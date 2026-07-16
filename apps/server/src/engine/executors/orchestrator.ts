import { basename, join } from "path";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { resolveAuthFile } from "../oauth.js";
import { randomUUID } from "crypto";
import { getBotName, getRuntimeConfig, type SandboxBackend } from "../../config/config.js";
import {
  agentGitIdentityEnv,
  sandboxFor,
  type EgressPolicy,
  type PrePopulateSpec,
  type ProvisionResult,
  type Sandbox,
  type SandboxEvent,
  type SandboxFactory,
} from "../../sandbox/sandbox.js";
import { SANDBOX_IMAGE_QA } from "../../sandbox/index.js";
import { DEFAULT_ALLOWLIST, mergeAllowlist } from "../../sandbox/egress-allowlist.js";
import {
  AGENTIC_PROFILE_FOR,
  loadAgentContext,
  type ExecutorConfig,
  type ExecutionResult,
  type GitSandboxAccess,
} from "../github/profiles.js";
import { AgenticShim } from "../event-shim.js";
import { projectSlugForCwd } from "../../session-log.js";
import { recordError, recordExecutionMetrics } from "../../telemetry/index.js";
import { recordPiEvent } from "../../telemetry/pi-events.js";
import {
  DEFAULT_MODEL,
  RunResultAccumulator,
  coerceThinking,
  emptyResult,
  finalizeFromRunResult,
  harvestArtifactsOut,
  resolveSessionsDir,
  serverArtifacts,
  skillBundleKey,
  stageArtifactsIn,
} from "./shared.js";

/**
 * The **Sandbox orchestrator** — the deep module that owns one agent/command
 * run end-to-end behind the {@link Sandbox} port. It is written ONCE and is
 * identical for every backend; the per-backend `executeDocker` / `executeSmol`
 * / `executeInProcess` twins it replaced are gone.
 *
 *   - {@link withSandbox} is the bracket: build the adapter → provision →
 *     (work) → dispose. Errors from provision (e.g. docker unavailable)
 *     propagate; dispose always runs once provisioned.
 *   - {@link runSandboxedAgent} runs one agent turn: skill staging,
 *     build-artifact stage/harvest, the `RunResultAccumulator` + shim +
 *     `recordPiEvent` event loop, session-id notify, and the single converged
 *     fallback path.
 *   - {@link runSandboxedCommand} runs a deterministic command/script and
 *     mirrors it to a session jsonl.
 *
 * Egress is computed once here as an intent-only {@link EgressPolicy} and
 * handed to the adapter at construction.
 */

/** Shared run context threaded into the orchestrator by the executors. */
export interface SandboxRunContext {
  config: ExecutorConfig;
  taskId: string;
  stateDir: string;
  backend: SandboxBackend;
  /** Env forwarded into the sandbox (provider keys, minted GITHUB_TOKEN, …). */
  env: Record<string, string>;
  prePopulate?: PrePopulateSpec;
  access?: GitSandboxAccess;
  onSessionId?: (sessionId: string) => void;
  /** Test seam — substitute a FakeSandbox. Defaults to {@link sandboxFor}. */
  sandboxFactory?: SandboxFactory;
}

/**
 * Compute the run's intent-only egress policy once: `unrestricted` for a phase
 * that opted out, otherwise the default allowlist merged with any OTEL
 * collector hosts. Each adapter translates this to its own mechanism.
 */
export function egressPolicyFor(config: ExecutorConfig): EgressPolicy {
  if (config.unrestrictedEgress) return { unrestricted: true, hosts: [] };
  const extraHosts =
    config.otel?.enabled && config.otel.forwardToSandbox ? config.otel.collectorHosts : [];
  return { unrestricted: false, hosts: mergeAllowlist(DEFAULT_ALLOWLIST, extraHosts) };
}

/**
 * The provision → work → dispose bracket. Builds the adapter via the factory
 * (or the injected one), provisions the workspace, runs `fn`, and disposes in a
 * `finally` once provisioned. A provision failure propagates to the caller (it
 * is not a workspace we ever provisioned, so there is nothing to dispose).
 */
export async function withSandbox<T>(
  ctx: SandboxRunContext,
  fn: (sandbox: Sandbox, provisioned: ProvisionResult) => Promise<T>,
): Promise<T> {
  const factory = ctx.sandboxFactory ?? sandboxFor;
  const sandbox = factory(ctx.backend, {
    taskId: ctx.taskId,
    egress: egressPolicyFor(ctx.config),
    env: ctx.env,
    stateDir: ctx.stateDir,
    sandboxDir: ctx.config.sandboxDir,
    repoSubdir: ctx.config.repoSubdir,
    imageName: ctx.config.sandboxImage === "qa" ? SANDBOX_IMAGE_QA : undefined,
    otel: ctx.config.otel,
  });
  let provisioned: ProvisionResult | undefined;
  try {
    provisioned = await sandbox.provision(ctx.prePopulate);
    return await fn(sandbox, provisioned);
  } finally {
    if (provisioned) await sandbox.dispose();
  }
}

/** Drop AGENTS.md into the workspace — agentic-pi reads it as system context. */
function writeAgentsMd(hostWorkspaceDir: string, config: ExecutorConfig): void {
  try {
    const md = loadAgentContext(config.agentContextDir);
    if (md) writeFileSync(join(hostWorkspaceDir, "AGENTS.md"), md);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[executor] Could not write AGENTS.md: ${msg}`);
  }
}

/** Host path of the repo checkout (for build-artifact stage/harvest). */
function hostRepoDirFor(prov: ProvisionResult, prePopulate?: PrePopulateSpec): string {
  return prePopulate ? join(prov.hostWorkspaceDir, prePopulate.repo) : prov.hostWorkspaceDir;
}

/**
 * Run one agent turn through any backend. Replaces `executeDocker` /
 * `executeSmol` / `executeInProcess` — the three slightly-different fallback
 * paths are converged into the single catch below.
 */
export async function runSandboxedAgent(prompt: string, ctx: SandboxRunContext): Promise<ExecutionResult> {
  const { config, access } = ctx;
  const startTime = Date.now();
  const model = config.model || DEFAULT_MODEL;
  const thinking = coerceThinking(config.variant);
  const profile = access ? AGENTIC_PROFILE_FOR[access.profile] : undefined;
  const sessionsDir = resolveSessionsDir(config);

  return withSandbox(ctx, async (sandbox, prov) => {
    console.log(`  [executor] Running agent (task: ${ctx.taskId}, sandbox: ${ctx.backend})`);
    writeAgentsMd(prov.hostWorkspaceDir, config);

    // Stage this phase's skills (adapter decides symlink/copy + path mapping).
    let skillDirs: string[] | undefined;
    try {
      skillDirs = sandbox.stageSkills(skillBundleKey(config), config.skillPaths);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[executor] Could not stage skills: ${msg}`);
    }

    // Server-mode build assets: stage in before, harvest after (even on error).
    const artifacts = serverArtifacts(config, hostRepoDirFor(prov, ctx.prePopulate));
    stageArtifactsIn(artifacts);

    const shim = new AgenticShim({
      homeDir: sessionsDir,
      projectSlug: projectSlugForCwd(prov.agentCwd),
      model,
      initialPrompt: prompt,
    });
    const acc = new RunResultAccumulator();
    let notifiedSessionId = false;
    const onEvent = (record: SandboxEvent): void => {
      acc.feed(record);
      shim.feed(record as Parameters<typeof shim.feed>[0]);
      recordPiEvent(record, {
        includeContent: config.otel?.includeContent === true,
        surface: "agent",
        workflowName: config.telemetry?.workflowName,
        phaseName: config.telemetry?.phaseName,
        model,
      });
      if (!notifiedSessionId && ctx.onSessionId && record.type === "session" && typeof record.id === "string") {
        notifiedSessionId = true;
        ctx.onSessionId(record.id);
      }
    };

    // OAuth credential store for model auth. Only the in-process adapters
    // (none/gondolin) run the model call host-side, so a host path resolves
    // there; the docker adapter ignores authFile (its model call is
    // in-container) and relies on the OAuth env tokens spliced in by the
    // executor. Pass the path only when the store actually exists so pure
    // API-key deployments never point agentic-pi at a phantom file.
    let authFile: string | undefined;
    if (ctx.backend === "none" || ctx.backend === "gondolin") {
      const candidate = resolveAuthFile(undefined, ctx.stateDir);
      if (existsSync(candidate)) authFile = candidate;
    }

    let returned;
    try {
      returned = await sandbox.runAgent(
        ctx.taskId,
        prompt,
        {
          model,
          thinking,
          profile,
          authFile,
          sandboxEnv: agentGitIdentityEnv(getRuntimeConfig()?.botLogin ?? `${getBotName()}[bot]`),
          agentCwd: prov.agentCwd,
          skillDirs,
          webSearch: config.webSearch === true,
          webSearchProvider: config.webSearchProvider,
          githubApiBaseUrl: config.githubApiBaseUrl,
        },
        onEvent,
      );
    } catch (err: unknown) {
      // The single converged fallback path (was three near-identical catches).
      const msg = err instanceof Error ? err.message : String(err);
      const durationMs = Date.now() - startTime;
      const tags = {
        "sandbox.backend": ctx.backend,
        model,
        success: false,
        stop_reason: "error_sandbox",
        "workflow.name": config.telemetry?.workflowName,
        "phase.name": config.telemetry?.phaseName,
      };
      recordError("agent", err, tags);
      recordExecutionMetrics("agent", { ...tags, durationMs });
      const synthesizedId = await shim
        .finalizeWithFallback(emptyResult("error_sandbox", durationMs), `exec-${basename(ctx.taskId)}`, msg)
        .catch(() => null);
      harvestArtifactsOut(artifacts);
      return {
        success: false,
        output: "",
        turns: 0,
        error: msg,
        durationMs,
        sessionId: synthesizedId ?? undefined,
        stopReason: "error_sandbox",
      } satisfies ExecutionResult;
    }

    harvestArtifactsOut(artifacts);

    // Reconstruct the RunResult: the in-process adapter returns its
    // authoritative one; docker/smol return undefined → build from the
    // accumulated events. Either way prefer our compaction-proof per-message
    // accumulation when it carries token data.
    const result = returned ?? acc.build(0);
    const better = acc.bestStats();
    if (better && (better.tokens?.total ?? 0) > 0) result.stats = better;

    const finalResult = finalizeFromRunResult(
      result,
      prompt,
      shim,
      startTime,
      acc.extensions(),
      acc.skills(),
      acc.toolError(),
      acc.endedOnToolCall(),
    );
    recordExecutionMetrics("agent", {
      "sandbox.backend": ctx.backend,
      model,
      success: finalResult.success,
      stop_reason: finalResult.stopReason,
      durationMs: finalResult.durationMs,
      costUsd: finalResult.costUsd,
      inputTokens: finalResult.inputTokens,
      outputTokens: finalResult.outputTokens,
      "workflow.name": config.telemetry?.workflowName,
      "phase.name": config.telemetry?.phaseName,
    });
    return finalResult;
  });
}

// ── Deterministic command path (type: bash / type: script) ───────────

/** What a command phase runs. */
// CommandSpec's canonical home is now the workflow engine's vocabulary
// (`workflow-engine/core/types.ts`); re-export it so existing importers of
// `./executors/orchestrator.js` (and the `agent-executor.js` chain) resolve
// unchanged.
export type { CommandSpec } from "@lastlight/workflow-engine";
import type { CommandSpec } from "@lastlight/workflow-engine";

const SCRIPT_EXT: Record<"js" | "ts" | "python", string> = { js: "mjs", ts: "mts", python: "py" };

/**
 * Where a `type: script` source file is staged. A workspace-root sibling of the
 * skill bundle, keyed per phase (`<root>/<phase>/script.<ext>`) — so it sits
 * beside the skills and is never written inside any checked-out repo's git tree.
 */
const SCRIPT_BUNDLE_ROOT = ".lastlight-scripts";

/** Build the shell invocation + on-disk filename for a script spec. */
function scriptInvocation(spec: Extract<CommandSpec, { kind: "script" }>): {
  fileName: string;
  run: (path: string) => string;
} {
  const fileName = `script.${SCRIPT_EXT[spec.runtime]}`;
  const run = (path: string): string => {
    switch (spec.runtime) {
      case "js":
        return `node ${path}`;
      case "ts":
        return `node --experimental-strip-types ${path}`;
      case "python":
        return `uv run ${path}`;
    }
  };
  return { fileName, run };
}

/** Options for {@link runSandboxedCommand}. */
export interface CommandRunOpts {
  /** Per-step timeout in seconds (default 300). */
  timeoutSeconds?: number;
  /** Extra env forwarded into the command (e.g. upstream phase outputs). */
  sandboxEnv?: Record<string, string>;
  /** Mirror output to a session jsonl (default true; false for internal checks). */
  writeSession?: boolean;
}

/**
 * Execute a deterministic command/script in the same workspace an agent phase
 * would use — no LLM. Replaces the three-way fork that lived in
 * `executeCommand`. Writes a session jsonl so the output is visible in the
 * dashboard + CLI.
 */
export async function runSandboxedCommand(
  spec: CommandSpec,
  ctx: SandboxRunContext,
  cmdOpts: CommandRunOpts,
): Promise<ExecutionResult> {
  const { config } = ctx;
  const model = config.model || DEFAULT_MODEL;
  const sessionsDir = resolveSessionsDir(config);
  const timeoutSeconds = cmdOpts.timeoutSeconds ?? 300;
  const startTime = Date.now();
  const displayPrompt =
    spec.kind === "bash" ? `$ ${spec.command}` : `${spec.runtime} script: ${spec.name}\n\n${spec.script}`;

  return withSandbox(ctx, async (sandbox, prov) => {
    // Per-phase script-bundle dir, a workspace-root sibling of the skill bundle.
    const scriptDir = spec.kind === "script" ? `${SCRIPT_BUNDLE_ROOT}/${spec.name}` : SCRIPT_BUNDLE_ROOT;

    let command: string;
    let toolInput: Record<string, unknown>;
    if (spec.kind === "bash") {
      command = spec.command;
      toolInput = { command: spec.command };
    } else {
      const { fileName, run } = scriptInvocation(spec);
      mkdirSync(join(prov.hostWorkspaceDir, scriptDir), { recursive: true });
      writeFileSync(join(prov.hostWorkspaceDir, scriptDir, fileName), spec.script);
      command = run(sandbox.sandboxPathFor(`${scriptDir}/${fileName}`));
      toolInput = { command, runtime: spec.runtime };
    }

    // Forward the GitHub API base-url override (evals fake) into the command env.
    // The agent path already threads `githubApiBaseUrl` (see runSandboxedAgent);
    // command/script phases need the same so a GitHub-mutating script (e.g.
    // pr-review's post-review step) hits the fake in evals. Prod-inert:
    // `githubApiBaseUrl` is undefined outside the eval harness, so nothing is
    // injected and the script falls back to api.github.com with its minted token.
    const sandboxEnv = config.githubApiBaseUrl
      ? { ...(cmdOpts.sandboxEnv ?? {}), GITHUB_API_URL: config.githubApiBaseUrl }
      : cmdOpts.sandboxEnv;
    const res = await sandbox.runCommand(ctx.taskId, command, {
      cwd: prov.agentCwd,
      sandboxEnv,
      timeoutSeconds,
    });
    const durationMs = Date.now() - startTime;
    const sessionId =
      cmdOpts.writeSession === false
        ? null
        : await writeCommandSession({
            sessionsDir,
            projectSlug: projectSlugForCwd(prov.agentCwd),
            model,
            displayPrompt,
            toolName: "bash",
            toolInput,
            stdout: res.stdout,
            stderr: res.stderr,
            exitCode: res.exitCode,
            durationMs,
          });
    if (sessionId && ctx.onSessionId) ctx.onSessionId(sessionId);
    return buildCommandResult(res, durationMs, sessionId);
  });
}

/**
 * Mirror a finished command into a session jsonl via the shim. Synthesizes a
 * minimal agentic-pi event stream: session → assistant(tool_use bash) →
 * user(tool_result) → assistant(text summary) → result. Returns the session id
 * the shim wrote under (so the executions row can link to it).
 */
async function writeCommandSession(opts: {
  sessionsDir: string;
  projectSlug: string;
  model?: string;
  displayPrompt: string;
  toolName: string;
  toolInput: Record<string, unknown>;
  stdout: string;
  stderr: string;
  exitCode: number;
  durationMs: number;
}): Promise<string | null> {
  const shim = new AgenticShim({
    homeDir: opts.sessionsDir,
    projectSlug: opts.projectSlug,
    model: opts.model,
    initialPrompt: opts.displayPrompt,
  });
  const sessionId = randomUUID();
  const ts = Date.now();
  const toolCallId = `cmd_${randomUUID().slice(0, 8)}`;
  const feed = (record: Record<string, unknown>): void =>
    shim.feed(record as unknown as Parameters<typeof shim.feed>[0]);

  feed({ type: "session", id: sessionId, timestamp: ts });
  feed({
    type: "message_end",
    sessionId,
    timestamp: ts,
    message: { role: "assistant", content: [{ type: "toolCall", id: toolCallId, name: opts.toolName, arguments: opts.toolInput }] },
  });
  const combined = opts.stderr
    ? `${opts.stdout}${opts.stdout && !opts.stdout.endsWith("\n") ? "\n" : ""}${opts.stderr}`
    : opts.stdout;
  feed({
    type: "tool_execution_end",
    sessionId,
    timestamp: ts,
    toolCallId,
    result: combined || `(no output, exit ${opts.exitCode})`,
    isError: opts.exitCode !== 0,
  });
  const summary = opts.exitCode === 0 ? "Command succeeded (exit 0)." : `Command failed (exit ${opts.exitCode}).`;
  feed({
    type: "message_end",
    sessionId,
    timestamp: ts,
    message: { role: "assistant", content: [{ type: "text", text: summary }] },
  });

  shim.finalize({
    finalText: summary,
    turns: 1,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    stopReason: opts.exitCode === 0 ? "success" : "error_bash",
    durationMs: opts.durationMs,
  });
  await shim.flush();
  return shim.isInitialized ? sessionId : null;
}

/** Map a raw command result onto the ExecutionResult contract (turns 0, no cost). */
function buildCommandResult(
  res: { exitCode: number; stdout: string; stderr: string; timedOut: boolean },
  durationMs: number,
  sessionId: string | null,
): ExecutionResult {
  const success = res.exitCode === 0;
  const combined = res.stderr
    ? `${res.stdout}${res.stdout && !res.stdout.endsWith("\n") ? "\n" : ""}${res.stderr}`
    : res.stdout;
  // Strip the trailing newline so the value substitutes cleanly into a
  // downstream command / `{{phaseOutputs.<name>}}` and can be forwarded as an
  // `LL_OUT_<PHASE>` env var. The raw stdout/stderr is preserved in the jsonl.
  const output = combined.replace(/\n+$/, "");
  return {
    success,
    output,
    turns: 0,
    durationMs,
    sessionId: sessionId ?? undefined,
    error: success
      ? undefined
      : res.timedOut
        ? `command timed out after ${Math.round(durationMs / 1000)}s`
        : `command exited ${res.exitCode}`,
    stopReason: success ? "success" : res.timedOut ? "error_timeout" : "error_bash",
  };
}

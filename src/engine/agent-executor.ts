import { resolve, join } from "path";
import { mkdirSync, writeFileSync } from "fs";
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import {
  createTaskSandbox,
  setupTaskWorktree,
  prePopulateWorkspace,
  SANDBOX_IMAGE_QA,
} from "../sandbox/index.js";
import { SmolSandbox, smolAvailable, SMOL_WORKSPACE_DIR } from "../sandbox/smol.js";
import { refreshGitAuth } from "./github/git-auth.js";
import {
  GITHUB_PERMISSION_PROFILES,
  loadAgentContext,
  type ExecutorConfig,
  type ExecutionResult,
  type GitSandboxAccess,
} from "./github/profiles.js";
import { AgenticShim } from "./event-shim.js";
import { projectSlugForCwd } from "../session-log.js";
import type { SandboxBackend } from "../config/config.js";
import { DEFAULT_ALLOWLIST, mergeAllowlist } from "../sandbox/egress-allowlist.js";
import { getDockerSandboxOtelEnv, getOtelEnvForSandbox, safeSpanAttributes, withSpan } from "../telemetry/index.js";
// Per-backend executors + their shared building blocks live under ./executors/.
import { executeInProcess, executeDocker, executeSmol } from "./executors/backends.js";
import { DEFAULT_MODEL, DOCKER_WORKSPACE_DIR, resolveSessionsDir } from "./executors/shared.js";
// Re-exported for back-compat with existing importers (tests, dashboards).
export { RunResultAccumulator, stageSkillBundle, excludeFromGit, detectAccountError } from "./executors/shared.js";


/**
 * Shared run preparation for {@link executeAgent} and {@link executeCommand}:
 * resolve the taskId / state dir / backend, mint the scoped GitHub token,
 * assemble the sandbox env (git token, provider keys, OTEL), and compute the
 * pre-populate descriptor. Both the agent and the deterministic command paths
 * run in the same sandbox/workspace with the same git access, so they share
 * this setup verbatim.
 */
async function prepareRun(
  config: ExecutorConfig,
  opts?: { taskId?: string; githubAccess?: GitSandboxAccess },
): Promise<{
  taskId: string;
  stateDir: string;
  backend: SandboxBackend;
  ghEnv: Record<string, string>;
  mintedToken?: string;
  prePopulate?: { owner: string; repo: string; branch: string; token: string; runId?: string; shallow?: boolean };
}> {
  const taskId = opts?.taskId || `task-${randomUUID().slice(0, 8)}`;
  const stateDir = config.stateDir || resolve("data");
  const backend: SandboxBackend = config.sandbox ?? "gondolin";

  // Mint a scoped GitHub App token. Same flow as the legacy executor —
  // defense in depth so a downstream tool gating regression can't burn
  // more access than the profile allowed.
  //
  // GITHUB_APP_* env vars are forwarded to agentic-pi *only* when the access
  // profile opts into App PEM access via `allowMcpAppAuth`. That is currently
  // never set (see gitSandboxAccessForWorkflow): the github extension can't
  // read the PEM in the sandbox and skips rather than falling back, so we keep
  // the App key out entirely and every run uses just the minted `GITHUB_TOKEN`
  // below — which also stops agents minting elevated tokens themselves. The
  // branch is retained so per-profile App auth can be re-enabled if the
  // sandbox-side PEM is ever materialized.
  const ghEnv: Record<string, string> = {};
  let mintedToken: string | undefined;
  const access = opts?.githubAccess;
  const allowAppAuth = access?.allowMcpAppAuth === true;
  if (process.env.GITHUB_APP_ID && allowAppAuth) {
    ghEnv.GITHUB_APP_ID = process.env.GITHUB_APP_ID;
    if (process.env.GITHUB_APP_INSTALLATION_ID) {
      ghEnv.GITHUB_APP_INSTALLATION_ID = process.env.GITHUB_APP_INSTALLATION_ID;
    }
    if (process.env.GITHUB_APP_PRIVATE_KEY_PATH) {
      ghEnv.GITHUB_APP_PRIVATE_KEY_PATH = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
    }
  } else {
    // Suppress for in-process runs that inherit our env. Empty strings
    // override the inherited value via `applyEnv()`.
    ghEnv.GITHUB_APP_ID = "";
    ghEnv.GITHUB_APP_INSTALLATION_ID = "";
    ghEnv.GITHUB_APP_PRIVATE_KEY_PATH = "";
  }
  if (process.env.GITHUB_APP_ID && access) {
    try {
      const permissions = GITHUB_PERMISSION_PROFILES[access.profile];
      const repositories = access.repo ? [access.repo] : undefined;
      console.log(
        `[executor] Minting git token: profile=${access.profile}, ` +
        `repo=${access.repo || "(unscoped)"}, permissions=${permissions ? Object.keys(permissions).join(",") : "all"}`,
      );
      const { token } = await refreshGitAuth({
        appId: process.env.GITHUB_APP_ID,
        privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH || "",
        installationId: process.env.GITHUB_APP_INSTALLATION_ID || "",
        permissions,
        repositories,
      });
      mintedToken = token;
      ghEnv.GITHUB_TOKEN = token;
      ghEnv.GIT_TOKEN = token;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(
        `[executor] Could not mint git token (repo=${access.repo || "none"}, ` +
        `profile=${access.profile}): ${msg}`,
      );
    }
  }

  // Provider API keys.
  if (process.env.OPENAI_API_KEY) ghEnv.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (process.env.ANTHROPIC_API_KEY) ghEnv.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
  if (process.env.OPENROUTER_API_KEY) ghEnv.OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;
  if (process.env.FIREWORKS_API_KEY) ghEnv.FIREWORKS_API_KEY = process.env.FIREWORKS_API_KEY;

  // Web-search provider keys. Forwarded only when the workflow opted into
  // web search (scoped to explore today; see webSearchEnabledForWorkflow
  // in workflows/runner.ts). agentic-pi auto-detects the provider from
  // whichever key is present (Tavily > Exa > Brave by default).
  if (config.webSearch) {
    if (process.env.TAVILY_API_KEY) ghEnv.TAVILY_API_KEY = process.env.TAVILY_API_KEY;
    if (process.env.BRAVE_SEARCH_API_KEY) ghEnv.BRAVE_SEARCH_API_KEY = process.env.BRAVE_SEARCH_API_KEY;
    if (process.env.EXA_API_KEY) ghEnv.EXA_API_KEY = process.env.EXA_API_KEY;
  }

  // OTEL config for the agent runtime itself. On docker the agent runs
  // inside the container, so it reads this (the container env) and is
  // pointed at the in-network collector — never the real backend or its
  // auth headers. On gondolin/none the agent runs in the harness process
  // and inherits the harness SDK; forwarding the host's OTEL_* here just
  // re-affirms that config for any child processes.
  if (config.otel?.enabled && config.otel.forwardToSandbox) {
    Object.assign(ghEnv, backend === "docker" ? getDockerSandboxOtelEnv() : getOtelEnvForSandbox());
  }

  const prePopulate =
    access?.prePopulateBranch && mintedToken
      ? {
          owner: access.owner,
          repo: access.repo,
          branch: access.prePopulateBranch,
          token: mintedToken,
          runId: access.runId,
          shallow: access.shallow,
        }
      : undefined;

  return { taskId, stateDir, backend, ghEnv, mintedToken, prePopulate };
}

export async function executeAgent(
  prompt: string,
  config: ExecutorConfig,
  opts?: {
    taskId?: string;
    /**
     * Fired as soon as the run gets a session id. Used to persist the id
     * onto the in-flight executions row so the dashboard can deep-link
     * the running phase to its live JSONL.
     */
    onSessionId?: (sessionId: string) => void;
    githubAccess?: GitSandboxAccess;
  },
): Promise<ExecutionResult> {
  const { taskId, stateDir, backend, ghEnv, prePopulate } = await prepareRun(config, opts);
  const access = opts?.githubAccess;

  const spanAttrs = safeSpanAttributes({
    "agent.runtime": "agentic-pi",
    "sandbox.backend": backend,
    "task.id": taskId,
    repo: access?.repo,
    "github.profile": access?.profile,
    model: config.model || DEFAULT_MODEL,
    variant: config.variant,
    "web_search.enabled": config.webSearch === true,
    unrestricted_egress: config.unrestrictedEgress === true,
    "workflow.name": config.telemetry?.workflowName,
    "phase.name": config.telemetry?.phaseName,
  });

  if (backend === "docker") {
    return withSpan("lastlight.agent.execute", spanAttrs, () => executeDocker(prompt, config, {
      taskId,
      stateDir,
      env: ghEnv,
      prePopulate,
      access,
      onSessionId: opts?.onSessionId,
    }));
  }

  if (backend === "smol") {
    return withSpan("lastlight.agent.execute", spanAttrs, () => executeSmol(prompt, config, {
      taskId,
      stateDir,
      env: ghEnv,
      prePopulate,
      access,
      onSessionId: opts?.onSessionId,
    }));
  }

  const workDir = setupTaskWorktree({
    taskId,
    stateDir,
    sandboxDir: config.sandboxDir,
    prePopulate,
  });

  // Drop AGENTS.md into the workspace — agentic-pi reads it as the
  // system context (same convention as the previous opencode setup).
  try {
    const md = loadAgentContext(config.agentContextDir);
    if (md) writeFileSync(join(workDir, "AGENTS.md"), md);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[executor] Could not write AGENTS.md: ${msg}`);
  }

  return withSpan("lastlight.agent.execute", spanAttrs, () => executeInProcess(prompt, config, {
    backend,
    taskId,
    workDir,
    stateDir,
    env: ghEnv,
    access,
    onSessionId: opts?.onSessionId,
  }));
}

// ── Deterministic command path (type: bash / type: script) ───────────
//
// Runs a deterministic shell command (or inline script) inside the SAME
// sandbox/workspace an agent phase would use — no LLM. The command's output is
// mirrored to a Claude-SDK-style session jsonl via the AgenticShim (the same
// shim agent phases use), so a bash/script phase shows up in the admin console
// and `lastlight session log` exactly like an agent turn: the command renders
// as a `bash` tool_use and its stdout/stderr as the tool_result.

/** What a command phase runs. */
export type CommandSpec =
  | { kind: "bash"; command: string }
  | { kind: "script"; script: string; runtime: "js" | "ts" | "python"; name: string };

const SCRIPT_EXT: Record<"js" | "ts" | "python", string> = { js: "mjs", ts: "mts", python: "py" };

/**
 * Where a `type: script` source file is staged. A workspace-root sibling of
 * {@link SKILL_BUNDLE_ROOT}, keyed per phase (`<root>/<phase>/script.<ext>`) —
 * same convention as the skill bundle, so it sits beside the skills and is
 * never written inside any checked-out repo's git tree.
 */
const SCRIPT_BUNDLE_ROOT = ".lastlight-scripts";

/** Build the shell invocation + on-disk filename for a script spec. */
function scriptInvocation(spec: Extract<CommandSpec, { kind: "script" }>): { fileName: string; run: (path: string) => string } {
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
  const combined = opts.stderr ? `${opts.stdout}${opts.stdout && !opts.stdout.endsWith("\n") ? "\n" : ""}${opts.stderr}` : opts.stdout;
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

/**
 * Execute a deterministic command/script. Mirrors {@link executeDocker} /
 * {@link executeInProcess} for sandbox setup but runs `runCommand` (docker) or
 * `spawnSync` (gondolin/none) instead of an agent, and writes a session jsonl
 * so the output is visible in the dashboard + CLI.
 */
export async function executeCommand(
  spec: CommandSpec,
  config: ExecutorConfig,
  opts?: {
    taskId?: string;
    githubAccess?: GitSandboxAccess;
    /** Per-step timeout in seconds. */
    timeoutSeconds?: number;
    /** Extra env forwarded into the command (e.g. upstream phase outputs). */
    sandboxEnv?: Record<string, string>;
    onSessionId?: (sessionId: string) => void;
    /**
     * Mirror the command output to a session jsonl (visible in the dashboard +
     * CLI). Default true. Set false for internal checks like `until_bash` that
     * shouldn't create a user-facing session log.
     */
    writeSession?: boolean;
  },
): Promise<ExecutionResult> {
  const { taskId, stateDir, backend, ghEnv, prePopulate } = await prepareRun(config, opts);
  const access = opts?.githubAccess;
  const model = config.model || DEFAULT_MODEL;
  const sessionsDir = resolveSessionsDir(config);
  const timeoutSeconds = opts?.timeoutSeconds ?? 300;
  const startTime = Date.now();

  const displayPrompt =
    spec.kind === "bash" ? `$ ${spec.command}` : `${spec.runtime} script: ${spec.name}\n\n${spec.script}`;

  const spanAttrs = safeSpanAttributes({
    "agent.runtime": spec.kind,
    "sandbox.backend": backend,
    "task.id": taskId,
    repo: access?.repo,
    "github.profile": access?.profile,
    unrestricted_egress: config.unrestrictedEgress === true,
    "workflow.name": config.telemetry?.workflowName,
    "phase.name": config.telemetry?.phaseName,
  });

  return withSpan("lastlight.command.execute", spanAttrs, async () => {
    // Per-phase script-bundle dir, a workspace-root sibling of the skill bundle
    // (and of any repo checkout) — so a `type: script` file is never written
    // inside the target's git tree. `spec.name` is the (sanitized) phase name.
    const scriptDir = spec.kind === "script" ? `${SCRIPT_BUNDLE_ROOT}/${spec.name}` : SCRIPT_BUNDLE_ROOT;

    if (backend === "docker") {
      const dnsIp = config.unrestrictedEgress
        ? (process.env.LASTLIGHT_DNS_OPEN || "172.30.0.11")
        : (process.env.LASTLIGHT_DNS_STRICT || "172.30.0.10");
      const imageName = config.sandboxImage === "qa" ? SANDBOX_IMAGE_QA : undefined;

      const sbx = await createTaskSandbox({
        taskId, stateDir, sandboxDir: config.sandboxDir, env: ghEnv, prePopulate, dnsIp, imageName,
      });
      if (!sbx) {
        throw new Error("LASTLIGHT_SANDBOX=docker but no docker sandbox was available for command phase.");
      }
      const agentCwd = prePopulate ? `${DOCKER_WORKSPACE_DIR}/${prePopulate.repo}` : DOCKER_WORKSPACE_DIR;
      try {
        let command: string;
        let toolName: string;
        let toolInput: Record<string, unknown>;
        if (spec.kind === "bash") {
          command = spec.command;
          toolName = "bash";
          toolInput = { command: spec.command };
        } else {
          const { fileName, run } = scriptInvocation(spec);
          mkdirSync(join(sbx.workDir, scriptDir), { recursive: true });
          writeFileSync(join(sbx.workDir, scriptDir, fileName), spec.script);
          const inContainer = `${DOCKER_WORKSPACE_DIR}/${scriptDir}/${fileName}`;
          command = run(inContainer);
          toolName = "bash";
          toolInput = { command, runtime: spec.runtime };
        }
        const res = await sbx.sandbox.runCommand(taskId, command, {
          cwd: agentCwd,
          sandboxEnv: opts?.sandboxEnv,
          timeoutSeconds,
          onLine: () => {},
        });
        const durationMs = Date.now() - startTime;
        const sessionId = opts?.writeSession === false ? null : await writeCommandSession({
          sessionsDir, projectSlug: projectSlugForCwd(agentCwd), model,
          displayPrompt, toolName, toolInput,
          stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode, durationMs,
        });
        if (sessionId && opts?.onSessionId) opts.onSessionId(sessionId);
        return buildCommandResult(res, durationMs, sessionId);
      } finally {
        await sbx.cleanup();
      }
    }

    if (backend === "smol") {
      if (!smolAvailable()) {
        throw new Error("LASTLIGHT_SANDBOX=smol but the smolvm CLI is not available for command phase.");
      }
      const allowHosts = config.unrestrictedEgress
        ? null
        : mergeAllowlist(DEFAULT_ALLOWLIST, config.otel?.enabled && config.otel.forwardToSandbox ? config.otel.collectorHosts : []);
      // Boot first, then provision the probed share-backed dir (see executeSmol).
      const workDir = setupTaskWorktree({ taskId, stateDir, sandboxDir: config.sandboxDir });
      const sandbox = new SmolSandbox({ env: ghEnv, allowHosts });
      const machine = await sandbox.create({ taskId, worktreePath: workDir });
      const hostWs = machine.hostWorkspace;
      if (prePopulate) prePopulateWorkspace(hostWs, prePopulate);
      const agentCwd = prePopulate ? `${SMOL_WORKSPACE_DIR}/${prePopulate.repo}` : SMOL_WORKSPACE_DIR;
      try {
        let command: string;
        let toolName: string;
        let toolInput: Record<string, unknown>;
        if (spec.kind === "bash") {
          command = spec.command;
          toolName = "bash";
          toolInput = { command: spec.command };
        } else {
          const { fileName, run } = scriptInvocation(spec);
          mkdirSync(join(hostWs, scriptDir), { recursive: true });
          writeFileSync(join(hostWs, scriptDir, fileName), spec.script);
          const inGuest = `${SMOL_WORKSPACE_DIR}/${scriptDir}/${fileName}`;
          command = run(inGuest);
          toolName = "bash";
          toolInput = { command, runtime: spec.runtime };
        }
        const res = await sandbox.runCommand(taskId, command, {
          cwd: agentCwd,
          sandboxEnv: opts?.sandboxEnv,
          timeoutSeconds,
          onLine: () => {},
        });
        const durationMs = Date.now() - startTime;
        const sessionId = opts?.writeSession === false ? null : await writeCommandSession({
          sessionsDir, projectSlug: projectSlugForCwd(agentCwd), model,
          displayPrompt, toolName, toolInput,
          stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode, durationMs,
        });
        if (sessionId && opts?.onSessionId) opts.onSessionId(sessionId);
        return buildCommandResult(res, durationMs, sessionId);
      } finally {
        await sandbox.destroy(taskId);
      }
    }

    // gondolin / none — run on the host worktree via spawnSync (the same
    // degraded model those backends already use; matches the pre-existing
    // host-side until_bash behaviour).
    const workDir = setupTaskWorktree({ taskId, stateDir, sandboxDir: config.sandboxDir, prePopulate });
    const agentCwd = access?.prePopulateBranch ? join(workDir, access.repo) : workDir;
    let command: string;
    let toolName = "bash";
    let toolInput: Record<string, unknown>;
    if (spec.kind === "bash") {
      command = spec.command;
      toolInput = { command: spec.command };
    } else {
      const { fileName, run } = scriptInvocation(spec);
      mkdirSync(join(workDir, scriptDir), { recursive: true });
      const filePath = join(workDir, scriptDir, fileName);
      writeFileSync(filePath, spec.script);
      command = run(filePath);
      toolInput = { command, runtime: spec.runtime };
    }
    const proc = spawnSync("sh", ["-c", command], {
      cwd: agentCwd,
      env: { ...process.env, ...ghEnv, ...(opts?.sandboxEnv ?? {}) },
      encoding: "utf-8",
      timeout: timeoutSeconds * 1000,
      maxBuffer: 256 * 1024 * 1024,
    });
    const durationMs = Date.now() - startTime;
    const exitCode = proc.status ?? (proc.signal ? 124 : 1);
    const res = { exitCode, stdout: proc.stdout ?? "", stderr: proc.stderr ?? "", timedOut: proc.signal === "SIGTERM" };
    const sessionId = opts?.writeSession === false ? null : await writeCommandSession({
      sessionsDir, projectSlug: projectSlugForCwd(agentCwd), model,
      displayPrompt, toolName, toolInput,
      stdout: res.stdout, stderr: res.stderr, exitCode: res.exitCode, durationMs,
    });
    if (sessionId && opts?.onSessionId) opts.onSessionId(sessionId);
    return buildCommandResult(res, durationMs, sessionId);
  });
}

/** Map a raw command result onto the ExecutionResult contract (turns 0, no cost). */
function buildCommandResult(
  res: { exitCode: number; stdout: string; stderr: string; timedOut: boolean },
  durationMs: number,
  sessionId: string | null,
): ExecutionResult {
  const success = res.exitCode === 0;
  const combined = res.stderr ? `${res.stdout}${res.stdout && !res.stdout.endsWith("\n") ? "\n" : ""}${res.stderr}` : res.stdout;
  // Strip the trailing newline so the value substitutes cleanly into a
  // downstream command / `{{phaseOutputs.<name>}}` and can be forwarded as an
  // `LL_OUT_<PHASE>` env var (mirrors archon's "trailing newline removed"). The
  // full raw stdout/stderr is preserved verbatim in the session jsonl.
  const output = combined.replace(/\n+$/, "");
  return {
    success,
    output,
    turns: 0,
    durationMs,
    sessionId: sessionId ?? undefined,
    error: success ? undefined : res.timedOut ? `command timed out after ${Math.round(durationMs / 1000)}s` : `command exited ${res.exitCode}`,
    stopReason: success ? "success" : res.timedOut ? "error_timeout" : "error_bash",
  };
}


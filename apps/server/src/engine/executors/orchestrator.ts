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
  agentContextFor,
  provideAgentContext,
  type ExecutorConfig,
  type ExecutionResult,
  type GitSandboxAccess,
} from "../github/profiles.js";
import {
  ImageAllowlist,
  parseServiceSpec,
  ServiceSet,
  type ServiceSpec,
} from "lastlight-shared/sandbox-services";
import { AgenticShim } from "../event-shim.js";
import { QuotaExceededError } from "../../sandbox/k8s/quota.js";
import { projectSlugForCwd } from "../../session-log.js";
import type { Span } from "@opentelemetry/api";
import { recordError, recordExecutionMetrics, setSpanAttributes } from "../../telemetry/index.js";
import { AgentSpanTree, recordPiEvent } from "../../telemetry/pi-events.js";
import { OI, llmTokenAttributes } from "../../telemetry/openinference.js";
import { logger } from "../../logging/logger.js";
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

const log = logger("executor");

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
 * The backends that implement dependency services (`docs/plans/sandbox-services`,
 * decision 8). The two container backends are what real deployments run; the rest warn
 * once and proceed without, which lands the run exactly where it is today.
 */
export const SERVICE_CAPABLE_BACKENDS: ReadonlySet<SandboxBackend> = new Set([
  "docker",
  "kubernetes",
]);

/**
 * Admit the phase's declared services against the operator's bounds — the services
 * counterpart to {@link egressPolicyFor}, computed once per run.
 *
 * `config.services` is the RAW declaration map carried through from the repo's merged
 * config (plain data, so it survives JSON persistence and resume), so this is also where
 * it is parsed. A declaration that no longer parses is skipped rather than thrown on:
 * it was already validated and warned about at the config layer, and a repo's config can
 * never fail a run.
 *
 * SET-level rules (the flat port space, the count ceiling) belong to `ServiceSet`, which
 * is the only place a phase's whole port space is visible.
 */
export function servicesFor(config: ExecutorConfig): ServiceSet {
  const declared = config.services;
  if (!declared || Object.keys(declared).length === 0) return ServiceSet.empty();

  const specs: ServiceSpec[] = [];
  for (const [name, raw] of Object.entries(declared)) {
    const spec = parseServiceSpec(name, raw);
    if (spec) specs.push(spec);
  }
  if (specs.length === 0) return ServiceSet.empty();

  const { set, violations } = ServiceSet.create(specs, {
    allowlist: ImageAllowlist.of(config.serviceBounds?.allowedImages),
    maxServices: config.serviceBounds?.maxServices ?? 0,
  });
  for (const v of violations) {
    log.warn("service dropped", { service: v.name, reason: v.reason });
  }
  return set;
}

/**
 * How a phase discovers its services. Everything is on `localhost` — one shared network
 * namespace — so only the port varies. The LISTEN side is published because that is the
 * port to dial: when a mapping is remapped, a forwarder owns it and the service's own
 * port is an implementation detail.
 */
export function serviceEnv(services: ServiceSet): Record<string, string> {
  if (services.isEmpty) return {};
  const map: Record<string, number[]> = {};
  for (const s of services.specs) map[s.name] = s.ports.map((p) => p.listen);
  return { LASTLIGHT_SERVICES: JSON.stringify(map) };
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
  let services = servicesFor(ctx.config);
  if (!services.isEmpty && !SERVICE_CAPABLE_BACKENDS.has(ctx.backend)) {
    // Degrade, never fail: the agent then hits the same missing-service wall it hits
    // today and records the same `constraint:` note (design decision 9).
    log.warn("backend does not support services — running without them", {
      backend: ctx.backend,
      services: services.specs.map((s) => s.name),
    });
    services = ServiceSet.empty();
  }
  const sandbox = factory(ctx.backend, {
    taskId: ctx.taskId,
    egress: egressPolicyFor(ctx.config),
    env: { ...ctx.env, ...serviceEnv(services) },
    services,
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

/**
 * Deliver the run's agent context (the bot's persona + hard rules) to the agent
 * as `AGENTS.md`.
 *
 * ONE composition, two deliveries. The text comes from {@link agentContextFor},
 * which prefers the value the runner resolved for this run — the only one that
 * includes the target repo's additive `agent-context/*.md` (issue #180) — and
 * falls back to the module-level loader when no repo layer applies. Composing it
 * here rather than in each delivery path is what keeps the host-shared and
 * kubernetes backends from drifting apart, and what stops a repo's own
 * `security.md` sneaking in unfiltered: the additive-only rule was applied once,
 * upstream, to the value we are handed.
 *
 *   - host-shared backends (docker/gondolin/none/smol): written into the
 *     workspace ROOT, a sibling of any checkout — never into the checkout, so a
 *     repo-write phase's `git add -A` can't commit the bot's own persona.
 *
 *     **Why the agent still sees it, one level above its cwd.** pi's resource
 *     loader walks UP from `cwd` collecting `AGENTS.md`/`CLAUDE.md` and INLINES
 *     each one into the system prompt at session construction (see
 *     `DefaultResourceLoader.getAgentsFiles`). That walk runs in whichever
 *     process hosts pi — the harness itself on gondolin/none, the container on
 *     docker/smol — as a plain `fs.readFileSync`. The agent never reads the file
 *     with a tool, so **the sandbox's mount boundary is irrelevant to it**. This
 *     is the whole reason gondolin works despite mounting ONLY `cwd`: `AGENTS.md`
 *     arrives as prompt text, not as a readable path. Contrast `stageSkills`,
 *     which DOES have to stage gondolin's bundle under `cwd` — a `SKILL.md` is
 *     read on demand *by the agent*, through the sandboxed `read` tool, and
 *     `toGuestPath` throws "path escapes workspace" for anything above `cwd`.
 *     The invariant this delivery depends on is therefore
 *     `hostWorkspaceDir` being an ANCESTOR of `hostAgentCwd`
 *     (`tests/sandbox/agent-context-visibility.test.ts` pins it; the pi-side half
 *     is pinned by `packages/agentic-pi/test/context-file-walk.test.ts`).
 *
 *     An empty context writes no file. The docker sandbox image's entrypoint has
 *     a baked `cat /app/agent-context/*.md > $WORKSPACE/AGENTS.md` fallback for
 *     that case — but it covers **docker only** (`deploy/sandbox-entrypoint.sh`
 *     runs for no other backend), so it is not what makes gondolin work.
 *   - kubernetes: `hostWorkspaceDir` is an in-pod path that doesn't exist on the
 *     harness host, so a write here would always ENOENT. The adapter takes the
 *     text through the {@link provideAgentContext} sink instead and serves it
 *     over its own per-run init-fetch channel (see `KubernetesSandbox.runAgent`).
 *     Offered even when empty, so the adapter never falls back to re-composing a
 *     value we have already resolved.
 *
 * Best-effort: a failure here degrades the agent's context, it must never fail
 * the phase.
 */
function deliverAgentContext(sandbox: Sandbox, ctx: SandboxRunContext, prov: ProvisionResult): void {
  try {
    const md = agentContextFor(ctx.config);
    if (ctx.backend === "kubernetes") {
      provideAgentContext(sandbox, md);
      return;
    }
    if (md) writeFileSync(join(prov.hostWorkspaceDir, "AGENTS.md"), md);
  } catch (err: unknown) {
    log.warn("Could not deliver AGENTS.md", { err });
  }
}

/**
 * Host path the server-mode artifact seam stages into / harvests from.
 *
 * Relocated runs (server mode + pre-cloned + docker/none/smol) put the docs at
 * the **workspace root** — a sibling of the checkout — so the agent's `git add
 * -A` can never see them; the agent reaches them via `../.lastlight/…`. Every
 * other case keeps the in-repo path: the repo checkout for pre-cloned
 * workflows, else the workspace root (non-pre-cloned clones into a subdir, so
 * the root is already outside the repo tree). The decision is computed once in
 * simple.ts and carried on `config.buildAssetsRelocated` so this never
 * disagrees with the agent-facing `{{issueDir}}`.
 */
function hostRepoDirFor(
  prov: ProvisionResult,
  prePopulate: PrePopulateSpec | undefined,
  relocated: boolean,
): string {
  if (relocated) return prov.hostWorkspaceDir;
  return prePopulate ? join(prov.hostWorkspaceDir, prePopulate.repo) : prov.hostWorkspaceDir;
}

/**
 * Options for {@link runAgentIn}.
 */
export interface AgentTurnOpts {
  /** The AGENT span this turn's turn/tool spans nest under. */
  span?: Span;
  /**
   * When the caller started counting. Defaults to now.
   *
   * {@link runSandboxedAgent} passes a timestamp taken BEFORE provisioning, so
   * a single-turn phase's `durationMs` keeps including its own provision — the
   * value every existing `executions` row, dashboard and eval scorecard already
   * carries. A fan-out branch passes its own start instead, because the
   * provision it shares with five siblings belongs to none of them.
   */
  startTime?: number;
}

/**
 * Run ONE agent turn inside an ALREADY-PROVISIONED sandbox.
 *
 * Extracted verbatim from {@link runSandboxedAgent}'s `withSandbox` callback so
 * a caller holding one provisioned workspace can run several turns in it —
 * sequentially or concurrently. It deliberately does NOT deliver `AGENTS.md` and
 * does NOT stage/harvest build assets: those are per-WORKSPACE, not per-turn,
 * and doing them per-turn under a fan-out is WP5's D3 (two concurrent harvests
 * of the same `architect-plan.md`, last writer wins) plus a torn `AGENTS.md`
 * from N concurrent identical `writeFileSync`s. Both wrappers below do them once.
 *
 * Skill staging IS per-turn, and safe: the bundle is keyed on
 * `skillBundleKey(config)` → `config.telemetry.phaseName`, which a fan-out sets
 * per branch, so branches never share a bundle directory.
 */
export async function runAgentIn(
  sandbox: Sandbox,
  prov: ProvisionResult,
  prompt: string,
  ctx: SandboxRunContext,
  opts: AgentTurnOpts = {},
): Promise<ExecutionResult> {
  const { config, access } = ctx;
  const span = opts.span;
  const startTime = opts.startTime ?? Date.now();
  const model = config.model || DEFAULT_MODEL;
  const includeContent = config.otel?.includeContent === true;
  const thinking = coerceThinking(config.variant);
  const profile = access ? AGENTIC_PROFILE_FOR[access.profile] : undefined;
  const sessionsDir = resolveSessionsDir(config);

  return await (async () => {
    log.info("Running agent", { taskId: ctx.taskId, sandbox: ctx.backend });

    // Stage this phase's skills (adapter decides symlink/copy + path mapping).
    let skillDirs: string[] | undefined;
    try {
      skillDirs = sandbox.stageSkills(skillBundleKey(config), config.skillPaths);
    } catch (err: unknown) {
      log.warn("Could not stage skills", { err });
    }

    const shim = new AgenticShim({
      homeDir: sessionsDir,
      projectSlug: projectSlugForCwd(prov.agentCwd),
      model,
      initialPrompt: prompt,
      // For a fan-out branch this is the branch label, which is what makes the
      // six concurrent sessions of one phase tellable apart on disk.
      phase: config.telemetry?.phaseName,
    });
    const acc = new RunResultAccumulator();
    // OpenInference span tree (turn = LLM, tool = TOOL) nested under the active
    // `lastlight.agent.execute` (AGENT) span. No-ops when telemetry is off (span
    // undefined). The flat pi.* events (recordPiEvent) stay as a fallback.
    const tree = new AgentSpanTree({ parent: span, includeContent, model });
    let notifiedSessionId = false;
    const onEvent = (record: SandboxEvent): void => {
      acc.feed(record);
      shim.feed(record as Parameters<typeof shim.feed>[0]);
      tree.feed(record);
      recordPiEvent(record, {
        includeContent,
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
          sandboxEnv: agentGitIdentityEnv(getRuntimeConfig()?.botLogin ?? `${getBotName()}[bot]`, ctx.env.GIT_TOKEN),
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
      // A k8s ResourceQuota rejection is backpressure, not a sandbox failure:
      // a distinct stop reason lets the runner requeue the run (spec/09-sandbox.md (Concurrency)).
      const stopReason = err instanceof QuotaExceededError ? "error_quota" : "error_sandbox";
      const tags = {
        "sandbox.backend": ctx.backend,
        model,
        success: false,
        stop_reason: stopReason,
        "workflow.name": config.telemetry?.workflowName,
        "phase.name": config.telemetry?.phaseName,
      };
      // A quota rejection is backpressure, not an error — don't pollute the
      // error telemetry with it (the run requeues; see the outer .catch).
      if (!(err instanceof QuotaExceededError)) recordError("agent", err, tags);
      recordExecutionMetrics("agent", { ...tags, durationMs });
      tree.end();
      const synthesizedId = await shim
        .finalizeWithFallback(emptyResult(stopReason, durationMs), `exec-${basename(ctx.taskId)}`, msg)
        .catch(() => null);
      return {
        success: false,
        output: "",
        turns: 0,
        error: msg,
        durationMs,
        sessionId: synthesizedId ?? undefined,
        stopReason,
      } satisfies ExecutionResult;
    }

    // Close any turn/tool spans still open before we decorate the agent span.
    tree.end();

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
    // Decorate the AGENT span with the run's total tokens + cost (so Phoenix
    // shows real figures, not $0) via the scrubber-bypassing path. input/output
    // text are content — gated behind LASTLIGHT_OTEL_INCLUDE_CONTENT.
    setSpanAttributes(span, {
      ...llmTokenAttributes({
        input: finalResult.inputTokens,
        output: finalResult.outputTokens,
        cacheRead: finalResult.cacheReadInputTokens,
        cacheWrite: finalResult.cacheCreationInputTokens,
        cost: finalResult.costUsd,
      }),
      ...(includeContent
        ? {
            [OI.INPUT_VALUE]: prompt,
            [OI.INPUT_MIME_TYPE]: "text/plain",
            [OI.OUTPUT_VALUE]: finalResult.output,
            [OI.OUTPUT_MIME_TYPE]: "text/plain",
          }
        : {}),
    });
    return finalResult;
  })();
}

/**
 * Deliver `AGENTS.md` and bracket the server-mode build-asset stage/harvest
 * around `fn` — the two per-WORKSPACE steps {@link runAgentIn} deliberately
 * leaves out. Both wrappers ({@link runSandboxedAgent}, {@link withSandboxSession})
 * go through here so a fan-out cannot accidentally do either N times.
 *
 * The harvest is a `finally` rather than a call on each exit path: the extracted
 * code harvested once on the error path and once on the success path, which is
 * what a `finally` is.
 */
async function withWorkspaceArtifacts<T>(
  sandbox: Sandbox,
  prov: ProvisionResult,
  ctx: SandboxRunContext,
  fn: () => Promise<T>,
): Promise<T> {
  // AGENTS.md — composed once, delivered the way this backend needs it
  // (workspace write, or the k8s adapter's own init-fetch channel).
  deliverAgentContext(sandbox, ctx, prov);
  const artifacts = serverArtifacts(
    ctx.config,
    hostRepoDirFor(prov, ctx.prePopulate, ctx.config.buildAssetsRelocated === true),
  );
  stageArtifactsIn(artifacts);
  try {
    return await fn();
  } finally {
    harvestArtifactsOut(artifacts);
  }
}

/**
 * A k8s ResourceQuota rejection during PROVISIONING (pod-create) throws OUTSIDE
 * the in-callback runAgent catch — `withSandbox` provisions before it runs `fn`.
 * Surface it as an `error_quota` RESULT (not a throw) so the runner flags
 * backpressure and requeues, instead of the run terminal-failing red. Every
 * other provision failure propagates unchanged (withSandbox already disposed).
 */
function quotaAsResult(startTime: number) {
  return (err: unknown): ExecutionResult => {
    if (err instanceof QuotaExceededError) {
      return {
        success: false,
        output: "",
        turns: 0,
        error: err.message,
        durationMs: Date.now() - startTime,
        stopReason: "error_quota",
      };
    }
    throw err;
  };
}

/**
 * Run one agent turn through any backend. Replaces `executeDocker` /
 * `executeSmol` / `executeInProcess` — the three slightly-different fallback
 * paths are converged into the single catch in {@link runAgentIn}.
 */
export async function runSandboxedAgent(
  prompt: string,
  ctx: SandboxRunContext,
  span?: Span,
): Promise<ExecutionResult> {
  // Taken before provisioning, so a single-turn phase's recorded duration keeps
  // including its own provision — see {@link AgentTurnOpts.startTime}.
  const startTime = Date.now();
  return withSandbox(ctx, (sandbox, prov) =>
    withWorkspaceArtifacts(sandbox, prov, ctx, () =>
      runAgentIn(sandbox, prov, prompt, ctx, { span, startTime }),
    ),
  ).catch(quotaAsResult(startTime));
}

// ── Deterministic command path (type: bash / type: script) ───────────

/** What a command phase runs. */
// CommandSpec's canonical home is now the workflow engine's vocabulary
// (`workflow-engine/core/types.ts`); re-export it so existing importers of
// `./executors/orchestrator.js` (and the `agent-executor.js` chain) resolve
// unchanged.
export type { CommandSpec } from "lastlight-workflow-engine";
import type { CommandSpec } from "lastlight-workflow-engine";

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
  // A type:script phase stages the script bytes into the sandbox by writing them
  // to `prov.hostWorkspaceDir` — correct for every host-shared backend
  // (docker/smol/none), where that dir is bind-mounted into the guest. The k8s
  // backend has no host-shared workspace (skills + AGENTS.md reach the pod over
  // HTTP init-fetch channels instead), and nothing stages the script into the
  // pod, so the write would land on the harness FS and the pod would hit a
  // confusing `No such file or directory`. Fail fast with an actionable message.
  // type:bash is unaffected — it runs the command directly, staging no file.
  if (ctx.backend === "kubernetes" && spec.kind === "script") {
    throw new Error(
      "type:script phases are not yet supported on the kubernetes backend " +
        "(no host-shared workspace to stage the script into the pod); use a " +
        "type:bash phase, or run this workflow on the docker/gondolin backend",
    );
  }

  const startTime = Date.now();
  try {
    return await withSandbox(ctx, (sandbox, prov) => runCommandIn(sandbox, prov, spec, ctx, cmdOpts));
  } catch (err: unknown) {
    // A k8s ResourceQuota rejection on a bash/script phase is backpressure too:
    // surface it as an error_quota RESULT so the runner requeues (spec/09-sandbox.md (Concurrency)).
    // Every other throw propagates exactly as before (the engine records it as a
    // failed phase) — we do NOT swallow real command failures.
    return quotaAsResult(startTime)(err);
  }
}

/**
 * Run ONE deterministic command inside an ALREADY-PROVISIONED sandbox — the
 * command-side twin of {@link runAgentIn}, extracted from
 * {@link runSandboxedCommand}'s `withSandbox` callback for the same reason: a
 * `type: fanout` phase runs its branches' `until_bash` gates in the workspace it
 * already holds rather than provisioning six more.
 */
export async function runCommandIn(
  sandbox: Sandbox,
  prov: ProvisionResult,
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

  return await (async () => {
    {
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

      // Git identity + auth, same as the agent path (runSandboxedAgent) — so a
      // commit made by a deterministic bash/script phase (e.g. a status-doc commit)
      // is authored as the configured botLogin, not left identity-less. The
      // caller's sandboxEnv (upstream phase outputs) wins on key collision.
      //
      // Also forward the GitHub API base-url override (evals fake): the agent path
      // threads `githubApiBaseUrl` too, so a GitHub-mutating script (e.g.
      // pr-review's post-review step) hits the fake in evals. Prod-inert —
      // `githubApiBaseUrl` is undefined outside the eval harness.
      const sandboxEnv = {
        ...agentGitIdentityEnv(getRuntimeConfig()?.botLogin ?? `${getBotName()}[bot]`, ctx.env.GIT_TOKEN),
        ...(cmdOpts.sandboxEnv ?? {}),
        ...(config.githubApiBaseUrl ? { GITHUB_API_URL: config.githubApiBaseUrl } : {}),
      };
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
              phase: config.telemetry?.phaseName,
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
    }
  })();
}

// ── The multi-turn bracket (`type: fanout`) ──────────────────────────

/**
 * One provisioned workspace, many turns. Handed to the callback of
 * {@link withSandboxSession}.
 *
 * `config` is per-CALL rather than per-session because that is exactly what
 * varies across the branches of a fan-out: the skill bundle key
 * (`telemetry.phaseName`), the resolved `skillPaths`, and optionally the model /
 * reasoning effort. Everything genuinely per-workspace — backend, taskId,
 * minted GitHub credential, egress policy, pre-clone — is fixed when the session
 * opens and cannot be varied per turn.
 */
export interface SandboxSession {
  /**
   * The agent's working directory, addressed from the HARNESS process — the
   * host end of {@link ProvisionResult.agentCwd}.
   *
   * Exposed because a fan-out branch may need the harness to read a file a
   * deterministic phase wrote into the checkout (`FanoutBranch.context_file`),
   * and the harness must resolve it against exactly the base that phase's shell
   * ran in. `hostWorkspaceDir` is one level too high whenever the workflow
   * pre-clones — which is the whole class of bug this exists to close.
   *
   * On `kubernetes` this is an in-pod path: a read fails, and the caller must
   * degrade rather than read the failure as "the file is not there".
   */
  readonly hostAgentCwd: string;
  runAgent(
    prompt: string,
    config: ExecutorConfig,
    opts?: { onSessionId?: (id: string) => void; span?: Span },
  ): Promise<ExecutionResult>;
  runCommand(
    spec: CommandSpec,
    config: ExecutorConfig,
    opts?: CommandRunOpts & { onSessionId?: (id: string) => void },
  ): Promise<ExecutionResult>;
}

/**
 * Provision ONE sandbox and hand the caller a {@link SandboxSession} that can
 * run any number of agent turns and commands in it — concurrently if it wants.
 *
 * This is the whole mechanism behind `type: fanout`, and the reason the fan-out
 * dodges the blocker list in `docs/plans/review-evidence-pipeline/05-parallel-phases.md`:
 * every one of B1 / D1 / D2 / D3 / D7 exists because each PHASE provisions its
 * own sandbox against a shared workspace. Here there is exactly one provision,
 * one `AGENTS.md` write, one artifact stage/harvest and one dispose, no matter
 * how many turns run inside.
 *
 * **Concurrency is the caller's to bound.** This bracket imposes none: the
 * handler clamps per backend before it ever gets here (`none`/`docker` fan out;
 * `gondolin` boots a QEMU micro-VM per session and is pinned to 1).
 */
export async function withSandboxSession<T>(
  ctx: SandboxRunContext,
  fn: (session: SandboxSession) => Promise<T>,
): Promise<T> {
  return withSandbox(ctx, (sandbox, prov) =>
    withWorkspaceArtifacts(sandbox, prov, ctx, () => {
      const session: SandboxSession = {
        hostAgentCwd: prov.hostAgentCwd,
        runAgent: (prompt, config, opts) =>
          runAgentIn(
            sandbox,
            prov,
            prompt,
            { ...ctx, config, onSessionId: opts?.onSessionId ?? ctx.onSessionId },
            { span: opts?.span },
          ),
        runCommand: (spec, config, opts) =>
          runCommandIn(
            sandbox,
            prov,
            spec,
            { ...ctx, config, onSessionId: opts?.onSessionId ?? ctx.onSessionId },
            {
              timeoutSeconds: opts?.timeoutSeconds,
              sandboxEnv: opts?.sandboxEnv,
              writeSession: opts?.writeSession,
            },
          ),
      };
      return fn(session);
    }),
  );
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
  /** Owning phase label — see {@link AgenticShimOptions.phase}. */
  phase?: string;
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
    phase: opts.phase,
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

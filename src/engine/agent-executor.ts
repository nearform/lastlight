import { resolve, basename, join, relative } from "path";
import { cpSync, existsSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { randomUUID } from "crypto";
import type { run as agenticRunType, RunResult, ThinkingLevel } from "agentic-pi";
import {
  createTaskSandbox,
  setupTaskWorktree,
  type DockerSandbox,
} from "../sandbox/index.js";
import { refreshGitAuth } from "./git-auth.js";
import {
  AGENTIC_PROFILE_FOR,
  GITHUB_PERMISSION_PROFILES,
  loadAgentContext,
  type ExecutorConfig,
  type ExecutionResult,
  type ExtensionStatusMap,
  type SkillsStatus,
  type GitSandboxAccess,
} from "./profiles.js";
import { AgenticShim, truncateForLog, safeStringify } from "./event-shim.js";
import { projectSlugForCwd } from "../session-log.js";
import type { SandboxBackend } from "../config.js";
import { ALLOW_ALL_SENTINEL, DEFAULT_ALLOWLIST, mergeAllowlist } from "../sandbox/egress-allowlist.js";
import { getDockerSandboxOtelEnv, getOtelEnvForSandbox, recordError, recordExecutionMetrics, safeSpanAttributes, withSpan } from "../telemetry/index.js";
import { recordPiEvent } from "../telemetry/pi-events.js";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
const DOCKER_WORKSPACE_DIR = "/home/agent/workspace";
// Per-workspace root holding one skill bundle per phase. Deliberately NOT
// named `.agents/skills` (pi's auto-discovery path): we map each phase's
// bundle explicitly via --skill / skillPaths so two phases sharing a
// workspace — sequential today, parallel via worktrees tomorrow — can never
// clobber each other's catalogue. It lives at the workspace ROOT, a sibling
// of any checked-out repo, so it never enters the repo's git tree and the
// agent never sees or commits it.
const SKILL_BUNDLE_ROOT = ".lastlight-skills";
const THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off", "minimal", "low", "medium", "high", "xhigh",
]);

/**
 * Stage this phase's declared skills into a per-phase bundle directory at
 * `<workspaceRoot>/.lastlight-skills/<phaseKey>/<basename>/` and return the
 * staged skill dirs, so the caller can point pi at them explicitly (via
 * `--skill` for docker or `skillPaths` for the in-process backends). Each
 * skill is a directory containing SKILL.md plus any `scripts/` / `references/`
 * / `assets/` — the whole tree comes along.
 *
 * Keyed by phase so concurrent phases in one workspace never touch each
 * other's bundle: only the phase's own `<phaseKey>` subtree is cleared, so a
 * clean slate per phase doesn't disturb a sibling phase mid-run.
 *
 * `mode` controls how each skill lands:
 *   - "symlink": one symlink per skill → host source. gondolin/none, where pi
 *     resolves skill files relative to cwd (the workspace root) and the bundle
 *     rides the cwd mount. Zero-copy.
 *   - "copy": recursive copy. docker, where the agent's tools run inside the
 *     container and host symlink targets wouldn't resolve; the copy lands
 *     under the bind-mounted workspace.
 *
 * Returns `undefined` when the phase declares no skills (after clearing its
 * bundle), so a phase with no `skills:` gets no catalogue at all.
 */
export function stageSkillBundle(
  workspaceRoot: string,
  phaseKey: string,
  skillPaths: string[] | undefined,
  mode: "symlink" | "copy",
): string[] | undefined {
  const bundleDir = join(workspaceRoot, SKILL_BUNDLE_ROOT, phaseKey);
  if (existsSync(bundleDir)) {
    rmSync(bundleDir, { recursive: true, force: true });
  }
  if (!skillPaths?.length) return undefined;
  mkdirSync(bundleDir, { recursive: true });
  const staged: string[] = [];
  for (const hostPath of skillPaths) {
    const dest = join(bundleDir, basename(hostPath));
    if (mode === "symlink") {
      symlinkSync(hostPath, dest, "dir");
    } else {
      cpSync(hostPath, dest, { recursive: true, dereference: true });
    }
    staged.push(dest);
  }
  return staged;
}

/**
 * Sanitized per-phase key for the skill bundle directory. Phase name first
 * (unique even for loop iterations like `reviewer_fix_1`), then workflow name,
 * then a constant fallback — so the bundle is always isolated per phase.
 */
function skillBundleKey(config: ExecutorConfig): string {
  const raw = config.telemetry?.phaseName || config.telemetry?.workflowName || "phase";
  return raw.replace(/[^A-Za-z0-9_-]/g, "_") || "phase";
}

/**
 * Execute one workflow-phase agent task via agentic-pi.
 *
 * Sandbox backend (decided per call):
 *  1. gondolin — agentic-pi's QEMU micro-VM. cwd is the host worktree,
 *     mounted at /workspace inside the VM.
 *  2. docker — the legacy container path (`src/sandbox/docker.ts`). The
 *     entrypoint inside the container execs `agentic-pi run --sandbox none`.
 *  3. none — agentic-pi in-process with cwd = the host worktree.
 */
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

// ── In-process path (gondolin / none) ───────────────────────────────

async function executeInProcess(
  prompt: string,
  config: ExecutorConfig,
  ctx: {
    backend: SandboxBackend;
    taskId: string;
    workDir: string;
    stateDir: string;
    env: Record<string, string>;
    access?: GitSandboxAccess;
    onSessionId?: (sessionId: string) => void;
  },
): Promise<ExecutionResult> {
  const startTime = Date.now();
  console.log(
    `  [executor] Running in-process (task: ${ctx.taskId}, sandbox: ${ctx.backend})`,
  );

  const model = config.model || DEFAULT_MODEL;
  const thinking = coerceThinking(config.variant);
  const profile = ctx.access ? AGENTIC_PROFILE_FOR[ctx.access.profile] : undefined;
  const sessionsDir = resolveSessionsDir(config);
  // cwd is the workspace ROOT — the parent of any pre-cloned repo subdir
  // (`<workDir>/<repo>/`). Keeping the repo a child of cwd lets the per-phase
  // skill bundle sit as a sibling (under cwd, so gondolin mounts it) without
  // ever entering the repo's git tree. Repo-write prompts `cd {{repo}}` as
  // their first step. pi-coding-agent's AGENTS.md discovery finds the
  // workspace-root `AGENTS.md` directly at cwd.
  const agentCwd = ctx.workDir;

  // Stage this phase's skills into its own bundle dir and point pi at the
  // staged dirs explicitly via `skillPaths` below. Symlinks suffice — pi
  // resolves them relative to cwd in the harness process / VM mount.
  let stagedSkillDirs: string[] | undefined;
  try {
    stagedSkillDirs = stageSkillBundle(agentCwd, skillBundleKey(config), config.skillPaths, "symlink");
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[executor] Could not stage skills: ${msg}`);
  }

  const shim = new AgenticShim({
    homeDir: sessionsDir,
    projectSlug: projectSlugForCwd(agentCwd),
    model,
    initialPrompt: prompt,
  });

  // agentic-pi reads its own env (provider keys, App PEM, etc.) from
  // process.env. Splice in our scoped values for the duration of the call,
  // then restore.
  const restore = applyEnv(ctx.env);

  // Env forwarded INTO the sandbox so the agent's `bash` calls see it.
  // agentic-pi auto-injects GITHUB_TOKEN/GH_TOKEN when --profile is set;
  // git identity is set here so `git commit` works without extra setup.
  //
  // Notes per backend:
  //   - gondolin: the VM's user inherits HOME from the agentic-pi process
  //     (so the host's HOME — e.g. /Users/clifton — leaks in). We force
  //     HOME=/root so `git config --global` and `gh auth status` write
  //     to a real path inside the VM.
  //   - none: agent runs on the host; do NOT override HOME (would mess
  //     with the harness user's real config).
  //   - docker (handled separately): the container's `agent` user has
  //     its own HOME=/home/agent baked in by the image; no override.
  const baseSandboxEnv: Record<string, string> = {
    GIT_AUTHOR_NAME: "last-light[bot]",
    GIT_AUTHOR_EMAIL: "last-light[bot]@users.noreply.github.com",
    GIT_COMMITTER_NAME: "last-light[bot]",
    GIT_COMMITTER_EMAIL: "last-light[bot]@users.noreply.github.com",
    // /workspace is a bind mount from the host (host UID) into a VM running
    // as a different UID; git refuses to operate without an explicit
    // safe-directory. Setting it via GIT_CONFIG_* avoids needing HOME and
    // a writeable ~/.gitconfig.
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
  };
  const otelSandboxEnv = config.otel?.enabled && config.otel.forwardToSandbox ? getOtelEnvForSandbox() : {};
  const sandboxEnv: Record<string, string> =
    ctx.backend === "gondolin"
      ? { ...otelSandboxEnv, ...baseSandboxEnv, HOME: "/root", USER: "root", LOGNAME: "root" }
      : { ...otelSandboxEnv, ...baseSandboxEnv };

  let notifiedSessionId = false;
  let result: RunResult;
  const acc = new RunResultAccumulator();
  try {
    // HTTP egress allowlist. lastlight owns the policy (rather than relying
    // on agentic-pi's bundled default) so a single source — `egress-allowlist.ts`
    // — covers both backends. `unrestrictedEgress` opts a phase out via the
    // `"*"` sentinel; gondolin (post the upstream allow-all patch) treats it
    // as "allow every host".
    const extraHosts = config.otel?.enabled && config.otel.forwardToSandbox ? config.otel.collectorHosts : [];
    const allowedHttpHosts = config.unrestrictedEgress
      ? [ALLOW_ALL_SENTINEL]
      : mergeAllowlist(DEFAULT_ALLOWLIST, extraHosts);

    // Loaded lazily: agentic-pi transitively imports pi-coding-agent, whose
    // bundled undici writes a v8 Agent onto `Symbol.for('undici.globalDispatcher.1')`
    // the moment its `lib/global.js` evaluates. Node's built-in fetch reads
    // from the same symbol, so eager-loading here would poison every fetch
    // in the harness — breaking arctic's OAuth code exchange (strict
    // content-length validation). Dynamic import keeps the harness on
    // Node's clean dispatcher unless an in-process sandbox actually runs.
    const { run: agenticRun }: { run: typeof agenticRunType } = await import("agentic-pi");

    result = await agenticRun({
      model,
      prompt,
      thinking,
      profile,
      sandbox: ctx.backend === "gondolin" ? "gondolin" : "none",
      sandboxEnv,
      cwd: agentCwd,
      noSession: true,
      // Explicit per-phase skill bundle (staged above). pi loads these
      // additively; nothing is written into the repo for the agent to commit.
      skillPaths: stagedSkillDirs,
      allowedHttpHosts,
      // Explicit boolean — without it, agentic-pi auto-enables web search
      // when any provider key is in process.env. We forwarded those keys
      // above only for opted-in workflows, but `process.env` on the harness
      // host carries them regardless, so we must opt-out explicitly.
      webSearch: config.webSearch === true,
      webSearchProvider: config.webSearchProvider,
      onEvent: (record) => {
        acc.feed(record);
        shim.feed(record);
        recordPiEvent(record as Record<string, unknown>, {
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
      },
      onWarn: (msg) => console.warn(`[agentic] ${msg}`),
    });
  } catch (err: unknown) {
    restore();
    const msg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;
    recordError("agent", err, { "sandbox.backend": ctx.backend, model, success: false, stop_reason: "error_executor", "workflow.name": config.telemetry?.workflowName, "phase.name": config.telemetry?.phaseName });
    recordExecutionMetrics("agent", { "sandbox.backend": ctx.backend, model, success: false, stop_reason: "error_executor", durationMs });
    const fallbackId = `exec-${basename(ctx.taskId)}`;
    const synthesizedId = await shim
      .finalizeWithFallback(
        emptyResult("error_executor", durationMs),
        fallbackId,
        msg,
      )
      .catch(() => null);
    return {
      success: false,
      output: "",
      turns: 0,
      error: msg,
      durationMs,
      sessionId: synthesizedId ?? undefined,
      stopReason: "error_executor",
    };
  }
  restore();

  // agentic-pi's in-process `stats` is the same compaction-blind
  // `usage_snapshot`. Prefer our per-message accumulation when it carries
  // token data (see RunResultAccumulator.bestStats).
  const better = acc.bestStats();
  if (better && (better.tokens?.total ?? 0) > 0) result.stats = better;

  const finalResult = await finalizeFromRunResult(result, prompt, shim, startTime, acc.extensions(), acc.skills(), acc.toolError(), acc.endedOnToolCall());
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
}

// ── Docker path ─────────────────────────────────────────────────────

async function executeDocker(
  prompt: string,
  config: ExecutorConfig,
  ctx: {
    taskId: string;
    stateDir: string;
    env: Record<string, string>;
    prePopulate?: { owner: string; repo: string; branch: string; token: string; runId?: string; shallow?: boolean };
    access?: GitSandboxAccess;
    onSessionId?: (sessionId: string) => void;
  },
): Promise<ExecutionResult> {
  // HTTP egress routing — docker analog of the gondolin allowlist.
  // Sandbox is wired to coredns-strict by default (allowlist enforced via
  // DNS sinkhole + nginx ssl_preread); a phase that set
  // `unrestricted_egress: true` points at coredns-open instead.
  // The IPs here match the static assignments in docker-compose.yml
  // (see src/sandbox/egress-firewall-config.ts for the constants).
  const dnsIp = config.unrestrictedEgress
    ? (process.env.LASTLIGHT_DNS_OPEN || "172.30.0.11")
    : (process.env.LASTLIGHT_DNS_STRICT || "172.30.0.10");

  const sbx = await createTaskSandbox({
    taskId: ctx.taskId,
    stateDir: ctx.stateDir,
    sandboxDir: config.sandboxDir,
    env: ctx.env,
    prePopulate: ctx.prePopulate,
    dnsIp,
  });
  if (!sbx) {
    throw new Error(
      "LASTLIGHT_SANDBOX=docker but no docker sandbox was available. " +
      "Install Docker and build the sandbox image, or set LASTLIGHT_SANDBOX=gondolin / none.",
    );
  }

  try {
    const md = loadAgentContext(config.agentContextDir);
    if (md) writeFileSync(join(sbx.workDir, "AGENTS.md"), md);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[executor] Could not write docker AGENTS.md: ${msg}`);
  }

  const startTime = Date.now();
  console.log(`  [executor] Running in docker sandbox (task: ${ctx.taskId})`);

  const model = config.model || DEFAULT_MODEL;
  const thinking = coerceThinking(config.variant);
  const profile = ctx.access ? AGENTIC_PROFILE_FOR[ctx.access.profile] : undefined;
  const sessionsDir = resolveSessionsDir(config);
  // cwd = workspace root (parent of any pre-cloned `<workspace>/<repo>/`
  // subdir). See the in-process path for the rationale; repo-write prompts
  // `cd {{repo}}` as their first step.
  const agentCwd = DOCKER_WORKSPACE_DIR;

  // Stage this phase's skills into its own bundle under the workspace root.
  // The container's bind-mount of `<sbx.workDir>` → `/home/agent/workspace`
  // is already live, so host writes appear in the container. Copy (not
  // symlink) because the agent's tools run inside the container and host
  // symlink targets don't resolve there. Map the host dests to their
  // in-container paths for `--skill` (passed to runAgent below).
  let skillDirsInContainer: string[] = [];
  try {
    const staged = stageSkillBundle(sbx.workDir, skillBundleKey(config), config.skillPaths, "copy");
    if (staged) {
      skillDirsInContainer = staged.map((d) => `${DOCKER_WORKSPACE_DIR}/${relative(sbx.workDir, d)}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[executor] Could not stage skills in docker workspace: ${msg}`);
  }
  // The dashboard reads from <sessionsDir>/projects/<slug>/. Use the same
  // resolved cwd for the slug so live tails land in the right project dir.
  const shim = new AgenticShim({
    homeDir: sessionsDir,
    projectSlug: projectSlugForCwd(agentCwd),
    model,
    initialPrompt: prompt,
  });

  const acc = new RunResultAccumulator();
  let notifiedSessionId = false;
  // Identity forwarded into the sandboxed agentic-pi run inside the container.
  // The container's `agent` user already has HOME=/home/agent set up, so we
  // do NOT override HOME here — only git identity + safe.directory (for the
  // host-UID bind mount). GITHUB_TOKEN/GH_TOKEN are auto-injected by
  // agentic-pi when --profile is set.
  const sandboxEnv: Record<string, string> = {
    // Inner-run env for the agent's child shells. Points at the in-network
    // collector (IP-only, no secret headers) so any OTLP a script emits is
    // tunnelled the same way the agent's own telemetry is.
    ...(config.otel?.enabled && config.otel.forwardToSandbox ? getDockerSandboxOtelEnv() : {}),
    GIT_AUTHOR_NAME: "last-light[bot]",
    GIT_AUTHOR_EMAIL: "last-light[bot]@users.noreply.github.com",
    GIT_COMMITTER_NAME: "last-light[bot]",
    GIT_COMMITTER_EMAIL: "last-light[bot]@users.noreply.github.com",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
  };
  try {
    await sbx.sandbox.runAgent(ctx.taskId, prompt, {
      model,
      thinking,
      profile,
      sandboxEnv,
      agentCwd,
      skillDirs: skillDirsInContainer,
      webSearch: config.webSearch === true,
      webSearchProvider: config.webSearchProvider,
      onLine: (line) => {
        if (!line.startsWith("{")) return;
        let record: Record<string, unknown>;
        try {
          record = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return;
        }
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
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;
    recordError("agent", err, { "sandbox.backend": "docker", model, success: false, stop_reason: "error_sandbox", "workflow.name": config.telemetry?.workflowName, "phase.name": config.telemetry?.phaseName });
    recordExecutionMetrics("agent", { "sandbox.backend": "docker", model, success: false, stop_reason: "error_sandbox", durationMs });
    const fallbackId = `exec-${basename(ctx.taskId)}`;
    const synthesizedId = await shim
      .finalizeWithFallback(
        emptyResult("error_sandbox", durationMs),
        fallbackId,
        msg,
      )
      .catch(() => null);
    await sbx.cleanup();
    return {
      success: false,
      output: "",
      turns: 0,
      error: msg,
      durationMs,
      sessionId: synthesizedId ?? undefined,
      stopReason: "error_sandbox",
    };
  }
  await sbx.cleanup();
  const finalResult = await finalizeFromRunResult(acc.build(0), prompt, shim, startTime, acc.extensions(), acc.skills(), acc.toolError(), acc.endedOnToolCall());
  recordExecutionMetrics("agent", {
    "sandbox.backend": "docker",
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
}

/**
 * Build a RunResult-shaped tally from the JSONL event stream emitted by
 * `agentic-pi run` inside the docker sandbox. Mirrors what agentic-pi's
 * own `run()` function does in-process — minimum viable subset of
 * fields the executor cares about.
 *
 * Usage accounting accumulates each assistant `message_end`'s `usage`
 * rather than trusting the terminal `usage_snapshot`. pi's snapshot is
 * derived from `getSessionStats()`, which recomputes from the *current*
 * in-memory message window — auto-compaction replaces those messages with
 * a summary, so the snapshot reports zero tokens/cost/turns the moment a
 * phase compacts. The per-message events fire at finalization (before any
 * compaction rebuild), so summing them is compaction-proof. `bestStats()`
 * prefers the accumulation and falls back to the snapshot only when no
 * per-message usage was observed.
 */
export class RunResultAccumulator {
  private sessionId?: string;
  private finalText = "";
  private agentEnded = false;
  private toolErrors = false;
  private lastToolError?: { tool?: string; message: string };
  // True iff the last assistant turn ended with a tool call — i.e. the agent
  // asked for a tool and the loop terminated before it could respond to the
  // result. That's a truncated run (pi hit its internal step cap mid-task),
  // not a finished one. See `finalizeFromRunResult`'s truncation guard.
  private lastAssistantHadToolCall = false;
  private fatalError?: { name: string; message: string };
  private snapshotStats?: RunResult["stats"];
  private messages: unknown[] = [];

  // Per-message usage accumulation (the compaction-proof source).
  private assistantMessages = 0;
  private userMessages = 0;
  private toolCalls = 0;
  private toolResults = 0;
  private msgInput = 0;
  private msgOutput = 0;
  private msgCacheRead = 0;
  private msgCacheWrite = 0;
  private msgCost = 0;

  // Extension status events (file-search / github / web-search), keyed by
  // extension name. Emitted once each at run start; we keep the raw payload
  // (minus type/extension) so build() can map them onto the RunResult.
  private ext: Record<string, Record<string, unknown>> = {};

  // Skill-loading status. agentic-pi emits a single (gated) `skills_status`
  // event at run start; we keep the raw payload (minus type) so skills()
  // can normalize it onto the RunResult, mirroring `ext` above for tools.
  private skillsRaw?: Record<string, unknown>;

  feed(r: Record<string, unknown>): void {
    switch (r.type) {
      case "session":
        if (typeof r.id === "string") this.sessionId = r.id;
        break;
      case "extension_status": {
        if (typeof r.extension === "string") {
          const { type: _t, extension: _e, ...rest } = r;
          this.ext[r.extension] = rest;
        }
        break;
      }
      case "skills_status": {
        const { type: _t, ...rest } = r;
        this.skillsRaw = rest;
        break;
      }
      case "message_end": {
        const m = r.message as
          | {
              role?: string;
              content?: Array<{ type?: string; text?: string }>;
              usage?: Record<string, unknown>;
            }
          | undefined;
        if (m?.role === "assistant" && Array.isArray(m.content)) {
          const text = m.content
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text as string)
            .join("");
          if (text) this.finalText = text;
          this.assistantMessages += 1;
          const toolCallsInTurn = m.content.filter((c) => c.type === "toolCall").length;
          this.toolCalls += toolCallsInTurn;
          // Track whether the *latest* assistant turn requested a tool. If the
          // run ends here (no synthesis turn follows the tool result), the
          // agent was cut off mid-task.
          this.lastAssistantHadToolCall = toolCallsInTurn > 0;
          this.accumulateUsage(m.usage);
        } else if (m?.role === "user") {
          this.userMessages += 1;
        }
        break;
      }
      case "tool_execution_end":
        this.toolResults += 1;
        if (r.isError === true) {
          this.toolErrors = true;
          // Keep the actual failure text (not just a boolean) so a run that
          // ends in `error_tool` can report which tool failed and why —
          // e.g. a provider `insufficient_quota` surfaced through an MCP
          // call, or a bash command's stderr. Last error wins (it's the
          // one that ended the run). truncate: tool output can be huge.
          const raw = r.error ?? r.result ?? r.output;
          const message = truncateForLog(
            typeof raw === "string" ? raw : safeStringify(raw),
            4096,
          );
          const tool =
            typeof r.tool === "string"
              ? r.tool
              : typeof r.toolName === "string"
              ? r.toolName
              : undefined;
          if (message) this.lastToolError = { tool, message };
        }
        break;
      case "agent_end":
        this.agentEnded = true;
        if (Array.isArray(r.messages)) this.messages = r.messages;
        break;
      case "usage_snapshot":
        this.snapshotStats = r.stats as RunResult["stats"];
        break;
      case "fatal_error":
        this.fatalError = r.error as { name: string; message: string };
        break;
    }
  }

  private accumulateUsage(usage: Record<string, unknown> | undefined): void {
    if (!usage || typeof usage !== "object") return;
    const num = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    this.msgInput += num(usage.input);
    this.msgOutput += num(usage.output);
    this.msgCacheRead += num(usage.cacheRead);
    this.msgCacheWrite += num(usage.cacheWrite);
    const cost = usage.cost as { total?: unknown } | undefined;
    if (cost && typeof cost === "object") this.msgCost += num(cost.total);
  }

  /** Stats summed from per-message usage, or undefined if none was seen. */
  private accumulatedStats(): RunResult["stats"] | undefined {
    const total =
      this.msgInput + this.msgOutput + this.msgCacheRead + this.msgCacheWrite;
    if (this.assistantMessages === 0 && total === 0) return undefined;
    return {
      userMessages: this.userMessages,
      assistantMessages: this.assistantMessages,
      toolCalls: this.toolCalls,
      toolResults: this.toolResults,
      tokens: {
        input: this.msgInput,
        output: this.msgOutput,
        cacheRead: this.msgCacheRead,
        cacheWrite: this.msgCacheWrite,
        total,
      },
      cost: this.msgCost,
    };
  }

  /**
   * Prefer the per-message accumulation (compaction-proof) over pi's
   * terminal `usage_snapshot`. Fall back to the snapshot only when the
   * accumulation carries no token data — e.g. a provider that doesn't
   * report per-message usage — so a non-compacted snapshot still wins.
   */
  bestStats(): RunResult["stats"] | undefined {
    const acc = this.accumulatedStats();
    if (acc && acc.tokens.total > 0) return acc;
    return this.snapshotStats ?? acc;
  }

  build(exitCode: 0 | 1 | 2): RunResult {
    return {
      exitCode: exitCode as RunResult["exitCode"],
      ok: exitCode === 0 && !this.fatalError,
      agentEnded: this.agentEnded,
      toolErrors: this.toolErrors,
      fatalError: this.fatalError,
      sessionId: this.sessionId,
      finalText: this.finalText,
      messages: this.messages,
      stats: this.bestStats(),
      records: [],
      warnings: [],
    };
  }

  /**
   * Normalized extension status captured from `extension_status` events
   * (file-search / github / web-search), or undefined if none reported.
   * Decoupled from agentic-pi's `RunResult` type, which lags the runtime —
   * the docker sandbox's agentic-pi emits file-search even when the harness's
   * pinned `RunResult` type doesn't yet declare it.
   */
  extensions(): ExtensionStatusMap | undefined {
    const out: ExtensionStatusMap = {};
    for (const [name, v] of Object.entries(this.ext)) {
      if (v && typeof v.status === "string") {
        out[name] = {
          status: v.status,
          ...(typeof v.mode === "string" ? { mode: v.mode } : {}),
          ...(typeof v.provider === "string" ? { provider: v.provider } : {}),
          ...(typeof v.toolCount === "number" ? { toolCount: v.toolCount } : {}),
          ...(typeof v.reason === "string" ? { reason: v.reason } : {}),
        };
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /**
   * Normalized skill-loading status from the gated `skills_status` event, or
   * undefined if none was reported (agentic-pi suppresses it on a run that
   * configured no skills and discovered none). The skill-loading counterpart
   * to {@link extensions}.
   */
  skills(): SkillsStatus | undefined {
    const s = this.skillsRaw;
    if (!s || typeof s.status !== "string") return undefined;
    const skills = Array.isArray(s.skills)
      ? s.skills
          .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
          .map((x) => ({
            name: typeof x.name === "string" ? x.name : "",
            source: typeof x.source === "string" ? x.source : "",
            modelInvocable: x.modelInvocable === true,
          }))
      : [];
    return {
      status: s.status,
      discovered: typeof s.discovered === "number" ? s.discovered : skills.length,
      skills,
      mappedPaths: Array.isArray(s.mappedPaths)
        ? s.mappedPaths.filter((p): p is string => typeof p === "string")
        : [],
      noSkills: s.noSkills === true,
    };
  }

  /**
   * The last tool result that came back with `isError: true`, including the
   * failure text — or undefined if no tool errored. This is what turns a
   * bare `error_tool` stop reason into a human-readable cause.
   */
  toolError(): { tool?: string; message: string } | undefined {
    return this.lastToolError;
  }

  /**
   * True iff the run's final assistant turn ended on a tool call — meaning
   * the agent intended to keep going but the loop stopped before it could
   * respond to the tool result and write its answer. The signal a run was
   * truncated (step-limit) rather than genuinely finished.
   */
  endedOnToolCall(): boolean {
    return this.lastAssistantHadToolCall;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function finalizeFromRunResult(
  result: RunResult,
  _prompt: string,
  shim: AgenticShim,
  startTime: number,
  extensions?: ExtensionStatusMap,
  skills?: SkillsStatus,
  toolError?: { tool?: string; message: string },
  endedOnToolCall = false,
): ExecutionResult {
  const durationMs = Date.now() - startTime;
  const stats = result.stats;
  // pi-agent-core swallows provider API errors (insufficient_quota, rate
  // limit, auth) inside `handleRunFailure`: it synthesizes an assistant
  // message with stopReason "error" + errorMessage and emits a clean
  // agent_end. Without this check the run would map to "success" and the
  // workflow would silently advance with no output. See message scan below.
  const agentError = extractAgentError(result);
  let stopReason = agentError?.stopReason ?? mapStopReason(result);

  // Truncation guard. A run that *would* map to "success" but whose final
  // assistant turn ended on a tool call was cut off mid-task: the agent
  // asked for a tool and the loop stopped before it could read the result
  // and synthesize an answer (pi hit its internal step cap — agentic-pi
  // v0.2.7 exposes no maxSteps knob to lift it). In that state `finalText`
  // is the agent's "let me just check X" preamble, NOT an answer. Reclassify
  // as a failure so the workflow fires `on_failure` instead of delivering
  // the fragment as if it were the result.
  const truncated = stopReason === "success" && !agentError && endedOnToolCall;
  if (truncated) stopReason = "error_truncated";
  const success = stopReason === "success";
  const truncationMessage =
    "Agent stopped mid-task before producing a final answer (hit the agent " +
    "step limit). No answer was delivered.";

  // A bare `error_tool` stop reason is useless on its own. Surface the
  // failing tool's actual error text so the executions row and dashboard
  // show *why* the run died (e.g. "Tool `bash` failed: insufficient_quota").
  const toolErrorText = toolError
    ? toolError.tool
      ? `Tool \`${toolError.tool}\` failed: ${toolError.message}`
      : toolError.message
    : undefined;

  const inputTokens = stats?.tokens.input ?? 0;
  const outputTokens = stats?.tokens.output ?? 0;
  const cacheRead = stats?.tokens.cacheRead ?? 0;
  const cacheWrite = stats?.tokens.cacheWrite ?? 0;
  const costUsd = stats?.cost ?? 0;
  const turns = stats?.assistantMessages ?? 0;

  const costStr = costUsd > 0 ? `, $${costUsd.toFixed(4)}` : "";
  console.log(
    `  [executor] Result: ${stopReason} (${turns} turns, ${Math.round(durationMs / 1000)}s${costStr})` +
    `${result.sessionId ? ` [session ${result.sessionId}]` : ""}`,
  );

  shim.finalize({
    finalText: result.finalText,
    turns,
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
    stopReason,
    durationMs,
    apiErrorMessage:
      agentError?.errorMessage ??
      (success ? undefined : (toolErrorText ?? (truncated ? truncationMessage : undefined))),
  });
  void shim.flush();

  // Only fold the tool error into account-error detection on a failed run.
  // A *successful* run may carry a tool result that legitimately contains
  // "unauthorized" / "rate limit" (e.g. a curl probing a 401 endpoint as
  // part of the task) — folding that in would wrongly fail the run.
  const combined = [
    result.fatalError?.message,
    agentError?.errorMessage,
    result.finalText,
    success ? undefined : toolErrorText,
  ]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n")
    .toLowerCase();
  const accountError =
    combined.includes("credit balance") ||
    combined.includes("insufficient_quota") ||
    combined.includes("insufficient quota") ||
    combined.includes("rate limit") ||
    combined.includes("unauthorized") ||
    combined.includes("invalid_api_key");

  const errorText =
    result.fatalError?.message ||
    agentError?.errorMessage ||
    toolErrorText ||
    (truncated ? truncationMessage : result.finalText) ||
    stopReason;
  if (!success || accountError) {
    if (accountError) console.error(`  [executor] Account error: ${errorText}`);
    else console.error(`  [executor] Run failed (${stopReason}): ${errorText}`);
  }

  return {
    success: success && !accountError,
    output: result.finalText,
    turns,
    error: success && !accountError ? undefined : errorText,
    durationMs,
    sessionId: result.sessionId,
    costUsd: costUsd > 0 ? costUsd : undefined,
    inputTokens: inputTokens || undefined,
    outputTokens: outputTokens || undefined,
    cacheReadInputTokens: cacheRead || undefined,
    cacheCreationInputTokens: cacheWrite || undefined,
    stopReason,
    extensions,
    skills,
  };
}

function mapStopReason(result: RunResult): string {
  if (result.fatalError) return "error_fatal";
  if (result.toolErrors && result.finalText.length === 0) return "error_tool";
  if (!result.ok) return `error_exit_${result.exitCode}`;
  if (result.agentEnded || result.finalText.length > 0) return "success";
  return "unknown";
}

/**
 * Scan agent_end's messages for a failed assistant turn. pi-agent-core's
 * `handleRunFailure` catches provider errors, synthesizes an assistant
 * message with stopReason "error"/"aborted" + errorMessage, and emits a
 * normal agent_end — so the only signal that the run actually failed
 * lives on the last assistant message.
 */
function extractAgentError(
  result: RunResult,
): { stopReason: string; errorMessage: string } | undefined {
  if (!Array.isArray(result.messages)) return undefined;
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const m = result.messages[i] as
      | { role?: string; stopReason?: string; errorMessage?: string }
      | undefined;
    if (m?.role !== "assistant") continue;
    if (m.stopReason === "error" || m.stopReason === "aborted") {
      return {
        stopReason: m.stopReason === "aborted" ? "error_aborted" : "error_agent",
        errorMessage: m.errorMessage || m.stopReason,
      };
    }
    return undefined;
  }
  return undefined;
}

function coerceThinking(raw: string | undefined): ThinkingLevel | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (!THINKING_LEVELS.has(v)) {
    console.warn(
      `[executor] Ignoring unknown thinking level "${raw}" — must be one of: ${[...THINKING_LEVELS].join(", ")}`,
    );
    return undefined;
  }
  return v as ThinkingLevel;
}

function resolveSessionsDir(config: ExecutorConfig): string {
  if (config.sessionsDir) return resolve(config.sessionsDir);
  const stateDir = config.stateDir || resolve("data");
  return process.env.LASTLIGHT_SESSIONS_DIR
    ? resolve(process.env.LASTLIGHT_SESSIONS_DIR)
    : resolve(stateDir, "agent-sessions");
}

function emptyResult(stopReason: string, durationMs: number) {
  return {
    finalText: "",
    turns: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    stopReason,
    durationMs,
  };
}

/** Splice values into process.env for the duration of a sync block. */
function applyEnv(env: Record<string, string>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

// Compatibility: keep a reference so existing imports from
// `./opencode-executor.js` can be deleted in one pass. DockerSandbox
// type used internally only.
export type { DockerSandbox };

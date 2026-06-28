import { basename, join, relative } from "path";
import { writeFileSync } from "fs";
import type { run as agenticRunType, RunResult } from "agentic-pi";
import type { SandboxBackend } from "../../config/config.js";
import {
  createTaskSandbox,
  setupTaskWorktree,
  prePopulateWorkspace,
  SANDBOX_IMAGE_QA,
} from "../../sandbox/index.js";
import { SmolSandbox, smolAvailable, SMOL_WORKSPACE_DIR } from "../../sandbox/smol.js";
import {
  AGENTIC_PROFILE_FOR,
  loadAgentContext,
  type ExecutorConfig,
  type ExecutionResult,
  type GitSandboxAccess,
} from "../github/profiles.js";
import { AgenticShim } from "../event-shim.js";
import { projectSlugForCwd } from "../../session-log.js";
import { ALLOW_ALL_SENTINEL, DEFAULT_ALLOWLIST, mergeAllowlist } from "../../sandbox/egress-allowlist.js";
import { getDockerSandboxOtelEnv, getOtelEnvForSandbox, recordError, recordExecutionMetrics } from "../../telemetry/index.js";
import { recordPiEvent } from "../../telemetry/pi-events.js";
import {
  DEFAULT_MODEL,
  DOCKER_WORKSPACE_DIR,
  SKILL_BUNDLE_ROOT,
  stageSkillBundle,
  skillBundleKey,
  excludeFromGit,
  serverArtifacts,
  stageArtifactsIn,
  harvestArtifactsOut,
  RunResultAccumulator,
  finalizeFromRunResult,
  coerceThinking,
  resolveSessionsDir,
  emptyResult,
  applyEnv,
} from "./shared.js";

// ── In-process path (gondolin / none) ───────────────────────────────

export async function executeInProcess(
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
  // When the harness pre-cloned the target repo, cwd is the checkout
  // (`<workDir>/<repo>/`) so the agent's commands run inside the repo with no
  // `cd` preamble; otherwise cwd is the workspace root and the agent clones in.
  const agentCwd = ctx.access?.prePopulateBranch
    ? join(ctx.workDir, ctx.access.repo)
    : ctx.workDir;

  // Stage this phase's skills into its own bundle and point pi at the staged
  // dirs explicitly via `skillPaths` below. The bundle lives at the workspace
  // root — a sibling of the repo, outside its git tree — for `none` (the host
  // FS is fully visible in-process). gondolin mounts only cwd, so its bundle
  // is staged under the repo and added to the checkout's local
  // `.git/info/exclude` so the agent can't commit it.
  const gondolin = ctx.backend === "gondolin";
  const skillRoot = gondolin ? agentCwd : ctx.workDir;
  let stagedSkillDirs: string[] | undefined;
  try {
    stagedSkillDirs = stageSkillBundle(skillRoot, skillBundleKey(config), config.skillPaths, "symlink");
    if (stagedSkillDirs && gondolin) excludeFromGit(agentCwd, SKILL_BUNDLE_ROOT);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[executor] Could not stage skills: ${msg}`);
  }

  // Server-mode build assets: agentCwd is the host-visible repo checkout for
  // the in-process backends (gondolin's cwd mount / none's host FS), so stage
  // and harvest operate on it directly.
  const artifacts = serverArtifacts(config, agentCwd);
  stageArtifactsIn(artifacts);

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
      // Test/eval escape hatch: when set (by the eval harness), agentic-pi's
      // built-in github_* tools talk to a local fake GitHub instead of
      // api.github.com. Unset in production.
      githubApiBaseUrl: config.githubApiBaseUrl,
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
    // Harvest even on failure so a partial plan/summary still reaches the store.
    harvestArtifactsOut(artifacts);
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
  harvestArtifactsOut(artifacts);

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

export async function executeDocker(
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

  // A phase can opt into the browser-QA image (Playwright + Chromium baked in)
  // with `sandbox_image: qa`. The runner only schedules such a phase when the
  // image is actually present (see `qaImageAvailable`), so by here it's safe to
  // request; pass undefined otherwise to use the lean default image.
  const imageName = config.sandboxImage === "qa" ? SANDBOX_IMAGE_QA : undefined;

  const sbx = await createTaskSandbox({
    taskId: ctx.taskId,
    stateDir: ctx.stateDir,
    sandboxDir: config.sandboxDir,
    env: ctx.env,
    prePopulate: ctx.prePopulate,
    dnsIp,
    imageName,
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
  // When the harness pre-cloned the repo, cwd is the checkout
  // (`<workspace>/<repo>/`) so the agent runs inside the repo with no `cd`
  // preamble; otherwise it's the workspace root.
  const agentCwd = ctx.prePopulate
    ? `${DOCKER_WORKSPACE_DIR}/${ctx.prePopulate.repo}`
    : DOCKER_WORKSPACE_DIR;

  // Stage this phase's skills into its own bundle at the workspace ROOT — a
  // sibling of any repo subdir, never inside its git tree. docker bind-mounts
  // the WHOLE workspace, so the agent reaches the bundle by an absolute
  // `--skill` path even though cwd is the repo. Copy (not symlink) because the
  // agent's tools run inside the container and host symlink targets don't
  // resolve there. Map the host dests to their in-container paths for `--skill`.
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

  // Server-mode build assets. The host-visible repo checkout is the
  // bind-mounted workspace path (`sbx.workDir[/<repo>]`), NOT the in-container
  // `agentCwd`. Stage now; harvest before each `sbx.cleanup()` below (cleanup
  // removes the workspace, taking the docs with it).
  const hostRepoDir = ctx.prePopulate ? join(sbx.workDir, ctx.prePopulate.repo) : sbx.workDir;
  const artifacts = serverArtifacts(config, hostRepoDir);
  stageArtifactsIn(artifacts);

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
    harvestArtifactsOut(artifacts);
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
  harvestArtifactsOut(artifacts);
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

// ── smolvm path (local micro-VM) ────────────────────────────────────
//
// Structural peer of executeDocker: Last Light owns the boundary, mounts the
// workspace, runs `agentic-pi run --sandbox none` inside the VM, parses the
// stream, destroys the machine. Differences from docker: a real micro-VM
// (own kernel) and NATIVE per-machine egress via smolvm's `--allow-host`
// (sourced from egress-allowlist.ts) instead of the coredns/nginx sidecars.

export async function executeSmol(
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
  if (!smolAvailable()) {
    throw new Error(
      "LASTLIGHT_SANDBOX=smol but the smolvm CLI is not available. " +
      "Install smolvm (https://smolmachines.com) and start `smolvm serve`, " +
      "or set LASTLIGHT_SANDBOX=docker / gondolin / none.",
    );
  }

  // Native egress allowlist — the docker/gondolin policy expressed as
  // per-machine `--allow-host` flags. `unrestrictedEgress` → null (open, but
  // still `--net`). NOTE: unlike docker's coredns-open, this has no SSRF
  // metadata floor — a spike gap, documented in smol.ts. The allowlist does
  // NOT include docker-registry hosts, so the image must already be in smolvm's
  // store (pre-pull / `smolvm pack`) — `start` won't reach a registry here.
  const extraHosts = config.otel?.enabled && config.otel.forwardToSandbox ? config.otel.collectorHosts : [];
  const allowHosts = config.unrestrictedEgress
    ? null
    : mergeAllowlist(DEFAULT_ALLOWLIST, extraHosts);

  // Workspace dir on the host. We boot the VM FIRST (with the dir mounted),
  // then probe where the share actually lands and clone/stage into that — see
  // SmolSandbox.resolveHostWorkspace for why the mount source isn't always the
  // share root. So no pre-clone here; just the dir.
  const workDir = setupTaskWorktree({
    taskId: ctx.taskId,
    stateDir: ctx.stateDir,
    sandboxDir: config.sandboxDir,
  });

  const sandbox = new SmolSandbox({ env: ctx.env, allowHosts });
  const machine = await sandbox.create({ taskId: ctx.taskId, worktreePath: workDir });
  const hostWs = machine.hostWorkspace;

  // Now that we know the share-backed host dir, provision it: clone the repo,
  // drop AGENTS.md, stage skills — all where the guest will see them at
  // SMOL_WORKSPACE_DIR.
  if (ctx.prePopulate) prePopulateWorkspace(hostWs, ctx.prePopulate);
  try {
    const md = loadAgentContext(config.agentContextDir);
    if (md) writeFileSync(join(hostWs, "AGENTS.md"), md);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[executor] Could not write smol AGENTS.md: ${msg}`);
  }

  const startTime = Date.now();
  console.log(`  [executor] Running in smol micro-VM (task: ${ctx.taskId})`);

  const model = config.model || DEFAULT_MODEL;
  const thinking = coerceThinking(config.variant);
  const profile = ctx.access ? AGENTIC_PROFILE_FOR[ctx.access.profile] : undefined;
  const sessionsDir = resolveSessionsDir(config);
  const agentCwd = ctx.prePopulate
    ? `${SMOL_WORKSPACE_DIR}/${ctx.prePopulate.repo}`
    : SMOL_WORKSPACE_DIR;

  // Skills copied (not symlinked) into the share-backed workspace root — host
  // symlink targets wouldn't resolve across the VM mount — then mapped to their
  // in-guest paths for `--skill`. Same rationale as the docker path.
  let skillDirsInGuest: string[] = [];
  try {
    const staged = stageSkillBundle(hostWs, skillBundleKey(config), config.skillPaths, "copy");
    if (staged) {
      skillDirsInGuest = staged.map((d) => `${SMOL_WORKSPACE_DIR}/${relative(hostWs, d)}`);
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[executor] Could not stage skills in smol workspace: ${msg}`);
  }

  const hostRepoDir = ctx.prePopulate ? join(hostWs, ctx.prePopulate.repo) : hostWs;
  const artifacts = serverArtifacts(config, hostRepoDir);
  stageArtifactsIn(artifacts);

  const shim = new AgenticShim({
    homeDir: sessionsDir,
    projectSlug: projectSlugForCwd(agentCwd),
    model,
    initialPrompt: prompt,
  });

  const acc = new RunResultAccumulator();
  let notifiedSessionId = false;
  // Git identity for the inner agentic-pi run. No HOME override — the sandbox
  // image's `agent` user has its own HOME. GITHUB_TOKEN/GH_TOKEN are
  // auto-injected by agentic-pi from the machine env when --profile is set.
  const sandboxEnv: Record<string, string> = {
    GIT_AUTHOR_NAME: "last-light[bot]",
    GIT_AUTHOR_EMAIL: "last-light[bot]@users.noreply.github.com",
    GIT_COMMITTER_NAME: "last-light[bot]",
    GIT_COMMITTER_EMAIL: "last-light[bot]@users.noreply.github.com",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
  };
  try {
    await sandbox.runAgent(ctx.taskId, prompt, {
      model,
      thinking,
      profile,
      sandboxEnv,
      agentCwd,
      skillDirs: skillDirsInGuest,
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
    recordError("agent", err, { "sandbox.backend": "smol", model, success: false, stop_reason: "error_sandbox", "workflow.name": config.telemetry?.workflowName, "phase.name": config.telemetry?.phaseName });
    recordExecutionMetrics("agent", { "sandbox.backend": "smol", model, success: false, stop_reason: "error_sandbox", durationMs });
    const fallbackId = `exec-${basename(ctx.taskId)}`;
    const synthesizedId = await shim
      .finalizeWithFallback(emptyResult("error_sandbox", durationMs), fallbackId, msg)
      .catch(() => null);
    harvestArtifactsOut(artifacts);
    await sandbox.destroy(ctx.taskId);
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
  harvestArtifactsOut(artifacts);
  await sandbox.destroy(ctx.taskId);
  const finalResult = await finalizeFromRunResult(acc.build(0), prompt, shim, startTime, acc.extensions(), acc.skills(), acc.toolError(), acc.endedOnToolCall());
  recordExecutionMetrics("agent", {
    "sandbox.backend": "smol",
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

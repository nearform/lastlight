import { resolve, basename, join } from "path";
import { writeFileSync } from "fs";
import { randomUUID } from "crypto";
import { run as agenticRun, type RunResult, type ThinkingLevel } from "agentic-pi";
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
  type GitSandboxAccess,
} from "./profiles.js";
import { AgenticShim, projectSlugForCwd } from "./event-shim.js";
import type { SandboxBackend } from "../config.js";
import { ALLOW_ALL_SENTINEL, DEFAULT_ALLOWLIST } from "../sandbox/egress-allowlist.js";

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
const DOCKER_WORKSPACE_DIR = "/home/agent/workspace";
const THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off", "minimal", "low", "medium", "high", "xhigh",
]);

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
  // GITHUB_APP_* env vars are forwarded to agentic-pi *only* when the
  // access profile explicitly opts into App PEM access (repo-write or
  // explicitly allowMcpAppAuth=true). All other runs see just
  // `GITHUB_TOKEN` so they can't mint elevated tokens themselves.
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

  const prePopulate =
    access?.prePopulateBranch && mintedToken
      ? {
          owner: access.owner,
          repo: access.repo,
          branch: access.prePopulateBranch,
          token: mintedToken,
        }
      : undefined;

  if (backend === "docker") {
    return executeDocker(prompt, config, {
      taskId,
      stateDir,
      env: ghEnv,
      prePopulate,
      access,
      onSessionId: opts?.onSessionId,
    });
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

  return executeInProcess(prompt, config, {
    backend,
    taskId,
    workDir,
    stateDir,
    env: ghEnv,
    access,
    onSessionId: opts?.onSessionId,
  });
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
  const shim = new AgenticShim({
    homeDir: sessionsDir,
    projectSlug: projectSlugForCwd(ctx.workDir),
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
  const sandboxEnv: Record<string, string> =
    ctx.backend === "gondolin"
      ? { ...baseSandboxEnv, HOME: "/root", USER: "root", LOGNAME: "root" }
      : baseSandboxEnv;

  let notifiedSessionId = false;
  let result: RunResult;
  try {
    // HTTP egress allowlist. lastlight owns the policy (rather than relying
    // on agentic-pi's bundled default) so a single source — `egress-allowlist.ts`
    // — covers both backends. `unrestrictedEgress` opts a phase out via the
    // `"*"` sentinel; gondolin (post the upstream allow-all patch) treats it
    // as "allow every host".
    const allowedHttpHosts = config.unrestrictedEgress
      ? [ALLOW_ALL_SENTINEL]
      : [...DEFAULT_ALLOWLIST];

    result = await agenticRun({
      model,
      prompt,
      thinking,
      profile,
      sandbox: ctx.backend === "gondolin" ? "gondolin" : "none",
      sandboxEnv,
      cwd: ctx.workDir,
      noSession: true,
      allowedHttpHosts,
      onEvent: (record) => {
        shim.feed(record);
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

  return finalizeFromRunResult(result, prompt, shim, startTime);
}

// ── Docker path ─────────────────────────────────────────────────────

async function executeDocker(
  prompt: string,
  config: ExecutorConfig,
  ctx: {
    taskId: string;
    stateDir: string;
    env: Record<string, string>;
    prePopulate?: { owner: string; repo: string; branch: string; token: string };
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

  const startTime = Date.now();
  console.log(`  [executor] Running in docker sandbox (task: ${ctx.taskId})`);

  const model = config.model || DEFAULT_MODEL;
  const thinking = coerceThinking(config.variant);
  const profile = ctx.access ? AGENTIC_PROFILE_FOR[ctx.access.profile] : undefined;
  const sessionsDir = resolveSessionsDir(config);
  // The dashboard reads from <sessionsDir>/projects/<slug>/. Inside the
  // container the agent's cwd is DOCKER_WORKSPACE_DIR — use that for the
  // slug so live tails land in the right project dir.
  const shim = new AgenticShim({
    homeDir: sessionsDir,
    projectSlug: projectSlugForCwd(DOCKER_WORKSPACE_DIR),
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
        if (!notifiedSessionId && ctx.onSessionId && record.type === "session" && typeof record.id === "string") {
          notifiedSessionId = true;
          ctx.onSessionId(record.id);
        }
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const durationMs = Date.now() - startTime;
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
  return finalizeFromRunResult(acc.build(0), prompt, shim, startTime);
}

/**
 * Build a RunResult-shaped tally from the JSONL event stream emitted by
 * `agentic-pi run` inside the docker sandbox. Mirrors what agentic-pi's
 * own `run()` function does in-process — minimum viable subset of
 * fields the executor cares about.
 */
class RunResultAccumulator {
  private sessionId?: string;
  private finalText = "";
  private agentEnded = false;
  private toolErrors = false;
  private fatalError?: { name: string; message: string };
  private stats?: RunResult["stats"];
  private messages: unknown[] = [];

  feed(r: Record<string, unknown>): void {
    switch (r.type) {
      case "session":
        if (typeof r.id === "string") this.sessionId = r.id;
        break;
      case "message_end": {
        const m = r.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
        if (m?.role === "assistant" && Array.isArray(m.content)) {
          const text = m.content
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text as string)
            .join("");
          if (text) this.finalText = text;
        }
        break;
      }
      case "tool_execution_end":
        if (r.isError === true) this.toolErrors = true;
        break;
      case "agent_end":
        this.agentEnded = true;
        if (Array.isArray(r.messages)) this.messages = r.messages;
        break;
      case "usage_snapshot":
        this.stats = r.stats as RunResult["stats"];
        break;
      case "fatal_error":
        this.fatalError = r.error as { name: string; message: string };
        break;
    }
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
      stats: this.stats,
      records: [],
      warnings: [],
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function finalizeFromRunResult(
  result: RunResult,
  _prompt: string,
  shim: AgenticShim,
  startTime: number,
): ExecutionResult {
  const durationMs = Date.now() - startTime;
  const stats = result.stats;
  // pi-agent-core swallows provider API errors (insufficient_quota, rate
  // limit, auth) inside `handleRunFailure`: it synthesizes an assistant
  // message with stopReason "error" + errorMessage and emits a clean
  // agent_end. Without this check the run would map to "success" and the
  // workflow would silently advance with no output. See message scan below.
  const agentError = extractAgentError(result);
  const stopReason = agentError?.stopReason ?? mapStopReason(result);
  const success = stopReason === "success";

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
    apiErrorMessage: agentError?.errorMessage,
  });
  void shim.flush();

  const combined = [
    result.fatalError?.message,
    agentError?.errorMessage,
    result.finalText,
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
    result.finalText ||
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

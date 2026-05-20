import { resolve } from "path";
import { randomUUID } from "crypto";
import { spawn } from "child_process";
import { createTaskSandbox, type DockerSandbox } from "../sandbox/index.js";
import { refreshGitAuth } from "./git-auth.js";
import {
  GITHUB_PERMISSION_PROFILES,
  type ExecutorConfig,
  type ExecutionResult,
  type GitSandboxAccess,
} from "./profiles.js";
import { ClaudeJsonlShim, projectSlugForCwd } from "./opencode-shim.js";

const DEFAULT_MODEL = "openai/gpt-5.3-codex";

/**
 * Cwd inside the sandbox container (matches `WORKSPACE_DIR` in
 * `src/sandbox/docker.ts`). Surfaced here so the jsonl shim can pin the
 * right `claude-home/projects/<slug>/` dir, which the dashboard
 * SessionReader scans by directory name.
 */
const SANDBOX_WORKSPACE_DIR = "/home/agent/workspace";

/**
 * Names of MCP servers the executor configures inside the sandbox. The
 * shim prepends `mcp_` to tool calls whose `<server>_` prefix matches
 * one of these, so the dashboard tool-family classifier
 * (`dashboard/src/timeline/toolFamily.ts`) keeps routing them as MCP /
 * git family. Keep in sync with `deploy/opencode-config.tmpl.json`.
 */
const MCP_SERVER_NAMES = ["github"];

/**
 * Execute an agent task using OpenCode.
 *
 * Execution modes (automatic):
 * 1. Docker sandbox — if a sandbox is available, runs `opencode run --format json`
 *    inside an isolated container. Full sandboxing.
 * 2. Direct — runs `opencode run` against the host process. Local-dev fallback
 *    only, gated by ENABLE_DIRECT_FALLBACK=true.
 */
export async function executeAgent(
  prompt: string,
  config: ExecutorConfig,
  opts?: {
    taskId?: string;
    /**
     * Fired as soon as OpenCode's first event with a top-level `sessionID`
     * arrives. The runner uses this to persist the session id onto the
     * in-flight DB row so the dashboard can show live logs.
     */
    onSessionId?: (sessionId: string) => void;
    githubAccess?: GitSandboxAccess;
  },
): Promise<ExecutionResult> {
  const taskId = opts?.taskId || `task-${randomUUID().slice(0, 8)}`;
  const stateDir = config.stateDir || resolve("data");

  // Mint a per-run GitHub App token for the sandbox. Same flow as the legacy
  // executor — only the sandbox runtime changed.
  const env: Record<string, string> = {};
  const access = opts?.githubAccess;
  if (process.env.GITHUB_APP_ID) {
    const allowMcpAppAuth = access?.allowMcpAppAuth === true;
    env.ALLOW_APP_PEM = allowMcpAppAuth ? "1" : "0";
    env.GITHUB_APP_ID = allowMcpAppAuth ? process.env.GITHUB_APP_ID : "";
    env.GITHUB_APP_INSTALLATION_ID = allowMcpAppAuth
      ? (process.env.GITHUB_APP_INSTALLATION_ID || "")
      : "";
    // sandbox-entrypoint materializes app.pem at this path only when ALLOW_APP_PEM=1
    env.GITHUB_APP_PRIVATE_KEY_PATH = allowMcpAppAuth ? "/home/agent/.config/app.pem" : "";

    try {
      const permissions = access ? GITHUB_PERMISSION_PROFILES[access.profile] : undefined;
      const repositories = access?.repo ? [access.repo] : undefined;
      console.log(
        `[executor] Minting git token: profile=${access?.profile ?? "default"}, ` +
        `repo=${access?.repo || "(unscoped)"}, permissions=${permissions ? Object.keys(permissions).join(",") : "all"}`,
      );
      const { token } = await refreshGitAuth({
        appId: process.env.GITHUB_APP_ID,
        privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH || "",
        installationId: process.env.GITHUB_APP_INSTALLATION_ID || "",
        permissions,
        repositories,
      });
      env.GIT_TOKEN = token;
      env.GITHUB_TOKEN = token;
    } catch (err: any) {
      console.warn(
        `[executor] Could not generate git token (repo=${access?.repo || "none"}, ` +
        `profile=${access?.profile ?? "default"}): ${err.message}`,
      );
    }
  }

  // OpenCode picks up provider creds from these env vars. Forward whichever
  // are set on the harness process. Production uses metered API keys; dev can
  // mount auth.json instead (not handled here — see Phase 1 docs).
  if (process.env.OPENAI_API_KEY) env.OPENAI_API_KEY = process.env.OPENAI_API_KEY;
  if (process.env.ANTHROPIC_API_KEY) env.ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;

  const sbx = await createTaskSandbox({
    taskId,
    stateDir,
    sandboxDir: config.sandboxDir,
    env,
  });

  if (sbx) {
    return executeSandboxed(prompt, config, sbx.sandbox, taskId, sbx.cleanup, opts?.onSessionId);
  }

  if (process.env.ENABLE_DIRECT_FALLBACK === "true") {
    console.warn(`  [executor] No sandbox available — falling back to direct execution`);
    return executeDirect(prompt, config);
  }

  throw new Error("Docker sandbox not available and ENABLE_DIRECT_FALLBACK is not enabled. Install Docker and build the sandbox image (docker-compose build sandbox), or set ENABLE_DIRECT_FALLBACK=true.");
}

// ── Stream-event parsing ─────────────────────────────────────────────

/**
 * Accumulates OpenCode `--format json` events into an `ExecutionResult`-shaped
 * tally. Event contract (empirically verified, see .spike/PHASE0-FINDINGS.md):
 *
 *   {type, timestamp, sessionID, ...data}
 *
 * where type ∈ {step_start, step_finish, text, tool_use, reasoning, error}
 * and step_finish carries `part: {reason, cost, tokens:{input, output, reasoning, cache:{read, write}}}`.
 */
class OpencodeAccumulator {
  sessionId?: string;
  finalText = "";
  turns = 0;
  costUsd = 0;
  inputTokens = 0;
  outputTokens = 0;
  reasoningTokens = 0;
  cacheReadInputTokens = 0;
  cacheCreationInputTokens = 0;
  lastReason?: string;
  errors: string[] = [];
  firstEventTs?: number;
  lastEventTs?: number;

  feed(evt: any): void {
    if (!evt || typeof evt !== "object") return;
    const ts = typeof evt.timestamp === "number" ? evt.timestamp : undefined;
    if (ts !== undefined) {
      if (this.firstEventTs === undefined) this.firstEventTs = ts;
      this.lastEventTs = ts;
    }
    if (!this.sessionId && typeof evt.sessionID === "string") {
      this.sessionId = evt.sessionID;
    }

    switch (evt.type) {
      case "text": {
        const txt = evt.part?.text;
        if (typeof txt === "string" && txt.length > 0) {
          this.finalText += (this.finalText ? "\n\n" : "") + txt;
        }
        break;
      }
      case "step_finish": {
        const part = evt.part ?? {};
        this.turns++;
        if (typeof part.cost === "number") this.costUsd += part.cost;
        const tk = part.tokens ?? {};
        if (typeof tk.input === "number") this.inputTokens += tk.input;
        if (typeof tk.output === "number") this.outputTokens += tk.output;
        if (typeof tk.reasoning === "number") this.reasoningTokens += tk.reasoning;
        if (tk.cache && typeof tk.cache === "object") {
          if (typeof tk.cache.read === "number") this.cacheReadInputTokens += tk.cache.read;
          if (typeof tk.cache.write === "number") this.cacheCreationInputTokens += tk.cache.write;
        }
        if (typeof part.reason === "string") this.lastReason = part.reason;
        break;
      }
      case "error": {
        const msg = evt.error?.data?.message ?? evt.error?.name ?? "unknown error";
        this.errors.push(String(msg));
        break;
      }
    }
  }

  /**
   * Map OpenCode's final reason → the legacy claude-style stopReason values
   * the dashboard and result-row writers already understand.
   */
  stopReason(): string {
    if (this.errors.length > 0) return "error_api";
    if (!this.lastReason) return "unknown";
    if (this.lastReason === "stop") return "success";
    if (this.lastReason === "max_tokens" || this.lastReason === "length") {
      return "error_max_turns";
    }
    // "tool-calls" at end of stream means the model wanted to call tools but
    // got cut off — treat as error.
    return `error_${this.lastReason.replace(/-/g, "_")}`;
  }

  apiDurationMs(): number | undefined {
    if (this.firstEventTs === undefined || this.lastEventTs === undefined) return undefined;
    return this.lastEventTs - this.firstEventTs;
  }
}

/**
 * Parse a buffered stream of OpenCode JSON-format output into an accumulator.
 * Skips non-JSON lines defensively.
 */
function parseStream(output: string): OpencodeAccumulator {
  const acc = new OpencodeAccumulator();
  for (const raw of output.split("\n")) {
    const line = raw.trim();
    if (!line.startsWith("{")) continue;
    try {
      acc.feed(JSON.parse(line));
    } catch {
      /* skip malformed line */
    }
  }
  return acc;
}

// ── Docker sandbox execution ────────────────────────────────────────

async function executeSandboxed(
  prompt: string,
  config: ExecutorConfig,
  sandbox: DockerSandbox,
  taskId: string,
  cleanup: () => Promise<void>,
  onSessionId?: (sessionId: string) => void,
): Promise<ExecutionResult> {
  const startTime = Date.now();
  console.log(`  [executor] Running in sandbox (task: ${taskId})`);

  let notifiedSessionId = false;

  // Dashboard live-tail shim: as we receive OpenCode events, write a
  // parallel Claude-SDK envelope jsonl into the claude-home projects dir
  // the SessionReader already scans. See Phase 2 of the OpenCode fork plan.
  const stateDir = config.stateDir || resolve("data");
  const claudeHomeDir = process.env.CLAUDE_HOME_DIR
    ? resolve(process.env.CLAUDE_HOME_DIR)
    : resolve(stateDir, "claude-home");
  const shim = new ClaudeJsonlShim({
    claudeHomeDir,
    projectSlug: projectSlugForCwd(SANDBOX_WORKSPACE_DIR),
    mcpServerNames: MCP_SERVER_NAMES,
    model: config.model,
    initialPrompt: prompt,
  });

  try {
    const output = await sandbox.runAgent(taskId, prompt, {
      model: config.model,
      onLine: (line) => {
        if (!line.startsWith("{")) return;
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(line) as Record<string, unknown>;
        } catch {
          return; // incomplete JSON — wait for the next chunk
        }
        shim.feed(msg);
        if (!notifiedSessionId && onSessionId && typeof msg.sessionID === "string") {
          notifiedSessionId = true;
          onSessionId(msg.sessionID);
        }
      },
    });

    const acc = parseStream(output);
    const durationMs = Date.now() - startTime;
    const stopReason = acc.stopReason();
    const success = stopReason === "success";
    const costStr = acc.costUsd > 0 ? `, $${acc.costUsd.toFixed(4)}` : "";
    console.log(
      `  [executor] Result: ${stopReason} (${acc.turns} turns, ${Math.round(durationMs / 1000)}s${costStr})` +
      `${acc.sessionId ? ` [session ${acc.sessionId}]` : ""}`,
    );

    if (!success) {
      const err = acc.errors.join("\n") || acc.lastReason || "unknown error";
      console.error(`  [executor] Error: ${err}`);
    }

    const metrics = {
      sessionId: acc.sessionId,
      costUsd: acc.costUsd > 0 ? acc.costUsd : undefined,
      inputTokens: acc.inputTokens || undefined,
      cacheCreationInputTokens: acc.cacheCreationInputTokens || undefined,
      cacheReadInputTokens: acc.cacheReadInputTokens || undefined,
      outputTokens: acc.outputTokens || undefined,
      apiDurationMs: acc.apiDurationMs(),
      stopReason,
    };

    shim.finalize({
      finalText: acc.finalText,
      turns: acc.turns,
      costUsd: acc.costUsd,
      inputTokens: acc.inputTokens,
      outputTokens: acc.outputTokens,
      cacheReadInputTokens: acc.cacheReadInputTokens,
      cacheCreationInputTokens: acc.cacheCreationInputTokens,
      stopReason,
      durationMs,
    });
    await shim.flush();

    // Detect billing / auth / rate-limit errors regardless of stop reason
    const combined = (acc.errors.join("\n") + "\n" + acc.finalText).toLowerCase();
    if (
      combined.includes("credit balance") ||
      combined.includes("insufficient_quota") ||
      combined.includes("rate limit") ||
      combined.includes("unauthorized")
    ) {
      const err = acc.errors.join("\n") || acc.finalText;
      console.error(`  [executor] Account error: ${err}`);
      return {
        success: false,
        output: acc.finalText,
        turns: acc.turns,
        error: err,
        durationMs,
        ...metrics,
      };
    }

    return {
      success,
      output: acc.finalText,
      turns: acc.turns,
      error: success ? undefined : (acc.errors.join("\n") || acc.lastReason || "unknown"),
      durationMs,
      ...metrics,
    };
  } catch (err: any) {
    console.error(`  [executor] Sandbox error: ${err.message}`);
    await shim.flush().catch(() => { /* ignore */ });
    return {
      success: false,
      output: "",
      turns: 0,
      error: err.message,
      durationMs: Date.now() - startTime,
    };
  } finally {
    await cleanup();
  }
}

// ── Direct (no-sandbox) execution ───────────────────────────────────

/**
 * Spawn the OpenCode CLI directly on the host. Used only when
 * ENABLE_DIRECT_FALLBACK=true; meant for local debugging without Docker.
 * The binary path can be overridden with OPENCODE_BIN.
 */
async function executeDirect(
  prompt: string,
  config: ExecutorConfig,
): Promise<ExecutionResult> {
  const startTime = Date.now();
  console.log(`  [executor] Running directly (no sandbox)`);

  const model = config.model || DEFAULT_MODEL;
  const opencodeBin = process.env.OPENCODE_BIN || "opencode";
  const args = [
    "run",
    "--format", "json",
    "-m", model,
    "--dangerously-skip-permissions",
  ];

  // Same dashboard live-tail shim as the sandbox path. The cwd here is the
  // harness process working dir, so the project slug differs.
  const stateDir = config.stateDir || resolve("data");
  const claudeHomeDir = process.env.CLAUDE_HOME_DIR
    ? resolve(process.env.CLAUDE_HOME_DIR)
    : resolve(stateDir, "claude-home");
  const directCwd = config.cwd || process.cwd();
  const shim = new ClaudeJsonlShim({
    claudeHomeDir,
    projectSlug: projectSlugForCwd(directCwd),
    mcpServerNames: MCP_SERVER_NAMES,
    model,
    initialPrompt: prompt,
  });

  return new Promise<ExecutionResult>((resolveResult) => {
    const child = spawn(opencodeBin, args, {
      cwd: config.cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });
    child.stdin.write(prompt);
    child.stdin.end();

    let stdout = "";
    let stderr = "";
    let buf = "";

    child.stdout.setEncoding("utf-8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.startsWith("{")) continue;
        try {
          shim.feed(JSON.parse(line));
        } catch { /* skip malformed */ }
      }
    });
    child.stderr.setEncoding("utf-8");
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });

    child.on("error", (err) => {
      void shim.flush();
      resolveResult({
        success: false,
        output: "",
        turns: 0,
        error: `opencode spawn failed: ${err.message}`,
        durationMs: Date.now() - startTime,
      });
    });

    child.on("close", async (code) => {
      // Flush any trailing partial line through the shim
      if (buf.length > 0 && buf.startsWith("{")) {
        try { shim.feed(JSON.parse(buf)); } catch { /* ignore */ }
      }
      const acc = parseStream(stdout);
      const stopReason = acc.stopReason();
      const success = code === 0 && stopReason === "success";
      const durationMs = Date.now() - startTime;
      shim.finalize({
        finalText: acc.finalText,
        turns: acc.turns,
        costUsd: acc.costUsd,
        inputTokens: acc.inputTokens,
        outputTokens: acc.outputTokens,
        cacheReadInputTokens: acc.cacheReadInputTokens,
        cacheCreationInputTokens: acc.cacheCreationInputTokens,
        stopReason,
        durationMs,
      });
      await shim.flush();
      const error = success
        ? undefined
        : (acc.errors.join("\n") || (code !== 0 ? `opencode exit ${code}: ${stderr}` : acc.lastReason || "unknown"));
      resolveResult({
        success,
        output: acc.finalText,
        turns: acc.turns,
        error,
        durationMs,
        sessionId: acc.sessionId,
        costUsd: acc.costUsd > 0 ? acc.costUsd : undefined,
        inputTokens: acc.inputTokens || undefined,
        cacheCreationInputTokens: acc.cacheCreationInputTokens || undefined,
        cacheReadInputTokens: acc.cacheReadInputTokens || undefined,
        outputTokens: acc.outputTokens || undefined,
        apiDurationMs: acc.apiDurationMs(),
        stopReason,
      });
    });
  });
}

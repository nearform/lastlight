import { spawn, type ChildProcess } from "node:child_process";
import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Long-lived `opencode serve` supervisor and typed HTTP client used by
 * the chat skill. Replaces the in-process `@anthropic-ai/claude-agent-sdk`
 * query() that chat.ts used pre-Phase 5.
 *
 * Lifecycle:
 *  - `start()` writes an opencode.json into the working dir (MCP servers
 *    + permissions) and spawns `opencode serve --hostname 127.0.0.1 --port <p>`.
 *  - Health check polls the server until it responds, then resolves.
 *  - On unexpected exit the supervisor restarts with exponential backoff
 *    up to MAX_RESTART_ATTEMPTS in a 60s window, then gives up.
 *  - `stop()` SIGTERMs the child and waits for exit (SIGKILL after 5s).
 *
 * Why blocking (not SSE):
 *   `POST /session/{id}/message` blocks server-side until the model
 *   turn is complete and returns `{info, parts}` carrying full token /
 *   cost / finish-reason accounting. The chat path doesn't need
 *   token-by-token streaming for Slack UX, and the shim-jsonl writer
 *   can reconstruct everything the dashboard needs from `parts`.
 */
export interface OpencodeChatServerConfig {
  /** TCP port for the server. */
  port: number;
  /** Working dir for the server process — where opencode.json is read. */
  workingDir: string;
  /** Default model id, format `provider/model` (e.g. "openai/gpt-5.3-codex"). */
  defaultModel: string;
  /** Override the opencode binary path (CI/dev). Defaults to `OPENCODE_BIN` env var or `opencode`. */
  binary?: string;
  /** Extra env to pass to the child process (API keys, GITHUB_APP_*). */
  env?: Record<string, string>;
  /** Forward server logs to stderr — useful for local dev. */
  printLogs?: boolean;
  /** MCP servers to register in opencode.json. */
  mcpServers?: Record<string, OpencodeMcpServer>;
  /**
   * Markdown content to write as `AGENTS.md` in the working dir. OpenCode
   * picks this up as the system context for every session — equivalent to
   * Claude SDK's `systemPrompt` option that pre-Phase 5 chat used.
   */
  agentMarkdown?: string;
  /**
   * Name of the OpenCode agent to use for chat turns. The supervisor
   * writes the matching agent definition into opencode.json so the server
   * picks it up on boot. Defaults to `chat` — a primary agent that
   * denies host-side tools (bash/edit/webfetch/task/skill/todowrite/etc.)
   * and the destructive github_* write tools, while still permitting
   * reads + issue/comment/label management via the github MCP.
   */
  agentName?: string;
}

export interface OpencodeMcpServer {
  type: "local";
  command: string[];
  enabled: boolean;
  environment?: Record<string, string>;
  timeout?: number;
}

/** Empirical shape captured in `.spike/PHASE0-FINDINGS.md`. */
export interface OpencodeChatTurnResult {
  sessionId: string;
  /** Final assistant text concatenated from all `text` parts. */
  text: string;
  /** Raw `parts` array from the server — needed by the shim. */
  parts: Array<Record<string, unknown>>;
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
  };
  /** `info.finish` from the server (e.g. "stop", "tool-calls"). */
  finish: string;
  modelId: string;
  providerId: string;
  /** Wall-clock time the HTTP call took (ms). */
  apiDurationMs: number;
}

export class OpencodeChatServer {
  private static MAX_RESTART_ATTEMPTS = 5;
  private static RESTART_WINDOW_MS = 60_000;

  private cfg: OpencodeChatServerConfig;
  private child: ChildProcess | null = null;
  private baseUrl: string | null = null;
  private shouldRun = false;
  private restartCount = 0;
  /**
   * Timestamp of the most recent unexpected child exit (set in `handleExit`).
   * Used to reset `restartCount` when crashes fall outside the rolling window
   * — see `handleExit` for the reset condition. Initialized to 0 so the first
   * crash always resets cleanly.
   */
  private lastCrash = 0;
  /**
   * Per-session in-flight chain. Guarantees that two `postMessage`
   * calls against the SAME sessionId run sequentially server-side
   * even if their callers arrive concurrently (e.g. a Slack user
   * sends two messages in the same thread before the first reply
   * lands). Different sessionIds stay fully concurrent — that's the
   * whole point of running serve as a server.
   */
  private sessionChains: Map<string, Promise<unknown>> = new Map();

  constructor(cfg: OpencodeChatServerConfig) {
    this.cfg = cfg;
  }

  async start(): Promise<void> {
    if (this.shouldRun && this.child) return; // already running
    this.shouldRun = true;
    await this.writeOpencodeConfig();
    await this.spawn();
  }

  async stop(): Promise<void> {
    this.shouldRun = false;
    const child = this.child;
    if (!child) return;
    await new Promise<void>((resolve) => {
      let resolved = false;
      const finish = () => {
        if (resolved) return;
        resolved = true;
        resolve();
      };
      child.once("exit", finish);
      try { child.kill("SIGTERM"); } catch { /* ignore */ }
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch { /* ignore */ }
        finish();
      }, 5000);
    });
    this.child = null;
    this.baseUrl = null;
  }

  isRunning(): boolean {
    return this.child !== null && this.baseUrl !== null;
  }

  /** Create a fresh session; returns its id. */
  async createSession(opts?: { title?: string }): Promise<string> {
    const base = this.requireBaseUrl();
    const body: Record<string, unknown> = {};
    if (opts?.title) body.title = opts.title;
    const res = await fetch(`${base}/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`createSession failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as { id?: string };
    if (!data.id) throw new Error("createSession: server returned no id");
    return data.id;
  }

  /**
   * Send one message in a session and wait for the model to finish.
   * Resume = pass an existing sessionId; first-turn = create one with
   * `createSession()` first.
   */
  async postMessage(
    sessionId: string,
    prompt: string,
    opts?: { model?: string; agent?: string; timeoutMs?: number },
  ): Promise<OpencodeChatTurnResult> {
    // Serialize against any in-flight call for this same session. The
    // promise we return is what later callers will await for ordering;
    // failures don't propagate to subsequent callers (the chain catches).
    const prev = this.sessionChains.get(sessionId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(() => this.doPostMessage(sessionId, prompt, opts));
    this.sessionChains.set(sessionId, next);
    // Best-effort cleanup so the map doesn't grow forever — drop the
    // entry if it still points at this chain when we finish. We use
    // a swallowing catch so this side-channel can't surface as an
    // unhandled rejection independent of the returned `next`.
    const cleanup = () => {
      if (this.sessionChains.get(sessionId) === next) {
        this.sessionChains.delete(sessionId);
      }
    };
    next.then(cleanup, cleanup);
    return next;
  }

  private async doPostMessage(
    sessionId: string,
    prompt: string,
    opts?: { model?: string; agent?: string; timeoutMs?: number },
  ): Promise<OpencodeChatTurnResult> {
    const base = this.requireBaseUrl();
    const model = opts?.model || this.cfg.defaultModel;
    const { providerID, modelID } = splitModel(model);
    const startMs = Date.now();

    const ctrl = new AbortController();
    const timeout = opts?.timeoutMs ?? 120_000;
    const timer = setTimeout(() => ctrl.abort(), timeout);

    let res: Response;
    try {
      res = await fetch(`${base}/session/${encodeURIComponent(sessionId)}/message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          agent: opts?.agent || this.cfg.agentName || "chat",
          parts: [{ type: "text", text: prompt }],
          model: { providerID, modelID },
        }),
      });
    } finally {
      clearTimeout(timer);
    }

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`postMessage failed: ${res.status} ${text}`);
    }
    const data = (await res.json()) as Record<string, unknown>;
    return parseTurnResult(data, sessionId, modelID, providerID, Date.now() - startMs);
  }

  // ── internals ───────────────────────────────────────────────────────

  private requireBaseUrl(): string {
    if (!this.baseUrl) throw new Error("opencode chat server not started");
    return this.baseUrl;
  }

  private async writeOpencodeConfig(): Promise<void> {
    await fs.mkdir(this.cfg.workingDir, { recursive: true });
    const config: Record<string, unknown> = {
      $schema: "https://opencode.ai/config.json",
    };
    if (this.cfg.mcpServers && Object.keys(this.cfg.mcpServers).length > 0) {
      config.mcp = this.cfg.mcpServers;
    }

    const agentName = this.cfg.agentName ?? "chat";
    config.agent = {
      [agentName]: buildChatAgentDef(),
    };

    const file = path.join(this.cfg.workingDir, "opencode.json");
    await fs.writeFile(file, JSON.stringify(config, null, 2));

    if (this.cfg.agentMarkdown) {
      await fs.writeFile(path.join(this.cfg.workingDir, "AGENTS.md"), this.cfg.agentMarkdown);
    }
  }

  private async spawn(): Promise<void> {
    const binary = this.cfg.binary || process.env.OPENCODE_BIN || "opencode";
    const args = [
      "serve",
      "--hostname", "127.0.0.1",
      "--port", String(this.cfg.port),
    ];
    if (this.cfg.printLogs) args.push("--print-logs");

    console.log(`[chat-server] spawning: ${binary} ${args.join(" ")} (cwd: ${this.cfg.workingDir})`);

    const child = spawn(binary, args, {
      cwd: this.cfg.workingDir,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(this.cfg.env || {}) },
    });
    this.child = child;

    if (this.cfg.printLogs) {
      child.stdout?.setEncoding("utf-8");
      child.stderr?.setEncoding("utf-8");
      child.stdout?.on("data", (chunk: string) => process.stderr.write(`[chat-server:out] ${chunk}`));
      child.stderr?.on("data", (chunk: string) => process.stderr.write(`[chat-server:err] ${chunk}`));
    } else {
      // Drain pipes so the child doesn't block on a full buffer.
      child.stdout?.on("data", () => { /* drop */ });
      child.stderr?.on("data", () => { /* drop */ });
    }

    child.on("exit", (code, signal) => this.handleExit(code, signal));
    child.on("error", (err) => console.error(`[chat-server] spawn error: ${err.message}`));

    this.baseUrl = `http://127.0.0.1:${this.cfg.port}`;
    try {
      await this.waitForReady();
      console.log(`[chat-server] ready at ${this.baseUrl}`);
    } catch (err) {
      // Couldn't reach the server — clean up so a future start() retries cleanly.
      this.baseUrl = null;
      try { child.kill("SIGKILL"); } catch { /* ignore */ }
      this.child = null;
      throw err;
    }
  }

  private async waitForReady(timeoutMs = 10_000): Promise<void> {
    const base = this.baseUrl!;
    const deadline = Date.now() + timeoutMs;
    let lastErr: unknown = null;
    while (Date.now() < deadline) {
      try {
        // No documented health endpoint — `/session` (GET) returns 404 or
        // 405 if not supported, but the response itself proves the server
        // is listening. Any HTTP response is good enough.
        const res = await fetch(`${base}/session`, { method: "GET" });
        if (res.status > 0) return;
      } catch (e) {
        lastErr = e;
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    const msg = lastErr instanceof Error ? lastErr.message : String(lastErr);
    throw new Error(`opencode serve not ready within ${timeoutMs}ms (${msg})`);
  }

  private handleExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasChild = this.child;
    this.child = null;
    this.baseUrl = null;
    if (!this.shouldRun || !wasChild) {
      console.log(`[chat-server] exited (code=${code}, signal=${signal})`);
      return;
    }
    const now = Date.now();
    // Reset the rolling restart counter when the *previous crash* (not the
    // previous spawn) was outside the window. This is what "restarted N
    // times in the last 60s" actually means; using lastStart let restartCount
    // creep up across an arbitrarily long stable period.
    if (this.lastCrash !== 0 && now - this.lastCrash > OpencodeChatServer.RESTART_WINDOW_MS) {
      this.restartCount = 0;
    }
    this.lastCrash = now;
    this.restartCount++;
    if (this.restartCount > OpencodeChatServer.MAX_RESTART_ATTEMPTS) {
      console.error(`[chat-server] exit (code=${code}, signal=${signal}); restart limit reached, giving up`);
      this.shouldRun = false;
      return;
    }
    const backoffMs = Math.min(1000 * 2 ** (this.restartCount - 1), 30_000);
    console.warn(`[chat-server] exit (code=${code}, signal=${signal}); restart in ${backoffMs}ms (attempt ${this.restartCount}/${OpencodeChatServer.MAX_RESTART_ATTEMPTS})`);
    setTimeout(() => {
      if (this.shouldRun) {
        this.spawn().catch((err) => {
          console.error(`[chat-server] restart failed: ${err.message}`);
        });
      }
    }, backoffMs);
  }
}

/** Pull final assistant text + token tally out of `POST /session/{id}/message`. */
export function parseTurnResult(
  data: Record<string, unknown>,
  fallbackSessionId: string,
  fallbackModelId: string,
  fallbackProviderId: string,
  apiDurationMs: number,
): OpencodeChatTurnResult {
  const info = (data.info ?? {}) as Record<string, unknown>;
  const parts = Array.isArray(data.parts) ? (data.parts as Array<Record<string, unknown>>) : [];
  const text = parts
    .filter((p) => p?.type === "text" && typeof p.text === "string")
    .map((p) => p.text as string)
    .join("");
  const tokens = (info.tokens ?? {}) as Record<string, unknown>;
  const cache = (tokens.cache ?? {}) as Record<string, unknown>;
  return {
    sessionId: typeof info.sessionID === "string" ? (info.sessionID as string) : fallbackSessionId,
    text,
    parts,
    cost: typeof info.cost === "number" ? (info.cost as number) : 0,
    tokens: {
      input: numOr0(tokens.input),
      output: numOr0(tokens.output),
      reasoning: numOr0(tokens.reasoning),
      cacheRead: numOr0(cache.read),
      cacheWrite: numOr0(cache.write),
    },
    finish: typeof info.finish === "string" ? (info.finish as string) : "unknown",
    modelId: typeof info.modelID === "string" ? (info.modelID as string) : fallbackModelId,
    providerId: typeof info.providerID === "string" ? (info.providerID as string) : fallbackProviderId,
    apiDurationMs,
  };
}

export function splitModel(model: string): { providerID: string; modelID: string } {
  const slash = model.indexOf("/");
  if (slash <= 0) return { providerID: "openai", modelID: model };
  return { providerID: model.slice(0, slash), modelID: model.slice(slash + 1) };
}

function numOr0(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

/**
 * Permission profile for the chat agent. Tool-level fence — the chat
 * persona prompt already forbids these, but OpenCode's permission
 * config gives us a hard guarantee that prompt injection can't talk
 * the agent into running shell commands against the harness process,
 * editing local files, fetching arbitrary URLs, cloning repos to the
 * server's filesystem, or destructively mutating remote repos.
 *
 * Allowed (the chat skill's legitimate surface):
 *   - read-only host tools (read / glob / grep / list)
 *   - read-only github MCP tools (get_*, list_*, search_*)
 *   - tame github write tools: create_issue, add_issue_comment,
 *     add_labels / remove_label, update_issue (close/reopen/edit)
 *
 * Denied:
 *   - host-side: bash, edit, webfetch, websearch, task, skill,
 *     todowrite, repo_clone, repo_overview, external_directory
 *   - github writes that touch code/branches/PRs:
 *     clone_repo, create_branch, push_files, create_or_update_file,
 *     setup_git_auth, refresh_git_auth, merge_pull_request,
 *     create_pull_request, create_pull_request_review
 */
export function buildChatAgentDef(): Record<string, unknown> {
  return {
    description: "Last Light messaging chat agent — read repos, manage issues/comments/labels, no host shell, no code changes.",
    mode: "primary",
    permission: {
      // Host-side tools
      bash: "deny",
      edit: "deny",
      webfetch: "deny",
      websearch: "deny",
      task: "deny",
      skill: "deny",
      todowrite: "deny",
      repo_clone: "deny",
      repo_overview: "deny",
      external_directory: "deny",
      read: "allow",
      glob: "allow",
      grep: "allow",
      list: "allow",
      // GitHub MCP — code/branch/PR mutation
      github_clone_repo: "deny",
      github_create_branch: "deny",
      github_push_files: "deny",
      github_create_or_update_file: "deny",
      github_setup_git_auth: "deny",
      github_refresh_git_auth: "deny",
      github_merge_pull_request: "deny",
      github_create_pull_request: "deny",
      github_create_pull_request_review: "deny",
    },
  };
}

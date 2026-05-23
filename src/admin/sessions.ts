import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";

/**
 * Normalized message shape returned by the reader.
 * Claude Code CLI format is unwrapped into this.
 */
export interface JsonlMessage {
  role: string;
  content?: unknown;
  tool_calls?: unknown;
  tool_name?: string;
  tool_call_id?: string;
  timestamp?: string;
  reasoning?: unknown;
  finish_reason?: string;
  [k: string]: unknown;
}

export interface SessionMeta {
  id: string;
  source: string;
  /** Session type derived from the prompt content */
  sessionType: string;
  model: string | null;
  started_at: number;
  last_message_at: number | null;
  message_count: number;
  tool_call_count: number;
  conversation_message_count: number;
  last_assistant_content: string | null;
  /** Agent sub-session IDs that belong to this session */
  agentIds: string[];
}

/**
 * Detect session type from the first user message (prompt).
 * Matches against known orchestrator prompt patterns.
 */
function detectSessionType(firstUserMessage: string): string {
  if (!firstUserMessage) return "agent";
  const msg = firstUserMessage.slice(0, 500); // Only need the start
  // Build cycle phases
  if (msg.includes("PRE-FLIGHT GUARDRAILS CHECK")) return "guardrails";
  if (msg.includes("You are the ARCHITECT")) return "architect";
  if (msg.includes("You are the EXECUTOR (fix cycle")) return "fix";
  if (msg.includes("You are the EXECUTOR")) return "executor";
  if (msg.includes("You are the CODE REVIEWER")) return "reviewer";
  if (msg.includes("Create a pull request for the work on branch")) return "pr";
  if (msg.includes("You are fixing a PR based on")) return "pr-fix";
  if (msg.includes("Check if a build cycle already exists")) return "resume";
  // Skills
  if (msg.includes("issue-triage")) return "triage";
  if (msg.includes("pr-review")) return "review";
  if (msg.includes("repo-health")) return "health";
  // Chat (handled by chat.ts, not executor)
  if (msg.includes("You are Last Light") && msg.includes("chat")) return "chat";
  return "agent";
}

/**
 * Unwrap a Claude Code CLI envelope line into a normalized JsonlMessage.
 *
 * Claude Code format: { type: "user"|"assistant"|"tool_use"|"tool_result"|...,
 *   message: { role, content, ... } | "<json string>", timestamp, uuid, sessionId, ... }
 *
 * Hermes/Agent SDK format: { role: "user"|"assistant"|"tool"|"session_meta", content, ... }
 */
/**
 * Unwrap a Claude Code CLI envelope line into normalized JsonlMessage(s).
 * Returns an array because one line can contain multiple tool_results.
 */
export function unwrapLine(raw: Record<string, unknown>): JsonlMessage[] {
  // Already in role-based format (Hermes / Agent SDK --print output)
  if (typeof raw.role === "string") {
    return [raw as JsonlMessage];
  }

  const type = raw.type as string | undefined;
  if (!type) return [];

  // Skip internal types
  if (type === "queue-operation" || type === "summary" || type === "login") return [];
  if (type === "last-prompt" || type === "attachment") return [];

  const timestamp = raw.timestamp as string | undefined;

  // Parse the message field — can be a JSON string or an object
  let msg: Record<string, unknown> = {};
  if (raw.message != null) {
    if (typeof raw.message === "string") {
      try {
        msg = JSON.parse(raw.message) as Record<string, unknown>;
      } catch {
        msg = { content: raw.message };
      }
    } else if (typeof raw.message === "object") {
      msg = raw.message as Record<string, unknown>;
    }
  }

  if (type === "user") {
    const content = msg.content ?? raw.content;
    // User messages with tool_result blocks → emit each as a separate tool message
    if (Array.isArray(content)) {
      const hasToolResults = content.some(
        (b) => (b as Record<string, unknown>).type === "tool_result",
      );
      if (hasToolResults) {
        return content
          .filter((b) => (b as Record<string, unknown>).type === "tool_result")
          .map((b) => {
            const block = b as Record<string, unknown>;
            return {
              role: "tool",
              content: block.content,
              tool_call_id: block.tool_use_id as string,
              timestamp,
            };
          });
      }
    }
    return [{ role: "user", content, timestamp }];
  }

  if (type === "assistant") {
    if (raw.isApiErrorMessage || raw.error) {
      return [{ role: "system", content: String(raw.error ?? "API error"), timestamp }];
    }

    const content = msg.content;
    const model = msg.model as string | undefined;
    const stopReason = msg.stop_reason as string | undefined;

    let textContent: string | undefined;
    let toolCalls: unknown[] | undefined;
    let reasoning: unknown;

    if (Array.isArray(content)) {
      const textBlocks: string[] = [];
      const tools: unknown[] = [];
      for (const block of content) {
        const b = block as Record<string, unknown>;
        if (b.type === "text" && typeof b.text === "string") {
          textBlocks.push(b.text);
        } else if (b.type === "tool_use") {
          tools.push({
            id: b.id,
            function: { name: b.name, arguments: b.input },
          });
        } else if (b.type === "thinking" || b.type === "reasoning") {
          reasoning = b.thinking ?? b.text;
        }
      }
      if (textBlocks.length) textContent = textBlocks.join("\n");
      if (tools.length) toolCalls = tools;
    } else if (typeof content === "string") {
      textContent = content;
    }

    // Skip lines that only have thinking (no text, no tools) — they're noise
    if (!textContent && !toolCalls && reasoning) return [];

    // Skip completely empty assistant messages
    if (!textContent && !toolCalls) return [];

    return [{
      role: "assistant",
      content: textContent,
      tool_calls: toolCalls,
      reasoning,
      finish_reason: stopReason,
      model,
      timestamp,
    }];
  }

  if (type === "tool_result") {
    const content = msg.content ?? raw.content;
    const toolUseId = (msg.tool_use_id as string) ?? (raw.tool_use_id as string);
    return [{
      role: "tool",
      content,
      tool_call_id: toolUseId,
      timestamp,
    }];
  }

  if (type === "tool_use") {
    return [{
      role: "assistant",
      tool_calls: [{
        id: msg.id ?? raw.uuid,
        function: { name: msg.name, arguments: msg.input },
      }],
      timestamp,
    }];
  }

  return [];
}

/**
 * Which on-disk slice of `<sessionsDir>/projects` a SessionReader exposes.
 *
 * - `sandbox`: every project dir EXCEPT `-app`. These are workflow runs that
 *   executed inside a per-task docker sandbox; they're what the "Sessions"
 *   tab has historically shown.
 * - `chat`: ONLY `-app`. These are in-process Agent SDK runs from the host
 *   harness (cwd `/app`) — primarily the chat skill responding to Slack DMs
 *   and threads. Surfaced separately so the chat stream doesn't pollute the
 *   workflow session list.
 */
export type SessionReaderScope = "sandbox" | "chat";

/**
 * Interface implemented by every dashboard session source. Both the
 * jsonl-scanning SessionReader (sandbox runs) and the DB-backed
 * ChatSessionReader (Slack chat threads) implement this so that
 * `mountSessionRoutes` can wire either one to a route prefix without
 * caring where the data lives.
 */
export interface SessionSource {
  listSessionIds(): string[];
  exists(sessionId: string): boolean;
  getSessionMeta(sessionId: string): Promise<SessionMeta | null>;
  read(sessionId: string): Promise<Array<{ index: number; msg: JsonlMessage }>>;
  getFilePath(sessionId: string): string | null;
}

export class SessionReader implements SessionSource {
  private sessionsHomeDir: string;
  private scope: SessionReaderScope;
  private metaCache = new Map<string, { meta: SessionMeta; cachedAt: number }>();
  private static CACHE_TTL_MS = 10_000; // 10s cache for session metadata

  constructor(sessionsHomeDir: string, scope: SessionReaderScope = "sandbox") {
    this.sessionsHomeDir = sessionsHomeDir;
    this.scope = scope;
  }

  /** Find the project directories this reader is scoped to. See SessionReaderScope. */
  private projectDirs(): string[] {
    const projectsDir = path.join(this.sessionsHomeDir, "projects");
    try {
      return fs
        .readdirSync(projectsDir)
        .filter((name) => (this.scope === "chat" ? name === "-app" : name !== "-app"))
        .map((d) => path.join(projectsDir, d))
        .filter((p) => fs.statSync(p).isDirectory());
    } catch {
      return [];
    }
  }

  /** Resolve session ID to its file path (search across project dirs) */
  private pathFor(sessionId: string): string | null {
    for (const dir of this.projectDirs()) {
      const candidate = path.join(dir, `${sessionId}.jsonl`);
      if (fs.existsSync(candidate)) return candidate;
    }
    return null;
  }

  exists(sessionId: string): boolean {
    return this.pathFor(sessionId) !== null;
  }

  /** Return all session IDs across all project directories.
   *  Filters out agent sub-sessions (agent-xxx) — those are included
   *  in their parent session's view. */
  listSessionIds(): string[] {
    const ids: string[] = [];
    for (const dir of this.projectDirs()) {
      try {
        for (const f of fs.readdirSync(dir)) {
          if (!f.endsWith(".jsonl")) continue;
          const id = f.slice(0, -6);
          // Skip agent sub-sessions — they'll be loaded via parent
          if (id.startsWith("agent-")) continue;
          ids.push(id);
        }
      } catch {
        // skip unreadable dirs
      }
    }
    return ids;
  }

  async getSessionMeta(sessionId: string): Promise<SessionMeta | null> {
    const cached = this.metaCache.get(sessionId);
    if (cached && Date.now() - cached.cachedAt < SessionReader.CACHE_TTL_MS) {
      return cached.meta;
    }

    const meta = await this._readSessionMeta(sessionId);
    if (meta) {
      this.metaCache.set(sessionId, { meta, cachedAt: Date.now() });
    }
    return meta;
  }

  private async _readSessionMeta(sessionId: string): Promise<SessionMeta | null> {
    const file = this.pathFor(sessionId);
    if (!file) return null;

    // Collect all files to scan: main session + agent sub-sessions
    const filesToScan = [file];
    const dir = path.dirname(file);

    // Check for agent files in same directory (old layout)
    // and in subagents/ subdirectory (new layout)
    const agentDirs = [dir, path.join(dir, sessionId, "subagents")];
    for (const agentDir of agentDirs) {
      try {
        for (const f of fs.readdirSync(agentDir)) {
          if (!f.startsWith("agent-") || !f.endsWith(".jsonl")) continue;
          filesToScan.push(path.join(agentDir, f));
        }
      } catch { /* dir doesn't exist */ }
    }

    let source = "agent";
    let model: string | null = null;
    let startedAt: number | null = null;
    let lastMessageAt: number | null = null;
    let messageCount = 0;
    let toolCallCount = 0;
    let conversationMessageCount = 0;
    let lastAssistantContent: string | null = null;
    let firstUserMessage: string | null = null;
    const agentIds: string[] = [];

    for (const scanFile of filesToScan) {
      const stream = fs.createReadStream(scanFile, { encoding: "utf8" });
      const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

      for await (const line of rl) {
        if (!line.trim()) continue;
        let raw: Record<string, unknown>;
        try {
          raw = JSON.parse(line) as Record<string, unknown>;
        } catch {
          continue;
        }

        // Track agent sub-sessions
        const agentId = raw.agentId as string | undefined;
        if (agentId && !agentIds.includes(agentId)) {
          agentIds.push(agentId);
        }

        // Extract source from userType field
        if (raw.userType === "external") source = "agent";

        const msgs = unwrapLine(raw);
        if (!msgs.length) continue;

        for (const msg of msgs) {
          // Extract model from first assistant message
          if (msg.role === "assistant" && msg.model && !model) {
            model = msg.model as string;
          }

          // Handle session_meta (Hermes format)
          if (msg.role === "session_meta") {
            source = (msg.platform as string) ?? (msg.source as string) ?? source;
            model = (msg.model as string) ?? model;
            if (msg.timestamp) {
              startedAt = new Date(msg.timestamp as string).getTime() / 1000;
            }
            continue;
          }

          if (msg.timestamp) {
            const ts = new Date(msg.timestamp as string).getTime() / 1000;
            if (!Number.isNaN(ts)) {
              // True min/max across the main session AND every agent sub-
              // session file. The previous "first / last seen" logic broke
              // when multiple files were scanned in non-chronological
              // readdir order — `lastMessageAt` ended up being the final
              // timestamp of whichever file was scanned last, which could
              // easily be older than the real most recent message.
              if (startedAt === null || ts < startedAt) startedAt = ts;
              if (lastMessageAt === null || ts > lastMessageAt) lastMessageAt = ts;
            }
          }

          if (msg.role === "user" || msg.role === "assistant" || msg.role === "tool") {
            messageCount++;
            conversationMessageCount++;
          }
          // Capture first user message for type detection
          if (msg.role === "user" && firstUserMessage === null && msg.content) {
            firstUserMessage = typeof msg.content === "string"
              ? msg.content
              : Array.isArray(msg.content)
                ? (msg.content as Array<Record<string, unknown>>)
                    .filter((b) => b.type === "text")
                    .map((b) => b.text as string)
                    .join(" ")
                : JSON.stringify(msg.content);
          }
          if (msg.role === "assistant") {
            if (msg.tool_calls && Array.isArray(msg.tool_calls)) {
              toolCallCount += msg.tool_calls.length;
            }
            if (typeof msg.content === "string" && msg.content) {
              lastAssistantContent = msg.content;
            }
          }
        }
      }
    }

    if (startedAt === null) {
      startedAt = Date.now() / 1000;
    }

    const sessionType = detectSessionType(firstUserMessage ?? "");

    return {
      id: sessionId,
      source,
      sessionType,
      model,
      started_at: startedAt,
      last_message_at: lastMessageAt,
      message_count: messageCount,
      tool_call_count: toolCallCount,
      conversation_message_count: conversationMessageCount,
      last_assistant_content: lastAssistantContent,
      agentIds,
    };
  }

  /**
   * Read all messages from a session, unwrapping Claude Code envelope format.
   * Also includes messages from agent sub-sessions (agent-xxx.jsonl) that
   * belong to this session, interleaved by timestamp.
   */
  async read(sessionId: string): Promise<Array<{ index: number; msg: JsonlMessage }>> {
    const file = this.pathFor(sessionId);
    if (!file) return [];

    const dir = path.dirname(file);
    const allMessages: Array<{ timestamp: string; msg: JsonlMessage }> = [];

    // Read main session file
    await this.readFile(file, allMessages);

    // Find and read agent sub-sessions
    const agentDirs = [dir, path.join(dir, sessionId, "subagents")];
    for (const agentDir of agentDirs) {
      try {
        for (const f of fs.readdirSync(agentDir)) {
          if (!f.startsWith("agent-") || !f.endsWith(".jsonl")) continue;
          await this.readFile(path.join(agentDir, f), allMessages);
        }
      } catch { /* dir doesn't exist */ }
    }

    // Sort by timestamp and assign indices
    allMessages.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return allMessages.map((m, i) => ({ index: i, msg: m.msg }));
  }

  private async readFile(
    file: string,
    out: Array<{ timestamp: string; msg: JsonlMessage }>,
  ): Promise<void> {
    const stream = fs.createReadStream(file, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const msgs = unwrapLine(raw);
        for (const msg of msgs) {
          if (msg.role === "system" && !msg.content) continue;
          const timestamp = msg.timestamp ?? (raw.timestamp as string) ?? "";
          out.push({ timestamp: timestamp as string, msg });
        }
      } catch {
        // skip malformed
      }
    }
  }

  /** Get the file path for a session (needed by the tailer) */
  getFilePath(sessionId: string): string | null {
    return this.pathFor(sessionId);
  }
}

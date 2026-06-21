import {
  SessionLog,
  type JsonlMessage,
  type SessionLogScope,
} from "../session-log.js";

export type { JsonlMessage } from "../session-log.js";

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
  /** Messaging platform a chat session originated from ("slack" / "cli"). */
  platform?: string | null;
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
export type SessionReaderScope = SessionLogScope;

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
  normalizeRawLine(raw: Record<string, unknown>): JsonlMessage[];
}

export class SessionReader implements SessionSource {
  private sessionLog: SessionLog;
  private scope: SessionLogScope;
  private metaCache = new Map<string, { meta: SessionMeta; cachedAt: number }>();
  private static CACHE_TTL_MS = 10_000; // 10s cache for session metadata

  constructor(sessionsHomeDir: string, scope?: SessionReaderScope);
  constructor(sessionLog: SessionLog, scope?: SessionReaderScope);
  constructor(sessionsHomeDirOrLog: string | SessionLog, scope: SessionReaderScope = "sandbox") {
    this.sessionLog = typeof sessionsHomeDirOrLog === "string"
      ? new SessionLog(sessionsHomeDirOrLog)
      : sessionsHomeDirOrLog;
    this.scope = scope;
  }

  exists(sessionId: string): boolean {
    return this.sessionLog.findSession(this.scope, sessionId) !== null;
  }

  /** Return all session IDs across all project directories, sorted
   *  newest-first by file mtime.
   *
   *  Filters out agent sub-sessions (agent-xxx) — those are included
   *  in their parent session's view.
   *
   *  The newest-first ordering matters: callers (the `/sessions` list +
   *  SSE handlers) slice this to a `limit * 2` window BEFORE loading and
   *  date-sorting each session's meta. With raw `readdir` order that window
   *  could omit the most recent sessions entirely — e.g. today's runs living
   *  in repo-suffixed project dirs read after a large generic dir — so the
   *  list silently showed only older sessions. mtime is a cheap, reliable
   *  recency proxy (it tracks the last appended message) that keeps the
   *  freshest sessions inside the window; the handler then refines ordering
   *  by parsed `started_at`. Mirrors the DB-backed chat reader, which
   *  already returns threads newest-first. */
  listSessionIds(): string[] {
    return this.sessionLog.listSessions(this.scope).map((e) => e.id);
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
    const entry = this.sessionLog.findSession(this.scope, sessionId);
    if (!entry) return null;

    const filesToScan = this.sessionLog.relatedFilesForSession(this.scope, sessionId, { includeAgents: true });

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
      const records = await this.sessionLog.readNormalizedFile(scanFile);
      for (const { raw, msg } of records) {
        // Track agent sub-sessions
        const agentId = raw.agentId as string | undefined;
        if (agentId && !agentIds.includes(agentId)) {
          agentIds.push(agentId);
        }

        // Extract source from userType field
        if (raw.userType === "external") source = "agent";

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

    if (startedAt === null) {
      // No parseable timestamps (empty or malformed file). Fall back to the
      // file's mtime — its real last-write time — NOT Date.now(). Using "now"
      // made a zero-byte/timestamp-less session masquerade as freshly active:
      // it sorted to the top of the list and tripped the 5-minute liveness
      // check, surfacing dead runs as live sessions.
      startedAt = entry.mtimeMs > 0 ? entry.mtimeMs / 1000 : Date.now() / 1000;
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
    return this.sessionLog.readNormalizedSession(this.scope, sessionId, {
      includeAgents: true,
      skipEmptySystem: true,
    });
  }

  /** Get the file path for a session (needed by the tailer) */
  getFilePath(sessionId: string): string | null {
    return this.sessionLog.findSession(this.scope, sessionId)?.filePath ?? null;
  }

  normalizeRawLine(raw: Record<string, unknown>): JsonlMessage[] {
    return this.sessionLog.normalizeLine(raw);
  }
}

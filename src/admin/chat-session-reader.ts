import type { StateDb } from "../state/db.js";
import {
  CHAT_PROJECT_SLUG,
  SessionLog,
  type JsonlMessage,
} from "../session-log.js";
import type { SessionSource, SessionMeta } from "./sessions.js";

/**
 * DB-backed chat-session reader. Drop-in replacement for SessionReader on
 * the chat path: same public surface (`mountSessionRoutes` works against it
 * unchanged), but listing comes from the executions table grouped by Slack
 * thread, and message reads target the single jsonl file owned by that
 * thread's pi-ai session id. SessionLog owns the on-disk CHAT_PROJECT_SLUG
 * path resolution, so this reader does not scan unrelated `agent-*.jsonl`
 * sidechain files from other in-process Agent SDK runs.
 *
 * Conceptual mapping:
 * - SessionMeta.id      ← messaging_session.id (= Slack thread / executions.trigger_id)
 * - jsonl on disk       ← SessionLog CHAT_PROJECT_SLUG file for
 *                         messaging_sessions.agent_session_id
 */
export class ChatSessionReader implements SessionSource {
  private db: StateDb;
  private sessionLog: SessionLog;

  constructor(db: StateDb, sessionsHomeDir: string);
  constructor(db: StateDb, sessionLog: SessionLog);
  constructor(db: StateDb, sessionsHomeDirOrLog: string | SessionLog) {
    this.db = db;
    this.sessionLog = typeof sessionsHomeDirOrLog === "string"
      ? new SessionLog(sessionsHomeDirOrLog)
      : sessionsHomeDirOrLog;
  }

  /** All chat thread ids (= Slack threads) that have at least one chat execution. */
  listSessionIds(): string[] {
    // Soft cap at 500 — anything older than that almost certainly won't be
    // surfaced after the dashboard's per-tab filters anyway.
    return this.db.executions.listChatThreads(500).map((t) => t.triggerId);
  }

  exists(id: string): boolean {
    return this.db.executions.getChatThread(id) !== null;
  }

  async getSessionMeta(id: string): Promise<SessionMeta | null> {
    const t = this.db.executions.getChatThread(id);
    if (!t) return null;
    const startedAt = new Date(t.firstStartedAt).getTime() / 1000;
    const lastMessageAt = new Date(t.lastActivityAt).getTime() / 1000;
    // sessionType "chat" lets the dashboard SessionFilters show a chat
    // chip and gives the user a meaningful label.
    return {
      id,
      source: "chat",
      sessionType: "chat",
      model: null,
      started_at: Number.isNaN(startedAt) ? Date.now() / 1000 : startedAt,
      last_message_at: Number.isNaN(lastMessageAt) ? null : lastMessageAt,
      message_count: t.turnCount,
      tool_call_count: 0,
      conversation_message_count: t.turnCount,
      last_assistant_content: t.lastAssistantContent,
      agentIds: [],
      platform: t.platform,
    };
  }

  async read(id: string): Promise<Array<{ index: number; msg: JsonlMessage }>> {
    const thread = this.db.executions.getChatThread(id);
    if (!thread?.agentSessionId) return [];
    return this.sessionLog.readNormalizedSession("chat", thread.agentSessionId, {
      includeAgents: false,
      skipEmptySystem: true,
    });
  }

  /**
   * Resolve a thread id to its on-disk Agent SDK jsonl. Returns null if
   * the thread has no agent_session_id yet (pre-resume) or the jsonl file
   * doesn't exist on disk (deleted, rotated, or written by a different
   * Agent SDK installation).
   */
  getFilePath(id: string): string | null {
    const thread = this.db.executions.getChatThread(id);
    if (!thread || !thread.agentSessionId) return null;
    return this.sessionLog.pathForProject(CHAT_PROJECT_SLUG, thread.agentSessionId, {
      requireExists: true,
    });
  }

  normalizeRawLine(raw: Record<string, unknown>): JsonlMessage[] {
    return this.sessionLog.normalizeLine(raw);
  }
}

import * as fs from "node:fs";
import * as path from "node:path";
import * as readline from "node:readline";
import type { StateDb } from "../state/db.js";
import type { SessionSource, SessionMeta, JsonlMessage } from "./sessions.js";
import { unwrapLine } from "./sessions.js";

/**
 * DB-backed chat-session reader. Drop-in replacement for SessionReader on
 * the chat path: same public surface (`mountSessionRoutes` works against it
 * unchanged), but listing comes from the executions table grouped by Slack
 * thread, and message reads target the single jsonl file owned by that
 * thread's pi-ai session id — no scanning of unrelated `agent-*.jsonl`
 * sidechain files under `<sessionsDir>/projects/-app/`.
 *
 * Conceptual mapping:
 * - SessionMeta.id      ← messaging_session.id (= Slack thread / executions.trigger_id)
 * - jsonl on disk       ← <sessionsDir>/projects/-app/<agent_session_id>.jsonl
 *                         (resolved via messaging_sessions.agent_session_id)
 */
export class ChatSessionReader implements SessionSource {
  private db: StateDb;
  private sessionsHomeDir: string;

  constructor(db: StateDb, sessionsHomeDir: string) {
    this.db = db;
    this.sessionsHomeDir = sessionsHomeDir;
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
    };
  }

  async read(id: string): Promise<Array<{ index: number; msg: JsonlMessage }>> {
    const file = this.getFilePath(id);
    if (!file) return [];
    return this.readSingleFile(file);
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
    const file = path.join(
      this.sessionsHomeDir,
      "projects",
      "-app",
      `${thread.agentSessionId}.jsonl`,
    );
    if (!fs.existsSync(file)) return null;
    return file;
  }

  /**
   * Read one specific jsonl file end-to-end. Crucially, we DO NOT walk
   * sibling `agent-*.jsonl` files like SessionReader does — those are
   * unrelated sidechain spawns from other in-process Agent SDK runs and
   * would pollute the conversation view.
   */
  private async readSingleFile(file: string): Promise<Array<{ index: number; msg: JsonlMessage }>> {
    const out: Array<{ timestamp: string; msg: JsonlMessage }> = [];
    const stream = fs.createReadStream(file, { encoding: "utf8" });
    const rl = readline.createInterface({ input: stream, crlfDelay: Infinity });
    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const raw = JSON.parse(line) as Record<string, unknown>;
        const msgs = unwrapLine(raw);
        for (const msg of msgs) {
          if (msg.role === "system" && !msg.content) continue;
          const timestamp = (msg.timestamp as string) ?? (raw.timestamp as string) ?? "";
          out.push({ timestamp, msg });
        }
      } catch {
        // skip malformed line
      }
    }
    out.sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    return out.map((m, i) => ({ index: i, msg: m.msg }));
  }
}

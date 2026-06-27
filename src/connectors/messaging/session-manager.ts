import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { ConversationKey, ConversationSession, ConversationMessage } from "./types.js";

/** Inactivity timeout before a session is considered stale (30 minutes) */
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/**
 * SQLite-backed session manager for messaging conversations.
 * Shared across all messaging platform connectors.
 */
export class SessionManager {
  private db: Database.Database;

  constructor(db: Database.Database) {
    this.db = db;
    this.migrate();
  }

  private migrate() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messaging_sessions (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT,
        user_id TEXT NOT NULL,
        agent_session_id TEXT,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1
      );

      CREATE TABLE IF NOT EXISTS messaging_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES messaging_sessions(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        platform_message_id TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_msg_sessions_lookup
        ON messaging_sessions(platform, channel_id, thread_id, user_id);
      CREATE INDEX IF NOT EXISTS idx_msg_messages_session
        ON messaging_messages(session_id, timestamp);
    `);

    // Older versions of this code put an unconditional
    // `UNIQUE(platform, channel_id, thread_id, user_id)` on the table.
    // That collides with the get-or-create flow: a stale (active=0) row
    // for a returning user/thread would block the INSERT of a fresh
    // session. Replace it with a partial unique index that only enforces
    // the "one active session per key" invariant — the actually-desired
    // semantic. Inactive rows from past sessions are allowed to pile up
    // (deleted later by clearStale).
    const tableSql = (this.db
      .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='messaging_sessions'`)
      .get() as { sql?: string } | undefined)?.sql ?? "";
    if (tableSql.includes("UNIQUE(platform")) {
      this.rebuildWithoutTableUnique();
    }

    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_msg_sessions_unique_active
        ON messaging_sessions(platform, channel_id, thread_id, user_id)
        WHERE active = 1
    `);
  }

  /**
   * One-shot migration: copy `messaging_sessions` rows into a table
   * without the table-level UNIQUE constraint. `messaging_messages.session_id`
   * has a foreign key to this table, so `DROP TABLE messaging_sessions`
   * trips FK enforcement.
   *
   * Follows SQLite's official table-rebuild recipe
   * (https://www.sqlite.org/lang_altertable.html#otheralter): toggle
   * `foreign_keys` OFF *outside* a transaction, do the rebuild, run
   * `foreign_key_check` to confirm no orphans, COMMIT, re-enable.
   * `defer_foreign_keys` isn't enough — it pushes the check to COMMIT but
   * still fails when the schema flux at rename-time is observed.
   *
   * `foreign_key_check` after the rebuild is belt-and-suspenders: if the
   * copy somehow missed rows the messages reference, fail the migration
   * loudly rather than commit a half-broken schema.
   */
  private rebuildWithoutTableUnique() {
    console.log("[messaging] migrating messaging_sessions: dropping unconditional UNIQUE constraint");
    const fkOriginal = this.db.pragma("foreign_keys", { simple: true });
    this.db.pragma("foreign_keys = OFF");
    try {
      this.db.exec("BEGIN");
      try {
        this.db.exec(`
          CREATE TABLE messaging_sessions__new (
            id TEXT PRIMARY KEY,
            platform TEXT NOT NULL,
            channel_id TEXT NOT NULL,
            thread_id TEXT,
            user_id TEXT NOT NULL,
            agent_session_id TEXT,
            created_at TEXT NOT NULL,
            last_activity_at TEXT NOT NULL,
            message_count INTEGER DEFAULT 0,
            active INTEGER DEFAULT 1
          );
          INSERT INTO messaging_sessions__new
            SELECT id, platform, channel_id, thread_id, user_id, agent_session_id,
                   created_at, last_activity_at, message_count, active
            FROM messaging_sessions;
          DROP TABLE messaging_sessions;
          ALTER TABLE messaging_sessions__new RENAME TO messaging_sessions;
          CREATE INDEX IF NOT EXISTS idx_msg_sessions_lookup
            ON messaging_sessions(platform, channel_id, thread_id, user_id);
        `);
        const violations = this.db.pragma("foreign_key_check") as unknown[];
        if (violations.length > 0) {
          throw new Error(
            `FK check failed after migration — ${violations.length} dangling reference(s): ` +
            JSON.stringify(violations),
          );
        }
        this.db.exec("COMMIT");
      } catch (err) {
        this.db.exec("ROLLBACK");
        throw err;
      }
    } finally {
      if (fkOriginal) this.db.pragma("foreign_keys = ON");
    }
  }

  /** Look up an existing session by id (used to read its agent_session_id). */
  getSession(id: string): ConversationSession | null {
    const row = this.db.prepare(`SELECT * FROM messaging_sessions WHERE id = ?`).get(id) as Record<string, unknown> | undefined;
    return row ? this.rowToSession(row) : null;
  }

  /** Get an existing active session or create a new one */
  getOrCreateSession(key: ConversationKey): ConversationSession {
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS).toISOString();

    // Look for an active, non-stale session
    const existing = this.db.prepare(`
      SELECT * FROM messaging_sessions
      WHERE platform = ? AND channel_id = ? AND thread_id IS ? AND user_id = ?
        AND active = 1 AND last_activity_at >= ?
    `).get(key.platform, key.channelId, key.threadId, key.userId, cutoff) as any;

    if (existing) {
      return this.rowToSession(existing);
    }

    // Deactivate any stale sessions for this key
    this.db.prepare(`
      UPDATE messaging_sessions SET active = 0
      WHERE platform = ? AND channel_id = ? AND thread_id IS ? AND user_id = ? AND active = 1
    `).run(key.platform, key.channelId, key.threadId, key.userId);

    // Create new session
    const id = randomUUID();
    this.db.prepare(`
      INSERT INTO messaging_sessions (id, platform, channel_id, thread_id, user_id, created_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(id, key.platform, key.channelId, key.threadId, key.userId, now, now);

    return {
      id,
      platform: key.platform,
      channelId: key.channelId,
      threadId: key.threadId,
      userId: key.userId,
      agentSessionId: null,
      createdAt: now,
      lastActivityAt: now,
      messageCount: 0,
      active: true,
    };
  }

  /**
   * Persist the Agent SDK session id captured from the first chat reply in
   * a thread. Subsequent replies in the same thread pass this id back to
   * the SDK as `resume`, so the whole Slack thread maps to one continuous
   * Agent SDK session jsonl instead of a fresh file per message.
   */
  setAgentSessionId(id: string, agentSessionId: string | null): void {
    this.db.prepare(`
      UPDATE messaging_sessions SET agent_session_id = ? WHERE id = ?
    `).run(agentSessionId, id);
  }

  /** Update last activity timestamp and increment message count */
  touchSession(id: string): void {
    this.db.prepare(`
      UPDATE messaging_sessions
      SET last_activity_at = ?, message_count = message_count + 1
      WHERE id = ?
    `).run(new Date().toISOString(), id);
  }

  /** Deactivate a session (e.g., user sends /new or /reset) */
  deactivateSession(id: string): void {
    this.db.prepare(`UPDATE messaging_sessions SET active = 0 WHERE id = ?`).run(id);
  }

  /** Store a message in the conversation history */
  addMessage(sessionId: string, role: "user" | "assistant", content: string, platformMessageId?: string): void {
    this.db.prepare(`
      INSERT INTO messaging_messages (session_id, role, content, timestamp, platform_message_id)
      VALUES (?, ?, ?, ?, ?)
    `).run(sessionId, role, content, new Date().toISOString(), platformMessageId || null);
  }

  /** Get conversation history for a session (most recent N messages) */
  getHistory(sessionId: string, limit = 50): ConversationMessage[] {
    const rows = this.db.prepare(`
      SELECT * FROM messaging_messages
      WHERE session_id = ?
      ORDER BY timestamp ASC
      LIMIT ?
    `).all(sessionId, limit) as any[];

    return rows.map((r) => ({
      id: r.id,
      sessionId: r.session_id,
      role: r.role,
      content: r.content,
      timestamp: r.timestamp,
      platformMessageId: r.platform_message_id,
    }));
  }

  /** Check if the bot is already participating in a thread (any user, any active non-stale session) */
  hasActiveThread(platform: string, channelId: string, threadId: string): boolean {
    const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS).toISOString();
    const row = this.db.prepare(`
      SELECT 1 FROM messaging_sessions
      WHERE platform = ? AND channel_id = ? AND thread_id = ?
        AND active = 1 AND last_activity_at >= ?
      LIMIT 1
    `).get(platform, channelId, threadId);
    return !!row;
  }

  /** Clean up old inactive sessions (call from cron) */
  cleanupStaleSessions(maxAgeDays = 7): number {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();

    // Delete messages for old sessions first
    this.db.prepare(`
      DELETE FROM messaging_messages WHERE session_id IN (
        SELECT id FROM messaging_sessions WHERE active = 0 AND last_activity_at < ?
      )
    `).run(cutoff);

    const result = this.db.prepare(`
      DELETE FROM messaging_sessions WHERE active = 0 AND last_activity_at < ?
    `).run(cutoff);

    return result.changes;
  }

  private rowToSession(row: any): ConversationSession {
    return {
      id: row.id,
      platform: row.platform,
      channelId: row.channel_id,
      threadId: row.thread_id,
      userId: row.user_id,
      agentSessionId: row.agent_session_id,
      createdAt: row.created_at,
      lastActivityAt: row.last_activity_at,
      messageCount: row.message_count,
      active: !!row.active,
    };
  }
}

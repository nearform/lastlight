import { afterEach, beforeEach, describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { SessionManager } from "./session-manager.js";

const KEY = {
  platform: "slack",
  channelId: "C123",
  threadId: "thread-1",
  userId: "U999",
};

describe("SessionManager", () => {
  let db: Database.Database;
  let manager: SessionManager;

  beforeEach(() => {
    db = new Database(":memory:");
    manager = new SessionManager(db);
  });

  afterEach(() => {
    db.close();
  });

  it("returns the same active session for the same key", () => {
    const a = manager.getOrCreateSession(KEY);
    const b = manager.getOrCreateSession(KEY);
    expect(b.id).toBe(a.id);
    expect(b.active).toBe(true);
  });

  it("creates a new session after the old one is deactivated", () => {
    const a = manager.getOrCreateSession(KEY);
    manager.deactivateSession(a.id);
    const b = manager.getOrCreateSession(KEY);
    expect(b.id).not.toBe(a.id);
    expect(b.active).toBe(true);

    // The old row should still exist (audit trail), just inactive — the
    // partial unique index only forbids two ACTIVE rows for the same key.
    const rows = db.prepare(`
      SELECT id, active FROM messaging_sessions
      WHERE platform = ? AND channel_id = ? AND thread_id = ? AND user_id = ?
      ORDER BY created_at
    `).all(KEY.platform, KEY.channelId, KEY.threadId, KEY.userId) as Array<{ id: string; active: number }>;
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.active).sort()).toEqual([0, 1]);
  });

  it("migrates a legacy schema with FK-referencing messages without dropping them", () => {
    // Reproduces the production crash: a DB carrying messaging_messages
    // rows that point at messaging_sessions via FK fails DROP TABLE
    // unless FK enforcement is deferred.
    const legacy = new Database(":memory:");
    legacy.pragma("foreign_keys = ON");
    legacy.exec(`
      CREATE TABLE messaging_sessions (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT,
        user_id TEXT NOT NULL,
        agent_session_id TEXT,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1,
        UNIQUE(platform, channel_id, thread_id, user_id)
      );
      CREATE TABLE messaging_messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        session_id TEXT NOT NULL REFERENCES messaging_sessions(id),
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        timestamp TEXT NOT NULL,
        platform_message_id TEXT
      );
      INSERT INTO messaging_sessions
        (id, platform, channel_id, thread_id, user_id, created_at, last_activity_at, active)
      VALUES ('sess-1', 'slack', 'C123', 't1', 'U1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 1);
      INSERT INTO messaging_messages (session_id, role, content, timestamp)
      VALUES ('sess-1', 'user', 'hi', '2026-01-01T00:00:01Z'),
             ('sess-1', 'assistant', 'hi back', '2026-01-01T00:00:02Z');
    `);

    // Migration should succeed without losing the FK-referenced rows.
    new SessionManager(legacy);
    const survivingMessages = legacy.prepare(`SELECT COUNT(*) AS n FROM messaging_messages WHERE session_id = 'sess-1'`).get() as { n: number };
    expect(survivingMessages.n).toBe(2);
    const survivingSession = legacy.prepare(`SELECT id FROM messaging_sessions WHERE id = 'sess-1'`).get();
    expect(survivingSession).toBeDefined();

    // And the FK is still enforced post-migration.
    expect(() => legacy.prepare(`
      INSERT INTO messaging_messages (session_id, role, content, timestamp)
      VALUES (?, ?, ?, ?)
    `).run("does-not-exist", "user", "x", "2026-01-01T00:00:03Z"))
      .toThrow(/FOREIGN KEY/);

    legacy.close();
  });

  it("migrates a legacy table that has the old unconditional UNIQUE constraint", () => {
    // Spin up a DB pre-loaded with the old schema, then run the manager
    // (which runs migrate()) and verify a fresh insert no longer collides.
    const legacy = new Database(":memory:");
    legacy.exec(`
      CREATE TABLE messaging_sessions (
        id TEXT PRIMARY KEY,
        platform TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        thread_id TEXT,
        user_id TEXT NOT NULL,
        agent_session_id TEXT,
        created_at TEXT NOT NULL,
        last_activity_at TEXT NOT NULL,
        message_count INTEGER DEFAULT 0,
        active INTEGER DEFAULT 1,
        UNIQUE(platform, channel_id, thread_id, user_id)
      );
      INSERT INTO messaging_sessions
        (id, platform, channel_id, thread_id, user_id, created_at, last_activity_at, active)
      VALUES
        ('old-1', 'slack', 'C123', 'thread-1', 'U999', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0);
    `);

    // Sanity check: the legacy schema *would* reject a second insert.
    expect(() => legacy.prepare(`
      INSERT INTO messaging_sessions
        (id, platform, channel_id, thread_id, user_id, created_at, last_activity_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run("dup", "slack", "C123", "thread-1", "U999", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"))
      .toThrow(/UNIQUE/);

    // Run the migration via a fresh SessionManager on the same DB.
    const migrated = new SessionManager(legacy);

    // The old row survives the migration.
    const oldRow = legacy.prepare(`SELECT id FROM messaging_sessions WHERE id = 'old-1'`).get();
    expect(oldRow).toBeDefined();

    // And get-or-create now succeeds — old (active=0) row no longer blocks insert.
    const fresh = migrated.getOrCreateSession(KEY);
    expect(fresh.id).not.toBe("old-1");
    expect(fresh.active).toBe(true);

    legacy.close();
  });

  it("partial unique index still prevents two active rows for the same key", () => {
    const a = manager.getOrCreateSession(KEY);
    expect(a.active).toBe(true);
    // Directly insert a second active row — should fail the partial index.
    expect(() => db.prepare(`
      INSERT INTO messaging_sessions
        (id, platform, channel_id, thread_id, user_id, created_at, last_activity_at, active)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1)
    `).run("dup", KEY.platform, KEY.channelId, KEY.threadId, KEY.userId, "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"))
      .toThrow(/UNIQUE/);
  });
});

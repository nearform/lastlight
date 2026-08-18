import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate as drizzleMigrate } from "drizzle-orm/libsql/migrator";
import { and, eq } from "drizzle-orm";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

// The legacy compat pre-step logs via the pino LoggerPort — mock the logger
// module so the suite's stderr stays free of real pino JSON (no assertions
// here depend on the logged content).
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

import { SessionManager } from "#src/connectors/messaging/session-manager.js";
import { applyLegacySqliteCompat } from "#src/state/legacy-sqlite.js";
import * as sqliteSchema from "#src/state/schema/sqlite.js";
import { messagingMessages, messagingSessions } from "#src/state/schema/sqlite.js";
import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../../helpers/state-db.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../drizzle/sqlite", import.meta.url));

const KEY = {
  platform: "slack",
  channelId: "C123",
  threadId: "thread-1",
  userId: "U999",
};

/**
 * Drizzle wraps driver errors in a `DrizzleQueryError` whose own message is
 * only the failed SQL — the SQLite constraint text lives on `cause`. Flatten
 * the chain so a test can still assert on WHICH constraint fired.
 */
async function constraintFailure(op: Promise<unknown>): Promise<string> {
  try {
    await op;
  } catch (err) {
    const chain: string[] = [];
    for (let e: unknown = err, depth = 0; e != null && depth < 6; e = (e as { cause?: unknown }).cause, depth++) {
      chain.push(String((e as Error).message));
    }
    return chain.join(" | ");
  }
  throw new Error("expected the statement to fail, but it succeeded");
}

describe("SessionManager", () => {
  let db: StateDb;
  let manager: SessionManager;

  beforeEach(async () => {
    db = await makeTestDb();
    manager = new SessionManager(db.client);
  });

  it("returns the same active session for the same key", async () => {
    const a = await manager.getOrCreateSession(KEY);
    const b = await manager.getOrCreateSession(KEY);
    expect(b.id).toBe(a.id);
    expect(b.active).toBe(true);
  });

  it("creates a new session after the old one is deactivated", async () => {
    const a = await manager.getOrCreateSession(KEY);
    await manager.deactivateSession(a.id);
    const b = await manager.getOrCreateSession(KEY);
    expect(b.id).not.toBe(a.id);
    expect(b.active).toBe(true);

    // The old row should still exist (audit trail), just inactive — the
    // partial unique index only forbids two ACTIVE rows for the same key.
    const rows = await db.client
      .select({ id: messagingSessions.id, active: messagingSessions.active })
      .from(messagingSessions)
      .where(
        and(
          eq(messagingSessions.platform, KEY.platform),
          eq(messagingSessions.channelId, KEY.channelId),
          eq(messagingSessions.threadId, KEY.threadId),
          eq(messagingSessions.userId, KEY.userId),
        ),
      )
      .orderBy(messagingSessions.createdAt);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.active).sort()).toEqual([false, true]);
  });

  describe("getHistory", () => {
    it("keeps the NEWEST messages when the limit bites, oldest-first", async () => {
      const s = await manager.getOrCreateSession(KEY);
      for (let i = 0; i < 10; i++) {
        await manager.addMessage(s.id, i % 2 === 0 ? "user" : "assistant", `m${i}`);
      }

      const history = await manager.getHistory(s.id, 4);
      // An `ASC … LIMIT` would return m0..m3 — the opening of the thread —
      // leaving a long conversation permanently rehydrating its own preamble.
      expect(history.map((h) => h.content)).toEqual(["m6", "m7", "m8", "m9"]);
    });

    it("orders same-millisecond writes by insertion, not arbitrarily", async () => {
      const s = await manager.getOrCreateSession(KEY);
      // The user + assistant rows of one turn are routinely written inside the
      // same whole-millisecond ISO timestamp, so `id` is the tiebreak.
      const now = new Date().toISOString();
      await db.client.insert(messagingMessages).values([
        { sessionId: s.id, role: "user", content: "question", timestamp: now },
        { sessionId: s.id, role: "assistant", content: "answer", timestamp: now },
      ]);

      expect((await manager.getHistory(s.id, 2)).map((h) => h.content)).toEqual([
        "question",
        "answer",
      ]);
    });
  });

  describe("findActiveThreadSession", () => {
    it("finds the thread's session without knowing which user opened it", async () => {
      const s = await manager.getOrCreateSession(KEY);
      const found = await manager.findActiveThreadSession("slack", KEY.channelId, KEY.threadId);
      expect(found?.id).toBe(s.id);
    });

    it("skips a stale session by default but finds it for a writer", async () => {
      const s = await manager.getOrCreateSession(KEY);
      // Age it past SESSION_TIMEOUT_MS — what a workflow that ran longer than
      // 30 minutes between question and answer leaves behind.
      await db.client
        .update(messagingSessions)
        .set({ lastActivityAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
        .where(eq(messagingSessions.id, s.id));

      expect(await manager.findActiveThreadSession("slack", KEY.channelId, KEY.threadId)).toBeNull();
      expect(await manager.hasActiveThread("slack", KEY.channelId, KEY.threadId)).toBe(false);
      expect(
        (
          await manager.findActiveThreadSession("slack", KEY.channelId, KEY.threadId, {
            includeStale: true,
          })
        )?.id,
      ).toBe(s.id);
    });

    it("ignores other threads and deactivated sessions", async () => {
      const s = await manager.getOrCreateSession(KEY);
      expect(await manager.findActiveThreadSession("slack", KEY.channelId, "other-thread")).toBeNull();
      await manager.deactivateSession(s.id);
      expect(
        await manager.findActiveThreadSession("slack", KEY.channelId, KEY.threadId, {
          includeStale: true,
        }),
      ).toBeNull();
    });
  });

  it("partial unique index still prevents two active rows for the same key", async () => {
    const a = await manager.getOrCreateSession(KEY);
    expect(a.active).toBe(true);
    // Directly insert a second active row — should fail the partial index.
    const failure = await constraintFailure(
      db.client.insert(messagingSessions).values({
        id: "dup",
        platform: KEY.platform,
        channelId: KEY.channelId,
        threadId: KEY.threadId,
        userId: KEY.userId,
        createdAt: "2026-01-01T00:00:00Z",
        lastActivityAt: "2026-01-01T00:00:00Z",
        active: true,
      }),
    );
    expect(failure).toMatch(/UNIQUE/);
  });
});

/**
 * The one legacy-database concern that is genuinely SessionManager's.
 *
 * The rebuild itself — stripping the old unconditional
 * `UNIQUE(platform, channel_id, thread_id, user_id)`, preserving the rows and
 * the FK-referencing messages, freeing the key the deactivated row occupied —
 * moved out to `applyLegacySqliteCompat()` and is covered end-to-end by
 * `tests/state/schema-equivalence.test.ts`. What that test cannot say is that
 * `getOrCreateSession` (the method the constraint actually broke) works over
 * the rebuilt database, and that the messages FK survives the table swap. This
 * boots the real path — raw client → compat pre-step → migrator — and asserts
 * exactly those two things.
 */
describe("SessionManager over a legacy database booted through the real path", () => {
  const dirs: string[] = [];

  afterAll(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  });

  it("serves get-or-create after the rebuild, with the messages FK intact", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lastlight-legacy-session-"));
    dirs.push(dir);
    const raw = createClient({ url: `file:${join(dir, "legacy.db")}` });
    try {
      await raw.executeMultiple(`
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
        VALUES ('old-1', 'slack', 'C123', 'thread-1', 'U999',
                '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0);
        INSERT INTO messaging_messages (session_id, role, content, timestamp)
        VALUES ('old-1', 'user', 'hi', '2026-01-01T00:00:01Z'),
               ('old-1', 'assistant', 'hi back', '2026-01-01T00:00:02Z');
      `);

      // Sanity check: the legacy schema *would* reject a second insert, even
      // though the row already there is deactivated. That is the bug.
      await expect(
        raw.execute({
          sql: `INSERT INTO messaging_sessions
                  (id, platform, channel_id, thread_id, user_id, created_at, last_activity_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: ["dup", "slack", "C123", "thread-1", "U999", "2026-01-01T00:00:00Z", "2026-01-01T00:00:00Z"],
        }),
      ).rejects.toThrow(/UNIQUE/);

      // The real boot path.
      await applyLegacySqliteCompat(raw);
      const client = drizzle(raw, { schema: sqliteSchema });
      await drizzleMigrate(client, { migrationsFolder: MIGRATIONS_FOLDER });

      // Get-or-create now succeeds — the old (active=0) row no longer blocks
      // the insert, which is the whole point of the rebuild.
      const manager = new SessionManager(client);
      const fresh = await manager.getOrCreateSession(KEY);
      expect(fresh.id).not.toBe("old-1");
      expect(fresh.active).toBe(true);

      // And the messages FK still bites after the table swap.
      await expect(
        raw.execute({
          sql: `INSERT INTO messaging_messages (session_id, role, content, timestamp)
                VALUES (?, ?, ?, ?)`,
          args: ["does-not-exist", "user", "x", "2026-01-01T00:00:03Z"],
        }),
      ).rejects.toThrow(/FOREIGN KEY/);
    } finally {
      raw.close();
    }
  });
});

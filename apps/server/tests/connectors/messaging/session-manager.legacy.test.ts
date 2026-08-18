/**
 * The one legacy-database concern that is genuinely SessionManager's.
 *
 * Inherently sqlite-only — it builds legacy DDL fixtures and exercises the
 * `legacy-sqlite.ts` pre-step — so it is NOT parameterized. Split out of
 * `session-manager.test.ts` in Phase 3, when that file became the thin sqlite
 * runner for `runSessionManagerSuite`.
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
import { afterAll, describe, expect, it, vi } from "vitest";

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

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate as drizzleMigrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { SessionManager } from "#src/connectors/messaging/session-manager.js";
import { applyLegacySqliteCompat } from "#src/state/legacy-sqlite.js";
import * as sqliteSchema from "#src/state/schema/sqlite.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../drizzle/sqlite", import.meta.url));

const KEY = {
  platform: "slack",
  channelId: "C123",
  threadId: "thread-1",
  userId: "U999",
};

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

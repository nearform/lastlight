/**
 * The dialect-parameterized `SessionManager` suite.
 *
 * `SessionManager` is not reachable through `StateDb` — it is constructed from
 * a `StateClient` + dialect (wired in `src/index.ts`) — so it takes its own
 * context factory rather than a `makeDb`.
 *
 * Not named `*.test.ts`: vitest collects `tests/**\/*.test.ts`, so this module
 * is imported by its runners and never collected on its own. All mutable state
 * is function-scoped — two invocations may share one process.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { and, eq } from "drizzle-orm";
import { tablesOf, type StateClient } from "#src/state/client.js";
import { isUniqueViolation } from "#src/state/dialect.js";
import type { SessionManager } from "#src/connectors/messaging/session-manager.js";
import type { Dialect } from "../../state/store-suite.js";

export interface SessionSuiteCtx {
  manager: SessionManager;
  /** For direct-row assertions (the audit trail, the duplicate-insert probe). */
  client: StateClient;
  close(): Promise<void>;
}

export interface SessionSuiteOpts {
  dialect: Dialect;
}

const KEY = {
  platform: "slack",
  channelId: "C123",
  threadId: "thread-1",
  userId: "U999",
};

export function runSessionManagerSuite(
  makeCtx: () => Promise<SessionSuiteCtx>,
  opts: SessionSuiteOpts,
): void {
  describe(`SessionManager [${opts.dialect}]`, () => {
    let ctx: SessionSuiteCtx;
    let manager: SessionManager;
    let client: StateClient;
    // The direct-row peeks below must address the tables of the dialect under
    // test, not the sqlite ones — a sqliteTable driven by a PG client writes
    // `1` into a boolean column and JSON.parses an already-parsed jsonb.
    let t: ReturnType<typeof tablesOf>;

    beforeEach(async () => {
      ctx = await makeCtx();
      manager = ctx.manager;
      client = ctx.client;
      t = tablesOf(client);
    });

    afterEach(async () => {
      await ctx.close();
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
      const rows = await client
        .select({ id: t.messagingSessions.id, active: t.messagingSessions.active })
        .from(t.messagingSessions)
        .where(
          and(
            eq(t.messagingSessions.platform, KEY.platform),
            eq(t.messagingSessions.channelId, KEY.channelId),
            eq(t.messagingSessions.threadId, KEY.threadId),
            eq(t.messagingSessions.userId, KEY.userId),
          ),
        )
        .orderBy(t.messagingSessions.createdAt);
      expect(rows).toHaveLength(2);
      expect(rows.map((r) => r.active).sort()).toEqual([false, true]);
    });

    describe("getHistory", () => {
      it("round-trips appended messages in order", async () => {
        // The plain append path, which the limit/tiebreak cases below never
        // assert on its own: two messages in, both out, oldest first.
        const s = await manager.getOrCreateSession(KEY);
        await manager.addMessage(s.id, "user", "first");
        await manager.addMessage(s.id, "assistant", "second");

        const history = await manager.getHistory(s.id, 10);
        expect(history.map((h) => [h.role, h.content])).toEqual([
          ["user", "first"],
          ["assistant", "second"],
        ]);
      });

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
        await client.insert(t.messagingMessages).values([
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
        await client
          .update(t.messagingSessions)
          .set({ lastActivityAt: new Date(Date.now() - 60 * 60 * 1000).toISOString() })
          .where(eq(t.messagingSessions.id, s.id));

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
      // Matched through `isUniqueViolation` rather than on the message text:
      // sqlite says "UNIQUE constraint failed", Postgres says "duplicate key …
      // 23505", and the helper walks the DrizzleQueryError cause chain for both.
      await expect(
        client.insert(t.messagingSessions).values({
          id: "dup",
          platform: KEY.platform,
          channelId: KEY.channelId,
          threadId: KEY.threadId,
          userId: KEY.userId,
          createdAt: "2026-01-01T00:00:00Z",
          lastActivityAt: "2026-01-01T00:00:00Z",
          active: true,
        }),
      ).rejects.toSatisfy(isUniqueViolation);
    });
  });
}

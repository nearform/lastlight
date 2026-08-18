/**
 * `FeedbackStore` — anchors, signals, the score aggregates, the polling
 * rotation and the export watermark (issue #255).
 *
 * Bodies moved verbatim from the pre-Phase-3 `tests/state/feedback-store.test.ts`.
 * That file's `vi.mock` of the logger moved to the runner
 * (`tests/state/db.test.ts`) — `vi.mock` is hoisted per test FILE and cannot
 * live in an imported module.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { tablesOf } from "#src/state/client.js";
import type { StateDb } from "#src/state/db.js";
import type { FeedbackAnchor, FeedbackAnchorInput } from "#src/state/feedback-store.js";
import type { MakeDb, SuiteOpts } from "../store-suite.js";

export function runFeedbackSuite(makeDb: MakeDb, _opts: SuiteOpts): void {
  describe("FeedbackStore", () => {
    let db: StateDb;

    beforeEach(async () => {
      db = await makeDb();
    });

    function slackAnchor(over: Partial<FeedbackAnchorInput> = {}): Promise<FeedbackAnchor> {
      return db.feedback.upsertAnchor({
        source: "slack",
        kind: "slack_message",
        externalId: "1712000000.000100",
        nodeId: null,
        channel: "C123",
        owner: null,
        repo: null,
        issueNumber: null,
        workflowRunId: "run-1",
        workflowName: "answer",
        messagingSessionId: null,
        ...over,
      });
    }

    function githubAnchor(over: Partial<FeedbackAnchorInput> = {}): Promise<FeedbackAnchor> {
      return db.feedback.upsertAnchor({
        source: "github",
        kind: "issue_comment",
        externalId: "5139649039",
        nodeId: "IC_kwDO_abc",
        channel: null,
        owner: "nearform",
        repo: "lastlight",
        issueNumber: 255,
        workflowRunId: "run-2",
        workflowName: "pr-review",
        messagingSessionId: null,
        ...over,
      });
    }

    // A direct row peek through the query builder rather than raw dialect SQL.
    // The table object is resolved from the client under test, not imported
    // from `schema/sqlite.js` — a sqliteTable driven by a PG client mis-maps its
    // own values. (Only the id column is read here, which is `text` in both
    // dialects, but the peek must still address the right table object.)
    const rowCount = async () => {
      const { feedbackAnchors } = tablesOf(db.client);
      return (await db.client.select({ id: feedbackAnchors.id }).from(feedbackAnchors)).length;
    };

    const thumbsUp = { emoji: "+1", score: 1, sentiment: "good" as const };
    const thumbsDown = { emoji: "-1", score: -1, sentiment: "bad" as const };
    const eyes = { emoji: "eyes", score: 0, sentiment: "neutral" as const };

    describe("anchors", () => {
      it("round-trips a slack anchor and finds it by (channel, ts)", async () => {
        const anchor = await slackAnchor();
        const found = await db.feedback.findAnchor("slack", "C123", "1712000000.000100");
        expect(found).toEqual(anchor);
        expect(found?.workflowRunId).toBe("run-1");
      });

      it("finds a github anchor whose channel is NULL", async () => {
        // `channel IS ?` rather than `= ?` — a NULL channel must still match, and
        // SQL equality against NULL never does.
        const anchor = await githubAnchor();
        expect((await db.feedback.findAnchor("github", null, "5139649039"))?.id).toBe(anchor.id);
      });

      it("is idempotent — re-registering the same message keeps one anchor", async () => {
        const first = await slackAnchor();
        const second = await slackAnchor();
        expect(second.id).toBe(first.id);
        expect(await rowCount()).toBe(1);
      });

      it("is idempotent for GITHUB anchors too, which have no channel", async () => {
        // SQLite treats NULLs as DISTINCT in a UNIQUE constraint, so a nullable
        // `channel` made `ON CONFLICT(source, channel, external_id)` silently
        // inoperative for every GitHub anchor: re-discovering the same comment —
        // which a retried run does, since its `since` window is unchanged — forked
        // a second row that the poller then spent budget on. Hence the '' sentinel.
        const first = await githubAnchor();
        const second = await githubAnchor();
        expect(second.id).toBe(first.id);
        expect(await rowCount()).toBe(1);
      });

      it("keeps the sentinel out of the type callers see", async () => {
        expect((await githubAnchor()).channel).toBeNull();
        expect((await slackAnchor()).channel).toBe("C123");
      });

      it("does not collide a slack ts with a github id that happens to match", async () => {
        await githubAnchor({ externalId: "555" });
        await slackAnchor({ externalId: "555" });
        expect(await rowCount()).toBe(2);
      });

      it("enriches an existing anchor rather than nulling out what it already knows", async () => {
        const first = await slackAnchor({ workflowRunId: "run-1", workflowName: "answer" });
        const second = await slackAnchor({ workflowRunId: null, workflowName: null, messagingSessionId: "exec-9" });
        expect(second.id).toBe(first.id);
        expect(second.workflowRunId).toBe("run-1");
        expect(second.messagingSessionId).toBe("exec-9");
      });
    });

    describe("signals", () => {
      it("records a new signal and carries the anchor's attribution onto it", async () => {
        const anchor = await githubAnchor();
        const signal = await db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "cliftonc" });
        expect(signal).toMatchObject({
          workflowRunId: "run-2",
          workflowName: "pr-review",
          repo: "lastlight",
          owner: "nearform",
          issueNumber: 255,
          emoji: "+1",
          score: 1,
          exportedAt: null,
        });
      });

      it("returns null on a replay so telemetry fires exactly once", async () => {
        const anchor = await slackAnchor();
        expect(await db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" })).not.toBeNull();
        expect(await db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" })).toBeNull();
        expect((await db.feedback.list()).total).toBe(1);
      });

      it("keeps different reactors and different emoji apart", async () => {
        const anchor = await slackAnchor();
        await db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" });
        await db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U2" });
        await db.feedback.recordSignal({ anchor, ...thumbsDown, reactor: "U1" });
        expect((await db.feedback.list()).total).toBe(3);
      });

      it("retracts rather than deletes, and drops the row from the live list", async () => {
        const anchor = await slackAnchor();
        await db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" });
        expect(await db.feedback.removeSignal(anchor.id, "U1", "+1")).toBe(true);
        expect((await db.feedback.list()).total).toBe(0);
        expect((await db.feedback.list({ includeRemoved: true })).total).toBe(1);
        // Retracting twice is a no-op, not a second event.
        expect(await db.feedback.removeSignal(anchor.id, "U1", "+1")).toBe(false);
      });

      it("revives a retracted signal and re-arms its export", async () => {
        const anchor = await slackAnchor();
        const first = (await db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" }))!;
        await db.feedback.markExported([first.id]);
        await db.feedback.removeSignal(anchor.id, "U1", "+1");

        const revived = await db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" });
        expect(revived).not.toBeNull();
        expect(revived!.removedAt).toBeNull();
        expect(revived!.exportedAt).toBeNull();
        expect((await db.feedback.list()).total).toBe(1);
      });

      it("reconciles an anchor against a fresh read, retracting what has vanished", async () => {
        const anchor = await githubAnchor();
        await db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "alice" });
        await db.feedback.recordSignal({ anchor, ...thumbsDown, reactor: "bob" });

        const removed = await db.feedback.reconcileAnchor(anchor.id, [{ reactor: "alice", emoji: "+1" }]);
        expect(removed).toBe(1);
        const live = await db.feedback.forRun("run-2");
        expect(live.map((s) => s.reactor)).toEqual(["alice"]);
      });
    });

    describe("aggregates", () => {
      it("averages over SCORED signals only — 👀 must not drag the mean to zero", async () => {
        const anchor = await githubAnchor();
        await db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "a" });
        await db.feedback.recordSignal({ anchor, emoji: "rocket", score: 2, sentiment: "very_good", reactor: "b" });
        await db.feedback.recordSignal({ anchor, ...eyes, reactor: "c" });

        const [row] = await db.feedback.summaryByWorkflow(30);
        expect(row).toMatchObject({
          workflowName: "pr-review",
          total: 3,
          positive: 2,
          negative: 0,
          neutral: 1,
          averageScore: 1.5, // (1 + 2) / 2, not (1 + 2 + 0) / 3
        });
      });

      it("excludes retracted signals from the summary", async () => {
        const anchor = await githubAnchor();
        await db.feedback.recordSignal({ anchor, ...thumbsDown, reactor: "a" });
        await db.feedback.removeSignal(anchor.id, "a", "-1");
        expect(await db.feedback.summaryByWorkflow(30)).toEqual([]);
      });

      it("zero-fills the daily series across the whole window", async () => {
        const anchor = await githubAnchor();
        await db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "a" });

        const series = await db.feedback.dailyScores(7);
        expect(series).toHaveLength(7);
        expect(series.at(-1)).toMatchObject({ total: 1, positive: 1, averageScore: 1 });
        expect(series.slice(0, 6).every((d) => d.total === 0)).toBe(true);
        // Keys are contiguous UTC dates.
        expect(new Set(series.map((d) => d.date)).size).toBe(7);
      });

      it("filters the daily series by workflow", async () => {
        await db.feedback.recordSignal({ anchor: await githubAnchor(), ...thumbsUp, reactor: "a" });
        await db.feedback.recordSignal({ anchor: await slackAnchor(), ...thumbsUp, reactor: "b" });

        expect((await db.feedback.dailyScores(1, "pr-review")).at(-1)?.total).toBe(1);
        expect((await db.feedback.dailyScores(1, "answer")).at(-1)?.total).toBe(1);
        expect((await db.feedback.dailyScores(1)).at(-1)?.total).toBe(2);
      });
    });

    describe("polling rotation + retention", () => {
      it("returns never-polled github anchors first, then least-recently-polled", async () => {
        const a = await githubAnchor({ externalId: "1", nodeId: "IC_1" });
        const b = await githubAnchor({ externalId: "2", nodeId: "IC_2" });
        const c = await githubAnchor({ externalId: "3", nodeId: "IC_3" });
        await db.feedback.markPolled([a.id], "2026-08-01T00:00:00.000Z");
        await db.feedback.markPolled([b.id], "2026-08-05T00:00:00.000Z");

        const order = (await db.feedback.anchorsToPoll({ windowDays: 14, limit: 10 })).map((x) => x.id);
        expect(order).toEqual([c.id, a.id, b.id]);
      });

      it("never polls slack anchors — those arrive live", async () => {
        await slackAnchor();
        expect(await db.feedback.anchorsToPoll({ windowDays: 14, limit: 10 })).toEqual([]);
      });

      it("drops anchors that have aged past the reaction window", async () => {
        await githubAnchor({ externalId: "old", nodeId: "IC_old", createdAt: "2020-01-01T00:00:00.000Z" });
        const fresh = await githubAnchor({ externalId: "new", nodeId: "IC_new" });
        const ids = (await db.feedback.anchorsToPoll({ windowDays: 14, limit: 10 })).map((x) => x.id);
        expect(ids).toEqual([fresh.id]);
      });

      it("respects the per-tick cap", async () => {
        for (let i = 0; i < 5; i++) await githubAnchor({ externalId: `c${i}`, nodeId: `IC_${i}` });
        expect(await db.feedback.anchorsToPoll({ windowDays: 14, limit: 2 })).toHaveLength(2);
      });

      it("prunes stale anchors but keeps the signals — those are the data", async () => {
        const old = await githubAnchor({ externalId: "old", createdAt: "2020-01-01T00:00:00.000Z" });
        await db.feedback.recordSignal({ anchor: old, ...thumbsUp, reactor: "a" });

        expect(await db.feedback.pruneAnchors(90)).toBe(1);
        expect(await db.feedback.getAnchor(old.id)).toBeNull();
        expect((await db.feedback.list()).total).toBe(1);
      });
    });

    describe("export watermark", () => {
      it("hands out unexported signals and stops once marked", async () => {
        const anchor = await slackAnchor();
        const s = (await db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" }))!;
        expect((await db.feedback.pendingExport()).map((x) => x.id)).toEqual([s.id]);
        await db.feedback.markExported([s.id]);
        expect(await db.feedback.pendingExport()).toEqual([]);
      });

      it("never hands out a signal the reactor already withdrew", async () => {
        // Added and retracted while telemetry was off: it has no `exported_at` and
        // a `removed_at`. Exporting it on the backlog drain would put a +1 the
        // person explicitly took back onto the trace, with nothing saying so.
        const anchor = await slackAnchor();
        const s = (await db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" }))!;
        await db.feedback.removeSignal(anchor.id, "U1", "+1");
        expect(s.exportedAt).toBeNull();
        expect(await db.feedback.pendingExport()).toEqual([]);
      });

      it("hands out a signal that was withdrawn and then re-added", async () => {
        const anchor = await slackAnchor();
        await db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" });
        await db.feedback.removeSignal(anchor.id, "U1", "+1");
        await db.feedback.recordSignal({ anchor, ...thumbsUp, reactor: "U1" });
        expect(await db.feedback.pendingExport()).toHaveLength(1);
      });
    });
  });
}

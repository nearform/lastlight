/**
 * `ExecutionStore` — the ledger writes, the record-returning reads, the
 * outcome classification and the stats rollups.
 *
 * Bodies moved from the pre-Phase-3 `tests/state/db.test.ts`
 * (`recordSkippedPhase`, `consecutiveFailures`, `dailyStats`),
 * `tests/state/execution-outcome.test.ts` and
 * `tests/state/execution-store-reads.test.ts`.
 *
 * **Fixed-timestamp rule.** Every bucketing assertion materializes its
 * timestamp as an ISO string ONCE and derives the expected bucket key by
 * slicing that same string (`slice(0, 10)` daily, `slice(0, 13)` hourly) —
 * matching the `substr` ports in `dayBucket()` / `hourBucket()`. Never
 * re-format through a second `new Date()`, and never compare against a
 * DB-generated clock value: that is what keeps the keys byte-identical on both
 * dialects.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { randomUUID } from "crypto";
import type { StateDb } from "#src/state/db.js";
import type { MakeDb, SuiteOpts } from "../store-suite.js";

export function runExecutionsSuite(makeDb: MakeDb, _opts: SuiteOpts): void {
  describe("ExecutionStore", () => {
    let db: StateDb;

    beforeEach(async () => {
      db = await makeDb();
    });

    describe("recordSkippedPhase — skips land in the executions ledger", () => {
      it("writes a finished, non-successful skip row that shouldRunPhase re-evaluates", async () => {
        const skill = "build:merge";
        const triggerId = "owner/repo#88";
        await db.executions.recordSkippedPhase(skill, triggerId, "wf-skip-1", "repo");

        // Not "done" (success is false) and not "running" (finished_at set) — so a
        // resume re-evaluates the node (it'll simply be re-skipped if still gated).
        expect(await db.executions.shouldRunPhase(skill, triggerId, "wf-skip-1")).toBe("run");
      });
    });

    describe("consecutiveFailures — the cron failure alert's only input", () => {
      // The single most dangerous line in the sqlite→drizzle port: `success` is a
      // boolean-mode column now, so the old `=== 0` compare is never true and this
      // would report a permanent zero, disarming the alert with nothing red
      // anywhere. Cheap to pin, silent to lose.
      async function finished(id: string, skill: string, success: boolean, startedAt: string) {
        await db.executions.recordStart({
          id,
          triggerType: "cron",
          triggerId: "owner/repo::health",
          skill,
          startedAt,
        });
        await db.executions.recordFinish(id, { success });
      }

      it("counts the failure streak and resets on a success at the head", async () => {
        await finished("cf-1", "cron-health", true, "2026-08-18T10:00:00.000Z");
        await finished("cf-2", "cron-health", false, "2026-08-18T10:01:00.000Z");
        await finished("cf-3", "cron-health", false, "2026-08-18T10:02:00.000Z");

        expect(await db.executions.consecutiveFailures("cron-health")).toBe(2);

        await finished("cf-4", "cron-health", true, "2026-08-18T10:03:00.000Z");
        expect(await db.executions.consecutiveFailures("cron-health")).toBe(0);
      });
    });

    describe("dailyStats", () => {
      // Each test gets its own database from `makeDb()`, so rows no longer
      // accumulate across tests and nothing has to be wiped up front. (The old
      // suite shared one file, because `path.resolve(':memory:')` resolved to
      // one, and had to DELETE FROM executions here.)

      async function insertExecution(opts: {
        id: string;
        startedAt: string;
        success?: boolean;
        inputTokens?: number;
        outputTokens?: number;
        cacheReadTokens?: number;
        costUsd?: number;
      }) {
        await db.executions.recordStart({
          id: opts.id,
          triggerType: "webhook",
          triggerId: "owner/repo#1",
          skill: "build",
          repo: "owner/repo",
          issueNumber: 1,
          startedAt: opts.startedAt,
        });
        if (opts.success !== undefined) {
          await db.executions.recordFinish(opts.id, {
            success: opts.success,
            inputTokens: opts.inputTokens,
            outputTokens: opts.outputTokens,
            cacheReadInputTokens: opts.cacheReadTokens,
            costUsd: opts.costUsd,
          });
        }
      }

      // Dates relative to "now" so the test data always falls inside the
      // dailyStats() window. Hardcoded calendar dates rot once wall-clock
      // time moves past the 30-day window. The bucket key is sliced off the
      // very string that gets inserted, never re-derived.
      function daysAgo(n: number): { iso: string; key: string } {
        const d = new Date();
        d.setUTCDate(d.getUTCDate() - n);
        d.setUTCHours(12, 0, 0, 0);
        const iso = d.toISOString();
        return { iso, key: iso.slice(0, 10) };
      }

      it("returns days rows of zeros when no executions exist", async () => {
        const rows = await db.executions.dailyStats(30);
        expect(rows).toHaveLength(30);
        expect(rows.every((r) => r.executions === 0)).toBe(true);
        expect(rows.every((r) => r.totalTokens === 0 && r.costUsd === 0)).toBe(true);
      });

      it("aggregates executions by date", async () => {
        const day1 = daysAgo(5);
        const day2 = daysAgo(4);
        await insertExecution({ id: randomUUID(), startedAt: day1.iso, success: true });
        await insertExecution({ id: randomUUID(), startedAt: day1.iso, success: false });
        await insertExecution({ id: randomUUID(), startedAt: day2.iso, success: true });

        const rows = await db.executions.dailyStats(30);
        expect(rows).toHaveLength(30);

        const d1 = rows.find((r) => r.date === day1.key);
        const d2 = rows.find((r) => r.date === day2.key);
        expect(d1).toBeDefined();
        expect(d1!.executions).toBe(2);
        expect(d1!.succeeded).toBe(1);
        expect(d1!.failed).toBe(1);
        expect(d2).toBeDefined();
        expect(d2!.executions).toBe(1);
        expect(d2!.succeeded).toBe(1);
        expect(d2!.failed).toBe(0);
      });

      it("sums token and cost data correctly", async () => {
        const day = daysAgo(3);
        await insertExecution({ id: randomUUID(), startedAt: day.iso, success: true, inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, costUsd: 0.01 });
        await insertExecution({ id: randomUUID(), startedAt: day.iso, success: true, inputTokens: 200, outputTokens: 80, cacheReadTokens: 0, costUsd: 0.02 });

        const rows = await db.executions.dailyStats(30);
        const d = rows.find((r) => r.date === day.key);
        expect(d).toBeDefined();
        expect(d!.inputTokens).toBe(300);
        expect(d!.outputTokens).toBe(130);
        expect(d!.cacheReadTokens).toBe(20);
        expect(d!.totalTokens).toBe(450);
        expect(d!.costUsd).toBeCloseTo(0.03);
      });

      it("handles NULL token/cost columns gracefully", async () => {
        const day = daysAgo(2);
        // recordStart only — no recordFinish, so tokens/cost are NULL
        await db.executions.recordStart({ id: randomUUID(), triggerType: "webhook", triggerId: "t1", skill: "build", repo: "r", issueNumber: 1, startedAt: day.iso });

        const rows = await db.executions.dailyStats(30);
        const d = rows.find((r) => r.date === day.key);
        expect(d).toBeDefined();
        expect(d!.totalTokens).toBe(0);
        expect(d!.costUsd).toBe(0);
      });

      it("respects the days limit and excludes older executions", async () => {
        // Very old execution — 60 days ago
        const old = new Date();
        old.setDate(old.getDate() - 60);
        await insertExecution({ id: randomUUID(), startedAt: old.toISOString(), success: true });

        // Recent execution — today
        await insertExecution({ id: randomUUID(), startedAt: new Date().toISOString(), success: true });

        const rows = await db.executions.dailyStats(30);
        // 30 daily rows (filled with zeros), with exactly one having an execution
        expect(rows).toHaveLength(30);
        const withExec = rows.filter((r) => r.executions > 0);
        expect(withExec).toHaveLength(1);
      });

      it("orders results by date ascending", async () => {
        // These were hardcoded `2026-04-08..10`, which fell out of the 30-day
        // window long ago — the assertion had degraded to "the zero-filled rows
        // are sorted", which no bucketing bug could ever break. Relative days put
        // real rows back inside the window, so the ordering claim is about the
        // GROUP BY's own output again.
        const d1 = daysAgo(3);
        const d2 = daysAgo(2);
        const d3 = daysAgo(1);
        await insertExecution({ id: randomUUID(), startedAt: d3.iso, success: true });
        await insertExecution({ id: randomUUID(), startedAt: d1.iso, success: true });
        await insertExecution({ id: randomUUID(), startedAt: d2.iso, success: true });

        const rows = await db.executions.dailyStats(30);
        expect(rows).toHaveLength(30);
        const dates = rows.map((r) => r.date);
        const sorted = [...dates].sort();
        expect(dates).toEqual(sorted);

        // …and the rows we actually wrote land in their own buckets, in that
        // same ascending order — inserted deliberately out of order above.
        const populated = rows.filter((r) => r.executions > 0).map((r) => r.date);
        expect(populated).toEqual([d1.key, d2.key, d3.key]);
      });
    });

    /**
     * The stats aggregations must not read `executions.success` as a health signal
     * (issue #325).
     *
     * `success = false` is written deliberately by two paths that did not fail:
     * `recordSkippedPhase` needs it so `shouldRunPhase` re-evaluates the node on
     * resume, and the runner needs it on a `ResourceQuota` rejection so the run
     * requeues. The column answers "may this phase be skipped on resume?", for
     * which skipped, quota-rejected and crashed are all correctly the same answer
     * — so the aggregations classify on `(success, stop_reason)` instead.
     */
    describe("execution outcome classification (issue #325)", () => {
      /** Write one finished execution with an explicit outcome shape. */
      async function exec(id: string, opts: { success?: boolean; stopReason?: string; skill?: string }) {
        await db.executions.recordStart({
          id,
          triggerType: "webhook",
          triggerId: "owner/repo#1",
          skill: opts.skill ?? "pr-review:review",
          owner: "owner",
          repo: "repo",
          issueNumber: 1,
          startedAt: new Date().toISOString(),
        });
        if (opts.success !== undefined) {
          await db.executions.recordFinish(id, { success: opts.success, stopReason: opts.stopReason });
        }
      }

      /** Today's bucket, which is where every row written by `exec` lands. */
      async function today() {
        const rows = await db.executions.dailyStats(1);
        expect(rows).toHaveLength(1);
        return rows[0]!;
      }

      it("counts a successful execution as succeeded", async () => {
        await exec("e-ok", { success: true, stopReason: "success" });

        expect(await today()).toMatchObject({ executions: 1, succeeded: 1, skipped: 0, deferred: 0, failed: 0 });
      });

      it("counts a cascade-skipped phase as skipped, not failed", async () => {
        await db.executions.recordSkippedPhase("pr-review:post-review", "owner/repo#1", "wfr-1", "repo", "owner");

        expect(await today()).toMatchObject({ executions: 1, succeeded: 0, skipped: 1, deferred: 0, failed: 0 });
      });

      it("counts a ResourceQuota rejection as deferred, not failed", async () => {
        await exec("e-quota", { success: false, stopReason: "error_quota" });

        expect(await today()).toMatchObject({ executions: 1, succeeded: 0, skipped: 0, deferred: 1, failed: 0 });
      });

      it("counts a real agent error as failed", async () => {
        await exec("e-fatal", { success: false, stopReason: "error_fatal" });

        expect(await today()).toMatchObject({ executions: 1, succeeded: 0, skipped: 0, deferred: 0, failed: 1 });
      });

      it("counts a failure with no stop reason as failed", async () => {
        await exec("e-null", { success: false });

        expect(await today()).toMatchObject({ executions: 1, failed: 1 });
      });

      it("counts an in-flight execution in the total but in no outcome bucket", async () => {
        await exec("e-running", {});

        expect(await today()).toMatchObject({ executions: 1, succeeded: 0, skipped: 0, deferred: 0, failed: 0 });
      });

      it("counts a generic-loop check that came back red as succeeded", async () => {
        // `condition_not_met` is stored `success = true` because the CHECK ran fine
        // — the loop simply isn't finished. It cost real tokens and really
        // executed, so it belongs in the green band; only its per-row rendering is
        // muted (`execMark` in packages/cli/src/cli-format.ts).
        await exec("e-unmet", { success: true, stopReason: "condition_not_met" });

        expect(await today()).toMatchObject({ executions: 1, succeeded: 1, failed: 0 });
      });

      it("classifies the same way in hourlyStats", async () => {
        await exec("e-ok", { success: true });
        await exec("e-quota", { success: false, stopReason: "error_quota" });
        await exec("e-fatal", { success: false, stopReason: "error_fatal" });
        await db.executions.recordSkippedPhase("pr-review:post-review", "owner/repo#1", "wfr-1", "repo", "owner");

        const hour = await db.executions.hourlyStats(1);
        expect(hour).toHaveLength(1);
        expect(hour[0]).toMatchObject({ executions: 4, succeeded: 1, skipped: 1, deferred: 1, failed: 1 });
      });

      it("classifies the same way in executionStats().by_skill", async () => {
        await exec("e-ok", { success: true, skill: "pr-review:review" });
        await exec("e-quota", { success: false, stopReason: "error_quota", skill: "pr-review:review" });
        await exec("e-fatal", { success: false, stopReason: "error_fatal", skill: "pr-review:review" });
        await db.executions.recordSkippedPhase("pr-review:review", "owner/repo#1", "wfr-1", "repo", "owner");

        const stats = await db.executions.executionStats();
        expect(stats.by_skill["pr-review:review"]).toMatchObject({
          count: 4,
          succeeded: 1,
          skipped: 1,
          deferred: 1,
          failed: 1,
        });
      });

      it("keeps a skipped phase re-runnable on resume", async () => {
        // The invariant a careless fix breaks: reclassifying must NOT reach for
        // `success = true`, because `shouldRunPhase` reads that column to decide
        // whether a phase is already done.
        await db.executions.recordSkippedPhase("pr-review:post-review", "owner/repo#1", "wfr-1", "repo", "owner");

        expect(await db.executions.shouldRunPhase("pr-review:post-review", "owner/repo#1", "wfr-1")).toBe("run");
        expect((await today()).skipped).toBe(1);
      });
    });

    /**
     * Every read that claims to return an `ExecutionRecord` must actually return
     * one (issue #285).
     *
     * The table is snake_case and the record is camelCase, so a `SELECT *` cast to
     * `ExecutionRecord[]` type-checks while leaving `issueNumber`, `startedAt` and
     * `workflowRunId` `undefined` — the compiler cannot see the difference and
     * neither could any test, because no test read those fields back. Three reads
     * had drifted that way: the Slack status report rendered `(started undefined)`
     * and the admin cancel loop filtered `runningExecutions()` on a `workflowRunId`
     * that matched no row.
     *
     * So this asserts the FIELDS, not the SQL: it writes one row through the store
     * and reads it back through each of the four record-returning paths.
     */
    describe("ExecutionStore — record-returning reads (issue #285)", () => {
      const startedAt = "2026-08-07T09:00:00.000Z";
      const row = {
        id: "e-1",
        triggerType: "webhook" as const,
        triggerId: "nearform/lastlight#42",
        triggeredBy: "cliftonc",
        triggerActorType: "github" as const,
        skill: "pr-review:review",
        owner: "nearform",
        repo: "lastlight",
        issueNumber: 42,
        startedAt,
        workflowRunId: "wfr-1",
      };

      beforeEach(async () => {
        await db.executions.recordStart(row);
      });

      // One assertion set, applied to every path — the point is that none of them
      // may answer differently.
      function expectFullRecord(rec: Awaited<ReturnType<typeof db.executions.allExecutions>>[number]) {
        expect(rec.id).toBe("e-1");
        expect(rec.triggerType).toBe("webhook");
        expect(rec.triggerId).toBe("nearform/lastlight#42");
        expect(rec.triggeredBy).toBe("cliftonc");
        expect(rec.triggerActorType).toBe("github");
        expect(rec.skill).toBe("pr-review:review");
        expect(rec.owner).toBe("nearform");
        expect(rec.repo).toBe("lastlight");
        // The three the snake_case cast silently dropped.
        expect(rec.issueNumber).toBe(42);
        expect(rec.startedAt).toBe(startedAt);
        expect(rec.workflowRunId).toBe("wfr-1");
      }

      it("allExecutions returns a populated record", async () => {
        const [rec] = await db.executions.allExecutions();
        expectFullRecord(rec);
      });

      it("runningExecutions returns a populated record", async () => {
        const [rec] = await db.executions.runningExecutions();
        expectFullRecord(rec);
      });

      it("recentExecutions returns a populated record", async () => {
        const [rec] = await db.executions.recentExecutions("pr-review:review");
        expectFullRecord(rec);
      });

      it("getExecutionsForWorkflowRun returns a populated record", async () => {
        const [rec] = await db.executions.getExecutionsForWorkflowRun(
          "wfr-1",
          "nearform/lastlight#42",
          "pr-review",
        );
        expectFullRecord(rec);
      });

      it("maps a finished row's optional columns, with success as a boolean", async () => {
        await db.executions.recordFinish("e-1", {
          success: true,
          turns: 7,
          durationMs: 1234,
          costUsd: 0.5,
        });
        const [rec] = await db.executions.allExecutions();
        expect(rec.success).toBe(true);
        expect(rec.finishedAt).toBeTruthy();
        expect(rec.turns).toBe(7);
        expect(rec.durationMs).toBe(1234);
        expect(rec.costUsd).toBe(0.5);
      });

      it("reads SQL NULLs back as undefined, not null", async () => {
        // A chat turn: no repo, no issue, no owning run.
        await db.executions.recordStart({
          id: "e-2",
          triggerType: "chat",
          triggerId: "slack:T1:C1:1.0",
          skill: "chat",
          startedAt: "2026-08-07T10:00:00.000Z",
        });
        const rec = (await db.executions.allExecutions()).find((r) => r.id === "e-2")!;
        expect(rec.owner).toBeUndefined();
        expect(rec.repo).toBeUndefined();
        expect(rec.issueNumber).toBeUndefined();
        expect(rec.workflowRunId).toBeUndefined();
        expect(rec.success).toBeUndefined();
        expect(rec.startedAt).toBe("2026-08-07T10:00:00.000Z");
      });

      it("returns the BARE repo, so a caller composes owner/repo itself (issue #279)", async () => {
        // The status report and the dashboard qualify at the display boundary; the
        // ledger keeps the split pair. A read that qualified here would hand a
        // `repo` back to Octokit's (owner, repo) pair as `nearform/lastlight`.
        const [rec] = await db.executions.runningExecutions();
        expect(rec.repo).toBe("lastlight");
        expect(rec.owner).toBe("nearform");
      });
    });
  });
}

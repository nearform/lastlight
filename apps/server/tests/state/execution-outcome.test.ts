import { describe, it, expect, beforeEach } from "vitest";
import { StateDb } from "#src/state/db.js";

/**
 * The stats aggregations must not read `executions.success` as a health signal
 * (issue #325).
 *
 * `success = 0` is written deliberately by two paths that did not fail:
 * `recordSkippedPhase` needs it so `shouldRunPhase` re-evaluates the node on
 * resume, and the runner needs it on a `ResourceQuota` rejection so the run
 * requeues. The column answers "may this phase be skipped on resume?", for
 * which skipped, quota-rejected and crashed are all correctly the same answer
 * — so the aggregations classify on `(success, stop_reason)` instead.
 */
describe("execution outcome classification (issue #325)", () => {
  let db: StateDb;

  /** Write one finished execution with an explicit outcome shape. */
  function exec(id: string, opts: { success?: boolean; stopReason?: string; skill?: string }) {
    db.executions.recordStart({
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
      db.executions.recordFinish(id, { success: opts.success, stopReason: opts.stopReason });
    }
  }

  /** Today's bucket, which is where every row written by `exec` lands. */
  function today() {
    const rows = db.executions.dailyStats(1);
    expect(rows).toHaveLength(1);
    return rows[0]!;
  }

  beforeEach(() => {
    db = new StateDb(":memory:");
  });

  it("counts a successful execution as succeeded", () => {
    exec("e-ok", { success: true, stopReason: "success" });

    expect(today()).toMatchObject({ executions: 1, succeeded: 1, skipped: 0, deferred: 0, failed: 0 });
  });

  it("counts a cascade-skipped phase as skipped, not failed", () => {
    db.executions.recordSkippedPhase("pr-review:post-review", "owner/repo#1", "wfr-1", "repo", "owner");

    expect(today()).toMatchObject({ executions: 1, succeeded: 0, skipped: 1, deferred: 0, failed: 0 });
  });

  it("counts a ResourceQuota rejection as deferred, not failed", () => {
    exec("e-quota", { success: false, stopReason: "error_quota" });

    expect(today()).toMatchObject({ executions: 1, succeeded: 0, skipped: 0, deferred: 1, failed: 0 });
  });

  it("counts a real agent error as failed", () => {
    exec("e-fatal", { success: false, stopReason: "error_fatal" });

    expect(today()).toMatchObject({ executions: 1, succeeded: 0, skipped: 0, deferred: 0, failed: 1 });
  });

  it("counts a failure with no stop reason as failed", () => {
    exec("e-null", { success: false });

    expect(today()).toMatchObject({ executions: 1, failed: 1 });
  });

  it("counts an in-flight execution in the total but in no outcome bucket", () => {
    exec("e-running", {});

    expect(today()).toMatchObject({ executions: 1, succeeded: 0, skipped: 0, deferred: 0, failed: 0 });
  });

  it("counts a generic-loop check that came back red as succeeded", () => {
    // `condition_not_met` is stored `success = 1` because the CHECK ran fine —
    // the loop simply isn't finished. It cost real tokens and really executed,
    // so it belongs in the green band; only its per-row rendering is muted
    // (`execMark` in packages/cli/src/cli-format.ts).
    exec("e-unmet", { success: true, stopReason: "condition_not_met" });

    expect(today()).toMatchObject({ executions: 1, succeeded: 1, failed: 0 });
  });

  it("classifies the same way in hourlyStats", () => {
    exec("e-ok", { success: true });
    exec("e-quota", { success: false, stopReason: "error_quota" });
    exec("e-fatal", { success: false, stopReason: "error_fatal" });
    db.executions.recordSkippedPhase("pr-review:post-review", "owner/repo#1", "wfr-1", "repo", "owner");

    const hour = db.executions.hourlyStats(1);
    expect(hour).toHaveLength(1);
    expect(hour[0]).toMatchObject({ executions: 4, succeeded: 1, skipped: 1, deferred: 1, failed: 1 });
  });

  it("classifies the same way in executionStats().by_skill", () => {
    exec("e-ok", { success: true, skill: "pr-review:review" });
    exec("e-quota", { success: false, stopReason: "error_quota", skill: "pr-review:review" });
    exec("e-fatal", { success: false, stopReason: "error_fatal", skill: "pr-review:review" });
    db.executions.recordSkippedPhase("pr-review:review", "owner/repo#1", "wfr-1", "repo", "owner");

    const stats = db.executions.executionStats();
    expect(stats.by_skill["pr-review:review"]).toMatchObject({
      count: 4,
      succeeded: 1,
      skipped: 1,
      deferred: 1,
      failed: 1,
    });
  });

  it("keeps a skipped phase re-runnable on resume", () => {
    // The invariant a careless fix breaks: reclassifying must NOT reach for
    // `success = 1`, because `shouldRunPhase` reads that column to decide
    // whether a phase is already done.
    db.executions.recordSkippedPhase("pr-review:post-review", "owner/repo#1", "wfr-1", "repo", "owner");

    expect(db.executions.shouldRunPhase("pr-review:post-review", "owner/repo#1", "wfr-1")).toBe("run");
    expect(today().skipped).toBe(1);
  });
});

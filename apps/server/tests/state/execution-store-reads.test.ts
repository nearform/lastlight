import { describe, it, expect, beforeEach } from "vitest";
import { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../helpers/state-db.js";

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
  let db: StateDb;

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
    db = await makeTestDb();
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

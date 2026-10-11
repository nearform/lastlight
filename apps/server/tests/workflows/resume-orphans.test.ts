/**
 * Boot-recovery tests for resumeOrphanedWorkflows — specifically that a run
 * left `queued` when the harness died is re-stamped (so the AdmissionController
 * promotes it) instead of being TTL-reaped to a non-retryable `cancelled`.
 *
 * Uses queued/paused runs only, so the running-orphan path (which would call
 * the heavy resumeSimpleRun) is never exercised.
 */
import { describe, it, expect, beforeEach } from "vitest";
import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../helpers/state-db.js";
import { resumeOrphanedWorkflows, resumeSimpleRun } from "#src/workflows/resume.js";
import type { ResumeOptions } from "#src/workflows/resume.js";

function makeResumeOpts(db: StateDb): ResumeOptions {
  return {
    db,
    github: null,
    config: {
      model: "test",
      maxTurns: 3,
      stateDir: "/tmp",
      sandboxDir: "/tmp",
      sessionsDir: "/tmp",
      sandbox: "none" as const,
      buildAssets: "repo" as const,
      buildAssetsDir: "/tmp",
    },
  };
}

describe("resumeOrphanedWorkflows — queued orphans", () => {
  let db: StateDb;

  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("re-stamps a stale queued orphan's clock so admission can promote it", async () => {
    const stale = new Date(Date.now() - 3_600_000).toISOString(); // 60 min ago
    await db.runs.createRun({
      id: "q1",
      workflowName: "explore",
      triggerId: "acme/widgets#1",
      currentPhase: "socratic",
      status: "queued",
      startedAt: stale,
    });

    await resumeOrphanedWorkflows(makeResumeOpts(db));

    const r = (await db.runs.getRun("q1"))!;
    // Still queued (not dropped to cancelled) with a fresh enqueue clock, so the
    // next admission sweep won't instantly TTL-expire it.
    expect(r.status).toBe("queued");
    expect(Date.parse(r.startedAt)).toBeGreaterThan(Date.parse(stale));
  });

  it("leaves paused runs untouched (they await human approval)", async () => {
    await db.runs.createRun({
      id: "p1",
      workflowName: "build",
      triggerId: "acme/widgets#2",
      currentPhase: "architect",
      status: "paused",
      startedAt: new Date().toISOString(),
    });

    await resumeOrphanedWorkflows(makeResumeOpts(db));

    expect((await db.runs.getRun("p1"))!.status).toBe("paused");
  });

  it("restores a run wrongly finished at an approval gate back to paused", async () => {
    const approval = { gate: "post_architect", summary: "plan ready", createdAt: new Date().toISOString() };
    for (const [id, pending] of [["stranded", true], ["answered", false]] as const) {
      await db.runs.createRun({
        id,
        workflowName: "build",
        triggerId: `acme/widgets#${id}`,
        currentPhase: "waiting_approval",
        status: "running",
        startedAt: new Date().toISOString(),
      });
      const approvalId = `${id}-approval`;
      await db.approvals.create({ ...approval, id: approvalId, workflowRunId: id });
      if (!pending) await db.approvals.respond(approvalId, "approved", "someone");
      await db.runs.finishRun(id, "succeeded");
    }

    await resumeOrphanedWorkflows(makeResumeOpts(db));

    const stranded = (await db.runs.getRun("stranded"))!;
    expect(stranded.status).toBe("paused");
    expect(stranded.finishedAt).toBeFalsy();
    // An answered approval means the run really moved on — never rewound.
    expect((await db.runs.getRun("answered"))!.status).toBe("succeeded");
  });
});

describe("resumeOrphanedWorkflows — runs another engine owns (rollback guard, #435)", () => {
  let db: StateDb;

  beforeEach(async () => {
    db = await makeTestDb();
  });

  it("leaves a newer engine's running and queued runs exactly as they were", async () => {
    const stale = new Date(Date.now() - 3_600_000).toISOString();
    for (const [id, status] of [["running-durable", "running"], ["queued-durable", "queued"]] as const) {
      await db.runs.createRun({
        id,
        workflowName: "build",
        triggerId: `acme/widgets#${id}`,
        currentPhase: "architect",
        status,
        startedAt: stale,
        engine: "durable",
      });
    }

    await resumeOrphanedWorkflows(makeResumeOpts(db));

    const running = (await db.runs.getRun("running-durable"))!;
    // Not resumed on this engine: no restart attempt counted, not failed.
    expect(running.status).toBe("running");
    expect(running.restartCount).toBe(0);
    const queued = (await db.runs.getRun("queued-durable"))!;
    expect(queued.status).toBe("queued");
    expect(queued.startedAt).toBe(stale);
  });

  it("resumeSimpleRun refuses a run another engine owns, even when handed one directly", async () => {
    await db.runs.createRun({
      id: "d1",
      workflowName: "build",
      triggerId: "acme/widgets#7",
      currentPhase: "architect",
      status: "running",
      startedAt: new Date().toISOString(),
      engine: "durable",
    });

    await resumeSimpleRun((await db.runs.getRun("d1"))!, makeResumeOpts(db));

    const r = (await db.runs.getRun("d1"))!;
    expect(r.status).toBe("running");
    expect(r.finishedAt).toBeUndefined();
  });
});

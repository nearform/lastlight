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
import { resumeOrphanedWorkflows } from "#src/workflows/resume.js";
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
});

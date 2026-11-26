/**
 * A run that hit a model provider's usage limit is requeued with `not_before`:
 * admission leaves it queued until then, and the queue-wait TTL counts from
 * then, not from the requeue.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("#src/workflows/resume.js", () => ({
  resumeSimpleRun: vi.fn(async () => {}),
  parseTriggerId: vi.fn(() => null),
  parseSlackTriggerId: vi.fn(() => null),
}));
vi.mock("#src/workflows/runner.js", () => ({
  runWorkflow: vi.fn(async () => ({ success: true, phases: [] })),
}));

import { createAdmissionController, nextNotBefore } from "#src/workflows/admission.js";
import type { StateDb } from "#src/state/db.js";
import type { ResumeOptions } from "#src/workflows/resume.js";
import { makeTestDb } from "../helpers/state-db.js";

const HOUR = 3_600_000;

function resumeOpts(db: StateDb): ResumeOptions {
  return {
    db,
    github: null,
    config: {
      model: "test",
      maxTurns: 3,
      stateDir: "/tmp",
      sandboxDir: "/tmp",
      sandboxDirs: undefined,
      sessionsDir: "/tmp",
      sandbox: "none" as const,
      buildAssets: "repo" as const,
      buildAssetsDir: "/tmp",
    } as never,
  };
}

async function waitingRun(db: StateDb, id: string, notBefore: string): Promise<void> {
  await db.runs.createRun({
    id,
    workflowName: "build",
    triggerId: `acme/widgets#${id.slice(-2)}`,
    currentPhase: "architect",
    status: "running",
    startedAt: new Date().toISOString(),
  });
  expect(await db.runs.requeueRunning(id, { notBefore })).toBe(1);
}

describe("nextNotBefore", () => {
  const now = new Date("2026-11-04T12:00:00.000Z");
  it("floors not_before", () => {
    expect(nextNotBefore("2026-11-04T11:59:00.000Z", now)).toBe("2026-11-04T12:05:00.000Z");
    expect(nextNotBefore(null, now)).toBe("2026-11-04T13:00:00.000Z");
    expect(nextNotBefore("2026-11-04T15:00:00.000Z", now)).toBe("2026-11-04T15:00:00.000Z");
    expect(nextNotBefore("not a date", now)).toBe("2026-11-04T13:00:00.000Z");
    // a reset parsed from transcript text never parks a run past the longest (weekly) window
    expect(nextNotBefore("2099-12-31T00:00:00.000Z", now)).toBe("2026-11-11T12:00:00.000Z");
  });
});

describe("admission with not_before", () => {
  let db: StateDb;
  beforeEach(async () => {
    db = await makeTestDb();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
  });

  const ctrl = (maxQueueWaitMs = 1_800_000) =>
    createAdmissionController({ db, resumeOpts: resumeOpts(db), maxWorkflows: 4, maxQueueWaitMs });

  it("does not promote a run before not_before, and promotes it after", async () => {
    await waitingRun(db, "run-w1", new Date(Date.now() + HOUR).toISOString());
    await ctrl().admitNext();
    expect((await db.runs.getRun("run-w1"))!.status).toBe("queued");

    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + HOUR + 1000);
    await ctrl().admitNext();
    expect((await db.runs.getRun("run-w1"))!.status).toBe("running");
  });

  it("a waiting run does not block a runnable one behind it", async () => {
    await waitingRun(db, "run-w2", new Date(Date.now() + HOUR).toISOString());
    await db.runs.createRun({
      id: "run-r3",
      workflowName: "build",
      triggerId: "acme/widgets#r3",
      currentPhase: "architect",
      status: "queued",
      startedAt: new Date(Date.now() + 1000).toISOString(),
    });
    await ctrl().admitNext();
    expect((await db.runs.getRun("run-w2"))!.status).toBe("queued");
    expect((await db.runs.getRun("run-r3"))!.status).toBe("running");
  });

  it("a cancelled waiting run is not promoted", async () => {
    await waitingRun(db, "run-w4", new Date(Date.now() - 1000).toISOString());
    expect(await db.runs.cancelRun("run-w4")).toBe(true);
    await ctrl().admitNext();
    expect((await db.runs.getRun("run-w4"))!.status).toBe("cancelled");
  });

  it("is not expired by maxQueueWaitMs before not_before + maxQueueWaitMs", async () => {
    await waitingRun(db, "run-w5", new Date(Date.now() + 3 * HOUR).toISOString());
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 2 * HOUR); // well past the 30 min TTL from the requeue
    await ctrl().sweep();
    expect((await db.runs.getRun("run-w5"))!.status).toBe("queued");

    vi.setSystemTime(Date.now() + HOUR + 31 * 60_000); // past not_before + 30 min, and blocked from admit by cap 0
    await createAdmissionController({ db, resumeOpts: resumeOpts(db), maxWorkflows: 0, maxQueueWaitMs: 1_800_000 }).sweep();
    expect((await db.runs.getRun("run-w5"))!.status).toBe("cancelled");
  });
});

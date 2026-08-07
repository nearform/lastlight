/**
 * Admission controller tests (#172).
 * Uses an in-memory DB and a stubbed resumeSimpleRun.
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

import { createAdmissionController, K8S_SANITY_FUSE } from "#src/workflows/admission.js";
import { StateDb } from "#src/state/db.js";
import { resumeSimpleRun } from "#src/workflows/resume.js";
import type { ResumeOptions } from "#src/workflows/resume.js";

const mockResumeSimpleRun = vi.mocked(resumeSimpleRun);

function makeDb(): StateDb {
  return new StateDb(":memory:");
}

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

function makeQueuedRun(db: StateDb, id: string, startedAt: string): void {
  db.runs.createRun({
    id,
    workflowName: "explore",
    triggerId: `acme/widgets#${id.slice(-2)}`,
    currentPhase: "socratic",
    status: "queued",
    startedAt,
  });
}

/**
 * A queued GitHub-triggered run that left an enqueue ack behind — the shape
 * `simple.ts` persists when it posts the "…is queued" comment (#244).
 */
function makeQueuedRunWithAck(
  db: StateDb,
  id: string,
  startedAt: string,
  commentId: number,
): void {
  db.runs.createRun({
    id,
    workflowName: "issue-triage",
    triggerId: `acme/widgets#${id.slice(-2)}`,
    owner: "acme",
    repo: "widgets",
    issueNumber: 215,
    currentPhase: "triage",
    status: "queued",
    startedAt,
  });
  db.runs.mergeScratch(id, { queuedAck: { commentId } });
}

/**
 * The same run, but written the way a process that predates the #279 backfill
 * wrote it: the qualified `owner/repo` in the `repo` column. Raw SQL, because
 * `createRun` now normalizes that shape away — which is the point.
 *
 * Octokit takes `(owner, repo)` positionally with no normalization of its own,
 * so a row like this reaching `deleteComment` unsplit would address
 * `/repos/acme/acme%2Fwidgets/...`.
 */
function makeLegacyQueuedRunWithAck(
  db: StateDb,
  id: string,
  startedAt: string,
  commentId: number,
): void {
  db.database
    .prepare(
      `INSERT INTO workflow_runs (id, workflow_name, trigger_id, owner, repo, issue_number, current_phase, status, started_at, updated_at)
       VALUES (?, 'issue-triage', ?, NULL, 'acme/widgets', 215, 'triage', 'queued', ?, ?)`,
    )
    .run(id, `acme/widgets#${id.slice(-2)}`, startedAt, startedAt);
  db.runs.mergeScratch(id, { queuedAck: { commentId } });
}

function makeGithubStub() {
  return {
    postComment: vi.fn(async () => 1),
    updateComment: vi.fn(async () => {}),
    deleteComment: vi.fn(async () => {}),
  };
}

function makeRunningRun(db: StateDb, id: string): void {
  db.runs.createRun({
    id,
    workflowName: "build",
    triggerId: `acme/widgets#${id.slice(-2)}`,
    currentPhase: "architect",
    status: "running",
    startedAt: new Date().toISOString(),
  });
}

describe("createAdmissionController", () => {
  let db: StateDb;

  beforeEach(() => {
    db = makeDb();
    mockResumeSimpleRun.mockResolvedValue(undefined);
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  it("admitNext: does nothing when no queued runs exist", async () => {
    const ctrl = createAdmissionController({
      db,
      resumeOpts: makeResumeOpts(db),
      maxWorkflows: 4,
      maxQueueWaitMs: 1_800_000,
    });
    await ctrl.admitNext();
    expect(mockResumeSimpleRun).not.toHaveBeenCalled();
  });

  it("admitNext: promotes a queued run to running when under cap", async () => {
    makeQueuedRun(db, "run-01", "2024-01-01T00:00:00.000Z");

    const ctrl = createAdmissionController({
      db,
      resumeOpts: makeResumeOpts(db),
      maxWorkflows: 4,
      maxQueueWaitMs: 1_800_000,
    });
    await ctrl.admitNext();

    // CAS should have changed the row to running
    expect(db.runs.getRun("run-01")!.status).toBe("running");
    // resumeSimpleRun called in background - may be async, wait a tick
    await new Promise((r) => setTimeout(r, 10));
    expect(mockResumeSimpleRun).toHaveBeenCalledOnce();
  });

  it("admitNext: admits multiple runs up to the cap", async () => {
    makeQueuedRun(db, "run-01", "2024-01-01T00:00:00.000Z");
    makeQueuedRun(db, "run-02", "2024-01-01T00:01:00.000Z");
    makeQueuedRun(db, "run-03", "2024-01-01T00:02:00.000Z");

    const ctrl = createAdmissionController({
      db,
      resumeOpts: makeResumeOpts(db),
      maxWorkflows: 2,
      maxQueueWaitMs: 1_800_000,
    });
    await ctrl.admitNext();
    await new Promise((r) => setTimeout(r, 10));

    // Only 2 should have been admitted (cap = 2)
    expect(db.runs.getRun("run-01")!.status).toBe("running");
    expect(db.runs.getRun("run-02")!.status).toBe("running");
    expect(db.runs.getRun("run-03")!.status).toBe("queued"); // still waiting
    expect(mockResumeSimpleRun).toHaveBeenCalledTimes(2);
  });

  it("admitNext: FIFO order — oldest run is admitted first", async () => {
    makeQueuedRun(db, "run-late", "2024-01-01T00:05:00.000Z");
    makeQueuedRun(db, "run-early", "2024-01-01T00:00:00.000Z");

    const ctrl = createAdmissionController({
      db,
      resumeOpts: makeResumeOpts(db),
      maxWorkflows: 1,
      maxQueueWaitMs: 1_800_000,
    });
    await ctrl.admitNext();
    await new Promise((r) => setTimeout(r, 10));

    expect(db.runs.getRun("run-early")!.status).toBe("running");
    expect(db.runs.getRun("run-late")!.status).toBe("queued");
    const call = mockResumeSimpleRun.mock.calls[0];
    expect((call[0] as { id: string }).id).toBe("run-early");
  });

  it("admitNext: does not admit when at or over cap", async () => {
    // Create running runs to fill the cap
    db.runs.createRun({
      id: "running-1",
      workflowName: "build",
      triggerId: "acme/widgets#100",
      currentPhase: "architect",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    makeQueuedRun(db, "run-01", "2024-01-01T00:00:00.000Z");

    const ctrl = createAdmissionController({
      db,
      resumeOpts: makeResumeOpts(db),
      maxWorkflows: 1,
      maxQueueWaitMs: 1_800_000,
    });
    await ctrl.admitNext();

    expect(db.runs.getRun("run-01")!.status).toBe("queued"); // still waiting
    expect(mockResumeSimpleRun).not.toHaveBeenCalled();
  });

  it("sweep: expires queued runs older than maxQueueWaitMs", async () => {
    // A run enqueued 1 hour ago (3600000 ms)
    const oldTime = new Date(Date.now() - 3_600_000).toISOString();
    makeQueuedRun(db, "stale-run", oldTime);

    const ctrl = createAdmissionController({
      db,
      resumeOpts: makeResumeOpts(db),
      maxWorkflows: 4,
      maxQueueWaitMs: 1_800_000, // 30 min — stale-run is 60 min old
    });
    await ctrl.sweep();

    const run = db.runs.getRun("stale-run")!;
    expect(run.status).toBe("cancelled");
    expect(run.context?.error).toMatch(/waiting too long/);
  });

  it("sweep: does not expire a recently queued run", async () => {
    const recentTime = new Date(Date.now() - 60_000).toISOString(); // 1 min ago
    makeQueuedRun(db, "fresh-run", recentTime);
    // Fill the cap so admitNext won't promote it
    db.runs.createRun({
      id: "blocker",
      workflowName: "build",
      triggerId: "acme/widgets#999",
      currentPhase: "architect",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const ctrl = createAdmissionController({
      db,
      resumeOpts: makeResumeOpts(db),
      maxWorkflows: 1, // cap = 1, blocker holds the slot
      maxQueueWaitMs: 1_800_000,
    });
    await ctrl.sweep();

    // Should still be queued — not expired (it's only 1 min old)
    expect(db.runs.getRun("fresh-run")!.status).toBe("queued");
  });

  it("sweep: expires a github-triggered run WITHOUT posting a PR comment", async () => {
    // The "dropped from queue" comment used to flood dependency PRs on every
    // TTL expiry. Expiry must still transition the row (visible in the
    // dashboard + retryable) but post nothing to GitHub.
    const oldTime = new Date(Date.now() - 3_600_000).toISOString();
    makeQueuedRun(db, "gh-stale", oldTime); // triggerId acme/widgets#le
    const postComment = vi.fn(async () => {});
    const resumeOpts = { ...makeResumeOpts(db), github: { postComment } as any };

    const ctrl = createAdmissionController({
      db,
      resumeOpts,
      maxWorkflows: 4,
      maxQueueWaitMs: 1_800_000,
    });
    await ctrl.sweep();

    expect(db.runs.getRun("gh-stale")!.status).toBe("cancelled");
    expect(postComment).not.toHaveBeenCalled();
  });

  // ── enqueue-ack lifecycle (issue #244) ──────────────────────────────────
  //
  // The ack promises "it'll start automatically when a slot frees", so it must
  // not survive the run leaving the queue — otherwise a run that starts and
  // then legitimately no-ops leaves that comment as its only visible trace.

  it("admitNext: deletes the enqueue ack once the run is admitted", async () => {
    makeQueuedRunWithAck(db, "run-ack", "2024-01-01T00:00:00.000Z", 5060108290);
    const github = makeGithubStub();

    const ctrl = createAdmissionController({
      db,
      resumeOpts: { ...makeResumeOpts(db), github: github as never },
      maxWorkflows: 4,
      maxQueueWaitMs: 1_800_000,
    });
    await ctrl.admitNext();
    await new Promise((r) => setTimeout(r, 10));

    expect(db.runs.getRun("run-ack")!.status).toBe("running");
    expect(github.deleteComment).toHaveBeenCalledWith("acme", "widgets", 5060108290);
    // Retracted, not rewritten — the run's own output is the real answer now.
    expect(github.updateComment).not.toHaveBeenCalled();
  });

  it("admitNext: passes Octokit the BARE repo even for a legacy qualified row", async () => {
    // The sharp edge of #279. This code path hands `(run.owner, run.repo)`
    // straight to Octokit with no split of its own — correct only because the
    // store normalizes on read-back. Without that shim this would call
    // `deleteComment("", "acme/widgets", …)`.
    makeLegacyQueuedRunWithAck(db, "run-legacy", "2024-01-01T00:00:00.000Z", 5060108290);
    const github = makeGithubStub();

    const ctrl = createAdmissionController({
      db,
      resumeOpts: { ...makeResumeOpts(db), github: github as never },
      maxWorkflows: 4,
      maxQueueWaitMs: 1_800_000,
    });
    await ctrl.admitNext();
    await new Promise((r) => setTimeout(r, 10));

    expect(github.deleteComment).toHaveBeenCalledWith("acme", "widgets", 5060108290);
  });

  it("sweep: rewrites a legacy qualified row's ack against the BARE repo", async () => {
    // The updateComment twin of the above — the other Octokit call reachable
    // from a stored repo identifier.
    const oldTime = new Date(Date.now() - 3_600_000).toISOString();
    makeLegacyQueuedRunWithAck(db, "gh-legacy-stale", oldTime, 777);
    const github = makeGithubStub();

    const ctrl = createAdmissionController({
      db,
      resumeOpts: { ...makeResumeOpts(db), github: github as never },
      maxWorkflows: 4,
      maxQueueWaitMs: 1_800_000,
    });
    await ctrl.sweep();
    await new Promise((r) => setTimeout(r, 10));

    const [owner, repo] = github.updateComment.mock.calls[0] as unknown as [string, string];
    expect([owner, repo]).toEqual(["acme", "widgets"]);
  });

  it("admitNext: admits normally when no ack was recorded (Slack / failed post)", async () => {
    makeQueuedRun(db, "run-noack", "2024-01-01T00:00:00.000Z");
    const github = makeGithubStub();

    const ctrl = createAdmissionController({
      db,
      resumeOpts: { ...makeResumeOpts(db), github: github as never },
      maxWorkflows: 4,
      maxQueueWaitMs: 1_800_000,
    });
    await ctrl.admitNext();
    await new Promise((r) => setTimeout(r, 10));

    expect(db.runs.getRun("run-noack")!.status).toBe("running");
    expect(github.deleteComment).not.toHaveBeenCalled();
  });

  it("admitNext: a failing retract does not block the run from dispatching", async () => {
    makeQueuedRunWithAck(db, "run-boom", "2024-01-01T00:00:00.000Z", 42);
    const github = makeGithubStub();
    github.deleteComment.mockRejectedValue(new Error("404 comment gone"));

    const ctrl = createAdmissionController({
      db,
      resumeOpts: { ...makeResumeOpts(db), github: github as never },
      maxWorkflows: 4,
      maxQueueWaitMs: 1_800_000,
    });
    await ctrl.admitNext();
    await new Promise((r) => setTimeout(r, 10));

    expect(db.runs.getRun("run-boom")!.status).toBe("running");
    expect(mockResumeSimpleRun).toHaveBeenCalledOnce();
  });

  it("sweep: rewrites the stale ack IN PLACE on TTL expiry rather than posting anew", async () => {
    const oldTime = new Date(Date.now() - 3_600_000).toISOString();
    makeQueuedRunWithAck(db, "gh-ack-stale", oldTime, 777);
    const github = makeGithubStub();

    const ctrl = createAdmissionController({
      db,
      resumeOpts: { ...makeResumeOpts(db), github: github as never },
      maxWorkflows: 4,
      maxQueueWaitMs: 1_800_000,
    });
    await ctrl.sweep();
    await new Promise((r) => setTimeout(r, 10));

    expect(db.runs.getRun("gh-ack-stale")!.status).toBe("cancelled");
    expect(github.updateComment).toHaveBeenCalledOnce();
    const [owner, repo, commentId, body] = github.updateComment.mock.calls[0] as unknown as [
      string,
      string,
      number,
      string,
    ];
    expect([owner, repo, commentId]).toEqual(["acme", "widgets", 777]);
    expect(body).toMatch(/waiting too long/);
    // Editing an existing comment, never adding one — that was the noise source.
    expect(github.postComment).not.toHaveBeenCalled();
  });

  it("start/stop: can start the interval and stop it without throwing", () => {
    const ctrl = createAdmissionController({
      db,
      resumeOpts: makeResumeOpts(db),
      maxWorkflows: 4,
      maxQueueWaitMs: 1_800_000,
      sweepIntervalMs: 60_000,
    });
    ctrl.start();
    ctrl.stop(); // should not throw
  });

  it("backpressure mode promotes at most one queued run per admitNext", async () => {
    makeQueuedRun(db, "run-01", "2024-01-01T00:00:00.000Z");
    makeQueuedRun(db, "run-02", "2024-01-01T00:01:00.000Z");
    makeQueuedRun(db, "run-03", "2024-01-01T00:02:00.000Z");

    const ctrl = createAdmissionController({
      db,
      resumeOpts: makeResumeOpts(db),
      maxWorkflows: 1,
      maxQueueWaitMs: 60_000,
      backpressureMode: true,
    });
    await ctrl.admitNext();

    expect(db.runs.countRunning()).toBe(1); // only ONE promoted despite 3 queued
  });

  it("default mode still fills up to maxWorkflows", async () => {
    makeQueuedRun(db, "run-01", "2024-01-01T00:00:00.000Z");
    makeQueuedRun(db, "run-02", "2024-01-01T00:01:00.000Z");
    makeQueuedRun(db, "run-03", "2024-01-01T00:02:00.000Z");

    const ctrl = createAdmissionController({
      db,
      resumeOpts: makeResumeOpts(db),
      maxWorkflows: 2,
      maxQueueWaitMs: 60_000,
      // backpressureMode omitted
    });
    await ctrl.admitNext();

    expect(db.runs.countRunning()).toBe(2);
  });

  it("backpressure mode gates on the sanity fuse, not maxWorkflows", async () => {
    // maxWorkflows=1 with one already running would block default mode;
    // backpressure mode admits because countRunning (1) < K8S_SANITY_FUSE.
    makeRunningRun(db, "running-1");
    makeQueuedRun(db, "run-01", "2024-01-01T00:00:00.000Z");

    const ctrl = createAdmissionController({
      db,
      resumeOpts: makeResumeOpts(db),
      maxWorkflows: 1,
      maxQueueWaitMs: 60_000,
      backpressureMode: true,
    });
    await ctrl.admitNext();

    expect(db.runs.countRunning()).toBe(2);
    expect(K8S_SANITY_FUSE).toBeGreaterThan(100);
  });
});

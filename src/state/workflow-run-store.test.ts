import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { randomUUID } from "crypto";
import { StateDb } from "./db.js";
import { migrate } from "./migrate.js";
import { ApprovalStore } from "./approval-store.js";
import { WorkflowRunStore } from "./workflow-run-store.js";

let db: StateDb;

beforeEach(() => {
  db = new StateDb(":memory:");
});

afterEach(() => {
  db.close();
});

/** Create a fresh run and return its id. */
function makeRun(overrides: Partial<Parameters<WorkflowRunStore["createRun"]>[0]> = {}): string {
  const id = randomUUID();
  db.runs.createRun({
    id,
    workflowName: "explore",
    triggerId: `slack:${id}`,
    currentPhase: "socratic",
    status: "running",
    startedAt: new Date().toISOString(),
    ...overrides,
  });
  return id;
}

describe("pauseForApproval", () => {
  it("creates the approval, appends the marker, merges scratch, and pauses — in one step", () => {
    const runId = makeRun();
    const approvalId = randomUUID();
    db.runs.pauseForApproval(
      runId,
      {
        id: approvalId,
        workflowRunId: runId,
        gate: "post_architect",
        summary: "Plan ready",
        kind: "approve",
        createdAt: new Date().toISOString(),
      },
      { phase: "waiting_approval", summary: "Waiting for approval: post_architect" },
      { socratic: { iteration: 2 } },
    );

    const run = db.runs.getRun(runId);
    expect(run!.status).toBe("paused");
    expect(run!.currentPhase).toBe("waiting_approval");
    expect(run!.phaseHistory.at(-1)!.phase).toBe("waiting_approval");
    expect(run!.scratch).toEqual({ socratic: { iteration: 2 } });

    const approval = db.approvals.getById(approvalId);
    expect(approval!.status).toBe("pending");
    expect(approval!.gate).toBe("post_architect");
  });

  it("rolls back the phase-history append when the approval store throws (injected collaborator)", () => {
    // Build a store stack on a raw shared connection so we can inject a fake
    // ApprovalStore whose create() throws as the last txn step.
    const raw = new Database(":memory:");
    migrate(raw);
    const realApprovals = new ApprovalStore(raw);
    const seed = new WorkflowRunStore(raw, { approvals: realApprovals });
    const runId = randomUUID();
    seed.createRun({
      id: runId,
      workflowName: "build",
      triggerId: "owner/repo#1",
      currentPhase: "architect",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const throwingApprovals = {
      create() {
        throw new Error("approval insert failed");
      },
    } as unknown as ApprovalStore;
    const runs = new WorkflowRunStore(raw, { approvals: throwingApprovals });

    expect(() =>
      runs.pauseForApproval(
        runId,
        {
          id: randomUUID(),
          workflowRunId: runId,
          gate: "post_architect",
          summary: "Plan ready",
          createdAt: new Date().toISOString(),
        },
        { phase: "waiting_approval" },
      ),
    ).toThrow("approval insert failed");

    // The appendPhase that ran before the throwing collaborator must be rolled
    // back: the run is still running with empty phase history.
    const run = seed.getRun(runId);
    expect(run!.status).toBe("running");
    expect(run!.phaseHistory).toEqual([]);
    raw.close();
  });
});

describe("finishRun with a terminal marker", () => {
  it("appends the on_success phase marker and flips status in one step", () => {
    const runId = makeRun();
    db.runs.finishRun(runId, "succeeded", { terminalMarker: { phase: "done", summary: "PR #5" } });

    const run = db.runs.getRun(runId);
    expect(run!.status).toBe("succeeded");
    expect(run!.finishedAt).toBeTruthy();
    expect(run!.currentPhase).toBe("done");
    const last = run!.phaseHistory.at(-1)!;
    expect(last.phase).toBe("done");
    expect(last.summary).toBe("PR #5");
    expect(last.success).toBe(true);
  });

  it("plain finish (no marker) flips status without touching phase history", () => {
    const runId = makeRun();
    db.runs.finishRun(runId, "failed", { error: "boom" });

    const run = db.runs.getRun(runId);
    expect(run!.status).toBe("failed");
    expect(run!.phaseHistory).toEqual([]);
    expect(run!.context).toEqual({ error: "boom" });
  });
});

describe("resolveGateAndResume — approve path", () => {
  it("approves the gate and sets the run running, returning the run", () => {
    const runId = makeRun({ status: "paused" });
    const approvalId = randomUUID();
    db.approvals.create({
      id: approvalId,
      workflowRunId: runId,
      gate: "post_architect",
      summary: "Plan ready",
      createdAt: new Date().toISOString(),
    });

    const run = db.runs.resolveGateAndResume(approvalId, "bob");

    expect(run!.id).toBe(runId);
    expect(run!.status).toBe("running");
    const approval = db.approvals.getById(approvalId);
    expect(approval!.status).toBe("approved");
    expect(approval!.respondedBy).toBe("bob");
  });

  it("throws on an unknown approval id", () => {
    expect(() => db.runs.resolveGateAndResume("no-such-approval", "bob")).toThrow();
  });

  it("does not resume a stale approval that was already resolved", () => {
    const runId = makeRun({ status: "paused" });
    const approvalId = randomUUID();
    db.approvals.create({
      id: approvalId,
      workflowRunId: runId,
      gate: "post_architect",
      summary: "Plan ready",
      createdAt: new Date().toISOString(),
    });

    db.runs.resolveGateAndFail(approvalId, "carol", "plan incomplete");

    expect(() => db.runs.resolveGateAndResume(approvalId, "bob")).toThrow("not pending");
    expect(db.runs.getRun(runId)!.status).toBe("failed");
    expect(db.approvals.getById(approvalId)!.status).toBe("rejected");
  });
});

describe("resolveGateAndFail — reject path", () => {
  it("does not fail a stale approval that was already approved", () => {
    const runId = makeRun({ status: "paused" });
    const approvalId = randomUUID();
    db.approvals.create({
      id: approvalId,
      workflowRunId: runId,
      gate: "post_architect",
      summary: "Plan ready",
      createdAt: new Date().toISOString(),
    });

    db.runs.resolveGateAndResume(approvalId, "bob");

    expect(() => db.runs.resolveGateAndFail(approvalId, "carol", "too late")).toThrow("not pending");
    expect(db.runs.getRun(runId)!.status).toBe("running");
    expect(db.approvals.getById(approvalId)!.status).toBe("approved");
  });

  it("rejects the gate and fails the run", () => {
    const runId = makeRun({ status: "paused" });
    const approvalId = randomUUID();
    db.approvals.create({
      id: approvalId,
      workflowRunId: runId,
      gate: "post_architect",
      summary: "Plan ready",
      createdAt: new Date().toISOString(),
    });

    const run = db.runs.resolveGateAndFail(approvalId, "carol", "plan incomplete");

    expect(run!.id).toBe(runId);
    expect(run!.status).toBe("failed");
    const approval = db.approvals.getById(approvalId);
    expect(approval!.status).toBe("rejected");
    expect(approval!.respondedBy).toBe("carol");
    expect(approval!.response).toBe("plan incomplete");
    expect(db.runs.getRun(runId)!.context).toEqual({ error: "Rejected: plan incomplete" });
  });

  it("records a fallback error annotation when rejection has no reason", () => {
    const runId = makeRun({ status: "paused" });
    const approvalId = randomUUID();
    db.approvals.create({
      id: approvalId,
      workflowRunId: runId,
      gate: "post_architect",
      summary: "Plan ready",
      createdAt: new Date().toISOString(),
    });

    const run = db.runs.resolveGateAndFail(approvalId, "carol");

    expect(run!.status).toBe("failed");
    expect(run!.context).toEqual({ error: "Rejected: no reason given" });
  });
});

describe("resolveReplyGateAndResume — the socratic explore-reply atomic op", () => {
  it("resolves the reply gate, merges scratch, and sets the run running in one step", () => {
    const runId = makeRun({ status: "paused" });
    const approvalId = randomUUID();
    db.approvals.create({
      id: approvalId,
      workflowRunId: runId,
      gate: "socratic_1",
      summary: "What problem are we solving?",
      kind: "reply",
      createdAt: new Date().toISOString(),
    });

    const scratchPatch = { socratic: { qa: [{ question: "Q1", answer: "A1" }] } };
    const run = db.runs.resolveReplyGateAndResume(runId, approvalId, "A1", "alice", scratchPatch);

    // Returns the resumed run
    expect(run).not.toBeNull();
    expect(run!.id).toBe(runId);
    expect(run!.status).toBe("running");

    // Gate resolved with the reply text recorded
    const approval = db.approvals.getById(approvalId);
    expect(approval!.status).toBe("approved");
    expect(approval!.response).toBe("A1");
    expect(approval!.respondedBy).toBe("alice");

    // Scratch merged
    const reloaded = db.runs.getRun(runId);
    expect(reloaded!.status).toBe("running");
    expect(reloaded!.scratch).toEqual(scratchPatch);
  });

  it("double-reply concurrency guard: a second resolve throws and leaves the run paused", () => {
    const runId = makeRun({ status: "paused" });
    const approvalId = randomUUID();
    db.approvals.create({
      id: approvalId,
      workflowRunId: runId,
      gate: "socratic_1",
      summary: "Q",
      kind: "reply",
      createdAt: new Date().toISOString(),
    });

    db.runs.resolveReplyGateAndResume(runId, approvalId, "first", "alice", {});
    db.runs.setPaused(runId); // pretend it paused again on the next iteration

    // A racing second reply against the already-resolved gate must not resume.
    expect(() =>
      db.runs.resolveReplyGateAndResume(runId, approvalId, "second", "bob", {}),
    ).toThrow();
    expect(db.runs.getRun(runId)!.status).toBe("paused");
  });

  it("rolls back the gate resolution when the scratch patch is not serializable", () => {
    const runId = makeRun({ status: "paused" });
    const approvalId = randomUUID();
    db.approvals.create({
      id: approvalId,
      workflowRunId: runId,
      gate: "socratic_1",
      summary: "Q",
      kind: "reply",
      createdAt: new Date().toISOString(),
    });

    // A BigInt makes JSON.stringify throw mid-transaction (natural poison input).
    const poison = { socratic: { n: BigInt(1) } } as unknown as Record<string, unknown>;
    expect(() =>
      db.runs.resolveReplyGateAndResume(runId, approvalId, "A1", "alice", poison),
    ).toThrow();

    // Nothing applied: gate still pending, run still paused, scratch untouched.
    expect(db.approvals.getById(approvalId)!.status).toBe("pending");
    const reloaded = db.runs.getRun(runId);
    expect(reloaded!.status).toBe("paused");
    expect(reloaded!.scratch).toBeUndefined();
  });
});

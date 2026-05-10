import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { StateDb } from "./db.js";
import { randomUUID } from "crypto";

let db: StateDb;

beforeEach(() => {
  db = new StateDb(":memory:");
});

afterEach(() => {
  db.close();
});

describe("workflow_runs CRUD", () => {
  it("creates a workflow run and retrieves it by ID", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#1",
      repo: "repo",
      issueNumber: 1,
      currentPhase: "phase_0",
      status: "running",
      context: { branch: "lastlight/1-test" },
      startedAt: now,
      finishedAt: undefined,
    });

    const run = db.getWorkflowRun(id);
    expect(run).not.toBeNull();
    expect(run!.id).toBe(id);
    expect(run!.workflowName).toBe("build");
    expect(run!.triggerId).toBe("owner/repo#1");
    expect(run!.repo).toBe("repo");
    expect(run!.issueNumber).toBe(1);
    expect(run!.currentPhase).toBe("phase_0");
    expect(run!.status).toBe("running");
    expect(run!.phaseHistory).toEqual([]);
    expect(run!.context).toEqual({ branch: "lastlight/1-test" });
  });

  it("returns null for a non-existent ID", () => {
    expect(db.getWorkflowRun("no-such-id")).toBeNull();
  });

  it("updates phase and appends to phase_history", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#2",
      currentPhase: "phase_0",
      status: "running",
      startedAt: now,
    });

    const entry = { phase: "guardrails", timestamp: new Date().toISOString(), success: true, summary: "READY" };
    db.updateWorkflowPhase(id, "guardrails", entry);

    const run = db.getWorkflowRun(id);
    expect(run!.currentPhase).toBe("guardrails");
    expect(run!.phaseHistory).toHaveLength(1);
    expect(run!.phaseHistory[0]).toEqual(entry);
  });

  it("appends multiple phase history entries", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#3",
      currentPhase: "phase_0",
      status: "running",
      startedAt: now,
    });

    db.updateWorkflowPhase(id, "guardrails", { phase: "guardrails", timestamp: now, success: true });
    db.updateWorkflowPhase(id, "architect", { phase: "architect", timestamp: now, success: true });
    db.updateWorkflowPhase(id, "executor", { phase: "executor", timestamp: now, success: true });

    const run = db.getWorkflowRun(id);
    expect(run!.currentPhase).toBe("executor");
    expect(run!.phaseHistory).toHaveLength(3);
    expect(run!.phaseHistory.map((e) => e.phase)).toEqual(["guardrails", "architect", "executor"]);
  });

  it("finishes a workflow run with succeeded status", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#4",
      currentPhase: "executor",
      status: "running",
      startedAt: now,
    });

    db.finishWorkflowRun(id, "succeeded");
    const run = db.getWorkflowRun(id);
    expect(run!.status).toBe("succeeded");
    expect(run!.finishedAt).toBeTruthy();
  });

  it("finishes a workflow run with failed status", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#5",
      currentPhase: "architect",
      status: "running",
      startedAt: now,
    });

    db.finishWorkflowRun(id, "failed", "some error");
    const run = db.getWorkflowRun(id);
    expect(run!.status).toBe("failed");
    expect(run!.finishedAt).toBeTruthy();
  });
});

describe("getWorkflowRunByTrigger", () => {
  it("returns the active run for a trigger", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#10",
      currentPhase: "executor",
      status: "running",
      startedAt: now,
    });

    const run = db.getWorkflowRunByTrigger("owner/repo#10");
    expect(run).not.toBeNull();
    expect(run!.id).toBe(id);
  });

  it("ignores failed or succeeded runs", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#11",
      currentPhase: "executor",
      status: "running",
      startedAt: now,
    });
    db.finishWorkflowRun(id, "failed");

    expect(db.getWorkflowRunByTrigger("owner/repo#11")).toBeNull();
  });

  it("returns null when no run exists for trigger", () => {
    expect(db.getWorkflowRunByTrigger("owner/repo#999")).toBeNull();
  });

  it("returns the most recent active run when multiple exist", async () => {
    const id1 = randomUUID();
    const id2 = randomUUID();

    db.createWorkflowRun({
      id: id1,
      workflowName: "build",
      triggerId: "owner/repo#12",
      currentPhase: "guardrails",
      status: "running",
      startedAt: new Date(Date.now() - 1000).toISOString(),
    });
    db.createWorkflowRun({
      id: id2,
      workflowName: "build",
      triggerId: "owner/repo#12",
      currentPhase: "architect",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const run = db.getWorkflowRunByTrigger("owner/repo#12");
    expect(run!.id).toBe(id2);
  });
});

describe("activeWorkflowRuns", () => {
  it("returns only running and paused runs", () => {
    const now = new Date().toISOString();

    const runningId = randomUUID();
    db.createWorkflowRun({ id: runningId, workflowName: "build", triggerId: "t1", currentPhase: "guardrails", status: "running", startedAt: now });

    const failedId = randomUUID();
    db.createWorkflowRun({ id: failedId, workflowName: "build", triggerId: "t2", currentPhase: "executor", status: "running", startedAt: now });
    db.finishWorkflowRun(failedId, "failed");

    const active = db.activeWorkflowRuns();
    expect(active.map((r) => r.id)).toContain(runningId);
    expect(active.map((r) => r.id)).not.toContain(failedId);
  });
});

describe("recentWorkflowRuns", () => {
  it("respects limit and orders by started_at DESC", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      db.createWorkflowRun({
        id: randomUUID(),
        workflowName: "build",
        triggerId: `t${i}`,
        currentPhase: "phase_0",
        status: "running",
        startedAt: new Date(now + i * 1000).toISOString(),
      });
    }

    const runs = db.recentWorkflowRuns(3);
    expect(runs).toHaveLength(3);
    // Most recent first
    expect(runs[0]!.startedAt >= runs[1]!.startedAt).toBe(true);
    expect(runs[1]!.startedAt >= runs[2]!.startedAt).toBe(true);
  });
});

describe("cancelWorkflowRun", () => {
  it("sets status to cancelled", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.createWorkflowRun({ id, workflowName: "build", triggerId: "t-cancel", currentPhase: "executor", status: "running", startedAt: now });
    db.cancelWorkflowRun(id);

    const run = db.getWorkflowRun(id);
    expect(run!.status).toBe("cancelled");
    expect(run!.finishedAt).toBeTruthy();
  });
});

describe("pauseWorkflowRun", () => {
  it("sets status to paused", () => {
    const id = randomUUID();
    db.createWorkflowRun({ id, workflowName: "build", triggerId: "t-pause", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });
    db.pauseWorkflowRun(id);

    const run = db.getWorkflowRun(id);
    expect(run!.status).toBe("paused");
  });
});

describe("workflow_approvals CRUD", () => {
  it("creates an approval and retrieves it by ID", () => {
    const id = randomUUID();
    const workflowRunId = randomUUID();
    db.createWorkflowRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#20", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const now = new Date().toISOString();
    db.createApproval({
      id,
      workflowRunId,
      gate: "post_architect",
      summary: "Plan ready for review",
      requestedBy: "alice",
      createdAt: now,
    });

    const approval = db.getApproval(id);
    expect(approval).not.toBeNull();
    expect(approval!.id).toBe(id);
    expect(approval!.workflowRunId).toBe(workflowRunId);
    expect(approval!.gate).toBe("post_architect");
    expect(approval!.summary).toBe("Plan ready for review");
    expect(approval!.status).toBe("pending");
    expect(approval!.requestedBy).toBe("alice");
    expect(approval!.createdAt).toBe(now);
  });

  it("returns null for a non-existent approval", () => {
    expect(db.getApproval("no-such-id")).toBeNull();
  });

  it("getPendingApprovalForWorkflow returns pending approval", () => {
    const workflowRunId = randomUUID();
    db.createWorkflowRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#21", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const approvalId = randomUUID();
    db.createApproval({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });

    const approval = db.getPendingApprovalForWorkflow(workflowRunId);
    expect(approval).not.toBeNull();
    expect(approval!.id).toBe(approvalId);
    expect(approval!.status).toBe("pending");
  });

  it("getPendingApprovalForWorkflow returns null when no pending approval", () => {
    expect(db.getPendingApprovalForWorkflow("no-such-workflow")).toBeNull();
  });

  it("getPendingApprovalByTrigger returns pending approval by trigger ID", () => {
    const workflowRunId = randomUUID();
    const triggerId = "owner/repo#22";
    db.createWorkflowRun({ id: workflowRunId, workflowName: "build", triggerId, currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const approvalId = randomUUID();
    db.createApproval({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });

    const approval = db.getPendingApprovalByTrigger(triggerId);
    expect(approval).not.toBeNull();
    expect(approval!.id).toBe(approvalId);
  });

  it("getPendingApprovalByTrigger returns null when trigger has no pending approval", () => {
    expect(db.getPendingApprovalByTrigger("owner/repo#9999")).toBeNull();
  });

  it("listPendingApprovals returns all pending approvals", () => {
    for (let i = 0; i < 3; i++) {
      const workflowRunId = randomUUID();
      db.createWorkflowRun({ id: workflowRunId, workflowName: "build", triggerId: `owner/repo#${30 + i}`, currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });
      db.createApproval({ id: randomUUID(), workflowRunId, gate: "post_architect", summary: `Summary ${i}`, createdAt: new Date().toISOString() });
    }

    const pending = db.listPendingApprovals();
    expect(pending.length).toBeGreaterThanOrEqual(3);
    expect(pending.every((a) => a.status === "pending")).toBe(true);
  });

  it("respondToApproval sets status and respondedBy", () => {
    const workflowRunId = randomUUID();
    db.createWorkflowRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#23", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const approvalId = randomUUID();
    db.createApproval({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });

    db.respondToApproval(approvalId, "approved", "bob");

    const approval = db.getApproval(approvalId);
    expect(approval!.status).toBe("approved");
    expect(approval!.respondedBy).toBe("bob");
    expect(approval!.respondedAt).toBeTruthy();
    expect(approval!.response).toBeUndefined();
  });

  it("respondToApproval stores rejection reason", () => {
    const workflowRunId = randomUUID();
    db.createWorkflowRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#24", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const approvalId = randomUUID();
    db.createApproval({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });

    db.respondToApproval(approvalId, "rejected", "carol", "Plan is incomplete");

    const approval = db.getApproval(approvalId);
    expect(approval!.status).toBe("rejected");
    expect(approval!.respondedBy).toBe("carol");
    expect(approval!.response).toBe("Plan is incomplete");
  });

  it("getPendingApprovalForWorkflow ignores responded approvals", () => {
    const workflowRunId = randomUUID();
    db.createWorkflowRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#25", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const approvalId = randomUUID();
    db.createApproval({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });
    db.respondToApproval(approvalId, "approved", "dave");

    expect(db.getPendingApprovalForWorkflow(workflowRunId)).toBeNull();
  });
});

describe("dailyStats", () => {
  // The shared db path resolves to a file (path.resolve(':memory:')), so rows
  // accumulate across tests. Wipe executions before each test in this suite.
  beforeEach(() => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (db as any).db.exec("DELETE FROM executions");
  });

  function insertExecution(opts: {
    id: string;
    startedAt: string;
    success?: boolean;
    inputTokens?: number;
    outputTokens?: number;
    cacheReadTokens?: number;
    costUsd?: number;
  }) {
    db.recordStart({
      id: opts.id,
      triggerType: "webhook",
      triggerId: "owner/repo#1",
      skill: "build",
      repo: "owner/repo",
      issueNumber: 1,
      startedAt: opts.startedAt,
    });
    if (opts.success !== undefined) {
      db.recordFinish(opts.id, {
        success: opts.success,
        inputTokens: opts.inputTokens,
        outputTokens: opts.outputTokens,
        cacheReadInputTokens: opts.cacheReadTokens,
        costUsd: opts.costUsd,
      });
    }
  }

  it("returns days rows of zeros when no executions exist", () => {
    const rows = db.dailyStats(30);
    expect(rows).toHaveLength(30);
    expect(rows.every((r) => r.executions === 0)).toBe(true);
    expect(rows.every((r) => r.totalTokens === 0 && r.costUsd === 0)).toBe(true);
  });

  it("aggregates executions by date", () => {
    // Use relative dates to stay within the 30-day window regardless of when tests run
    const d1Date = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 5));
    const d2Date = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 4));
    const d1Key = d1Date.toISOString().slice(0, 10);
    const d2Key = d2Date.toISOString().slice(0, 10);
    const day1 = `${d1Key}T10:00:00.000Z`;
    const day2 = `${d2Key}T10:00:00.000Z`;
    insertExecution({ id: randomUUID(), startedAt: day1, success: true });
    insertExecution({ id: randomUUID(), startedAt: day1, success: false });
    insertExecution({ id: randomUUID(), startedAt: day2, success: true });

    const rows = db.dailyStats(30);
    expect(rows).toHaveLength(30);

    const d1 = rows.find((r) => r.date === d1Key);
    const d2 = rows.find((r) => r.date === d2Key);
    expect(d1).toBeDefined();
    expect(d1!.executions).toBe(2);
    expect(d1!.successes).toBe(1);
    expect(d1!.failures).toBe(1);
    expect(d2).toBeDefined();
    expect(d2!.executions).toBe(1);
    expect(d2!.successes).toBe(1);
    expect(d2!.failures).toBe(0);
  });

  it("sums token and cost data correctly", () => {
    const dDate = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 3));
    const dKey = dDate.toISOString().slice(0, 10);
    const day = `${dKey}T12:00:00.000Z`;
    insertExecution({ id: randomUUID(), startedAt: day, success: true, inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, costUsd: 0.01 });
    insertExecution({ id: randomUUID(), startedAt: day, success: true, inputTokens: 200, outputTokens: 80, cacheReadTokens: 0, costUsd: 0.02 });

    const rows = db.dailyStats(30);
    const d = rows.find((r) => r.date === dKey);
    expect(d).toBeDefined();
    expect(d!.inputTokens).toBe(300);
    expect(d!.outputTokens).toBe(130);
    expect(d!.cacheReadTokens).toBe(20);
    expect(d!.totalTokens).toBe(450);
    expect(d!.costUsd).toBeCloseTo(0.03);
  });

  it("handles NULL token/cost columns gracefully", () => {
    const dDate = new Date(Date.UTC(new Date().getUTCFullYear(), new Date().getUTCMonth(), new Date().getUTCDate() - 2));
    const dKey = dDate.toISOString().slice(0, 10);
    const day = `${dKey}T08:00:00.000Z`;
    // recordStart only — no recordFinish, so tokens/cost are NULL
    db.recordStart({ id: randomUUID(), triggerType: "webhook", triggerId: "t1", skill: "build", repo: "r", issueNumber: 1, startedAt: day });

    const rows = db.dailyStats(30);
    const d = rows.find((r) => r.date === dKey);
    expect(d).toBeDefined();
    expect(d!.totalTokens).toBe(0);
    expect(d!.costUsd).toBe(0);
  });

  it("respects the days limit and excludes older executions", () => {
    // Very old execution — 60 days ago
    const old = new Date();
    old.setDate(old.getDate() - 60);
    insertExecution({ id: randomUUID(), startedAt: old.toISOString(), success: true });

    // Recent execution — today
    insertExecution({ id: randomUUID(), startedAt: new Date().toISOString(), success: true });

    const rows = db.dailyStats(30);
    // 30 daily rows (filled with zeros), with exactly one having an execution
    expect(rows).toHaveLength(30);
    const withExec = rows.filter((r) => r.executions > 0);
    expect(withExec).toHaveLength(1);
  });

  it("orders results by date ascending", () => {
    const d1 = "2026-04-08T10:00:00.000Z";
    const d2 = "2026-04-09T10:00:00.000Z";
    const d3 = "2026-04-10T10:00:00.000Z";
    insertExecution({ id: randomUUID(), startedAt: d3, success: true });
    insertExecution({ id: randomUUID(), startedAt: d1, success: true });
    insertExecution({ id: randomUUID(), startedAt: d2, success: true });

    const rows = db.dailyStats(30);
    expect(rows).toHaveLength(30);
    const dates = rows.map((r) => r.date);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });
});

describe("context JSON round-trip", () => {
  it("stores and retrieves complex context objects", () => {
    const id = randomUUID();
    const context = { branch: "lastlight/42-my-feature", taskId: "repo-42", models: { architect: "claude-opus-4-6" } };
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#42",
      currentPhase: "phase_0",
      status: "running",
      context,
      startedAt: new Date().toISOString(),
    });

    const run = db.getWorkflowRun(id);
    expect(run!.context).toEqual(context);
  });

  it("handles runs without context", () => {
    const id = randomUUID();
    db.createWorkflowRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#43",
      currentPhase: "phase_0",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const run = db.getWorkflowRun(id);
    expect(run!.context).toBeUndefined();
  });
});

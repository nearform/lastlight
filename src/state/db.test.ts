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
    db.runs.createRun({
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

    const run = db.runs.getRun(id);
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
    expect(db.runs.getRun("no-such-id")).toBeNull();
  });

  it("updates phase and appends to phase_history", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#2",
      currentPhase: "phase_0",
      status: "running",
      startedAt: now,
    });

    const entry = { phase: "guardrails", timestamp: new Date().toISOString(), success: true, summary: "READY" };
    db.runs.appendPhase(id, "guardrails", entry);

    const run = db.runs.getRun(id);
    expect(run!.currentPhase).toBe("guardrails");
    expect(run!.phaseHistory).toHaveLength(1);
    expect(run!.phaseHistory[0]).toEqual(entry);
  });

  it("appends multiple phase history entries", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#3",
      currentPhase: "phase_0",
      status: "running",
      startedAt: now,
    });

    db.runs.appendPhase(id, "guardrails", { phase: "guardrails", timestamp: now, success: true });
    db.runs.appendPhase(id, "architect", { phase: "architect", timestamp: now, success: true });
    db.runs.appendPhase(id, "executor", { phase: "executor", timestamp: now, success: true });

    const run = db.runs.getRun(id);
    expect(run!.currentPhase).toBe("executor");
    expect(run!.phaseHistory).toHaveLength(3);
    expect(run!.phaseHistory.map((e) => e.phase)).toEqual(["guardrails", "architect", "executor"]);
  });

  it("finishes a workflow run with succeeded status", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#4",
      currentPhase: "executor",
      status: "running",
      startedAt: now,
    });

    db.runs.finishRun(id, "succeeded");
    const run = db.runs.getRun(id);
    expect(run!.status).toBe("succeeded");
    expect(run!.finishedAt).toBeTruthy();
  });

  it("finishes a workflow run with failed status", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#5",
      currentPhase: "architect",
      status: "running",
      startedAt: now,
    });

    db.runs.finishRun(id, "failed", { error: "some error" });
    const run = db.runs.getRun(id);
    expect(run!.status).toBe("failed");
    expect(run!.finishedAt).toBeTruthy();
  });
});

describe("node_statuses store removed (issue #94)", () => {
  it("no longer exposes updateNodeStatus and getWorkflowRun has no nodeStatuses", () => {
    const id = randomUUID();
    db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#77",
      currentPhase: "phase_0",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    expect((db as unknown as Record<string, unknown>).updateNodeStatus).toBeUndefined();
    const run = db.runs.getRun(id);
    expect(run).not.toBeNull();
    expect((run as unknown as Record<string, unknown>).nodeStatuses).toBeUndefined();
  });
});

describe("recordSkippedPhase — skips land in the executions ledger", () => {
  it("writes a finished, non-successful skip row that shouldRunPhase re-evaluates", () => {
    const skill = "build:merge";
    const triggerId = "owner/repo#88";
    db.executions.recordSkippedPhase(skill, triggerId, "wf-skip-1", "repo");

    // Not "done" (success != 1) and not "running" (finished_at set) — so a
    // resume re-evaluates the node (it'll simply be re-skipped if still gated).
    expect(db.executions.shouldRunPhase(skill, triggerId, "wf-skip-1")).toBe("run");
  });
});

describe("getWorkflowRunByTrigger", () => {
  it("returns the active run for a trigger", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#10",
      currentPhase: "executor",
      status: "running",
      startedAt: now,
    });

    const run = db.runs.getByTrigger("owner/repo#10");
    expect(run).not.toBeNull();
    expect(run!.id).toBe(id);
  });

  it("ignores failed or succeeded runs", () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#11",
      currentPhase: "executor",
      status: "running",
      startedAt: now,
    });
    db.runs.finishRun(id, "failed");

    expect(db.runs.getByTrigger("owner/repo#11")).toBeNull();
  });

  it("returns null when no run exists for trigger", () => {
    expect(db.runs.getByTrigger("owner/repo#999")).toBeNull();
  });

  it("returns the most recent active run when multiple exist", async () => {
    const id1 = randomUUID();
    const id2 = randomUUID();

    db.runs.createRun({
      id: id1,
      workflowName: "build",
      triggerId: "owner/repo#12",
      currentPhase: "guardrails",
      status: "running",
      startedAt: new Date(Date.now() - 1000).toISOString(),
    });
    db.runs.createRun({
      id: id2,
      workflowName: "build",
      triggerId: "owner/repo#12",
      currentPhase: "architect",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const run = db.runs.getByTrigger("owner/repo#12");
    expect(run!.id).toBe(id2);
  });
});

describe("activeWorkflowRuns", () => {
  it("returns only running and paused runs", () => {
    const now = new Date().toISOString();

    const runningId = randomUUID();
    db.runs.createRun({ id: runningId, workflowName: "build", triggerId: "t1", currentPhase: "guardrails", status: "running", startedAt: now });

    const failedId = randomUUID();
    db.runs.createRun({ id: failedId, workflowName: "build", triggerId: "t2", currentPhase: "executor", status: "running", startedAt: now });
    db.runs.finishRun(failedId, "failed");

    const active = db.runs.listActive();
    expect(active.map((r) => r.id)).toContain(runningId);
    expect(active.map((r) => r.id)).not.toContain(failedId);
  });
});

describe("recentWorkflowRuns", () => {
  it("respects limit and orders by started_at DESC", () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      db.runs.createRun({
        id: randomUUID(),
        workflowName: "build",
        triggerId: `t${i}`,
        currentPhase: "phase_0",
        status: "running",
        startedAt: new Date(now + i * 1000).toISOString(),
      });
    }

    const runs = db.runs.listRecent(3);
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
    db.runs.createRun({ id, workflowName: "build", triggerId: "t-cancel", currentPhase: "executor", status: "running", startedAt: now });
    db.runs.cancelRun(id);

    const run = db.runs.getRun(id);
    expect(run!.status).toBe("cancelled");
    expect(run!.finishedAt).toBeTruthy();
  });
});

describe("pauseWorkflowRun", () => {
  it("sets status to paused", () => {
    const id = randomUUID();
    db.runs.createRun({ id, workflowName: "build", triggerId: "t-pause", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });
    db.runs.setPaused(id);

    const run = db.runs.getRun(id);
    expect(run!.status).toBe("paused");
  });
});

describe("workflow_approvals CRUD", () => {
  it("creates an approval and retrieves it by ID", () => {
    const id = randomUUID();
    const workflowRunId = randomUUID();
    db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#20", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const now = new Date().toISOString();
    db.approvals.create({
      id,
      workflowRunId,
      gate: "post_architect",
      summary: "Plan ready for review",
      requestedBy: "alice",
      createdAt: now,
    });

    const approval = db.approvals.getById(id);
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
    expect(db.approvals.getById("no-such-id")).toBeNull();
  });

  it("getPendingApprovalForWorkflow returns pending approval", () => {
    const workflowRunId = randomUUID();
    db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#21", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const approvalId = randomUUID();
    db.approvals.create({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });

    const approval = db.approvals.getPendingForWorkflow(workflowRunId);
    expect(approval).not.toBeNull();
    expect(approval!.id).toBe(approvalId);
    expect(approval!.status).toBe("pending");
  });

  it("getPendingApprovalForWorkflow returns null when no pending approval", () => {
    expect(db.approvals.getPendingForWorkflow("no-such-workflow")).toBeNull();
  });

  it("getPendingApprovalByTrigger returns pending approval by trigger ID", () => {
    const workflowRunId = randomUUID();
    const triggerId = "owner/repo#22";
    db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId, currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const approvalId = randomUUID();
    db.approvals.create({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });

    const approval = db.approvals.getPendingByTrigger(triggerId);
    expect(approval).not.toBeNull();
    expect(approval!.id).toBe(approvalId);
  });

  it("getPendingApprovalByTrigger returns null when trigger has no pending approval", () => {
    expect(db.approvals.getPendingByTrigger("owner/repo#9999")).toBeNull();
  });

  it("listPendingApprovals returns all pending approvals", () => {
    for (let i = 0; i < 3; i++) {
      const workflowRunId = randomUUID();
      db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: `owner/repo#${30 + i}`, currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });
      db.approvals.create({ id: randomUUID(), workflowRunId, gate: "post_architect", summary: `Summary ${i}`, createdAt: new Date().toISOString() });
    }

    const pending = db.approvals.listPending();
    expect(pending.length).toBeGreaterThanOrEqual(3);
    expect(pending.every((a) => a.status === "pending")).toBe(true);
  });

  it("respondToApproval sets status and respondedBy", () => {
    const workflowRunId = randomUUID();
    db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#23", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const approvalId = randomUUID();
    db.approvals.create({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });

    db.approvals.respond(approvalId, "approved", "bob");

    const approval = db.approvals.getById(approvalId);
    expect(approval!.status).toBe("approved");
    expect(approval!.respondedBy).toBe("bob");
    expect(approval!.respondedAt).toBeTruthy();
    expect(approval!.response).toBeUndefined();
  });

  it("respondToApproval stores rejection reason", () => {
    const workflowRunId = randomUUID();
    db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#24", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const approvalId = randomUUID();
    db.approvals.create({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });

    db.approvals.respond(approvalId, "rejected", "carol", "Plan is incomplete");

    const approval = db.approvals.getById(approvalId);
    expect(approval!.status).toBe("rejected");
    expect(approval!.respondedBy).toBe("carol");
    expect(approval!.response).toBe("Plan is incomplete");
  });

  it("getPendingApprovalForWorkflow ignores responded approvals", () => {
    const workflowRunId = randomUUID();
    db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#25", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const approvalId = randomUUID();
    db.approvals.create({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });
    db.approvals.respond(approvalId, "approved", "dave");

    expect(db.approvals.getPendingForWorkflow(workflowRunId)).toBeNull();
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
    db.executions.recordStart({
      id: opts.id,
      triggerType: "webhook",
      triggerId: "owner/repo#1",
      skill: "build",
      repo: "owner/repo",
      issueNumber: 1,
      startedAt: opts.startedAt,
    });
    if (opts.success !== undefined) {
      db.executions.recordFinish(opts.id, {
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
  // time moves past the 30-day window.
  function daysAgo(n: number): { iso: string; key: string } {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    d.setUTCHours(12, 0, 0, 0);
    return { iso: d.toISOString(), key: d.toISOString().slice(0, 10) };
  }

  it("returns days rows of zeros when no executions exist", () => {
    const rows = db.executions.dailyStats(30);
    expect(rows).toHaveLength(30);
    expect(rows.every((r) => r.executions === 0)).toBe(true);
    expect(rows.every((r) => r.totalTokens === 0 && r.costUsd === 0)).toBe(true);
  });

  it("aggregates executions by date", () => {
    const day1 = daysAgo(5);
    const day2 = daysAgo(4);
    insertExecution({ id: randomUUID(), startedAt: day1.iso, success: true });
    insertExecution({ id: randomUUID(), startedAt: day1.iso, success: false });
    insertExecution({ id: randomUUID(), startedAt: day2.iso, success: true });

    const rows = db.executions.dailyStats(30);
    expect(rows).toHaveLength(30);

    const d1 = rows.find((r) => r.date === day1.key);
    const d2 = rows.find((r) => r.date === day2.key);
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
    const day = daysAgo(3);
    insertExecution({ id: randomUUID(), startedAt: day.iso, success: true, inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, costUsd: 0.01 });
    insertExecution({ id: randomUUID(), startedAt: day.iso, success: true, inputTokens: 200, outputTokens: 80, cacheReadTokens: 0, costUsd: 0.02 });

    const rows = db.executions.dailyStats(30);
    const d = rows.find((r) => r.date === day.key);
    expect(d).toBeDefined();
    expect(d!.inputTokens).toBe(300);
    expect(d!.outputTokens).toBe(130);
    expect(d!.cacheReadTokens).toBe(20);
    expect(d!.totalTokens).toBe(450);
    expect(d!.costUsd).toBeCloseTo(0.03);
  });

  it("handles NULL token/cost columns gracefully", () => {
    const day = daysAgo(2);
    // recordStart only — no recordFinish, so tokens/cost are NULL
    db.executions.recordStart({ id: randomUUID(), triggerType: "webhook", triggerId: "t1", skill: "build", repo: "r", issueNumber: 1, startedAt: day.iso });

    const rows = db.executions.dailyStats(30);
    const d = rows.find((r) => r.date === day.key);
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

    const rows = db.executions.dailyStats(30);
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

    const rows = db.executions.dailyStats(30);
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
    db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#42",
      currentPhase: "phase_0",
      status: "running",
      context,
      startedAt: new Date().toISOString(),
    });

    const run = db.runs.getRun(id);
    expect(run!.context).toEqual(context);
  });

  it("handles runs without context", () => {
    const id = randomUUID();
    db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#43",
      currentPhase: "phase_0",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const run = db.runs.getRun(id);
    expect(run!.context).toBeUndefined();
  });
});

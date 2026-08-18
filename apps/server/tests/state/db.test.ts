import { describe, it, expect, beforeEach } from "vitest";
import { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../helpers/state-db.js";
import { randomUUID } from "crypto";

let db: StateDb;

beforeEach(async () => {
  db = await makeTestDb();
});

describe("workflow_runs CRUD", () => {
  it("creates a workflow run and retrieves it by ID", async () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.runs.createRun({
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

    const run = await db.runs.getRun(id);
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

  it("returns null for a non-existent ID", async () => {
    expect(await db.runs.getRun("no-such-id")).toBeNull();
  });

  it("updates phase and appends to phase_history", async () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#2",
      currentPhase: "phase_0",
      status: "running",
      startedAt: now,
    });

    const entry = { phase: "guardrails", timestamp: new Date().toISOString(), success: true, summary: "READY" };
    await db.runs.appendPhase(id, "guardrails", entry);

    const run = await db.runs.getRun(id);
    expect(run!.currentPhase).toBe("guardrails");
    expect(run!.phaseHistory).toHaveLength(1);
    expect(run!.phaseHistory[0]).toEqual(entry);
  });

  it("appends multiple phase history entries", async () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#3",
      currentPhase: "phase_0",
      status: "running",
      startedAt: now,
    });

    await db.runs.appendPhase(id, "guardrails", { phase: "guardrails", timestamp: now, success: true });
    await db.runs.appendPhase(id, "architect", { phase: "architect", timestamp: now, success: true });
    await db.runs.appendPhase(id, "executor", { phase: "executor", timestamp: now, success: true });

    const run = await db.runs.getRun(id);
    expect(run!.currentPhase).toBe("executor");
    expect(run!.phaseHistory).toHaveLength(3);
    expect(run!.phaseHistory.map((e) => e.phase)).toEqual(["guardrails", "architect", "executor"]);
  });

  it("finishes a workflow run with succeeded status", async () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#4",
      currentPhase: "executor",
      status: "running",
      startedAt: now,
    });

    await db.runs.finishRun(id, "succeeded");
    const run = await db.runs.getRun(id);
    expect(run!.status).toBe("succeeded");
    expect(run!.finishedAt).toBeTruthy();
  });

  it("finishes a workflow run with failed status", async () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#5",
      currentPhase: "architect",
      status: "running",
      startedAt: now,
    });

    await db.runs.finishRun(id, "failed", { error: "some error" });
    const run = await db.runs.getRun(id);
    expect(run!.status).toBe("failed");
    expect(run!.finishedAt).toBeTruthy();
  });
});

describe("node_statuses store removed (issue #94)", () => {
  it("no longer exposes updateNodeStatus and getWorkflowRun has no nodeStatuses", async () => {
    const id = randomUUID();
    await db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#77",
      currentPhase: "phase_0",
      status: "running",
      startedAt: new Date().toISOString(),
    });
    expect((db as unknown as Record<string, unknown>).updateNodeStatus).toBeUndefined();
    const run = await db.runs.getRun(id);
    expect(run).not.toBeNull();
    expect((run as unknown as Record<string, unknown>).nodeStatuses).toBeUndefined();
  });
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

describe("getWorkflowRunByTrigger", () => {
  it("returns the active run for a trigger", async () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#10",
      currentPhase: "executor",
      status: "running",
      startedAt: now,
    });

    const run = await db.runs.getByTrigger("owner/repo#10");
    expect(run).not.toBeNull();
    expect(run!.id).toBe(id);
  });

  it("ignores failed or succeeded runs", async () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#11",
      currentPhase: "executor",
      status: "running",
      startedAt: now,
    });
    await db.runs.finishRun(id, "failed");

    expect(await db.runs.getByTrigger("owner/repo#11")).toBeNull();
  });

  it("returns null when no run exists for trigger", async () => {
    expect(await db.runs.getByTrigger("owner/repo#999")).toBeNull();
  });

  it("returns the most recent active run when multiple exist", async () => {
    const id1 = randomUUID();
    const id2 = randomUUID();

    await db.runs.createRun({
      id: id1,
      workflowName: "build",
      triggerId: "owner/repo#12",
      currentPhase: "guardrails",
      status: "running",
      startedAt: new Date(Date.now() - 1000).toISOString(),
    });
    await db.runs.createRun({
      id: id2,
      workflowName: "build",
      triggerId: "owner/repo#12",
      currentPhase: "architect",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const run = await db.runs.getByTrigger("owner/repo#12");
    expect(run!.id).toBe(id2);
  });
});

describe("activeWorkflowRuns", () => {
  it("returns only running and paused runs", async () => {
    const now = new Date().toISOString();

    const runningId = randomUUID();
    await db.runs.createRun({ id: runningId, workflowName: "build", triggerId: "t1", currentPhase: "guardrails", status: "running", startedAt: now });

    const failedId = randomUUID();
    await db.runs.createRun({ id: failedId, workflowName: "build", triggerId: "t2", currentPhase: "executor", status: "running", startedAt: now });
    await db.runs.finishRun(failedId, "failed");

    const active = await db.runs.listActive();
    expect(active.map((r) => r.id)).toContain(runningId);
    expect(active.map((r) => r.id)).not.toContain(failedId);
  });
});

describe("recentWorkflowRuns", () => {
  it("respects limit and orders by started_at DESC", async () => {
    const now = Date.now();
    for (let i = 0; i < 5; i++) {
      await db.runs.createRun({
        id: randomUUID(),
        workflowName: "build",
        triggerId: `t${i}`,
        currentPhase: "phase_0",
        status: "running",
        startedAt: new Date(now + i * 1000).toISOString(),
      });
    }

    const runs = await db.runs.listRecent(3);
    expect(runs).toHaveLength(3);
    // Most recent first
    expect(runs[0]!.startedAt >= runs[1]!.startedAt).toBe(true);
    expect(runs[1]!.startedAt >= runs[2]!.startedAt).toBe(true);
  });
});

describe("cancelWorkflowRun", () => {
  it("sets status to cancelled", async () => {
    const id = randomUUID();
    const now = new Date().toISOString();
    await db.runs.createRun({ id, workflowName: "build", triggerId: "t-cancel", currentPhase: "executor", status: "running", startedAt: now });
    await db.runs.cancelRun(id);

    const run = await db.runs.getRun(id);
    expect(run!.status).toBe("cancelled");
    expect(run!.finishedAt).toBeTruthy();
  });
});

describe("pauseWorkflowRun", () => {
  it("sets status to paused", async () => {
    const id = randomUUID();
    await db.runs.createRun({ id, workflowName: "build", triggerId: "t-pause", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });
    await db.runs.setPaused(id);

    const run = await db.runs.getRun(id);
    expect(run!.status).toBe("paused");
  });
});

describe("workflow_approvals CRUD", () => {
  it("creates an approval and retrieves it by ID", async () => {
    const id = randomUUID();
    const workflowRunId = randomUUID();
    await db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#20", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const now = new Date().toISOString();
    await db.approvals.create({
      id,
      workflowRunId,
      gate: "post_architect",
      summary: "Plan ready for review",
      requestedBy: "alice",
      createdAt: now,
    });

    const approval = await db.approvals.getById(id);
    expect(approval).not.toBeNull();
    expect(approval!.id).toBe(id);
    expect(approval!.workflowRunId).toBe(workflowRunId);
    expect(approval!.gate).toBe("post_architect");
    expect(approval!.summary).toBe("Plan ready for review");
    expect(approval!.status).toBe("pending");
    expect(approval!.requestedBy).toBe("alice");
    expect(approval!.createdAt).toBe(now);
  });

  it("returns null for a non-existent approval", async () => {
    expect(await db.approvals.getById("no-such-id")).toBeNull();
  });

  it("getPendingApprovalForWorkflow returns pending approval", async () => {
    const workflowRunId = randomUUID();
    await db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#21", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const approvalId = randomUUID();
    await db.approvals.create({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });

    const approval = await db.approvals.getPendingForWorkflow(workflowRunId);
    expect(approval).not.toBeNull();
    expect(approval!.id).toBe(approvalId);
    expect(approval!.status).toBe("pending");
  });

  it("getPendingApprovalForWorkflow returns null when no pending approval", async () => {
    expect(await db.approvals.getPendingForWorkflow("no-such-workflow")).toBeNull();
  });

  it("getPendingApprovalByTrigger returns pending approval by trigger ID", async () => {
    const workflowRunId = randomUUID();
    const triggerId = "owner/repo#22";
    await db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId, currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const approvalId = randomUUID();
    await db.approvals.create({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });

    const approval = await db.approvals.getPendingByTrigger(triggerId);
    expect(approval).not.toBeNull();
    expect(approval!.id).toBe(approvalId);
  });

  it("getPendingApprovalByTrigger returns null when trigger has no pending approval", async () => {
    expect(await db.approvals.getPendingByTrigger("owner/repo#9999")).toBeNull();
  });

  it("listPendingApprovals returns all pending approvals", async () => {
    for (let i = 0; i < 3; i++) {
      const workflowRunId = randomUUID();
      await db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: `owner/repo#${30 + i}`, currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });
      await db.approvals.create({ id: randomUUID(), workflowRunId, gate: "post_architect", summary: `Summary ${i}`, createdAt: new Date().toISOString() });
    }

    const pending = await db.approvals.listPending();
    expect(pending.length).toBeGreaterThanOrEqual(3);
    expect(pending.every((a) => a.status === "pending")).toBe(true);
  });

  it("respondToApproval sets status and respondedBy", async () => {
    const workflowRunId = randomUUID();
    await db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#23", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const approvalId = randomUUID();
    await db.approvals.create({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });

    await db.approvals.respond(approvalId, "approved", "bob");

    const approval = await db.approvals.getById(approvalId);
    expect(approval!.status).toBe("approved");
    expect(approval!.respondedBy).toBe("bob");
    expect(approval!.respondedAt).toBeTruthy();
    expect(approval!.response).toBeUndefined();
  });

  it("respondToApproval stores rejection reason", async () => {
    const workflowRunId = randomUUID();
    await db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#24", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const approvalId = randomUUID();
    await db.approvals.create({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });

    await db.approvals.respond(approvalId, "rejected", "carol", "Plan is incomplete");

    const approval = await db.approvals.getById(approvalId);
    expect(approval!.status).toBe("rejected");
    expect(approval!.respondedBy).toBe("carol");
    expect(approval!.response).toBe("Plan is incomplete");
  });

  it("getPendingApprovalForWorkflow ignores responded approvals", async () => {
    const workflowRunId = randomUUID();
    await db.runs.createRun({ id: workflowRunId, workflowName: "build", triggerId: "owner/repo#25", currentPhase: "architect", status: "running", startedAt: new Date().toISOString() });

    const approvalId = randomUUID();
    await db.approvals.create({ id: approvalId, workflowRunId, gate: "post_architect", summary: "Test", createdAt: new Date().toISOString() });
    await db.approvals.respond(approvalId, "approved", "dave");

    expect(await db.approvals.getPendingForWorkflow(workflowRunId)).toBeNull();
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
  // Each test gets its own temp-file database from `makeTestDb()`, so rows no
  // longer accumulate across tests and nothing has to be wiped up front. (The
  // old suite shared one file, because `path.resolve(':memory:')` resolved to
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
  // time moves past the 30-day window.
  function daysAgo(n: number): { iso: string; key: string } {
    const d = new Date();
    d.setUTCDate(d.getUTCDate() - n);
    d.setUTCHours(12, 0, 0, 0);
    return { iso: d.toISOString(), key: d.toISOString().slice(0, 10) };
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
    const d1 = "2026-04-08T10:00:00.000Z";
    const d2 = "2026-04-09T10:00:00.000Z";
    const d3 = "2026-04-10T10:00:00.000Z";
    await insertExecution({ id: randomUUID(), startedAt: d3, success: true });
    await insertExecution({ id: randomUUID(), startedAt: d1, success: true });
    await insertExecution({ id: randomUUID(), startedAt: d2, success: true });

    const rows = await db.executions.dailyStats(30);
    expect(rows).toHaveLength(30);
    const dates = rows.map((r) => r.date);
    const sorted = [...dates].sort();
    expect(dates).toEqual(sorted);
  });
});

describe("context JSON round-trip", () => {
  it("stores and retrieves complex context objects", async () => {
    const id = randomUUID();
    const context = { branch: "lastlight/42-my-feature", taskId: "repo-42", models: { architect: "claude-opus-4-6" } };
    await db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#42",
      currentPhase: "phase_0",
      status: "running",
      context,
      startedAt: new Date().toISOString(),
    });

    const run = await db.runs.getRun(id);
    expect(run!.context).toEqual(context);
  });

  it("handles runs without context", async () => {
    const id = randomUUID();
    await db.runs.createRun({
      id,
      workflowName: "build",
      triggerId: "owner/repo#43",
      currentPhase: "phase_0",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const run = await db.runs.getRun(id);
    expect(run!.context).toBeUndefined();
  });
});

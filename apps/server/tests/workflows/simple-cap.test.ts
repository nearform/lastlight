/**
 * Concurrency cap tests for runSimpleWorkflow (#172).
 * Drives the queuing gate with a mocked runWorkflow + in-memory DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("#src/workflows/loader.js", () => ({
  getWorkflow: vi.fn(() => ({
    name: "explore",
    kind: "agent",
    status_checklist: false,
    phases: [{ name: "socratic", type: "agent", prompt: "prompt.md" }],
  })),
  loadPromptTemplate: vi.fn(() => "TEMPLATE"),
}));

vi.mock("#src/workflows/runner.js", () => ({
  runWorkflow: vi.fn(async () => ({
    success: true,
    phases: [{ phase: "socratic", success: true, output: "done" }],
  })),
}));

vi.mock("#src/engine/agent-executor.js", () => ({
  executeAgent: vi.fn(),
  executeCommand: vi.fn(),
}));

import { runSimpleWorkflow } from "#src/workflows/simple.js";
import { StateDb } from "#src/state/db.js";
import { runWorkflow } from "#src/workflows/runner.js";

const mockRunWorkflow = vi.mocked(runWorkflow);

function makeDb(): StateDb {
  return new StateDb(":memory:");
}

function makeRequest(overrides: Record<string, unknown> = {}) {
  return {
    owner: "acme",
    repo: "widgets",
    issueNumber: 1,
    issueTitle: "Test",
    sender: "alice",
    ...overrides,
  };
}

function makeConfig() {
  return {
    model: "test-model",
    maxTurns: 3,
    stateDir: "/tmp",
    sandboxDir: "/tmp/sandboxes",
    sessionsDir: "/tmp/sessions",
    sandbox: "none" as const,
    buildAssets: "repo" as const,
    buildAssetsDir: "/tmp/build-assets",
  };
}

function makeCallbacks() {
  return {
    postComment: vi.fn(async () => {}),
    onRunStart: vi.fn(async () => {}),
  };
}

describe("runSimpleWorkflow — concurrency cap (issue #172)", () => {
  let db: StateDb;

  beforeEach(() => {
    db = makeDb();
    mockRunWorkflow.mockResolvedValue({
      success: true,
      phases: [{ phase: "socratic", success: true, output: "ok" }],
    });
  });

  afterEach(() => {
    db.close();
    vi.clearAllMocks();
  });

  it("runs normally (creates running row, calls onRunStart) when under cap", async () => {
    const callbacks = makeCallbacks();
    const result = await runSimpleWorkflow(
      "explore",
      makeRequest(),
      makeConfig(),
      callbacks,
      db,
      undefined,
      undefined,
      "lastlight:bootstrap",
      undefined,
      { maxWorkflows: 4, maxQueueWaitMs: 1_800_000 },
    );
    expect(result.success).toBe(true);
    expect(result.queued).toBeFalsy();
    expect(callbacks.onRunStart).toHaveBeenCalledOnce();
    expect(mockRunWorkflow).toHaveBeenCalledOnce();
  });

  it("queues the run (creates queued row, does NOT call onRunStart) when at cap", async () => {
    // Fill up the cap with running runs
    for (let i = 0; i < 2; i++) {
      db.runs.createRun({
        id: `running-${i}`,
        workflowName: "build",
        triggerId: `acme/widgets#${100 + i}`,
        currentPhase: "architect",
        status: "running",
        startedAt: new Date().toISOString(),
      });
    }

    const callbacks = makeCallbacks();
    const result = await runSimpleWorkflow(
      "explore",
      makeRequest({ issueNumber: 99 }),
      makeConfig(),
      callbacks,
      db,
      undefined,
      undefined,
      "lastlight:bootstrap",
      undefined,
      { maxWorkflows: 2, maxQueueWaitMs: 1_800_000 },
    );

    expect(result.queued).toBe(true);
    expect(result.success).toBe(true);
    expect(result.phases).toHaveLength(0);
    expect(callbacks.onRunStart).not.toHaveBeenCalled();
    expect(mockRunWorkflow).not.toHaveBeenCalled();
    // Row should be in queued status
    const run = db.runs.getByTrigger("acme/widgets#99");
    expect(run).not.toBeNull();
    expect(run!.status).toBe("queued");
    // Enqueue ack posted
    expect(callbacks.postComment).toHaveBeenCalledOnce();
  });

  it("dedup: a duplicate trigger on a queued run returns queued without executing", async () => {
    // Create a queued run for the trigger
    db.runs.createRun({
      id: "queued-run-id",
      workflowName: "explore",
      triggerId: "acme/widgets#55",
      currentPhase: "socratic",
      status: "queued",
      startedAt: new Date().toISOString(),
    });

    const callbacks = makeCallbacks();
    const result = await runSimpleWorkflow(
      "explore",
      makeRequest({ issueNumber: 55 }),
      makeConfig(),
      callbacks,
      db,
      undefined,
      undefined,
      "lastlight:bootstrap",
      undefined,
      { maxWorkflows: 4, maxQueueWaitMs: 1_800_000 },
    );

    expect(result.queued).toBe(true);
    expect(mockRunWorkflow).not.toHaveBeenCalled();
    // Status stays queued, not changed
    expect(db.runs.getRun("queued-run-id")!.status).toBe("queued");
  });

  it("k8s backend admits freely at dispatch (fuse, not maxWorkflows)", async () => {
    // One run already 'running' + maxWorkflows=1 would queue the next on docker/none.
    // On the k8s backend the dispatch gate uses the sanity fuse, so it dispatches 'running'.
    db.runs.createRun({
      id: "running-k8s-0",
      workflowName: "build",
      triggerId: "acme/widgets#200",
      currentPhase: "architect",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const result = await runSimpleWorkflow(
      "explore",
      makeRequest(),
      { ...makeConfig(), sandbox: "kubernetes" as const },
      makeCallbacks(),
      db,
      undefined,
      undefined,
      "lastlight:bootstrap",
      undefined,
      { maxWorkflows: 1, maxQueueWaitMs: 1_800_000 },
    );

    expect(result.queued).toBeFalsy(); // NOT capped by maxWorkflows on k8s
    // Prove it actually admitted + dispatched (not a silent early return): the
    // workflow ran, so runWorkflow was invoked and the result reflects it.
    expect(mockRunWorkflow).toHaveBeenCalledOnce();
    expect(result.success).toBe(true);
  });

  it("requeues the run (running -> queued) when runWorkflow reports backpressure", async () => {
    mockRunWorkflow.mockResolvedValue({
      success: false,
      phases: [{ phase: "socratic", success: false, error: "exceeded quota" }],
      backpressure: true,
    });

    const result = await runSimpleWorkflow(
      "explore",
      makeRequest(),
      { ...makeConfig(), sandbox: "kubernetes" as const },
      makeCallbacks(),
      db,
      undefined,
      undefined,
      "lastlight:bootstrap",
      undefined,
      { maxWorkflows: 1000, maxQueueWaitMs: 1_800_000 },
    );

    expect(result.queued).toBe(true);
    expect(result.backpressure).toBe(true);
    // The row was created 'running', then requeued back to 'queued' by requeueRunning.
    const runs = db.runs.listActive();
    expect(runs.find((r) => r.workflowName === "explore")!.status).toBe("queued");
  });
});

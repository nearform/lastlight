/**
 * Concurrency cap tests for runSimpleWorkflow (#172).
 * Drives the queuing gate with a mocked runWorkflow + in-memory DB.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// PARTIAL — `simple.ts` now derives the run's workspace/pre-populate policy off
// the real loaded definitions (issue #368), so `listAgentWorkflows` /
// `getAssetVersion` must stay real.
vi.mock("#src/workflows/loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/workflows/loader.js")>()),
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

// reapOnSuccess's underlying reapSandboxWorkspace (src/sandbox/reap.js) now
// logs via the pino LoggerPort instead of console — mock the logger module
// so the suite's stderr stays free of real pino JSON (no assertions here
// depend on the logged content).
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

import { runSimpleWorkflow } from "#src/workflows/simple.js";
import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../helpers/state-db.js";
import { runWorkflow } from "#src/workflows/runner.js";

const mockRunWorkflow = vi.mocked(runWorkflow);

function makeDb(): Promise<StateDb> {
  return makeTestDb();
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

  beforeEach(async () => {
    db = await makeDb();
    mockRunWorkflow.mockResolvedValue({
      success: true,
      phases: [{ phase: "socratic", success: true, output: "ok" }],
    });
  });

  afterEach(() => {
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
      await db.runs.createRun({
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
    const run = await db.runs.getByTrigger("acme/widgets#99");
    expect(run).not.toBeNull();
    expect(run!.status).toBe("queued");
    // Enqueue ack posted
    expect(callbacks.postComment).toHaveBeenCalledOnce();
  });

  it("stashes the enqueue ack's comment id so admission can retract it (#244)", async () => {
    await db.runs.createRun({
      id: "blocker",
      workflowName: "build",
      triggerId: "acme/widgets#100",
      currentPhase: "architect",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    // A GitHub surface resolves the new comment id; Slack resolves void.
    const callbacks = { ...makeCallbacks(), postComment: vi.fn(async () => 5060108290) };
    await runSimpleWorkflow(
      "explore",
      makeRequest({ issueNumber: 215 }),
      makeConfig(),
      callbacks,
      db,
      undefined,
      undefined,
      "lastlight:bootstrap",
      undefined,
      { maxWorkflows: 1, maxQueueWaitMs: 1_800_000 },
    );

    const run = (await db.runs.getByTrigger("acme/widgets#215"))!;
    expect(run.status).toBe("queued");
    expect(run.scratch?.queuedAck).toEqual({ commentId: 5060108290 });
  });

  it("records no ack handle when the surface returns no comment id (Slack)", async () => {
    await db.runs.createRun({
      id: "blocker",
      workflowName: "build",
      triggerId: "acme/widgets#100",
      currentPhase: "architect",
      status: "running",
      startedAt: new Date().toISOString(),
    });

    const callbacks = makeCallbacks(); // postComment resolves void
    await runSimpleWorkflow(
      "explore",
      makeRequest({ issueNumber: 216 }),
      makeConfig(),
      callbacks,
      db,
      undefined,
      undefined,
      "lastlight:bootstrap",
      undefined,
      { maxWorkflows: 1, maxQueueWaitMs: 1_800_000 },
    );

    const run = (await db.runs.getByTrigger("acme/widgets#216"))!;
    expect(run.status).toBe("queued");
    expect(run.scratch?.queuedAck).toBeUndefined();
  });

  it("dedup: a duplicate trigger on a queued run returns queued without executing", async () => {
    // Create a queued run for the trigger
    await db.runs.createRun({
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
    expect((await db.runs.getRun("queued-run-id"))!.status).toBe("queued");
  });

  it("k8s backend admits freely at dispatch (fuse, not maxWorkflows)", async () => {
    // One run already 'running' + maxWorkflows=1 would queue the next on docker/none.
    // On the k8s backend the dispatch gate uses the sanity fuse, so it dispatches 'running'.
    await db.runs.createRun({
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
      phases: [{ phase: "socratic", success: false, output: "", error: "exceeded quota" }],
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
    const runs = await db.runs.listActive();
    expect(runs.find((r) => r.workflowName === "explore")!.status).toBe("queued");
  });
});

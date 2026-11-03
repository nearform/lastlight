/**
 * A duplicate trigger on a run whose scheduler is still executing in this
 * process must not start a second scheduler on the same run id (issue #488).
 *
 * Two `pr.checks_settled` events for one head both passed the PR run lock
 * (each read `runInFlight` before the other's row existed). The second found
 * the first's fresh `running` row via `getByTrigger`, and `handleExistingRun`
 * treated it as a resume — so `runWorkflow` ran twice concurrently on one run.
 * The first scheduler then marked the row `succeeded` while the second kept
 * the run live in memory, and the next review failed with WorkspaceBusyError.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// PARTIAL — `simple.ts` derives the run's workspace/pre-populate policy off the
// real loaded definitions (issue #368), so `listAgentWorkflows` /
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
import { markRunLive, __resetLiveRunsForTest } from "#src/workflows/live-runs.js";

const mockRunWorkflow = vi.mocked(runWorkflow);

const RUN_ID = "live-run-id";
const TRIGGER = "acme/widgets#227";

function dispatch(db: StateDb) {
  return runSimpleWorkflow(
    "explore",
    { owner: "acme", repo: "widgets", issueNumber: 227, issueTitle: "Test", sender: "alice" },
    {
      model: "test-model",
      maxTurns: 3,
      stateDir: "/tmp",
      sandboxDir: "/tmp/sandboxes",
      sessionsDir: "/tmp/sessions",
      sandbox: "none" as const,
      buildAssets: "repo" as const,
      buildAssetsDir: "/tmp/build-assets",
    },
    { postComment: vi.fn(async () => {}), onRunStart: vi.fn(async () => {}) },
    db,
    undefined,
    undefined,
    "lastlight:bootstrap",
    undefined,
    { maxWorkflows: 4, maxQueueWaitMs: 1_800_000 },
  );
}

describe("runSimpleWorkflow — duplicate trigger on a live run (issue #488)", () => {
  let db: StateDb;

  beforeEach(async () => {
    db = await makeTestDb();
    await db.runs.createRun({
      id: RUN_ID,
      workflowName: "explore",
      triggerId: TRIGGER,
      currentPhase: "socratic",
      status: "running",
      startedAt: new Date().toISOString(),
    });
  });

  afterEach(() => {
    __resetLiveRunsForTest();
    vi.clearAllMocks();
  });

  it("does not start a second scheduler when the run is still executing in this process", async () => {
    const release = markRunLive(RUN_ID);
    try {
      const result = await dispatch(db);

      expect(mockRunWorkflow).not.toHaveBeenCalled();
      // Parked, not failed — the same shape the other-engine guard returns.
      expect(result).toEqual({ success: true, paused: true, phases: [] });
      expect((await db.runs.getRun(RUN_ID))!.status).toBe("running");
    } finally {
      release();
    }
  });

  it("still resumes a running row whose scheduler is not live here (orphan after a restart)", async () => {
    await dispatch(db);

    expect(mockRunWorkflow).toHaveBeenCalledOnce();
  });
});

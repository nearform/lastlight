import { describe, expect, it, vi } from "vitest";

vi.mock("#src/logging/logger.js", () => {
  const noop = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn() };
  return { logger: () => noop };
});

import { supersedeRun } from "#src/engine/supersede.js";

function fakeDb(run: Record<string, unknown> | null, executions: Array<Record<string, unknown>> = []) {
  return {
    runs: {
      getRun: vi.fn().mockResolvedValue(run),
      cancelRun: vi.fn().mockResolvedValue(undefined),
    },
    executions: {
      runningExecutions: vi.fn().mockResolvedValue(executions),
      recordFinish: vi.fn().mockResolvedValue(undefined),
    },
  };
}

describe("supersedeRun — replacing a stale in-flight review", () => {
  it("cancels the run, kills its containers, fails its open phases, then waits for it to stop", async () => {
    const db = fakeDb(
      { id: "run-old", status: "running", workflowName: "pr-review", context: { taskId: "skillspro-2008-pr-review" } },
      [
        { id: 1, workflowRunId: "run-old" },
        { id: 2, workflowRunId: "someone-else" },
      ],
    );
    const killContainer = vi.fn().mockResolvedValue(undefined);
    const waitForStop = vi.fn().mockResolvedValue(true);

    const stopped = await supersedeRun("run-old", "superseded by a review of abcdef1", {
      db: db as any,
      listContainers: vi.fn().mockResolvedValue([
        { name: "lastlight-sandbox-skillspro-2008-pr-review-deadbeef", taskId: "skillspro-2008-pr-review" },
        { name: "lastlight-sandbox-skillspro-2009-pr-review-cafebabe", taskId: "skillspro-2009-pr-review" },
      ]) as any,
      killContainer,
      waitForStop,
    });

    expect(stopped).toBe(true);
    expect(db.runs.cancelRun).toHaveBeenCalledWith("run-old");
    expect(killContainer).toHaveBeenCalledTimes(1);
    expect(killContainer).toHaveBeenCalledWith("lastlight-sandbox-skillspro-2008-pr-review-deadbeef");
    expect(db.executions.recordFinish).toHaveBeenCalledTimes(1);
    expect(db.executions.recordFinish).toHaveBeenCalledWith(1, {
      success: false,
      error: "superseded: superseded by a review of abcdef1",
    });
    expect(waitForStop).toHaveBeenCalledWith("run-old", expect.any(Number));
  });

  it("does not re-cancel a run that already finished, but still waits for its runner", async () => {
    const db = fakeDb({ id: "run-old", status: "succeeded", workflowName: "pr-review", context: {} });
    const waitForStop = vi.fn().mockResolvedValue(true);
    await supersedeRun("run-old", "why", { db: db as any, waitForStop });
    expect(db.runs.cancelRun).not.toHaveBeenCalled();
    expect(waitForStop).toHaveBeenCalled();
  });

  it("never throws — a failed cancel must not cost the new review its dispatch", async () => {
    const db = fakeDb(null);
    db.runs.getRun.mockRejectedValue(new Error("db down"));
    const waitForStop = vi.fn().mockResolvedValue(false);
    await expect(supersedeRun("run-old", "why", { db: db as any, waitForStop })).resolves.toBe(false);
  });
});

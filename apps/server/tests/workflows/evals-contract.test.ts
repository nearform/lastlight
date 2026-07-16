import { describe, it, expect, expectTypeOf } from "vitest";
import { runWorkflow } from "#src/workflows/runner.js";
import type { RunnerCallbacks, WorkflowResult } from "#src/workflows/runner.js";
import type { ExecutorConfig } from "#src/engine/github/profiles.js";

/**
 * Fence for the frozen `lastlight/evals` surface (extraction design §7). The
 * eval harness drives real workflows through `runWorkflow` + these types; the
 * extraction must not perturb them.
 */
describe("lastlight/evals barrel contract", () => {
  it("runWorkflow keeps its frozen 9-arg signature", () => {
    expect(runWorkflow.length).toBe(9);
  });

  it("pins RunnerCallbacks / WorkflowResult / ExecutorConfig.githubApiBaseUrl", () => {
    // The github-mock seam the eval harness points at a fake GitHub.
    expectTypeOf<ExecutorConfig["githubApiBaseUrl"]>().toEqualTypeOf<string | undefined>();

    expectTypeOf<WorkflowResult>().toHaveProperty("success").toEqualTypeOf<boolean>();
    expectTypeOf<WorkflowResult>().toHaveProperty("phases");
    expectTypeOf<WorkflowResult>().toHaveProperty("prNumber").toEqualTypeOf<number | undefined>();
    expectTypeOf<WorkflowResult>().toHaveProperty("paused").toEqualTypeOf<boolean | undefined>();

    expectTypeOf<RunnerCallbacks>().toHaveProperty("postComment");
    expectTypeOf<RunnerCallbacks>().toHaveProperty("reporter");
    expectTypeOf<RunnerCallbacks["postComment"]>().toEqualTypeOf<((body: string) => Promise<void>) | undefined>();
  });
});

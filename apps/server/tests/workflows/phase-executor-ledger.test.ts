import { describe, it, expect, vi } from "vitest";
import { runPhase } from "lastlight-workflow-engine";
import type { ExecutorConfig } from "lastlight-workflow-engine";
import {
  FakeAgentPort,
  InMemoryStateStore,
  noopLiveness,
  noopObservability,
} from "lastlight-workflow-engine/test-support";

/**
 * Reproduces the `be203c6f` failure mode: provisioning (prePopulateWorkspace)
 * throws *before* the agent runs. The runPhaseLedger catch must finish the
 * `executions` row as failed — otherwise it stays `started` forever (renders
 * `…` in the CLI/dashboard instead of `✗`) and the phase is never retried.
 */
class ThrowingAgentPort extends FakeAgentPort {
  override async runAgent(): Promise<never> {
    throw new Error("prePopulate: refusing to embed a token (simulated provisioning failure)");
  }
}

describe("runPhase — provisioning throw finishes the ledger row failed", () => {
  it("records success:false / error_fatal and leaves the phase retryable (not done)", async () => {
    const store = new InMemoryStateStore("run-1");
    const recordFinish = vi.spyOn(store.executions, "recordFinish");
    const deps = {
      store,
      agent: new ThrowingAgentPort(),
      liveness: noopLiveness,
      observability: noopObservability,
    };
    const config = { sandbox: "none" } as unknown as ExecutorConfig;

    await expect(
      runPhase("build", "architect", "task-1", "trigger-1", "the prompt", config, deps, undefined, "run-1"),
    ).rejects.toThrow(/simulated provisioning failure/);

    // The row was finished *failed* — not left dangling at `started`.
    expect(recordFinish).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ success: false, stopReason: "error_fatal" }),
    );
    // shouldRunPhase now says "run" (retryable), never "done".
    expect(store.executions.shouldRunPhase("build:architect", "trigger-1", "run-1")).toBe("run");
  });
});

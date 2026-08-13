import { describe, it, expect, vi } from "vitest";
import type { LoggerPort } from "lastlight-workflow-engine";
import type { PhaseResult } from "lastlight-workflow-engine";
import { logPhaseEnd } from "#src/logging/phase-log.js";

/**
 * "Phase end" is the ONLY record a failed phase leaves (issue #335).
 *
 * `PhaseResult` carries an `error` field that both `onPhaseEnd` handlers used to
 * drop, logging `success: false` at `info` and nothing else. Every phase failure
 * was therefore indistinguishable from every other, and — the operational cost —
 * alerting on `level: error` never fired for a harness whose runs were all
 * failing.
 *
 * The failure that surfaced this was a Kubernetes 409 caught and RETURNED by
 * `executors/orchestrator.ts` (`stopReason: "error_sandbox"`), not thrown. The
 * throw path in `core/scheduler.ts` already logs `error` with the cause; the
 * returned path had no equivalent, so the error reached the run record and
 * telemetry but never the log stream.
 *
 * These tests hold both call sites (`index.ts`, `workflows/resume.ts`) to the
 * one helper, which is the point of extracting it: the two lines were
 * byte-identical duplicates, which is how one gets fixed and the other doesn't.
 */

function fakeLogger(): LoggerPort & { info: ReturnType<typeof vi.fn>; error: ReturnType<typeof vi.fn> } {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  };
  log.child.mockReturnValue(log);
  return log as unknown as LoggerPort & {
    info: ReturnType<typeof vi.fn>;
    error: ReturnType<typeof vi.fn>;
  };
}

const ok: PhaseResult = { phase: "review", success: true, output: "done" };

describe("logPhaseEnd", () => {
  it("logs a successful phase at info", () => {
    const log = fakeLogger();
    logPhaseEnd(log, "pr-review", "review", ok);

    expect(log.info).toHaveBeenCalledWith("Phase end", {
      workflowName: "pr-review",
      phase: "review",
      success: true,
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("logs a failed phase at ERROR, carrying the cause", () => {
    const log = fakeLogger();
    const failed: PhaseResult = {
      phase: "review",
      success: false,
      output: "",
      error: 'secrets "ll-run-abc-creds" already exists',
    };

    logPhaseEnd(log, "pr-review", "review", failed);

    expect(log.error).toHaveBeenCalledWith("Phase end", {
      workflowName: "pr-review",
      phase: "review",
      success: false,
      error: 'secrets "ll-run-abc-creds" already exists',
    });
    expect(log.info).not.toHaveBeenCalled();
  });

  // The level must not depend on whether a cause was captured — a failure with
  // no `error` is still a failure, and is exactly the case that most needs to be
  // greppable. Downgrading it to `info` would restore the original bug for the
  // subset of failures that carry no message.
  it("logs a failed phase at ERROR even when no cause was captured", () => {
    const log = fakeLogger();
    const failed: PhaseResult = { phase: "review", success: false, output: "" };

    logPhaseEnd(log, "pr-review", "review", failed);

    expect(log.error).toHaveBeenCalledWith("Phase end", {
      workflowName: "pr-review",
      phase: "review",
      success: false,
      error: undefined,
    });
    expect(log.info).not.toHaveBeenCalled();
  });
});

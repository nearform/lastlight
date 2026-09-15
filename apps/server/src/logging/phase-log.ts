import type { LoggerPort, PhaseResult } from "lastlight-workflow-engine";

/**
 * The single "Phase end" log call, shared by every workflow host.
 *
 * Extracted because the two call sites — `index.ts` (fresh dispatch) and
 * `workflows/resume.ts` (orphan recovery and the dashboard's Retry) — were
 * byte-identical duplicates. That is precisely the shape where one gets fixed
 * and the other silently doesn't, and the resume path is the one where
 * diagnosis matters most: a run reaching it is already known to have been
 * interrupted.
 *
 * A failed phase logs at `error` and carries `result.error`. Both halves of
 * that matter and for different reasons:
 *
 *   - the LEVEL, because `level: error` is the rule operators actually alert
 *     on. Logging failures at `info` means a harness whose runs are all failing
 *     looks healthy to anything watching the log stream.
 *   - the CAUSE, because `success: false` alone cannot distinguish an auth
 *     failure from a quota rejection from a scheduling failure from a bug.
 *
 * One `success: false` case is logged at `warn`, not `error`: `error_quota`
 * (a k8s ResourceQuota rejection). That is backpressure working as designed
 * — the runner requeues the run at zero cost — not a failure (#370). Every
 * other `success: false` case, including a missing `stopReason`, stays at
 * `error` so a misclassification fails safe toward visibility.
 *
 * `core/scheduler.ts` already logs `error` with the cause when a phase THROWS.
 * This covers the other path: an executor that catches a failure and returns it
 * as a failed `PhaseResult` (`executors/orchestrator.ts` does this for sandbox
 * provisioning errors, `stopReason: "error_sandbox"`). Before this, such a
 * failure reached the run record and telemetry but never the logs.
 */
/**
 * The matching "Phase start" call. No failure semantics — this exists only so
 * the pair stays together: the same three hosts emitted it as three separate
 * literals, which is the duplication that let `logPhaseEnd`'s sites drift apart
 * in the first place.
 */
export function logPhaseStart(log: LoggerPort, workflowName: string, phase: string): void {
  log.info("Phase start", { workflowName, phase });
}

export function logPhaseEnd(
  log: LoggerPort,
  workflowName: string,
  phase: string,
  result: PhaseResult,
): void {
  if (result.success) {
    log.info("Phase end", { workflowName, phase, success: true });
    return;
  }
  // A k8s ResourceQuota rejection (`error_quota`) is backpressure working as
  // designed, not a failure: the runner requeues the run and it costs $0/0
  // turns (see execution-store.ts, and #325 which files it as `deferred`, not
  // `failed`). Logging it at `error` puts a deferral in the same bucket as a
  // genuine fault. Log it at `warn`; keep `error` for real failures. `error`
  // still rides the payload so the cause stays visible.
  if (result.stopReason === "error_quota") {
    log.warn("Phase end", { workflowName, phase, success: false, error: result.error });
    return;
  }
  // `error` stays in the payload even when undefined: a failure that captured
  // no cause is still a failure, and the field's presence is what makes the
  // gap visible rather than ambiguous.
  log.error("Phase end", { workflowName, phase, success: false, error: result.error });
}

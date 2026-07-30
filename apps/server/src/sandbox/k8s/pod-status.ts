import type { V1ContainerStatus, V1PodStatus } from "@kubernetes/client-node";

/** Container `waiting.reason`s that will never resolve on their own — fail fast
 *  with the reason instead of waiting out the whole start budget. */
export const FATAL_WAITING_REASONS = new Set([
  "ImagePullBackOff",
  "ErrImagePull",
  "InvalidImageName",
  "CreateContainerConfigError",
  "CreateContainerError",
]);

/**
 * Pure classifier for {@link awaitPodResult} (`pod-lifecycle.ts`): resolve a
 * pod's status to its real exit code + deadline flag once it has gone
 * terminal, or `undefined` while it's still running. "Terminal" means either
 * the first container status reports `terminated`, or the pod phase itself is
 * `Succeeded`/`Failed` (some terminal pods never populate `containerStatuses`).
 * `timedOut` is true when either the pod-level or container-level reason is
 * `DeadlineExceeded` (an `activeDeadlineSeconds` kill).
 */
export function terminalResult(
  status?: V1PodStatus,
): { exitCode: number; timedOut: boolean } | undefined {
  const terminated = status?.containerStatuses?.[0]?.state?.terminated;
  const phase = status?.phase;
  const isTerminal = terminated !== undefined || phase === "Succeeded" || phase === "Failed";
  if (!isTerminal) return undefined;
  const timedOut =
    status?.reason === "DeadlineExceeded" || terminated?.reason === "DeadlineExceeded";
  const exitCode = terminated ? terminated.exitCode : phase === "Succeeded" ? 0 : 1;
  return { exitCode, timedOut };
}

/**
 * Pure classifier for {@link waitForContainerStart} (`pod-lifecycle.ts`):
 * "started" means the container is `running`/`terminated` OR the pod already
 * reached a terminal phase (a fast command can finish before the first poll)
 * — the kubelet log endpoint is available either way. A `waiting` state whose
 * reason is in {@link FATAL_WAITING_REASONS} (an image/config error that will
 * never resolve on its own) classifies as fatal instead of "waiting", so the
 * caller can fail fast with the real reason rather than waiting out the whole
 * start budget.
 */
export function containerStartState(
  status?: V1PodStatus,
): "started" | "waiting" | { fatal: string; message?: string } {
  const state = status?.containerStatuses?.[0]?.state;
  const phase = status?.phase;
  if (state?.running || state?.terminated || phase === "Succeeded" || phase === "Failed") {
    return "started";
  }
  const waiting = state?.waiting;
  if (waiting?.reason && FATAL_WAITING_REASONS.has(waiting.reason)) {
    return { fatal: waiting.reason, message: waiting.message };
  }
  return "waiting";
}

/**
 * Pure classifier for {@link checkInitContainerFailure} (`pod-lifecycle.ts`):
 * the first init container that has either terminated non-zero or is stuck on
 * a fatal `waiting.reason` (see {@link FATAL_WAITING_REASONS}) — `undefined`
 * while every init container is still progressing normally (the NORMAL
 * `PodInitializing` state is not itself a failure). `message` already reads
 * as a complete clause ("failed (exit N): reason — detail" or "cannot start:
 * reason — detail"); the caller prefixes it with the pod/container identity
 * and — for the terminated case only — appends a best-effort log tail (a
 * pure function can't fetch logs, so that I/O stays in the caller).
 */
export function initContainerFailure(
  inits?: V1ContainerStatus[],
): { name: string; message: string } | undefined {
  for (const init of inits ?? []) {
    const name = init.name;
    const terminated = init.state?.terminated;
    if (terminated && terminated.exitCode !== 0) {
      return {
        name,
        message:
          `failed (exit ${terminated.exitCode}): ${terminated.reason ?? "unknown"}` +
          (terminated.message ? ` — ${terminated.message}` : ""),
      };
    }
    const waiting = init.state?.waiting;
    if (waiting?.reason && FATAL_WAITING_REASONS.has(waiting.reason)) {
      return {
        name,
        message:
          `cannot start: ${waiting.reason}` + (waiting.message ? ` — ${waiting.message}` : ""),
      };
    }
  }
  return undefined;
}

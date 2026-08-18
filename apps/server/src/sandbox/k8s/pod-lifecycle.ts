import { ApiException } from "@kubernetes/client-node";
import type { CoreV1Api, V1ContainerStatus } from "@kubernetes/client-node";
import { containerStartState, initContainerFailure, terminalResult } from "./pod-status.js";
import { logger } from "../../logging/logger.js";

const log = logger("k8s");

/** Bound on the post-stream status poll: ~15 × 500ms ≈ 8s before the coarse
 *  phase-based fallback, so a lagging kubelet status never hangs a command. */
const POD_STATUS_POLL_ATTEMPTS = 15;
const POD_STATUS_POLL_INTERVAL_MS = 500;

/** Bound on the pre-stream "container started" poll. A cold node pulling the
 *  ~400 MB sandbox image straight from GHCR takes ~30s, and a burst of reviews
 *  lands pods on several cold nodes at once (plus scheduling + iSCSI attach) —
 *  60s wasn't enough and pods were reaped mid-pull. ~180 × 1s ≈ 180s absorbs a
 *  cold first-node pull; a terminal pull/config error still fails fast within it
 *  (see FATAL_WAITING_REASONS in `pod-status.ts`), so the extra budget only
 *  helps a progressing pull. A cluster image mirror (Spegel) makes subsequent
 *  nodes pull from a LAN peer, so this budget is the fallback for the one node
 *  that pulls from GHCR. */
const POD_START_POLL_ATTEMPTS = 180;
const POD_START_POLL_INTERVAL_MS = 1000;

/** Bound on the post-delete "pod actually gone" poll (RWO Multi-Attach fix):
 *  a Pod deleted via the API isn't detached from its RWO PVC until it's
 *  truly gone, so a sequential next-phase pod on the same PVC (possibly a
 *  different node) can hit Multi-Attach if `dispose` returns too early.
 *  Budget ~30 × 1s ≈ 30s; on exhaustion `waitForPodGone` warns and returns
 *  anyway — never hang the run (the reclaim sweep, Plan 4, is the backstop). */
const POD_DELETE_POLL_ATTEMPTS = 30;
const POD_DELETE_POLL_INTERVAL_MS = 1000;

/** Promise-based delay — the one place the pod-lifecycle poll loops below wait
 *  between attempts, replacing four hand-rolled `new Promise((r) =>
 *  setTimeout(r, ms))` calls. */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Resolve a finished pod to its real exit code + deadline flag. The log
 * stream closing does not guarantee the API-visible status has left
 * `Running` (kubelet status-sync lag), so we poll `readNamespacedPodStatus`
 * until the pod is terminal (see {@link terminalResult}), then read the
 * container's `terminated.exitCode`. The loop is bounded (~15 × 500ms ≈ 8s)
 * so a stuck status never hangs the command; on exhaustion we fall back to
 * the coarse phase-based result.
 */
export async function awaitPodResult(
  core: CoreV1Api,
  ns: string,
  name: string,
): Promise<{ exitCode: number; timedOut: boolean }> {
  for (let attempt = 0; attempt < POD_STATUS_POLL_ATTEMPTS; attempt++) {
    const pod = await core.readNamespacedPodStatus({ name, namespace: ns });
    const result = terminalResult(pod.status);
    if (result) return result;
    await sleep(POD_STATUS_POLL_INTERVAL_MS);
  }
  // Status never went terminal within the budget — coarse phase fallback.
  const pod = await core.readNamespacedPodStatus({ name, namespace: ns });
  return { exitCode: pod.status?.phase === "Succeeded" ? 0 : 1, timedOut: false };
}

/**
 * Wait until the pod's container has started so the kubelet log endpoint is
 * available. `Log.log(follow)` returns HTTP 400 while the container is still
 * `waiting` (Pending / ContainerCreating / image pull), so streaming
 * immediately after create races the scheduler. See {@link containerStartState}
 * for what counts as "started" vs a fatal `waiting` reason — a terminal
 * image/config error fails fast with its real reason rather than waiting out
 * the budget, so the failure is debuggable instead of a cryptic 400. A failed
 * clone initContainer is checked on every poll too (see
 * {@link checkInitContainerFailure}) — otherwise the main container just sits
 * at `PodInitializing` for the whole budget while the real `git clone`
 * failure sits unreported in `initContainerStatuses`.
 */
export async function waitForContainerStart(
  core: CoreV1Api,
  ns: string,
  name: string,
): Promise<void> {
  let lastReason = "";
  for (let attempt = 0; attempt < POD_START_POLL_ATTEMPTS; attempt++) {
    const pod = await core.readNamespacedPodStatus({ name, namespace: ns });
    await checkInitContainerFailure(core, ns, name, pod.status?.initContainerStatuses);
    const state = containerStartState(pod.status);
    // container has started (or already finished) — logs are available
    if (state === "started") return;
    if (state !== "waiting") {
      throw new Error(
        `k8s sandbox pod ${name} cannot start: ${state.fatal}` +
          (state.message ? ` — ${state.message}` : ""),
      );
    }
    const waiting = pod.status?.containerStatuses?.[0]?.state?.waiting;
    lastReason = waiting?.reason ?? pod.status?.phase ?? "";
    await sleep(POD_START_POLL_INTERVAL_MS);
  }
  const budgetSeconds = (POD_START_POLL_ATTEMPTS * POD_START_POLL_INTERVAL_MS) / 1000;
  throw new Error(
    `k8s sandbox pod ${name} container did not start within ${budgetSeconds}s ` +
      `(last state: ${lastReason || "unknown"})`,
  );
}

/**
 * Fail fast when the clone initContainer has failed or is stuck on a fatal
 * pull/config error, instead of leaving the caller to wait out the full
 * `waitForContainerStart` budget while the main container reports the
 * uninformative `PodInitializing` (which is the NORMAL state while an
 * initContainer is still running — not itself a failure). Delegates the
 * decision to the pure {@link initContainerFailure}; only the terminated
 * (non-zero exit) case fetches a log tail — a `waiting` container has no logs
 * to show yet.
 */
async function checkInitContainerFailure(
  core: CoreV1Api,
  ns: string,
  podName: string,
  initStatuses: V1ContainerStatus[] | undefined,
): Promise<void> {
  const failure = initContainerFailure(initStatuses);
  if (!failure) return;
  const failing = initStatuses?.find((init) => init.name === failure.name);
  const logs = failing?.state?.terminated
    ? await initContainerLogs(core, ns, podName, failure.name)
    : "";
  throw new Error(
    `k8s sandbox pod ${podName} init container "${failure.name}" ${failure.message}` +
      (logs ? `\n--- ${failure.name} logs (tail) ---\n${logs}` : ""),
  );
}

/**
 * Best-effort tail of a terminated init container's logs, appended to the
 * thrown error so the REAL failure (a git clone error — DNS, egress, PVC
 * permission, auth) is visible instead of a bare `exit 128`. Never throws:
 * a log-fetch failure just yields no extra detail.
 */
async function initContainerLogs(
  core: CoreV1Api,
  ns: string,
  podName: string,
  container: string,
): Promise<string> {
  try {
    const raw = await core.readNamespacedPodLog({ name: podName, namespace: ns, container });
    const text = typeof raw === "string" ? raw.trim() : "";
    const MAX = 2000;
    return text.length > MAX ? `…${text.slice(-MAX)}` : text;
  } catch {
    return "";
  }
}

/**
 * Poll after a successful pod delete until the API 404s it, so the RWO PVC
 * (an RWO block/local StorageClass such as the cluster default allows only
 * one attached node) is actually released before `dispose` returns — a
 * sequential next-phase pod reusing the same PVC on a different node would
 * otherwise race the still-attaching volume and hit Multi-Attach. A 404 on
 * the very first poll (pod already gone)
 * succeeds immediately. Best-effort like the delete above: any non-404
 * read error is treated as "not yet confirmed gone" and just retried
 * within the budget, never failing the caller's `dispose()`.
 */
/** Pod phases that mean the pod has finished and holds nothing but its record. */
const TERMINAL_POD_PHASES = new Set(["Succeeded", "Failed"]);

/**
 * Delete a previous attempt's finished pod so a retry can recreate the run.
 *
 * Sandbox object names are deterministic — {@link podNameFor} hashes the taskId
 * with no attempt component — so a retry regenerates the same pod name and the
 * same `<pod>-creds` / `<pod>-prompt` Secret names. `dispose()` normally clears
 * all three, but a harness that dies mid-run never reaches it. The tombstone
 * left behind makes every later attempt of that run fail: the Secret create
 * 409s first (the Secrets are ownerRef'd to the pod, so they outlive it only
 * because it was never deleted), and the pod create would 409 next.
 *
 * Only a TERMINAL pod is reclaimed. A pod still Pending or Running belongs to a
 * live dispatch racing this one for the same taskId, and that collision must
 * keep failing loudly — deleting it would turn a 409 into silent sabotage of
 * someone else's run.
 *
 * Mirrors `dispose()`'s sequence, `waitForPodGone` included: the workspace PVC
 * is `(repo,PR)`-scoped and RWO, so the replacement pod cannot attach it until
 * the tombstone is really gone.
 *
 * Best-effort, like everything else on this path — a pod that cannot be read or
 * deleted is left alone and the caller proceeds to fail on the create as before.
 *
 * @returns whether a stale pod was found and deleted.
 */
export async function reclaimStalePod(core: CoreV1Api, ns: string, name: string): Promise<boolean> {
  let phase: string | undefined;
  try {
    const pod = await core.readNamespacedPodStatus({ name, namespace: ns });
    phase = pod.status?.phase;
  } catch {
    return false; // absent (404) or unreadable — nothing to reclaim
  }
  if (!phase || !TERMINAL_POD_PHASES.has(phase)) return false;

  try {
    await core.deleteNamespacedPod({ name, namespace: ns });
  } catch {
    return false; // raced by the sweep, or forbidden — let the create surface it
  }
  log.info("Reclaimed a finished pod from a previous attempt", { pod: name, phase });
  await waitForPodGone(core, ns, name);
  return true;
}

export async function waitForPodGone(core: CoreV1Api, ns: string, name: string): Promise<void> {
  for (let attempt = 0; attempt < POD_DELETE_POLL_ATTEMPTS; attempt++) {
    try {
      await core.readNamespacedPodStatus({ name, namespace: ns });
    } catch (err) {
      if (err instanceof ApiException && err.code === 404) return; // gone
    }
    await sleep(POD_DELETE_POLL_INTERVAL_MS);
  }
  const budgetSeconds = (POD_DELETE_POLL_ATTEMPTS * POD_DELETE_POLL_INTERVAL_MS) / 1000;
  log.warn(
    "Pod still present after delete — proceeding anyway " +
      "(a sequential pod on the same PVC may race the volume release)",
    { pod: name, budgetSeconds },
  );
}

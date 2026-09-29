/**
 * Which workflow runs are executing IN THIS PROCESS right now.
 *
 * The run row's `status` says what a run is supposed to be doing; this says
 * whether its runner is actually still going. They disagree in exactly the
 * window that matters for a shared workspace: a run flipped to `cancelled`
 * keeps executing its current phase until the scheduler's next between-phase
 * check, and a run whose row the run lock failed to see (the stale-read bug
 * behind nearform/skillspro#2008) is `running` in memory whatever a read says.
 *
 * Two readers:
 * - `prePopulateWorkspace` refuses to reset a per-target workspace whose
 *   marker names a run that is still live here — the second run fails cleanly
 *   instead of `git clean`-ing the first run's `.lastlight/` out from under it.
 * - a superseding review waits for the run it cancelled to stop before it
 *   provisions the same workspace.
 *
 * Process-local on purpose: the harness is one process, and every path into
 * the runner (dispatch, resume, admission, retry) crosses `runWorkflow`, which
 * is where runs are registered.
 */

const live = new Map<string, Promise<void>>();

/**
 * Mark `runId` live until the returned release is called. Re-entrant for the
 * same id (a resume in the same process): the latest registration wins, and an
 * older release never clears a newer one.
 */
export function markRunLive(runId: string): () => void {
  let release!: () => void;
  const done = new Promise<void>((resolve) => {
    release = resolve;
  });
  live.set(runId, done);
  return () => {
    release();
    if (live.get(runId) === done) live.delete(runId);
  };
}

/** Is `runId`'s runner still executing in this process? */
export function isRunLive(runId: string): boolean {
  return live.has(runId);
}

/**
 * Resolve once `runId` is no longer live, or after `timeoutMs`. `true` when it
 * stopped, `false` on timeout. A run that is not live resolves `true` at once.
 */
export async function waitForRunToStop(runId: string, timeoutMs: number): Promise<boolean> {
  const done = live.get(runId);
  if (!done) return true;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
  });
  try {
    return await Promise.race([done.then(() => true as const), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Tests only. */
export function __resetLiveRunsForTest(): void {
  live.clear();
}

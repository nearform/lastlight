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
 * Three readers:
 * - `prePopulateWorkspace` refuses to reset a per-target workspace whose
 *   marker names a run that is still live here — the second run fails cleanly
 *   instead of `git clean`-ing the first run's `.lastlight/` out from under it.
 * - a superseding review waits for the run it cancelled to stop before it
 *   provisions the same workspace.
 * - `runSimpleWorkflow` claims a run (`claimRun`) before it creates or reuses
 *   the row, so a duplicate trigger can never start a second scheduler on a
 *   run that is already executing (issue #488).
 *
 * Process-local on purpose: the harness is one process, and every path into
 * the runner (dispatch, resume, admission, retry) crosses `runWorkflow`, which
 * registers the run for the life of the scheduler. `runSimpleWorkflow` adds a
 * registration of its own that also covers its start hooks and its wrap-up.
 */

interface LiveEntry {
  holders: number;
  done: Promise<void>;
  resolve: () => void;
}

const live = new Map<string, LiveEntry>();

/**
 * Mark `runId` live until the returned release is called. Re-entrant for the
 * same id: registrations are COUNTED, so the run stays live until every holder
 * has released, in any order. `runSimpleWorkflow` holds one registration from
 * before `createRun` to its own return, and `runWorkflow` holds another for the
 * scheduler — the scheduler releasing first must not open a window in which the
 * run looks free while `runSimpleWorkflow` is still finishing it (issue #488).
 * Each release is idempotent.
 */
export function markRunLive(runId: string): () => void {
  let entry = live.get(runId);
  if (!entry) {
    let resolve!: () => void;
    const done = new Promise<void>((r) => {
      resolve = r;
    });
    entry = { holders: 0, done, resolve };
    live.set(runId, entry);
  }
  entry.holders += 1;
  const held = entry;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    held.holders -= 1;
    if (held.holders === 0) {
      held.resolve();
      if (live.get(runId) === held) live.delete(runId);
    }
  };
}

/**
 * Take `runId` for a new scheduler, or refuse: a release when the run was not
 * live, `null` when it already is. The check and the registration happen in
 * one synchronous step, so of two dispatches racing for the same run exactly
 * one wins — the other must not start a second scheduler (issue #488).
 */
export function claimRun(runId: string): (() => void) | null {
  if (live.has(runId)) return null;
  return markRunLive(runId);
}

/** Is `runId`'s runner still executing in this process? */
export function isRunLive(runId: string): boolean {
  return live.has(runId);
}

/**
 * Resolve once `runId` is no longer live (every registration released), or
 * after `timeoutMs`. `true` when it stopped, `false` on timeout. A run that is
 * not live resolves `true` at once.
 */
export async function waitForRunToStop(runId: string, timeoutMs: number): Promise<boolean> {
  const done = live.get(runId)?.done;
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

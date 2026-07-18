/**
 * Cron fan-out: when a cron job context contains a `repos` array, dispatch
 * one workflow run per repo instead of passing the array through to a single
 * dispatch that expects `context.repo` (singular).
 *
 * Each per-repo run gets its own workflow_runs row, taskId, sandbox, and
 * trigger id, so failures are isolated and the existing per-run resume
 * machinery works unchanged.
 *
 * Concurrency is bounded so 100 repo scans don't spin 100 concurrent
 * sandboxes — default is 3, tunable per call.
 */

export type CronDispatcher = (
  workflow: string,
  context: Record<string, unknown>,
) => Promise<{ success: boolean; error?: string; paused?: boolean }>;

export interface FanOutResult {
  /** Number of dispatch calls actually made */
  dispatched: number;
  /** Number that returned !success and !paused (or threw) */
  failures: number;
}

export interface FanOutOptions {
  /** Max concurrent dispatches. Default 3. */
  concurrency?: number;
}

/**
 * Dispatch a cron-scheduled workflow, fanning out over `context.repos` when
 * present. When absent, behaves like a single dispatch. Always stamps
 * `_triggerType: "cron"` on the outgoing context.
 */
export async function dispatchCronWorkflow(
  workflowName: string,
  context: Record<string, unknown>,
  dispatch: CronDispatcher,
  options: FanOutOptions = {},
): Promise<FanOutResult> {
  const base: Record<string, unknown> = { ...context, _triggerType: "cron" };
  const rawRepos = base.repos;

  if (!Array.isArray(rawRepos)) {
    const result = await runOne(dispatch, workflowName, base);
    return { dispatched: 1, failures: result ? 0 : 1 };
  }

  const { repos: _drop, ...rest } = base;
  const repos = (rawRepos as unknown[]).filter(
    (r): r is string => typeof r === "string" && r.length > 0,
  );

  return fanOutContexts(
    workflowName,
    repos.map((repo) => ({ ...rest, repo })),
    dispatch,
    options,
  );
}

/**
 * Fan out one dispatch per pre-built context, bounded by `concurrency` (default
 * 3) so a large batch doesn't spin N concurrent sandboxes. Failures are
 * isolated (`Promise.allSettled`). This is the shared engine behind both the
 * per-repo cron fan-out (above) and the per-PR dependency-merge fan-out
 * (`src/index.ts`, over `discoverGreenDependencyPrs`). Each context already
 * carries everything `dispatch` needs — this helper adds nothing.
 */
export async function fanOutContexts(
  workflowName: string,
  contexts: Record<string, unknown>[],
  dispatch: CronDispatcher,
  options: FanOutOptions = {},
): Promise<FanOutResult> {
  if (contexts.length === 0) {
    return { dispatched: 0, failures: 0 };
  }

  const concurrency = Math.max(1, options.concurrency ?? 3);
  let dispatched = 0;
  let failures = 0;

  for (let i = 0; i < contexts.length; i += concurrency) {
    const batch = contexts.slice(i, i + concurrency);
    const results = await Promise.allSettled(
      batch.map((context) => runOne(dispatch, workflowName, context)),
    );
    for (const r of results) {
      dispatched++;
      const ok = r.status === "fulfilled" && r.value === true;
      if (!ok) failures++;
    }
  }

  return { dispatched, failures };
}

async function runOne(
  dispatch: CronDispatcher,
  workflowName: string,
  context: Record<string, unknown>,
): Promise<boolean> {
  try {
    const result = await dispatch(workflowName, context);
    return !!(result.success || result.paused);
  } catch (err) {
    console.error(
      `[cron-fanout] ${workflowName} dispatch threw for ${String(context.repo ?? "<no repo>")}:`,
      err,
    );
    return false;
  }
}

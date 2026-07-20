/**
 * Cron fan-out: when a cron job context contains a `repos` array, dispatch
 * one workflow run per repo instead of passing the array through to a single
 * dispatch that expects `context.repo` (singular).
 *
 * Each per-repo run gets its own workflow_runs row, taskId, sandbox, and
 * trigger id, so failures are isolated and the existing per-run resume
 * machinery works unchanged.
 *
 * Fan-out fires ALL contexts at once — it does NOT throttle how many sandboxes
 * run. That job belongs entirely to the global admission cap
 * (`concurrency.maxWorkflows`, issue #172): each dispatch just creates a
 * `workflow_runs` row, and an over-cap row is persisted `queued` (cheap) and
 * later promoted by the admission controller as slots free. There is no
 * dispatch-side concurrency knob — a batcher on top of the run queue only
 * serialized the fan-out, blocking each slice on completion while the queue
 * sat under-used.
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

/**
 * Dispatch a cron-scheduled workflow, fanning out over `context.repos` when
 * present. When absent, behaves like a single dispatch. Always stamps
 * `_triggerType: "cron"` on the outgoing context.
 */
export async function dispatchCronWorkflow(
  workflowName: string,
  context: Record<string, unknown>,
  dispatch: CronDispatcher,
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
  );
}

/**
 * Fan out one dispatch per pre-built context, ALL at once — no throttle. The
 * global admission cap decides how many run vs sit `queued`, so this must not
 * second-guess it. Failures are isolated (`Promise.allSettled`). This is the
 * shared engine behind both the per-repo cron fan-out (above) and the per-PR
 * dependency-merge fan-out (`src/index.ts`, over `discoverGreenDependencyPrs`).
 * Each context already carries everything `dispatch` needs — this helper adds
 * nothing.
 */
export async function fanOutContexts(
  workflowName: string,
  contexts: Record<string, unknown>[],
  dispatch: CronDispatcher,
): Promise<FanOutResult> {
  if (contexts.length === 0) {
    return { dispatched: 0, failures: 0 };
  }

  const results = await Promise.allSettled(
    contexts.map((context) => runOne(dispatch, workflowName, context)),
  );

  let failures = 0;
  for (const r of results) {
    if (!(r.status === "fulfilled" && r.value === true)) failures++;
  }

  return { dispatched: results.length, failures };
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

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
 *
 * WHICH repos the fan-out covers is resolved here, per tick, not when the job
 * was registered: a managed repo may opt out of (or into) a cron in its
 * `.lastlight/lastlight.yml` and that must take effect without re-registering
 * croner jobs. See `repo-crons.ts` for that resolution and its cost model.
 */

import { CRON_GLOBALLY_ENABLED_KEY, CRON_NAME_KEY, resolveCronRepos } from "./repo-crons.js";
import { logger } from "../logging/logger.js";

const log = logger("cron-fanout");

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
 *
 * When the context carries the cron's name (every scheduled tick does — see
 * `jobs.ts`), the repo list is narrowed by each repo's own `crons:` block
 * first. Without it — a manual "Run now", or any caller that builds its own
 * context — the list is used verbatim, exactly as before.
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

  // The two cron control keys are consumed here and dropped alongside `repos`,
  // so a dispatched run's context is byte-for-byte what it was before per-repo
  // participation existed.
  const { repos: _drop, [CRON_NAME_KEY]: rawCron, [CRON_GLOBALLY_ENABLED_KEY]: rawEnabled, ...rest } = base;
  const repos = (rawRepos as unknown[]).filter(
    (r): r is string => typeof r === "string" && r.length > 0,
  );

  const cron = typeof rawCron === "string" && rawCron ? rawCron : undefined;
  let targets = repos;
  if (cron) {
    const resolved = await resolveCronRepos({
      cron,
      repos,
      // Absent means "on" — only jobs.ts marks a cron globally off.
      globallyEnabled: rawEnabled !== false,
    });
    targets = resolved.repos;
    if (resolved.optedOut.length || resolved.optedIn.length) {
      log.info("Repo participation resolved", {
        cron,
        targetCount: targets.length,
        repoCount: repos.length,
        optedOut: resolved.optedOut,
        optedIn: resolved.optedIn,
      });
    }
  }

  // An empty list is a legitimate outcome (a globally-off cron nobody opted
  // into): fanOutContexts no-ops, so the tick costs nothing and reports no
  // failure.
  return fanOutContexts(
    workflowName,
    targets.map((repo) => ({ ...rest, repo })),
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
    log.error("Dispatch threw", {
      workflowName,
      repo: String(context.repo ?? "<no repo>"),
      err,
    });
    return false;
  }
}

/**
 * Superseding an in-flight review with a newer one.
 *
 * A `pr-review` run reviewing head A is stale the moment head B is the PR's
 * head. When the dispatch gate decides a review of B should run while A's is
 * still going (`Decision.supersedes`, from `resolveReviewTrigger`), the old run
 * is cancelled rather than left to post a review of code that no longer exists
 * — GitHub Actions' `cancel-in-progress`, for reviews.
 *
 * Both runs use the SAME per-target workspace (`workspace: per-target-reuse`),
 * so "cancelled" is not enough: the row flips at once, but the runner only
 * notices between phases and its current phase keeps writing into the
 * checkout. So this kills the run's sandbox containers (the in-flight phase
 * dies with them; in-process phases such as `survey-units` poll for the cancel
 * themselves) and then WAITS for the runner to actually stop
 * (`waitForRunToStop`) before the new run is allowed to provision.
 *
 * If the old run outlasts the wait, the new run proceeds anyway and
 * `prePopulateWorkspace` refuses the still-owned workspace — that fails the new
 * run cleanly (the sweep re-picks the unreviewed head), never both.
 */

import type { StateDb } from "../state/db.js";
import { listRunningContainers, killContainer } from "../admin/docker.js";
import { waitForRunToStop } from "../workflows/live-runs.js";
import { logger } from "../logging/logger.js";

const log = logger("supersede");

/** How long a superseding dispatch waits for the old runner to stop. */
export const SUPERSEDE_STOP_WAIT_MS = 5 * 60_000;

export interface SupersedeDeps {
  db: StateDb;
  /** Injected for tests; default is the docker CLI. */
  listContainers?: typeof listRunningContainers;
  killContainer?: typeof killContainer;
  waitForStop?: typeof waitForRunToStop;
  stopWaitMs?: number;
}

/**
 * Cancel `runId` in favour of a newer review, and wait for it to stop.
 *
 * Returns `true` when the old run is no longer executing (or was never live
 * here), `false` when it outlasted the wait. Never throws: a supersede that
 * cannot complete must not cost the NEW review its dispatch.
 */
export async function supersedeRun(runId: string, reason: string, deps: SupersedeDeps): Promise<boolean> {
  const { db } = deps;
  try {
    const run = await db.runs.getRun(runId);
    if (!run) return true;
    if (run.status === "running" || run.status === "queued" || run.status === "paused") {
      await db.runs.cancelRun(runId);
      log.info("Superseded an in-flight run", { runId, workflow: run.workflowName, reason });
    }

    const taskId = (run.context as Record<string, unknown> | undefined)?.taskId;
    if (typeof taskId === "string" && taskId) {
      try {
        const containers = await (deps.listContainers ?? listRunningContainers)();
        const kill = deps.killContainer ?? killContainer;
        await Promise.all(
          containers
            .filter((c) => c.taskId && c.taskId.startsWith(taskId))
            .map((c) =>
              kill(c.name).catch((err: unknown) =>
                log.warn("Could not kill a superseded run's container", { runId, container: c.name, err }),
              ),
            ),
        );
      } catch (err: unknown) {
        log.warn("Could not enumerate a superseded run's containers", { runId, err });
      }
    }

    for (const e of await db.executions.runningExecutions()) {
      if (e.workflowRunId === runId) {
        await db.executions.recordFinish(e.id, { success: false, error: `superseded: ${reason}` });
      }
    }
  } catch (err: unknown) {
    log.warn("Supersede failed — the new review dispatches anyway", { runId, err });
  }

  const stopped = await (deps.waitForStop ?? waitForRunToStop)(runId, deps.stopWaitMs ?? SUPERSEDE_STOP_WAIT_MS);
  if (!stopped) log.warn("Superseded run is still executing after the wait", { runId });
  return stopped;
}

/**
 * The TERMINAL half of the software-factory stage pipeline — the second and
 * final call site of `./stage-advance.ts`.
 *
 * The dispatch-time advance (`./build-gate.ts`, guard 2) moves an issue onto
 * the stage's `running` label before the run starts. Nothing moved it off
 * again: without this module `agent-building` is a dead end, and every issue
 * the pipeline ever picked up sits there forever while the run that owns it
 * has long since finished. This closes that loop.
 *
 * ```
 * agent-building ──▶ ready-for-human   (succeeded)
 *                └──▶ agent-blocked     (failed | cancelled)
 * ```
 *
 * ## Why an observer, and not a line in `simple.ts`
 *
 * The precedent is exact, and it is `./review-check.ts`: the `last-light/review`
 * check used to be completed from a `.then()` chained onto the in-memory
 * workflow promise, so it stranded on every deploy, every resume, every TTL
 * expiry and every crash. The fix was not routing but DURABILITY — make the
 * projection follow the run's PERSISTED terminal transition, wherever that
 * transition happens. Hanging off `TerminalRunObserver` is what makes
 * `simple.ts`, `resume.ts`, the queued-run TTL expiry and the admin cancel all
 * move the label for free, and what stops a ninth terminal path being added
 * without one. A stage label stranded at `agent-building` is the same class of
 * bug as a check stranded at `in_progress`, with a worse symptom: it is the
 * source of truth for where an issue has got to, so a human scanning the
 * tracker reads a lie.
 *
 * ## The observer contract
 *
 * `workflow-run-store.ts` states it: **synchronous, never throws, never
 * re-enters the store.** Everything here is one cheap synchronous filter and
 * then a fire-and-forget of the GitHub work, the same shape
 * `installReviewCheckObserver` uses — the promise carries a `.catch`, which is
 * both how the rejection gets somewhere to go and how it satisfies the
 * `lint-floating-promises` gate.
 *
 * ## Idempotency, without bookkeeping
 *
 * The observer can fire more than once for one run — a restart-resumed run that
 * finishes twice, a retry, a cancel racing a finish. It needs no dedup state,
 * because `advanceStage` is naturally idempotent at both ends: re-adding a label
 * the issue already carries is a no-op for GitHub's `addLabels`, and
 * `GitHubClient.removeLabel` swallows the 404 that means "already gone" (see
 * `github.ts` — the one status that means "already in the desired state"). So a
 * second firing re-asserts the same two facts and changes nothing. Recording a
 * "already advanced" flag would buy nothing and add a write that could itself
 * fail or go stale; the durable fact is the run row, and the label is its
 * projection.
 */

import { advanceStage } from "./stage-advance.js";
import { getAutonomyConfig, type AutonomyStageConfig } from "../config/config.js";
import { logger } from "../logging/logger.js";
import type { StateDb } from "../state/db.js";
import type { WorkflowRun } from "../state/workflow-run-store.js";
import type { GitHubClient } from "./github/github.js";

const log = logger("stage-observer");

export interface StageObserverDeps {
  /** `null` in chat-only mode — there is then no label to advance. */
  github: GitHubClient | null;
  /**
   * Called with the qualified `owner/repo` after a label actually moved.
   *
   * INJECTED rather than imported, so the engine keeps no edge to a delivery
   * surface: the one caller hands in `invalidateBoard` from the admin board
   * cache. Without it the board reads a stale label for up to its whole TTL,
   * and the result is a card that contradicts itself — the run band says
   * FAILED (read live from the database) while the card still sits in the
   * "building" column (read from the cached GitHub answer). Two freshness
   * windows on one card is worse than either being slow.
   *
   * Fires only on a CLEAN advance. A degraded one returns early above, and
   * busting the cache to re-read a label we know is half-written would just
   * spend a GitHub request to show the same wrong thing.
   */
  onAdvanced?: (repo: string) => void;
}

/**
 * The stage name this run was dispatched under, or `null` if it was not a
 * stage dispatch at all.
 *
 * Read BY NAME off the stored `context`, never through a mirrored type — the
 * same rule `PrStatePanel` follows. That JSON was written by whatever build was
 * running when the run started and is read back here by whatever build is
 * running when it ends, which for a paused-then-resumed run can be a different
 * release. A type assertion would claim a guarantee the storage cannot make.
 *
 * Two keys, because two things are being asked and only one of them exists on
 * every dispatch today: `_stage` is what the router stamps (`router.ts`, the
 * `issue.labeled` case) and is the one that NAMES the stage, so a run without it
 * cannot be advanced whatever else it carries. `_autonomous` is the gate's own
 * "this dispatch is autonomous" flag; where it is present and explicitly
 * `false`, that is a deliberate statement and it wins. An `@bot build` comment
 * carries neither, which is the case that matters most: a human-asked build
 * must never acquire stage labels it did not enter the pipeline through.
 */
function readStageName(run: WorkflowRun): string | null {
  const ctx = run.context ?? {};
  if (ctx._autonomous === false) return null;
  const stage = ctx._stage;
  if (typeof stage !== "string" || !stage) return null;
  return stage;
}

/**
 * Which label a terminal status lands on.
 *
 * Every terminal status of `workflow_runs` is named explicitly rather than
 * being swept up by an `else`, so adding a fourth one is a type error here
 * instead of a silent mis-labelling. The three are the store's own union
 * (`succeeded | failed | cancelled`).
 *
 * `cancelled` maps to `on_failure` with `failed`: from the issue's point of
 * view they are the same fact — the build did not get there and a person needs
 * to look. `agent-blocked` is the label that says so, and leaving a cancelled
 * run on `agent-building` would strand it exactly as before.
 *
 * **`paused` is NOT terminal and never reaches this function** — the store only
 * ever notifies for the three above. That is load-bearing rather than
 * incidental: a run sitting on an approval gate is `paused`, and the whole
 * point of an HITL gate is that the work is still in flight while a human
 * decides. Moving the label there would report a build as finished mid-run,
 * and — because the resume path finishes the run later — move it a second time.
 * This is the easy mistake in this module; the type is what prevents it.
 */
function targetLabel(
  stage: AutonomyStageConfig,
  status: "succeeded" | "failed" | "cancelled",
): string {
  switch (status) {
    case "succeeded":
      return stage.on_success;
    case "failed":
      return stage.on_failure;
    case "cancelled":
      return stage.on_failure;
  }
}

/**
 * Where this run happened. The `owner` / `repo` / `issueNumber` COLUMNS are
 * preferred and are populated for a build run — `createRun` writes them from
 * the normalized repo ref and the dispatch context's issue number.
 *
 * `triggerId` (`owner/repo#N`) is the fallback, not the primary, because it is
 * a formatted string and the columns are the structured fact. It earns its
 * place anyway: it is the value the run is KEYED on, so it is the one field
 * that cannot be absent.
 */
function locate(run: WorkflowRun): { owner: string; repo: string; issueNumber: number } | null {
  if (run.owner && run.repo && typeof run.issueNumber === "number" && run.issueNumber > 0) {
    return { owner: run.owner, repo: run.repo, issueNumber: run.issueNumber };
  }
  const match = /^([^/]+)\/([^#]+)#(\d+)$/.exec(run.triggerId ?? "");
  if (!match) return null;
  return { owner: match[1], repo: match[2], issueNumber: Number(match[3]) };
}

/** The async half — everything the synchronous observer fires and forgets. */
async function advanceTerminalStage(
  run: WorkflowRun,
  status: "succeeded" | "failed" | "cancelled",
  stageName: string,
  deps: StageObserverDeps,
): Promise<void> {
  // An operator renamed or removed the stage between dispatch and completion,
  // or the run predates the stage. There is no label vocabulary to move within,
  // so there is nothing correct to do — and nothing alarming either, which is
  // why this is debug rather than warn.
  const stage = getAutonomyConfig().stages[stageName];
  if (!stage) {
    log.debug("Terminal stage run names a stage that is not configured; leaving its label alone", {
      runId: run.id,
      workflow: run.workflowName,
      stage: stageName,
      status,
    });
    return;
  }

  const where = locate(run);
  if (!where) {
    log.warn("Terminal stage run has no issue to label", {
      runId: run.id,
      workflow: run.workflowName,
      stage: stageName,
      triggerId: run.triggerId,
      status,
    });
    return;
  }

  const to = targetLabel(stage, status);
  const advance = await advanceStage(
    { ...where, from: stage.running, to },
    { github: deps.github },
  );

  // Same condition `build-gate.ts` warns on, and for the same reason: the label
  // IS the stage, so a half-advance is the projection degrading. `advanced:
  // false` means the issue is still reported as building when it is not;
  // `removed: false` means it now claims both. Neither loses the run — that
  // fact is in the database — but both mislead a human reading the tracker,
  // which is the audience the whole pipeline is for.
  if (!advance.advanced || !advance.removed) {
    log.warn("Terminal stage label advance degraded — the issue's stage now misreports", {
      runId: run.id,
      workflow: run.workflowName,
      stage: stageName,
      status,
      ...where,
      from: stage.running,
      to,
      advanced: advance.advanced,
      removed: advance.removed,
      reason: advance.reason,
    });
    return;
  }

  log.info("Advanced the stage label on a terminal run", {
    runId: run.id,
    workflow: run.workflowName,
    stage: stageName,
    status,
    ...where,
    from: stage.running,
    to,
  });

  // The label moved, so anything caching the OLD one is now wrong. Best-effort
  // and deliberately last: a cache that refuses to clear must not turn a
  // successful advance into a logged failure.
  try {
    deps.onAdvanced?.(`${where.owner}/${where.repo}`);
  } catch (err: unknown) {
    log.debug("Stage advance notification failed", { runId: run.id, err });
  }
}

/**
 * Wire {@link advanceTerminalStage} onto every terminal run transition. Called
 * once, at boot, beside `installReviewCheckObserver`.
 */
export function installStageObserver(db: StateDb, deps: StageObserverDeps): void {
  db.runs.addTerminalObserver((run, status) => {
    const stageName = readStageName(run);
    if (!stageName) return;
    advanceTerminalStage(run, status, stageName, deps).catch((err: unknown) => {
      // The observer contract's "never throws" end of the bargain. The run is
      // already persisted as terminal; no projection of it may undo that, and
      // one failing must not cost the other observers their notification.
      log.warn("Terminal stage advance failed for run", { runId: run.id, stage: stageName, err });
    });
  });
}

/**
 * The `last-light/review` Check Run — as a **projection of run state**.
 *
 * Before this module the check was created in `dispatcher.ts` and completed
 * inside a `.then()` chained onto the in-memory workflow promise, and
 * `updateCheckRun` appeared nowhere else. `resume.ts` and `admission.ts` never
 * touched it, and the queued branch said so out loud: *"Documented limitation:
 * the check stays in-progress until admission fires."* So a check stranded
 * `in_progress` on every server restart mid-review (i.e. **every deploy**),
 * every queued-then-resumed run, every `expireStaleRuns` cancellation and every
 * crash. Nobody noticed because `check-prs-awaiting-review` re-reviewed the PR
 * within 30 minutes and `createCheckRun` posted a *new* check under the same
 * name, superseding the stranded one — the polling cron was the de facto repair
 * mechanism for stuck checks. That repair is accidental, and the per-SHA review
 * dedup breaks it: a check strands most often on a review that ran and posted,
 * and in that state `botReviewAtHead` is set, so the dedup skips the run and
 * posts no superseding check. You can have the dedup or the accidental repair,
 * not both.
 *
 * The bug is not routing, it is that **the check's state lived somewhere the
 * run's state did not** (09-state-machine.md → S2, locked decision 16). So:
 *
 * 1. The check id (+ owner, repo, head SHA) is persisted on the run row the
 *    moment the run exists — {@link recordReviewCheck}.
 * 2. It is completed from the run's TERMINAL TRANSITION — the same place that
 *    writes `succeeded` / `failed` / `cancelled` — via the store's
 *    `TerminalRunObserver`. `simple.ts`, `resume.ts`, `expireQueued` and the
 *    admin cancel therefore all resolve it for free, and a future terminal path
 *    cannot forget to.
 * 3. A run that never dispatches creates no check at all, rather than creating
 *    one and immediately concluding it.
 *
 * Boot-time reconciliation is deliberately NOT needed: terminal-transition
 * completion plus the existing `MAX_RESTART_RESUMES` resume path covers
 * restart.
 *
 * The one thing that is NOT a run — the `queued` / `neutral` PLACEHOLDER a
 * deferred review leaves behind ({@link postPlaceholderReviewCheck}) — is
 * terminal by construction: `neutral` is already concluded, and a `queued`
 * check is superseded by the real one the moment a review dispatches (GitHub
 * shows the latest run for a check name), with the 30-minute sweep as the
 * backstop that guarantees one arrives.
 */

import type { StateDb } from "../state/db.js";
import type { WorkflowRun } from "../state/workflow-run-store.js";
import type { GitHubClient } from "./github/github.js";
import type { ReviewCheckPlacement } from "./pr-decisions.js";
import { logger } from "../logging/logger.js";

const log = logger("check");

/** The check-run name branch protection can require. */
export const REVIEW_CHECK_NAME = "last-light/review";

/** The workflow whose runs own a {@link REVIEW_CHECK_NAME} check. */
export const REVIEW_WORKFLOW = "pr-review";

/** `workflow_runs.scratch` key holding {@link PersistedReviewCheck}. */
export const REVIEW_CHECK_SCRATCH_KEY = "reviewCheck";

/**
 * Everything the terminal transition needs to conclude the check, persisted
 * beside the run.
 *
 * The head SHA is stored rather than re-read: the check is pinned to the commit
 * it was created against, so that is the commit whose review verdict it must
 * report. A rebase mid-review produces a *new* head with its own checks; the
 * old one is superseded, not retro-actively re-judged.
 */
export interface PersistedReviewCheck {
  checkRunId: number;
  owner: string;
  repo: string;
  headSha: string;
}

/** Read the persisted ref off a run row, tolerating rows that have none. */
export function readReviewCheck(run: WorkflowRun): PersistedReviewCheck | null {
  const raw = (run.scratch ?? {})[REVIEW_CHECK_SCRATCH_KEY];
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.checkRunId !== "number" || typeof r.owner !== "string") return null;
  if (typeof r.repo !== "string" || typeof r.headSha !== "string") return null;
  return { checkRunId: r.checkRunId, owner: r.owner, repo: r.repo, headSha: r.headSha };
}

/** Persist the ref so the terminal transition can find it. */
export function recordReviewCheck(db: StateDb, runId: string, ref: PersistedReviewCheck): void {
  db.runs.mergeScratch(runId, { [REVIEW_CHECK_SCRATCH_KEY]: ref });
}

/** Everything {@link openReviewCheck} / {@link postPlaceholderReviewCheck} need. */
export interface ReviewCheckDeps {
  github: GitHubClient | null;
  /** `<botName>[bot]` — whose review the conclusion is derived from. */
  botLogin?: string;
  /** `@<botName>` handle, for the `on-request` placeholder's instructions. */
  botMention?: string;
}

/**
 * Open the in-progress check for a review that IS about to run.
 *
 * Best-effort: a failed create returns null and the review proceeds without a
 * check. Losing the check is a UI gap; refusing the review over it would not be.
 */
export async function openReviewCheck(
  args: { owner: string; repo: string; headSha: string },
  deps: ReviewCheckDeps,
): Promise<PersistedReviewCheck | null> {
  const { github } = deps;
  if (!github || !args.headSha) return null;
  try {
    const checkRunId = await github.createCheckRun(
      args.owner,
      args.repo,
      args.headSha,
      REVIEW_CHECK_NAME,
      {
        output: {
          title: "Review in progress",
          summary:
            "Last Light is reviewing this PR. The conclusion will land here when the review completes.",
        },
      },
    );
    log.info("Posted in-progress check", {
      checkRunId,
      repo: `${args.owner}/${args.repo}`,
      headSha: args.headSha.slice(0, 7),
    });
    return { checkRunId, owner: args.owner, repo: args.repo, headSha: args.headSha };
  } catch (err: unknown) {
    log.warn("Failed to create in-progress check", { err });
    return null;
  }
}

/**
 * Open the check AND bind it to a run, as one step.
 *
 * The two halves must not be separable, and that is a defect report rather than
 * a preference: the check used to be created at the top of `dispatchWorkflow`
 * and recorded only inside the runner's `onRunStart` callback — which
 * `runSimpleWorkflow` never reaches when the run is over the concurrency cap
 * (it returns `{ queued: true }` first). The check was created, never
 * persisted, never seen by the terminal observer, and never concluded; and the
 * accidental repair that used to hide this is gone, because a `queued` run
 * counts as active for its trigger, so the 30-minute sweep resolves
 * `run-in-flight` → placement `none` and posts no superseding check.
 *
 * Best-effort throughout: a failed create returns null and the review proceeds
 * without a check. Losing the check is a UI gap; refusing the review over it
 * would not be.
 */
export async function openAndBindReviewCheck(
  db: StateDb,
  runId: string,
  args: { owner: string; repo: string; headSha: string; detailsUrl?: string },
  deps: ReviewCheckDeps,
): Promise<PersistedReviewCheck | null> {
  const ref = await openReviewCheck(args, deps);
  if (!ref) return null;
  db.runs.mergeScratch(runId, { [REVIEW_CHECK_SCRATCH_KEY]: ref });
  if (args.detailsUrl) linkReviewCheck(ref, args.detailsUrl, deps).catch(() => {});
  return ref;
}

/** What {@link bindQueuedReviewCheck} needs to find the row and describe the check. */
export interface QueuedReviewCheckArgs {
  /** `owner/repo#N` — exactly the id `simple.ts` derived for the run. */
  triggerId: string;
  workflowName: string;
  owner: string;
  repo: string;
  headSha: string;
  /** Dashboard deep link for whichever run turns out to own the check. */
  detailsUrl?: (runId: string) => string | undefined;
}

/**
 * Bind a check to the run a dispatch just QUEUED.
 *
 * A queued run never reaches `onRunStart` — `runSimpleWorkflow` writes the row
 * and returns — and admission promotes it through `resumeSimpleRun`, which
 * takes no callbacks at all. So this is the only moment at which a queued
 * review's check can be attached to its run, and attaching it is what makes the
 * TTL expiry, the admin cancel and the eventual completion resolve it for free.
 *
 * Returns null (creating nothing) when there is no queued row of this workflow
 * to own it, or when the row already carries one — a duplicate trigger on an
 * already-queued run also returns `queued`, and a second check would orphan the
 * first rather than supersede it.
 */
export async function bindQueuedReviewCheck(
  db: StateDb,
  args: QueuedReviewCheckArgs,
  deps: ReviewCheckDeps,
): Promise<PersistedReviewCheck | null> {
  const run = db.runs.getByTrigger(args.triggerId);
  if (!run || run.workflowName !== args.workflowName || run.status !== "queued") return null;
  if (readReviewCheck(run)) return null;
  return openAndBindReviewCheck(
    db,
    run.id,
    {
      owner: args.owner,
      repo: args.repo,
      headSha: args.headSha,
      detailsUrl: args.detailsUrl?.(run.id),
    },
    deps,
  );
}

/**
 * Post the placeholder a DEFERRED review leaves behind — see
 * `reviewCheckPlacement`.
 *
 * `queued` (`after-checks`): branch protection already sees the check, so a repo
 * can require `last-light/review` without racing the settle event that will
 * eventually dispatch the real review.
 *
 * `neutral` (`on-request`): treated as passing by branch protection, so it never
 * blocks a merge, and its Re-run button becomes the request affordance — the
 * check *is* the button (`check_run.rerequested` on this name is normalised to
 * an explicit review request).
 *
 * `carried-over` (the generated-only skip, issue #271): a COMPLETED check
 * restating the verdict of the review already posted against an earlier SHA.
 * Not a "not yet" like the other two — it is the answer, it just isn't a new
 * one. Its conclusion mirrors that prior review (`args.carriedOver.state`),
 * because a CHANGES_REQUESTED carried forward as `success` would clear the
 * merge gate the review deliberately closed.
 *
 * Never throws; a placeholder is advisory.
 */
export async function postPlaceholderReviewCheck(
  args: {
    owner: string;
    repo: string;
    headSha: string;
    /** Required for `carried-over` — the review whose verdict is being repeated. */
    carriedOver?: { sha: string; state: string };
  },
  placement: Exclude<ReviewCheckPlacement, "in-progress" | "none">,
  deps: ReviewCheckDeps,
): Promise<void> {
  const { github } = deps;
  if (!github || !args.headSha) return;
  const mention = deps.botMention ?? "@last-light";
  const carriedOverOptions = () => {
    const prior = args.carriedOver!;
    const state = prior.state;
    const conclusion =
      state === "APPROVED" ? ("success" as const)
      : state === "CHANGES_REQUESTED" ? ("failure" as const)
      : ("neutral" as const);
    return {
      status: "completed" as const,
      conclusion,
      output: {
        title: "No re-review needed",
        summary:
          `Only generated files changed since the review of \`${prior.sha.slice(0, 7)}\`, so that ` +
          `review still stands (${state}). Comment \`${mention} review\` to force a fresh one.`,
      },
    };
  };
  const options =
    placement === "queued"
      ? {
          status: "queued" as const,
          output: {
            title: "Waiting for CI",
            summary: "Waiting for CI to finish before reviewing.",
          },
        }
      : placement === "carried-over" && args.carriedOver
        ? carriedOverOptions()
        : {
            status: "completed" as const,
            conclusion: "neutral" as const,
            output: {
              title: "Review available on request",
              summary: `Review available on request — use Re-run, or comment \`${mention} review\`.`,
            },
          };
  try {
    const id = await github.createCheckRun(
      args.owner,
      args.repo,
      args.headSha,
      REVIEW_CHECK_NAME,
      options,
    );
    log.info("Posted placeholder check", {
      placement,
      checkRunId: id,
      repo: `${args.owner}/${args.repo}`,
      headSha: args.headSha.slice(0, 7),
    });
  } catch (err: unknown) {
    log.warn("Failed to create placeholder check", { placement, err });
  }
}

/**
 * The placeholder half of the dispatch gate: called from BOTH skip sites (the
 * dispatcher's webhook/comment gate and `dispatchWorkflow`'s cron/API gate), the
 * same way `escalatePr` is, so the two routes cannot drift.
 *
 * Only ever fires on a PR-ATTENTION event. That is the whole rate limit: a
 * placeholder is a statement about a head SHA, and `pr.opened` / `synchronize` /
 * `reopened` / `ready_for_review` arrive roughly once per SHA, whereas the
 * 30-minute sweep would re-post one on every tick for the life of the PR.
 *
 * `carried-over` is exempt from that route limit, and has to be. Under the
 * packaged `review.trigger: after-checks` the generated-only decision is taken
 * on the `checks-settled` route, not on attention — so limiting it to attention
 * would leave the required check missing on exactly the heads it exists to
 * cover. Re-posting is harmless: GitHub shows the latest check run of a given
 * name on a SHA, so a repeat supersedes rather than accumulates.
 */
export async function postReviewCheckForSkip(
  args: {
    workflowName: string;
    placement: ReviewCheckPlacement;
    postsCheck: boolean;
    route: "attention" | "checks-settled" | "sweep";
    owner: string;
    repo: string;
    headSha: string;
    carriedOver?: { sha: string; state: string };
  },
  deps: ReviewCheckDeps,
): Promise<void> {
  if (args.workflowName !== REVIEW_WORKFLOW || !args.postsCheck) return;
  if (args.placement === "carried-over") {
    if (!args.carriedOver) return;
  } else {
    if (args.route !== "attention") return;
    if (args.placement !== "queued" && args.placement !== "neutral") return;
  }
  await postPlaceholderReviewCheck(
    { owner: args.owner, repo: args.repo, headSha: args.headSha, carriedOver: args.carriedOver },
    args.placement,
    deps,
  );
}

/** Point an already-open check at the run's dashboard deep link. */
export async function linkReviewCheck(
  ref: PersistedReviewCheck,
  detailsUrl: string,
  deps: ReviewCheckDeps,
): Promise<void> {
  if (!deps.github || !detailsUrl) return;
  try {
    await deps.github.updateCheckRun(ref.owner, ref.repo, ref.checkRunId, { detailsUrl });
    log.info("Linked check", { checkRunId: ref.checkRunId, detailsUrl });
  } catch (err: unknown) {
    log.warn("Failed to set details_url on check", { checkRunId: ref.checkRunId, err });
  }
}

/**
 * Conclude the check for a run that has just reached a terminal status.
 *
 * The conclusion is read from what the run actually POSTED — the bot's review
 * at the check's head SHA — rather than from the run's exit code, because a
 * `succeeded` run that legitimately skipped (already reviewed, nothing to say)
 * must not claim an approval it did not give. `neutral` is the honest answer
 * whenever there is no verdict to report, and branch protection treats it as
 * passing, so a review that failed to run never blocks a merge on its own.
 *
 * Idempotent enough: the persisted ref is cleared first, so a second terminal
 * notification for the same run (a retry, a racing cancel) is a no-op.
 */
export async function concludeReviewCheck(
  db: StateDb,
  run: WorkflowRun,
  status: "succeeded" | "failed" | "cancelled",
  deps: ReviewCheckDeps,
): Promise<void> {
  const ref = readReviewCheck(run);
  if (!ref || !deps.github) return;
  // Clear before the network call: a failed update must not leave a ref that
  // re-fires on the next terminal transition of the same row.
  db.runs.mergeScratch(run.id, { [REVIEW_CHECK_SCRATCH_KEY]: null });

  const github = deps.github;
  let conclusion: "success" | "failure" | "neutral" | "cancelled" = "neutral";
  let title = "Review completed";
  let summary = "Review complete.";

  if (status === "cancelled") {
    conclusion = "cancelled";
    title = "Review cancelled";
    summary = "The review run was cancelled before it could post a verdict.";
  } else {
    let review: { state: string; body: string | null } | null = null;
    try {
      review = await github.getLatestBotReview(
        ref.owner,
        ref.repo,
        run.issueNumber ?? 0,
        ref.headSha,
        deps.botLogin,
      );
    } catch (err: unknown) {
      log.warn("Could not read the posted review for check", { checkRunId: ref.checkRunId, err });
    }
    if (status === "failed" && !review) {
      title = "Review didn't complete";
      summary = "The review run failed before posting a verdict.";
    } else if (review?.state === "APPROVED") {
      conclusion = "success";
      title = "Review approved";
      summary = review.body?.slice(0, 65000) || "Approved.";
    } else if (review?.state === "CHANGES_REQUESTED") {
      conclusion = "failure";
      title = "Review requested changes";
      summary = review.body?.slice(0, 65000) || "Changes requested.";
    } else if (review) {
      summary = review.body?.slice(0, 65000) || "Review complete.";
    }
  }

  try {
    await github.updateCheckRun(ref.owner, ref.repo, ref.checkRunId, {
      status: "completed",
      conclusion,
      output: { title, summary },
    });
    log.info("Completed check", { checkRunId: ref.checkRunId, conclusion, runStatus: status });
  } catch (err: unknown) {
    log.warn("Failed to complete check", { checkRunId: ref.checkRunId, err });
  }
}

/**
 * Wire {@link concludeReviewCheck} onto every terminal run transition. Called
 * once, at boot.
 */
export function installReviewCheckObserver(db: StateDb, deps: ReviewCheckDeps): void {
  db.runs.setTerminalObserver((run, status) => {
    if (!readReviewCheck(run)) return;
    concludeReviewCheck(db, run, status, deps).catch((err: unknown) => {
      log.warn("Terminal conclusion failed for run", { runId: run.id, err });
    });
  });
}

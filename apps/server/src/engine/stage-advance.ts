/**
 * Advancing an issue through the software-factory pipeline — one label on, one
 * label off, in that order, best-effort.
 *
 * The stage LABEL is the source of truth for where an issue has got to
 * (`stage-labels.ts`), and the harness moves it itself, host-side. This is the
 * whole mechanism. It runs at the dispatch choke point, where there is no
 * sandbox and no agent to ask, so it goes through the two harness-side label
 * writes on `GitHubClient` rather than agentic-pi's `github_*` tools.
 *
 * ## The ordering rule: ADD first, then REMOVE
 *
 * Not negotiable, and not arbitrary — the two failure modes are asymmetric.
 *
 * - Add succeeded, remove failed → the issue carries BOTH labels. That is
 *   visible, reconcilable by hand or by the next advance, and harmless: a later
 *   stage wins when anything reads the pair.
 * - Remove succeeded, add failed → the issue carries NEITHER. It has silently
 *   fallen out of the pipeline with nothing on it to see. No query finds it, no
 *   sweep re-picks it, and nobody scanning the tracker has any reason to look
 *   at it. That is the one outcome worth engineering against.
 *
 * So if the add fails we do **not** attempt the remove. Half an advance in the
 * safe direction beats a clean exit from the pipeline.
 *
 * ## Why it never throws
 *
 * Best-effort, like every other GitHub-touching helper on this path. A failed
 * label write must not block the dispatch it decorates. What actually enforces
 * idempotency is **guard 3** — `hasRunForTrigger`, a fact in our own database,
 * which no GitHub outage can move. The labels are the HUMAN-READABLE PROJECTION
 * of that fact, not the fact itself.
 *
 * Which is not to say the entry-label removal is decorative. It is **guard 2**
 * of four, and it is the one that makes a re-dispatch loop structurally
 * impossible rather than merely caught: the backstop cron sweep queries
 * `label:ready-for-agent`, so an entry label removed before the run starts
 * cannot be re-picked at all. This repo has a recorded production incident of
 * the opposite shape — a cron gated on a signal the work never wrote, burning
 * roughly $1.30/hour while every run reported `succeeded`. Guard 3 is why a
 * failure here costs visibility rather than money; guard 2 is why guard 3 is
 * rarely the one doing the work.
 *
 * Label names arrive as plain strings. They are operator-owned config
 * (`autonomy.stages`), resolved by the caller — this module stays decoupled
 * from the config types on purpose.
 */

import type { GitHubClient } from "./github/github.js";
import { logger } from "../logging/logger.js";

const log = logger("stage-advance");

export interface StageAdvanceArgs {
  owner: string;
  repo: string;
  issueNumber: number;
  /** The label to remove. Omit when entering the pipeline. */
  from?: string;
  /** The label to add. */
  to: string;
  /**
   * Further labels to take off, BEST-EFFORT, once the add has succeeded.
   *
   * Exists for one case: a stage's terminal verdicts (`on_success` /
   * `on_failure`) are stale the moment a new run starts, and nothing else ever
   * clears them. Without this, an issue that failed and was then re-run
   * successfully ends up carrying BOTH `agent-blocked` and `ready-for-human`,
   * and the board — which breaks a tie by column order — files it under the
   * older, scarier one.
   *
   * Deliberately NOT reflected in {@link StageAdvanceResult.removed}, which
   * remains a statement about `from` alone: these are opportunistic tidying, and
   * a failure to tidy is not a failure to advance. `to` and `from` are skipped,
   * so a caller can pass a stage's whole label set without thinking about it.
   */
  alsoRemove?: readonly string[];
}

export interface StageAdvanceDeps {
  /** `null` in chat-only mode — no GitHub, nothing to label. */
  github: GitHubClient | null;
}

/**
 * The outcome, granular on purpose: `added` and `removed` are reported
 * separately so a caller (or a log reader) can tell "never entered the new
 * stage" from "entered it but still carries the old label", which are different
 * problems with different remedies.
 */
export interface StageAdvanceResult {
  /** True once the NEW label is on — the stage has moved, whatever else did. */
  advanced: boolean;
  added: boolean;
  removed: boolean;
  /** Present only when something did not happen; short, machine-ish. */
  reason?: string;
}

export async function advanceStage(
  args: StageAdvanceArgs,
  deps: StageAdvanceDeps,
): Promise<StageAdvanceResult> {
  const { owner, repo, issueNumber, from, to, alsoRemove } = args;

  /**
   * The opportunistic half. Runs only AFTER the add has succeeded — the module's
   * ordering rule is about never leaving an issue with no stage label, and that
   * argument covers these removals exactly as it covers `from`.
   */
  const removeStale = async (): Promise<void> => {
    for (const label of alsoRemove ?? []) {
      if (!label || label === to || label === from) continue;
      try {
        await deps.github!.removeLabel(owner, repo, issueNumber, label);
      } catch (err) {
        // A stale verdict left on the issue is untidy, not unsafe.
        log.warn("stage advance could not clear a stale label", {
          owner,
          repo,
          issueNumber,
          label,
          err,
        });
      }
    }
  };

  // Chat-only mode: there is no GitHub to project onto. Not an error, and not
  // worth a warn — it is the configured shape of the deployment.
  if (!deps.github) {
    return { advanced: false, added: false, removed: false, reason: "no-github" };
  }
  if (!to) {
    return { advanced: false, added: false, removed: false, reason: "no-target-label" };
  }

  // 1. The new label FIRST. See the ordering rule in the module header.
  try {
    await deps.github.addLabels(owner, repo, issueNumber, [to]);
  } catch (err) {
    // The old label stays exactly where it was — which is the point. The issue
    // is still in its previous stage, which is a true statement about it, and
    // whatever queries that stage will find it again.
    log.warn("stage advance failed to apply the new label; leaving the old stage in place", {
      owner,
      repo,
      issueNumber,
      from,
      to,
      err,
    });
    return { advanced: false, added: false, removed: false, reason: "add-failed" };
  }

  // Entering the pipeline (no `from`), or a no-op advance onto the same label:
  // nothing to take off.
  if (!from || from === to) {
    await removeStale();
    return { advanced: true, added: true, removed: false };
  }

  // 2. Only now the old one.
  try {
    await deps.github.removeLabel(owner, repo, issueNumber, from);
  } catch (err) {
    // Both labels on the issue. Tolerable and visible — the advance itself
    // stands, and a human or the next advance reconciles it.
    log.warn("stage advance applied the new label but could not remove the old one", {
      owner,
      repo,
      issueNumber,
      from,
      to,
      err,
    });
    await removeStale();
    return { advanced: true, added: true, removed: false, reason: "remove-failed" };
  }

  await removeStale();
  return { advanced: true, added: true, removed: true };
}

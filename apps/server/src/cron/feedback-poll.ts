import type { StateDb, WorkflowRun } from "../state/db.js";
import type { FeedbackCandidate, ReactionRead } from "../engine/github/github.js";
import { REACTION_BATCH_SIZE } from "../engine/github/github.js";
import { canonicalReaction, isSelfReactor } from "../engine/feedback/reactions.js";
import { ingestReaction, type FeedbackIngestDeps } from "../engine/feedback/ingest.js";
import { logger } from "../logging/logger.js";

const log = logger("feedback-poll");

/**
 * The GitHub half of feedback signals (issue #255).
 *
 * GitHub delivers **no webhook for reactions** — there is no `reaction` event,
 * and no action on `issue_comment` covers one. So unlike Slack, a 👍 on a bot
 * comment has to be discovered by asking. The design exists to make that asking
 * cheap enough to be uncontroversial, in two halves:
 *
 * 1. **Discovery, once per run.** When a run finishes we list what it posted
 *    and record each comment as an anchor. This is the only per-run cost, it is
 *    scoped by `since` to the run's own window, and it is where attribution
 *    happens — while we still know which run wrote what.
 *
 * 2. **Refresh, on a cron.** The recurring half reads reactions for up to
 *    `maxAnchorsPerTick` anchors, 100 at a time, through ONE batched GraphQL
 *    query per 100 — measured at **one rate-limit point per request**, with the
 *    reactors included. A steady state of ~840 live anchors is therefore ~9
 *    points a tick against a 5,000/hour budget.
 *
 * What bounds it is the *data*, not the schedule: we poll individual bot
 * comments, never issues; an anchor ages out of the rotation after
 * `windowDays`; and the per-tick cap is a hard number of requests rather than a
 * hope. That is the difference between this and "poll GitHub forever".
 */

/** The narrow slice of {@link import("../engine/github/github.js").GitHubClient} this needs. */
export interface FeedbackGitHubClient {
  listBotComments(
    owner: string,
    repo: string,
    issueNumber: number,
    opts: { botLogin: string; isPr?: boolean; since?: string },
  ): Promise<FeedbackCandidate[]>;
  fetchReactions(owner: string, nodeIds: string[]): Promise<Map<string, ReactionRead[]>>;
}

export interface FeedbackPollDeps extends FeedbackIngestDeps {
  github: FeedbackGitHubClient;
  windowDays: number;
  maxAnchorsPerTick: number;
  retentionDays: number;
}

export interface PollResult {
  anchorsPolled: number;
  requests: number;
  added: number;
  retracted: number;
  pruned: number;
}

/**
 * Discover what a finished run posted, and register each piece as an anchor.
 *
 * Attribution happens HERE and nowhere else, because this is the only moment
 * the association is free: we are holding the run. Later — at reaction time, on
 * a cron tick, in the dashboard — the only way back would be to guess from
 * timestamps.
 *
 * Best-effort and fire-and-forget: it hangs off the terminal-run observer,
 * whose contract is that the transition is already persisted and no projection
 * of it may fail the run.
 */
export async function discoverRunAnchors(
  deps: Pick<FeedbackPollDeps, "db" | "github" | "botLogin">,
  run: WorkflowRun,
): Promise<number> {
  const { owner, repo, issueNumber } = run;
  if (!owner || !repo || !issueNumber || !deps.botLogin) return 0;

  try {
    const candidates = await deps.github.listBotComments(owner, repo, issueNumber, {
      botLogin: deps.botLogin,
      // A `review_comment` can only exist on a PR, and asking for one on a
      // plain issue is a guaranteed 404. `pr-review` is the workflow whose
      // findings we most want scored, so getting this right matters.
      isPr: isPullRequestRun(run),
      // Only what THIS run wrote. Without it, a PR with a long comment history
      // re-lists everything on every run, and every old comment is re-attributed
      // to whichever run happened to finish last.
      since: run.startedAt,
    });

    let created = 0;
    for (const candidate of candidates) {
      // A comment posted before the run started is not this run's output —
      // `since` filters on `updated_at`, so an EDITED old comment still shows up.
      if (candidate.createdAt < run.startedAt) continue;
      await deps.db.feedback.upsertAnchor({
        source: "github",
        kind: candidate.kind,
        externalId: candidate.externalId,
        nodeId: candidate.nodeId,
        channel: null,
        owner,
        repo,
        issueNumber,
        workflowRunId: run.id,
        workflowName: run.workflowName,
        messagingSessionId: null,
        createdAt: candidate.createdAt,
      });
      created += 1;
    }
    if (created > 0) {
      log.debug("Registered feedback anchors for a finished run", {
        runId: run.id,
        workflow: run.workflowName,
        anchors: created,
      });
    }
    return created;
  } catch (err: unknown) {
    log.warn("Anchor discovery failed", { runId: run.id, repo: `${owner}/${repo}`, err });
    return 0;
  }
}

/**
 * Is this run's subject a pull request? Read off the run's own context rather
 * than asked of GitHub — `prNumber` is set by every PR-scoped dispatch, and an
 * extra API call to re-learn what we already recorded would defeat the point.
 */
function isPullRequestRun(run: WorkflowRun): boolean {
  const ctx = run.context as { prNumber?: unknown } | undefined;
  return typeof ctx?.prNumber === "number";
}

/**
 * One poll tick: refresh reactions for the least-recently-polled anchors.
 *
 * Grouped by owner because each installation has its own token and its own
 * rate-limit budget — batching across owners into one query is not possible,
 * and would hide whose budget was being spent.
 */
export async function pollFeedbackReactions(deps: FeedbackPollDeps): Promise<PollResult> {
  const result: PollResult = { anchorsPolled: 0, requests: 0, added: 0, retracted: 0, pruned: 0 };

  const anchors = await deps.db.feedback.anchorsToPoll({
    windowDays: deps.windowDays,
    limit: deps.maxAnchorsPerTick,
  });

  const byOwner = new Map<string, typeof anchors>();
  for (const anchor of anchors) {
    if (!anchor.owner || !anchor.nodeId) continue;
    const list = byOwner.get(anchor.owner) ?? [];
    list.push(anchor);
    byOwner.set(anchor.owner, list);
  }

  for (const [owner, ownerAnchors] of byOwner) {
    for (let i = 0; i < ownerAnchors.length; i += REACTION_BATCH_SIZE) {
      const batch = ownerAnchors.slice(i, i + REACTION_BATCH_SIZE);
      let reads: Map<string, ReactionRead[]>;
      try {
        reads = await deps.github.fetchReactions(owner, batch.map((a) => a.nodeId!));
        result.requests += 1;
      } catch (err: unknown) {
        // Leave `last_polled_at` untouched so this batch is first in line next
        // tick rather than rotating to the back of the queue.
        log.warn("Reaction batch failed", { owner, anchors: batch.length, err });
        continue;
      }

      for (const anchor of batch) {
        const reactions = reads.get(anchor.nodeId!);
        // A node GitHub didn't return is a deleted comment. Its anchor ages out
        // on its own; retracting its signals would misreport "they changed
        // their mind" when the comment simply went away.
        if (!reactions) continue;

        const live: Array<{ reactor: string | null; emoji: string }> = [];
        for (const reaction of reactions) {
          if (isSelfReactor(reaction.reactor, deps.botLogin)) continue;
          const emoji = canonicalReaction(reaction.content, "github");
          live.push({ reactor: reaction.reactor, emoji });
          if (await ingestReaction(deps, {
            anchor,
            source: "github",
            emoji: reaction.content,
            reactor: reaction.reactor,
          })) {
            result.added += 1;
          }
        }
        // Absence from a fresh read is the ONLY evidence a reaction was
        // removed — there is no event for it.
        result.retracted += await deps.db.feedback.reconcileAnchor(anchor.id, live);
      }

      await deps.db.feedback.markPolled(batch.map((a) => a.id));
      result.anchorsPolled += batch.length;
    }
  }

  result.pruned = await deps.db.feedback.pruneAnchors(deps.retentionDays);

  if (result.added || result.retracted) {
    log.info("Feedback poll", { ...result });
  } else {
    log.debug("Feedback poll", { ...result });
  }
  return result;
}

/** Convenience for the boot wiring — the terminal-run observer's body. */
export function feedbackAnchorObserver(
  deps: Pick<FeedbackPollDeps, "db" | "github" | "botLogin">,
): (run: WorkflowRun) => void {
  return (run) => {
    void discoverRunAnchors(deps, run).catch((err: unknown) => {
      log.warn("Anchor discovery rejected", { runId: run.id, err });
    });
  };
}


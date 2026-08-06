import type { StateDb } from "../../state/db.js";
import type { FeedbackAnchor, FeedbackSignal } from "../../state/feedback-store.js";
import { recordFeedbackSignal } from "../../telemetry/feedback.js";
import { isTelemetryEnabled } from "../../telemetry/index.js";
import { logger } from "../../logging/logger.js";
import { canonicalReaction, isSelfReactor, scoreReaction, type FeedbackSource } from "./reactions.js";

const log = logger("feedback");

/**
 * The one way a reaction becomes a signal (issue #255).
 *
 * Both surfaces funnel through here — Slack's live `reaction_added` and the
 * GitHub poller's batch reconciliation — so scoring, self-reaction filtering,
 * persistence and telemetry happen once, in one order, with one set of rules.
 * A second copy of this sequence is how the two surfaces would quietly start
 * disagreeing about what a 👍 is worth.
 *
 * Everything here is best-effort by contract: a reaction is a nicety, and
 * nothing about recording one may throw into a webhook handler or fail a cron
 * tick.
 */

export interface FeedbackIngestDeps {
  db: StateDb;
  /** `<botName>[bot]`. Reactions from the bot itself are never feedback. */
  botLogin?: string;
  /** `feedback.otel` — export each new signal as a span on the run's trace. */
  otel?: boolean;
}

export interface ReactionInput {
  anchor: FeedbackAnchor;
  source: FeedbackSource;
  /** Raw name as the platform spelled it (`+1::skin-tone-3`, `THUMBS_UP`, …). */
  emoji: string;
  reactor?: string;
  reactedAt?: string;
}

/**
 * Record a reaction. Returns the signal when it was NEW (so the caller can log
 * it), and null when it was scored away, self-authored, or already known.
 */
export function ingestReaction(deps: FeedbackIngestDeps, input: ReactionInput): FeedbackSignal | null {
  try {
    if (isSelfReactor(input.reactor, deps.botLogin)) return null;
    const scored = scoreReaction(input.emoji, input.source);
    if (!scored) {
      log.debug("Ignoring a reaction outside the feedback vocabulary", {
        emoji: input.emoji,
        source: input.source,
      });
      return null;
    }

    const signal = deps.db.feedback.recordSignal({
      anchor: input.anchor,
      emoji: scored.emoji,
      score: scored.score,
      sentiment: scored.sentiment,
      reactor: input.reactor,
      reactedAt: input.reactedAt,
    });
    // Already live — a Slack redelivery or the poller re-reading the same
    // reaction. Nothing happened, so nothing is exported.
    if (!signal) return null;

    log.info("Feedback signal", {
      source: signal.source,
      emoji: signal.emoji,
      score: signal.score,
      workflow: signal.workflowName ?? undefined,
      workflowRunId: signal.workflowRunId ?? undefined,
      repo: signal.repo ?? undefined,
    });

    if (deps.otel !== false) exportSignal(deps.db, signal, input.anchor);
    return signal;
  } catch (err: unknown) {
    log.warn("Failed to ingest a reaction", { source: input.source, err });
    return null;
  }
}

/** Retract a reaction that has been taken away. Returns true when one was live. */
export function retractReaction(deps: FeedbackIngestDeps, input: ReactionInput): boolean {
  try {
    const emoji = canonicalReaction(input.emoji, input.source);
    const removed = deps.db.feedback.removeSignal(
      input.anchor.id,
      input.reactor ?? null,
      emoji,
      input.reactedAt,
    );
    if (removed) {
      log.info("Feedback signal retracted", {
        source: input.source,
        emoji,
        workflowRunId: input.anchor.workflowRunId ?? undefined,
      });
    }
    return removed;
  } catch (err: unknown) {
    log.warn("Failed to retract a reaction", { source: input.source, err });
    return false;
  }
}

/**
 * Export one signal and stamp the watermark. The run row supplies the trace to
 * attach to; a run whose trace we can't read (it ran with telemetry off) exports
 * as its own root span rather than not at all.
 *
 * **The watermark is only stamped when a span was actually emitted.** With
 * telemetry disabled `recordFeedbackSignal` is a no-op, and marking those rows
 * exported would quietly discard them: turning OTel on later would find an
 * empty backlog and the whole pre-OTel history would be unrepresented in the
 * backend forever. Leaving them unmarked is what makes {@link drainFeedbackExport}
 * able to catch up.
 */
export function exportSignal(db: StateDb, signal: FeedbackSignal, anchor: FeedbackAnchor): void {
  if (!isTelemetryEnabled()) return;
  let parent: { traceId: string; spanId: string } | undefined;
  if (signal.workflowRunId) {
    const run = db.runs.getRun(signal.workflowRunId);
    if (run?.traceId && run.spanId) parent = { traceId: run.traceId, spanId: run.spanId };
  }
  recordFeedbackSignal({ signal, anchor, anchorUrl: anchorUrl(anchor), parent });
  db.feedback.markExported([signal.id]);
}

/**
 * Export every signal recorded while telemetry was off. Called once at boot,
 * after the SDK starts.
 *
 * This is the payoff for the watermark being honest: an operator who enables
 * OTel today gets the feedback they already collected, on the traces it belongs
 * to, instead of a backend that starts from zero. Bounded per boot so a long
 * backlog drains over a few restarts rather than stalling startup.
 */
export function drainFeedbackExport(db: StateDb, limit = 500): number {
  if (!isTelemetryEnabled()) return 0;
  let exported = 0;
  try {
    for (const signal of db.feedback.pendingExport(limit)) {
      const anchor = db.feedback.getAnchor(signal.anchorId);
      // The anchor was pruned past `retentionDays` while the signal outlived it
      // (signals are kept forever). Mark it done rather than re-reading it on
      // every boot for a span we can no longer describe.
      if (!anchor) {
        db.feedback.markExported([signal.id]);
        continue;
      }
      exportSignal(db, signal, anchor);
      exported += 1;
    }
    if (exported > 0) log.info("Exported backlogged feedback signals", { exported });
  } catch (err: unknown) {
    log.warn("Feedback export backlog drain failed", { err });
  }
  return exported;
}

/**
 * A deep link to the thing that was reacted to, when the platform gives us one
 * that resolves without a workspace-specific base. GitHub comment permalinks
 * are derivable from the ids we already hold; a Slack permalink needs the
 * team's domain and an API round-trip, so those go unlinked rather than wrong.
 */
function anchorUrl(anchor: FeedbackAnchor): string | undefined {
  if (anchor.source !== "github" || !anchor.owner || !anchor.repo || !anchor.issueNumber) {
    return undefined;
  }
  const base = `https://github.com/${anchor.owner}/${anchor.repo}`;
  switch (anchor.kind) {
    case "issue_comment":
      return `${base}/issues/${anchor.issueNumber}#issuecomment-${anchor.externalId}`;
    case "review_comment":
      return `${base}/pull/${anchor.issueNumber}#discussion_r${anchor.externalId}`;
    case "issue":
      return `${base}/issues/${anchor.issueNumber}`;
    default:
      return undefined;
  }
}

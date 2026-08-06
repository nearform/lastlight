import type { StateDb } from "../../state/db.js";
import type { FeedbackAnchor } from "../../state/feedback-store.js";
import { logger } from "../../logging/logger.js";
import { ingestReaction, retractReaction, type FeedbackIngestDeps } from "./ingest.js";

const log = logger("feedback");

/**
 * The Slack half of feedback signals (issue #255).
 *
 * Slack is the surface that works properly: `reaction_added` is a real event,
 * so a 👍 becomes a scored signal within a second of the click, with no polling
 * and no API budget. The catch is attribution — the event names a message
 * (`item.channel` + `item.ts`) and says nothing about a workflow run — which is
 * why every bot message is registered as an ANCHOR when we post it. The ts
 * exists for exactly one moment, in the `chat.postMessage` response, and used
 * to be discarded at every send site.
 *
 * The alternative would be resolving the message's thread at reaction time via
 * `conversations.replies` and matching the thread to a run. That costs an API
 * call per reaction, needs a `channels:history`-class scope we deliberately
 * don't hold, and can only ever identify the THREAD — so a thread with several
 * runs in it could not say which one was being praised.
 */

/** A `reaction_added` / `reaction_removed` payload, narrowed to what we use. */
export interface SlackReactionEvent {
  type: string;
  /** The reacting user. */
  user?: string;
  /** Emoji name, possibly with a `::skin-tone-N` suffix. */
  reaction?: string;
  /** Author of the reacted-to item — our bot, for anything we can score. */
  item_user?: string;
  item?: { type?: string; channel?: string; ts?: string };
  event_ts?: string;
}

export interface SlackFeedbackDeps extends FeedbackIngestDeps {
  /**
   * `SLACK_ALLOWED_USERS`. Empty means everyone, matching the messaging
   * connector's own rule — applied here too because a reaction handler is a
   * second door into the same instance, and the gate belongs on both.
   */
  allowedUsers?: string[];
}

/** Register a message the bot just posted as a reaction target. */
export function registerSlackAnchor(
  db: StateDb,
  input: {
    channelId: string;
    threadId?: string | null;
    messageId: string;
    workflowRunId?: string;
    workflowName?: string;
    messagingSessionId?: string;
  },
): FeedbackAnchor | null {
  try {
    return db.feedback.upsertAnchor({
      source: "slack",
      kind: "slack_message",
      externalId: input.messageId,
      nodeId: null,
      channel: input.channelId,
      owner: null,
      repo: null,
      issueNumber: null,
      workflowRunId: input.workflowRunId ?? null,
      workflowName: input.workflowName ?? null,
      messagingSessionId: input.messagingSessionId ?? null,
    });
  } catch (err: unknown) {
    log.warn("Failed to register a Slack feedback anchor", { channel: input.channelId, err });
    return null;
  }
}

/**
 * Handle one Slack reaction event. Returns true when it produced a change.
 *
 * Unknown messages are dropped in silence-but-for-a-debug-line: most reactions
 * in a channel are on other people's messages, and the anchor lookup is a
 * single indexed read, so this is the cheap common case rather than an error.
 */
export function handleSlackReaction(deps: SlackFeedbackDeps, event: SlackReactionEvent): boolean {
  const channel = event.item?.channel;
  const ts = event.item?.ts;
  if (!channel || !ts || !event.reaction) return false;
  if (event.item?.type && event.item.type !== "message") return false;

  if (deps.allowedUsers?.length && event.user && !deps.allowedUsers.includes(event.user)) {
    log.info("Ignoring a reaction from an unauthorized user", { user: event.user });
    return false;
  }

  const anchor = deps.db.feedback.findAnchor("slack", channel, ts);
  if (!anchor) {
    log.debug("Reaction on a message we have no anchor for", { channel, ts });
    return false;
  }

  const common = {
    anchor,
    source: "slack" as const,
    emoji: event.reaction,
    reactor: event.user,
    reactedAt: slackTsToIso(event.event_ts),
  };
  return event.type === "reaction_removed"
    ? retractReaction(deps, common)
    : ingestReaction(deps, common) !== null;
}

/**
 * Slack timestamps are `<epoch seconds>.<6-digit sequence>` — a message id that
 * happens to sort chronologically, not a date. Undefined on a malformed value
 * so the store falls back to "now" rather than storing a bogus instant.
 */
function slackTsToIso(ts: string | undefined): string | undefined {
  if (!ts) return undefined;
  const seconds = Number.parseFloat(ts);
  if (!Number.isFinite(seconds)) return undefined;
  return new Date(seconds * 1000).toISOString();
}

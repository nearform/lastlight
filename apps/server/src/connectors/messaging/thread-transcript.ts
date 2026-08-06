import type { EventEnvelope } from "../types.js";
import type { SessionManager } from "./session-manager.js";
import { logger } from "../../logging/logger.js";

const log = logger("messaging");

/**
 * Per-message cap on what we write into `messaging_messages`. The store feeds
 * `ChatRunner`'s rehydrated context, so an unbounded workflow report (a health
 * summary, a review write-up) would otherwise dominate the next chat turn's
 * prompt. The tail is what a follow-up question usually refers back to, so the
 * HEAD is what gets cut.
 */
export const MAX_TRANSCRIPT_CHARS = 4000;

const ELLIPSIS = "…(truncated)…\n";

function clamp(text: string): string {
  if (text.length <= MAX_TRANSCRIPT_CHARS) return text;
  return ELLIPSIS + text.slice(-(MAX_TRANSCRIPT_CHARS - ELLIPSIS.length));
}

/**
 * Append one message to a messaging thread's conversation and refresh the
 * session's activity clock.
 *
 * Best-effort by construction: the transcript is context for the NEXT turn, so
 * a write that fails must never fail the turn that produced it.
 */
export function recordThreadMessage(
  sessionManager: SessionManager,
  sessionId: string,
  role: "user" | "assistant",
  text: string,
): void {
  const body = text?.trim();
  if (!body) return;
  try {
    sessionManager.addMessage(sessionId, role, clamp(body));
    // The activity clock is what keeps the thread's session out of
    // `SESSION_TIMEOUT_MS` staleness. Without it a thread carried entirely by
    // workflow turns silently re-keys to a fresh session mid-conversation.
    sessionManager.touchSession(sessionId);
  } catch (err) {
    log.warn("Failed to record thread message", { role, err });
  }
}

/**
 * Same, addressed by thread rather than by session id — for the workflow
 * runner's `postComment`, which knows the channel + thread it is posting into
 * but never sees the messaging session.
 */
export function recordThreadMessageForThread(
  sessionManager: SessionManager,
  platform: string,
  channelId: string,
  threadId: string,
  role: "user" | "assistant",
  text: string,
): void {
  let session;
  try {
    // `includeStale`: the run that produced this message may well have outlived
    // the session's inactivity window. Recording touches the session, which
    // revives it — so the thread continues rather than re-keying.
    session = sessionManager.findActiveThreadSession(platform, channelId, threadId, {
      includeStale: true,
    });
  } catch (err) {
    log.warn("Failed to resolve thread session", { platform, err });
    return;
  }
  if (!session) return;
  recordThreadMessage(sessionManager, session.id, role, text);
}

/**
 * Make a messaging envelope keep a transcript of its own turn.
 *
 * Conversation persistence used to live in the connector, was moved wholesale
 * into `ChatRunner` to stop the chat path double-writing every turn — and
 * `ChatRunner` runs on the chat path ONLY. So a Slack message the classifier
 * routed to a workflow (`answer`, `build`, `explore`, …) left no trace at all:
 * the next chat turn in the SAME thread rehydrated an empty history and
 * answered as if the thread had just started.
 *
 * This restores the record for exactly the paths `ChatRunner` does not own —
 * the inbound message, plus every reply the harness posts back through the
 * envelope. The two writers stay mutually exclusive per turn (the caller skips
 * the wrap for chat), so the double-write is not reintroduced.
 *
 * The workflow's own output reaches the thread through the runner's
 * `postComment` instead of `reply`, and is recorded there via
 * `recordThreadMessageForThread`.
 *
 * A non-messaging envelope, or one with no session (the CLI `/api/chat` route
 * never touches a connector), is returned unchanged.
 */
export function withThreadTranscript(
  envelope: EventEnvelope,
  sessionManager: SessionManager,
): EventEnvelope {
  if (envelope.type !== "message") return envelope;
  const raw = envelope.raw as { sessionId?: unknown } | undefined;
  const sessionId = typeof raw?.sessionId === "string" ? raw.sessionId : undefined;
  if (!sessionId) return envelope;

  recordThreadMessage(sessionManager, sessionId, "user", envelope.body);

  const reply = envelope.reply;
  return {
    ...envelope,
    reply: async (msg: string) => {
      // Send FIRST: the user-visible message is the point, the transcript is a
      // side effect. A throw here propagates as it always did.
      await reply(msg);
      recordThreadMessage(sessionManager, sessionId, "assistant", msg);
    },
  };
}

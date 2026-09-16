import { api, ApiError, type BoardCard, type BoardCardAction } from "../../api";
import { stageMoveOutcome } from "./stageDrop";

/**
 * What a board action MEANS, and how to perform it.
 *
 * Split out of the menu component and kept pure so the mapping is readable
 * (and testable, once this package has anywhere to put a test) without a DOM:
 * {@link intentForAction} is a total function from the server's action
 * descriptor onto one of the calls the admin API actually offers, and
 * {@link performIntent} is the only place that calls them.
 *
 * ## What this file does NOT decide
 *
 * Whether an action is allowed. `enabled` / `disabledReason` are computed
 * server-side — it is the side that knows the hold label, the run lock and the
 * route map — and re-deriving either here would be the #256 defect class in a
 * new place. The menu renders the server's verdict; this file only routes the
 * ones the operator is allowed to press.
 *
 * ## Ids first, then kinds
 *
 * The server sends both an `id` (`approve`, `cancel`, `dispatch`, …) and a
 * coarser `kind` (`approval`, `run`, `dispatch`, `link`). Matching on the id
 * and falling back to the kind means a server that adds `approve-with-note`
 * still lands somewhere sensible, and one that invents a whole new kind
 * degrades to an explicit "this dashboard doesn't know that action" rather
 * than to a button that silently does nothing.
 */
export type CardIntent =
  /** Navigation, not mutation — opens GitHub in a new tab. */
  | { kind: "open"; url: string }
  | { kind: "approve"; approvalId: string }
  | { kind: "reject"; approvalId: string }
  | { kind: "cancelRun"; runId: string }
  | { kind: "retryRun"; runId: string }
  | { kind: "dispatchIssue"; repo: string; number: number }
  /**
   * Move a parked card back to its stage's entry column, which the server then
   * treats as a human asking for a build. Distinct from `retryRun`, which
   * resumes the SAME run from the phase that failed.
   */
  | { kind: "unblockIssue"; repo: string; number: number; to: string; from: string }
  /** Known to the server, not to this build of the dashboard. */
  | { kind: "unsupported"; reason: string };

/** The subject an intent acts on — the identity fields of a card. */
export interface CardSubject {
  repo: string;
  number: number;
  url: string;
  runId: string | null;
  approvalId: string | null;
  /** The label the card is filed under now — the `from` of a stage move. */
  stageLabel: string;
}

/** Read a card's identity defensively — same discipline as `BoardCard`. */
export function subjectOf(card: BoardCard): CardSubject {
  const run = card.run && typeof card.run === "object" ? card.run : null;
  const approval = card.approval && typeof card.approval === "object" ? card.approval : null;
  return {
    repo: typeof card.repo === "string" ? card.repo : "",
    number: typeof card.number === "number" ? card.number : 0,
    url: typeof card.url === "string" ? card.url : "",
    runId: typeof run?.id === "string" && run.id ? run.id : null,
    approvalId: typeof approval?.id === "string" && approval.id ? approval.id : null,
    stageLabel: typeof card.stageLabel === "string" ? card.stageLabel : "",
  };
}

export function intentForAction(action: BoardCardAction, subject: CardSubject): CardIntent {
  const id = typeof action?.id === "string" ? action.id : "";
  const kind = typeof action?.kind === "string" ? action.kind : "";

  if (id === "open" || kind === "link") {
    return subject.url
      ? { kind: "open", url: subject.url }
      : { kind: "unsupported", reason: "This card has no GitHub link." };
  }

  if (id === "approve" || id === "reject" || kind === "approval") {
    if (!subject.approvalId) {
      return { kind: "unsupported", reason: "This card has no pending approval to answer." };
    }
    if (id === "reject") return { kind: "reject", approvalId: subject.approvalId };
    if (id === "approve") return { kind: "approve", approvalId: subject.approvalId };
    return { kind: "unsupported", reason: `Unknown approval action "${id}".` };
  }

  if (id === "unblock" || kind === "stage") {
    // `to` is the server's, never ours: stage labels are operator-configured,
    // so a client picking "the first column" would be re-deriving policy it
    // cannot see.
    const to = typeof action?.to === "string" ? action.to : "";
    if (!to) return { kind: "unsupported", reason: "The server named no column to move this card to." };
    return { kind: "unblockIssue", repo: subject.repo, number: subject.number, to, from: subject.stageLabel };
  }

  if (id === "cancel") {
    return subject.runId
      ? { kind: "cancelRun", runId: subject.runId }
      : { kind: "unsupported", reason: "No run on this card to cancel." };
  }

  if (id === "retry" || kind === "run") {
    // A run id is what the run-scoped retry needs. The board holds issues
    // only, so there is no PR-retry fallback here.
    if (subject.runId) return { kind: "retryRun", runId: subject.runId };
    return { kind: "unsupported", reason: "No run on this card to retry." };
  }

  if (id === "dispatch" || kind === "dispatch") {
    return { kind: "dispatchIssue", repo: subject.repo, number: subject.number };
  }

  return { kind: "unsupported", reason: `This dashboard does not know the action "${id || kind}".` };
}

/** Actions that take a human's reason before firing — the approval pair. */
export function needsReason(intent: CardIntent): boolean {
  return intent.kind === "approve" || intent.kind === "reject";
}

/**
 * Actions worth a second press. Cancelling stops work that is running now and
 * there is no undo; nothing else here destroys anything.
 */
export function needsConfirm(intent: CardIntent): boolean {
  return intent.kind === "cancelRun";
}

/** True for the one intent that navigates instead of mutating. */
export function isNavigation(intent: CardIntent): boolean {
  return intent.kind === "open";
}

/**
 * Perform an intent. Resolves with an optional note worth telling the operator
 * on SUCCESS (a parked PR retry is the one case: it is a 200, but nothing is
 * running yet and a board that showed no change would look broken).
 *
 * Rejects with an {@link ApiError} for anything the server refused — the caller
 * shows `message` as-is.
 */
export async function performIntent(
  intent: CardIntent,
  opts: { reason?: string } = {},
): Promise<{ note?: string }> {
  const reason = opts.reason?.trim() ? opts.reason.trim() : undefined;
  switch (intent.kind) {
    case "open":
      window.open(intent.url, "_blank", "noopener,noreferrer");
      return {};
    case "approve":
      await api.respondToApproval(intent.approvalId, "approved", reason);
      return {};
    case "reject":
      await api.respondToApproval(intent.approvalId, "rejected", reason);
      return {};
    case "cancelRun":
      await api.cancelWorkflowRun(intent.runId);
      return {};
    case "retryRun":
      await api.retryWorkflowRun(intent.runId);
      return {};
    case "dispatchIssue":
      await api.dispatchIssue(intent.repo, intent.number, reason ? { reason } : {});
      return {};
    case "unblockIssue": {
      // The SAME request the drag gesture makes, so both inherit one gate and
      // one set of refusals — including the note when the gate says no.
      const res = await api.moveIssueStage(intent.repo, intent.number, intent.to, intent.from);
      const { note } = stageMoveOutcome(res, intent.to);
      return note ? { note } : {};
    }
    case "unsupported":
      throw new Error(intent.reason);
  }
}

/**
 * The sentence to put in front of the operator when an action fails.
 *
 * A 409 is not noise to swallow: it is the gate explaining itself in the same
 * words the bot would have used on the issue, and it is the most useful thing
 * the board can say. Everything else falls back to whatever the error carries.
 */
export function failureMessage(err: unknown): string {
  if (err instanceof ApiError) return err.message;
  if (err instanceof Error) return err.message;
  return String(err);
}

import { api, type BoardCard, type BoardColumn } from "../../api";
import type { CardFeedback } from "./CardActionMenu";

/**
 * What DRAGGING a card onto a column means, and how to perform it.
 *
 * The peer of `cardActions.ts`, and pure for the same reason: the decision —
 * is this drop a move at all, where does it go, and is there anything the
 * operator needs told afterwards — is a total function over two values, so it
 * is readable and testable without a DOM. The component layer does the HTML5
 * drag plumbing and nothing else.
 *
 * ## What the server decides, not this file
 *
 * Whether the move is ALLOWED. The endpoint answers `400` for a label that is
 * not a configured stage and `409` when the hold label refuses — and that 409
 * is the gate explaining itself in the same words the bot would have posted, so
 * it renders verbatim on the card (`failureMessage` → the feedback banner).
 * The one thing this file refuses up front is a HELD card, and only because
 * offering a gesture the server is certain to reject is worse than not offering
 * it: a held card is not draggable, so the refusal never has to be shown.
 *
 * ## The note comes from the SERVER, not from here
 *
 * `POST …/stage` writes a label AND, on a stage's `enter` or `running` column,
 * dispatches a build. Whether one actually started is the gate's answer — a
 * budget ceiling or a run already in flight refuses it — and that answer is
 * only knowable server-side. So {@link performStageMove} reads `dispatched` /
 * `dispatchReason` off the response and turns them into the banner sentence.
 *
 * This file used to guess instead, from the card's run plus "is this the entry
 * column", because the endpoint did not dispatch and an already-built issue
 * silently started nothing. Both halves of that are now false. A guess derived
 * from a board snapshot up to two minutes stale is exactly the class of
 * second-policy-free-to-drift the server-computed `actions` exist to avoid.
 */

/** The identity a dragged card carries — the whole drag payload. */
export interface DraggedCard {
  /** `owner/repo#123`. */
  key: string;
  repo: string;
  number: number;
  /** The stage label the card carries now; `""` when it is unstaged. */
  stageLabel: string;
  /** The hold label is applied — this card may not be dragged. */
  held: boolean;
}

/** The column under the cursor. */
export interface DropTarget {
  /** The stage label to write. `""` is the unstaged column — remove, add none. */
  label: string;
}

/** A drop that changes nothing, and which of the three reasons it was. */
export interface StageDropNoop {
  kind: "noop";
  reason: "no-card" | "held" | "same-column";
}

/** A drop that writes a label. `to: ""` means "move to unstaged". */
export interface StageDropMove {
  kind: "move";
  to: string;
  from: string;
}

export type StageDrop = StageDropNoop | StageDropMove;

/** The dataTransfer type. Namespaced so nothing else's drag looks like ours. */
export const DRAG_MIME = "application/x-lastlight-board-card";

/**
 * Read a card's drag identity defensively — same discipline as `BoardCard`,
 * for the same reason: `api.ts` hand-mirrors the wire shape and a mirror is
 * free to drift from the endpoint (#256).
 */
export function draggedCardOf(card: BoardCard): DraggedCard {
  return {
    key: typeof card?.key === "string" ? card.key : "",
    repo: typeof card?.repo === "string" ? card.repo : "",
    number: typeof card?.number === "number" ? card.number : 0,
    stageLabel: typeof card?.stageLabel === "string" ? card.stageLabel : "",
    held: card?.held === true,
  };
}

/** A held card cannot be dragged at all — the server would refuse it anyway. */
export function isDraggable(card: BoardCard): boolean {
  return card?.held !== true;
}

/** Serialize for `dataTransfer.setData`. */
export function encodeDragPayload(dragged: DraggedCard): string {
  return JSON.stringify(dragged);
}

/**
 * Parse what came back out of `dataTransfer`. Total: anything that is not one
 * of our payloads is `null`, which every consumer treats as "nothing dragged".
 */
export function decodeDragPayload(raw: unknown): DraggedCard | null {
  if (typeof raw !== "string" || !raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  // Coerced against the DraggedCard shape, not the card's: the payload is a
  // flat identity, and reading it back through `draggedCardOf` would demand a
  // whole BoardCard we do not have here.
  const p = parsed as Record<string, unknown>;
  const dragged: DraggedCard = {
    key: typeof p.key === "string" ? p.key : "",
    repo: typeof p.repo === "string" ? p.repo : "",
    number: typeof p.number === "number" ? p.number : 0,
    stageLabel: typeof p.stageLabel === "string" ? p.stageLabel : "",
    held: p.held === true,
  };
  return dragged.key && dragged.repo && dragged.number > 0 ? dragged : null;
}

/**
 * The whole decision: what a drop of `dragged` onto `target` should do.
 *
 * Total, and `noop` on every case that should cost no request — nothing being
 * dragged, a held card, and the column the card is already in (a "move" there
 * would write the label it already has and burn a GitHub write for no change).
 */
export function resolveStageDrop(dragged: DraggedCard | null, target: DropTarget): StageDrop {
  if (!dragged || !dragged.key) return { kind: "noop", reason: "no-card" };
  if (dragged.held) return { kind: "noop", reason: "held" };
  const to = typeof target?.label === "string" ? target.label : "";
  const from = dragged.stageLabel;
  if (to === from) return { kind: "noop", reason: "same-column" };
  return { kind: "move", to, from };
}

/** What the move turned out to be, once the server answered. */
export interface StageMoveOutcome {
  /** The sentence for the card's info banner, when there is one worth saying. */
  note?: string;
  /** Where the card actually landed, when that differs from the drop target. */
  landedLabel?: string;
}

/**
 * Reasons that are the ORDINARY answer and not worth a banner: dropping on a
 * terminal column or re-dropping a card in the stage it already occupies are
 * both "nothing to build here", which the board already shows by moving it.
 */
const QUIET_DISPATCH_REASON = /^(terminal-column|already-in-stage|unconfigured-label):/;

/**
 * Perform a move. Resolves with what the operator needs told, and rejects with
 * the {@link ApiError} for anything the server refused — the caller shows
 * `message` as-is, which is how the 409 reaches the card verbatim.
 *
 * A gate refusal is NOT a rejection: the move succeeded and the build did not,
 * which is a 200 carrying `dispatchReason`. Surfacing it is the whole point —
 * "the budget said no" and "nothing happened" must not look the same.
 */
export function stageMoveOutcome(
  res: { dispatched?: boolean; dispatchReason?: string; landedLabel?: string } | undefined,
  to: string,
): StageMoveOutcome {
  const landed = typeof res?.landedLabel === "string" ? res.landedLabel : undefined;
  const landedLabel = landed && landed !== to ? landed : undefined;

  if (res?.dispatched === true) {
    // The entry column is gated before any label is written, so a dispatched
    // build has already advanced the issue past the column it was asked for.
    return {
      note: landedLabel ? `Build started — the card moved to \`${landedLabel}\`.` : "Build started.",
      ...(landedLabel ? { landedLabel } : {}),
    };
  }

  const reason = typeof res?.dispatchReason === "string" ? res.dispatchReason : "";
  if (reason && !QUIET_DISPATCH_REASON.test(reason)) {
    return { note: `Label set, but no build started — ${reason}`, ...(landedLabel ? { landedLabel } : {}) };
  }
  return landedLabel ? { landedLabel } : {};
}

export async function performStageMove(
  dragged: DraggedCard,
  move: StageDropMove,
): Promise<StageMoveOutcome> {
  const res = await api.moveIssueStage(dragged.repo, dragged.number, move.to, move.from);
  return stageMoveOutcome(res, move.to);
}

/**
 * The drag wiring a column and its cards need, owned by `BoardPage`.
 *
 * One object rather than seven props: the gesture spans two components and the
 * page is the only place that can hold state for both ends of it.
 */
export interface BoardDnd {
  /** The card under the cursor right now, or null. */
  dragging: DraggedCard | null;
  onDragStart: (dragged: DraggedCard) => void;
  onDragEnd: () => void;
  /** `raw` is the `dataTransfer` payload — the record of what was dragged. */
  onDrop: (target: DropTarget, raw: string | null) => void;
  /** A move is in flight for this card; a second drop on it is ignored. */
  isMoving: (key: string) => boolean;
  feedbackFor: (key: string) => CardFeedback | null;
  clearFeedback: (key: string) => void;
}

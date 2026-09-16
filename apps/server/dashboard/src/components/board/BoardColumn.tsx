import { useState } from "react";
import clsx from "clsx";
import type { BoardCard as BoardCardData, BoardColumn as BoardColumnData } from "../../api";
import { BoardCard, isGated } from "./BoardCard";
import { DRAG_MIME, resolveStageDrop, type BoardDnd, type DropTarget } from "./stageDrop";

/**
 * One pipeline stage — a header plus its cards.
 *
 * The title and label come straight from the operator's `autonomy.stages`, so
 * both render as-is. An unknown stage is not an error condition here; it is
 * the normal case for any deployment that renamed its stages.
 *
 * ## As a drop target
 *
 * The column highlights only when the card under the cursor would actually
 * move here, and `resolveStageDrop` is the one thing that decides that — the
 * same function the drop itself goes through, so the highlight can never
 * promise something the drop then declines. A column the card is already in
 * never highlights and never calls `preventDefault`, which is what makes the
 * browser show "no drop" rather than accepting a gesture that does nothing.
 *
 * The dragged card comes from `dnd.dragging` rather than `dataTransfer`,
 * because `getData` is deliberately unreadable during `dragover` — the payload
 * is still what the DROP reads.
 */
export function BoardColumn({
  column,
  selectedKey,
  onSelect,
  onOpenApproval,
  onRefresh,
  emptyLabel = "Nothing here",
  dnd,
}: {
  column: BoardColumnData;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onOpenApproval: (approvalId: string) => void;
  /** Passed through to each card's action menu — `BoardPage` owns the fetch. */
  onRefresh?: () => void | Promise<void>;
  emptyLabel?: string;
  /** Drag-and-drop wiring. Absent = the column is not a drop target. */
  dnd?: BoardDnd;
}) {
  const [over, setOver] = useState(false);
  const cards = sortGatedFirst(Array.isArray(column.cards) ? column.cards : []);
  const awaiting = typeof column.awaitingHumanCount === "number" ? column.awaitingHumanCount : 0;
  const count = typeof column.count === "number" ? column.count : cards.length;

  // The unstaged column's label is "" — "remove the stage label, add none".
  const target: DropTarget = {
    label: typeof column.label === "string" ? column.label : "",
  };
  const accepts = dnd ? resolveStageDrop(dnd.dragging, target).kind === "move" : false;

  return (
    <div
      onDragOver={(e) => {
        if (!accepts) return;
        // Without preventDefault the browser refuses the drop outright, which
        // is exactly what we want for the column the card already sits in.
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
        if (!over) setOver(true);
      }}
      onDragLeave={(e) => {
        // Ignore the leaves fired crossing into a child element.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setOver(false);
      }}
      onDrop={(e) => {
        if (!accepts) return;
        e.preventDefault();
        setOver(false);
        dnd?.onDrop(target, e.dataTransfer.getData(DRAG_MIME) || null);
      }}
      className={clsx(
        "ll-board-column flex w-96 shrink-0 flex-col overflow-hidden rounded-panel border transition-colors",
        over && accepts
          ? "border-primary bg-primary/[0.06] ring-1 ring-primary/40"
          : "border-hairline",
      )}
    >
      <div className="flex items-center gap-2 border-b border-hairline px-2.5 py-2">
        <span className="truncate text-xs font-semibold text-strong">{column.title}</span>
        <span className="rounded-control bg-base-300/60 px-1.5 py-px text-[10px] font-medium text-muted">
          {count}
        </span>
        <div className="grow" />
        {awaiting > 0 && (
          <span
            title={`${awaiting} card${awaiting === 1 ? "" : "s"} waiting on a human decision`}
            className="rounded-control bg-warning/20 px-1.5 py-px text-[10px] font-semibold text-warning"
          >
            {awaiting} waiting
          </span>
        )}
      </div>
      <div className="flex flex-1 flex-col gap-1.5 overflow-y-auto p-1.5">
        {cards.length === 0 ? (
          <div className="px-1 py-2 text-[11px] text-faint">
            {over && accepts ? `Drop to move here` : emptyLabel}
          </div>
        ) : (
          cards.map((card) => (
            <BoardCard
              key={card.key}
              card={card}
              selected={card.key === selectedKey}
              onSelect={onSelect}
              onOpenApproval={onOpenApproval}
              onRefresh={onRefresh}
              moving={dnd?.isMoving(card.key) ?? false}
              moveFeedback={dnd?.feedbackFor(card.key) ?? null}
              onClearMoveFeedback={dnd ? () => dnd.clearFeedback(card.key) : undefined}
              onDragCardStart={dnd?.onDragStart}
              onDragCardEnd={dnd?.onDragEnd}
            />
          ))
        )}
      </div>
    </div>
  );
}

/**
 * Gated cards first, the server's order preserved otherwise.
 *
 * A stable partition rather than a comparator sort: the server already chose
 * an order within the column and we only have grounds to override it for the
 * one case a human is blocking on.
 */
export function sortGatedFirst(cards: BoardCardData[]): BoardCardData[] {
  const gated: BoardCardData[] = [];
  const rest: BoardCardData[] = [];
  for (const card of cards) (isGated(card) ? gated : rest).push(card);
  return [...gated, ...rest];
}

import { useState } from "react";
import clsx from "clsx";
import { GitPullRequest, CircleDot, Split, X, Loader2, TriangleAlert } from "lucide-react";
import type { BoardCard as BoardCardData, BoardLinkedPr } from "../../api";
import { LabelChip } from "./LabelChip";
import { CardActionMenu, type CardFeedback } from "./CardActionMenu";
import { draggedCardOf, encodeDragPayload, isDraggable, DRAG_MIME, type DraggedCard } from "./stageDrop";

/**
 * One issue on the pipeline board. Pull requests are never cards — the PRs that
 * close an issue render as links on it.
 *
 * ## Everything optional is read by name, defensively
 *
 * `api.ts` hand-mirrors the `/board` wire shape, but a mirror is a second copy
 * free to drift from the endpoint — the defect that hid three config blocks
 * for a release (#256, see `PrStatePanel`'s docstring). So the nested
 * `run` / `approval` / `actions` / `labels` members are read through the
 * coercers below rather than trusted: a card whose `run` arrives as `null`,
 * as `undefined`, or as a shape nobody predicted renders without its run
 * line instead of taking the column down with it.
 *
 * There is deliberately **no `switch` on stage ids**. Operators name their own
 * `autonomy.stages`, so `stageLabel` and the column titles are strings we
 * display, never values we branch on.
 *
 * ## Why a refused action lands HERE
 *
 * The card is where the refusal belongs: a 409 from the dispatch gate is about
 * this issue, in the same words the bot would have posted on it, and it is the
 * single most useful thing the board can tell somebody. So the menu hands its
 * outcome back and the card shows it inline — there is no toast surface in this
 * dashboard, and a `console.error` would be a refusal nobody ever reads.
 *
 * ## Dragging
 *
 * Plain HTML5 drag events — the card carries its key, repo, number and current
 * `stageLabel` in `dataTransfer` and the column it lands on does the rest
 * (`stageDrop.ts`). A **held** card is not draggable at all: the server would
 * refuse the move, and offering a gesture then rejecting it is worse than not
 * offering it. A move in flight shows on the card and its outcome — including
 * the refusal — lands in the same feedback banner an action's would.
 */
export function BoardCard({
  card,
  selected,
  onSelect,
  onOpenApproval,
  onRefresh,
  moving = false,
  moveFeedback = null,
  onClearMoveFeedback,
  onDragCardStart,
  onDragCardEnd,
}: {
  card: BoardCardData;
  selected: boolean;
  onSelect: (key: string) => void;
  onOpenApproval: (approvalId: string) => void;
  /** Refetch the board now — `BoardPage` owns the fetch. */
  onRefresh?: () => void | Promise<void>;
  /** A stage move is in flight for this card — `BoardPage` owns the request. */
  moving?: boolean;
  /** What that move answered, shown in the same banner an action's outcome is. */
  moveFeedback?: CardFeedback | null;
  onClearMoveFeedback?: () => void;
  onDragCardStart?: (dragged: DraggedCard) => void;
  onDragCardEnd?: () => void;
}) {
  const [feedback, setFeedback] = useState<CardFeedback | null>(null);
  const approval = asDict(card.approval);
  const run = asDict(card.run);
  const actions = Array.isArray(card.actions) ? card.actions : [];
  // EVERY label GitHub reports, the stage label included. The column heading
  // already names the stage, so the card repeating it as a second, synthetic
  // chip was the duplicate — not the real label, which is the one a maintainer
  // recognises from the issue itself.
  // Sorted by name, always. GitHub returns them in whatever order the API felt
  // like, which means a card's chips can reorder between two polls with nothing
  // having changed — movement that draws the eye and means nothing. Alphabetical
  // is arbitrary but STABLE, and stable is the property that matters on a view
  // that refreshes every twenty seconds.
  const labels = (Array.isArray(card.labels) ? card.labels : [])
    .slice()
    .sort((x, y) => (x?.name ?? "").localeCompare(y?.name ?? ""));
  const linkedPrs = linkedPrsOf(card);
  const held = card.held === true;
  const gated = approval !== null;
  const canDrag = isDraggable(card) && !moving;
  // One banner, whichever spoke last: an action's outcome and a move's are the
  // same kind of answer about the same card.
  const shown = feedback ?? moveFeedback ?? null;

  const approvalId = str(approval?.id);
  const gate = str(approval?.gate);
  const approvalAge = timeAgo(str(approval?.createdAt));
  // The server's own sentence when it sent one. The fallback — the first
  // action's `disabledReason` — is a GUESS that happens to be right while the
  // hold is the only thing disabling actions, so it stays only as a bridge for
  // a server that predates `heldReason`.
  const heldReason =
    str(card.heldReason) ?? actions.find((a) => a?.disabledReason)?.disabledReason ?? null;

  // Read by name like everything else nested — see the docstring. The server
  // sends `failure` only on a FAILED run whose ledger carried a reason.
  const failure =
    run && typeof run.failure === "object" && run.failure
      ? (run.failure as { phase?: unknown; reason?: unknown })
      : null;
  const failedPhase = str(failure?.phase);
  const failedReason = str(failure?.reason);

  return (
    <div
      role="button"
      tabIndex={0}
      draggable={canDrag}
      onDragStart={(e) => {
        if (!canDrag) return;
        const dragged = draggedCardOf(card);
        e.dataTransfer.setData(DRAG_MIME, encodeDragPayload(dragged));
        e.dataTransfer.effectAllowed = "move";
        onDragCardStart?.(dragged);
      }}
      onDragEnd={() => onDragCardEnd?.()}
      onClick={() => onSelect(card.key)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect(card.key);
        }
      }}
      className={clsx(
        "group flex cursor-pointer flex-col gap-1.5 rounded-panel border p-2 text-left shadow-sm transition-colors",
        // The amber border is the loudest thing on the board on purpose: a
        // gated card is the only one that cannot move without a human.
        gated
          ? "border-warning/60 bg-warning/[0.06] hover:bg-warning/10"
          : "border-hairline ll-surface hover:bg-base-300/40",
        held && "opacity-60",
        moving && "opacity-60",
        canDrag && "active:cursor-grabbing",
        selected && "ring-1 ring-primary",
      )}
    >
      {/* ── Identity line: #123 · author · opened 14h ─────────────────── */}
      <div className="flex items-start gap-1.5">
        <span className="mt-px shrink-0 text-faint" title="Issue">
          <CircleDot className="h-3 w-3" />
        </span>
        <div className="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-1.5 text-[10px] text-muted">
          {card.repo && (
            <a
              href={`https://github.com/${card.repo}`}
              target="_blank"
              rel="noopener noreferrer"
              title={`Open ${card.repo} on GitHub`}
              onClick={(e) => e.stopPropagation()}
              className="max-w-[55%] truncate transition-colors hover:text-primary hover:underline"
            >
              {card.repo}
            </a>
          )}
          <a
            href={card.url}
            target="_blank"
            rel="noopener noreferrer"
            title="Open on GitHub"
            onClick={(e) => e.stopPropagation()}
            className="font-mono font-medium text-strong transition-colors hover:text-primary hover:underline"
          >
            #{card.number}
          </a>
          {card.author && <span className="truncate">· {card.author}</span>}
          {approvalAge === null && timeAgo(card.createdAt) && (
            <span>· opened {timeAgo(card.createdAt)}</span>
          )}
        </div>
        <CardActionMenu
          card={card}
          actions={actions}
          held={held}
          heldReason={heldReason}
          approvalId={approvalId}
          onOpenApproval={onOpenApproval}
          onRefresh={onRefresh}
          onFeedback={setFeedback}
        />
      </div>

      {/* ── Title ─────────────────────────────────────────────────────── */}
      <div className="line-clamp-2 text-xs font-medium leading-snug text-strong">
        {card.title}
      </div>

      {/* ── Description ───────────────────────────────────────────────── */}
      {/* Already flattened and clipped by the server (`boardExcerpt`); the
          clamp is the second bound, on height rather than payload. */}
      {str(card.body) && (
        <div className="line-clamp-2 text-[11px] leading-snug text-muted">{card.body}</div>
      )}

      {/* ── What the last action answered ─────────────────────────────── */}
      {shown && (
        <div
          onClick={(e) => {
            e.stopPropagation();
            setFeedback(null);
            onClearMoveFeedback?.();
          }}
          title="Dismiss"
          className={clsx(
            "flex cursor-pointer items-start gap-1 rounded-control border px-1.5 py-1 text-[10px] leading-snug",
            shown.tone === "error"
              ? "border-error/30 bg-error/10 text-error"
              : "border-info/30 bg-info/10 text-info",
          )}
        >
          <span className="flex-1">{shown.text}</span>
          <X className="mt-px h-2.5 w-2.5 shrink-0 opacity-60" />
        </div>
      )}

      {/* ── The HITL pill — the point of the whole view ────────────────── */}
      {gated && (
        <div className="flex items-center gap-1 rounded-control bg-warning/15 px-1.5 py-0.5 text-[10px] font-semibold text-warning">
          <span className="truncate">
            Waiting on you
            {gate ? ` · ${gate}` : ""}
            {approvalAge ? ` · ${approvalAge}` : ""}
          </span>
        </div>
      )}

      {/* ── The RUN, when there is one ────────────────────────────────── */}
      {/* A card with work happening on it is the one you came to the board to
          look at, so the run is a band rather than a line of footer text: the
          status reads first, then the phase it is in and how long it has been
          there, and the whole thing is a link to the run's own page. */}
      {run && (
        <a
          href={`?tab=runs&run=${encodeURIComponent(str(run.id) ?? "")}`}
          onClick={(e) => e.stopPropagation()}
          title={`${str(run.workflowName) ?? "run"} — open this run`}
          className={clsx(
            "flex items-center gap-1.5 rounded-control border px-1.5 py-1 text-[10px] font-semibold transition-colors",
            runTone(str(run.status)),
          )}
        >
          {isLive(str(run.status)) && <Loader2 className="h-2.5 w-2.5 shrink-0 animate-spin" />}
          <span className="uppercase tracking-wide">{str(run.status) ?? "run"}</span>
          {/* `phase` when the server sent one: `current_phase` is written on
              COMPLETION, so it lags by one for everything after the first
              phase. Falling back keeps an older server rendering. */}
          {(str(run.phase) ?? str(run.currentPhase)) && (
            <span className="truncate font-normal opacity-90">
              · {str(run.phase) ?? str(run.currentPhase)}
            </span>
          )}
          {timeAgo(str(run.startedAt)) && (
            <span className="ml-auto shrink-0 font-normal opacity-75">
              {timeAgo(str(run.startedAt))}
            </span>
          )}
        </a>
      )}

      {/* ── WHY it failed ─────────────────────────────────────────────── */}
      {/* An annotation of the FAILED band directly above: that says the run
          died, this says what killed it. Without it, a guardrails block and a
          crash are the same red pill. Already flattened and clipped by the
          server, so the clamp here is a second bound on height, not the only
          one. */}
      {failedReason && (
        <div
          title={failedReason}
          className="flex items-start gap-1 rounded-control border border-error/30 bg-error/10 px-1.5 py-1 text-[10px] leading-snug text-error"
        >
          <TriangleAlert className="mt-px h-2.5 w-2.5 shrink-0" />
          <span className="line-clamp-2">
            {failedPhase && <span className="font-semibold">{failedPhase}: </span>}
            {failedReason}
          </span>
        </div>
      )}

      {/* ── Linked pull requests ──────────────────────────────────────── */}
      {linkedPrs.length > 0 && (
        <div className="flex flex-wrap gap-x-2 gap-y-0.5 text-[10px]">
          {linkedPrs.map((pr) => (
            <a
              key={pr.number}
              href={pr.url}
              target="_blank"
              rel="noopener noreferrer"
              title={`${pr.title || `PR #${pr.number}`} — ${prStateLabel(pr)}`}
              onClick={(e) => e.stopPropagation()}
              className={clsx(
                "inline-flex items-center gap-1 font-medium transition-colors hover:underline",
                prStateTone(pr),
              )}
            >
              <GitPullRequest className="h-2.5 w-2.5 shrink-0" />
              <span className="font-mono">#{pr.number}</span>
              <span className="font-normal opacity-80">{prStateLabel(pr)}</span>
            </a>
          ))}
        </div>
      )}

      {/* ── Labels ────────────────────────────────────────────────────── */}
      {labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {labels.map((label) => (
            <LabelChip
              key={label?.name ?? Math.random()}
              name={label?.name ?? ""}
              color={label?.color}
              description={label?.description}
            />
          ))}
        </div>
      )}

      {/* ── Footer: stage, run, held ──────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-1.5 text-[10px] text-faint">
        {card.ambiguousStage === true && (
          // The one thing the real label chips CANNOT say: this card carries
          // two stage labels, so which column it sits in was a choice. Subtle
          // on purpose — it is the ordinary outcome of a partial advance
          // (`stage-advance.ts` adds before it removes), not an error.
          <span
            title="Ambiguous stage — this card carries more than one stage label"
            className="inline-flex items-center gap-1 text-warning"
          >
            <Split className="h-2.5 w-2.5" aria-label="Ambiguous stage" />
            two stages
          </span>
        )}
        {held && (
          <span
            title={heldReason || "Held — Last Light is not acting on this item"}
            className="rounded-control border border-hairline px-1 py-px font-medium text-muted"
          >
            held
          </span>
        )}
        {moving && (
          <span className="inline-flex items-center gap-1 font-medium text-primary">
            <Loader2 className="h-2.5 w-2.5 animate-spin" />
            moving…
          </span>
        )}

      </div>
    </div>
  );
}

// ── Defensive readers ───────────────────────────────────────────────────────
// Deliberately tolerant: `null`, `undefined` and a wrong-shaped value all
// collapse to "we don't know", which renders as an absent line.

type Dict = Record<string, unknown>;

function asDict(v: unknown): Dict | null {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : null;
}

function str(v: unknown): string | null {
  return typeof v === "string" && v ? v : null;
}

/** The card's linked PRs, dropping any entry without a number or link. */
export function linkedPrsOf(card: BoardCardData): BoardLinkedPr[] {
  return (Array.isArray(card.linkedPrs) ? card.linkedPrs : []).filter(
    (pr): pr is BoardLinkedPr => !!pr && typeof pr.number === "number" && !!str(pr.url),
  );
}

/** `MERGED` → "merged", an open draft → "draft". */
export function prStateLabel(pr: BoardLinkedPr): string {
  if (pr.state === "MERGED") return "merged";
  if (pr.state === "CLOSED") return "closed";
  return pr.draft ? "draft" : "open";
}

function prStateTone(pr: BoardLinkedPr): string {
  if (pr.state === "MERGED") return "text-primary";
  if (pr.state === "CLOSED") return "text-faint line-through";
  return pr.draft ? "text-muted" : "text-success";
}

/** Relative age of an ISO timestamp — "3h", "2d" (mirrors ReposPage). */
export function timeAgo(iso: unknown): string | null {
  if (typeof iso !== "string" || !iso) return null;
  const ms = Date.parse(iso);
  if (Number.isNaN(ms)) return null;
  const secs = Math.floor((Date.now() - ms) / 1000);
  if (secs < 0) return "now";
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

/** True when a card is waiting on a human decision. */
export function isGated(card: BoardCardData): boolean {
  return asDict(card.approval) !== null;
}

/** Is this run still going? Drives the spinner, not the colour. */
export function isLive(status: string | null): boolean {
  return status === "running" || status === "queued";
}

/**
 * A run status → its band colour.
 *
 * Deliberately a lookup with an explicit default rather than a `switch` over
 * every status the store can hold: statuses are the server's vocabulary and it
 * is free to add one, so an unknown value must render as a plain band rather
 * than as nothing at all.
 */
export function runTone(status: string | null): string {
  switch (status) {
    case "running":
      return "border-info/40 bg-info/10 text-info hover:bg-info/20";
    case "queued":
      return "border-hairline bg-base-300/40 text-muted hover:bg-base-300/60";
    case "paused":
      return "border-warning/40 bg-warning/10 text-warning hover:bg-warning/20";
    case "failed":
    case "cancelled":
      return "border-error/40 bg-error/10 text-error hover:bg-error/20";
    case "succeeded":
      return "border-success/40 bg-success/10 text-success hover:bg-success/20";
    default:
      return "border-hairline bg-base-300/30 text-muted hover:bg-base-300/50";
  }
}

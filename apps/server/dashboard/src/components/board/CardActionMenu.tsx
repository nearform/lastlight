import { useEffect, useRef, useState } from "react";
import clsx from "clsx";
import { MoreHorizontal, ArrowRight, Loader2 } from "lucide-react";
import type { BoardCard as BoardCardData, BoardCardAction } from "../../api";
import {
  failureMessage,
  intentForAction,
  isNavigation,
  needsConfirm,
  needsReason,
  performIntent,
  subjectOf,
  type CardIntent,
} from "./cardActions";

/** What the menu hands back to the card to render inline. */
export interface CardFeedback {
  tone: "error" | "info";
  text: string;
}

/**
 * The per-card action menu — live.
 *
 * Each item the server sent is routed through `cardActions.ts` onto the admin
 * API call it means, and the board is refetched the moment one succeeds: the
 * 20s poll is for watching, not for confirming something you just did.
 *
 * ## `enabled` / `disabledReason` are the server's answer, not ours
 *
 * The server computes them because it is the only side that knows the hold
 * label, the PR-scoped run lock and the route map. A client-side re-derivation
 * would be a second opinion free to drift from the gate that actually decides,
 * which is the whole defect class `PrStatePanel` documents. So an item is
 * disabled exactly when the server said so, and the tooltip is the server's
 * own `disabledReason` — never a sentence composed here.
 *
 * `held` disables the entire menu on top of that: a held card is one Last
 * Light has been told to keep its hands off, which outranks any per-action
 * verdict.
 *
 * ## One press at a time
 *
 * A dispatch is not idempotent, so while anything is in flight EVERY item goes
 * disabled rather than just the one pressed — a double-click on a slow link is
 * otherwise two builds. The reason and confirm prompts render in place for the
 * same reason `FocusedApprovalView` uses an inline textarea: the decision and
 * its justification belong on one surface.
 *
 * Failures are handed up via `onFeedback` and shown ON the card. A 409 in
 * particular is not an error to bury — it is the gate explaining itself in the
 * same words the bot would have posted on the issue.
 */
export function CardActionMenu({
  card,
  actions,
  held,
  heldReason,
  approvalId,
  onOpenApproval,
  onRefresh,
  onFeedback,
}: {
  card: BoardCardData;
  actions: BoardCardAction[];
  held: boolean;
  /** The server's reason, shown as the tooltip on a held card's menu. */
  heldReason?: string | null;
  approvalId?: string | null;
  onOpenApproval?: (id: string) => void;
  /** Refetch the board — owned by `BoardPage`, which does the fetching. */
  onRefresh?: () => void | Promise<void>;
  onFeedback?: (feedback: CardFeedback | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const [pendingId, setPendingId] = useState<string | null>(null);
  /** The action awaiting a reason or a second press, if any. */
  const [prompt, setPrompt] = useState<{ action: BoardCardAction; intent: CardIntent } | null>(null);
  const [reason, setReason] = useState("");
  const wrapperRef = useRef<HTMLDivElement>(null);

  // Close on an outside click or Escape. No daisyUI `dropdown` here: its
  // focus-based open/close fights the card's own click handler.
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      // Never close out from under an in-flight action: the menu is the only
      // thing showing that something is happening.
      if (pendingId) return;
      if (!wrapperRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !pendingId) close();
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
    // `close` is stable enough to leave out: it only ever resets local state.
  }, [open, pendingId]);

  const close = () => {
    setOpen(false);
    setPrompt(null);
    setReason("");
  };

  const run = async (action: BoardCardAction, intent: CardIntent) => {
    setPendingId(action.id);
    onFeedback?.(null);
    try {
      const { note } = await performIntent(intent, { reason });
      close();
      onFeedback?.(note ? { tone: "info", text: note } : null);
      await onRefresh?.();
    } catch (err) {
      close();
      onFeedback?.({ tone: "error", text: failureMessage(err) });
    } finally {
      setPendingId(null);
    }
  };

  const press = (action: BoardCardAction) => {
    const intent = intentForAction(action, subjectOf(card));
    if (intent.kind === "unsupported") {
      close();
      onFeedback?.({ tone: "error", text: intent.reason });
      return;
    }
    if (isNavigation(intent)) {
      close();
      void performIntent(intent);
      return;
    }
    if (needsReason(intent) || needsConfirm(intent)) {
      setReason("");
      setPrompt({ action, intent });
      return;
    }
    void run(action, intent);
  };

  const hasApproval = Boolean(approvalId);
  if (actions.length === 0 && !hasApproval) return null;

  const busy = pendingId !== null;
  const menuTitle = held
    ? heldReason || "Held — Last Light is not acting on this item"
    : "Actions";

  return (
    <div ref={wrapperRef} className="relative shrink-0">
      <button
        type="button"
        aria-label="Card actions"
        title={menuTitle}
        disabled={held}
        onClick={(e) => {
          e.stopPropagation();
          if (open) close();
          else setOpen(true);
        }}
        className={clsx(
          "rounded-control p-0.5 transition-colors",
          held
            ? "cursor-not-allowed text-faint"
            : "text-faint hover:bg-base-300/60 hover:text-strong",
        )}
      >
        {busy ? (
          <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
        ) : (
          <MoreHorizontal className="h-3.5 w-3.5" />
        )}
      </button>

      {open && !held && (
        <div
          role="menu"
          onClick={(e) => e.stopPropagation()}
          className="absolute right-0 top-full z-30 mt-1 w-56 overflow-hidden rounded-panel border border-hairline bg-base-300 py-1 shadow-pop"
        >
          {hasApproval && (
            <button
              type="button"
              role="menuitem"
              disabled={busy}
              onClick={() => {
                close();
                if (approvalId && onOpenApproval) onOpenApproval(approvalId);
              }}
              className="flex w-full items-center gap-2 px-2.5 py-1.5 text-left text-xs font-medium text-warning hover:bg-warning/10 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <ArrowRight className="h-3 w-3 shrink-0" />
              Review &amp; decide
            </button>
          )}
          {hasApproval && actions.length > 0 && (
            <div className="my-1 border-t border-hairline" />
          )}
          {actions.map((action) => {
            const reasonText = action.disabledReason || undefined;
            // Disabled exactly when the server said so — plus the whole menu
            // while one action is in flight (above).
            const disabled = !action.enabled || busy;
            const pending = pendingId === action.id;
            return (
              <button
                key={action.id}
                type="button"
                role="menuitem"
                disabled={disabled}
                title={action.enabled ? action.label : reasonText || "Unavailable"}
                onClick={() => press(action)}
                className={clsx(
                  "flex w-full items-center justify-between gap-2 px-2.5 py-1.5 text-left text-xs transition-colors",
                  disabled
                    ? "cursor-not-allowed"
                    : "cursor-pointer text-muted hover:bg-base-100/60 hover:text-strong",
                  !action.enabled && "text-faint",
                  action.enabled && busy && "text-faint",
                )}
              >
                <span className="truncate">{action.label}</span>
                {pending ? (
                  <Loader2 className="h-3 w-3 shrink-0 animate-spin text-primary" />
                ) : (
                  !action.enabled &&
                  reasonText && (
                    <span className="shrink-0 text-[9px] uppercase tracking-wide text-faint">
                      blocked
                    </span>
                  )
                )}
              </button>
            );
          })}

          {/* ── Reason / confirm prompt ─────────────────────────────────── */}
          {prompt && (
            <div className="mt-1 border-t border-hairline px-2.5 pb-1.5 pt-2">
              {needsReason(prompt.intent) ? (
                <>
                  <textarea
                    autoFocus
                    className="textarea textarea-bordered textarea-xs w-full resize-none text-xs"
                    placeholder="Optional reason (required by some teams on reject)…"
                    rows={2}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    disabled={busy}
                  />
                </>
              ) : (
                <p className="mb-1.5 text-[11px] leading-snug text-muted">
                  Cancel the run in flight? The work stops where it is and there is no undo.
                </p>
              )}
              <div className="mt-1.5 flex gap-1.5">
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => void run(prompt.action, prompt.intent)}
                  className={clsx(
                    "btn btn-xs",
                    prompt.intent.kind === "approve"
                      ? "btn-success"
                      : "btn-error btn-outline",
                  )}
                >
                  {busy ? "Working…" : prompt.action.label}
                </button>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    setPrompt(null);
                    setReason("");
                  }}
                  className="btn btn-xs btn-ghost"
                >
                  Back
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

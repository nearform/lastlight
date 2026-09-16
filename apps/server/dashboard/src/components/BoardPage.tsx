import { useCallback, useEffect, useMemo, useState } from "react";
import clsx from "clsx";
import { TriangleAlert, RefreshCw, X } from "lucide-react";
import { api, type BoardResponse, type BoardColumn as BoardColumnData, type RepoEntry } from "../api";
import { BoardColumn } from "./board/BoardColumn";
import { isGated } from "./board/BoardCard";
import type { CardFeedback } from "./board/CardActionMenu";
import { failureMessage } from "./board/cardActions";
import {
  decodeDragPayload,
  performStageMove,
  resolveStageDrop,
  type BoardDnd,
  type DraggedCard,
  type DropTarget,
} from "./board/stageDrop";
import {
  useUrlState,
  stringParser,
  stringSerializer,
  nullableStringParser,
  nullableStringSerializer,
  boolParser,
  boolSerializer,
} from "../hooks/useUrlState";
import { useBoardStream } from "../hooks/useBoardStream";

/**
 * Board tab — issues and PRs as they flow through the autonomous pipeline.
 *
 * Every card's `actions` array is rendered and each item is LIVE — routed onto
 * the admin API by `board/cardActions.ts`, with `enabled` / `disabledReason`
 * taken from the server rather than re-derived here (see `CardActionMenu`).
 * This page owns the fetch, so it hands a `refresh` callback down instead:
 * an action that succeeded refetches immediately rather than waiting out the
 * poll, which is the difference between a board that responds and one that
 * looks broken for twenty seconds.
 *
 * The columns are the operator's `autonomy.stages`. When none are configured
 * the server answers `configured: false` and this page says so — it does NOT
 * invent a default Intake/Triage/Review set, because a board showing stages a
 * deployment never declared is worse than an honest empty state.
 *
 * ## Polling is visibility-gated
 *
 * The server caches each answer for ~120s, and behind that cache are GitHub
 * requests. A dashboard left open on a second monitor overnight is exactly how
 * a cache TTL turns into a bill, so the 20s poll stops while `document.hidden`
 * and fires once on the way back — a returning user gets fresh data without
 * the tab having paid for it while nobody was looking.
 *
 * ## Dragging a card moves its stage LABEL
 *
 * A drop writes `POST /issues/:owner/:repo/:number/stage` and nothing else —
 * the endpoint deliberately does not dispatch. The state lives here rather than
 * on the card because the gesture spans two components (a card starts it, a
 * column finishes it) and the answer has to land back on the card that moved.
 * `stageDrop.ts` holds the whole decision; this page only owns the request and
 * where its outcome is shown.
 *
 * Deep-link params: `?tab=board&brepo=<csv>&card=<owner/repo#N>&needs=1`.
 * `brepo`, not `repo`: `ReposPage` already owns `repo` and the two would fight
 * over one param.
 */
const POLL_MS = 20_000;

/**
 * The poll interval once the change stream is live.
 *
 * A SAFETY NET, not the refresh mechanism: a stream that dies silently must not
 * strand the view on a stale board. Matched to the server's cache TTL, so it
 * costs at most one extra read per window on a board nothing is happening to.
 */
const SLOW_POLL_MS = 120_000;

export function BoardPage() {
  const [brepo, setBrepo] = useUrlState<string>("brepo", "", stringParser, stringSerializer);
  const [selectedKey, setSelectedKey] = useUrlState<string | null>(
    "card",
    null,
    nullableStringParser,
    nullableStringSerializer,
  );
  const [needsYou, setNeedsYou] = useUrlState<boolean>(
    "needs",
    false,
    boolParser(false),
    boolSerializer(false),
  );
  // Not a URL param: the unstaged drawer is a "while I'm looking" toggle, and
  // the four linkable params are the ones worth putting in somebody's bookmark.
  const [showUnstaged, setShowUnstaged] = useState(false);

  const [board, setBoard] = useState<BoardResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  // ── Drag and drop ──────────────────────────────────────────────────────
  // The dragged card is held HERE as well as in `dataTransfer`, because a
  // column must decide during `dragover` whether it is a legal target and
  // `dataTransfer.getData` is deliberately unreadable until the drop. The
  // payload still travels in `dataTransfer` — that is what the drop reads.
  const [dragging, setDragging] = useState<DraggedCard | null>(null);
  // Keyed by card: a second drop on a card already moving is ignored while
  // every other card stays draggable.
  const [moving, setMoving] = useState<Record<string, true>>({});
  const [moveFeedback, setMoveFeedback] = useState<Record<string, CardFeedback>>({});

  // The picker offers only repos the board CAN show — the server's own
  // `scope.eligible` (the autonomy allow-list ∩ managed), not `GET /repos`,
  // which answers the larger "what does this deployment manage" question. Fed
  // from that, the dropdown listed repos with no pipeline: picking one gave an
  // empty board and no reason why.
  const repoOptions: string[] = useMemo(
    () => (Array.isArray(board?.scope?.eligible) ? board.scope.eligible : []),
    [board],
  );

  const scopedRepos = useMemo(
    () => brepo.split(",").map((r) => r.trim()).filter(Boolean),
    [brepo],
  );
  // The scope list is a URL string, so depend on the joined form rather than
  // the array identity — otherwise `load` is a new function every render and
  // the poll restarts on each tick.
  const scopeKey = scopedRepos.join(",");

  const load = useCallback(
    async (opts: { refresh?: boolean } = {}) => {
      try {
        const res = await api.board({
          repos: scopeKey ? scopeKey.split(",") : undefined,
          unstaged: true,
          refresh: opts.refresh,
        });
        setBoard(res);
        setError(null);
      } catch (err) {
        // Keep the last good board on screen — a transient admin-API blip
        // should not blank a view somebody is reading.
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        setLoading(false);
      }
    },
    [scopeKey],
  );

  // Handed to every card's action menu. `refresh: true` on purpose: the point
  // is to see the effect of what you just pressed, and the server's ~120s cache
  // would otherwise answer with the board as it looked before it.
  const refreshNow = useCallback(() => load({ refresh: true }), [load]);

  const clearMoveFeedback = useCallback((key: string) => {
    setMoveFeedback((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  }, []);

  const onCardDrop = useCallback(
    async (target: DropTarget, raw: string | null) => {
      const dragged = decodeDragPayload(raw) ?? dragging;
      setDragging(null);
      const drop = resolveStageDrop(dragged, target);
      // Same column, held, or nothing dragged: no request at all.
      if (!dragged || drop.kind !== "move") return;
      if (moving[dragged.key]) return;
      const key = dragged.key;
      setMoving((prev) => ({ ...prev, [key]: true }));
      clearMoveFeedback(key);
      try {
        const { note } = await performStageMove(dragged, drop);
        if (note) setMoveFeedback((prev) => ({ ...prev, [key]: { tone: "info", text: note } }));
        // Don't wait out the poll to show what just happened.
        await refreshNow();
      } catch (err) {
        // Verbatim: a 409 here is the hold label refusing in the same words the
        // bot would have posted on the issue.
        setMoveFeedback((prev) => ({
          ...prev,
          [key]: { tone: "error", text: failureMessage(err) },
        }));
      } finally {
        setMoving((prev) => {
          const next = { ...prev };
          delete next[key];
          return next;
        });
      }
    },
    [clearMoveFeedback, dragging, moving, refreshNow],
  );

  const dnd: BoardDnd = useMemo(
    () => ({
      dragging,
      onDragStart: setDragging,
      onDragEnd: () => setDragging(null),
      onDrop: (target, raw) => void onCardDrop(target, raw),
      isMoving: (key) => moving[key] === true,
      feedbackFor: (key) => moveFeedback[key] ?? null,
      clearFeedback: clearMoveFeedback,
    }),
    [clearMoveFeedback, dragging, moveFeedback, moving, onCardDrop],
  );

  // ── Live updates ────────────────────────────────────────────────────────
  //
  // The stream carries a REVISION, not a board — so a push means "something
  // changed, refetch at your own scope". Closing the connection while the tab
  // is hidden matters more than stopping the poll did: a poll that is not
  // firing costs nothing, whereas an idle EventSource holds a connection open
  // all night.
  const [hidden, setHidden] = useState(() => document.hidden);
  const { revision, status: streamStatus } = useBoardStream(!hidden);
  const streamLive = streamStatus === "live";
  const [seenRevision, setSeenRevision] = useState<string | null>(null);

  useEffect(() => {
    if (revision === null) return;
    // The handshake frame says the stream is live; it is not news.
    if (seenRevision === null) {
      setSeenRevision(revision);
      return;
    }
    if (revision === seenRevision) return;
    setSeenRevision(revision);
    // A plain refetch. NEVER `refresh: true` — the server already invalidated
    // its cache before signalling, and forcing would bypass the TTL and defeat
    // BOARD_FORCE_THROTTLE_MS on every single push.
    void load();
  }, [revision, seenRevision, load]);

  useEffect(() => {
    setLoading(true);
    load();
  }, [load]);

  useEffect(() => {
    let timer: ReturnType<typeof setInterval> | null = null;
    // Falls back to the old 20s cadence whenever the stream is not live, so a
    // browser or proxy that will not hold an EventSource open degrades to
    // exactly the behaviour that shipped before it.
    const everyMs = streamLive ? SLOW_POLL_MS : POLL_MS;
    const start = () => {
      if (timer === null) timer = setInterval(() => load(), everyMs);
    };
    const stop = () => {
      if (timer !== null) {
        clearInterval(timer);
        timer = null;
      }
    };
    const onVisibility = () => {
      // Drives the stream too — see `useBoardStream(!hidden)` above.
      setHidden(document.hidden);
      if (document.hidden) {
        stop();
      } else {
        load();
        start();
      }
    };
    if (!document.hidden) start();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [load, streamLive]);

  const onOpenApproval = useCallback((approvalId: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set("approval", approvalId);
    window.history.pushState(null, "", url.toString());
    // App reads `?approval=` on popstate; a pushState doesn't emit one, so
    // announce it ourselves.
    window.dispatchEvent(new PopStateEvent("popstate"));
  }, []);

  const addRepo = (repo: string) => {
    if (!repo || scopedRepos.includes(repo)) return;
    setBrepo([...scopedRepos, repo].join(","));
  };
  const removeRepo = (repo: string) => {
    setBrepo(scopedRepos.filter((r) => r !== repo).join(","));
  };

  const columns: BoardColumnData[] = Array.isArray(board?.columns) ? board.columns : [];
  const degraded = Array.isArray(board?.degraded) ? board.degraded : [];
  const waitingTotal = columns.reduce(
    (sum, c) => sum + (typeof c.awaitingHumanCount === "number" ? c.awaitingHumanCount : 0),
    0,
  );

  // "Needs you" filters the CARDS but keeps every column standing — a column
  // that vanishes because nothing in it is gated reads as a missing stage.
  // The success terminus, identified by the server's `<stage>.<phase>` column
  // id rather than by label text — operators rename their own stage labels, so
  // matching on "ready-for-human" would break the moment somebody did.
  // EVERY configured column renders, always. The `on_success` column used to be
  // hidden behind a toggle, on the reading that it is the pile the pipeline has
  // finished with and therefore only grows. The board's own GitHub query is why
  // that was wrong: it searches `is:open`, so an issue whose PR was merged and
  // which was then closed leaves the board altogether. Nothing accumulates.
  // What remains there is every issue whose build succeeded, whose PR is open,
  // and which is still open — work sitting on a HUMAN, and the most actionable
  // column on the board. A toggle for it hid the one thing waiting on you.
  const visibleColumns = useMemo(
    () =>
      needsYou
        ? columns.map((c) => ({
            ...c,
            cards: (Array.isArray(c.cards) ? c.cards : []).filter(isGated),
          }))
        : columns,
    [columns, needsYou],
  );

  const unstagedColumn: BoardColumnData | null = useMemo(() => {
    const unstaged = board?.unstaged;
    if (!unstaged) return null;
    const cards = Array.isArray(unstaged.cards) ? unstaged.cards : [];
    return {
      id: "__unstaged",
      title: "Unstaged",
      label: "",
      count: typeof unstaged.count === "number" ? unstaged.count : cards.length,
      awaitingHumanCount: cards.filter(isGated).length,
      cards: needsYou ? cards.filter(isGated) : cards,
    };
  }, [board, needsYou]);

  return (
    <div className="flex flex-1 flex-col overflow-hidden bg-base-100">
      {/* ── Toolbar ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2 border-b border-hairline px-3 py-2">
        <h2 className="text-sm font-semibold text-strong">Board</h2>

        <div className="flex flex-wrap items-center gap-1">
          {scopedRepos.length === 0 ? (
            <span className="text-[11px] text-faint">all repos</span>
          ) : (
            scopedRepos.map((repo) => (
              <span
                key={repo}
                className="inline-flex items-center gap-1 rounded-control border border-hairline px-1.5 py-px text-[10px] text-muted"
              >
                {repo}
                <button
                  type="button"
                  aria-label={`Remove ${repo} from scope`}
                  onClick={() => removeRepo(repo)}
                  className="text-faint hover:text-error"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))
          )}
          <select
            className="select select-xs select-bordered w-36"
            value=""
            onChange={(e) => {
              addRepo(e.target.value);
              e.target.value = "";
            }}
          >
            <option value="">Scope repo…</option>
            {repoOptions
              .filter((r) => !scopedRepos.includes(r))
              .map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
          </select>
        </div>

        <button
          type="button"
          onClick={() => setNeedsYou(!needsYou)}
          className={clsx(
            "rounded-control px-2 py-1 text-[11px] font-medium transition-colors",
            needsYou
              ? "bg-warning/20 text-warning"
              : "border border-hairline text-muted hover:text-strong",
          )}
        >
          Needs you ({waitingTotal})
        </button>

        <label className="flex cursor-pointer items-center gap-1.5 text-[11px] text-muted">
          <input
            type="checkbox"
            className="checkbox checkbox-xs"
            checked={showUnstaged}
            onChange={(e) => setShowUnstaged(e.target.checked)}
          />
          Unstaged
          {board?.unstaged ? ` (${board.unstaged.count})` : ""}
        </label>

        <div className="grow" />

        {board?.generatedAt && (
          <span className="text-[10px] text-faint" title={board.generatedAt}>
            updated {new Date(board.generatedAt).toLocaleTimeString()}
          </span>
        )}
        <button
          type="button"
          title="Refresh now (bypasses the server cache)"
          onClick={async () => {
            setRefreshing(true);
            await load({ refresh: true });
            setRefreshing(false);
          }}
          className="rounded-control p-1 text-faint transition-colors hover:bg-base-300/60 hover:text-strong"
        >
          <RefreshCw className={clsx("h-3.5 w-3.5", refreshing && "animate-spin")} />
        </button>
      </div>

      {/* ── Notices ───────────────────────────────────────────────────── */}
      <div className="space-y-2 px-3 pt-2 empty:hidden">
        {error && (
          <div className="rounded border border-error/30 bg-error/10 p-2 text-xs text-error">
            {error}
          </div>
        )}
        {board?.scope?.truncated && (
          <div className="rounded border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
            Showing a subset of repositories
            {board.scope.reason ? ` — ${board.scope.reason}` : ""}. Scope to a repo above for the
            full picture.
          </div>
        )}
        {degraded.length > 0 && (
          <div className="rounded border border-warning/30 bg-warning/10 p-2 text-xs text-warning">
            <div className="mb-1 flex items-center gap-1 font-medium">
              <TriangleAlert className="h-3 w-3" />
              {degraded.length} repositor{degraded.length === 1 ? "y is" : "ies are"} degraded — the
              cards below may be incomplete.
            </div>
            <ul className="space-y-0.5 pl-4">
              {degraded.map((d) => (
                <li key={d.repo} className="font-mono text-[11px]">
                  {d.repo}: {d.error}
                  {d.staleSince ? ` (stale since ${d.staleSince})` : ""}
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* ── Columns ───────────────────────────────────────────────────── */}
      {loading && !board ? (
        <div className="p-6 text-sm text-muted">Loading…</div>
      ) : board && board.configured === false ? (
        <div className="m-4 max-w-xl rounded-panel border border-hairline ll-surface p-4">
          <div className="mb-1 text-sm font-semibold text-strong">No pipeline configured</div>
          <p className="text-xs text-muted">
            This board renders the stages declared in <code className="font-mono">autonomy.stages</code>.
            This deployment has none, so there is nothing to lay out — the columns you would see
            otherwise would be invented rather than real. Add the block to the overlay{" "}
            <code className="font-mono">config.yaml</code> and the board fills in.
          </p>
        </div>
      ) : (
        <div className="flex flex-1 gap-2 overflow-x-auto p-3">
          {/* Unstaged sits FIRST, left of every stage: it is the intake pile —
              issues and PRs carrying no stage label at all — so the board reads
              left-to-right in the direction work actually travels. */}
          {showUnstaged && unstagedColumn && (
            <BoardColumn
              column={unstagedColumn}
              selectedKey={selectedKey}
              onSelect={(key) => setSelectedKey(key === selectedKey ? null : key)}
              onOpenApproval={onOpenApproval}
              onRefresh={refreshNow}
              emptyLabel="Nothing unstaged"
              dnd={dnd}
            />
          )}
          {visibleColumns.map((column) => (
            <BoardColumn
              key={column.id}
              column={column}
              selectedKey={selectedKey}
              onSelect={(key) => setSelectedKey(key === selectedKey ? null : key)}
              onOpenApproval={onOpenApproval}
              onRefresh={refreshNow}
              emptyLabel={needsYou ? "Nothing waiting on you" : "Nothing here"}
              dnd={dnd}
            />
          ))}
          {visibleColumns.length === 0 && (
            <div className="p-3 text-sm text-muted">No columns returned.</div>
          )}
        </div>
      )}
    </div>
  );
}

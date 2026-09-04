import { useCallback, useEffect, useState } from "react";
import { api, type ActivityRecord, type ActivityUsers } from "../api";
import { ActorChip } from "./ActorChip";
import { STATUS } from "../lib/status-colors";
import { useUrlState, nullableStringParser, nullableStringSerializer } from "../hooks/useUrlState";

const PAGE = 50;

/**
 * Outcome → the shared status palette. Never local hex: the palette is the one
 * place these hues are decided, and a second opinion here would drift from the
 * rest of the dashboard.
 */
const OUTCOME_COLOR: Record<ActivityRecord["outcome"], string> = {
  ok: STATUS.good,
  denied: STATUS.info,
  error: STATUS.bad,
};

/** Relative time, matching how the home page's live rows read. */
function timeAgo(iso: string): string {
  const diff = Date.now() - Date.parse(iso);
  const sec = Math.round(diff / 1000);
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 24) return `${hr}h ago`;
  return `${Math.round(hr / 24)}d ago`;
}

/** `detail` rendered as `k=v` pairs — a summary, so it is always short. */
function renderDetail(detail?: Record<string, string | number | boolean>): string {
  if (!detail) return "";
  return Object.entries(detail)
    .map(([k, v]) => `${k}=${v}`)
    .join("  ");
}

export function ActivityRow({ row, users }: { row: ActivityRecord; users: ActivityUsers }) {
  const user = row.actorLogin ? users[row.actorLogin] : undefined;
  return (
    <tr className="hover:bg-base-200/40">
      <td className="whitespace-nowrap text-base-content/50 text-xs">{timeAgo(row.createdAt)}</td>
      <td className="whitespace-nowrap">
        {row.actorLogin ? (
          <ActorChip login={row.actorLogin} actorType={row.actorType} user={user ?? null} />
        ) : (
          // NOT an empty cell: the row is complete, the login genuinely does
          // not exist (a password session, or auth disabled entirely).
          <span className="text-base-content/40 italic text-xs" title="No verified login on this session">
            no login
            {row.actorType ? ` · ${row.actorType}` : ""}
          </span>
        )}
      </td>
      <td className="whitespace-nowrap font-mono text-xs">{row.action}</td>
      <td className="text-xs text-base-content/70 max-w-[22rem] truncate" title={row.targetId}>
        {row.targetType ? (
          <>
            <span className="text-base-content/40">{row.targetType}:</span>
            {row.targetId}
          </>
        ) : null}
      </td>
      <td className="whitespace-nowrap text-xs">
        <span style={{ color: OUTCOME_COLOR[row.outcome] }}>● </span>
        {row.outcome}
      </td>
      <td className="text-xs text-base-content/50 font-mono truncate max-w-[18rem]">
        {renderDetail(row.detail)}
      </td>
    </tr>
  );
}

/**
 * The global audit feed (issue #206) — who did what, across every surface.
 *
 * Plain `fetch` + `useState` + an interval, like every other page here; there
 * is no React Query in this app. Filter state rides the URL so a filtered feed
 * is linkable.
 */
export function ActivityPage() {
  const [rows, setRows] = useState<ActivityRecord[]>([]);
  const [users, setUsers] = useState<ActivityUsers>({});
  const [total, setTotal] = useState(0);
  const [limit, setLimit] = useState(PAGE);
  const [actions, setActions] = useState<string[]>([]);
  const [actor, setActor] = useUrlState<string | null>(
    "actor",
    null,
    nullableStringParser,
    nullableStringSerializer,
  );
  const [action, setAction] = useUrlState<string | null>(
    "action",
    null,
    nullableStringParser,
    nullableStringSerializer,
  );

  // A filter change resets paging — otherwise "load more" keeps a limit that
  // belonged to a different result set.
  useEffect(() => {
    setLimit(PAGE);
  }, [actor, action]);

  const load = useCallback(async () => {
    try {
      const data = await api.activity({
        limit,
        actor: actor ?? undefined,
        action: action ?? undefined,
      });
      setRows(data.activity);
      setUsers(data.users ?? {});
      setTotal(data.total);
    } catch {
      // Leave the last good render in place — a transient admin-API blip
      // should not blank the page.
    }
  }, [limit, actor, action]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 15_000);
    return () => clearInterval(timer);
  }, [load]);

  useEffect(() => {
    api
      .activityActions()
      .then((d) => setActions(d.actions))
      .catch(() => {});
  }, []);

  return (
    <div className="p-4 space-y-3 overflow-auto">
      <div className="flex items-center gap-2 flex-wrap">
        <h2 className="text-lg font-semibold">Activity</h2>
        <span className="text-xs text-base-content/50">
          every user-initiated action, newest first
        </span>
        <div className="grow" />
        <input
          className="input input-sm input-bordered w-44"
          placeholder="Filter by actor…"
          value={actor ?? ""}
          onChange={(e) => setActor(e.target.value || null)}
        />
        <select
          className="select select-sm select-bordered w-52"
          value={action ?? ""}
          onChange={(e) => setAction(e.target.value || null)}
        >
          <option value="">All actions</option>
          {actions.map((a) => (
            <option key={a} value={a}>
              {a}
            </option>
          ))}
        </select>
      </div>

      <div className="overflow-x-auto">
        <table className="table table-sm">
          <thead>
            <tr className="text-xs">
              <th>When</th>
              <th>Actor</th>
              <th>Action</th>
              <th>Target</th>
              <th>Outcome</th>
              <th>Detail</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row) => (
              <ActivityRow key={row.id} row={row} users={users} />
            ))}
          </tbody>
        </table>
        {rows.length === 0 && (
          <div className="text-center text-base-content/50 text-sm py-8">
            No activity recorded yet.
          </div>
        )}
      </div>

      <div className="flex items-center gap-3 text-xs text-base-content/50">
        <span>
          {rows.length} of {total}
        </span>
        {rows.length < total && (
          <button className="btn btn-xs" onClick={() => setLimit((l) => l + PAGE)}>
            Load more
          </button>
        )}
      </div>
    </div>
  );
}

/**
 * The per-run activity strip.
 *
 * Renders NOTHING when the run has no activity — the same self-hiding rule
 * `PrStatePanel` follows, which is what keeps the run detail panel from filling
 * with empty sections. Fetched once on selection rather than polled, like
 * `FeedbackBadge`.
 */
export function RunActivityStrip({ runId }: { runId: string }) {
  const [rows, setRows] = useState<ActivityRecord[]>([]);
  const [users, setUsers] = useState<ActivityUsers>({});

  useEffect(() => {
    let cancelled = false;
    api
      .activity({ target: `workflow_run:${runId}`, limit: 20 })
      .then((d) => {
        if (cancelled) return;
        setRows(d.activity);
        setUsers(d.users ?? {});
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [runId]);

  if (rows.length === 0) return null;

  return (
    <div className="border-t border-base-300 px-4 py-2">
      <div className="text-xs font-semibold text-base-content/60 mb-1">Activity</div>
      <ul className="space-y-1">
        {rows.map((row) => (
          <li key={row.id} className="flex items-center gap-2 text-xs">
            <span style={{ color: OUTCOME_COLOR[row.outcome] }}>●</span>
            <span className="font-mono">{row.action}</span>
            {row.actorLogin ? (
              <ActorChip
                login={row.actorLogin}
                actorType={row.actorType}
                user={users[row.actorLogin] ?? null}
              />
            ) : (
              <span className="text-base-content/40 italic">no login</span>
            )}
            <span className="text-base-content/40">{timeAgo(row.createdAt)}</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

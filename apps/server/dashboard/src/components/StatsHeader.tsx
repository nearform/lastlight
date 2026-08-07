import clsx from "clsx";
import { useState } from "react";
import { BookOpen, Clock, Filter, GitBranch, LogOut, Moon, Radio, RefreshCw, Sun } from "lucide-react";
import type { MeRepos } from "../api";
import type { StreamStatus } from "../hooks/useSessionStream";
import { useTheme } from "../hooks/useTheme";
import { useVisibleRepos } from "../hooks/useVisibleRepos";
import { NearformLogo } from "./NearformLogo";
import { VersionPin } from "./VersionPin";

interface Props {
  timeRange: string;
  onTimeRangeChange: (r: string) => void;
  liveCount: number;
  query: string;
  onQueryChange: (q: string) => void;
  streamStatus: StreamStatus;
  /** Hide the live-count button (e.g. on the workflows tab where live filter doesn't apply). */
  hideLive?: boolean;
  /** Optional logout handler. If omitted (e.g. when auth is disabled), the button is hidden. */
  onLogout?: () => void;
}

const STATUS_LABEL: Record<StreamStatus, { text: string; color: string }> = {
  live: { text: "live", color: "bg-success" },
  connecting: { text: "connecting", color: "bg-warning animate-pulse" },
  reconnecting: { text: "reconnecting", color: "bg-warning animate-pulse" },
  closed: { text: "offline", color: "bg-error" },
};

/**
 * Why the filter has nothing to offer, in the words of the person who'd have to
 * act on it. Keyed by the `reason` the `/me/repos` endpoint returns.
 *
 * `ok` is absent on purpose — it is not an unresolved state, and the type makes
 * leaving it out a compile error if that ever changes. `disabled` is absent for
 * the same reason: the control is not drawn at all when the feature is off.
 */
const UNRESOLVED_HINT: Record<Exclude<MeRepos["reason"], "ok" | "disabled">, string> = {
  "no-teams": "You're in no GitHub team that owns a managed repo.",
  "no-identity": "Team filtering needs a GitHub login — this session signed in another way.",
  unavailable: "Your teams couldn't be looked up just now.",
  "too-many-teams": "You're in too many teams to resolve within the configured budget.",
  truncated: "A team's repo list was too large to read fully.",
  budget: "Resolving your teams exceeded the configured request budget.",
  error: "GitHub returned an error while resolving your teams.",
};

/**
 * The hint for a reason the caller believes is unresolved. `ok` / `disabled`
 * cannot reach here (the toggle branches on `degraded` and `offered` first),
 * but the compiler can't prove that from a boolean, so they fall back rather
 * than widening the map — which would cost the exhaustiveness check that makes
 * a newly-added reason a build error instead of an `undefined` tooltip.
 */
function unresolvedHint(reason: MeRepos["reason"] | undefined): string {
  if (!reason || reason === "ok" || reason === "disabled") return UNRESOLVED_HINT.unavailable;
  return UNRESOLVED_HINT[reason];
}

const TIME_RANGES = [
  { key: "hour", label: "1h" },
  { key: "day", label: "24h" },
  { key: "week", label: "7d" },
  { key: "all", label: "all" },
];

/**
 * The optional "my teams' repos" filter (issue #169) — OFF unless the user
 * turns it on, and remembered per browser once they do.
 *
 * Opt-in rather than opt-out because GitHub team grants describe involvement,
 * not access: an org owner reaches every repo without a team grant anywhere, so
 * as a default this would hide people's own projects. As a filter somebody
 * chose, narrowing to their teams' repos is exactly the decluttering they asked
 * for, and one click undoes it.
 *
 * **Rendered whenever the operator enabled `teamVisibility`** — not only once
 * grants resolved. When there is nothing to narrow to, it says so and offers a
 * re-sync instead of disappearing: the common path into that state is somebody
 * who just created a team or granted it repos, and the answer they need to
 * invalidate is cached for an hour. Hiding the control hid the fix.
 *
 * The one state it is NOT drawn in is the feature being off, which is also the
 * one state a re-sync provably cannot change — `resync()` short-circuits on
 * `config.enabled` before it touches GitHub.
 */
function RepoScopeToggle() {
  const { scope, setScope, offered, degraded, meta, resync } = useVisibleRepos();
  const [resyncing, setResyncing] = useState(false);
  if (!offered) return null;

  const count = meta?.repos?.length ?? 0;
  const on = scope === "mine";

  // Nothing to filter to. The click re-asks the server rather than toggling a
  // scope that would narrow nothing — the button IS the escape hatch.
  if (degraded) {
    return (
      <button
        onClick={() => {
          setResyncing(true);
          void resync().finally(() => setResyncing(false));
        }}
        disabled={resyncing}
        className="btn btn-xs h-7 min-h-0 gap-1 px-2 text-2xs btn-ghost text-base-content/40"
        title={`${unresolvedHint(meta?.reason)} Nothing is filtered. Click to re-check your teams.`}
      >
        <RefreshCw className={clsx("w-3.5 h-3.5", resyncing && "animate-spin")} />
        <span className="font-mono">{resyncing ? "checking…" : "my teams (none)"}</span>
      </button>
    );
  }

  return (
    <button
      onClick={() => setScope(on ? "all" : "mine")}
      className={clsx(
        "btn btn-xs h-7 min-h-0 gap-1 px-2 text-2xs btn-ghost",
        on ? "text-base-content/70" : "text-base-content/40",
      )}
      title={
        on
          ? `Filtered to the ${count} repo${count === 1 ? "" : "s"} your GitHub teams own. Click to show all repos.`
          : "Showing every managed repo. Click to filter to your GitHub teams' repos."
      }
    >
      <Filter className={clsx("w-3.5 h-3.5", on && "text-primary")} />
      <span className="font-mono">{on ? `my teams (${count})` : "all repos"}</span>
    </button>
  );
}

export function StatsHeader({
  timeRange,
  onTimeRangeChange,
  liveCount,
  query,
  onQueryChange,
  streamStatus,
  hideLive,
  onLogout,
}: Props) {
  const statusInfo = STATUS_LABEL[streamStatus];
  const { isDark, toggleTheme } = useTheme();

  return (
    <header className="bg-base-200 border-b border-base-300 flex items-center gap-3 px-4 h-12 shrink-0">
      <div className="flex items-center gap-2.5 shrink-0">
        <NearformLogo size={28} className="nf-logo" />
        <span className="text-base font-bold tracking-tight">Last Light</span>
        <span
          className={clsx("w-2 h-2 rounded-full", statusInfo.color)}
          title={statusInfo.text}
        />
      </div>

      <div className="relative shrink-0 w-64">
        <input
          type="text"
          value={query}
          onChange={(e) => onQueryChange(e.target.value)}
          placeholder="Search..."
          className="input input-sm input-bordered w-full bg-base-100 text-sm pl-7 pr-7 h-8"
        />
        <svg
          className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-base-content/40 pointer-events-none"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
        >
          <circle cx="11" cy="11" r="7" />
          <path d="m21 21-4.3-4.3" />
        </svg>
        {query && (
          <button
            onClick={() => onQueryChange("")}
            className="absolute right-2 top-1/2 -translate-y-1/2 text-base-content/40 hover:text-base-content text-xs"
            aria-label="clear search"
          >
            x
          </button>
        )}
      </div>

      <div className="flex items-center gap-1 shrink-0 border-l border-base-300 pl-3">
        <Clock size={12} className="text-base-content/40 shrink-0" />
        {!hideLive && (
          <button
            onClick={() => onTimeRangeChange("live")}
            className={clsx(
              "btn btn-xs h-7 min-h-0 font-medium gap-1 px-2",
              timeRange === "live" ? "btn-success" : "btn-ghost text-base-content/50",
            )}
          >
            <Radio size={12} className={liveCount > 0 ? "animate-pulse text-success" : ""} />
            <span className="text-2xs">{liveCount > 0 ? `${liveCount} live` : "live"}</span>
          </button>
        )}
        {TIME_RANGES.map((r) => (
          <button
            key={r.key}
            onClick={() => onTimeRangeChange(r.key)}
            className={clsx(
              "btn btn-xs h-7 min-h-0 font-mono text-2xs px-2",
              timeRange === r.key ? "btn-primary" : "btn-ghost text-base-content/50",
            )}
          >
            {r.label}
          </button>
        ))}
      </div>

      <RepoScopeToggle />

      <div className="flex-1" />

      <a
        href="https://lastlight.dev/docs"
        target="_blank"
        rel="noopener noreferrer"
        className="btn btn-ghost btn-xs h-7 min-h-0 px-2 text-base-content/50 hover:text-base-content"
        title="Documentation"
        aria-label="Open the documentation in a new tab"
      >
        <BookOpen size={14} />
      </a>

      <a
        href="https://github.com/nearform/lastlight/issues"
        target="_blank"
        rel="noopener noreferrer"
        className="btn btn-ghost btn-xs h-7 min-h-0 px-2 text-base-content/50 hover:text-base-content"
        title="GitHub issues"
        aria-label="Open GitHub issues in a new tab"
      >
        <GitBranch size={14} />
      </a>

      <VersionPin />

      <button
        onClick={toggleTheme}
        className="btn btn-ghost btn-xs h-7 min-h-0 px-2 text-base-content/50 hover:text-base-content"
        title={isDark ? "Switch to light theme" : "Switch to dark theme"}
        aria-label="Toggle light/dark theme"
      >
        {isDark ? <Sun size={14} /> : <Moon size={14} />}
      </button>

      {onLogout && (
        <button
          onClick={onLogout}
          className="btn btn-ghost btn-xs h-7 min-h-0 px-2 text-base-content/50 hover:text-base-content"
          title="Log out"
          aria-label="Log out"
        >
          <LogOut size={14} />
        </button>
      )}
    </header>
  );
}

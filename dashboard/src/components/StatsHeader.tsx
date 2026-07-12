import clsx from "clsx";
import { Clock, LogOut, Moon, Radio, Sun } from "lucide-react";
import type { StreamStatus } from "../hooks/useSessionStream";
import { useTheme } from "../hooks/useTheme";
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

const TIME_RANGES = [
  { key: "hour", label: "1h" },
  { key: "day", label: "24h" },
  { key: "week", label: "7d" },
  { key: "all", label: "all" },
];

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

      <div className="flex-1" />

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

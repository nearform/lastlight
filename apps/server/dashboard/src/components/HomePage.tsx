import { useEffect, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from "recharts";
import { api, type WorkflowRun, type ContainerStats } from "../api";
import { useStatsSeries } from "../hooks/useDailyStats";
import { useTheme } from "../hooks/useTheme";
import { repoUrl, issueUrl, runRepoPath } from "../lib/githubLinks";
import { GhLink } from "./GhLink";
import clsx from "clsx";

type StatRange = "today" | "7d" | "30d";

// Recharts can't resolve `hsl(var(--p))` because it parses fill strings
// internally for tooltip swatches and gradients. Use literal hex per theme so
// the chart renders — CHART_DARK matches the daisyUI `lastlight` theme,
// CHART_LIGHT matches `neaform`. Selected in-component via useTheme().
const CHART_DARK = {
  success: "#86efac",
  error: "#fca5a5",
  primary: "#7dd3fc",
  secondary: "#c4b5fd",
  accent: "#fcd34d",
  info: "#67e8f9",
  grid: "#21262d",
  axis: "rgba(230, 237, 243, 0.45)",
  tooltipBg: "#161b22",
  tooltipBorder: "#21262d",
};

const CHART_LIGHT = {
  success: "#07a06f",
  error: "#dc2626",
  primary: "#0b3b63",
  secondary: "#7c3aed",
  accent: "#b45309",
  info: "#0b3b63",
  grid: "#e2e6ea",
  axis: "rgba(27, 35, 48, 0.55)",
  tooltipBg: "#ffffff",
  tooltipBorder: "#e2e6ea",
};

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s ago`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m ago`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h ago`;
  return `${Math.floor(secs / 86400)}d ago`;
}

function formatCost(usd: number): string {
  if (usd === 0) return "$0.00";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GiB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(0)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KiB`;
  return `${n} B`;
}

function shortContainerName(name: string): string {
  // `lastlight-sandbox-{taskId}-{uuid}` → `sandbox-{taskId}`
  const sandbox = name.match(/^lastlight-sandbox-(.+?)-[a-f0-9]{8}$/);
  if (sandbox) return `sandbox-${sandbox[1]}`;
  // `lastlight-agent-1` → `agent`
  if (name.startsWith("lastlight-agent")) return "agent";
  return name.replace(/^lastlight-/, "");
}

function StatusBadge({ status }: { status: WorkflowRun["status"] }) {
  const cls = clsx("badge badge-xs font-mono", {
    "badge-info": status === "running",
    "badge-warning": status === "paused",
    "badge-success": status === "succeeded",
    "badge-error": status === "failed",
    "badge-ghost": status === "cancelled",
  });
  return <span className={cls}>{status}</span>;
}

function useLiveActivity() {
  const [workflowCount, setWorkflowCount] = useState(0);
  const [liveWorkflows, setLiveWorkflows] = useState<WorkflowRun[]>([]);
  const [containerCount, setContainerCount] = useState(0);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [wf, ct] = await Promise.all([
          api.workflowRuns({ status: "active", limit: 5 }),
          api.containers(),
        ]);
        if (!cancelled) {
          setWorkflowCount(wf.total);
          setLiveWorkflows(wf.workflowRuns);
          setContainerCount(ct.containers.length);
        }
      } catch {
        /* ignore */
      }
    };
    load();
    const t = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return { workflowCount, liveWorkflows, containerCount };
}

function useContainerStats() {
  const [stats, setStats] = useState<ContainerStats[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.containerStats();
        if (!cancelled) setStats(res.stats);
      } catch {
        /* ignore */
      }
    };
    load();
    // `docker stats --no-stream` is ~1s; poll every 10s to keep load low.
    const t = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return stats;
}

function ResourceUsageSection({ stats }: { stats: ContainerStats[] }) {
  return (
    <div className="card bg-base-200 shadow-sm">
      <div className="card-body p-4">
        <h2 className="card-title text-sm font-semibold text-base-content/70 uppercase tracking-wide mb-3">
          Resource Usage
        </h2>
        {stats.length === 0 ? (
          <p className="text-xs text-base-content/40 text-center py-4">No container stats</p>
        ) : (
          <div className="space-y-2">
            {stats.map((s) => (
              <div key={s.name} className="bg-base-100 rounded p-2">
                <div className="flex items-center justify-between text-xs mb-1">
                  <span className="font-mono text-base-content/80 truncate">
                    {shortContainerName(s.name)}
                  </span>
                  <span className="text-base-content/40 font-mono shrink-0 ml-2">
                    {formatBytes(s.memUsageBytes)} / {formatBytes(s.memLimitBytes)}
                  </span>
                </div>
                <div className="flex gap-2 items-center">
                  <div className="flex-1">
                    <div className="flex justify-between text-2xs text-base-content/50 mb-0.5">
                      <span>CPU</span>
                      <span className="font-mono">{s.cpuPercent.toFixed(1)}%</span>
                    </div>
                    <progress
                      className="progress progress-primary h-1.5 w-full"
                      value={Math.min(s.cpuPercent, 100)}
                      max={100}
                    />
                  </div>
                  <div className="flex-1">
                    <div className="flex justify-between text-2xs text-base-content/50 mb-0.5">
                      <span>MEM</span>
                      <span className="font-mono">{s.memPercent.toFixed(1)}%</span>
                    </div>
                    <progress
                      className="progress progress-secondary h-1.5 w-full"
                      value={Math.min(s.memPercent, 100)}
                      max={100}
                    />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function useRecentWorkflows() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.workflowRuns({ limit: 3 });
        if (!cancelled) setRuns(res.workflowRuns);
      } catch {
        /* ignore */
      }
    };
    load();
    const t = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return runs;
}

/**
 * The `owner/repo #N` target of a run, linked to GitHub where possible. Falls
 * back to plain text when the repo isn't a full `owner/repo` (no URL to build).
 */
function RunTarget({ run }: { run: WorkflowRun }) {
  if (!run.repo && !run.issueNumber) return <span className="flex-1" />;
  // `run.repo` is a BARE name; resolve the qualified `owner/repo` for the URL.
  const repoPath = runRepoPath(run);
  const rHref = repoUrl(repoPath);
  const iHref = issueUrl(repoPath, run.issueNumber, run.workflowName);
  return (
    <span className="font-mono text-base-content/50 truncate flex-1">
      {run.repo &&
        (rHref ? (
          <GhLink href={rHref} title={`Open ${run.repo} on GitHub`}>
            {run.repo}
          </GhLink>
        ) : (
          run.repo
        ))}
      {run.issueNumber ? (
        iHref ? (
          <GhLink href={iHref} title={`Open #${run.issueNumber} on GitHub`}>
            #{run.issueNumber}
          </GhLink>
        ) : (
          `#${run.issueNumber}`
        )
      ) : null}
    </span>
  );
}

function LiveActivitySection({
  workflowCount,
  liveWorkflows,
  containerCount,
  onSelect,
}: {
  workflowCount: number;
  liveWorkflows: WorkflowRun[];
  containerCount: number;
  onSelect: (id: string) => void;
}) {
  return (
    <div className="card bg-base-200 shadow-sm">
      <div className="card-body p-4">
        <h2 className="card-title text-sm font-semibold text-base-content/70 uppercase tracking-wide mb-3">
          Live Activity
        </h2>
        <div className="flex gap-4 mb-4">
          <div className="stat bg-base-100 rounded-box p-3 flex-1">
            <div className="stat-title text-xs">Active Workflows</div>
            <div className="stat-value text-2xl text-primary">{workflowCount}</div>
          </div>
          <div className="stat bg-base-100 rounded-box p-3 flex-1">
            <div className="stat-title text-xs">Running Containers</div>
            <div className="stat-value text-2xl text-secondary">{containerCount}</div>
          </div>
        </div>
        {liveWorkflows.length === 0 ? (
          <p className="text-xs text-base-content/40 text-center py-4">No active workflows</p>
        ) : (
          <div className="space-y-1">
            {liveWorkflows.map((run) => (
              <div
                key={run.id}
                role="button"
                tabIndex={0}
                onClick={() => onSelect(run.id)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(run.id);
                  }
                }}
                className="flex items-center gap-2 px-3 py-2 bg-base-100 rounded text-xs w-full text-left cursor-pointer hover:bg-base-300/60 transition-colors"
              >
                <StatusBadge status={run.status} />
                <span className="font-mono text-base-content/90 shrink-0">
                  {run.workflowName}
                </span>
                <RunTarget run={run} />
                <span className="text-base-content/50 shrink-0">{run.currentPhase}</span>
                <span className="text-base-content/40 shrink-0">{timeAgo(run.startedAt)}</span>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function RecentWorkflowsSection({
  runs,
  onSelect,
}: {
  runs: WorkflowRun[];
  onSelect: (id: string) => void;
}) {
  return (
    <div className="card bg-base-200 shadow-sm">
      <div className="card-body p-4">
        <h2 className="card-title text-sm font-semibold text-base-content/70 uppercase tracking-wide mb-3">
          Recent Workflows
        </h2>
        {runs.length === 0 ? (
          <p className="text-xs text-base-content/40 text-center py-4">No workflows yet</p>
        ) : (
          <div className="space-y-1">
            {runs.map((run) => {
              const durationMs = run.finishedAt
                ? new Date(run.finishedAt).getTime() - new Date(run.startedAt).getTime()
                : null;
              const duration = durationMs
                ? durationMs < 60000
                  ? `${Math.round(durationMs / 1000)}s`
                  : `${Math.floor(durationMs / 60000)}m${Math.round((durationMs % 60000) / 1000)}s`
                : null;
              return (
                <div
                  key={run.id}
                  role="button"
                  tabIndex={0}
                  onClick={() => onSelect(run.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      onSelect(run.id);
                    }
                  }}
                  className="flex items-center gap-2 px-3 py-2 bg-base-100 rounded text-xs w-full text-left cursor-pointer hover:bg-base-300/60 transition-colors"
                >
                  <StatusBadge status={run.status} />
                  <span className="font-mono text-base-content/90 shrink-0">
                    {run.workflowName}
                  </span>
                  <RunTarget run={run} />
                  {duration && (
                    <span className="text-base-content/50 shrink-0">{duration}</span>
                  )}
                  <span className="text-base-content/40 shrink-0">{timeAgo(run.startedAt)}</span>
                </div>
              );
            })}
          </div>
        )}
      </div>
    </div>
  );
}

function StatsChartsSection() {
  const [range, setRange] = useState<StatRange>("7d");
  const { isDark } = useTheme();
  const CHART = isDark ? CHART_DARK : CHART_LIGHT;
  const granularity = range === "today" ? "hour" : "day";
  const count = range === "today" ? 24 : range === "7d" ? 7 : 30;
  const { series, loading } = useStatsSeries(granularity, count);

  const summary = series
    ? series.reduce(
        (acc, d) => ({
          executions: acc.executions + d.executions,
          tokens: acc.tokens + d.totalTokens,
          cost: acc.cost + d.costUsd,
        }),
        { executions: 0, tokens: 0, cost: 0 },
      )
    : null;

  const chartData = series?.map((d) => ({
    // Hourly bucket key is `YYYY-MM-DDTHH` → render `HH:00`.
    // Daily bucket key is `YYYY-MM-DD` → render `MM-DD`.
    date: granularity === "hour" ? `${d.date.slice(11, 13)}:00` : d.date.slice(5),
    executions: d.executions,
    successes: d.successes,
    failures: d.failures,
    inputTokens: d.inputTokens,
    outputTokens: d.outputTokens,
    cacheTokens: d.cacheReadTokens,
    cost: d.costUsd,
  })) ?? [];

  const hasData = chartData.some((d) => d.executions > 0);

  return (
    <div className="card bg-base-200 shadow-sm">
      <div className="card-body p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="card-title text-sm font-semibold text-base-content/70 uppercase tracking-wide">
            Stats
          </h2>
          <div className="join">
            {(["today", "7d", "30d"] as StatRange[]).map((r) => (
              <button
                key={r}
                className={`join-item btn btn-xs ${range === r ? "btn-primary" : "btn-ghost"}`}
                onClick={() => setRange(r)}
              >
                {r}
              </button>
            ))}
          </div>
        </div>

        {/* Summary stat cards */}
        {summary && (
          <div className="flex gap-3 mb-4">
            <div className="stat bg-base-100 rounded-box p-3 flex-1">
              <div className="stat-title text-xs">Executions</div>
              <div className="stat-value text-xl">{summary.executions}</div>
            </div>
            <div className="stat bg-base-100 rounded-box p-3 flex-1">
              <div className="stat-title text-xs">Tokens</div>
              <div className="stat-value text-xl">{formatTokens(summary.tokens)}</div>
            </div>
            <div className="stat bg-base-100 rounded-box p-3 flex-1">
              <div className="stat-title text-xs">Cost</div>
              <div className="stat-value text-xl">{formatCost(summary.cost)}</div>
            </div>
          </div>
        )}

        {loading && (
          <div className="flex items-center justify-center h-32 text-base-content/40 text-xs">
            Loading…
          </div>
        )}

        {!loading && !hasData && (
          <div className="flex items-center justify-center h-32 text-base-content/40 text-xs">
            No data yet
          </div>
        )}

        {!loading && hasData && (
          <div className="space-y-4">
            {/* Execution count bar chart */}
            <div>
              <p className="text-xs text-base-content/50 mb-1 font-medium">Executions per {granularity}</p>
              <ResponsiveContainer width="100%" height={120}>
                <BarChart data={chartData} margin={{ top: 2, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: CHART.axis }} stroke={CHART.axis} />
                  <YAxis width={48} tick={{ fontSize: 10, fill: CHART.axis }} stroke={CHART.axis} allowDecimals={false} />
                  {/* Spacer right-axis so this chart's plot area matches the
                      Token chart, which has a real right axis. */}
                  <YAxis yAxisId="spacer" orientation="right" width={48} tick={false} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipBorder}` }}
                    cursor={{ fill: "rgba(255,255,255,0.04)" }}
                  />
                  <Bar dataKey="successes" stackId="e" fill={CHART.success} name="success" />
                  <Bar dataKey="failures" stackId="e" fill={CHART.error} name="failure" />
                </BarChart>
              </ResponsiveContainer>
            </div>

            {/* Token usage stacked area */}
            <div>
              <p className="text-xs text-base-content/50 mb-1 font-medium">Token usage per {granularity}</p>
              <ResponsiveContainer width="100%" height={120}>
                <ComposedChart data={chartData} margin={{ top: 2, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: CHART.axis }} stroke={CHART.axis} />
                  <YAxis
                    yAxisId="io"
                    width={48}
                    tick={{ fontSize: 10, fill: CHART.axis }}
                    stroke={CHART.axis}
                    tickFormatter={formatTokens}
                  />
                  <YAxis
                    yAxisId="cache"
                    orientation="right"
                    width={48}
                    tick={{ fontSize: 10, fill: CHART.axis }}
                    stroke={CHART.axis}
                    tickFormatter={formatTokens}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 11, background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipBorder}` }}
                    formatter={(v: number) => formatTokens(v)}
                    cursor={{ fill: "rgba(255,255,255,0.04)" }}
                  />
                  <Bar yAxisId="io" dataKey="inputTokens" stackId="t" fill={CHART.primary} name="input" />
                  <Bar yAxisId="io" dataKey="outputTokens" stackId="t" fill={CHART.secondary} name="output" />
                  <Line yAxisId="cache" type="monotone" dataKey="cacheTokens" stroke={CHART.accent} strokeWidth={2} strokeDasharray="4 2" dot={false} name="cache" />
                </ComposedChart>
              </ResponsiveContainer>
            </div>

            {/* Cost area chart */}
            <div>
              <p className="text-xs text-base-content/50 mb-1 font-medium">Cost per {granularity} (USD)</p>
              <ResponsiveContainer width="100%" height={100}>
                <BarChart data={chartData} margin={{ top: 2, right: 4, left: 0, bottom: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={CHART.grid} />
                  <XAxis dataKey="date" tick={{ fontSize: 10, fill: CHART.axis }} stroke={CHART.axis} />
                  <YAxis width={48} tick={{ fontSize: 10, fill: CHART.axis }} stroke={CHART.axis} tickFormatter={(v) => `$${v.toFixed(2)}`} />
                  <YAxis yAxisId="spacer" orientation="right" width={48} tick={false} axisLine={false} tickLine={false} />
                  <Tooltip
                    contentStyle={{ fontSize: 11, background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipBorder}` }}
                    formatter={(v: number) => formatCost(v)}
                    cursor={{ fill: "rgba(255,255,255,0.04)" }}
                  />
                  <Bar dataKey="cost" fill={CHART.info} name="cost" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

export function HomePage({ onSelectWorkflow }: { onSelectWorkflow: (id: string) => void }) {
  const { workflowCount, liveWorkflows, containerCount } = useLiveActivity();
  const recentRuns = useRecentWorkflows();
  const containerStats = useContainerStats();

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <LiveActivitySection
            workflowCount={workflowCount}
            liveWorkflows={liveWorkflows}
            containerCount={containerCount}
            onSelect={onSelectWorkflow}
          />
          <ResourceUsageSection stats={containerStats} />
          <RecentWorkflowsSection runs={recentRuns} onSelect={onSelectWorkflow} />
        </div>
        <div className="lg:col-span-3">
          <StatsChartsSection />
        </div>
      </div>
    </div>
  );
}

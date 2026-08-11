import { useEffect, useMemo, useState } from "react";
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  ComposedChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  Legend,
  CartesianGrid,
} from "recharts";
import { Server, Bot, Box, Network } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { api, type WorkflowRun, type ContainerStats, type ContainerKind, type HostStats } from "../api";
import { useStatsSeries } from "../hooks/useDailyStats";
import { useTheme } from "../hooks/useTheme";
import { repoUrl, issueUrl, runRepoPath } from "../lib/githubLinks";
import { useVisibleRepos, repoScopeParam } from "../hooks/useVisibleRepos";
import { GhLink } from "./GhLink";
import { ActorChip } from "./ActorChip";
import clsx from "clsx";

type StatRange = "today" | "7d" | "30d";

// Recharts can't resolve `hsl(var(--p))` because it parses fill strings
// internally for tooltip swatches and gradients. Use literal hex per theme so
// the chart renders — CHART_DARK matches the daisyUI `lastlight` theme,
// CHART_LIGHT matches `neaform`. Selected in-component via useTheme().
/**
 * Execution outcome — a STATUS palette, not a categorical one (issue #325).
 *
 * The four bands are states, not identities, so they take reserved status hues
 * and are **mode-invariant**: the same steps clear 3:1 on both the light card
 * (`#ffffff`) and the dark one (`#161b22`), and re-stepping them per theme
 * would only re-open the separation problem below.
 *
 * Only THREE of the four are solid fills. `skipped` is a hatch (see the
 * `<pattern>` at the chart), because it is the one band that is not an
 * outcome — and because hue could not carry it: every neutral that read as
 * "absence" landed too close to the green, and the best of them (ΔE 15.9,
 * nominally over the floor) was still called out as similar on sight. A floor
 * is a minimum, not a target. Texture is a different channel, so it separates
 * unconditionally.
 *
 * With `skipped` out of the colour set there are only three solids left, and
 * that is the whole reason this palette passes every check in both modes —
 * measured, not eyeballed (OKLab ΔE×100, min of protan/deutan):
 *
 *   succeeded ↔ deferred   22.1   (normal 26.0)
 *   deferred  ↔ failed     14.6   (normal 26.1)
 *   succeeded ↔ failed      8.7   (normal 37.7)   ← worst CVD
 *
 * **The red is a crimson so the green can be a green.** These two move
 * together: a true green (`#0ca30c`) against a pure red (`#d03b3b`) measures
 * ΔE 4.1 for deuteranopes — unusable — and every greener green collides the
 * same way. Cooling the red to `#cc2b5e` buys the room, and only then does
 * `succeeded` get to look like success rather than a teal compromise. The
 * earlier emerald was the other end of the same trade.
 *
 * **`deferred` is BLUE, not amber, and that is a salience decision.** The
 * bands are not equally important — succeeded is the signal, skipped is
 * unremarkable, deferred is an indication of load, failed is bad — so visual
 * weight has to track that order (Tufte's "smallest effective difference";
 * Few's rule that saturation is a budget spent only on what needs attention).
 * A bright amber made the LEAST consequential band the loudest thing on the
 * chart. Blue also stops it overclaiming: Carbon reserves yellow/orange for
 * "regular"/"serious warning", and a full sandbox queue is neither — it is
 * informational, it costs $0, and it clears itself. It fixes the numbers too:
 * amber was the one step failing contrast on white (1.83:1).
 *
 * Two choices carry that, and neither is cosmetic:
 *
 * Red/green dichromacy is the binding constraint on the whole palette, and it
 * cannot be solved by choosing a better red OR a better green in isolation —
 * only by moving the pair apart. (The dashboard's old dark pastels,
 * `#86efac`/`#fca5a5`, measured 5.8: below the ΔE 6 floor outright.)
 *
 * Two knowingly-accepted validator complaints, both properties of a status
 * palette rather than defects:
 *  - `skipped` fails the chroma floor. It is grey ON PURPOSE — grey IS the
 *    message ("nothing ran"), and a status hue there would imply one did.
 *  - `deferred` sits outside the categorical lightness band, and is sub-3:1 on
 *    the light surface (1.83). Both are documented properties of the reference
 *    `warning` step; the prescribed mitigation is never colour alone — hence
 *    the `<Legend>`.
 */
const OUTCOME = {
  succeeded: "#0ca30c",
  skipped: "#6b7280",
  deferred: "#4a7fb5",
  failed: "#cc2b5e",
};

/**
 * Bottom-to-top stack order, and the single source of it. Declared as data
 * rather than left implicit in the JSX because the tooltip has to REVERSE it:
 * a list reads top-down while a stack builds bottom-up, so listing the bands
 * in stack order puts `succeeded` at the top of the tooltip and `failed` at
 * the bottom — the mirror image of the bar the reader is pointing at.
 */
const OUTCOME_STACK = ["succeeded", "skipped", "deferred", "failed"] as const;

/**
 * Drop zero bands from the tooltip (issue #325). Most hours have no failures
 * and no deferrals, and four rows of which two say `0` buries the two that
 * carry information — the reader has to *read* to find out nothing happened.
 * Recharts renders nothing for a `null` name.
 */
function outcomeTooltipFormatter(value: unknown, name: unknown): [string, string] | null {
  return Number(value) > 0 ? [String(value), String(name)] : null;
}

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

// One glyph per container kind (plus the synthetic `host` row).
const KIND_ICON: Record<ContainerKind | "host", LucideIcon> = {
  host: Server,
  agent: Bot,
  sandbox: Box,
  infra: Network,
};

function StatusBadge({ status }: { status: WorkflowRun["status"] }) {
  const cls = clsx("badge badge-xs font-mono", {
    "badge-neutral": status === "queued",
    "badge-info": status === "running",
    "badge-warning": status === "paused",
    "badge-success": status === "succeeded",
    "badge-error": status === "failed",
    "badge-ghost": status === "cancelled",
  });
  return <span className={cls}>{status}</span>;
}

function useLiveActivity() {
  // "Active" is running+paused only — the runs actually executing. Queued runs
  // (parked by the concurrency cap) are counted separately so the two don't
  // double-count, and the live list stays to what's really in flight.
  const [workflowCount, setWorkflowCount] = useState(0);
  const [queuedCount, setQueuedCount] = useState(0);
  const [liveWorkflows, setLiveWorkflows] = useState<WorkflowRun[]>([]);
  const [containerCount, setContainerCount] = useState(0);
  const { allowed: allowedRepos } = useVisibleRepos();
  // The per-repo scope goes to the SERVER (issue #169), so these panels ask for
  // exactly the five rows they render. Narrowing client-side would mean either
  // over-fetching or showing a panel that looks empty because the user's repos
  // happened not to be in the global most-recent handful — and `total` would
  // still be the global count, which is the number the header shows.
  //
  // Memoized on the already-stable `allowed`; a fresh array identity per render
  // would make the effect below refetch on every render.
  const repos = useMemo(() => repoScopeParam(allowedRepos), [allowedRepos]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const [wf, queued, ct] = await Promise.all([
          api.workflowRuns({ status: "running,paused", limit: 5, repos }),
          api.workflowRuns({ status: "queued", limit: 1, repos }),
          api.containers(),
        ]);
        if (!cancelled) {
          setWorkflowCount(wf.total);
          setLiveWorkflows(wf.workflowRuns);
          setQueuedCount(queued.total);
          setContainerCount(ct.containers.length);
        }
      } catch {
        /* ignore */
      }
    };
    load();
    const t = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, [repos]);

  return { workflowCount, queuedCount, liveWorkflows, containerCount };
}

function useContainerStats() {
  const [stats, setStats] = useState<ContainerStats[]>([]);
  const [host, setHost] = useState<HostStats | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const res = await api.containerStats();
        if (!cancelled) {
          setStats(res.stats);
          setHost(res.host);
        }
      } catch {
        /* ignore */
      } finally {
        // Mark loaded after the first attempt (success OR failure) so the panel
        // stops showing its spinner instead of hanging on it forever.
        if (!cancelled) setLoaded(true);
      }
    };
    load();
    // `docker stats --no-stream` is ~1s; poll every 10s to keep load low.
    const t = setInterval(load, 10000);
    return () => { cancelled = true; clearInterval(t); };
  }, []);

  return { stats, host, loaded };
}

/**
 * One CPU/MEM row — shared by the host summary and every container. `emphasis`
 * gives the host row a subtle border so it reads as the aggregate above the
 * per-container list.
 */
function UsageRow({
  icon: Icon,
  label,
  detail,
  cpuPercent,
  memPercent,
  emphasis = false,
}: {
  icon: LucideIcon;
  label: string;
  detail: string;
  cpuPercent: number;
  memPercent: number;
  emphasis?: boolean;
}) {
  return (
    <div className={clsx("bg-base-100 rounded p-2", emphasis && "border border-base-300/70")}>
      <div className="flex items-center justify-between text-xs mb-1">
        <span className="flex items-center gap-1.5 min-w-0">
          <Icon className="w-3.5 h-3.5 shrink-0 text-base-content/50" />
          <span className="font-mono text-base-content/80 truncate">{label}</span>
        </span>
        <span className="text-base-content/40 font-mono shrink-0 ml-2">{detail}</span>
      </div>
      <div className="flex gap-2 items-center">
        <div className="flex-1">
          <div className="flex justify-between text-2xs text-base-content/50 mb-0.5">
            <span>CPU</span>
            <span className="font-mono">{cpuPercent.toFixed(1)}%</span>
          </div>
          <progress
            className="progress progress-primary h-1.5 w-full"
            value={Math.min(cpuPercent, 100)}
            max={100}
          />
        </div>
        <div className="flex-1">
          <div className="flex justify-between text-2xs text-base-content/50 mb-0.5">
            <span>MEM</span>
            <span className="font-mono">{memPercent.toFixed(1)}%</span>
          </div>
          <progress
            className="progress progress-secondary h-1.5 w-full"
            value={Math.min(memPercent, 100)}
            max={100}
          />
        </div>
      </div>
    </div>
  );
}

function ResourceUsageSection({
  stats,
  host,
  loaded,
}: {
  stats: ContainerStats[];
  host: HostStats | null;
  loaded: boolean;
}) {
  const [showInfra, setShowInfra] = useState(false);
  const infraCount = stats.filter((s) => s.kind === "infra").length;
  const visible = showInfra ? stats : stats.filter((s) => s.kind !== "infra");

  return (
    <div className="card bg-base-200 shadow-sm">
      <div className="card-body p-4">
        <div className="flex items-center justify-between mb-3">
          <h2 className="card-title text-sm font-semibold text-base-content/70 uppercase tracking-wide">
            Resource Usage
          </h2>
          {infraCount > 0 && (
            <label className="label cursor-pointer gap-1.5 py-0">
              <span className="label-text text-2xs text-base-content/50">
                infra ({infraCount})
              </span>
              <input
                type="checkbox"
                className="toggle toggle-xs"
                checked={showInfra}
                onChange={(e) => setShowInfra(e.target.checked)}
              />
            </label>
          )}
        </div>
        {!loaded ? (
          <div className="flex items-center justify-center py-8">
            <span className="loading loading-spinner loading-sm text-base-content/30" />
          </div>
        ) : (
          <>
            {host && (
              <div className="mb-2">
                <UsageRow
                  icon={KIND_ICON.host}
                  label="host"
                  detail={`${formatBytes(host.memUsedBytes)} / ${formatBytes(host.memTotalBytes)} · ${host.cpuCount} cores`}
                  cpuPercent={host.cpuPercent}
                  memPercent={host.memPercent}
                  emphasis
                />
              </div>
            )}
            {visible.length === 0 ? (
              <p className="text-xs text-base-content/40 text-center py-4">No container stats</p>
            ) : (
              <div className="space-y-2">
                {visible.map((s) => (
                  <UsageRow
                    key={s.name}
                    icon={KIND_ICON[s.kind]}
                    label={shortContainerName(s.name)}
                    detail={`${formatBytes(s.memUsageBytes)} / ${formatBytes(s.memLimitBytes)}`}
                    cpuPercent={s.cpuPercent}
                    memPercent={s.memPercent}
                  />
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
}

function useRecentWorkflows() {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const { allowed: allowedRepos } = useVisibleRepos();
  // Memoized on the already-stable `allowed` — a fresh array identity per
  // render would make the effect below refetch on every render.
  const repos = useMemo(() => repoScopeParam(allowedRepos), [allowedRepos]);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        // Only finished runs — queued/running/paused live in Live Activity,
        // not "Recent". Terminal statuses = succeeded, failed, cancelled.
        const res = await api.workflowRuns({
          status: "succeeded,failed,cancelled",
          limit: 3,
          repos,
        });
        if (!cancelled) setRuns(res.workflowRuns);
      } catch {
        /* ignore */
      }
    };
    load();
    const t = setInterval(load, 15000);
    return () => { cancelled = true; clearInterval(t); };
  }, [repos]);

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
  queuedCount,
  liveWorkflows,
  containerCount,
  onSelect,
}: {
  workflowCount: number;
  queuedCount: number;
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
            <div className="stat-title text-xs">Queued Workflows</div>
            <div
              className={clsx(
                "stat-value text-2xl",
                queuedCount > 0 ? "text-warning" : "text-base-content/40",
              )}
            >
              {queuedCount}
            </div>
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
                {run.triggeredBy && (
                  <ActorChip
                    login={run.triggeredBy}
                    actorType={run.triggerActorType}
                    className="shrink-0 max-w-[8rem]"
                  />
                )}
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
                  {run.triggeredBy && (
                    <ActorChip
                      login={run.triggeredBy}
                      actorType={run.triggerActorType}
                      className="shrink-0 max-w-[8rem]"
                    />
                  )}
                  {run.totalTokens ? (
                    <span className="text-base-content/40 font-mono shrink-0 tabular-nums" title="tokens">
                      {formatTokens(run.totalTokens)} tok
                    </span>
                  ) : null}
                  {run.totalCostUsd ? (
                    <span className="text-success/80 font-mono shrink-0 tabular-nums" title="cost">
                      {formatCost(run.totalCostUsd)}
                    </span>
                  ) : null}
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
    succeeded: d.succeeded,
    deferred: d.deferred,
    failed: d.failed,
    // `skipped` is deliberately absent from the stack: a cascade skip is the
    // CONSEQUENCE of another row's outcome, so stacking it renders one incident
    // twice. It stays in the tooltip via `executions`.
    skipped: d.skipped,
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
                  {/* Per-band counts plus the TOTAL. The total is the point:
                      the four bands sum to the "Executions" stat card above,
                      and showing it here is what lets a reader confirm that
                      rather than take it on trust. It is also the only place
                      `skipped` is quantified without squinting at a hatch. */}
                  <Tooltip
                    contentStyle={{ fontSize: 11, background: CHART.tooltipBg, border: `1px solid ${CHART.tooltipBorder}` }}
                    cursor={{ fill: "rgba(255,255,255,0.04)" }}
                    itemStyle={{ padding: 0 }}
                    formatter={outcomeTooltipFormatter}
                    itemSorter={(item) => -OUTCOME_STACK.indexOf(
                      String(item.dataKey) as (typeof OUTCOME_STACK)[number],
                    )}
                    labelFormatter={(label, payload) => {
                      const total = (payload ?? []).reduce((n, p) => n + (Number(p.value) || 0), 0);
                      return `${String(label ?? "")} — ${total} execution${total === 1 ? "" : "s"}`;
                    }}
                  />
                  <Legend
                    verticalAlign="bottom"
                    height={24}
                    iconSize={8}
                    wrapperStyle={{ fontSize: 11, color: CHART.axis }}
                  />
                  <defs>
                    {/* `skipped` is the one band that is not an outcome — the
                        phase never ran. It is drawn as a HATCH rather than a
                        fill because hue could not carry it: against the green
                        it measured ΔE 15.9, technically over the floor and
                        still visibly similar. Texture is a different channel
                        entirely, so it separates from all three solids at any
                        severity of colour blindness, in print, and under
                        forced-colors — and it reads as "placeholder", which is
                        what a skip is. */}
                    <pattern id="ll-skip-hatch" patternUnits="userSpaceOnUse" width={5} height={5}
                             patternTransform="rotate(45)">
                      {/* A tinted BODY under the lines, not an outline around
                          them. An outline would be drawn half outside the rect
                          — and since the solid bands' strokes are surface-
                          coloured (their outer half invisible), a visible one
                          renders this segment ~4px wider than the rest of the
                          column at the same strokeWidth. The tint gives the
                          band a definite edge from the inside, so every band
                          keeps identical geometry. */}
                      <rect width={5} height={5} fill={CHART.tooltipBg} />
                      <rect width={5} height={5} fill={OUTCOME.skipped} opacity={0.18} />
                      <line x1={0} y1={0} x2={0} y2={5} stroke={OUTCOME.skipped} strokeWidth={2.5} />
                    </pattern>
                  </defs>
                  {/* Stack order, bottom to top, is SEMANTIC: nothing wrong →
                      nothing happened → load → bad. It could not be before —
                      while `deferred` was amber it had to be held apart from
                      red (ΔE 2.8) by putting the neutral between them. Blue
                      dissolved that constraint, and the semantic order is also
                      the stronger one: the hatch now separates green from blue
                      by texture, leaving deferred↔failed (ΔE 19.0) as the only
                      solid-solid boundary, against 13.5 before.
                      `stroke` is the 2px surface gap between segments. */}
                  <Bar dataKey="succeeded" stackId="e" fill={OUTCOME.succeeded} name="succeeded"
                       stroke={CHART.tooltipBg} strokeWidth={2} />
                  {/* A cascade skip: the phase never ran, because an upstream
                      one didn't succeed. Kept in the stack so the bar totals to
                      the "Executions" headline — it is 31% of rows on a busy
                      day, so hiding it would make the two disagree visibly.
                      Same surface stroke as every other band; see the pattern
                      above for why its definition is a tint, not a border. */}
                  <Bar dataKey="skipped" stackId="e" fill="url(#ll-skip-hatch)" name="skipped"
                       stroke={CHART.tooltipBg} strokeWidth={2} />
                  {/* Capacity, not error: the k8s ResourceQuota rejected the
                      pod and the run requeued. Costs $0 and self-heals — but it
                      IS the signal that the sandbox namespace is saturated, so
                      it earns its own band rather than being hidden. */}
                  <Bar dataKey="deferred" stackId="e" fill={OUTCOME.deferred} name="deferred"
                       stroke={CHART.tooltipBg} strokeWidth={2} />
                  <Bar dataKey="failed" stackId="e" fill={OUTCOME.failed} name="failed"
                       stroke={CHART.tooltipBg} strokeWidth={2} />
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
                    formatter={(v) => formatTokens(Number(v ?? 0))}
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
                    formatter={(v) => formatCost(Number(v ?? 0))}
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
  const { workflowCount, queuedCount, liveWorkflows, containerCount } = useLiveActivity();
  const recentRuns = useRecentWorkflows();
  const { stats, host, loaded } = useContainerStats();

  return (
    <div className="flex-1 overflow-auto p-4">
      <div className="grid grid-cols-1 lg:grid-cols-5 gap-4">
        <div className="lg:col-span-2 space-y-4">
          <LiveActivitySection
            workflowCount={workflowCount}
            queuedCount={queuedCount}
            liveWorkflows={liveWorkflows}
            containerCount={containerCount}
            onSelect={onSelectWorkflow}
          />
          <ResourceUsageSection stats={stats} host={host} loaded={loaded} />
        </div>
        <div className="lg:col-span-3 space-y-4">
          <StatsChartsSection />
          <RecentWorkflowsSection runs={recentRuns} onSelect={onSelectWorkflow} />
        </div>
      </div>
    </div>
  );
}

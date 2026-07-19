import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import clsx from "clsx";
import { DocumentMagnifyingGlassIcon } from "@heroicons/react/24/outline";
import {
  api,
  type WorkflowRun,
  type WorkflowApproval,
  type WorkflowDefinition,
  type WorkflowRunExecution,
} from "../api";
import { WorkflowPipeline } from "./WorkflowPipeline";
import { ApprovalBanner } from "./ApprovalBanner";
import { PhaseDetailPanel } from "./PhaseDetailPanel";
import { MessageFeed, type MessageOrder } from "./MessageFeed";
import {
  useUrlState,
  nullableStringParser,
  nullableStringSerializer,
} from "../hooks/useUrlState";
import { timeRangeToSince } from "../lib/timeRange";
import { repoUrl, issueUrl, runRepoPath } from "../lib/githubLinks";
import { GhLink } from "./GhLink";

function timeAgo(iso: string): string {
  const secs = Math.floor((Date.now() - new Date(iso).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  return `${Math.floor(secs / 86400)}d`;
}

function elapsed(run: WorkflowRun): string {
  const end = run.finishedAt ?? run.updatedAt;
  const secs = Math.floor((new Date(end).getTime() - new Date(run.startedAt).getTime()) / 1000);
  if (secs < 60) return `${secs}s`;
  const m = Math.floor(secs / 60);
  const s = secs % 60;
  return `${m}m${s}s`;
}

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

interface DetailPanelProps {
  run: WorkflowRun;
  approvals: WorkflowApproval[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onApprovalResponded: () => void;
  onOpenDefinition?: (name: string) => void;
}

// ── Resizable pipeline + detail panels ──────────────────────────────────

interface ResizablePipelineProps {
  run: WorkflowRun;
  definition: WorkflowDefinition | null;
  definitionError: string | null;
  executions: WorkflowRunExecution[];
  /** Run-scoped approvals (all statuses) for the gate nodes + approval card. */
  approvals: WorkflowApproval[];
  selectedPhase: string | null;
  onPhaseClick: (phase: string | null) => void;
  selectedExecution: WorkflowRunExecution | null;
  selectedExecutions: WorkflowRunExecution[];
  feedOrder: MessageOrder;
  onFeedOrderChange: (o: MessageOrder) => void;
}

/**
 * Renders the pipeline visualization and the detail panels below it with a
 * draggable divider. The pipeline section is capped at 50% of the available
 * height and can be resized down further by dragging the divider bar.
 */
function ResizablePipeline({
  run,
  definition,
  definitionError,
  executions,
  approvals,
  selectedPhase,
  onPhaseClick,
  selectedExecution,
  selectedExecutions,
  feedOrder,
  onFeedOrderChange,
}: ResizablePipelineProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const [pipelineHeight, setPipelineHeight] = useState<number | null>(null);
  const dragging = useRef(false);
  const startY = useRef(0);
  const startH = useRef(0);

  const onDragStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    dragging.current = true;
    startY.current = e.clientY;
    startH.current = pipelineHeight ?? containerRef.current?.querySelector("[data-pipeline]")?.clientHeight ?? 180;

    const onMove = (ev: MouseEvent) => {
      if (!dragging.current || !containerRef.current) return;
      const containerH = containerRef.current.clientHeight;
      const maxH = Math.floor(containerH * 0.7);
      const minH = 80;
      const delta = ev.clientY - startY.current;
      setPipelineHeight(Math.max(minH, Math.min(maxH, startH.current + delta)));
    };
    const onUp = () => {
      dragging.current = false;
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    document.addEventListener("mousemove", onMove);
    document.addEventListener("mouseup", onUp);
  }, [pipelineHeight]);

  return (
    <div ref={containerRef} className="flex flex-col flex-1 min-h-0">
      {/* Pipeline section — capped at 50% by default */}
      <div
        data-pipeline
        className="shrink-0 overflow-auto"
        style={{ maxHeight: pipelineHeight ?? "50%", height: pipelineHeight ?? undefined }}
      >
        <div className="text-2xs font-semibold uppercase tracking-wider text-base-content/40 mb-2">
          Pipeline
        </div>
        {definitionError ? (
          <div className="p-4 text-sm text-error border border-error/40 bg-error/5 rounded">
            {definitionError}
          </div>
        ) : (
          <WorkflowPipeline
            run={run}
            definition={definition}
            executions={executions}
            approvals={approvals}
            height={180}
            selectedPhase={selectedPhase}
            onPhaseClick={onPhaseClick}
          />
        )}
      </div>

      {/* Draggable divider */}
      <div
        className="shrink-0 flex items-center justify-center cursor-row-resize group py-0.5"
        onMouseDown={onDragStart}
      >
        <div className="w-12 h-1 rounded-full bg-base-300 group-hover:bg-primary/50 transition-colors" />
      </div>

      {/* Detail panels */}
      {selectedPhase ? (
        <div className="flex flex-1 gap-4 min-h-0 border-t border-base-300 pt-3">
          <div className="w-80 shrink-0 overflow-y-auto border border-base-300/60 rounded bg-base-200/30">
            <PhaseDetailPanel
              phaseName={selectedPhase}
              run={run}
              definition={definition}
              execution={selectedExecution}
              totalExecutions={selectedExecutions.length}
              approvals={approvals}
            />
          </div>
          <div className="flex-1 overflow-hidden flex flex-col border border-base-300/60 rounded bg-base-100">
            {selectedExecution?.sessionId ? (
              <MessageFeed
                key={selectedExecution.sessionId}
                sessionId={selectedExecution.sessionId}
                order={feedOrder}
                onOrderChange={onFeedOrderChange}
                searchQuery=""
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-base-content/40 text-sm p-6 text-center">
                {selectedPhase?.startsWith("approval:")
                  ? "Approval gate — no agent session. See the gate details on the left."
                  : selectedExecution
                    ? "Session not captured for this run."
                    : "No execution recorded for this phase yet."}
              </div>
            )}
          </div>
        </div>
      ) : (
        <div className="flex-1 flex items-center justify-center text-base-content/30 text-xs border-t border-base-300 pt-3">
          click a phase above to inspect it
        </div>
      )}
    </div>
  );
}

// ── Detail panel ────────────────────────────────────────────────────────

function DetailPanel({ run, approvals, onCancel, onRetry, onApprovalResponded, onOpenDefinition }: DetailPanelProps) {
  const canCancel = run.status === "running" || run.status === "paused";
  const canRetry = run.status === "failed";

  const [definition, setDefinition] = useState<WorkflowDefinition | null>(null);
  const [definitionError, setDefinitionError] = useState<string | null>(null);
  const [executions, setExecutions] = useState<WorkflowRunExecution[]>([]);

  // Run-scoped approvals — ALL statuses (pending + resolved), unlike the global
  // pending-only `approvals` prop. Drives the pipeline's gate nodes and the
  // detail panel's read-only approval history. Seeded from the pending prop for
  // an instant banner, then enriched (with resolved history) by the fetch.
  const [runApprovals, setRunApprovals] = useState<WorkflowApproval[]>(() =>
    approvals.filter((a) => a.workflowRunId === run.id),
  );
  const [approvalRefresh, setApprovalRefresh] = useState(0);
  useEffect(() => {
    let cancelled = false;
    const fetchOnce = () => {
      api
        .workflowRunApprovals(run.id)
        .then((res) => {
          if (!cancelled) setRunApprovals(res.approvals);
        })
        .catch(() => {
          /* keep the last good list (e.g. the prop seed) on transient error */
        });
    };
    fetchOnce();
    const isTerminal =
      run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
    const timer = isTerminal ? null : setInterval(fetchOnce, 3000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [run.id, run.status, approvalRefresh]);

  const pendingApprovals = runApprovals.filter((a) => a.status === "pending");
  const handleApprovalResponded = () => {
    setApprovalRefresh((n) => n + 1);
    onApprovalResponded();
  };
  // Persisted in the URL so a deep link to ?run=…&phase=… reopens the same
  // split-view the user shared. Cleared when switching workflow runs (the
  // phase param from a previous run isn't meaningful in a new one).
  const [selectedPhase, setSelectedPhase] = useUrlState<string | null>(
    "phase",
    null,
    nullableStringParser,
    nullableStringSerializer,
  );

  // Local state for the embedded MessageFeed (each phase view is its own
  // little session viewer — order/search persist across phase clicks but
  // reset when the workflow run changes).
  const [feedOrder, setFeedOrder] = useState<MessageOrder>("newest");

  // Fetch the workflow definition once per workflow name.
  useEffect(() => {
    let cancelled = false;
    setDefinitionError(null);
    setDefinition(null);
    api
      .workflowDefinition(run.workflowName)
      .then((res) => {
        if (!cancelled) setDefinition(res.workflow);
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setDefinitionError(`Failed to load workflow definition "${run.workflowName}": ${msg}`);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [run.workflowName]);

  // Fetch the executions for this run, then poll while the run is still
  // active. The session id is persisted mid-run (as soon as the agent's
  // stream-json `system/init` line arrives) so the live phase's logs become
  // available without waiting for the next phase boundary. Stops polling
  // once the run is in a terminal state to avoid wasted requests.
  useEffect(() => {
    let cancelled = false;
    const fetchOnce = () => {
      api
        .workflowRunExecutions(run.id)
        .then((res) => {
          if (!cancelled) setExecutions(res.executions);
        })
        .catch(() => {
          if (!cancelled) setExecutions([]);
        });
    };
    fetchOnce();
    const isTerminal =
      run.status === "succeeded" || run.status === "failed" || run.status === "cancelled";
    const timer = isTerminal ? null : setInterval(fetchOnce, 3000);
    return () => {
      cancelled = true;
      if (timer) clearInterval(timer);
    };
  }, [run.id, run.status]);

  // Reset selected phase when actually switching between two different
  // workflow runs — but NOT on the very first mount, so a deep link like
  // ?run=…&phase=… is honored on initial load.
  const prevRunIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (prevRunIdRef.current && prevRunIdRef.current !== run.id) {
      setSelectedPhase(null);
    }
    prevRunIdRef.current = run.id;
  }, [run.id, setSelectedPhase]);

  // Default the selection to the run's first substantive phase once the
  // definition loads, so opening a run — whether by deeplink (?run=… with no
  // ?phase=) or a click — lands on real logs instead of an empty right pane.
  // Skips `context` markers (they never have a session). Only fills a NULL
  // selection, so an explicit ?run=…&phase=… deeplink still wins, and the
  // run-switch reset above re-defaults to the new run's first phase.
  useEffect(() => {
    if (selectedPhase || !definition) return;
    const first = definition.phases.find((p) => p.type !== "context") ?? definition.phases[0];
    if (first) setSelectedPhase(first.name);
  }, [definition, selectedPhase, setSelectedPhase]);

  // Build the per-phase grouping. For loop phases that produced multiple
  // executions (reviewer + reviewer_recheck_* / reviewer_fix_*) we always pick the most
  // recent — the count is shown in PhaseDetailPanel so the user knows.
  const phaseExecutions = useMemo(() => {
    const map = new Map<string, WorkflowRunExecution[]>();
    for (const ex of executions) {
      const arr = map.get(ex.phase);
      if (arr) arr.push(ex);
      else map.set(ex.phase, [ex]);
    }
    return map;
  }, [executions]);

  const selectedExecutions = selectedPhase ? phaseExecutions.get(selectedPhase) ?? [] : [];
  const selectedExecution =
    selectedExecutions.length > 0 ? selectedExecutions[selectedExecutions.length - 1]! : null;

  return (
    <div className="flex-1 overflow-hidden flex flex-col p-4 gap-4 min-h-0">
      <div className="flex items-center gap-3 flex-wrap shrink-0">
        <span className="font-semibold text-base-content">{run.workflowName}</span>
        {onOpenDefinition && (
          <button
            className="btn btn-xs btn-ghost btn-square"
            title="View workflow definition"
            onClick={() => onOpenDefinition(run.workflowName)}
          >
            <DocumentMagnifyingGlassIcon className="w-4 h-4" />
          </button>
        )}
        <StatusBadge status={run.status} />
        {run.repo &&
          (() => {
            const href = repoUrl(runRepoPath(run));
            const cls = "text-xs text-base-content/50 font-mono";
            return href ? (
              <GhLink href={href} className={cls} title={`Open ${run.repo} on GitHub`}>
                {run.repo}
              </GhLink>
            ) : (
              <span className={cls}>{run.repo}</span>
            );
          })()}
        {run.issueNumber &&
          (() => {
            const href = issueUrl(runRepoPath(run), run.issueNumber, run.workflowName);
            const cls = "text-xs text-base-content/50 font-mono";
            return href ? (
              <GhLink href={href} className={cls} title={`Open #${run.issueNumber} on GitHub`}>
                #{run.issueNumber}
              </GhLink>
            ) : (
              <span className={cls}>#{run.issueNumber}</span>
            );
          })()}
        {canCancel && (
          <button
            className="btn btn-xs btn-error btn-outline ml-auto"
            onClick={() => onCancel(run.id)}
          >
            Cancel
          </button>
        )}
        {canRetry && (
          <button
            className="btn btn-xs btn-warning btn-outline ml-auto"
            onClick={() => onRetry(run.id)}
            title="Re-run from the phase that failed, keeping the same context"
          >
            Retry
          </button>
        )}
      </div>

      <div className="text-2xs text-base-content/40 font-mono flex gap-4 shrink-0">
        <span>started {timeAgo(run.startedAt)} ago</span>
        <span>elapsed {elapsed(run)}</span>
        {run.finishedAt && <span>finished {timeAgo(run.finishedAt)} ago</span>}
      </div>

      <ApprovalBanner approvals={pendingApprovals} onResponded={handleApprovalResponded} />

      <ResizablePipeline
        run={run}
        definition={definition}
        definitionError={definitionError}
        executions={executions}
        approvals={runApprovals}
        selectedPhase={selectedPhase}
        onPhaseClick={setSelectedPhase}
        selectedExecution={selectedExecution}
        selectedExecutions={selectedExecutions}
        feedOrder={feedOrder}
        onFeedOrderChange={setFeedOrder}
      />
    </div>
  );
}

const WORKFLOW_PAGE_SIZE = 20;

interface WorkflowListProps {
  /** Header date filter. */
  timeRange: string;
  /** Header free-text search — matches workflow name, repo, issue number. */
  query: string;
  /** When set, server-side-filter the run list to this `owner/repo` (Repos tab). */
  repo?: string;
  /** Optional handler for the "View workflow definition" icon next to the title. */
  onOpenDefinition?: (name: string) => void;
}

export function WorkflowList({ timeRange, query, repo, onOpenDefinition }: WorkflowListProps) {
  const [runs, setRuns] = useState<WorkflowRun[]>([]);
  const [total, setTotal] = useState(0);
  const [approvals, setApprovals] = useState<WorkflowApproval[]>([]);
  const [selectedId, setSelectedId] = useUrlState<string | null>(
    "run",
    null,
    nullableStringParser,
    nullableStringSerializer,
  );
  const [error, setError] = useState<string | null>(null);
  const [limit, setLimit] = useState(WORKFLOW_PAGE_SIZE);
  const [workflowFilter, setWorkflowFilter] = useUrlState<string | null>(
    "workflow",
    null,
    nullableStringParser,
    nullableStringSerializer,
  );
  const [availableWorkflows, setAvailableWorkflows] = useState<string[]>([]);

  // Reset pagination whenever a filter changes — otherwise an inflated `limit`
  // from a previous, larger result set would silently keep showing too many
  // rows after the user narrows.
  useEffect(() => {
    setLimit(WORKFLOW_PAGE_SIZE);
  }, [timeRange, workflowFilter, repo]);

  // Clear the selected run when the Repos tab switches to a different repo.
  // WorkflowList isn't remounted on a repo switch (the `?run=` param survives),
  // so without this a run selected under repo A stays visible after clicking
  // repo B — even when B has no runs at all. Skip the first mount so a deep
  // link like ?repo=A&run=… is still honored on load; the auto-select effect
  // below then picks the new repo's first run (or nothing when it's empty).
  const prevRepoRef = useRef(repo);
  useEffect(() => {
    if (prevRepoRef.current !== repo) {
      prevRepoRef.current = repo;
      setSelectedId(null);
    }
  }, [repo, setSelectedId]);

  const load = useCallback(async () => {
    try {
      const since = timeRangeToSince(timeRange);
      // "live" range maps to status=active (running+paused), no date filter.
      const status = timeRange === "live" ? "active" : undefined;
      const [runsData, approvalsData] = await Promise.all([
        api.workflowRuns({
          limit,
          since,
          status,
          workflow: workflowFilter ?? undefined,
          repo,
        }),
        api.approvals().catch(() => ({ approvals: [] as WorkflowApproval[] })),
      ]);
      setRuns(runsData.workflowRuns);
      setTotal(runsData.total);
      setApprovals(approvalsData.approvals);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [limit, timeRange, workflowFilter, repo]);

  useEffect(() => {
    load();
    const timer = setInterval(load, 5000);
    return () => clearInterval(timer);
  }, [load]);

  // Fetch the distinct workflow-name list once for the filter row.
  useEffect(() => {
    let cancelled = false;
    api
      .workflowNames()
      .then((res) => {
        if (!cancelled) setAvailableWorkflows(res.names);
      })
      .catch(() => {
        if (!cancelled) setAvailableWorkflows([]);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Apply the header free-text search client-side. Backend pagination is by
  // date and workflow name; the search box is just a quick local filter so
  // the user doesn't have to wait for a server roundtrip on every keystroke.
  const visibleRuns = useMemo(() => {
    if (!query) return runs;
    const q = query.toLowerCase();
    return runs.filter((r) => {
      return (
        r.workflowName.toLowerCase().includes(q) ||
        (r.repo ?? "").toLowerCase().includes(q) ||
        String(r.issueNumber ?? "").includes(q) ||
        r.triggerId.toLowerCase().includes(q)
      );
    });
  }, [runs, query]);

  // Auto-select the first run only when nothing is currently selected. We
  // intentionally do NOT clear an existing selectedId just because it's not
  // in the visible set — the user may have arrived via a shareable URL that
  // points to a run outside the current pagination/filters.
  useEffect(() => {
    if (!selectedId && visibleRuns.length > 0) {
      setSelectedId(visibleRuns[0]!.id);
    }
  }, [visibleRuns, selectedId, setSelectedId]);

  // If selectedId points to a run that isn't in the loaded list (e.g. linked
  // from outside or hidden behind pagination), fetch it directly so the
  // detail panel still works.
  //
  // We always fetch the full detail (`/workflow-runs/:id`) for the selected
  // run — not just when it's absent from the list. The list query omits the
  // heavy `context` blob, but the detail panel's Artifacts tab needs
  // `context.issueDir` to locate the run's build assets. The list row still
  // wins for the live-updating fields (status / phaseHistory refresh on poll);
  // we only splice the immutable `context` in from the detail fetch below.
  const [detailRun, setDetailRun] = useState<WorkflowRun | null>(null);
  useEffect(() => {
    if (!selectedId) {
      setDetailRun(null);
      return;
    }
    let cancelled = false;
    api
      .workflowRun(selectedId)
      .then((res) => {
        if (!cancelled) setDetailRun(res.workflowRun);
      })
      .catch(() => {
        if (!cancelled) setDetailRun(null);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const handleCancel = async (id: string) => {
    try {
      await api.cancelWorkflowRun(id);
      await load();
    } catch {
      /* ignore */
    }
  };

  const handleRetry = async (id: string) => {
    try {
      await api.retryWorkflowRun(id);
      await load();
    } catch {
      /* ignore */
    }
  };

  const detailForSelected = detailRun?.id === selectedId ? detailRun : null;
  const listRow = visibleRuns.find((r) => r.id === selectedId) ?? null;
  // Prefer the live-updating list row, but splice in `context` (absent from the
  // list payload) from the detail fetch. Fall back to the full detail when the
  // run isn't in the list at all (deep-linked / paginated out).
  const selectedRun: WorkflowRun | null = listRow
    ? listRow.context
      ? listRow
      : { ...listRow, context: detailForSelected?.context }
    : detailForSelected;
  const hasMore = runs.length < total;

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Filter row — workflow type chips, mirrors the session-type strip on
          the sessions tab. */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-base-300 bg-base-200/40 shrink-0 overflow-x-auto flex-nowrap">
        <button
          onClick={() => setWorkflowFilter(null)}
          className={clsx(
            "btn btn-xs h-7 min-h-0 font-medium shrink-0",
            workflowFilter === null ? "btn-primary" : "btn-ghost text-base-content/60",
          )}
        >
          all <span className="text-2xs opacity-60 ml-0.5">{total}</span>
        </button>
        {availableWorkflows.map((name) => (
          <button
            key={name}
            onClick={() => setWorkflowFilter(name)}
            className={clsx(
              "btn btn-xs h-7 min-h-0 font-medium shrink-0 font-mono",
              workflowFilter === name ? "btn-primary" : "btn-ghost text-base-content/60",
            )}
          >
            <span className="text-2xs">{name}</span>
          </button>
        ))}
      </div>

      <div className="flex flex-1 overflow-hidden">
        {/* List panel */}
        <aside className="w-80 shrink-0 border-r border-base-300 bg-base-200/40 overflow-y-auto flex flex-col">
          {error && (
            <div className="px-3 py-2 text-2xs text-error border-b border-base-300">{error}</div>
          )}
          <ul className="flex-1">
            {visibleRuns.map((run) => {
              const active = run.id === selectedId;
              const canCancel = run.status === "running" || run.status === "paused";
              const canRetry = run.status === "failed";
              const hasApprovals = approvals.some((a) => a.workflowRunId === run.id);
              return (
                <li key={run.id} className="border-b border-base-300/40">
                  {/* Row uses role="button" instead of <button> so the
                      embedded "cancel" action can be a real <button> without
                      tripping React's no-nested-button DOM warning. */}
                  <div
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedId(run.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        setSelectedId(run.id);
                      }
                    }}
                    className={clsx(
                      "w-full flex flex-col items-start gap-0.5 py-2 px-3 text-left transition-colors cursor-pointer",
                      active
                        ? "bg-primary/15 border-l-2 border-l-primary -ml-px pl-[10px]"
                        : "hover:bg-base-300/40 border-l-2 border-l-transparent -ml-px pl-[10px]",
                    )}
                  >
                    <div className="flex items-center gap-2 w-full text-2xs">
                      <StatusBadge status={run.status} />
                      {hasApprovals && (
                        <span className="badge badge-warning badge-xs">approval</span>
                      )}
                      <span className="ml-auto text-base-content/40 font-mono">
                        {timeAgo(run.startedAt)} ago
                      </span>
                    </div>
                    <div className="text-sm truncate w-full text-base-content/90">
                      {run.workflowName}
                    </div>
                    <div className="flex gap-2 text-2xs text-base-content/40 w-full font-mono">
                      {run.repo &&
                        (() => {
                          const href = repoUrl(runRepoPath(run));
                          return href ? (
                            <GhLink href={href} className="truncate" title={`Open ${run.repo} on GitHub`}>
                              {run.repo}
                            </GhLink>
                          ) : (
                            <span className="truncate">{run.repo}</span>
                          );
                        })()}
                      {run.issueNumber &&
                        (() => {
                          const href = issueUrl(runRepoPath(run), run.issueNumber, run.workflowName);
                          return href ? (
                            <GhLink href={href} title={`Open #${run.issueNumber} on GitHub`}>
                              #{run.issueNumber}
                            </GhLink>
                          ) : (
                            <span>#{run.issueNumber}</span>
                          );
                        })()}
                      <span className="ml-auto">{run.currentPhase}</span>
                    </div>
                    {canCancel && (
                      <button
                        className="btn btn-2xs btn-error btn-outline mt-1 h-5 min-h-0 text-2xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleCancel(run.id);
                        }}
                      >
                        cancel
                      </button>
                    )}
                    {canRetry && (
                      <button
                        className="btn btn-2xs btn-warning btn-outline mt-1 h-5 min-h-0 text-2xs"
                        onClick={(e) => {
                          e.stopPropagation();
                          handleRetry(run.id);
                        }}
                        title="Re-run from the phase that failed, keeping the same context"
                      >
                        retry
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
            {visibleRuns.length === 0 && !error && (
              <li className="p-6 text-center text-base-content/40 text-xs">no workflow runs</li>
            )}
          </ul>
          <div className="sticky bottom-0 border-t border-base-300 bg-base-200 p-2 flex items-center justify-between text-2xs">
            <span className="text-base-content/50 font-mono">
              {visibleRuns.length} / {total}
            </span>
            <button
              className="btn btn-xs btn-ghost h-6 min-h-0"
              onClick={() => setLimit((l) => l + WORKFLOW_PAGE_SIZE)}
              disabled={!hasMore}
            >
              load more
            </button>
          </div>
        </aside>

        {/* Detail panel */}
        {selectedRun ? (
          <DetailPanel
            run={selectedRun}
            approvals={approvals}
            onCancel={handleCancel}
            onRetry={handleRetry}
            onApprovalResponded={load}
            onOpenDefinition={onOpenDefinition}
          />
        ) : (
          <div className="flex-1 flex items-center justify-center text-base-content/30 text-sm">
            select a workflow run
          </div>
        )}
      </div>
    </div>
  );
}

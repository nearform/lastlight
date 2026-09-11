import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { CircleCheck, CircleHelp, CircleMinus, CirclePause, CircleX, Clock, FileSearch, RefreshCw } from "lucide-react";
import clsx from "clsx";
import {
  api,
  type WorkflowRun,
  type WorkflowApproval,
  type WorkflowDefinition,
  type WorkflowRunExecution,
  type TriggeredByUser,
  type FeedbackSignal,
} from "../api";
import { ActorChip } from "./ActorChip";
import { WorkflowPipeline } from "./WorkflowPipeline";
import { ApprovalBanner } from "./ApprovalBanner";
import { PhaseDetailPanel } from "./PhaseDetailPanel";
import { PrStatePanel, hasPrState } from "./PrStatePanel";
import { Split, SplitPane, SplitHandle } from "./Split";
import { Tabs, TabButton } from "./Tabs";
import { useIsNarrow } from "../hooks/useIsNarrow";
import { RunActivityStrip } from "./ActivityPage";
import { MessageFeed, type MessageOrder } from "./MessageFeed";
import {
  useUrlState,
  nullableStringParser,
  nullableStringSerializer,
} from "../hooks/useUrlState";
import { useVisibleRepos, repoScopeParam } from "../hooks/useVisibleRepos";
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

/** Status → solid icon + colour. Used both in the dense list rows and the
 *  detail-panel header (the text chip was too heavy). Title carries the word. */
type StatusIconMeta = { Icon: typeof CircleCheck; cls: string };
const STATUS_ICON: Record<WorkflowRun["status"], StatusIconMeta> = {
  queued: { Icon: Clock, cls: "text-muted" },
  running: { Icon: RefreshCw, cls: "text-info animate-spin" },
  paused: { Icon: CirclePause, cls: "text-warning" },
  succeeded: { Icon: CircleCheck, cls: "text-success" },
  failed: { Icon: CircleX, cls: "text-error" },
  cancelled: { Icon: CircleMinus, cls: "text-faint" },
};
// Neutral fallback so an unrecognised runtime status (e.g. a new server-side
// status shipped before the dashboard) degrades gracefully instead of crashing
// the list with a destructure-of-undefined TypeError.
const STATUS_ICON_FALLBACK: StatusIconMeta = { Icon: CircleHelp, cls: "text-faint" };

function StatusIcon({ status, className }: { status: WorkflowRun["status"]; className?: string }) {
  const { Icon, cls } = STATUS_ICON[status] ?? STATUS_ICON_FALLBACK;
  // Wrapped rather than passing `title` to the icon: lucide's props don't
  // include it, and the status is rendered icon-only here — so losing the
  // tooltip would leave no way to read the state at all.
  return (
    <span title={status} aria-label={status} className="inline-flex shrink-0">
      <Icon className={clsx("shrink-0", cls, className ?? "w-4 h-4")} />
    </span>
  );
}

/** The emoji a canonical reaction name renders as (issue #255). */
const FEEDBACK_GLYPH: Record<string, string> = {
  "+1": "👍",
  "-1": "👎",
  laugh: "😄",
  hooray: "🎉",
  rocket: "🚀",
  heart: "❤️",
  confused: "😕",
  eyes: "👀",
  smile: "😄",
  smiley: "😄",
  grinning: "😀",
  heart_eyes: "😍",
  disappointed: "😞",
  cry: "😢",
  sob: "😭",
};

/**
 * What people said about this run, as a compact chip: the reactions themselves
 * plus the mean of the SCORED ones. 👀 shows in the glyphs but is left out of
 * the average — it is the bot's own ack idiom, so counting it as an opinion
 * would drag every score toward zero.
 */
function FeedbackBadge({ signals }: { signals: FeedbackSignal[] }) {
  if (signals.length === 0) return null;
  const scored = signals.filter((s) => s.score !== 0);
  const average = scored.length
    ? scored.reduce((n, s) => n + s.score, 0) / scored.length
    : null;
  const tone =
    average === null ? "text-muted" : average > 0 ? "text-success" : average < 0 ? "text-error" : "text-muted";
  const glyphs = signals.map((s) => FEEDBACK_GLYPH[s.emoji] ?? `:${s.emoji}:`).join("");
  return (
    <span
      className={clsx("badge badge-xs badge-ghost gap-1", tone)}
      title={`${signals.length} feedback signal${signals.length === 1 ? "" : "s"}`}
    >
      <span>{glyphs}</span>
      {average !== null && (
        <span className="font-mono">
          {average > 0 ? "+" : ""}
          {average.toFixed(1)}
        </span>
      )}
    </span>
  );
}

/**
 * The panes of the run view, in tab order.
 *
 * Wide, the first two are columns — the run list and the pipeline — and only
 * the rest are tabs. Narrow, all five are tabs in one strip. One vocabulary
 * either way, so there is no second notion of "which pane" to keep in step.
 */
export const RUN_PANES = ["runs", "workflow", "transcript", "phase", "prstate"] as const;
export type RunPane = (typeof RUN_PANES)[number];
const PANE_LABEL: Record<RunPane, string> = {
  runs: "Runs",
  workflow: "Workflow",
  transcript: "Transcript",
  phase: "Phase",
  prstate: "PR State",
};
/** The tabs the detail panel itself owns — the two column panes are not tabs there. */
const DETAIL_PANES: RunPane[] = ["transcript", "phase", "prstate"];

interface DetailPanelProps {
  run: WorkflowRun;
  /** Resolved `users`-table identity for the run's actor (avatar/name), issue #205. */
  triggeredByUser?: TriggeredByUser | null;
  approvals: WorkflowApproval[];
  onCancel: (id: string) => void;
  onRetry: (id: string) => void;
  onApprovalResponded: () => void;
  onOpenDefinition?: (name: string) => void;
  /** Below the three-column threshold — render one pane, not a split. */
  narrow: boolean;
  /** The pane being shown, owned by the parent (it renders the narrow strip). */
  pane: RunPane;
  onPaneChange: (pane: RunPane) => void;
  /** Which panes exist for this run — PR State is absent on a non-PR run. */
  panes: readonly RunPane[];
}

// ── Pipeline + the tabbed side panel ────────────────────────────────────

interface RunBodyProps {
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
  narrow: boolean;
  pane: RunPane;
  onPaneChange: (pane: RunPane) => void;
  panes: readonly RunPane[];
}

/**
 * The pipeline and everything you can read beside it.
 *
 * The pipeline runs top-to-bottom in a column of its own, which is what frees
 * the whole right-hand side for the transcript, the phase detail and the PR
 * state snapshot as tabs. Both boundaries are draggable and both sizes are
 * remembered (see `Split`).
 */
function RunBody({
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
  narrow,
  pane,
  onPaneChange,
  panes,
}: RunBodyProps) {
  // The harness records a terminal failure as a string on the run context.
  // Shown only for a terminal run: a `running` run can carry a stale `error`
  // from an earlier phase that was since retried, and banner-ing that would
  // report a live run as broken.
  const contextError = run.context?.error;
  const runFailureReason =
    (run.status === "failed" || run.status === "cancelled") && typeof contextError === "string"
      ? contextError
      : null;

  const pipeline = (
    <div className="flex flex-col h-full min-h-0 min-w-0">
      {/* Why the run failed.
       *
       * Not every failure has a phase node to hang off. A handler phase that
       * throws before it writes an `executions` row leaves NOTHING in the
       * pipeline — `post-review` rejecting a review is the case that prompted
       * this: the graph showed every phase green, the run said `failed`, and
       * the reason ("GitHub rejected the review … Can not request changes on
       * your own pull request") existed only on `context.error`, reachable
       * from the API and nowhere in the UI. A run that fails invisibly reads
       * as a bug in the dashboard rather than an answer about the run. */}
      {runFailureReason && (
        <div className="shrink-0 mb-3 rounded border border-error/40 bg-error/5 px-3 py-2">
          <div className="text-2xs font-semibold uppercase tracking-wider text-error/80">
            {run.status === "cancelled" ? "Cancelled" : "Failed"}
            {run.currentPhase ? ` · ${run.currentPhase}` : ""}
          </div>
          <div className="mt-1 text-xs text-strong break-words whitespace-pre-wrap font-mono">
            {runFailureReason}
          </div>
        </div>
      )}
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
          selectedPhase={selectedPhase}
          onPhaseClick={(phaseName) => {
            onPhaseClick(phaseName);
            // On a phone the pipeline is covering the transcript, and asking
            // about a phase means asking what it did.
            if (narrow) onPaneChange("transcript");
          }}
        />
      )}
    </div>
  );

  const transcript = selectedExecution?.sessionId ? (
    <MessageFeed
      key={selectedExecution.sessionId}
      sessionId={selectedExecution.sessionId}
      order={feedOrder}
      onOrderChange={onFeedOrderChange}
      searchQuery=""
    />
  ) : (
    <div className="flex-1 flex items-center justify-center text-faint text-sm p-6 text-center">
      {selectedPhase?.startsWith("approval:")
        ? "Approval gate — no agent session. See the gate details on the Phase tab."
        : selectedExecution
          ? "Session not captured for this run."
          : "No execution recorded for this phase yet."}
    </div>
  );

  const sidePanel = (current: RunPane) => {
    if (!selectedPhase && current !== "prstate") {
      return (
        <div className="flex-1 flex items-center justify-center text-faint text-xs p-6 text-center">
          click a phase to inspect it
        </div>
      );
    }
    if (current === "prstate") {
      return (
        <div className="flex-1 overflow-y-auto">
          <PrStatePanel run={run} defaultOpen />
        </div>
      );
    }
    if (current === "phase") {
      return (
        <div className="flex-1 overflow-y-auto">
          <PhaseDetailPanel
            phaseName={selectedPhase!}
            run={run}
            definition={definition}
            execution={selectedExecution}
            totalExecutions={selectedExecutions.length}
            approvals={approvals}
          />
        </div>
      );
    }
    return transcript;
  };

  if (narrow) {
    return (
      <div className="flex-1 min-h-0 flex flex-col">
        {pane === "workflow" ? pipeline : sidePanel(pane)}
      </div>
    );
  }

  const sideTabs = panes.filter((p) => DETAIL_PANES.includes(p));
  const side = sideTabs.includes(pane) ? pane : "transcript";

  return (
    // The wrapper, not the Split, is what `flex-1` sizes: the group sets its
    // own `height: 100%`, which only means anything against a parent whose
    // height is already resolved.
    <div className="flex-1 min-h-0">
      <Split id="ll-run-detail" panelIds={["pipeline", "side"]}>
      <SplitPane id="pipeline" defaultSize="38%" minSize="15%">
        {pipeline}
      </SplitPane>
      <SplitHandle />
      <SplitPane id="side" minSize="20%">
        <div className="flex flex-col h-full min-h-0 border border-hairline rounded bg-base-100 overflow-hidden">
          <Tabs className="px-2">
            {sideTabs.map((p) => (
              <TabButton key={p} active={side === p} onClick={() => onPaneChange(p)}>
                {PANE_LABEL[p]}
              </TabButton>
            ))}
          </Tabs>
          {sidePanel(side)}
        </div>
      </SplitPane>
      </Split>
    </div>
  );
}

// ── Detail panel ────────────────────────────────────────────────────────

function DetailPanel({
  run,
  triggeredByUser,
  approvals,
  onCancel,
  onRetry,
  onApprovalResponded,
  onOpenDefinition,
  narrow,
  pane,
  onPaneChange,
  panes,
}: DetailPanelProps) {
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

  // Feedback signals on this run (issue #255). Fetched once, not polled: a
  // reaction can arrive at any time, but nobody is watching a run detail panel
  // waiting for one, and the Feedback tab is where you go to look.
  const [feedback, setFeedback] = useState<FeedbackSignal[]>([]);
  useEffect(() => {
    let cancelled = false;
    api
      .workflowRunFeedback(run.id)
      .then((res) => {
        if (!cancelled) setFeedback(res.signals);
      })
      .catch(() => {
        /* a run with no feedback and a failed fetch look the same: no badge */
      });
    return () => {
      cancelled = true;
    };
  }, [run.id]);

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
    <div className="h-full overflow-hidden flex flex-col p-4 gap-4 min-h-0 min-w-0">
      <div className="flex items-center gap-3 flex-wrap shrink-0 min-w-0">
        <span className="font-semibold text-base-content">{run.workflowName}</span>
        {onOpenDefinition && (
          <button
            className="btn btn-xs btn-ghost btn-square"
            title="View workflow definition"
            onClick={() => onOpenDefinition(run.workflowName)}
          >
            <FileSearch className="w-4 h-4" />
          </button>
        )}
        <StatusIcon status={run.status} className="w-5 h-5" />
        <FeedbackBadge signals={feedback} />
        {run.repo &&
          (() => {
            const href = repoUrl(runRepoPath(run));
            const cls = "text-xs text-muted font-mono";
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
            const cls = "text-xs text-muted font-mono";
            return href ? (
              <GhLink href={href} className={cls} title={`Open #${run.issueNumber} on GitHub`}>
                #{run.issueNumber}
              </GhLink>
            ) : (
              <span className={cls}>#{run.issueNumber}</span>
            );
          })()}
        {run.triggeredBy && (
          <span className="inline-flex items-center gap-1.5 text-xs text-muted">
            <span className="opacity-70">by</span>
            <ActorChip
              login={run.triggeredBy}
              actorType={run.triggerActorType}
              user={triggeredByUser}
              size="md"
            />
          </span>
        )}
        <span className="text-2xs text-faint font-mono flex gap-3 items-center">
          <span>started {timeAgo(run.startedAt)} ago</span>
          <span>elapsed {elapsed(run)}</span>
          {run.finishedAt && <span>finished {timeAgo(run.finishedAt)} ago</span>}
        </span>
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

      <ApprovalBanner approvals={pendingApprovals} onResponded={handleApprovalResponded} />

      {/* Who acted on this run, and what came of it (issue #206). Self-hiding
          on a run nobody has touched. The PR-state snapshot that used to sit
          here is now a tab beside the transcript — it is a wide block of facts,
          and above the pipeline it pushed the run itself off the screen. */}
      <RunActivityStrip runId={run.id} />

      <RunBody
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
        narrow={narrow}
        pane={pane}
        onPaneChange={onPaneChange}
        panes={panes}
      />
    </div>
  );
}

const WORKFLOW_PAGE_SIZE = 20;

interface RunListPaneProps {
  runs: WorkflowRun[];
  approvals: WorkflowApproval[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  error: string | null;
  queuedTotal: number;
  showQueued: boolean;
  onToggleQueued: () => void;
  total: number;
  hasMore: boolean;
  onLoadMore: () => void;
}

/**
 * The run list. Its own component because it is a PANE when there is room for
 * three columns and a TAB when there is not, and those two parents are in
 * different places in the tree.
 */
function RunListPane({
  runs: visibleRuns,
  approvals,
  selectedId,
  onSelect: setSelectedId,
  error,
  queuedTotal,
  showQueued,
  onToggleQueued,
  total,
  hasMore,
  onLoadMore,
}: RunListPaneProps) {
  return (
    <div className="h-full bg-base-200/40 overflow-y-auto flex flex-col">
        {error && (
          <div className="px-3 py-2 text-2xs text-error border-b border-hairline">{error}</div>
        )}
        {queuedTotal > 0 && (
          <button
            type="button"
            onClick={onToggleQueued}
            title={showQueued ? "Hide queued workflow runs" : "Show queued workflow runs"}
            className={clsx(
              "flex items-center justify-between gap-2 px-3 py-1.5 text-2xs border-b border-hairline transition-colors",
              showQueued
                ? "bg-primary/10 text-primary"
                : "text-muted hover:bg-base-300/40",
            )}
          >
            <span className="font-mono">
              {queuedTotal} queued workflow{queuedTotal === 1 ? "" : "s"}
            </span>
            <span className="badge badge-ghost badge-xs">{showQueued ? "hide" : "show"}</span>
          </button>
        )}
        <ul className="flex-1">
          {visibleRuns.map((run) => {
            const active = run.id === selectedId;
            const hasApprovals = approvals.some((a) => a.workflowRunId === run.id);
            return (
              <li key={run.id} className="border-b border-hairline">
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
                    "w-full flex flex-col items-start gap-0.5 py-1.5 px-3 text-left transition-colors cursor-pointer border-l-2 -ml-px pl-[10px]",
                    active
                      ? "bg-primary/15 border-l-primary"
                      : clsx("border-l-transparent", {
                          // Faint red tint on unselected FAILED rows so they
                          // stand out at a glance; everything else is neutral.
                          "bg-error/10 hover:bg-error/20": run.status === "failed",
                          "hover:bg-base-300/40": run.status !== "failed",
                        }),
                  )}
                >
                  <div className="flex items-center gap-2 w-full text-2xs">
                    <span className="text-xs font-medium truncate text-strong min-w-0">
                      {run.workflowName}
                    </span>
                    {run.status === "running" && run.currentPhase && (
                      <span className="text-2xs italic text-muted shrink-0">
                        {run.currentPhase}
                      </span>
                    )}
                    {hasApprovals && (
                      <span className="ll-status badge text-warning badge-xs shrink-0">approval</span>
                    )}
                    <span className="ml-auto text-faint font-mono shrink-0">
                      {timeAgo(run.startedAt)} ago
                    </span>
                    <StatusIcon status={run.status} />
                  </div>
                  <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-2xs text-faint w-full font-mono">
                    {run.repo &&
                      (() => {
                        const href = repoUrl(runRepoPath(run));
                        return href ? (
                          <GhLink href={href} className="truncate shrink-0" title={`Open ${run.repo} on GitHub`}>
                            {run.repo}
                          </GhLink>
                        ) : (
                          <span className="truncate shrink-0">{run.repo}</span>
                        );
                      })()}
                    {run.issueNumber &&
                      (() => {
                        const href = issueUrl(runRepoPath(run), run.issueNumber, run.workflowName);
                        return href ? (
                          <GhLink href={href} className="shrink-0" title={`Open #${run.issueNumber} on GitHub`}>
                            #{run.issueNumber}
                          </GhLink>
                        ) : (
                          <span className="shrink-0">#{run.issueNumber}</span>
                        );
                      })()}
                    {run.triggeredBy && (
                      <ActorChip
                        login={run.triggeredBy}
                        actorType={run.triggerActorType}
                        className="min-w-0"
                      />
                    )}
                  </div>
                </div>
              </li>
            );
          })}
          {visibleRuns.length === 0 && !error && (
            <li className="p-6 text-center text-faint text-xs">no workflow runs</li>
          )}
        </ul>
        <div className="sticky bottom-0 border-t border-hairline bg-base-200 p-2 flex items-center justify-between text-2xs">
          <span className="text-muted font-mono">
            {visibleRuns.length} / {total}
          </span>
          <button
            className="btn btn-xs btn-ghost ll-control-sm"
            onClick={onLoadMore}
            disabled={!hasMore}
          >
            load more
          </button>
        </div>
    </div>
  );
}



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
  // Queued runs (parked by the concurrency cap) are hidden by default — they're
  // pending, not activity. The count drives the show/hide toggle above the list.
  const [showQueued, setShowQueued] = useState(false);
  const [queuedTotal, setQueuedTotal] = useState(0);
  const [workflowFilter, setWorkflowFilter] = useUrlState<string | null>(
    "workflow",
    null,
    nullableStringParser,
    nullableStringSerializer,
  );
  const [availableWorkflows, setAvailableWorkflows] = useState<string[]>([]);
  const narrow = useIsNarrow();
  const { allowed: allowedRepos } = useVisibleRepos();
  // Per-repo visibility (issue #169) is applied SERVER-side, via the `repos`
  // query param, so paging and the `total` count stay honest — filtering after
  // the fact would return short pages and a total that counts rows the user
  // can't see. Skipped when the Repos tab has already pinned a single repo
  // (`repo` is the narrower ask), and absent whenever the scope is the
  // fail-open sentinel. Memoized: a fresh array identity per render would
  // refetch on every render.
  const scopedRepos = useMemo(
    () => (repo ? undefined : repoScopeParam(allowedRepos)),
    [repo, allowedRepos],
  );

  // Reset pagination whenever a filter changes — otherwise an inflated `limit`
  // from a previous, larger result set would silently keep showing too many
  // rows after the user narrows.
  useEffect(() => {
    setLimit(WORKFLOW_PAGE_SIZE);
  }, [timeRange, workflowFilter, repo, scopedRepos]);

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
      const [runsData, approvalsData, queuedData] = await Promise.all([
        api.workflowRuns({
          limit,
          since,
          status,
          workflow: workflowFilter ?? undefined,
          repo,
          repos: scopedRepos,
        }),
        api.approvals().catch(() => ({ approvals: [] as WorkflowApproval[] })),
        // Queued-run count, scoped to the same date/workflow/repo filters, for
        // the show/hide toggle. Cheap (limit 1 — we only read `total`).
        api
          .workflowRuns({
            status: "queued",
            limit: 1,
            since,
            workflow: workflowFilter ?? undefined,
            repo,
            repos: scopedRepos,
          })
          .catch(() => ({ total: 0, workflowRuns: [] as WorkflowRun[] })),
      ]);
      setRuns(runsData.workflowRuns);
      setTotal(runsData.total);
      setApprovals(approvalsData.approvals);
      setQueuedTotal(queuedData.total);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, [limit, timeRange, workflowFilter, repo, scopedRepos]);

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
    // Queued runs are hidden unless the toggle is on — they're pending work,
    // not activity, and flood the list when a cron fans out a big batch.
    let list = showQueued ? runs : runs.filter((r) => r.status !== "queued");
    if (query) {
      const q = query.toLowerCase();
      list = list.filter((r) => {
        return (
          r.workflowName.toLowerCase().includes(q) ||
          (r.repo ?? "").toLowerCase().includes(q) ||
          String(r.issueNumber ?? "").includes(q) ||
          r.triggerId.toLowerCase().includes(q)
        );
      });
    }
    return list;
  }, [runs, query, showQueued]);

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
  // The run actor's `users`-table identity (avatar + real name), issue #205.
  // Comes only from the detail fetch (the list payload has just the login).
  const [triggeredByUser, setTriggeredByUser] = useState<TriggeredByUser | null>(null);
  useEffect(() => {
    if (!selectedId) {
      setDetailRun(null);
      setTriggeredByUser(null);
      return;
    }
    let cancelled = false;
    api
      .workflowRun(selectedId)
      .then((res) => {
        if (!cancelled) {
          setDetailRun(res.workflowRun);
          setTriggeredByUser(res.triggeredByUser);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setDetailRun(null);
          setTriggeredByUser(null);
        }
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
  // Prefer the live-updating list row, but splice in `context` + `scratch`
  // (both absent from the list payload — it omits the heavy JSON blobs) from
  // the detail fetch. `PrStatePanel` reads the snapshot from one and the fix
  // harvest from the other, so they must arrive together. Fall back to the full
  // detail when the run isn't in the list at all (deep-linked / paginated out).
  const selectedRun: WorkflowRun | null = listRow
    ? {
        ...listRow,
        context: listRow.context ?? detailForSelected?.context,
        scratch: listRow.scratch ?? detailForSelected?.scratch,
      }
    : detailForSelected;
  const hasMore = runs.length < total;

  // Which pane the user is looking at. Lives here rather than in `DetailPanel`
  // because on a narrow screen the run list and the pipeline are two more tabs
  // in the same strip, and those are not the detail panel's to render.
  const [pane, setPane] = useState<RunPane>("transcript");
  const showPrState = !!selectedRun && hasPrState(selectedRun);
  const visiblePanes = useMemo(
    () => RUN_PANES.filter((p) => p !== "prstate" || showPrState),
    [showPrState],
  );
  // A pane can stop existing under the user — the PR State tab on switching to
  // a non-PR run — so fall back rather than render nothing.
  const activePane = visiblePanes.includes(pane) ? pane : "transcript";

  const listPane = (
    <RunListPane
      runs={visibleRuns}
      approvals={approvals}
      selectedId={selectedId}
      onSelect={(id) => {
        setSelectedId(id);
        // Picking a run on a phone means "show me that run", and the list is
        // covering it.
        if (narrow) setPane("workflow");
      }}
      error={error}
      queuedTotal={queuedTotal}
      showQueued={showQueued}
      onToggleQueued={() => setShowQueued((v) => !v)}
      total={total}
      hasMore={hasMore}
      onLoadMore={() => setLimit((l) => l + WORKFLOW_PAGE_SIZE)}
    />
  );

  const detailPanel = selectedRun ? (
    <DetailPanel
      run={selectedRun}
      triggeredByUser={detailForSelected ? triggeredByUser : null}
      approvals={approvals}
      onCancel={handleCancel}
      onRetry={handleRetry}
      onApprovalResponded={load}
      onOpenDefinition={onOpenDefinition}
      narrow={narrow}
      pane={activePane}
      onPaneChange={setPane}
      panes={visiblePanes}
    />
  ) : null;

  return (
    <div className="flex flex-col flex-1 overflow-hidden">
      {/* Filter row — workflow type chips, mirrors the session-type strip on
          the sessions tab. */}
      <div className="flex items-center gap-1 px-4 py-2 border-b border-hairline bg-base-200/40 shrink-0 overflow-x-auto flex-nowrap">
        <button
          onClick={() => setWorkflowFilter(null)}
          className={clsx(
            "btn btn-xs ll-control font-medium shrink-0",
            workflowFilter === null ? "btn-primary" : "btn-ghost text-muted",
          )}
        >
          all <span className="text-2xs opacity-60 ml-0.5">{total}</span>
        </button>
        {availableWorkflows.map((name) => (
          <button
            key={name}
            onClick={() => setWorkflowFilter(name)}
            className={clsx(
              "btn btn-xs ll-control font-medium shrink-0 font-mono",
              workflowFilter === name ? "btn-primary" : "btn-ghost text-muted",
            )}
          >
            <span className="text-2xs">{name}</span>
          </button>
        ))}
      </div>

      {narrow ? (
        // One column, one pane at a time. The list and the pipeline — panes
        // when there is room for three columns — become the first two tabs, so
        // everything on this page is reachable without a horizontal scrollbar.
        <div className="flex flex-col flex-1 min-h-0">
          <Tabs className="px-2 bg-base-200/40">
            {visiblePanes.map((pane) => (
              <TabButton key={pane} active={activePane === pane} onClick={() => setPane(pane)}>
                {PANE_LABEL[pane]}
              </TabButton>
            ))}
          </Tabs>
          {activePane === "runs" ? (
            <div className="flex-1 min-h-0">{listPane}</div>
          ) : selectedRun ? (
            detailPanel
          ) : (
            <div className="flex-1 flex items-center justify-center text-faint text-sm">
              select a workflow run
            </div>
          )}
        </div>
      ) : (
        <div className="flex-1 min-h-0">
        <Split id="ll-runs" panelIds={["runs", "detail"]}>
          <SplitPane
            id="runs"
            defaultSize="22%"
            minSize="12%"
            className="border-r border-hairline"
          >
            {listPane}
          </SplitPane>
          <SplitHandle />
          <SplitPane id="detail" minSize="30%">
            {selectedRun ? (
              detailPanel
            ) : (
              <div className="h-full flex items-center justify-center text-faint text-sm">
                select a workflow run
              </div>
            )}
          </SplitPane>
        </Split>
        </div>
      )}
    </div>
  );
}

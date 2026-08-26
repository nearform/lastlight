import { useEffect, useMemo, useState } from "react";

import { isToolPair } from "../timeline";
import type { TimelineItem as TimelineItemT } from "../timeline";
import type { PhaseMetric, TrialSession } from "../types";
import { TimelineItem } from "./timeline/TimelineItem";
import { useSessionLog, usePhaseLogs, branchVocabulary } from "../lib/session";
import type { SessionLane } from "../lib/session";
import { buildPhaseRows } from "../lib/phaseTree";
import { PhaseSidebar, LiveSessionList } from "./PhaseSidebar";
import type { PhasePick, SidebarPhase } from "./PhaseSidebar";

/** Right-align user turns, matching the Last Light session viewer. */
function isUserMessage(item: TimelineItemT): boolean {
  return !isToolPair(item) && item.message.type === "user";
}

/** Ledger duration for a phase row. Prefers `agentMs` (agent + gate time) over
 * the wider `durationMs` window, because that is the number a reader compares
 * across phases. Only a fallback: once the transcript loads, the measured span of
 * its real sessions is authoritative — which is also what keeps the panel honest
 * while the `survey_branch_*` ledger rows carry no metrics at all. */
function ledgerMs(rows: PhaseMetric[]): number | undefined {
  let total: number | undefined;
  for (const m of rows) {
    const ms = m.agentMs ?? m.durationMs;
    if (ms === undefined) continue;
    total = (total ?? 0) + ms;
  }
  return total;
}

function ledgerCost(rows: PhaseMetric[]): number | undefined {
  let total: number | undefined;
  for (const m of rows) {
    if (m.costUsd === undefined) continue;
    total = (total ?? 0) + m.costUsd;
  }
  return total;
}

/** What the modal is showing: a single live (still-writing) transcript to follow,
 * or a finished case's per-trial / per-phase logs to browse. */
export type SessionSource =
  // No `metrics` here on purpose: a running case is a `PendingCase`, which
  // carries no phases — the scorecard gains `phases[]` only when the case
  // finishes. Lanes in a live log are named from their own opening prompt
  // instead, which is why that path does not depend on the vocabulary.
  | { kind: "live"; title: string; url: string }
  | {
      kind: "trials";
      title: string;
      sessions: TrialSession[];
      baseUrl: string;
      /** Per-phase metrics from the scorecard, keyed by phase name — so a tab can
       * show what the phase cost before you open it. Absent for older runs. */
      metrics?: PhaseMetric[];
    }
  | {
      kind: "execution";
      title: string;
      /** Run-relative-resolved URL of the captured test output, if any. */
      logUrl?: string;
      failToPass?: { id: string; pass: boolean }[];
      passToPass?: { id: string; pass: boolean }[];
    };

/** The held-out test view: per-test FAIL_TO_PASS / PASS_TO_PASS verdicts on top
 * (so you see WHICH tests failed) and the raw captured test output below. Shown
 * for resolved and unresolved code-fix cases alike. */
function ExecutionView({
  logUrl,
  failToPass = [],
  passToPass = [],
}: {
  logUrl?: string;
  failToPass?: { id: string; pass: boolean }[];
  passToPass?: { id: string; pass: boolean }[];
}) {
  const [text, setText] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    if (!logUrl) {
      setText("");
      return;
    }
    let cancelled = false;
    fetch(logUrl)
      .then((r) => (r.ok ? r.text() : Promise.reject(new Error(`HTTP ${r.status}`))))
      .then((t) => !cancelled && setText(t))
      .catch((e) => !cancelled && setErr(e instanceof Error ? e.message : String(e)));
    return () => {
      cancelled = true;
    };
  }, [logUrl]);

  const tests = [
    ...failToPass.map((t) => ({ ...t, kind: "FAIL_TO_PASS" })),
    ...passToPass.map((t) => ({ ...t, kind: "PASS_TO_PASS" })),
  ];
  return (
    <div className="flex-1 overflow-y-auto bg-base-100">
      {tests.length > 0 && (
        <div className="space-y-1 border-b border-base-300 px-4 py-3">
          <div className="mb-1.5 font-mono text-2xs uppercase tracking-wide text-base-content/40">
            held-out tests ({tests.filter((t) => t.pass).length}/{tests.length} passed)
          </div>
          {tests.map((t, i) => (
            <div key={i} className="flex items-start gap-2 font-mono text-xs leading-5">
              <span className={t.pass ? "text-success" : "text-error"}>{t.pass ? "✓" : "✗"}</span>
              <span className="shrink-0 text-base-content/40">{t.kind}</span>
              <span className="break-all text-base-content/80">{t.id}</span>
            </div>
          ))}
        </div>
      )}
      {err && <div className="px-4 py-3 font-mono text-xs text-error">Couldn't load test output: {err}</div>}
      {text === null && !err && (
        <div className="py-16 text-center font-mono text-sm text-base-content/40">loading test output…</div>
      )}
      {text !== null && (
        <pre className="whitespace-pre-wrap px-4 py-3 font-mono text-2xs leading-5 text-base-content/80">
          {text || "(no test output captured)"}
        </pre>
      )}
    </div>
  );
}

/** Scrolling timeline over an already-loaded set of items. Pure — the fetching
 * moved up to the modal, which loads every phase at once so the panel can show
 * what is inside each one without the reader opening it. */
function Timeline({
  items,
  live,
  loading,
  error,
}: {
  items: TimelineItemT[];
  live?: boolean;
  loading?: boolean;
  error?: unknown;
}) {
  // When following live, show newest-first so fresh turns land at the top.
  const ordered = live ? [...items].reverse() : items;
  return (
    <div className="min-w-0 flex-1 space-y-2 overflow-y-auto bg-base-100 px-4 py-3">
      {error ? (
        <div className="rounded-lg border border-error/40 bg-error/10 px-4 py-3 font-mono text-xs text-error">
          Couldn't load the session log: {(error as Error).message}
        </div>
      ) : loading && ordered.length === 0 ? (
        <div className="py-16 text-center font-mono text-sm text-base-content/40">loading session…</div>
      ) : ordered.length === 0 ? (
        <div className="py-16 text-center font-mono text-sm text-base-content/40">
          {live ? "waiting for the agent to start…" : "no messages recorded"}
        </div>
      ) : null}
      {ordered.map((item) =>
        isUserMessage(item) ? (
          <div key={item.id} className="flex justify-end">
            <div className="w-fit min-w-0 max-w-[85%]">
              <TimelineItem item={item} />
            </div>
          </div>
        ) : (
          <TimelineItem key={item.id} item={item} />
        ),
      )}
    </div>
  );
}

/** Tab pill (workflow phase / trial / full), with an optional pass/fail dot. */
function Tab({
  active,
  onClick,
  label,
  ok,
  hint,
}: {
  active: boolean;
  onClick: () => void;
  label: string;
  ok?: boolean;
  /** Muted suffix — the phase's wall clock + cost, so the expensive phases are
   * visible without opening each one. */
  hint?: string;
}) {
  return (
    <button
      onClick={onClick}
      className={
        "flex items-center gap-1.5 whitespace-nowrap rounded-md border px-2.5 py-1 font-mono text-2xs " +
        (active
          ? "border-info bg-info/15 text-info"
          : "border-base-300 bg-base-200 text-base-content/60 hover:border-info hover:text-base-content")
      }
    >
      {ok !== undefined && (
        <span className={"h-1.5 w-1.5 shrink-0 rounded-full " + (ok ? "bg-success" : "bg-error")} />
      )}
      {label}
      {hint && <span className="opacity-50">{hint}</span>}
    </button>
  );
}

/** Full-screen overlay rendering an agent session. For a finished case it shows
 * trial tabs (when `--runs N>1`) and one tab per workflow phase (plus a `full`
 * consolidated transcript); for a running case it follows the live transcript.
 * Closes on backdrop click or Esc. */
export function SessionModal({ source, onClose }: { source: SessionSource; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const [trialIdx, setTrialIdx] = useState(0);
  // `undefined` = nothing chosen yet for this trial, resolved to the first
  // openable phase below. `null` = the consolidated `full` transcript.
  const [pick, setPick] = useState<PhasePick | null | undefined>(undefined);

  const metrics = source.kind === "trials" ? (source.metrics ?? []) : [];
  // The fan-out branch names the harness recorded for THIS case — what CONFIRMS
  // a lane's mined family name (see `deriveLaneLabel`).
  const vocab = useMemo(() => branchVocabulary(metrics), [metrics]);

  const trials = source.kind === "trials" ? source.sessions : [];
  const trial = trials[Math.min(trialIdx, Math.max(0, trials.length - 1))];
  const resolve = (rel: string) =>
    source.kind === "trials" ? source.baseUrl.replace(/scorecard\.json$/, rel) : rel;

  // The ledger joined to the archive: workflow order, with a transcript attached
  // wherever one was written. See `buildPhaseRows` for why the two disagree.
  const rows = useMemo(() => buildPhaseRows(metrics, trial?.phases ?? []), [metrics, trial]);

  // Every phase's transcript, in parallel. Progressive: the panel renders from
  // the ledger immediately and fills in each phase's sessions as they land.
  const logs = usePhaseLogs(
    rows.map((r) => (r.log ? resolve(r.log) : undefined)),
    vocab,
  );

  // A running case has no archived phases at all — the splits are written when
  // the trial finishes — so it follows the one consolidated stream and shows its
  // sessions flat. That is the honest shape: nothing in a live log ties a
  // session to a phase.
  const liveLog = useSessionLog(source.kind === "live" ? source.url : undefined, true, vocab);
  const fullUrl = trial?.full ? resolve(trial.full) : undefined;
  const fullLog = useSessionLog(pick === null ? fullUrl : undefined, false, vocab);

  const live = source.kind === "live";
  const firstOpenable = rows.findIndex((r) => r.state === "log");
  const active: PhasePick | null =
    pick === undefined ? (firstOpenable >= 0 ? { phase: rows[firstOpenable].phase } : null) : pick;

  const phases: SidebarPhase[] = rows.map((r, i) => ({
    phase: r.phase,
    state: r.state,
    success: r.success,
    costUsd: ledgerCost(r.branches.length ? r.branches : r.metric ? [r.metric] : []),
    metricMs: ledgerMs(r.branches.length ? r.branches : r.metric ? [r.metric] : []),
    lanes: logs[i]?.data?.lanes ?? [],
    loading: !!logs[i]?.isLoading,
  }));

  // What the pane renders.
  let items: TimelineItemT[] = [];
  let loading = false;
  let error: unknown;
  let rawUrl: string | undefined;
  if (live) {
    const lanes: SessionLane[] = liveLog.data?.lanes ?? [];
    const laneId = pick?.lane;
    items = laneId ? (lanes.find((l) => l.sessionId === laneId)?.items ?? []) : (liveLog.data?.items ?? []);
    loading = liveLog.isLoading;
    error = liveLog.error;
    rawUrl = source.kind === "live" ? source.url : undefined;
  } else if (active === null) {
    items = fullLog.data?.items ?? [];
    loading = fullLog.isLoading;
    error = fullLog.error;
    rawUrl = fullUrl;
  } else {
    const idx = rows.findIndex((r) => r.phase === active.phase);
    const q = logs[idx];
    const lanes: SessionLane[] = q?.data?.lanes ?? [];
    items = active.lane
      ? (lanes.find((l) => l.sessionId === active.lane)?.items ?? [])
      : (q?.data?.items ?? []);
    loading = !!q?.isLoading;
    error = q?.error;
    rawUrl = rows[idx]?.log ? resolve(rows[idx].log as string) : undefined;
  }

  return (
    <div className="fixed inset-0 z-50 flex bg-black/60" onClick={onClose}>
      <div
        className="m-4 flex h-[calc(100vh-2rem)] w-full max-w-none flex-col overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-base-300 bg-base-200/80 px-4 py-2.5">
          {live && <span className="ll-pulse shrink-0 text-2xs font-semibold text-accent">● live</span>}
          <span className="truncate font-mono text-xs text-base-content/70">{source.title}</span>
          {live && (
            <span className="shrink-0 whitespace-nowrap rounded border border-base-300 bg-base-200 px-1.5 py-0.5 font-mono text-2xs text-base-content/60">
              ↓ newest first
            </span>
          )}
          {(() => {
            const href = source.kind === "execution" ? source.logUrl : rawUrl;
            if (!href) return null;
            return (
              <a
                href={href}
                target="_blank"
                rel="noreferrer"
                className="ml-auto whitespace-nowrap font-mono text-2xs text-info hover:underline"
              >
                {source.kind === "execution" ? "raw log" : "raw jsonl"}
              </a>
            );
          })()}
          <button onClick={onClose} className="btn btn-ghost btn-xs h-6 min-h-0" aria-label="Close">
            ✕
          </button>
        </div>

        {source.kind === "trials" && trials.length > 1 && (
          <div className="flex flex-wrap items-center gap-1.5 border-b border-base-300 bg-base-200/40 px-4 py-2">
            <span className="mr-1 font-mono text-2xs uppercase tracking-wide text-base-content/40">trial</span>
            {trials.map((t, i) => (
              <Tab
                key={t.trial}
                active={i === trialIdx}
                onClick={() => {
                  setTrialIdx(i);
                  setPick(undefined);
                }}
                label={`#${t.trial}`}
              />
            ))}
          </div>
        )}

        {source.kind === "execution" ? (
          <ExecutionView logUrl={source.logUrl} failToPass={source.failToPass} passToPass={source.passToPass} />
        ) : (
          <div className="flex min-h-0 flex-1">
            {live ? (
              <LiveSessionList
                lanes={liveLog.data?.lanes ?? []}
                active={pick ?? null}
                onPick={setPick}
              />
            ) : (
              <PhaseSidebar
                phases={phases}
                active={active}
                onPick={setPick}
                hasFull={!!fullUrl}
              />
            )}
            <Timeline
              key={`${active?.phase ?? "full"}:${active?.lane ?? ""}`}
              items={items}
              live={live}
              loading={loading}
              error={error}
            />
          </div>
        )}
      </div>
    </div>
  );
}

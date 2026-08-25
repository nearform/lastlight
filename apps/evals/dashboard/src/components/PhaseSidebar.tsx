import { useEffect, useState } from "react";

import type { SessionLane } from "../lib/session";
import { fmtDuration } from "../lib/format";

/** Ticks once a second while `on`, so a running session's duration counts up
 * instead of freezing at whatever the last poll happened to fetch. Parked
 * entirely when `on` is false, so a finished log costs no timer at all. */
function useNow(on: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!on) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [on]);
  return now;
}

/** Enough of a session id to tell two of them apart.
 *
 * NOT `slice(0, 8)`. Session ids are UUIDv7, whose leading bytes are a
 * millisecond timestamp — so six branches a fan-out launched together share a
 * byte-identical prefix. On the measured run all six surveys rendered as
 * `01a029ea`, which is worse than showing nothing: it reads as though the lanes
 * are the same session. The second group is where they first diverge. */
function shortId(id: string): string {
  return id.slice(0, 13);
}

/** A lane is still running when the log is live and nothing has been appended to
 * it recently. The shim flushes in blocks, so "recently" has to be generous —
 * 20s of silence from an agent mid-tool-call is ordinary, and calling it finished
 * would stop its clock early and understate it. */
const IDLE_MS = 20_000;

function laneClock(lane: SessionLane, now: number, live: boolean): { ms?: number; running: boolean } {
  if (lane.firstMs === undefined) return { ms: undefined, running: false };
  const last = lane.lastMs ?? lane.firstMs;
  const running = live && now - last < IDLE_MS;
  return { ms: (running ? now : last) - lane.firstMs, running };
}

/** A phase's wall clock, as the SPAN of its lanes — max end minus min start.
 *
 * The span, never the sum. A fan-out's six branches overlap, so summing them
 * reports 608s for a phase that took 242s. The span is the number that answers
 * "how long did this phase hold the pipeline up", which is the question the
 * panel exists to answer. */
function phaseClock(
  lanes: SessionLane[],
  now: number,
  live: boolean,
): { ms?: number; running: boolean; turns: number } {
  let first: number | undefined;
  let last: number | undefined;
  let turns = 0;
  let running = false;
  for (const lane of lanes) {
    turns += lane.turns;
    if (lane.firstMs === undefined) continue;
    const end = lane.lastMs ?? lane.firstMs;
    if (first === undefined || lane.firstMs < first) first = lane.firstMs;
    if (last === undefined || end > last) last = end;
    if (live && now - end < IDLE_MS) running = true;
  }
  if (first === undefined) return { ms: undefined, running, turns };
  return { ms: (running ? now : (last as number)) - first, running, turns };
}

/** One session row. Shared by the phase tree and the flat live list, so a lane
 * reads identically whether or not its phase is known yet. */
function LaneRow({
  lane,
  on,
  now,
  live,
  onPick,
  indent,
}: {
  lane: SessionLane;
  on: boolean;
  now: number;
  live: boolean;
  onPick: () => void;
  indent: boolean;
}) {
  const clock = laneClock(lane, now, live);
  return (
    <button
      onClick={onPick}
      className={
        "flex w-full flex-col gap-0.5 border-l-2 py-1.5 pr-3 text-left " +
        (indent ? "pl-7 " : "pl-3 ") +
        (on ? "border-info bg-info/10" : "border-transparent hover:bg-base-300/40")
      }
    >
      <div className="flex items-center gap-1.5">
        {clock.running && <span className="ll-pulse shrink-0 text-2xs text-accent">●</span>}
        <span
          className={
            "truncate font-mono text-xs " +
            (on ? "text-info" : "text-base-content/70") +
            // A positional label is guessing; mute it so a reader can tell a
            // real branch name from a placeholder.
            (lane.named ? "" : " italic opacity-60") +
            (lane.kind === "command" ? " opacity-70" : "")
          }
          title={[lane.full, lane.command, lane.sessionId || "harness output"].filter(Boolean).join(" · ")}
        >
          {lane.kind === "command" ? "$ " : ""}
          {lane.label}
        </span>
      </div>
      <div className="flex items-center gap-2 font-mono text-2xs text-base-content/35">
        <span>{clock.ms === undefined ? "—" : fmtDuration(clock.ms)}</span>
        <span>·</span>
        <span>{lane.turns}t</span>
        <span className="truncate opacity-60">{lane.sessionId ? shortId(lane.sessionId) : "harness"}</span>
      </div>
    </button>
  );
}

/** The live variant: a flat session list, no phase tree.
 *
 * A running case has NO phase structure available — the per-phase splits are
 * written when the trial finishes, and nothing in the consolidated stream ties a
 * session to a phase. Showing sessions flat is the honest rendering of what is
 * actually known mid-run; inventing a grouping would be a guess presented as
 * fact, during exactly the window when someone is watching to find out what is
 * happening. */
export function LiveSessionList({
  lanes,
  active,
  onPick,
}: {
  lanes: SessionLane[];
  active: PhasePick | null;
  onPick: (pick: PhasePick | null) => void;
}) {
  const now = useNow(true);
  return (
    <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-base-300 bg-base-200/40">
      <div className="sticky top-0 z-10 bg-base-200/95 px-3 py-2 font-mono text-2xs uppercase tracking-wide text-base-content/40">
        {lanes.length} sessions
      </div>
      <button
        onClick={() => onPick(null)}
        className={
          "border-l-2 px-3 py-1.5 text-left font-mono text-2xs " +
          (active === null || active?.lane === undefined
            ? "border-info bg-info/10 text-info"
            : "border-transparent text-base-content/50 hover:bg-base-300/40 hover:text-base-content")
        }
      >
        interleaved
      </button>
      {lanes.map((lane, i) => (
        <LaneRow
          key={lane.sessionId || `live-lane-${i}`}
          lane={lane}
          on={active?.lane === lane.sessionId}
          now={now}
          live
          indent={false}
          onPick={() => onPick({ phase: "live", lane: lane.sessionId })}
        />
      ))}
      <div className="px-3 py-2 font-mono text-2xs leading-4 text-base-content/30">
        phases appear when the case finishes
      </div>
    </div>
  );
}

export interface SidebarPhase {
  phase: string;
  state: "log" | "skipped" | "no-transcript";
  success?: boolean;
  /** Ledger cost for the phase (summed over a fan-out's branches). */
  costUsd?: number;
  /** Ledger duration, used only until the transcript lands — the measured span
   * of the real sessions is better, and is the only source that works while the
   * `survey_branch_*` ledger rows are still being fixed harness-side. */
  metricMs?: number;
  lanes: SessionLane[];
  loading: boolean;
}

export interface PhasePick {
  phase: string;
  /** Absent = the phase's whole transcript; set = one session within it. */
  lane?: string;
}

/**
 * The phase panel, down the left of the log pane. Every phase in the case, in
 * workflow order, with its sessions nested underneath when it ran more than one.
 *
 * One list rather than a tab strip plus a sidebar, because a `pr-review` case is
 * fifteen phases and six of them now run concurrently inside one window — the
 * two axes are really one tree, and splitting them across two controls is what
 * made the log unfollowable.
 */
export function PhaseSidebar({
  phases,
  active,
  onPick,
  live = false,
  hasFull,
}: {
  phases: SidebarPhase[];
  active: PhasePick | null;
  onPick: (pick: PhasePick | null) => void;
  live?: boolean;
  hasFull?: boolean;
}) {
  const now = useNow(live);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());

  const toggle = (phase: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(phase)) next.delete(phase);
      else next.add(phase);
      return next;
    });

  return (
    <div className="flex w-64 shrink-0 flex-col overflow-y-auto border-r border-base-300 bg-base-200/40">
      <div className="sticky top-0 z-10 bg-base-200/95 px-3 py-2 font-mono text-2xs uppercase tracking-wide text-base-content/40">
        {phases.length} phases
      </div>

      {phases.map((p) => {
        const measured = phaseClock(p.lanes, now, live);
        const ms = measured.ms ?? p.metricMs;
        const on = active?.phase === p.phase && active.lane === undefined;
        const openable = p.state === "log";
        const multi = p.lanes.length > 1;
        const open = multi && !collapsed.has(p.phase);

        return (
          <div key={p.phase}>
            <button
              onClick={() => (openable ? onPick({ phase: p.phase }) : undefined)}
              disabled={!openable}
              className={
                "flex w-full flex-col gap-0.5 border-l-2 px-3 py-1.5 text-left " +
                (on
                  ? "border-info bg-info/10"
                  : openable
                    ? "border-transparent hover:bg-base-300/40"
                    : "border-transparent cursor-default")
              }
            >
              <div className="flex items-center gap-1.5">
                {multi ? (
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      toggle(p.phase);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.stopPropagation();
                        toggle(p.phase);
                      }
                    }}
                    className="shrink-0 cursor-pointer font-mono text-2xs text-base-content/40 hover:text-base-content"
                  >
                    {open ? "▾" : "▸"}
                  </span>
                ) : (
                  <span className="w-2 shrink-0" />
                )}
                {measured.running && <span className="ll-pulse shrink-0 text-2xs text-accent">●</span>}
                {p.success === false && <span className="shrink-0 text-2xs text-error">✗</span>}
                <span
                  className={
                    "truncate font-mono text-xs " +
                    (on ? "text-info" : openable ? "text-base-content/80" : "text-base-content/35")
                  }
                  title={p.phase}
                >
                  {p.phase}
                </span>
              </div>
              <div className="flex items-center gap-2 pl-3.5 font-mono text-2xs text-base-content/40">
                {/* A skip is a correct outcome, not a failure and not a zero —
                    `prepare` and `falsify` skip on every probes-off run. */}
                {p.state === "skipped" ? (
                  <span className="italic opacity-70">skipped</span>
                ) : (
                  <>
                    <span>{ms === undefined ? (p.loading ? "…" : "—") : fmtDuration(ms)}</span>
                    {measured.turns > 0 && (
                      <>
                        <span>·</span>
                        <span>{measured.turns}t</span>
                      </>
                    )}
                    {p.costUsd ? (
                      <>
                        <span>·</span>
                        <span>${p.costUsd.toFixed(2)}</span>
                      </>
                    ) : null}
                  </>
                )}
              </div>
            </button>

            {open &&
              p.lanes.map((lane, i) => (
                <LaneRow
                  key={lane.sessionId || `${p.phase}-lane-${i}`}
                  lane={lane}
                  on={active?.phase === p.phase && active.lane === lane.sessionId}
                  now={now}
                  live={live}
                  indent
                  onPick={() => onPick({ phase: p.phase, lane: lane.sessionId })}
                />
              ))}
          </div>
        );
      })}

      {hasFull && (
        <button
          onClick={() => onPick(null)}
          className={
            "mt-1 border-l-2 border-t border-t-base-300 px-3 py-2 text-left font-mono text-2xs " +
            (active === null
              ? "border-l-info bg-info/10 text-info"
              : "border-l-transparent text-base-content/50 hover:bg-base-300/40 hover:text-base-content")
          }
        >
          full transcript
        </button>
      )}
    </div>
  );
}

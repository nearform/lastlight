import clsx from "clsx";

import {
  MICRO_LATENCY_CAVEAT,
  MICRO_RANKABLE_REPEATS,
  microRange,
  microRankable,
  microSeries,
  microStatus,
  type MicroSeries,
  type MicroStatus,
} from "../../../src/micro-survey.js";
import type { MicroSurveyEntry, MicroSurveyReport } from "../types";
import { useMicroReport } from "../lib/api";
import { fmtDate, fmtPct, fmtProbePct, fmtSecs, modelDisplay } from "../lib/format";
import { MICRO_TIER_KEY, useNavigate } from "../lib/router";

/**
 * The micro-survey views — the fast feedback loop for a prompt or skill edit,
 * rendered.
 *
 * A micro-survey replays ONE survey branch of the pr-review pipeline against a
 * preserved workspace (~2 minutes, ~$0.25) instead of paying for a 30-47 minute
 * full case. It is not a run: no tier, no scorecard, no graded cases. So it gets
 * its own list + detail rather than a row in the runs table, and it is read on
 * one number.
 *
 * Two rules the markup here exists to enforce:
 *
 *  1. **`needsProbePct` never appears without its baseline.** The baseline is
 *     what the preserved arm itself wrote for that family; a replay percentage
 *     on its own says nothing about whether the edit moved anything. They are
 *     rendered adjacent, always, including in the list.
 *  2. **A band of repeats is a RANGE, never a mean.** The survey runs at
 *     temperature 1 and its run-to-run variance is the dominant effect — one
 *     repeat is an observation, not a result. Every aggregate here is min-max
 *     and says so; there is deliberately no mean and no standard deviation to
 *     be found, because two or three points do not support one.
 *  3. **The fire rate is the headline, the percentages are the evidence.**
 *     `needsProbePct` is bimodal on the `enforcement` family — a repeat marks
 *     ~5 rows or none — so each repeat is really a coin flip and the quantity
 *     that varies is how often it comes up heads. It is rendered as
 *     `fired/done` beside the percentage so the denominator can never be lost,
 *     and below {@link MICRO_RANKABLE_REPEATS} completed repeats it is labelled
 *     unrankable rather than hidden.
 *
 *  4. **Latency is a first-class number, and a contaminated one.** A full
 *     pr-review case is 23-47 minutes, so a model is being judged on speed as
 *     well as behaviour and the wall clock belongs beside the cost, per repeat
 *     and per arm. But micro-surveys run in-process and are routinely launched
 *     several at a time on one host, and NOTHING in the report says whether
 *     that happened — so every arm-level latency aggregate carries
 *     {@link MICRO_LATENCY_CAVEAT} permanently, and no concurrency is invented
 *     or inferred. Absent timings stay absent: a repeat written before the
 *     script measured latency renders as an em dash, never as `0s`.
 *
 * And one thing the markup exists to *prevent*: a dead run reading as a live
 * one. A report is rewritten after every repeat and its `live` flag is stuck
 * true if the script is killed, so {@link microStatus} — shared with the index —
 * decides between running, interrupted and complete, and an interrupted run is
 * rendered as its own state rather than as a slow one.
 */

/** The disclaimer that must ride with `reassuranceShaped` wherever it appears —
 * a regex over claim text, not a judge, and read as ground truth it would be
 * wrong. */
const REASSURANCE_HINT =
  "A LEXICAL heuristic, not a judge: a regex over the claim text counting claims that assert the code is fine and ask for no probe. Read it as a tripwire for a shift in shape, never as ground truth.";

/** `16.7% / 0.0% / 41.7%` — every repeat, in order, spelled out. The list of
 * points IS the result; the range below it is the only summary offered. */
function repeatsList(values: number[]): string {
  return values.length ? values.map((v) => fmtProbePct(v)).join(" / ") : "—";
}

function rangeText(values: number[]): string {
  const r = microRange(values);
  if (!r) return "—";
  return r.min === r.max ? fmtProbePct(r.min) : `${fmtProbePct(r.min)}–${fmtProbePct(r.max)}`;
}

// ── latency ─────────────────────────────────────────────────────────────────

/** `2m 5s / 3m 1s / —` — every repeat in order, an untimed one as a dash. The
 * points are the result here exactly as they are for needsProbe%. */
function seriesList(values: (number | null)[], fmt: (x: number | null) => string): string {
  return values.length ? values.map((v) => fmt(v)).join(" / ") : "—";
}

/** The min–max spread of a partly-measured series, in that series' own units.
 * One point prints as itself — an observation, not a range. */
function seriesRangeText(s: MicroSeries, fmt: (x: number | null) => string): string {
  if (!s.range) return "—";
  return s.range.min === s.range.max
    ? fmt(s.range.min)
    : `${fmt(s.range.min)}–${fmt(s.range.max)}`;
}

/** A plain count (turns, tool calls), or an em dash when it was never read. */
const fmtCount = (x: number | null): string => (x === null || !Number.isFinite(x) ? "—" : String(x));

/** "2 of 3 repeats timed" — said out loud whenever a total or a range is
 * computed over only part of the band, so a partial total is never mistaken for
 * the run's wall clock. */
function partialNote(s: MicroSeries): string {
  return s.missing > 0 ? ` · ${s.measured.length} of ${s.measured.length + s.missing} repeats timed` : "";
}

/** The permanent latency caveat, rendered wherever an arm-level aggregate is.
 * Not a tooltip: the contamination is invisible in the data, so the warning
 * cannot be something a reader has to go looking for. */
function LatencyCaveat({ className = "" }: { className?: string }) {
  return (
    <p className={clsx("max-w-3xl font-mono text-2xs leading-5 text-warning/80", className)}>
      <b className="font-semibold">wall clock is contaminated by concurrency.</b> {MICRO_LATENCY_CAVEAT}
    </p>
  );
}

// ── live / interrupted / complete ───────────────────────────────────────────

/**
 * The progress chip: `3/10` with the run's state.
 *
 * `interrupted` is deliberately as loud as an error and worded as one. The
 * script rewrites its report after every repeat and never clears `live` when it
 * is killed, so a stale heartbeat is the ONLY evidence that nothing is coming —
 * and the failure this guards against is reading that silence as a run still
 * grinding away. {@link microStatus} makes the call, shared with the index.
 */
function ProgressChip({ entry, size = "sm" }: { entry: MicroSurveyEntry; size?: "sm" | "md" }) {
  const status = microStatus(entry, Date.now());
  const counts = `${entry.repeatsDone}/${entry.repeats}`;
  const style =
    status === "running"
      ? "bg-success/15 text-success"
      : status === "interrupted"
        ? "bg-error/15 text-error"
        : entry.repeatsDone < entry.repeats
          ? "bg-warning/15 text-warning"
          : "bg-base-300 text-base-content/60";
  const label =
    status === "running"
      ? `running · ${counts}`
      : status === "interrupted"
        ? `interrupted · ${counts}`
        : `${counts} repeats`;
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full font-semibold",
        size === "md" ? "px-2.5 py-1 text-xs" : "px-2 py-0.5 text-2xs",
        style,
      )}
      title={STATUS_HINT[status](entry)}
    >
      {status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />}
      {status === "interrupted" && <span className="h-1.5 w-1.5 rounded-full bg-error" />}
      {label}
    </span>
  );
}

const STATUS_HINT: Record<MicroStatus, (e: MicroSurveyEntry) => string> = {
  running: (e) =>
    `Still running: ${e.repeatsDone} of ${e.repeats} repeats done, last written ${fmtDate(e.heartbeat ?? "")}. The numbers below will move.`,
  interrupted: (e) =>
    `INTERRUPTED. The report still says it is live but nothing has been written since ${
      e.heartbeat ? fmtDate(e.heartbeat) : "— (no heartbeat recorded)"
    }, so the script was killed. ${e.repeatsDone} of ${e.repeats} repeats completed; the rest never will.`,
  complete: (e) =>
    e.repeatsDone < e.repeats
      ? `Finished short: launched with ${e.repeats} repeats, ${e.repeatsDone} recorded.`
      : `Complete: all ${e.repeats} repeats recorded.`,
};

// ── the headline: fire rate ─────────────────────────────────────────────────

/**
 * `1/3 repeats fired · 33%`.
 *
 * The count leads and the percentage follows, because the percentage alone
 * hides the denominator — and at these band lengths the denominator IS the
 * caveat. `null` (nothing completed yet) prints as an em dash, never as 0%.
 */
function fireRateText(entry: { firedRepeats: number; repeatsDone: number; fireRate: number | null }): string {
  if (entry.fireRate === null) return "—";
  return `${entry.firedRepeats}/${entry.repeatsDone} · ${fmtPct(entry.fireRate)}`;
}

const BASELINE_HINT =
  "What the preserved arm itself wrote for this family — the comparator. It is a single observation, so it fired or it did not; it has no fire rate of its own.";

const FIRE_RATE_HINT =
  "Fraction of completed repeats that asked for at least one probe. THE headline: needsProbe% is bimodal (a repeat marks ~5 rows or none), so a mean over it describes no run that ever happened, while this is exactly what varies between arms.";

/** The unrankable warning. Shown whenever fewer than {@link MICRO_RANKABLE_REPEATS}
 * repeats are done — the number stays on screen, it just stops being a ranking. */
function RankabilityNote({ repeatsDone }: { repeatsDone: number }) {
  if (microRankable(repeatsDone)) return null;
  return (
    <span className="text-warning">
      {repeatsDone === 0
        ? `no repeats yet — nothing to rank; ${MICRO_RANKABLE_REPEATS}+ before ranking`
        : `${repeatsDone} repeat${repeatsDone === 1 ? "" : "s"} — treat as ${repeatsDone} coin flip${
            repeatsDone === 1 ? "" : "s"
          }; ${MICRO_RANKABLE_REPEATS}+ before ranking`}
    </span>
  );
}

// ── provenance ──────────────────────────────────────────────────────────────

/**
 * `ambient-skills` / `AGENTS.md` — the two switches that make two runs
 * incomparable, so they ride beside the numbers rather than in a settings panel.
 * A report that recorded neither shows nothing: absent means "not recorded",
 * never "off".
 */
function ProvenanceChips({ entry }: { entry: MicroSurveyEntry }) {
  const chips: { label: string; on: boolean; title: string }[] = [];
  if (entry.ambientSkills !== null) {
    chips.push({
      label: `ambient-skills ${entry.ambientSkills ? "on" : "off"}`,
      on: entry.ambientSkills,
      title: entry.ambientSkills
        ? "Pi's ambient skill discovery was ON — what the preserved arm itself did."
        : "Pi's ambient skill discovery was OFF — the ablation. Not comparable with an ambient-on run.",
    });
  }
  if (entry.agentsMd !== null) {
    chips.push({
      label: `AGENTS.md ${entry.agentsMd ? "present" : "absent"}`,
      on: entry.agentsMd,
      title: entry.agentsMd
        ? "The composed AGENTS.md was in place, as it is in a real run."
        : "No AGENTS.md — the operational rules the arm ran under were absent. Not comparable with a run that had one.",
    });
  }
  if (!chips.length) return null;
  return (
    <>
      {chips.map((c) => (
        <span
          key={c.label}
          title={c.title}
          className={clsx(
            "whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-2xs",
            c.on ? "bg-base-300 text-base-content/70" : "bg-warning/15 text-warning",
          )}
        >
          {c.label}
        </span>
      ))}
    </>
  );
}

/**
 * The arm-level latency line: total wall clock for the run, then the min–max
 * spread of its repeats, then the turn/tool-call shape when the report recorded
 * it — a model burning many turns per repeat is the usual reason it is slow.
 *
 * Total leads because that is what the operator actually waits for. Absent
 * everywhere (an older report) it says so in words rather than printing zeros,
 * and a band only partly timed says how much of it was.
 */
function LatencySummary({ entry, align = "left" }: { entry: MicroSurveyEntry; align?: "left" | "right" }) {
  const dur = microSeries(entry.durationSec);
  const turns = microSeries(entry.turns);
  const tools = microSeries(entry.toolCalls);
  if (!dur.any) {
    return (
      <div
        className={clsx("text-2xs text-base-content/30", align === "right" && "text-right")}
        title="This report was written before the micro-survey recorded latency. Not zero — unmeasured."
      >
        no wall clock recorded
      </div>
    );
  }
  const shape = [
    turns.any ? `${turns.total} turns` : null,
    tools.any ? `${tools.total} tools` : null,
  ].filter(Boolean);
  return (
    <div className={clsx("text-2xs text-base-content/50", align === "right" && "text-right")} title={MICRO_LATENCY_CAVEAT}>
      <div>
        {fmtSecs(dur.total)} total
        {dur.measured.length > 1 && (
          <span className="text-base-content/40"> · {seriesRangeText(dur, fmtSecs)} per repeat</span>
        )}
        <span className="text-base-content/30">{partialNote(dur)}</span>
      </div>
      {shape.length > 0 && <div className="text-base-content/35">{shape.join(" · ")}</div>}
    </div>
  );
}

/**
 * The detail view's latency panel — the same shape as every other number on
 * this page: the per-repeat points first, the aggregate underneath, and the
 * aggregate is a TOTAL plus a min–max range. Never a mean.
 *
 * `turns` / `toolCalls` sit beside it because they are the mechanism behind the
 * number: a repeat that is slow because it took 60 turns is a different finding
 * from one that is slow because the host was busy. They are omitted entirely
 * when the report recorded none.
 */
function LatencyBlock({ entry }: { entry: MicroSurveyEntry }) {
  const dur = microSeries(entry.durationSec);
  const turns = microSeries(entry.turns);
  const tools = microSeries(entry.toolCalls);
  if (!dur.any && !turns.any && !tools.any) {
    return (
      <div>
        <div className="font-mono text-2xs uppercase tracking-wide text-base-content/40">wall clock</div>
        <div
          className="font-mono text-sm text-base-content/30"
          title="This report predates the latency measurement. Unmeasured — not instant."
        >
          not recorded
        </div>
      </div>
    );
  }
  return (
    <>
      <div>
        <div
          className="font-mono text-2xs uppercase tracking-wide text-base-content/40"
          title={MICRO_LATENCY_CAVEAT}
        >
          wall clock per repeat
        </div>
        <div className="font-mono text-sm tabular-nums text-base-content">
          {seriesList(entry.durationSec, fmtSecs)}
        </div>
        <div className="font-mono text-2xs text-base-content/40" title={MICRO_LATENCY_CAVEAT}>
          total <span className="text-base-content/60">{fmtSecs(dur.total)}</span>
          {dur.measured.length > 1 && (
            <>
              {" "}
              · range (min–max) <span className="text-base-content/60">{seriesRangeText(dur, fmtSecs)}</span> — not a
              mean
            </>
          )}
          {partialNote(dur)}
        </div>
      </div>

      {(turns.any || tools.any) && (
        <div>
          <div
            className="font-mono text-2xs uppercase tracking-wide text-base-content/40"
            title="Assistant turns and tool calls per repeat — the usual explanation for a slow repeat. Absent on a report that did not record them."
          >
            per repeat: turns · tool calls
          </div>
          {/* One labelled line each: both series use `/` between repeats, so
              running them together on one line makes the boundary guesswork. */}
          <div className="font-mono text-sm tabular-nums text-base-content/70">
            {turns.any && (
              <div>
                <span className="text-base-content/40">turns </span>
                {seriesList(entry.turns, fmtCount)}
              </div>
            )}
            {tools.any && (
              <div>
                <span className="text-base-content/40">tools </span>
                {seriesList(entry.toolCalls, fmtCount)}
              </div>
            )}
          </div>
          <div className="font-mono text-2xs text-base-content/40">
            {turns.any && <>{turns.total} turns total</>}
            {turns.any && tools.any && " · "}
            {tools.any && <>{tools.total} tool calls total</>}
          </div>
        </div>
      )}
    </>
  );
}

// ── list ────────────────────────────────────────────────────────────────────

/** Every micro-survey report on disk, newest first. */
export function MicroSurveyList({ reports }: { reports: MicroSurveyEntry[] }) {
  const navigate = useNavigate();

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold text-base-content">micro-survey</h1>
      <p className="mb-4 max-w-3xl font-mono text-xs text-base-content/50">
        {reports.length} report{reports.length === 1 ? "" : "s"} · one survey branch replayed against a preserved
        workspace · click a report for its claims
      </p>
      <p className="mb-6 max-w-3xl text-2xs leading-5 text-base-content/50">
        <b className="font-semibold text-base-content/70">fire rate</b> — how many repeats asked for at least one
        probe — is the headline. Per repeat, <b className="font-semibold text-base-content/70">needsProbe%</b> is
        bimodal: a repeat marks about five rows or it marks none, so it is a coin flip in continuous clothing and
        averaging it describes no run that ever happened. The per-repeat values stay listed because the spread is
        the evidence, and the range under them is a{" "}
        <b className="font-semibold text-base-content/70">min–max spread, not a mean</b>. Every replay number is
        read against the <b className="font-semibold text-base-content/70">baseline</b> beside it — what the
        preserved arm itself wrote for that family. Below {MICRO_RANKABLE_REPEATS} completed repeats a fire rate is
        shown but is <b className="font-semibold text-warning">not rankable</b>. Cost and{" "}
        <b className="font-semibold text-base-content/70">wall clock</b> ride together in the last column, so a
        model that is cheap but slow is visible beside its fire rate.
      </p>
      <LatencyCaveat className="mb-6" />

      {/* The table can still exceed a narrow window. `overflow-x-auto` makes it
          scrollable; macOS hides the scrollbar until it moves, so SAY so — a
          clipped cost column that looks like the end of the table is exactly
          the failure this whole layout pass was about. */}
      {reports.length > 0 && (
        <p className="mb-2 font-mono text-2xs text-base-content/40 xl:hidden">
          narrow window — the table scrolls sideways; cost and wall clock are its last column.
        </p>
      )}

      {!reports.length ? (
        <MicroSurveyEmpty />
      ) : (
        /* `overflow-x-auto`, never `overflow-hidden`: at a narrow viewport the
           right-hand columns (cost, wall clock) were CLIPPED AWAY with no
           indication they existed. Scrolling is a visible failure; clipping is a
           silent one. Nine columns became five so the default width fits. */
        <div className="overflow-x-auto rounded-xl border border-base-300 bg-base-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-neutral text-2xs uppercase tracking-wide text-neutral-content/70">
                <th className="px-3 py-3 text-left font-semibold">run</th>
                <th className="px-3 py-3 text-left font-semibold">progress</th>
                <th className="px-3 py-3 text-left font-semibold" title={FIRE_RATE_HINT}>
                  fire rate
                </th>
                <th className="px-3 py-3 text-left font-semibold">
                  needsProbe% — baseline · per repeat
                </th>
                <th className="px-3 py-3 text-right font-semibold" title={MICRO_LATENCY_CAVEAT}>
                  cost · wall clock
                </th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => {
                const model = modelDisplay({}, r.model);
                return (
                  <tr
                    key={r.id}
                    onClick={() => navigate(MICRO_TIER_KEY, r.id)}
                    className="cursor-pointer border-t border-base-300 align-top hover:bg-base-300/40"
                  >
                    {/* when + label + family + model, stacked. Rows are taller
                        and that is the trade: an identifier broken across three
                        lines (`glm-` / `5p3-` / `flash`) cannot be compared at a
                        glance with its neighbour, which is the whole job of this
                        column — so every identifier is `whitespace-nowrap`. */}
                    <td className="px-3 py-2.5">
                      <div className="whitespace-nowrap font-mono text-xs text-info hover:underline">
                        {fmtDate(r.generatedAt)}
                      </div>
                      <div className="whitespace-nowrap font-mono text-sm text-base-content">{r.label}</div>
                      <div
                        className="whitespace-nowrap font-mono text-2xs text-base-content/50"
                        title={model.title}
                      >
                        {r.family} · {model.label}
                        {r.thinking && <span className="text-base-content/40"> · thinking {r.thinking}</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2.5">
                      <ProgressChip entry={r} />
                      <div className="mt-1 flex flex-wrap gap-1">
                        <ProvenanceChips entry={r} />
                      </div>
                    </td>
                    {/* The value never wraps; the rankability note is allowed to,
                        so this column can give width back at a narrow viewport
                        instead of pushing cost off the screen. */}
                    <td className="px-3 py-2.5 font-mono tabular-nums" title={FIRE_RATE_HINT}>
                      <span
                        className={clsx(
                          "whitespace-nowrap text-sm font-semibold",
                          r.fireRate === null ? "text-base-content/40" : "text-base-content",
                        )}
                      >
                        {fireRateText(r)}
                      </span>
                      {/* A floor on the width: allowed to wrap, but not down to
                          one word per line. */}
                      <div className="min-w-44 text-2xs font-normal leading-4">
                        <RankabilityNote repeatsDone={r.repeatsDone} />
                      </div>
                    </td>
                    {/* Baseline and replay share ONE cell now — adjacency was
                        previously a column order, which a reflow could break;
                        here they cannot be separated at all. */}
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono tabular-nums">
                      <div
                        className="text-2xs text-base-content/60"
                        title="What the preserved arm itself wrote for this family — the comparator."
                      >
                        baseline{" "}
                        <span className="text-base-content/80">{fmtProbePct(r.baselineNeedsProbePct)}</span>
                      </div>
                      <div className="text-base-content">{repeatsList(r.needsProbePct)}</div>
                      {r.needsProbePct.length > 1 && (
                        <div className="text-2xs text-base-content/40">
                          range (min–max) {rangeText(r.needsProbePct)}
                        </div>
                      )}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono tabular-nums">
                      <div className="text-base-content">${r.costUsd.toFixed(3)}</div>
                      <LatencySummary entry={r} align="right" />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/** No `eval-results/micro-survey/` yet (or nothing in it). A distinct, calm
 * state — not an error, and not confusable with a stopped server. */
function MicroSurveyEmpty() {
  return (
    <div className="rounded-xl border border-base-300 bg-base-200 px-5 py-10 text-center">
      <p className="font-mono text-sm text-base-content/60">No micro-survey reports yet.</p>
      <p className="mt-2 font-mono text-xs text-base-content/40">
        Record one with <span className="text-accent">npx tsx scripts/micro-survey.ts --fixture &lt;dir&gt; --family
        &lt;family&gt;</span>
      </p>
    </div>
  );
}

// ── detail ──────────────────────────────────────────────────────────────────

/** One report: what was replayed, the headline beside its comparator, and the
 * claim lines each repeat produced. */
export function MicroSurveyDetail({ entry }: { entry: MicroSurveyEntry }) {
  const status = microStatus(entry, Date.now());
  // A live report is rewritten after every repeat, so the detail view follows it
  // at the live cadence; a settled one is still cached forever.
  const { data, isLoading, error } = useMicroReport(entry.report, status === "running");

  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-2xl font-semibold text-base-content">{entry.label}</h1>
        <span className="font-mono text-sm text-base-content/60">{entry.family}</span>
        <span className="font-mono text-xs text-base-content/40">{fmtDate(entry.generatedAt)}</span>
        <ProgressChip entry={entry} size="md" />
      </div>

      {status === "interrupted" && (
        <p className="mb-4 mt-2 max-w-3xl rounded-lg border border-error/40 bg-error/10 px-3 py-2 font-mono text-2xs leading-5 text-error">
          <b className="font-semibold">Interrupted.</b> This report still flags itself live, but nothing has been
          written to it since{" "}
          {entry.heartbeat ? fmtDate(entry.heartbeat) : "— it never recorded a heartbeat"} — the script was killed.
          The {entry.repeatsDone} repeat{entry.repeatsDone === 1 ? "" : "s"} below did complete and are real; the
          remaining {Math.max(0, entry.repeats - entry.repeatsDone)} never ran.
        </p>
      )}

      <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-1 font-mono text-2xs text-base-content/50">
        <span>
          model <span className="text-base-content/70">{entry.model}</span>
        </span>
        <span>
          thinking <span className="text-base-content/70">{entry.thinking ?? "off"}</span>
        </span>
        <span>
          repeats{" "}
          <span className="text-base-content/70">
            {entry.repeatsDone}/{entry.repeats}
          </span>{" "}
          <span className="text-base-content/40">done/launched</span>
        </span>
        <ProvenanceChips entry={entry} />
        <span className="break-all">
          fixture <span className="text-base-content/70">{entry.fixture || "—"}</span>
        </span>
      </div>

      <Headline entry={entry} />

      {error ? (
        <p className="mt-5 rounded-lg border border-error/40 bg-error/10 px-3 py-2 font-mono text-2xs text-error">
          Couldn't load the report — {(error as Error).message}
        </p>
      ) : isLoading || !data ? (
        <p className="mt-5 font-mono text-xs text-base-content/40">loading claims…</p>
      ) : (
        <Repeats report={data} entry={entry} status={status} />
      )}
    </div>
  );
}

/** The one thing this page is for: the fire rate leading, the baseline and the
 * per-repeat points beside it at the same size, so no one number can be read
 * without the others. */
function Headline({ entry }: { entry: MicroSurveyEntry }) {
  const n = entry.needsProbePct.length;
  // The concurrency caveat is permanent WHERE AN AGGREGATE IS SHOWN, and this
  // report may carry no timings at all — in which case there is nothing to
  // caveat and the warning would only teach the reader to skip it.
  const timed =
    microSeries(entry.durationSec).any || microSeries(entry.turns).any || microSeries(entry.toolCalls).any;
  return (
    <div className="rounded-xl border border-base-300 bg-base-200 px-4 py-3.5">
      <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <div className="font-mono text-2xs uppercase tracking-wide text-accent/70" title={FIRE_RATE_HINT}>
            fire rate
          </div>
          <div
            className={clsx(
              "font-mono text-3xl font-bold tabular-nums",
              entry.fireRate === null ? "text-base-content/40" : "text-accent",
            )}
            title={FIRE_RATE_HINT}
          >
            {entry.fireRate === null ? "—" : fmtPct(entry.fireRate)}
          </div>
          <div className="font-mono text-2xs text-base-content/60">
            {entry.fireRate === null
              ? "no repeat has completed yet"
              : `${entry.firedRepeats}/${entry.repeatsDone} repeat${
                  entry.repeatsDone === 1 ? "" : "s"
                } fired`}
            {/* The comparator, beside the headline as everywhere else: the
                preserved arm is ONE observation, so it either fired or it
                didn't — it has no rate of its own. */}
            <span className="ml-1.5 text-base-content/40" title={BASELINE_HINT}>
              · baseline{" "}
              {entry.baselineNeedsProbePct === null
                ? "—"
                : entry.baselineNeedsProbePct > 0
                  ? "fired"
                  : "did not fire"}
            </span>
          </div>
          <div className="mt-0.5 font-mono text-2xs">
            <RankabilityNote repeatsDone={entry.repeatsDone} />
          </div>
        </div>

        <div>
          <div
            className="font-mono text-2xs uppercase tracking-wide text-base-content/40"
            title="What the preserved arm itself wrote for this family. The comparator — a replay number alone means nothing."
          >
            baseline needsProbe%
          </div>
          <div className="font-mono text-2xl font-bold tabular-nums text-base-content/60">
            {fmtProbePct(entry.baselineNeedsProbePct)}
          </div>
          <div className="font-mono text-2xs text-base-content/40">
            {entry.baselineRows === null ? "—" : `${entry.baselineRows} rows`}
          </div>
        </div>

        <div>
          <div className="font-mono text-2xs uppercase tracking-wide text-base-content/40">
            replay needsProbe% · {n} repeat{n === 1 ? "" : "s"}
          </div>
          <div className="font-mono text-2xl font-bold tabular-nums text-base-content">
            {repeatsList(entry.needsProbePct)}
          </div>
          <div className="font-mono text-2xs text-base-content/40">
            {n > 1 ? (
              <>
                range (min–max) <span className="text-base-content/60">{rangeText(entry.needsProbePct)}</span> — not a
                mean, not an SD
              </>
            ) : (
              "one repeat — an observation, not a result"
            )}
          </div>
        </div>

        <div>
          <div className="font-mono text-2xs uppercase tracking-wide text-base-content/40">rows per repeat</div>
          <div className="font-mono text-sm tabular-nums text-base-content">
            {entry.rows.length ? entry.rows.join(" / ") : "—"}
          </div>
        </div>

        <div>
          <div
            className="font-mono text-2xs uppercase tracking-wide text-base-content/40"
            title={REASSURANCE_HINT}
          >
            reassurance-shaped <span className="normal-case tracking-normal">(lexical heuristic)</span>
          </div>
          <div className="font-mono text-sm tabular-nums text-base-content/70" title={REASSURANCE_HINT}>
            {entry.reassuranceShaped.length ? entry.reassuranceShaped.join(" / ") : "—"}
          </div>
        </div>

        <div>
          <div className="font-mono text-2xs uppercase tracking-wide text-base-content/40">cost</div>
          <div className="font-mono text-sm tabular-nums text-base-content">${entry.costUsd.toFixed(3)}</div>
        </div>

        <LatencyBlock entry={entry} />
      </div>

      <p className="mt-3 max-w-3xl border-t border-base-300 pt-2.5 font-mono text-2xs leading-5 text-base-content/40">
        Every repeat is listed because the spread is the finding. Two or three points give a range, never a standard
        deviation — a summary statistic here would claim precision this measurement does not have.
      </p>
      {timed && <LatencyCaveat className="mt-1.5" />}
    </div>
  );
}

/** Per-repeat claim lines, as the replay printed them, plus a placeholder for
 * each repeat still to come — a live run's shape should be visible before its
 * numbers are, and "4 of 10" is not the same page as "4". */
function Repeats({
  report,
  entry,
  status,
}: {
  report: MicroSurveyReport;
  entry: MicroSurveyEntry;
  status: MicroStatus;
}) {
  const claims = report.claims ?? [];
  const pending = Math.max(0, entry.repeats - report.results.length);
  return (
    <div className="mt-6 flex flex-col gap-4">
      {report.results.map((res, i) => (
        <div key={i} className="rounded-xl border border-base-300 bg-base-200 px-4 py-3">
          <div className="mb-2 flex flex-wrap items-baseline gap-x-4 gap-y-1 font-mono text-2xs text-base-content/50">
            <span className="text-sm font-semibold text-accent">repeat {i + 1}</span>
            <span
              className={clsx(
                "rounded-full px-2 py-0.5 font-semibold",
                res.needsProbe > 0 ? "bg-accent/20 text-accent" : "bg-base-300 text-base-content/50",
              )}
              title="Did this repeat ask for at least one probe? The bit the fire rate counts."
            >
              {res.needsProbe > 0 ? "fired" : "no probe"}
            </span>
            <span>
              needsProbe{" "}
              <span className="text-base-content">
                {res.needsProbe}/{res.rows} · {fmtProbePct(res.needsProbePct)}
              </span>
            </span>
            <span title="What the preserved arm itself wrote for this family — the comparator.">
              baseline <span className="text-base-content/70">{fmtProbePct(report.baseline?.needsProbePct)}</span>
            </span>
            <span title={REASSURANCE_HINT}>
              reassurance-shaped (lexical) <span className="text-base-content/70">{res.reassuranceShaped}</span>
            </span>
            <span>
              cost <span className="text-base-content/70">${(res.costUsd ?? 0).toFixed(3)}</span>
            </span>
            {/* Beside the cost, because the two are read together — and only
                when the repeat was actually timed: an absent duration is left
                out rather than printed as 0s. */}
            {typeof res.durationSec === "number" && Number.isFinite(res.durationSec) && (
              <span title="Wall clock for this repeat. Comparable with its siblings in this run; comparable with another RUN only if both are known to have run serially.">
                time <span className="text-base-content/70">{fmtSecs(res.durationSec)}</span>
              </span>
            )}
            {typeof res.turns === "number" && Number.isFinite(res.turns) && (
              <span title="Assistant turns this repeat spent — the usual reason one repeat is slower than another.">
                turns <span className="text-base-content/70">{res.turns}</span>
              </span>
            )}
            {typeof res.toolCalls === "number" && Number.isFinite(res.toolCalls) && (
              <span title="Tool calls this repeat made.">
                tools <span className="text-base-content/70">{res.toolCalls}</span>
              </span>
            )}
          </div>
          <ClaimLines lines={claims[i] ?? []} />
        </div>
      ))}

      {pending > 0 && (
        <div className="rounded-xl border border-dashed border-base-300 px-4 py-3 font-mono text-2xs text-base-content/40">
          {status === "running" ? (
            <>
              {pending} repeat{pending === 1 ? "" : "s"} still to run — this page follows the report as it is
              rewritten.
            </>
          ) : status === "interrupted" ? (
            <span className="text-error/80">
              {pending} repeat{pending === 1 ? "" : "s"} never ran: the script was killed part-way.
            </span>
          ) : (
            <>
              {pending} of the {entry.repeats} launched repeat{entry.repeats === 1 ? "" : "s"} were never recorded.
            </>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * The claim lines verbatim, with the probe-worthy ones pulled out.
 *
 * The script pre-formats each line as `PROBE ` or `  .   ` then
 * `[severity] claim-text`, so the prefix is the only thing parsed here — the
 * claim text itself is never reformatted.
 */
function ClaimLines({ lines }: { lines: string[] }) {
  if (!lines.length) {
    return <p className="font-mono text-2xs text-base-content/40">no claims recorded for this repeat</p>;
  }
  return (
    <div className="flex flex-col gap-0.5">
      {lines.map((line, i) => {
        const probe = line.startsWith("PROBE");
        const text = line.replace(/^(PROBE|\s*\.\s*)\s*/, "");
        return (
          <div
            key={i}
            className={clsx(
              "flex items-baseline gap-2 rounded px-1.5 py-0.5 font-mono text-2xs",
              probe ? "bg-accent/10 text-base-content" : "text-base-content/55",
            )}
          >
            <span
              className={clsx(
                "w-14 shrink-0 text-center font-semibold",
                probe ? "rounded-full bg-accent/20 text-accent" : "text-base-content/25",
              )}
            >
              {probe ? "PROBE" : "·"}
            </span>
            <span className="break-words">{text}</span>
          </div>
        );
      })}
    </div>
  );
}

import clsx from "clsx";

import {
  MICRO_LATENCY_CAVEAT,
  MICRO_RANKABLE_REPEATS,
  microRange,
  microRankable,
  microSeries,
  microGoldScore,
  microStatus,
  type MicroGoldCell,
  type MicroGoldRef,
  type MicroGoldRepeat,
  type MicroGoldTally,
  type MicroGoldVerdict,
  type MicroRowView,
  type MicroSeedStats,
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
 *  5. **Counts are not quality.** The fire rate and needsProbe% only count
 *     probe requests — a pass that finds nothing and asks to verify every row
 *     scores 100%. When the report carries the case's gold, each repeat also
 *     says what it did AT each gold: asserted the defect, reached it and said
 *     it was fine, or missed it — and how many probe requests landed at a gold
 *     at all. That view sits beside the fire rate everywhere the fire rate
 *     appears, so the cost number is never read without the quality one.
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

/**
 * Every repeat as one small bar — the per-repeat points without the width of
 * spelling them out. Eight repeats of `66.7% / 50.0% / …` pushed the list's
 * right-hand columns off a laptop screen; eight bars are as wide as three
 * numbers, and each still carries its exact value on hover. `null` (a repeat
 * that recorded nothing for this series) is drawn hollow, never as a zero.
 */
function RepeatBars({
  values,
  max,
  fmt,
  tone = "bg-base-content/60",
}: {
  values: (number | null)[];
  max: number;
  fmt: (v: number) => string;
  tone?: string;
}) {
  if (!values.length) return <span className="text-base-content/40">—</span>;
  return (
    <span className="inline-flex h-4 items-end gap-0.5 align-middle">
      {values.map((v, i) =>
        v === null ? (
          <span
            key={i}
            className="h-4 w-1.5 rounded-sm border border-dashed border-base-content/30"
            title={`repeat ${i + 1}: not recorded`}
          />
        ) : (
          <span
            key={i}
            className={clsx("w-1.5 rounded-sm", v > 0 ? tone : "bg-base-content/20")}
            style={{ height: `${Math.max(2, Math.round((16 * Math.min(v, max)) / (max || 1)))}px` }}
            title={`repeat ${i + 1}: ${fmt(v)}`}
          />
        ),
      )}
    </span>
  );
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

/** What "baseline" means, everywhere it appears. It is easy to read as "the
 * reference model on current code", which it is not — it is frozen with the
 * fixture — so the definition is spelled out, not left to the word. */
const BASELINE_HINT =
  "The rows already inside the fixture — written by the full pr-review arm the fixture was preserved from, under whatever prompts, skills and model THAT arm ran. Free (nothing is re-run), and fixed forever for this fixture. It is NOT a run of today's code: for that, replay a reference model (e.g. Haiku) on the same fixture and family and compare the two reports. It is a single observation, so it fired or it did not; it has no fire rate of its own.";

/** The visible version of {@link BASELINE_HINT}, for the detail page. */
function BaselineNote() {
  return (
    <p className="mb-4 max-w-3xl rounded-lg border border-base-300 bg-base-200/60 px-3 py-2 text-2xs leading-5 text-base-content/60">
      <b className="font-semibold text-base-content/80">baseline</b> = the rows already inside the fixture, written by
      the full pr-review arm it was preserved from, under whatever prompts, skills and model that arm ran. It costs
      nothing and never changes for this fixture — but it is <b className="font-semibold">not</b> today's code. To
      compare against today's code, replay a reference model (e.g. Haiku) on the same fixture and family and read the
      two reports side by side.
    </p>
  );
}

const GOLD_HINT =
  "Per repeat, how many of the case's gold defects a row ASSERTED (the internal-recall judge: MATCH + CONFIRM, which scores a verification report at the right location as a non-match). Reached = a row cited the gold's lines but did not assert the defect — right lines, opposite verdict. The gold is the whole case's, so one family is not expected to reach all of it.";

const PROBE_SPLIT_HINT =
  "Probe requests on rows at a gold (asserting or reaching it) vs everywhere else, summed over completed repeats. On-gold is what a probe is for; off-gold is cost.";

/** `1 / 0 / —` of `4` — `—` for a repeat whose asserted count is unknown
 * (judge did not run), which is not the same thing as zero. */
function goldSeriesText(values: (number | null)[]): string {
  return values.length ? values.map((v) => (v === null ? "—" : String(v))).join(" / ") : "—";
}

const SEED_HINT =
  "The family's SEEDED checklist and what the pass did with it — the discharge gate's own ledger. seeded = checks the deterministic layer built (after its cap); answered = checks some row points at; skipped = seeded checks no row answered; own rows = rows tied to no seeded check, i.e. what the pass found by itself. Lines lost = rows the reader could not parse (e.g. pretty-printed JSON) — those rows exist but count as nothing.";

/** One repeat's (or the baseline's) seed ledger, as one short line. */
function SeedLine({ seed, prefix }: { seed: MicroSeedStats | null | undefined; prefix?: string }) {
  if (!seed) return null;
  const codes = Object.entries(seed.byCode ?? {});
  return (
    <div className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-0.5 font-mono text-2xs text-base-content/55" title={SEED_HINT}>
      <span className="text-base-content/40">{prefix ?? "checks"}</span>
      <span>
        seeded <span className="text-base-content">{seed.seeded}</span>
        {seed.droppedByCap > 0 && <span className="text-base-content/40"> (+{seed.droppedByCap} cut by cap)</span>}
      </span>
      <span>
        answered <span className="text-base-content">{seed.answered}</span>
        {codes.length > 0 && <span className="text-base-content/40"> ({codes.map(([k, v]) => `${k} ${v}`).join(" · ")})</span>}
      </span>
      <span className={clsx(seed.skipped > 0 && "text-warning")}>
        skipped <span className="font-semibold">{seed.skipped}</span>
      </span>
      <span>
        own rows <span className="text-base-content">{seed.ownRows}</span>
      </span>
      {seed.malformed > 0 && (
        <span className="rounded-full bg-error/15 px-2 text-error" title="Lines the reader could not parse — rows the pass wrote that count as nothing.">
          {seed.malformed} lines lost (unparseable)
        </span>
      )}
      <span className={clsx(seed.gateSatisfied ? "text-success/80" : "text-error")}>gate {seed.gateSatisfied ? "pass" : "FAIL"}</span>
    </div>
  );
}

const F1_HINT =
  "Per repeat, shaped like the full eval's posted F1. Recall = gold found ÷ ALL the case's gold (every family's, so one family's recall cannot reach 1 — compare runs on the same fixture and family, not across). Precision = rows claiming a defect (derived Important/Critical) that found a gold ÷ all rows claiming a defect; a reassurance is not a claim. Shown as a range, never a mean.";

/** `F1 0.00–0.29` — the range over judged repeats, or nothing when none were. */
function F1Line({ values, big = false }: { values: (number | null)[]; big?: boolean }) {
  const known = values.filter((v): v is number => v !== null);
  if (!known.length) return null;
  const lo = Math.min(...known), hi = Math.max(...known);
  const text = lo === hi ? lo.toFixed(2) : `${lo.toFixed(2)}–${hi.toFixed(2)}`;
  return (
    <div className={clsx("font-mono tabular-nums", big ? "text-2xs text-base-content/60" : "text-2xs text-base-content/70")} title={F1_HINT}>
      F1 <span className="font-semibold text-base-content">{text}</span>
      {known.length > 1 && <span className="text-base-content/40"> range</span>}
    </div>
  );
}

function probeSplit(entry: MicroSurveyEntry): { on: number; off: number } | null {
  if (!entry.probesOnGold?.some((v) => v !== null)) return null;
  const sum = (xs: (number | null)[]) => xs.reduce<number>((a, v) => a + (v ?? 0), 0);
  return { on: sum(entry.probesOnGold), off: sum(entry.probesOffGold) };
}

const VERDICT_STYLE: Record<MicroGoldVerdict, string> = {
  asserted: "bg-success/20 text-success",
  reached: "bg-warning/20 text-warning",
  missed: "bg-base-300 text-base-content/40",
};

/** The words the page uses — plain, because the terms of art (asserted /
 * reached) meant nothing to a reader who had not built the judge. */
const VERDICT_LABEL: Record<MicroGoldVerdict, string> = {
  asserted: "found it",
  reached: "looked, said fine",
  missed: "never looked",
};

const goldLabel = (g: MicroGoldRef | undefined, j: number) =>
  `G${j + 1}${g?.file ? ` ${g.file.split("/").pop()}${g.line ? `:${g.line}` : ""}` : ""}`;

/** One repeat's verdict per gold, as chips — or the reason there are none. */
function GoldChips({ overlay, gold }: { overlay: MicroGoldRepeat | undefined; gold: MicroGoldRef[] | undefined }) {
  if (!overlay || !gold?.length) return null;
  return (
    <div className="mb-2 flex flex-wrap items-center gap-1.5 font-mono text-2xs" title={GOLD_HINT}>
      <span className="text-base-content/40">gold</span>
      {overlay.cells.map((c, j) => (
        <span
          key={j}
          className={clsx("rounded-full px-2 py-0.5", VERDICT_STYLE[c.verdict])}
          title={`${gold[j]?.summary ?? ""}\n${c.verdict}${c.rows.length ? ` — ${c.rows.join(", ")}` : ""}${c.probed ? " · probed" : ""}`}
        >
          G{j + 1} {VERDICT_LABEL[c.verdict]}
          {c.probed && c.verdict !== "missed" ? " · verify asked" : ""}
        </span>
      ))}
      <span className="ml-2 text-base-content/50" title={PROBE_SPLIT_HINT}>
        probes on-gold <span className="text-base-content">{overlay.probesOnGold}</span> · off-gold{" "}
        <span className="text-base-content">{overlay.probesOffGold}</span>
      </span>
      {(() => {
        const sc = microGoldScore(overlay, gold.length);
        return sc ? (
          <span className="ml-2 text-base-content/50" title={F1_HINT}>
            P {sc.precision.toFixed(2)} · R {sc.recall.toFixed(2)} · F1{" "}
            <span className="font-semibold text-base-content">{sc.f1.toFixed(2)}</span>
          </span>
        ) : null;
      })()}
      {overlay.asserted === null && (
        <span className="text-warning" title={overlay.judgeError ?? "run with --no-judge"}>
          asserted unknown — {overlay.judgeError ? "judge failed" : "not judged"}
        </span>
      )}
      {overlay.confirmUngraded && (
        <span className="text-warning" title={overlay.confirmUngraded}>
          CONFIRM did not run — raw MATCH credits
        </span>
      )}
    </div>
  );
}

/**
 * Per defect, one STATE per repeat — the table the page exists for once a
 * report carries gold. It used to be four counters per defect (found / looked /
 * never / verified), which made one outcome into a sum the reader had to do.
 * Now each repeat is one square in the colour of what it did, a dot on the
 * square when a row there asked for a probe, and a one-line reading beside it.
 */
function GoldTable({ entry, report }: { entry: MicroSurveyEntry; report?: MicroSurveyReport }) {
  if (!entry.gold?.length || !entry.perGold) return null;
  const n = entry.goldAsserted.length;
  const overlays = (report?.results ?? []).map((r) => r.gold);
  return (
    <div className="mt-4 rounded-xl border border-base-300 bg-base-200">
      <div className="px-4 pt-3.5 pb-2">
        <div className="text-sm font-semibold text-base-content">Did it find the real defects?</div>
        <p className="mt-1 flex max-w-4xl flex-wrap items-center gap-x-4 gap-y-1 text-2xs leading-5 text-base-content/60">
          <span>One square per repeat ({n}):</span>
          <LegendSwatch verdict="asserted" text="found it — a row said this is wrong" />
          <LegendSwatch verdict="reached" text="looked, said fine — the failure this eval catches" />
          <LegendSwatch verdict="missed" text="never looked" />
          <span className="inline-flex items-center gap-1.5">
            <span className="relative inline-block h-3 w-3 rounded-sm bg-warning/70">
              <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-info ring-1 ring-base-200" />
            </span>
            dot = asked for a probe there
          </span>
        </p>
      </div>
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-neutral text-2xs uppercase tracking-wide text-neutral-content/70">
              <th className="px-3 py-2.5 text-left font-semibold">defect</th>
              <th className="px-3 py-2.5 text-left font-semibold">each repeat</th>
              <th className="px-3 py-2.5 text-right font-semibold" title={BASELINE_HINT}>
                baseline
              </th>
            </tr>
          </thead>
          <tbody>
            {entry.gold.map((g, j) => {
              const t = entry.perGold?.[j];
              const bl = entry.baselineGold?.cells[j];
              const cells = overlays.map((o) => o?.cells[j]);
              return (
                <tr key={j} className="border-t border-base-300 align-top">
                  <td className="px-3 py-2">
                    <div className="whitespace-nowrap font-mono text-xs text-base-content">
                      {goldLabel(g, j)} <span className="text-base-content/40">[{g.severity}]</span>
                    </div>
                    <div className="max-w-xl text-2xs leading-4 text-base-content/55">{g.summary}</div>
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {cells.length
                        ? cells.map((c, i) => <StateSquare key={i} cell={c} repeat={i + 1} />)
                        : <span className="font-mono text-2xs text-base-content/40">loading…</span>}
                    </div>
                    {t && <div className="mt-1 font-mono text-2xs text-base-content/60">{tallyText(t)}</div>}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {bl ? (
                      <span
                        className={clsx("whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-2xs", VERDICT_STYLE[bl.verdict])}
                        title={BASELINE_HINT}
                      >
                        {VERDICT_LABEL[bl.verdict]}
                        {bl.probed && bl.verdict !== "missed" ? " · probe asked" : ""}
                      </span>
                    ) : (
                      <span className="font-mono text-2xs text-base-content/40">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="border-t border-base-300 px-3 py-2 font-mono text-2xs leading-5 text-base-content/40">
        "Found it" is the judge's call (MATCH + CONFIRM); "looked" / "never looked" come from the lines each row cites
        (±15 of the reviewer's comment), so they are known even when the judge did not run. The gold is the whole
        PR's — one survey family is not expected to reach every defect.
        {entry.baselineGold?.asserted === null && " The baseline was not judged — its verdicts are location-only."}
      </p>
    </div>
  );
}

const SQUARE_STYLE: Record<MicroGoldVerdict, string> = {
  asserted: "bg-success",
  reached: "bg-warning/70",
  missed: "bg-base-300",
};

function LegendSwatch({ verdict, text }: { verdict: MicroGoldVerdict; text: string }) {
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className={clsx("inline-block h-3 w-3 rounded-sm", SQUARE_STYLE[verdict])} />
      {text}
    </span>
  );
}

/** One repeat's outcome at one defect. Hollow when the repeat recorded none. */
function StateSquare({ cell, repeat }: { cell: MicroGoldCell | undefined; repeat: number }) {
  if (!cell) {
    return (
      <span
        className="inline-block h-4 w-4 rounded-sm border border-dashed border-base-content/30"
        title={`repeat ${repeat}: no gold verdict recorded`}
      />
    );
  }
  return (
    <span
      className={clsx("relative inline-block h-4 w-4 rounded-sm", SQUARE_STYLE[cell.verdict])}
      title={`repeat ${repeat}: ${VERDICT_LABEL[cell.verdict]}${cell.probed ? " · asked for a probe" : ""}${
        cell.rows.length ? ` — ${cell.rows.join(", ")}` : ""
      }`}
    >
      {cell.probed && cell.verdict !== "missed" && (
        <span className="absolute -right-0.5 -top-0.5 h-1.5 w-1.5 rounded-full bg-info ring-1 ring-base-200" />
      )}
    </span>
  );
}

/** `found 2 · said fine 5 · never looked 1` — or one phrase when every repeat agreed. */
function tallyText(t: MicroGoldTally): string {
  const parts: [number, string][] = [
    [t.asserted, "found it"],
    [t.reached, "looked, said fine"],
    [t.missed, "never looked"],
  ];
  const nonzero = parts.filter(([k]) => k > 0);
  const body =
    nonzero.length === 1 && nonzero[0][0] === t.repeats
      ? `${nonzero[0][1]} — every repeat`
      : nonzero.map(([k, s]) => `${s} ${k}`).join(" · ");
  const judged = t.judged < t.repeats ? ` (found it judged on ${t.judged}/${t.repeats})` : "";
  const probed = t.probedAtGold ? ` · probe asked ${t.probedAtGold}/${t.repeats}` : "";
  return `${body}${probed}${judged}`;
}

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
      {/* One short fact per line: the column is as wide as its longest line,
          and "12m total · 1m 4s–4m 2s per repeat" on one line made it the
          widest in the table. */}
      <div>
        {fmtSecs(dur.total)} total<span className="text-base-content/30">{partialNote(dur)}</span>
      </div>
      {dur.measured.length > 1 && (
        <div className="text-base-content/40">{seriesRangeText(dur, fmtSecs)} each</div>
      )}
      {shape.map((x) => (
        <div key={x} className="text-base-content/35">
          {x}
        </div>
      ))}
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
        read against the <b className="font-semibold text-base-content/70" title={BASELINE_HINT}>baseline</b> beside it — the rows already
        inside the fixture, written by the arm it was preserved from on <i>that</i> arm's pipeline (not today's code;
        hover for more). Below {MICRO_RANKABLE_REPEATS} completed repeats a fire rate is
        shown but is <b className="font-semibold text-warning">not rankable</b>. Cost and{" "}
        <b className="font-semibold text-base-content/70">wall clock</b> ride together in the last column, so a
        model that is cheap but slow is visible beside its fire rate. The fire rate only counts probe requests, so{" "}
        <b className="font-semibold text-base-content/70">on gold</b> sits beside it: per repeat, how many of the
        case's gold defects a row actually asserted, and how many probe requests landed at a gold at all.
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
                <th className="px-3 py-3 text-left font-semibold" title={GOLD_HINT}>
                  real defects found · probes
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
                        title={BASELINE_HINT}
                      >
                        baseline{" "}
                        <span className="text-base-content/80">{fmtProbePct(r.baselineNeedsProbePct)}</span>
                      </div>
                      <RepeatBars values={r.needsProbePct} max={100} fmt={(v) => fmtProbePct(v)} tone="bg-accent" />
                      <div className="text-2xs text-base-content/40">
                        {r.needsProbePct.length > 1
                          ? `range ${rangeText(r.needsProbePct)}`
                          : r.needsProbePct.length === 1
                            ? fmtProbePct(r.needsProbePct[0])
                            : "no repeat yet"}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono tabular-nums" title={GOLD_HINT}>
                      {r.gold?.length ? (
                        <>
                          <div className="text-2xs text-base-content/60">
                            baseline{" "}
                            <span className="text-base-content/80">
                              {r.baselineGold?.asserted ?? "—"}/{r.gold.length}
                            </span>
                          </div>
                          <RepeatBars
                            values={r.goldAsserted}
                            max={r.gold.length}
                            fmt={(v) => `${v} of ${r.gold!.length} gold asserted`}
                            tone="bg-success"
                          />
                          <div className="text-2xs text-base-content/40">
                            {(() => {
                              const known = r.goldAsserted.filter((v): v is number => v !== null);
                              if (!known.length) return "not judged yet";
                              const lo = Math.min(...known), hi = Math.max(...known);
                              return `${lo === hi ? lo : `${lo}–${hi}`} of ${r.gold.length} asserted`;
                            })()}
                          </div>
                          <F1Line values={r.goldF1} />
                          {(() => {
                            const split = probeSplit(r);
                            return split ? (
                              <div className="text-2xs text-base-content/50" title={PROBE_SPLIT_HINT}>
                                probes on-gold {split.on}/{split.on + split.off}
                              </div>
                            ) : null;
                          })()}
                        </>
                      ) : (
                        <span className="text-2xs text-base-content/30" title="Run with --instances to grade against the case's gold.">
                          no gold
                        </span>
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

      <BaselineNote />
      {entry.baselineSeed && (
        <div className="-mt-2 mb-3">
          <SeedLine seed={entry.baselineSeed} prefix="baseline checks" />
        </div>
      )}
      <Headline entry={entry} />
      <GoldTable entry={entry} report={data} />

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
            title={BASELINE_HINT}
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
          <div className="flex items-center gap-2">
            <RepeatBars values={entry.needsProbePct} max={100} fmt={(v) => fmtProbePct(v)} tone="bg-accent" />
            <span className="max-w-md font-mono text-sm font-semibold tabular-nums text-base-content">
              {repeatsList(entry.needsProbePct)}
            </span>
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

        {entry.gold?.length ? (
          <div title={GOLD_HINT}>
            <div className="font-mono text-2xs uppercase tracking-wide text-success/70">gold asserted · per repeat</div>
            <div className="flex items-center gap-2">
              <RepeatBars
                values={entry.goldAsserted}
                max={entry.gold.length}
                fmt={(v) => `${v} of ${entry.gold!.length}`}
                tone="bg-success"
              />
              <span className="font-mono text-sm font-semibold tabular-nums text-base-content">
                {goldSeriesText(entry.goldAsserted)}
                <span className="ml-1.5 font-normal text-base-content/40">of {entry.gold.length}</span>
              </span>
            </div>
            <F1Line values={entry.goldF1} big />
            <div className="font-mono text-2xs text-base-content/40">
              baseline {entry.baselineGold?.asserted ?? "—"}/{entry.gold.length}
              {(() => {
                const split = probeSplit(entry);
                return split ? (
                  <span title={PROBE_SPLIT_HINT}>
                    {" "}
                    · probes on-gold {split.on} of {split.on + split.off}
                  </span>
                ) : null;
              })()}
            </div>
          </div>
        ) : null}

        {entry.seed.some(Boolean) || entry.baselineSeed ? (
          <div title={SEED_HINT}>
            <div className="font-mono text-2xs uppercase tracking-wide text-base-content/40">seeded checks</div>
            <div className="font-mono text-sm tabular-nums text-base-content">
              {(entry.seed.find(Boolean) ?? entry.baselineSeed)?.seeded ?? "—"} seeded
            </div>
            <div className="font-mono text-2xs text-base-content/50">
              answered {goldSeriesText(entry.seed.map((x) => x?.answered ?? null))} · own rows{" "}
              {goldSeriesText(entry.seed.map((x) => x?.ownRows ?? null))}
            </div>
            {entry.seed.some((x) => (x?.malformed ?? 0) > 0) && (
              <div className="font-mono text-2xs text-error">
                lines lost {goldSeriesText(entry.seed.map((x) => x?.malformed ?? null))}
              </div>
            )}
          </div>
        ) : null}

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
            <span title={BASELINE_HINT}>
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
          <GoldChips overlay={res.gold} gold={report.gold} />
          <SeedLine seed={res.seed} />
          {res.rowsView ? (
            <RowLines rows={res.rowsView} checks={report.checks} />
          ) : (
            <ClaimLines lines={claims[i] ?? []} />
          )}
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

const PROBE_LABEL: Record<string, { text: string; cls: string; hint: string }> = {
  verify: {
    text: "VERIFY",
    cls: "bg-base-300 text-base-content/60",
    hint: "Probe asked only to VERIFY a reassurance: a clean discharge (binding control, nothing it cannot tell apart) sitting over a changed hunk.",
  },
  risk: { text: "RISK", cls: "bg-error/20 text-error", hint: "Probe asked because a consequence is stated and the control is not clean." },
  gap: { text: "GAP", cls: "bg-warning/25 text-warning", hint: "Probe asked because the control cannot tell two cases apart." },
  unknown: { text: "UNKNOWN", cls: "bg-info/20 text-info", hint: "Probe asked because order or authority could not be established." },
};

/**
 * Every row, with the seeded check it answers and WHY it asks for a probe.
 *
 * The pre-formatted claim lines could only say PROBE, so twelve clean
 * discharges asking to be verified looked identical to twelve suspected
 * defects. The reason comes from `probeReasonOf` in `lastlight-code-facts`,
 * beside the derivation itself.
 */
function RowLines({ rows, checks }: { rows: MicroRowView[]; checks?: { id: string; question: string }[] }) {
  if (!rows.length) return <p className="font-mono text-2xs text-base-content/40">no rows recorded for this repeat</p>;
  const question = new Map((checks ?? []).map((c) => [c.id, c.question]));
  const byReason = rows.reduce<Record<string, number>>((a, r) => {
    const k = r.probe ?? "none";
    a[k] = (a[k] ?? 0) + 1;
    return a;
  }, {});
  return (
    <div className="flex flex-col gap-0.5">
      <div className="mb-1 flex flex-wrap gap-x-3 font-mono text-2xs text-base-content/45">
        {(["risk", "gap", "unknown", "verify"] as const)
          .filter((k) => byReason[k])
          .map((k) => (
            <span key={k} title={PROBE_LABEL[k].hint}>
              {PROBE_LABEL[k].text.toLowerCase()} <span className="text-base-content/80">{byReason[k]}</span>
            </span>
          ))}
        {byReason.none ? (
          <span>
            no probe <span className="text-base-content/80">{byReason.none}</span>
          </span>
        ) : null}
      </div>
      {rows.map((r) => {
        const label = r.probe ? PROBE_LABEL[r.probe] : null;
        return (
          <div
            key={r.id}
            className={clsx(
              "flex items-baseline gap-2 rounded px-1.5 py-0.5 font-mono text-2xs",
              r.probe && r.probe !== "verify" ? "bg-accent/10 text-base-content" : "text-base-content/60",
            )}
          >
            <span
              className={clsx("w-16 shrink-0 rounded-full text-center font-semibold", label ? label.cls : "text-base-content/25")}
              title={label?.hint ?? "no probe asked"}
            >
              {label?.text ?? "·"}
            </span>
            <span
              className={clsx(
                "w-14 shrink-0 text-center",
                r.obligation ? "text-info" : "italic text-base-content/40",
              )}
              title={r.obligation ? `seeded check ${r.obligation}: ${question.get(r.obligation) ?? ""}` : "answers no seeded check — the pass's own row"}
            >
              {r.obligation ?? "own"}
            </span>
            <span className="w-16 shrink-0 text-base-content/45">[{r.severity ?? "?"}]</span>
            <span className="break-words" title={r.claim}>
              {r.claim.slice(0, 160)}
            </span>
          </div>
        );
      })}
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

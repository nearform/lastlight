/**
 * Runs → the rows of the overview's runs table.
 *
 * Two things were wrong with a row-per-run, column-per-model table:
 *
 *  1. **A column per model id.** Every model any run in the folder ever used got
 *     a column, so a folder holding four arms rendered rows that were almost
 *     entirely `—`. Worse, the SAME model appeared twice — once as
 *     `Claude Haiku 4.5` (the registry label for `anthropic/claude-haiku-4-5`)
 *     and once as the raw `anthropic/claude-haiku-4-5-20251001`, because the
 *     runs pinned a snapshot id the registry doesn't list. The arm a run
 *     measured is a property OF THE RUN, not a column of the table; it is now
 *     one `Arm` cell (overlay + {@link modelDisplay}'d model).
 *  2. **A band rendered as N unrelated results.** `--repeats N` writes N sibling
 *     run dirs of ONE arm, and reading any one of them as "the result" is the
 *     single easiest way to mistake noise for progress (0.320 / 0.080 / 0.200 on
 *     one measured arm). They fold into one row here, keyed on
 *     `meta.repeat.group`, showing every repeat's point plus the band.
 *
 * Pure functions over the already-fetched `/api/index`: no React, no fetching,
 * so the grouping and the band arithmetic are testable directly. The same
 * functions serve the live `serve` index and the baked static manifest — both
 * are the same `buildIndex` output.
 */

import type { IndexRun, ModelSummary } from "../types";
import { modelDisplay, tierMetric, type TierMetric } from "./format";

/** A run's summaries for one tier (a run may span several). */
export function tierModels(run: IndexRun, tier: string): ModelSummary[] {
  return run.byTier.find((b) => b.tier === tier)?.models ?? [];
}

/** What was under test: the overlay plus the model(s), each with its raw id kept
 * for the `title`. A `config` run's "models" are config names, so they are shown
 * verbatim rather than normalised through the model registry. */
export interface Arm {
  /** `meta.overlay`'s basename (`overlays/wp3-minimal` → `wp3-minimal`), or
   * undefined when the run recorded no overlay — which means "not recorded",
   * never "no overlay". */
  overlay?: string;
  /** The full overlay path, for the `title`. */
  overlayPath?: string;
  runType: "models" | "config";
  models: { label: string; title: string }[];
}

/** One point in a row's score cell: a repeat's score, or (on a multi-arm run
 * like `triage-compare`) one arm's. */
export interface ScorePoint {
  /** Chip prefix — `#1`/`#2` in a band, the arm name on a multi-arm run, empty
   * for the ordinary one-run-one-arm case where the Arm column already says it. */
  label: string;
  /** 0..1, for the band arithmetic. `null` = nothing graded (yet), which is NOT
   * a zero — it is excluded from the mean rather than dragging it down. */
  rate: number | null;
  /** The metric's own text, e.g. `32% · 8/25`. `—` when undefined. */
  text: string;
  /** The run this point came from — chips deep-link to it. */
  runId: string;
  generatedAt: string;
  gitSha?: string;
  live: boolean;
}

/** One row of the runs table: a repeat band, or a single ungrouped run. */
export interface RunGroup {
  key: string;
  /** The group's runs in repeat order (oldest → newest for unstamped runs). */
  runs: IndexRun[];
  /** Newest run in the group — the row's timestamp, and what a row click opens. */
  latest: IndexRun;
  /** First repeat — the run the repeat view is anchored on. */
  anchor: IndexRun;
  /** The harness stamped `meta.repeat`: this is a deliberate band, not a
   * coincidence. A single ungrouped run is `false`. */
  banded: boolean;
  /** Repeats the band was launched with (`meta.repeat.of`). */
  of?: number;
  /** Launched but not yet on disk (`of` − discovered). >0 ⇒ still in flight. */
  outstanding: number;
  live: boolean;
  interrupted: boolean;
  /** Distinct git SHAs across the group — a band CAN span two (a commit landing
   * mid-band), and hiding that would hide why the repeats disagree. */
  gitShas: string[];
  arm: Arm;
  points: ScorePoint[];
  /** Band arithmetic over the known points. `mean` is reported only when the
   * band is COMPLETE and has ≥2 points; a partial band's mean is not the band's. */
  mean: number | null;
  min: number | null;
  max: number | null;
  /** `max − min`, the harness's own definition (`VarianceRollup.band`). */
  band: number | null;
  /** Cases the arm covered (the widest any repeat graded). */
  cases: number;
  /** Total cost across the group's runs, for this tier. */
  cost: number;
}

/** The fold key: the harness's band stamp when present, else the run itself. */
export function groupKeyOf(run: IndexRun): string {
  return run.repeat?.group ?? run.id;
}

const basename = (p: string): string => p.replace(/\/+$/, "").split("/").pop() ?? p;

/**
 * The arm a run measured, in this tier.
 *
 * Arm labels come from the tier's summaries when there are any and from
 * `meta.models` otherwise, so a run that is live with nothing graded yet still
 * names its arm instead of rendering blank.
 */
export function armOf(run: IndexRun, tier: string, labels: Record<string, string>): Arm {
  const summarised = tierModels(run, tier).map((m) => m.model);
  const ids = summarised.length ? summarised : (run.models ?? []);
  const runType = run.runType ?? "models";
  return {
    overlay: run.overlay ? basename(run.overlay) : undefined,
    overlayPath: run.overlay,
    runType,
    models:
      runType === "config"
        ? ids.map((id) => ({ label: id, title: id }))
        : ids.map((id) => modelDisplay(labels, id)),
  };
}

/**
 * One run's score points for a tier.
 *
 * `rate` is derived from the SAME summary the text is, and is nulled whenever
 * the text is an em dash: `tierMetric().rate` returns 0 for an ungraded summary
 * (it has to, to sort), and folding that 0 into a band's mean would report a
 * measured failure where there was no measurement.
 */
function pointsFor(run: IndexRun, tier: string, metric: TierMetric, prefix: string, labels: Record<string, string>): ScorePoint[] {
  const models = tierModels(run, tier);
  const multiArm = models.length > 1;
  if (!models.length) {
    return prefix ? [{ label: prefix, rate: null, text: "—", runId: run.id, generatedAt: run.generatedAt, gitSha: run.gitSha, live: run.live }] : [];
  }
  return models.map((m) => {
    const text = metric.frac(m);
    const arm = run.runType === "config" ? m.model : modelDisplay(labels, m.model).label;
    return {
      label: [prefix, multiArm ? arm : ""].filter(Boolean).join(" "),
      rate: text === "—" ? null : metric.rate(m),
      text,
      runId: run.id,
      generatedAt: run.generatedAt,
      gitSha: run.gitSha,
      live: run.live,
    };
  });
}

/** Repeat order: the harness's 1-based `index` when stamped, else chronological. */
function byRepeatOrder(a: IndexRun, b: IndexRun): number {
  const ia = a.repeat?.index;
  const ib = b.repeat?.index;
  if (ia !== undefined && ib !== undefined && ia !== ib) return ia - ib;
  return a.generatedAt < b.generatedAt ? -1 : a.generatedAt > b.generatedAt ? 1 : 0;
}

/**
 * Fold a tier's runs into table rows, newest group first.
 *
 * Runs carrying no `meta.repeat` — every run measured before that stamp existed,
 * including the four preserved 2026-08-22 keepers — each become their own
 * single-run group and render exactly as one row, as they did before. Nothing is
 * grouped heuristically here: the band stamp is the only evidence that two runs
 * are the same arm, and guessing would silently fold a baseline in with the
 * candidates it is the control for.
 */
export function groupRuns(runs: IndexRun[], tier: string, labels: Record<string, string>): RunGroup[] {
  const metric = tierMetric(tier);
  const buckets = new Map<string, IndexRun[]>();
  for (const run of runs) {
    const key = groupKeyOf(run);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(run);
    else buckets.set(key, [run]);
  }

  const groups: RunGroup[] = [];
  for (const [key, bucket] of buckets) {
    const ordered = [...bucket].sort(byRepeatOrder);
    const latest = ordered.reduce((a, b) => (a.generatedAt >= b.generatedAt ? a : b));
    const banded = ordered.some((r) => !!r.repeat);
    const of = Math.max(0, ...ordered.map((r) => r.repeat?.of ?? 0)) || undefined;
    const outstanding = of ? Math.max(0, of - ordered.length) : 0;
    const multi = ordered.length > 1 || (banded && (of ?? 1) > 1);

    const points = ordered.flatMap((run, i) =>
      pointsFor(run, tier, metric, multi ? `#${run.repeat?.index ?? i + 1}` : "", labels),
    );
    const rates = points.map((p) => p.rate).filter((x): x is number => x !== null);
    // A band is the spread of ONE arm re-run, so it is reported only for a
    // multi-RUN group and only once every launched repeat has landed. The spread
    // across the twelve arms of a `triage-compare` run is not a band — averaging
    // those would report "μ98% ±13%" for twelve different models.
    //
    // "Landed" must also mean FINISHED: repeat run dirs are pre-assigned at
    // launch and scorecards are written live, so `outstanding === 0` passes
    // while cases are still completing — a μ over partial scorecards is a
    // moving number that will be misread as the result. Withhold it while any
    // repeat is live; the per-repeat chips still show the partial scores.
    const anyLive = ordered.some((r) => r.live);
    const complete = ordered.length > 1 && outstanding === 0 && rates.length >= 2 && !anyLive;
    const min = rates.length ? Math.min(...rates) : null;
    const max = rates.length ? Math.max(...rates) : null;

    groups.push({
      key,
      runs: ordered,
      latest,
      anchor: ordered[0],
      banded,
      of,
      outstanding,
      live: ordered.some((r) => r.live),
      interrupted: ordered.some((r) => r.interrupted),
      gitShas: [...new Set(ordered.map((r) => r.gitSha).filter((s): s is string => !!s))],
      arm: armOf(latest, tier, labels),
      points,
      mean: complete ? rates.reduce((a, b) => a + b, 0) / rates.length : null,
      min: complete ? min : null,
      max: complete ? max : null,
      band: complete && min !== null && max !== null ? max - min : null,
      cases: Math.max(0, ...ordered.map((r) => Math.max(0, ...tierModels(r, tier).map((m) => m.total)))),
      cost: ordered.reduce((s, r) => s + tierModels(r, tier).reduce((n, m) => n + (m.totalCostUsd || 0), 0), 0),
    });
  }

  return groups.sort((a, b) =>
    a.latest.generatedAt < b.latest.generatedAt ? 1 : a.latest.generatedAt > b.latest.generatedAt ? -1 : 0,
  );
}

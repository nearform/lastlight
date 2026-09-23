/**
 * The micro-survey report contract — the shapes `scripts/micro-survey.ts` writes
 * and the dashboard reads, plus the pure arithmetic over them.
 *
 * A micro-survey replays ONE survey branch of the pr-review pipeline against a
 * preserved workspace: ~2 minutes and ~$0.25 instead of a 30-47 minute full
 * case. It is the fast feedback loop for a prompt or skill edit, and it writes
 * one JSON file per invocation to
 * `eval-results/micro-survey/<ISO-stamp>-<label>-<family>.json`, which the
 * dashboard server already serves under `/data/`.
 *
 * **Node-free on purpose** (same contract as `review-metrics.ts`): the harness
 * scan in `report.ts` needs `node:fs`, the browser bundle must not, so the
 * shapes and the arithmetic live here and both sides import them rather than
 * keeping a copy that can drift.
 *
 * Two facts this module exists to keep honest:
 *
 *  - **`needsProbePct` means nothing without its baseline.** The replay number
 *    is only ever read against what the preserved arm itself wrote for that
 *    family, so {@link MicroSurveyEntry} carries the two together and never the
 *    replay alone.
 *  - **A band of repeats is a RANGE, not a mean.** The survey runs at
 *    temperature 1 and its run-to-run variance is the dominant effect; two or
 *    three points support a min-max spread and nothing more. {@link microRange}
 *    is the only aggregate offered here — deliberately no mean and no SD.
 *
 * And one that arrived later, from measuring the `enforcement` family: the
 * per-repeat `needsProbePct` is **bimodal**. A repeat marks ~5 rows or it marks
 * none; almost nothing lands in between. So the percentage is a Bernoulli trial
 * wearing a continuous disguise, and the quantity that actually varies between
 * two arms is {@link microFireRate} — the fraction of repeats that asked for at
 * least one probe. That is the headline; the per-repeat percentages stay visible
 * beneath it as the evidence, never folded into a mean.
 */

/** What `summarise()` in the script records for one hypotheses file. */
export interface MicroSurveyStats {
  rows: number;
  needsProbe: number;
  /** 0..100, already a percentage (not a 0..1 ratio). */
  needsProbePct: number;
  /**
   * Claims that assert the code is fine and ask for no probe, matched by a
   * regex over the claim text. A LEXICAL tripwire, not a judge — it is reported
   * so a shift in shape is visible, never as ground truth.
   */
  reassuranceShaped: number;
}

/** One replayed repeat: the stats plus what that repeat cost — in money and in
 * time. Everything but the stats themselves is OPTIONAL, and absent means NOT
 * RECORDED: reports written before the script measured latency carry none of
 * these, and `turns`/`toolCalls` can be `null` even on a report that does. A
 * consumer must render absence as absence, never as a measured zero — see
 * {@link microSeries}. */
export interface MicroSurveyResult extends MicroSurveyStats {
  costUsd?: number;
  /** Wall clock for this repeat, seconds. */
  durationSec?: number | null;
  /** Assistant turns the repeat spent; `null` when the harness could not read
   * them. The usual explanation for a slow repeat. */
  turns?: number | null;
  /** Tool calls the repeat made; `null` when unreadable. */
  toolCalls?: number | null;
}

/** One `eval-results/micro-survey/*.json` file, verbatim. */
export interface MicroSurveyReport {
  label: string;
  family: string;
  model: string;
  thinking?: string | null;
  /** What the run was LAUNCHED with. */
  repeats: number;
  /** How many repeats have completed. Absent on reports written before the
   * script started publishing after every repeat. */
  repeatsDone?: number;
  /** `true` on every write but the last one — the run is still going. */
  live?: boolean;
  /** Refreshed on every write. The only evidence that a `live` report is still
   * being written by a process that exists; see {@link microStatus}. */
  heartbeat?: string;
  /** Was Pi's ambient skill discovery on (the arm's own default)? */
  ambientSkills?: boolean;
  /** Was the workspace `AGENTS.md` present? */
  agentsMd?: boolean;
  /** `firedRepeats / repeatsDone` — the headline; `null` when none are done. */
  fireRate?: number | null;
  /** Repeats that asked for at least one probe. */
  firedRepeats?: number;
  fixture: string;
  /** What the preserved arm itself wrote for this family — the comparator. */
  baseline: MicroSurveyStats;
  /** One entry per COMPLETED repeat, parallel to {@link claims}. The script
   * rewrites this file after every repeat, so it grows during a run and may be
   * shorter than {@link repeats}. */
  results: MicroSurveyResult[];
  /**
   * One entry per repeat, parallel to {@link results}: pre-formatted claim
   * lines, each beginning `PROBE ` or `  .   ` then `[severity] claim-text`.
   */
  claims: string[][];
}

/** A report as the index lists it — enough to rank and label it without
 * fetching the file, which the detail view then does. */
export interface MicroSurveyEntry {
  /** Filename without `.json`; the id in the URL. */
  id: string;
  /** Where the full {@link MicroSurveyReport} is, for the detail view. */
  report: string;
  /** ISO timestamp recovered from the filename, else the file's mtime. */
  generatedAt: string;
  label: string;
  family: string;
  model: string;
  thinking: string | null;
  /** `repeats` as the run was LAUNCHED with — may exceed `repeatsDone` while the
   * run is still going, or forever if the script died part-way. Either way it is
   * a fact worth showing, which is why the two are carried separately. */
  repeats: number;
  /** Repeats completed so far. */
  repeatsDone: number;
  /** The script's own `live` flag: `false`/absent on the final write. Read it
   * through {@link microStatus}, never on its own — a `live` report whose writer
   * died keeps saying `true` forever. */
  live: boolean;
  /** The last write's timestamp, or `null` on a report that predates it. */
  heartbeat: string | null;
  /** Provenance: two runs that disagree on either of these are not comparable.
   * `null` means the report did not record it, never "off". */
  ambientSkills: boolean | null;
  agentsMd: boolean | null;
  /** **The headline.** `firedRepeats / repeatsDone`; `null` when none are done.
   * See {@link microFireRate} for why this and not a mean of the percentages. */
  fireRate: number | null;
  firedRepeats: number;
  fixture: string;
  /** The comparator. `null` when the report carried no baseline. */
  baselineNeedsProbePct: number | null;
  baselineRows: number | null;
  /** One per completed repeat, in order. */
  needsProbePct: number[];
  rows: number[];
  reassuranceShaped: number[];
  /** Summed over the repeats that completed. */
  costUsd: number;
  /**
   * Wall clock per completed repeat, seconds — `null` for a repeat whose report
   * predates the measurement. Carried as an ARRAY, like every other per-repeat
   * series here, because the honest aggregate is the points plus a range and
   * the list must be able to show that without fetching the whole report.
   * Read it through {@link microSeries}, and never without
   * {@link MICRO_LATENCY_CAVEAT}.
   */
  durationSec: (number | null)[];
  /** Assistant turns per completed repeat; `null` where unrecorded. */
  turns: (number | null)[];
  /** Tool calls per completed repeat; `null` where unrecorded. */
  toolCalls: (number | null)[];
}

export interface MicroSurveyIndex {
  generatedAt: string;
  reports: MicroSurveyEntry[];
}

/**
 * Fill in an index entry served by an OLDER harness.
 *
 * `/api/micro` is not always computed by the code reading it: the dashboard is
 * a long-lived SPA against a `serve` process that may predate these fields, and
 * `scripts/build-site.ts` BAKES the index into a static file that then outlives
 * every rebuild of the bundle. An entry missing the live/fire-rate fields must
 * therefore degrade to what an old report could still answer — a completed run
 * whose fire rate is derived from its per-repeat percentages — rather than
 * render `undefined/undefined`.
 */
export function withMicroEntryDefaults(e: MicroSurveyEntry): MicroSurveyEntry {
  const hasLive = typeof e?.repeatsDone === "number" && typeof e?.firedRepeats === "number";
  const hasLatency =
    Array.isArray(e?.durationSec) && Array.isArray(e?.turns) && Array.isArray(e?.toolCalls);
  if (hasLive && hasLatency) return e;
  const pcts = Array.isArray(e?.needsProbePct) ? e.needsProbePct : [];
  // An older index recorded no latency at all. One `null` per completed repeat
  // is the truthful filler: the repeats happened, nobody timed them.
  const unmeasured = (xs: unknown): (number | null)[] =>
    Array.isArray(xs) ? (xs as (number | null)[]) : pcts.map(() => null);
  const repeatsDone = typeof e?.repeatsDone === "number" ? e.repeatsDone : pcts.length;
  const firedRepeats =
    typeof e?.firedRepeats === "number" ? e.firedRepeats : pcts.filter((p) => num(p) > 0).length;
  return {
    ...e,
    repeatsDone,
    firedRepeats,
    fireRate: typeof e?.fireRate === "number" ? e.fireRate : microFireRate(firedRepeats, repeatsDone),
    live: e?.live === true,
    heartbeat: typeof e?.heartbeat === "string" ? e.heartbeat : null,
    ambientSkills: typeof e?.ambientSkills === "boolean" ? e.ambientSkills : null,
    agentsMd: typeof e?.agentsMd === "boolean" ? e.agentsMd : null,
    durationSec: unmeasured(e?.durationSec),
    turns: unmeasured(e?.turns),
    toolCalls: unmeasured(e?.toolCalls),
  };
}

/**
 * The min-max spread of a repeat band — **the only aggregate this module
 * offers**. `null` for an empty band; a single point returns `min === max` and
 * the caller must still present it as one observation, not as a result.
 */
export function microRange(values: number[]): { min: number; max: number } | null {
  if (!values.length) return null;
  return { min: Math.min(...values), max: Math.max(...values) };
}

/**
 * A repeat FIRED if it asked for at least one probe. The one bit each repeat
 * really carries — see the bimodality note at the top of this file.
 */
export function microFired(r: Pick<MicroSurveyStats, "needsProbe">): boolean {
  return num(r?.needsProbe) > 0;
}

/**
 * **The headline metric**: the fraction of completed repeats that fired.
 *
 * `null` below one completed repeat — a fire rate over nothing is not zero.
 * Deliberately NOT a mean of `needsProbePct`: those values are bimodal (a repeat
 * marks ~5 rows or none), so their mean describes no observation that ever
 * happened, while this describes exactly what varied.
 */
export function microFireRate(firedRepeats: number, repeatsDone: number): number | null {
  return repeatsDone > 0 ? firedRepeats / repeatsDone : null;
}

/**
 * Below this many completed repeats a fire rate is **not rankable**. It is a
 * count of coin flips: at 3 repeats the difference between 1/3 and 2/3 is one
 * flip. The number is still shown — it is the qualifier that is mandatory, not
 * the suppression.
 */
export const MICRO_RANKABLE_REPEATS = 8;

export function microRankable(repeatsDone: number): boolean {
  return repeatsDone >= MICRO_RANKABLE_REPEATS;
}

/**
 * How long a `live` report may go unwritten before it is presumed dead.
 *
 * The script rewrites its file after every repeat, and a repeat is ~2 minutes,
 * so the heartbeat is refreshed far more often than this — but it is refreshed
 * on the WRITE, not on a timer, so the bound has to clear the gap between two
 * writes of a slow repeat. 90 s is the compromise: long enough that a running
 * replay is never libelled as dead mid-repeat, short enough that a killed script
 * stops reading as progress within one screen-refresh of noticing.
 */
export const MICRO_STALE_HEARTBEAT_MS = 90_000;

/**
 * The three states a report can be in — and the reason this lives here rather
 * than in the dashboard: the index and the UI must not be able to disagree about
 * which one a file is in.
 *
 *  - `complete` — the final write landed (`live` false or absent).
 *  - `running` — `live`, with a fresh heartbeat.
 *  - `interrupted` — `live`, but nobody has written for
 *    {@link MICRO_STALE_HEARTBEAT_MS}. The script died; its `live` flag is stuck
 *    at `true` and will stay that way forever, so **silence must be rendered as
 *    silence**, never as a run still in progress.
 */
export type MicroStatus = "running" | "interrupted" | "complete";

/**
 * {@link MicroStatus} for a report, as of `nowMs`.
 *
 * A `live` report carrying no parsable heartbeat reads as `interrupted`: there
 * is no evidence a writer exists, and the failure mode being designed against is
 * exactly "absence read as progress". A report with no `live` flag at all is
 * `complete` — that is every report written before the script published
 * mid-run, and each of those really was finished when it landed.
 */
export function microStatus(
  r: { live?: boolean | null; heartbeat?: string | null },
  nowMs: number,
): MicroStatus {
  if (r?.live !== true) return "complete";
  const beat = typeof r.heartbeat === "string" ? Date.parse(r.heartbeat) : Number.NaN;
  if (!Number.isFinite(beat)) return "interrupted";
  return nowMs - beat > MICRO_STALE_HEARTBEAT_MS ? "interrupted" : "running";
}

/**
 * The filename stamp back to an ISO instant.
 *
 * The script writes `new Date().toISOString().replace(/[:.]/g, "-")` then
 * `-<label>-<family>`, so the leading 24 characters are a lossless ISO instant
 * with `:` and `.` flattened to `-`. Everything after is a label that may itself
 * contain dashes, hence the anchored prefix match rather than a split.
 */
export function parseMicroStamp(id: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z-/.exec(id);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
}

const num = (x: unknown): number => (typeof x === "number" && Number.isFinite(x) ? x : 0);
/** The optional counterpart of {@link num}: a value that was never recorded
 * stays `null` rather than becoming a measured zero. */
const opt = (x: unknown): number | null =>
  typeof x === "number" && Number.isFinite(x) ? x : null;

/**
 * One parsed file → its index entry, or `null` if it isn't a micro-survey
 * report at all (a stray JSON file in the directory, or one half-written by a
 * run still in flight).
 */
export function summariseMicroReport(
  id: string,
  raw: unknown,
  fallbackIso: string,
): MicroSurveyEntry | null {
  const r = raw as Partial<MicroSurveyReport> | null;
  if (!r || typeof r !== "object" || typeof r.label !== "string" || typeof r.family !== "string") {
    return null;
  }
  const results = Array.isArray(r.results) ? r.results : [];
  const baseline = r.baseline && typeof r.baseline === "object" ? r.baseline : null;
  // `repeatsDone` / `firedRepeats` / `fireRate` are all DERIVABLE from
  // `results[]`, and derived is what we use when the file does not carry them —
  // every report written before the script published mid-run is in that case,
  // and they are perfectly good micro-surveys. The file's own value wins when
  // present, because the script counts against what it launched.
  const repeatsDone = typeof r.repeatsDone === "number" ? r.repeatsDone : results.length;
  const firedRepeats =
    typeof r.firedRepeats === "number" ? r.firedRepeats : results.filter((x) => microFired(x)).length;
  return {
    id,
    report: `/data/micro-survey/${encodeURIComponent(`${id}.json`)}`,
    generatedAt: parseMicroStamp(id) ?? fallbackIso,
    label: r.label,
    family: r.family,
    model: typeof r.model === "string" ? r.model : "—",
    thinking: typeof r.thinking === "string" ? r.thinking : null,
    repeats: typeof r.repeats === "number" ? r.repeats : results.length,
    repeatsDone,
    live: r.live === true,
    heartbeat: typeof r.heartbeat === "string" ? r.heartbeat : null,
    ambientSkills: typeof r.ambientSkills === "boolean" ? r.ambientSkills : null,
    agentsMd: typeof r.agentsMd === "boolean" ? r.agentsMd : null,
    // Recomputed rather than copied: a `fireRate` and the two counts beside it
    // can only ever be read together, so one arithmetic keeps them consistent.
    fireRate: microFireRate(firedRepeats, repeatsDone),
    firedRepeats,
    fixture: typeof r.fixture === "string" ? r.fixture : "",
    baselineNeedsProbePct: baseline ? num(baseline.needsProbePct) : null,
    baselineRows: baseline ? num(baseline.rows) : null,
    needsProbePct: results.map((x) => num(x?.needsProbePct)),
    rows: results.map((x) => num(x?.rows)),
    reassuranceShaped: results.map((x) => num(x?.reassuranceShaped)),
    costUsd: results.reduce((a, x) => a + num(x?.costUsd), 0),
    // `opt`, not `num`: an unmeasured repeat must not land in the band as a
    // zero-second one. It carries `null` all the way to the screen.
    durationSec: results.map((x) => opt(x?.durationSec)),
    turns: results.map((x) => opt(x?.turns)),
    toolCalls: results.map((x) => opt(x?.toolCalls)),
  };
}

// ── latency ─────────────────────────────────────────────────────────────────

/**
 * The caveat that must ride with **every arm-level latency aggregate**, in the
 * list and in the detail view alike. Permanent, not a dismissible hint.
 *
 * Micro-surveys are run `--sandbox none`, in process, and several are routinely
 * launched at once on one host (the model screen ran six side by side). Repeats
 * that overlap contend for CPU, so wall clock is inflated by an amount nothing
 * in the report records — there is no concurrency field to read and none is
 * inferred here, because a guess would be indistinguishable from a measurement.
 * Cost, fire rate, needsProbe% and severity are unaffected: they are counts over
 * what the model produced, not over how long the box took to produce it.
 */
export const MICRO_LATENCY_CAVEAT =
  "Wall clock is only comparable between runs KNOWN to have run serially. Micro-surveys run in-process (--sandbox none) and are often launched several at a time on one host; overlapping repeats contend for CPU and nothing in the report records whether that happened. Cost, fire rate and severity are unaffected.";

/**
 * A per-repeat series that may be partly unmeasured, summarised the only way
 * this module summarises anything: the points, a min–max range, and — for a
 * quantity that ACCUMULATES, like seconds or turns — a total.
 *
 * Deliberately no mean and no SD, for the same reason {@link microRange} offers
 * none: a handful of repeats at temperature 1 supports a spread and nothing
 * finer. And deliberately `null`-preserving: `missing` counts the repeats that
 * were never timed, so a partial band can say so instead of quietly reporting a
 * total over half its repeats as if it were the whole run.
 */
export interface MicroSeries {
  /** The finite points, in repeat order, with the unmeasured repeats dropped. */
  measured: number[];
  /** Repeats carrying no value — absent field, or an explicit `null`. */
  missing: number;
  /** Min–max over {@link measured}; `null` when nothing was measured. */
  range: { min: number; max: number } | null;
  /** Sum over {@link measured}; `null` when nothing was measured — a total of
   * nothing is not zero. */
  total: number | null;
  /** Is there anything to show at all? */
  any: boolean;
}

export function microSeries(values: readonly (number | null | undefined)[] | undefined): MicroSeries {
  const list = Array.isArray(values) ? values : [];
  const measured = list.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  return {
    measured,
    missing: list.length - measured.length,
    range: microRange(measured),
    total: measured.length ? measured.reduce((a, b) => a + b, 0) : null,
    any: measured.length > 0,
  };
}

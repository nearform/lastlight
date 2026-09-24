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
 *
 * And a third, because the first two are both COUNTS: a fire rate of 100% is a
 * pass that asked for a probe on every row, which is as consistent with twelve
 * clean reassurances as with twelve real risks. Neither number says whether a
 * row landed on a real defect, or what it said when it did. So a report may
 * also carry the case's GOLD and, per repeat, what each gold got — see
 * {@link MicroGoldRepeat}. That is the quality view; the fire rate is the cost
 * view, and the two are read together.
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
  /** What this repeat did at each gold defect. Absent on a report run without
   * gold (no `--instances`, or a case with empty gold) and on every report
   * written before the overlay existed — absent is NOT "found nothing". */
  gold?: MicroGoldRepeat;
  /** How this repeat's rows relate to the family's SEEDED obligations. */
  seed?: MicroSeedStats;
  /** Every row, structured: which check it answers and why it probes. The
   * pre-formatted {@link MicroSurveyReport.claims} strings stay for old readers. */
  rowsView?: MicroRowView[];
}

/** Why a row asks for a probe — `lastlight-code-facts`' `probeReasonOf`. */
export type MicroProbeReason = "verify" | "risk" | "gap" | "unknown";

/** One row as the page shows it. */
export interface MicroRowView {
  id: string;
  /** The seeded check this row answers, or `null` for a row of the pass's own. */
  obligation: string | null;
  severity: string | null;
  /** `null` when the row asks for no probe. */
  probe: MicroProbeReason | null;
  /** A clean discharge — the pass says the control holds. Not a claim. */
  reassurance: boolean;
  claim: string;
}

/**
 * The seeded checklist, and what a pass did with it — read off the discharge
 * gate's own ledger (`checkDischarge` in `lastlight-code-facts`), so the eval
 * and the pipeline grade one family's obligations with one function.
 *
 * Without it every other number here floats: a 100% needsProbe over twelve
 * rows is a different result when twelve checks were seeded and all answered
 * than when none were and the pass wrote twelve of its own.
 */
export interface MicroSeedStats {
  /** Obligations the seeder built for this family (after its cap). */
  seeded: number;
  /** Of those, the ones some row points at (its `obligation` back-pointer, or
   * a discharge citation). Not "discharged with a valid code": under the
   * `minimal` contract rows are never asked for one. */
  answered: number;
  /** Seeded checks no row answered — what the pass dropped. */
  skipped: number;
  /** Discharge codes over the answered checks — QUOTE / ABSENT / PARTIAL /
   * PROBE — under the `full` contract; empty under `minimal`, which asks for none. */
  byCode: Record<string, number>;
  /** Rows that answer no seeded check — what the pass found on its own. */
  ownRows: number;
  /** Candidates the seeder dropped for THIS family's cap, before seeding. */
  droppedByCap: number;
  /** Lines the reader could not parse. Non-zero means rows were LOST, not
   * absent. */
  malformed: number;
  /** Rows read although not one object per line (pretty-printed, run
   * together) — nothing lost, but the pass ignored its format. Absent on
   * reports written before the reader recovered them. */
  recovered?: number;
  /** Would the discharge gate pass this file? */
  gateSatisfied: boolean;
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
  /** The case's gold, in the index order every {@link MicroGoldRepeat.cells}
   * array uses. Absent when the run had no gold to grade against. */
  gold?: MicroGoldRef[];
  /** The judge model that decided `asserted`; `null` when the run judged
   * nothing (`--no-judge`), so every verdict is location-only. */
  goldJudge?: string | null;
  /** The gold overlay for the PRESERVED arm's own rows — the comparator for
   * the per-repeat overlays, exactly as {@link baseline} is for needsProbe%. */
  baselineGold?: MicroGoldRepeat;
  /** The seed ledger over the preserved arm's rows. */
  baselineSeed?: MicroSeedStats;
  /** The family's seeded checks, id → question, for labelling rows. */
  checks?: { id: string; question: string }[];
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
  /**
   * The quality view, all `null`/empty on a report that carried no gold.
   *
   * `goldAsserted[i]` is how many gold repeat `i` asserted; `null` for a repeat
   * that was not judged (the judge failed, or `--no-judge`) — its `reached`
   * count is still real, its `asserted` is unknown, and unknown is not zero.
   */
  gold: MicroGoldRef[] | null;
  goldAsserted: (number | null)[];
  /** Gold REACHED but not asserted — the "right lines, opposite verdict" count. */
  goldReached: (number | null)[];
  /** Probe requests on rows at a gold, and elsewhere. Their sum is `needsProbe`. */
  probesOnGold: (number | null)[];
  probesOffGold: (number | null)[];
  /** Per repeat — see {@link microGoldScore}. `null` for an unjudged repeat. */
  goldF1: (number | null)[];
  goldPrecision: (number | null)[];
  goldRecall: (number | null)[];
  /** Per gold, across the completed repeats. Parallel to {@link gold}. */
  perGold: MicroGoldTally[] | null;
  /** What the preserved arm's own rows did at each gold — the comparator. */
  baselineGold: MicroGoldRepeat | null;
  /** Per repeat, the seed ledger; `null` for a repeat that predates it. */
  seed: (MicroSeedStats | null)[];
  /** The same ledger over the preserved arm's rows. */
  baselineSeed: MicroSeedStats | null;
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
  const hasGold = Array.isArray(e?.goldAsserted) && Array.isArray(e?.seed);
  if (hasLive && hasLatency && hasGold) return e;
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
    // An older server knows nothing about gold. Empty series and `null` — the
    // report may well carry gold, but this index cannot say, and a column of
    // zeros would claim the pass hit nothing.
    gold: Array.isArray(e?.gold) ? e.gold : null,
    goldAsserted: Array.isArray(e?.goldAsserted) ? e.goldAsserted : [],
    goldReached: Array.isArray(e?.goldReached) ? e.goldReached : [],
    probesOnGold: Array.isArray(e?.probesOnGold) ? e.probesOnGold : [],
    probesOffGold: Array.isArray(e?.probesOffGold) ? e.probesOffGold : [],
    goldF1: Array.isArray(e?.goldF1) ? e.goldF1 : [],
    goldPrecision: Array.isArray(e?.goldPrecision) ? e.goldPrecision : [],
    goldRecall: Array.isArray(e?.goldRecall) ? e.goldRecall : [],
    perGold: Array.isArray(e?.perGold) ? e.perGold : null,
    baselineGold: e?.baselineGold ?? null,
    seed: Array.isArray(e?.seed) ? e.seed : [],
    baselineSeed: e?.baselineSeed ?? null,
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
    ...microGoldSeries(Array.isArray(r.gold) ? r.gold : null, results),
    baselineGold: r.baselineGold && Array.isArray(r.baselineGold.cells) ? r.baselineGold : null,
    seed: results.map((x) => (x?.seed && typeof x.seed.seeded === "number" ? x.seed : null)),
    baselineSeed: r.baselineSeed && typeof r.baselineSeed.seeded === "number" ? r.baselineSeed : null,
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

// ── gold: the quality view ───────────────────────────────────────────────────

/**
 * How far from a gold's anchor line a row may cite and still count as having
 * REACHED it. The anchor is where the human left the comment, which is often
 * not the line a survey row names (the constant's declaration, the other end of
 * a comparison) — so it is a window, and a generous one. It only ever gates the
 * `reached` verdict; `asserted` is the judge's, and does not read lines at all.
 */
export const MICRO_GOLD_LINE_WINDOW = 15;

/** One gold defect, as a report records it — enough to label it on screen. */
export interface MicroGoldRef {
  file?: string;
  line?: number;
  severity: string;
  /** The gold description's opening, whitespace-collapsed and capped. */
  summary: string;
}

/**
 * What one repeat did at one gold.
 *
 *  - `asserted` — a row states that the gold's defect is WRONG. Decided by the
 *    internal-recall judge (MATCH, then CONFIRM per pair), which treats a
 *    verification report at the right location as a non-match — so this is
 *    the verdict, not the location.
 *  - `reached` — no row asserted it, but at least one cited the gold's file
 *    within {@link MICRO_GOLD_LINE_WINDOW} lines. **The failure this eval was
 *    built for**: right lines, opposite verdict. Deterministic, free.
 *  - `missed` — no row went near it.
 */
export type MicroGoldVerdict = "asserted" | "reached" | "missed";

export interface MicroGoldCell {
  verdict: MicroGoldVerdict;
  /** Row ids behind the verdict: the asserting row, else every row in reach. */
  rows: string[];
  /** Did any of those rows ask for a probe (derived verdict)? At a `reached`
   * gold this is the backstop: the pass said "fine" and the probe may yet
   * disagree. */
  probed: boolean;
}

export interface MicroGoldRepeat {
  /** Parallel to the report's `gold`. */
  cells: MicroGoldCell[];
  /** `null` when the judge did not run — then no cell is `asserted`, every
   * verdict is location-only, and the count is unknown rather than zero. */
  asserted: number | null;
  reached: number;
  /** Probe requests on rows at ANY gold (asserting or reaching), and on rows at
   * none. Every probe is one or the other, so the two sum to `needsProbe`. */
  probesOnGold: number;
  probesOffGold: number;
  /** Rows that CLAIM a defect — derived severity Important or Critical, i.e. the
   * row recorded a consequence. The precision denominator. Absent on overlays
   * written before the score existed. */
  claimed?: number;
  /** Of {@link claimed}, the rows the judge credited to a gold. */
  claimedAsserting?: number;
  /** How many judge passes decided `asserted` (majority vote). Absent = 1. */
  votes?: number;
  /** Per gold, how many of those passes credited it — a 2-of-3 is a
   * borderline call, and worth seeing as one. */
  creditVotes?: number[];
  /** The judge failed; see {@link asserted}. */
  judgeError?: string;
  /** MATCH ran and CONFIRM did not — `asserted` then carries MATCH's raw
   * credits, which the 2026-09-21 audit measured about a third high. */
  confirmUngraded?: string;
}

/** Per gold, across the completed repeats of one run. */
export interface MicroGoldTally {
  asserted: number;
  reached: number;
  missed: number;
  /** Repeats where a row at this gold (asserting or reaching) asked for a probe. */
  probedAtGold: number;
  /** Repeats that carried a verdict for this gold at all. */
  repeats: number;
  /** Of {@link repeats}, how many were JUDGED — the denominator for `asserted`. */
  judged: number;
}

/** The minimal row shape the gold overlay reads — a survey hypotheses row. */
export interface MicroRowLike {
  id?: string;
  quotes?: { path?: string; line?: number }[] | null;
  bothEnds?: Record<string, unknown> | null;
  evidence?: { control_site?: unknown } | null;
}

const SITE = /^(.+?):(\d+)(?:-\d+)?$/;

/** Every `path:line` a row cites: its quotes, its `bothEnds`, its control site. */
export function microRowSites(row: MicroRowLike): { path: string; line: number | null }[] {
  const out: { path: string; line: number | null }[] = [];
  for (const q of row?.quotes ?? []) {
    if (typeof q?.path === "string" && q.path) out.push({ path: q.path, line: typeof q.line === "number" ? q.line : null });
  }
  const refs = [...Object.values(row?.bothEnds ?? {}), row?.evidence?.control_site];
  for (const v of refs) {
    if (typeof v !== "string") continue;
    const m = SITE.exec(v.trim());
    if (m) out.push({ path: m[1], line: Number(m[2]) });
  }
  return out;
}

/** Same file, compared by path SUFFIX: gold records repo-relative paths, rows
 * sometimes carry a leading `./` or a deeper prefix. */
function samePath(a: string, b: string): boolean {
  const x = a.replace(/^\.?\//, ""), y = b.replace(/^\.?\//, "");
  return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`);
}

/**
 * Does this row stand at this gold? A gold with no file cannot be reached by
 * location (Martian-style gold is description-only) — only asserted. A gold
 * with a file but no line is reached by any citation of the file.
 */
export function microRowReachesGold(
  row: MicroRowLike,
  gold: Pick<MicroGoldRef, "file" | "line">,
  window = MICRO_GOLD_LINE_WINDOW,
): boolean {
  if (!gold?.file) return false;
  return microRowSites(row).some(
    (s) =>
      samePath(s.path, gold.file as string) &&
      (typeof gold.line !== "number" || (s.line !== null && Math.abs(s.line - gold.line) <= window)),
  );
}

/**
 * One repeat's gold overlay.
 *
 * `rowForGold[j]` is the index of the row the judge credited for gold `j`, or
 * `null`; pass `rowForGold: null` when the judge did not run, and nothing is
 * `asserted`. `probeOf` is injected rather than imported: the derivation lives
 * in `lastlight-code-facts`, which this browser-safe module must not pull in.
 */
export function microGoldRepeat<R extends MicroRowLike>(opts: {
  rows: R[];
  gold: Pick<MicroGoldRef, "file" | "line">[];
  rowForGold: (number | null)[] | null;
  probeOf: (row: R) => boolean;
  /** Does the row claim a defect? Supplied, it adds the precision counts. */
  claimOf?: (row: R) => boolean;
  window?: number;
}): Omit<MicroGoldRepeat, "judgeError" | "confirmUngraded"> {
  const { rows, gold, rowForGold, probeOf, claimOf } = opts;
  const onGold = new Set<number>();
  const cells: MicroGoldCell[] = gold.map((g, j) => {
    const credited = rowForGold?.[j];
    const reaching = rows.flatMap((r, i) => (microRowReachesGold(r, g, opts.window) ? [i] : []));
    for (const i of reaching) onGold.add(i);
    const idOf = (i: number) => rows[i]?.id ?? `row-${i}`;
    if (typeof credited === "number" && rows[credited]) {
      onGold.add(credited);
      return { verdict: "asserted", rows: [idOf(credited)], probed: probeOf(rows[credited]) };
    }
    if (reaching.length) {
      return { verdict: "reached", rows: reaching.map(idOf), probed: reaching.some((i) => probeOf(rows[i])) };
    }
    return { verdict: "missed", rows: [], probed: false };
  });
  let probesOnGold = 0, probesOffGold = 0;
  rows.forEach((r, i) => {
    if (!probeOf(r)) return;
    if (onGold.has(i)) probesOnGold++;
    else probesOffGold++;
  });
  const credited = new Set((rowForGold ?? []).filter((i): i is number => typeof i === "number" && !!rows[i]));
  // A row the judge credited IS a claim, whatever its evidence shape: CONFIRM
  // only credits a row that states the defect (one that states it and then
  // calls it handled still counts — see `INTERNAL_CONFIRM_SYSTEM`). Leaving such
  // a row out of the claims scored recall > 0 against precision 0, i.e. F1 0
  // for a repeat that found a gold (measured: GLM 5.3 Flash, 1667 repeat 2).
  const claims = claimOf ? new Set([...rows.flatMap((r, i) => (claimOf(r) ? [i] : [])), ...credited]) : null;
  return {
    cells,
    ...(claims ? { claimed: claims.size, claimedAsserting: [...claims].filter((i) => credited.has(i)).length } : {}),
    asserted: rowForGold === null ? null : cells.filter((c) => c.verdict === "asserted").length,
    reached: cells.filter((c) => c.verdict === "reached").length,
    probesOnGold,
    probesOffGold,
  };
}

/**
 * An F1 for one repeat, shaped like the full eval's posted F1 so the two read
 * alike:
 *
 *  - **recall** = gold asserted ÷ ALL the case's gold. The gold spans every
 *    family, so one family's recall has a ceiling below 1 — comparable between
 *    runs on the same fixture and family, never an absolute score.
 *  - **precision** = rows that CLAIM a defect and were credited to a gold ÷ all
 *    rows that claim a defect. A reassurance row is not a claim and does not
 *    count against it; a row claiming a defect the gold does not hold does —
 *    exactly as a posted comment the gold lacks is a false positive there.
 *
 * `null` when the repeat was not judged, or its overlay predates the claim
 * counts. A repeat that claims nothing scores precision 0, as a review that
 * posts nothing does.
 */
export function microGoldScore(
  o: MicroGoldRepeat | null | undefined,
  goldCount: number,
): { precision: number; recall: number; f1: number } | null {
  if (!o || o.asserted === null || typeof o.claimed !== "number" || goldCount <= 0) return null;
  const recall = o.asserted / goldCount;
  const precision = o.claimed > 0 ? (o.claimedAsserting ?? 0) / o.claimed : 0;
  const f1 = precision + recall > 0 ? (2 * precision * recall) / (precision + recall) : 0;
  return { precision, recall, f1 };
}

/** The index-entry fields derived from a report's gold + per-repeat overlays. */
export function microGoldSeries(
  gold: MicroGoldRef[] | null,
  results: { gold?: MicroGoldRepeat }[],
): Pick<
  MicroSurveyEntry,
  "gold" | "goldAsserted" | "goldReached" | "probesOnGold" | "probesOffGold" | "perGold" | "goldF1" | "goldPrecision" | "goldRecall"
> {
  if (!gold?.length) {
    return {
      gold: null, goldAsserted: [], goldReached: [], probesOnGold: [], probesOffGold: [], perGold: null,
      goldF1: [], goldPrecision: [], goldRecall: [],
    };
  }
  const overlays = results.map((r) => (r?.gold && Array.isArray(r.gold.cells) ? r.gold : null));
  const perGold: MicroGoldTally[] = gold.map((_, j) => {
    const t: MicroGoldTally = { asserted: 0, reached: 0, missed: 0, probedAtGold: 0, repeats: 0, judged: 0 };
    for (const o of overlays) {
      const c = o?.cells[j];
      if (!o || !c) continue;
      t.repeats++;
      if (o.asserted !== null) t.judged++;
      t[c.verdict]++;
      if (c.probed) t.probedAtGold++;
    }
    return t;
  });
  const scores = overlays.map((o) => microGoldScore(o, gold.length));
  return {
    gold,
    goldAsserted: overlays.map((o) => (o ? o.asserted : null)),
    goldReached: overlays.map((o) => (o ? o.reached : null)),
    probesOnGold: overlays.map((o) => (o ? o.probesOnGold : null)),
    probesOffGold: overlays.map((o) => (o ? o.probesOffGold : null)),
    goldF1: scores.map((x) => x?.f1 ?? null),
    goldPrecision: scores.map((x) => x?.precision ?? null),
    goldRecall: scores.map((x) => x?.recall ?? null),
    perGold,
  };
}

/**
 * Majority vote over several judge passes' `goldToFinding` arrays.
 *
 * The judge runs at temperature 0 and still flips on a borderline pair —
 * measured: the same preserved rows judged five times came back 0/4 three
 * times and 1/4 twice. A gold is credited when MORE THAN HALF the passes
 * credited it, to the row most of them named (ties to the lower index, so the
 * result does not depend on pass order).
 */
export function microGoldVote(passes: (number | null)[][], goldCount: number): {
  rowForGold: (number | null)[];
  creditVotes: number[];
} {
  const rowForGold: (number | null)[] = [];
  const creditVotes: number[] = [];
  for (let j = 0; j < goldCount; j++) {
    const byRow = new Map<number, number>();
    for (const p of passes) {
      const r = p[j];
      if (typeof r === "number") byRow.set(r, (byRow.get(r) ?? 0) + 1);
    }
    const credited = [...byRow.values()].reduce((a, b) => a + b, 0);
    creditVotes.push(credited);
    if (credited * 2 <= passes.length) {
      rowForGold.push(null);
      continue;
    }
    const [row] = [...byRow.entries()].sort((a, b) => b[1] - a[1] || a[0] - b[0])[0];
    rowForGold.push(row);
  }
  return { rowForGold, creditVotes };
}

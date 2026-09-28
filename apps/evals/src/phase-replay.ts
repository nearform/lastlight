/**
 * Phase replays — ONE pr-review phase (`falsify`, `adjudicate`, or the
 * experimental per-site investigator `site-review`) re-run
 * against preserved fixtures, in minutes rather than a full arm's hours.
 *
 * `scripts/micro-falsify.ts` and `scripts/micro-adjudicate.ts` write these
 * reports to `eval-results/phase-replay/*.json`; `/api/phase-replay` lists them
 * and the dashboard's `phase-replay` page renders them. This module is the ONE
 * definition of the report shape and of every number derived from it, and it
 * is **node-free** (like `micro-survey.ts` / `unit-survey-index.ts`) so the fs
 * scan and the browser cannot disagree about a figure.
 *
 * Why these two phases and why replay: measured on the first unit-survey arm
 * (2026-09-27), adjudicate on Sonnet 4.6 spent 8.7 minutes writing ~29k output
 * tokens for 52 rows and was still inside one turn at 12 minutes on 173, while
 * falsify was shown one owed row of 21 (the prompt keyed on a field the rows
 * never carry). Both are questions about ONE phase over a FIXED input — the
 * checkout, the hypotheses, the probe verdicts — so replaying that input holds
 * the upstream variance still and measures the phase alone.
 *
 * Absent is not zero, everywhere below: an unjudged grade is `null`, never a
 * zero recall; an audit (no model) has no cost rather than a free run.
 */
import { unitSurveyStatus, type UnitSurveyStatus } from "./unit-survey-index.js";

export const PHASE_REPLAY_DIR = "phase-replay";
export const PHASE_REPLAY_VERSION = 1;

export type PhaseKind = "falsify" | "adjudicate" | "site-review";
export type PhaseReplayWriteStatus = "running" | "done" | "failed";
export type PhaseReplayStatus = UnitSurveyStatus;

/** What was replayed, and with what — every knob an arm can turn. */
export interface PhaseReplayConfig {
  model: string;
  thinking: string | null;
  /** The prompt template actually rendered (core's, or an override). */
  prompt: string;
  promptSha256: string;
  promptOverride: boolean;
  /** Skill dir staged for the phase, or `null` (falsify runs with none). */
  skill: string | null;
  skillOverride: boolean;
  /** Gate-loop iterations allowed (the workflow's `max_iterations`). */
  rounds: number;
  /** falsify: `probe-plan --max-probes`; `null` = no cap. */
  maxProbes?: number | null;
  /** falsify: `rows` (probe-plan's list, one session) or `sites:<k>` (one session per site). Absent = `rows`. */
  plan?: string;
  /** falsify `sites:<k>`: the site window (lines). */
  window?: number;
  /** adjudicate: `admit --rules` spec, normalised. */
  rules?: string;
  /** site-review: `none` (arm A, the brief alone), `subjects` (arm B, deduplicated `evidence.subject` leads) or `summary` (arm C, ≤ 5 summarised concerns per site). */
  leads?: string;
  /** site-review `summary`: the model of the one non-agentic summary call per site. */
  summaryModel?: string;
  /** site-review `summary`: the summary prompt's sha256. */
  summaryPromptSha256?: string;
  /** site-review: `--summaries-only` — selection + summary calls, no investigator (the report is audit-like). */
  summariesOnly?: boolean;
  /** site-review: sites investigated per case. */
  topSites?: number;
  /** site-review: `clusterSites`' `maxSpan` (`null` = unbounded). */
  maxSpan?: number | null;
  /** site-review: the ranking vote (`unit` | `row`). */
  voters?: string;
  /** site-review: test files left out of site ranking (`isTestPath`). */
  skipTests?: boolean;
  /** The judge used for the gold map and the grade; `null` = location only. */
  judgeModel: string | null;
}

/** One gold comment, as the report carries it (summary trimmed). */
export interface PhaseReplayGold {
  file?: string;
  line?: number;
  severity: string;
  summary: string;
}

/** What `falsify` did, over the rows `probe-plan` selected. */
export interface FalsifyOutcome {
  owed: number;
  selected: number;
  deferred: number;
  /** Verdict counts over the SELECTED rows (`none` = no verdict written). */
  verdicts: Record<string, number>;
  gateSatisfied: boolean;
  gaps: number;
  /** Gold-mapped rows (see {@link PhaseReplayCase.goldRows}) that were selected. */
  goldSelected: string[];
  /** Gold-mapped rows falsify REFUTED — the one outcome that loses recall. */
  goldRefuted: string[];
  goldReproduced: string[];
  /** `--plan sites:<k>` only: one falsify session per site. */
  sites?: FalsifySite[];
}

/** One site's falsify session under `--plan sites:<k>`. */
export interface FalsifySite {
  id: string;
  /** `support` = a top site; `owed` = a row probe-plan owes that no top site holds. */
  origin: "support" | "owed";
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  rows: number;
  /** Gold-mapped rows in this site. */
  gold: string[];
  ok: boolean;
  error: string | null;
  /** `null` in an audit. */
  wallMs: number | null;
  costUsd: number | null;
  turns: number | null;
  outputTokens: number | null;
  gateSatisfied: boolean | null;
  /** Verdict counts over this site's rows (`none` = no verdict written). */
  verdicts: Record<string, number>;
  /** Distinct `claim` labels the session wrote; `null` = it wrote none. */
  claims: number | null;
  /** The gate's gaps after each round, by kind — why a round 2 happened. */
  gapsByRound?: Record<string, number>[];
  /** The gate's own notes after the last round (first few). */
  gateNotes?: string[];
  session: string | null;
}

/**
 * One finding a site investigator wrote, as the report carries it. `gold` is
 * the index into the case's `gold` the judge matched it to (majority of the
 * votes), `null` = matched none, and absent = not judged.
 */
export interface SiteReviewFinding {
  site: string;
  path: string;
  line: number;
  title: string;
  strength: string;
  /** Lead numbers (1-based, as the brief lists them) the finding says it used. */
  leads: number[];
  gold?: number | null;
}

/**
 * Arm C's per-site summary: the site's rows MERGED into concerns by one
 * non-agentic call, validated in code (`src/site-summary.ts`). Every row sits
 * in exactly one concern; rows the reply left out are the synthetic
 * `unmerged` concern and are listed in `uncovered`.
 */
export interface SiteReviewSummary {
  model: string;
  /** `specific` = the row whose mechanism is most specific (its subject is shown in the brief). */
  concerns: { concern: string; line: number | null; rows: string[]; specific: string | null; unmerged?: boolean }[];
  uncovered: string[];
  /** The site's cap: min(8, max(2, ⌈rows / 2⌉)). */
  maxConcerns: number;
  /** Both attempts were malformed: the brief fell back to arm B's subject leads. */
  fallback: boolean;
  attempts: number;
  /** Every reply read came from the on-disk cache (no spend this run). */
  cached: boolean;
  inputTokens: number;
  outputTokens: number;
  /** What the replies cost to produce, cached or not; `null` for an unpriced model. */
  costUsd: number | null;
  /** Why each rejected attempt was rejected. */
  errors: string[];
}

/** One site's investigator session. */
export interface SiteReviewSite {
  id: string;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  /** Hypothesis rows in the site — volume, never the investigator's input. */
  rows: number;
  /** Distinct voters (units, split siblings collapsed; rows under `--voters row`). */
  voters: number;
  /** Leads the brief listed (0 in arm A; the concern count in arm C). */
  leads: number;
  /** Gold-mapped rows inside this site. */
  gold: string[];
  /** Arm C only. */
  summary?: SiteReviewSummary;
  ok: boolean;
  error: string | null;
  /** `null` in an audit. */
  wallMs: number | null;
  costUsd: number | null;
  turns: number | null;
  outputTokens: number | null;
  gateSatisfied: boolean | null;
  /** The gate's gaps after each round, by kind. Round 2's prompt carried round 1's gaps. */
  gapsByRound?: Record<string, number>[];
  gateNotes?: string[];
  /** Findings written (0 with `none`); `null` in an audit. */
  findings: number | null;
  /** The investigator wrote the single `{"none": true}` line. `null` in an audit. */
  none: boolean | null;
  session: string | null;
}

/** What the per-site investigators found, over the top-k sites. */
export interface SiteReviewOutcome {
  /** Sites `clusterSites` formed (before the top-k cut). */
  sitesFormed: number;
  /** Rows `skipPath` kept out of ranking (test files). */
  skippedRows: number;
  sites: SiteReviewSite[];
  /** Gold-mapped rows inside the selected sites (the audit's number). */
  goldInSites: string[];
  /** Every finding written, across sites. Empty in an audit. */
  findings: SiteReviewFinding[];
  /** Gold indices some finding states (judged). `null` = not judged (audit, `--no-judge`, judge failure). */
  goldStated: number[] | null;
  /** Findings the judge matched to a gold; `null` when not judged. */
  matchedFindings: number | null;
  /** The judge failed — why. */
  judgeError?: string | null;
}

/** A judged grade of the PROMOTED findings (every tier but `internal`). */
export interface PhaseReplayGrade {
  precision: number;
  recall: number;
  f1: number;
  matched: number;
  posted: number;
  gold: number;
  error: string | null;
}

/** What `adjudicate` did, after `admit` and before posting. */
export interface AdjudicateOutcome {
  admitted: number;
  filed: number;
  filedByRule: Record<string, number>;
  /** Gold-mapped rows `admit` filed before the model saw them — a rule's cost. */
  goldFiled: string[];
  promotedInline: number;
  promotedBody: number;
  internal: number;
  dropped: number;
  gateSatisfied: boolean;
  /** Gold whose mapped row ended up cited by a PROMOTED finding. Deterministic. */
  goldPromoted: number | null;
  /** `null` in an audit (no model ran) or with no judge. */
  grade: PhaseReplayGrade | null;
}

/** One fixture × one repeat. */
export interface PhaseReplayCase {
  instanceId: string;
  /** The fixture's parent directory name (`arm1`, `arm2`, …). */
  arm: string;
  fixture: string;
  repeat: number;
  ok: boolean;
  error: string | null;
  /** `null` in an audit — no model ran, which is not a free, instant run. */
  wallMs: number | null;
  costUsd: number | null;
  turns: number | null;
  outputTokens: number | null;
  /** Gate-loop iterations actually used. */
  iterations: number | null;
  /** Hypothesis rows in the fixture. */
  rows: number;
  gold: PhaseReplayGold[];
  /** Per gold: the hypothesis id the judge matched it to, or `null` (none);
   * the whole array is `null` when the map was not judged. */
  goldRows: (string | null)[] | null;
  falsify?: FalsifyOutcome;
  adjudicate?: AdjudicateOutcome;
  siteReview?: SiteReviewOutcome;
  /** The case's consolidated session transcript (`/data/phase-replay/sessions/…/full.jsonl`). */
  session?: string | null;
}

/** A case still running — listed so its transcript can be followed live. */
export interface PhaseReplayInFlight {
  instanceId: string;
  arm: string;
  repeat: number;
  /** `--plan sites:<k>`: the site this session is — one entry per running site. */
  site?: string;
  startedAt: string;
  session: string;
}

export interface PhaseReplayPlanned {
  instanceId: string;
  arm: string;
  fixture: string;
  repeat: number;
}

export interface PhaseReplayReport {
  version: typeof PHASE_REPLAY_VERSION;
  kind: PhaseKind;
  label: string;
  /** No model ran: deterministic stats only (adjudicate `--audit`, a dry run). */
  audit: boolean;
  startedAt: string;
  finishedAt: string | null;
  status: PhaseReplayWriteStatus;
  heartbeat: string | null;
  error: string | null;
  config: PhaseReplayConfig;
  planned: PhaseReplayPlanned[];
  cases: PhaseReplayCase[];
  /** Cases in progress right now, each with its live transcript. */
  inFlight?: PhaseReplayInFlight[];
}

/** A range over repeats/cases — never a mean alone (see micro-survey). */
export interface PhaseRange {
  min: number;
  max: number;
  mean: number;
  n: number;
}

export function phaseRange(values: (number | null | undefined)[]): PhaseRange | null {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (!xs.length) return null;
  return { min: Math.min(...xs), max: Math.max(...xs), mean: xs.reduce((a, b) => a + b, 0) / xs.length, n: xs.length };
}

export function phaseMedian(values: (number | null | undefined)[]): number | null {
  const xs = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v)).sort((a, b) => a - b);
  if (!xs.length) return null;
  const mid = Math.floor(xs.length / 2);
  return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
}

/** The roll-up the list page shows, recomputed from the cases. */
export interface PhaseReplayTotals {
  cases: number;
  errored: number;
  /** `null` in an audit. */
  costUsd: number | null;
  wallMedianMs: number | null;
  wallMaxMs: number | null;
  outputTokens: number | null;
  rows: number;
  gold: number;
  falsify?: {
    owed: number;
    selected: number;
    answered: number;
    verdicts: Record<string, number>;
    /** `null` when any case's gold map was not judged — unknown, not zero. */
    goldSelected: number | null;
    goldRefuted: number | null;
    goldReproduced: number | null;
    gateFailures: number;
    /** `--plan sites:<k>`: sessions run, and distinct claims they named. */
    sites: number | null;
    claims: number | null;
  };
  adjudicate?: {
    admitted: number;
    filed: number;
    filedByRule: Record<string, number>;
    /** `null` when any case's gold map was not judged — unknown, not zero. */
    goldFiled: number | null;
    promoted: number;
    goldPromoted: number | null;
    f1: PhaseRange | null;
    precision: PhaseRange | null;
    recall: PhaseRange | null;
    gateFailures: number;
  };
  siteReview?: {
    /** Sites investigated (selected). */
    sites: number;
    rowsInSites: number;
    leads: number;
    /** `null` when any case's gold map was not judged. */
    goldInSites: number | null;
    /** `null` in an audit. */
    findings: number | null;
    /** Sites that wrote the `none` line; `null` in an audit. */
    noneSites: number | null;
    /** Distinct gold stated, summed over cases; `null` when any case was unjudged. */
    goldStated: number | null;
    matchedFindings: number | null;
    /** Pooled: matched findings ÷ findings; `null` unjudged or no findings. */
    precision: number | null;
    /** Sites whose gate was unsatisfied after the last round. */
    gateFailures: number;
    /** Sites that needed a second round. */
    secondRounds: number;
    /** Arm C: the summary calls, over the sites that carry one; absent otherwise. */
    summary?: {
      sites: number;
      concerns: number;
      uncovered: number;
      fallbacks: number;
      /** `null` when any site's model is unpriced. */
      costUsd: number | null;
    };
  };
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);

function mergeCounts(into: Record<string, number>, from: Record<string, number>): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

export function phaseReplayTotals(report: Pick<PhaseReplayReport, "kind" | "audit" | "cases">): PhaseReplayTotals {
  const all = report.cases ?? [];
  const ok = all.filter((c) => c.ok);
  const totals: PhaseReplayTotals = {
    cases: all.length,
    errored: all.length - ok.length,
    costUsd: report.audit ? null : sum(ok.map((c) => c.costUsd ?? 0)),
    wallMedianMs: report.audit ? null : phaseMedian(ok.map((c) => c.wallMs)),
    wallMaxMs: report.audit ? null : (phaseRange(ok.map((c) => c.wallMs))?.max ?? null),
    outputTokens: report.audit ? null : sum(ok.map((c) => c.outputTokens ?? 0)),
    rows: sum(ok.map((c) => c.rows)),
    gold: sum(ok.map((c) => c.gold.length)),
  };
  // A case with gold but no judged map cannot say which rows were gold, so any
  // gold count over it is unknown — never a measured zero.
  const goldKnown = ok.every((c) => c.goldRows !== null || c.gold.length === 0);
  if (report.kind === "falsify") {
    const verdicts: Record<string, number> = {};
    for (const c of ok) if (c.falsify) mergeCounts(verdicts, c.falsify.verdicts);
    const f = ok.map((c) => c.falsify).filter((x): x is FalsifyOutcome => !!x);
    totals.falsify = {
      owed: sum(f.map((x) => x.owed)),
      selected: sum(f.map((x) => x.selected)),
      answered: sum(f.map((x) => x.selected - (x.verdicts.none ?? 0))),
      verdicts,
      goldSelected: goldKnown ? sum(f.map((x) => x.goldSelected.length)) : null,
      goldRefuted: goldKnown ? sum(f.map((x) => x.goldRefuted.length)) : null,
      goldReproduced: goldKnown ? sum(f.map((x) => x.goldReproduced.length)) : null,
      gateFailures: f.filter((x) => !x.gateSatisfied).length,
      sites: f.some((x) => x.sites) ? sum(f.map((x) => x.sites?.length ?? 0)) : null,
      claims: f.some((x) => x.sites?.some((s) => s.claims !== null))
        ? sum(f.flatMap((x) => (x.sites ?? []).map((s) => s.claims ?? 0)))
        : null,
    };
  } else if (report.kind === "site-review") {
    const r = ok.map((c) => c.siteReview).filter((x): x is SiteReviewOutcome => !!x);
    const sites = r.flatMap((x) => x.sites);
    const judged = !report.audit && r.length > 0 && r.every((x) => x.goldStated !== null && x.matchedFindings !== null);
    const findings = sum(r.map((x) => x.findings.length));
    const matched = judged ? sum(r.map((x) => x.matchedFindings ?? 0)) : null;
    totals.siteReview = {
      sites: sites.length,
      rowsInSites: sum(sites.map((s) => s.rows)),
      leads: sum(sites.map((s) => s.leads)),
      goldInSites: goldKnown ? sum(r.map((x) => x.goldInSites.length)) : null,
      findings: report.audit ? null : findings,
      noneSites: report.audit ? null : sites.filter((s) => s.none === true).length,
      goldStated: judged ? sum(r.map((x) => x.goldStated!.length)) : null,
      matchedFindings: matched,
      precision: matched !== null && findings > 0 ? matched / findings : null,
      gateFailures: sites.filter((s) => s.gateSatisfied === false).length,
      secondRounds: sites.filter((s) => (s.gapsByRound?.length ?? 0) > 1).length,
    };
    const summaries = sites.map((s) => s.summary).filter((x): x is SiteReviewSummary => !!x);
    if (summaries.length)
      totals.siteReview.summary = {
        sites: summaries.length,
        concerns: sum(summaries.map((x) => x.concerns.length)),
        uncovered: sum(summaries.map((x) => x.uncovered.length)),
        fallbacks: summaries.filter((x) => x.fallback).length,
        costUsd: summaries.every((x) => x.costUsd !== null) ? sum(summaries.map((x) => x.costUsd!)) : null,
      };
  } else {
    const a = ok.map((c) => c.adjudicate).filter((x): x is AdjudicateOutcome => !!x);
    const filedByRule: Record<string, number> = {};
    for (const x of a) mergeCounts(filedByRule, x.filedByRule);
    const graded = a.map((x) => x.grade).filter((g): g is PhaseReplayGrade => !!g && g.error === null);
    const promotedKnown = a.every((x) => x.goldPromoted !== null);
    totals.adjudicate = {
      admitted: sum(a.map((x) => x.admitted)),
      filed: sum(a.map((x) => x.filed)),
      filedByRule,
      goldFiled: goldKnown ? sum(a.map((x) => x.goldFiled.length)) : null,
      promoted: sum(a.map((x) => x.promotedInline + x.promotedBody)),
      goldPromoted: a.length && promotedKnown ? sum(a.map((x) => x.goldPromoted ?? 0)) : null,
      f1: phaseRange(graded.map((g) => g.f1)),
      precision: phaseRange(graded.map((g) => g.precision)),
      recall: phaseRange(graded.map((g) => g.recall)),
      gateFailures: a.filter((x) => !x.gateSatisfied).length,
    };
  }
  return totals;
}

/** One report as `/api/phase-replay` lists it. */
export interface PhaseReplayEntry {
  id: string;
  /** `/data/phase-replay/<id>.json`, for the detail page. */
  report: string;
  kind: PhaseKind;
  label: string;
  audit: boolean;
  generatedAt: string;
  finishedAt: string | null;
  status: PhaseReplayWriteStatus;
  heartbeat: string | null;
  error: string | null;
  planned: number;
  config: PhaseReplayConfig;
  totals: PhaseReplayTotals;
}

export interface PhaseReplayIndex {
  generatedAt: string;
  reports: PhaseReplayEntry[];
}

/** `running` / `done` / `failed` / `stale` — the unit-survey rule, shared. */
export function phaseReplayStatus(
  r: { status?: PhaseReplayWriteStatus | string | null; heartbeat?: string | null },
  nowMs: number,
): PhaseReplayStatus {
  return unitSurveyStatus(r, nowMs);
}

/**
 * Summarise one raw report file for the index, or `null` when it is not a
 * phase-replay report (a stray JSON file, a different version). Tolerant of a
 * report still being written — `cases` may be short of `planned`.
 */
export function summarisePhaseReplay(id: string, raw: unknown, mtime: string): PhaseReplayEntry | null {
  const r = raw as Partial<PhaseReplayReport> | null;
  if (!r || typeof r !== "object" || r.version !== PHASE_REPLAY_VERSION) return null;
  if (r.kind !== "falsify" && r.kind !== "adjudicate" && r.kind !== "site-review") return null;
  if (!r.config || !Array.isArray(r.cases)) return null;
  return {
    id,
    report: `/data/${PHASE_REPLAY_DIR}/${id}.json`,
    kind: r.kind,
    label: typeof r.label === "string" ? r.label : id,
    audit: r.audit === true,
    generatedAt: typeof r.startedAt === "string" ? r.startedAt : mtime,
    finishedAt: typeof r.finishedAt === "string" ? r.finishedAt : null,
    status: r.status === "running" || r.status === "failed" ? r.status : "done",
    heartbeat: typeof r.heartbeat === "string" ? r.heartbeat : null,
    error: typeof r.error === "string" ? r.error : null,
    planned: Array.isArray(r.planned) ? r.planned.length : r.cases.length,
    config: r.config,
    totals: phaseReplayTotals({ kind: r.kind, audit: r.audit === true, cases: r.cases }),
  };
}

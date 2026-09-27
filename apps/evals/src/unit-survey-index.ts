/**
 * The unit-survey index — what `/api/unit-survey` lists, and the per-case view
 * the dashboard's detail page renders — derived from the reports
 * `scripts/unit-survey-replay.ts` writes to `eval-results/unit-survey/*.json`.
 *
 * **Node-free**, like `micro-survey.ts`: the fs scan (`buildUnitSurveyIndex` in
 * `report.ts`) and the browser share this one definition, so the list and the
 * detail page cannot disagree about a number. The report SHAPE is imported
 * type-only from `unit-survey-replay.ts` (which is Node-side — it reads
 * transcripts — so it is never imported at runtime here).
 *
 * One rule every function below keeps: **absent is not zero.** A stage-1 report
 * has no model side at all; a case whose judge failed has `asserted: null`; a
 * fixture whose transcripts carried no `survey_branch_*` result lines has no
 * agent wall clock and no agent cost (its `costUsd: 0` is a sum over nothing).
 * Each of those is `null` here and renders "n/a" — a 0 would read as a measured
 * zero recall or a free, instant survey.
 */
import type { MicroGoldRef, MicroGoldRepeat } from "./micro-survey.js";
import type { ReplayCase, ReplayModelRun, ReplayReport } from "./unit-survey-replay.js";

export type { ReplayCase, ReplayModelRun, ReplayReport } from "./unit-survey-replay.js";

/** The directory `scripts/unit-survey-replay.ts` writes into, under
 * `eval-results/`. Loose report files plus a `responses/` subdirectory of kept
 * raw unit replies — which is not a report and must never be listed as one. */
export const UNIT_SURVEY_DIR = "unit-survey";

/** The stage-2 roll-up of one report, recomputed from its cases. */
export interface UnitSurveyModelTotals {
  /** Cases with a model run that did not error. */
  cases: number;
  gold: number;
  /** Judge-credited gold (`asserted`), summed. `null` if ANY case's side was unjudged. */
  unitsAsserted: number | null;
  agentAsserted: number | null;
  onlyUnits: number;
  onlyAgent: number;
  unitsCostUsd: number;
  /** `null` when any case's fixture recorded no agent survey branches. */
  agentCostUsd: number | null;
  unitsWallMs: number;
  agentWallMs: number | null;
  /** Distinct unit-survey models / judge models / judge vote counts seen. */
  models: string[];
  judgeModels: (string | null)[];
  votes: number[];
}

/** One report as the index lists it. */
export interface UnitSurveyEntry {
  /** Filename without `.json`; the id in the URL. */
  id: string;
  /** Where the full report is, for the detail view (`/data/unit-survey/…`). */
  report: string;
  /** `startedAt` from the report, else the filename stamp, else the mtime. */
  generatedAt: string;
  finishedAt: string | null;
  label: string;
  /** `coverage` = stage 1 only ($0); `replay` = stage 2 ran on some case. */
  stage: "coverage" | "replay";
  /** Cases in the file, and how many of them errored. */
  cases: number;
  errored: number;
  /** Distinct arms (fixture parent dirs) the cases came from. */
  arms: string[];
  promptVersion: string | null;
  /** Stage-1 coverage over the non-errored cases: gold SHOWN by some unit / locatable. */
  coverage: { covered: number; locatable: number; gold: number; unlocatable: number };
  units: number;
  requestChars: number;
  truncated: number;
  /** `null` on a stage-1 report — there is no model side to total. */
  model: UnitSurveyModelTotals | null;
}

export interface UnitSurveyIndex {
  generatedAt: string;
  reports: UnitSurveyEntry[];
}

const sum = (xs: number[]): number => xs.reduce((a, b) => a + b, 0);
const isNum = (x: unknown): x is number => typeof x === "number" && Number.isFinite(x);

/** `2026-09-27T10-10-15-249Z-label` → `2026-09-27T10:10:15.249Z`, else `null`. */
export function parseUnitSurveyStamp(id: string): string | null {
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z/.exec(id);
  return m ? `${m[1]}T${m[2]}:${m[3]}:${m[4]}.${m[5]}Z` : null;
}

/** The arm a case came from — the report's own `arm`, which the script takes
 * from the fixture's parent directory. */
const armOf = (c: ReplayCase): string => (typeof c.arm === "string" && c.arm ? c.arm : "?");

/** A case's model run, if it ran and did not error. */
export function okModel(c: ReplayCase): ReplayModelRun | null {
  return !c.error && c.model && !c.model.error ? c.model : null;
}

/** The agent side's survey cost, or `null` when the fixture recorded no branch
 * (the report's `costUsd` is then a sum over nothing, not a free survey). */
export function agentCost(m: ReplayModelRun): number | null {
  return m.agentSurvey && Array.isArray(m.agentSurvey.branches) && m.agentSurvey.branches.length > 0
    ? m.agentSurvey.costUsd
    : null;
}

export function agentWall(m: ReplayModelRun): number | null {
  return isNum(m.agentSurvey?.wallMs) ? m.agentSurvey.wallMs : null;
}

/** Judge-credited gold for one side, `null` when that side was not judged. */
export function assertedOf(s: MicroGoldRepeat | null | undefined): number | null {
  return s && isNum(s.asserted) ? s.asserted : null;
}

/**
 * The stage-2 totals, RECOMPUTED from the cases rather than copied from the
 * report's `aggregate.model` — which sums the agent's `costUsd` even where the
 * fixture recorded no branch (a 0 that means "unknown"). `null` when no case
 * ran a model.
 */
export function modelTotals(cases: ReplayCase[]): UnitSurveyModelTotals | null {
  const withModel = cases.flatMap((c) => {
    const m = okModel(c);
    return m ? [{ c, m }] : [];
  });
  if (!withModel.length) return null;
  const nullableSum = (xs: (number | null)[]): number | null => (xs.some((x) => x === null) ? null : sum(xs as number[]));
  const uniq = <T,>(xs: T[]): T[] => [...new Set(xs)];
  return {
    cases: withModel.length,
    gold: sum(withModel.map(({ c }) => (Array.isArray(c.gold) ? c.gold.length : 0))),
    unitsAsserted: nullableSum(withModel.map(({ m }) => assertedOf(m.unitsScore))),
    agentAsserted: nullableSum(withModel.map(({ m }) => assertedOf(m.agentScore))),
    onlyUnits: sum(withModel.map(({ m }) => m.sides?.onlyUnits?.length ?? 0)),
    onlyAgent: sum(withModel.map(({ m }) => m.sides?.onlyAgent?.length ?? 0)),
    unitsCostUsd: sum(withModel.map(({ m }) => (isNum(m.costUsd) ? m.costUsd : 0))),
    agentCostUsd: nullableSum(withModel.map(({ m }) => agentCost(m))),
    unitsWallMs: sum(withModel.map(({ m }) => (isNum(m.wallMs) ? m.wallMs : 0))),
    agentWallMs: nullableSum(withModel.map(({ m }) => agentWall(m))),
    models: uniq(withModel.map(({ m }) => m.model)),
    judgeModels: uniq(withModel.map(({ m }) => m.judgeModel ?? null)),
    votes: uniq(
      withModel.flatMap(({ m }) => [m.unitsScore?.votes, m.agentScore?.votes].filter(isNum) as number[]),
    ).sort((a, b) => a - b),
  };
}

/**
 * One parsed file → its index entry, or `null` when it is not a unit-survey
 * report (a stray JSON file, or a shape this version cannot read). A torn,
 * half-written file never gets this far — the scan's `JSON.parse` drops it.
 */
export function summariseUnitSurveyReport(id: string, raw: unknown, fallbackIso: string): UnitSurveyEntry | null {
  const r = raw as Partial<ReplayReport> | null;
  if (!r || typeof r !== "object" || typeof r.label !== "string" || !Array.isArray(r.cases)) return null;
  const cases = r.cases.filter((c): c is ReplayCase => !!c && typeof c === "object" && typeof c.instanceId === "string");
  const ok = cases.filter((c) => !c.error);
  const tallies = ok.map((c) => c.coverageTally).filter((t) => t && typeof t === "object");
  const shapes = ok.map((c) => c.shape).filter((s) => s && typeof s === "object");
  const model = modelTotals(cases);
  return {
    id,
    report: `/data/${UNIT_SURVEY_DIR}/${encodeURIComponent(`${id}.json`)}`,
    generatedAt: (typeof r.startedAt === "string" && r.startedAt) || parseUnitSurveyStamp(id) || fallbackIso,
    finishedAt: typeof r.finishedAt === "string" ? r.finishedAt : null,
    label: r.label,
    stage: model || r.stage === "replay" ? "replay" : "coverage",
    cases: cases.length,
    errored: cases.length - ok.length,
    arms: [...new Set(cases.map(armOf))].sort(),
    promptVersion: typeof r.codeFacts?.promptVersion === "string" ? r.codeFacts.promptVersion : null,
    coverage: {
      covered: sum(tallies.map((t) => t.covered ?? 0)),
      locatable: sum(tallies.map((t) => t.locatable ?? 0)),
      gold: sum(tallies.map((t) => t.gold ?? 0)),
      unlocatable: sum(tallies.map((t) => t.unlocatable ?? 0)),
    },
    units: sum(shapes.map((s) => s.units ?? 0)),
    requestChars: sum(shapes.map((s) => s.requestChars ?? 0)),
    truncated: sum(shapes.map((s) => s.truncated ?? 0)),
    model,
  };
}

// ── the detail view ─────────────────────────────────────────────────────────

/** A gold that exactly one side's judge credited, with the rows that did it. */
export interface OneSidedGold {
  index: number;
  gold: MicroGoldRef | undefined;
  side: "units" | "agent";
  /** The crediting side's row ids at this gold (`cells[j].rows`). */
  rows: string[];
  /** How many judge passes credited it, when the report kept the tally. */
  creditVotes: number | null;
  votes: number | null;
}

/** Every gold one side credited and the other did not, units first. */
export function oneSidedGold(c: ReplayCase): OneSidedGold[] {
  const m = okModel(c);
  if (!m) return [];
  const pick = (side: "units" | "agent", idx: number[] | undefined): OneSidedGold[] => {
    const score = side === "units" ? m.unitsScore : m.agentScore;
    return (idx ?? []).map((j) => ({
      index: j,
      gold: c.gold?.[j],
      side,
      rows: score?.cells?.[j]?.rows ?? [],
      creditVotes: isNum(score?.creditVotes?.[j]) ? score!.creditVotes![j] : null,
      votes: isNum(score?.votes) ? score!.votes! : null,
    }));
  };
  return [...pick("units", m.sides?.onlyUnits), ...pick("agent", m.sides?.onlyAgent)];
}

/**
 * The caveats a report carries — each one a reason a number on the page could
 * be read as more than it is. Derived from the report's own fields, so a caveat
 * appears exactly when its condition holds (and nothing is guessed: where the
 * report does not record a thing, the caveat says it is not recorded).
 */
export function unitSurveyCaveats(r: ReplayReport): string[] {
  const out: string[] = [];
  const cases = Array.isArray(r.cases) ? r.cases : [];
  const models = cases.flatMap((c) => {
    const m = okModel(c);
    return m ? [{ c, m }] : [];
  });
  const errored = cases.filter((c) => c.error);
  if (errored.length) {
    out.push(`${errored.length} case(s) errored before stage 1 finished and are excluded from every total: ${errored.map((c) => `${armOf(c)}/${c.instanceId}`).join(", ")}.`);
  }
  const unlocatable = sum(cases.filter((c) => !c.error).map((c) => c.coverageTally?.unlocatable ?? 0));
  if (unlocatable) {
    out.push(`${unlocatable} gold name no file; they stay in the gold total and out of the locatable denominator of stage-1 coverage (no unit can show a gold with nowhere to be).`);
  }
  const drift = cases.filter((c) => {
    if (c.error || !c.obligations) return false;
    const fams = new Set([...Object.keys(c.obligations.fixture ?? {}), ...Object.keys(c.obligations.replay ?? {})]);
    return [...fams].some((f) => (c.obligations.fixture?.[f] ?? 0) !== (c.obligations.replay?.[f] ?? 0));
  });
  if (drift.length) {
    out.push(`Seeded obligations differ between the fixture and the replay on ${drift.length} case(s) (${drift.map((c) => `${armOf(c)}/${c.instanceId}`).join(", ")}) — the units were not handed exactly what the agent survey was.`);
  }
  const defaultedMax = cases.filter((c) => !c.error && /default/.test(c.seed?.source?.maxObligations ?? ""));
  if (defaultedMax.length) {
    out.push(`--max-obligations was not recorded for ${defaultedMax.length} case(s) and fell back to the CLI default.`);
  }
  const specOff = cases.filter((c) => !c.error && c.spec?.fidelity && c.spec.fidelity.match === false);
  if (specOff.length) {
    out.push(`The rebuilt spec obligations do not match the agent spec branch's recorded prompt on ${specOff.length} case(s) (${specOff.map((c) => `${armOf(c)}/${c.instanceId}`).join(", ")}).`);
  }
  const specErr = cases.filter((c) => !c.error && c.spec?.status === "error");
  if (specErr.length) out.push(`Spec obligations could not be built for ${specErr.length} case(s).`);
  const shapeDegraded = cases.filter((c) => !c.error && (c.shape?.degraded?.length ?? 0) > 0);
  if (shapeDegraded.length) out.push(`units degraded (an extractor failed) on ${shapeDegraded.length} case(s).`);

  if (models.length) {
    out.push(
      `Different code generations: the units side is TODAY's code (code-facts ${r.codeFacts?.cli ?? "?"}, prompt ${r.codeFacts?.promptVersion ?? "not recorded"}) run fresh with no cache; the agent side is the survey preserved in each fixture, written by the pipeline of the arm it was preserved from. The agent survey's model is not recorded in the report.`,
    );
    const judges = [...new Set(models.map(({ m }) => m.judgeModel ?? null))];
    const votes = [...new Set(models.flatMap(({ m }) => [m.unitsScore?.votes, m.agentScore?.votes].filter(isNum)))];
    if (judges.includes(null)) {
      out.push("No judge on some case(s) — scoring there is LOCATION ONLY: judge-credited gold is unknown (n/a), not 0.");
    }
    const named = judges.filter((j): j is string => !!j);
    if (named.length) {
      out.push(
        `Credited gold = the internal-recall judge (${named.join(", ")}) asserting the defect, majority over ${votes.length ? votes.join("/") : "1"} vote(s); a failed pass is dropped, never counted as a miss. Both sides are scored by the same judge on the same gold.`,
      );
    }
    const judgeErr = models.filter(({ m }) => m.unitsScore?.judgeError || m.agentScore?.judgeError);
    if (judgeErr.length) out.push(`The judge failed on ${judgeErr.length} case(s); credited gold there is n/a.`);
    const unconfirmed = models.filter(({ m }) => m.unitsScore?.confirmUngraded || m.agentScore?.confirmUngraded);
    if (unconfirmed.length) out.push(`The judge's CONFIRM step was ungraded on ${unconfirmed.length} case(s).`);
    const noAgent = models.filter(({ m }) => agentCost(m) === null || agentWall(m) === null);
    if (noAgent.length) out.push(`${noAgent.length} fixture(s) recorded no agent survey_branch_* result lines; agent wall/$ there is n/a and the totals are n/a.`);
    const conc = [...new Set(models.map(({ m }) => m.concurrency))];
    out.push(
      `Wall clock: units ran ${conc.join("/")} in flight; agent wall is the preserved fan-out's span (first branch message → last branch result). Neither records whether the host was busy with other runs. $ is the survey only — the judge's spend is not in either column.`,
    );
    const modelErr = cases.filter((c) => !c.error && c.model?.error);
    if (modelErr.length) out.push(`The unit survey errored on ${modelErr.length} case(s); those are excluded from the stage-2 totals.`);
  }
  return out;
}

/** `1/4` + a percent, or `n/a` — a fraction never loses its denominator. */
export function fmtGoldFraction(n: number | null | undefined, of: number): string {
  if (!isNum(n)) return "n/a";
  return of > 0 ? `${n}/${of} (${Math.round((100 * n) / of)}%)` : `${n}/0`;
}

/**
 * The unit-survey replay's arithmetic — `scripts/unit-survey-replay.ts` does
 * the file and process work, this module holds everything that decides a
 * number, so it is testable with no fixture, no CLI and no network.
 *
 * `docs/plans/pr-review-units-sites.md` → "Evals" asks two questions of the per-unit
 * survey before it may become a default:
 *
 *  1. **$0 coverage** — does some unit even SHOW the model each gold line? A
 *     gold line no unit carries cannot be found by any reply, whatever the
 *     model. Read off the request text's own line tags with code-facts'
 *     `requestLineTags` (the parser `units-ingest` uses), never a second copy
 *     of the rendering rules.
 *  2. **Replay** — the units' hypotheses against the preserved AGENT survey's,
 *     scored on the same gold by the same instrument: the internal-recall judge
 *     (`gradeInternalRecall`, MATCH then CONFIRM) folded through
 *     `microGoldRepeat` / `microGoldVote` — exactly what `micro-survey.ts`
 *     scores a replay with. No matcher lives here.
 */
import { readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import { needsProbeOf, requestLineTags } from "lastlight-code-facts";

import { gradeInternalRecall } from "./grade.js";
import {
  type MicroGoldRef,
  type MicroGoldRepeat,
  microGoldRepeat,
  microGoldVote,
} from "./micro-survey.js";
import { type SurveyRow, claimOf, rowsAsJudgeFindings } from "./micro-survey-node.js";
import type { GoldComment } from "./schema.js";

// ── Stage 1: does some unit show the gold line? ─────────────────────────────

/** The minimal slice of `units.json` stage 1 reads. */
export interface ReplayUnit {
  id: string;
  kind?: string;
  file?: string | null;
  request: string;
  truncated?: boolean;
}

export interface ReplayUnitsDoc {
  coverage?: string;
  promptVersion?: string | null;
  sharedPrefix?: string | null;
  degraded?: { extractor?: string; reason?: string }[];
  specObligations?: unknown[];
  units: ReplayUnit[];
}

/**
 * Per gold, whether a unit SHOWS it:
 *
 *  - `covered` — some unit's request carries a line tag for the gold's file at
 *    the gold's line (or, for a gold spanning lines, at any line of the span).
 *    A gold with a file and NO line is covered when any unit tags any line of
 *    that file — the best a location can say.
 *  - `file-only` — a unit shows the file, but not that line.
 *  - `uncovered` — no unit shows the file at all.
 *  - `unlocatable` — the gold names no file (description-only gold). It stays
 *    in the TOTAL and out of the LOCATABLE denominator: no location can cover
 *    it, and reporting it as "uncovered" would charge the unit cutter for a
 *    gold with nowhere to be.
 */
export type GoldUnitVerdict = "covered" | "file-only" | "uncovered" | "unlocatable";

export interface GoldUnitCell {
  verdict: GoldUnitVerdict;
  /** The units that show the line (covered) or the file (file-only). */
  units: string[];
  /**
   * Covered only: did some unit show the gold line as a line this PR CHANGED
   * (`+|`), rather than as surrounding context? A gold on context is shown, but
   * the request does not point the model at it.
   */
  changed?: boolean;
}

/**
 * The lines a gold points at. `line` is what the dataset carries; a gold that
 * spans lines (`start_line`..`line`, GitHub's multi-line comment shape) covers
 * the whole span. `null` = the gold names no line.
 */
export function goldLines(g: Pick<GoldComment, "line"> & { start_line?: number; end_line?: number }): number[] | null {
  const end = typeof g.end_line === "number" ? g.end_line : g.line;
  if (typeof end !== "number") return null;
  const start = typeof g.start_line === "number" && g.start_line <= end ? g.start_line : end;
  return Array.from({ length: end - start + 1 }, (_, i) => start + i);
}

const normPath = (p: string): string => p.replace(/^\.?\//, "");

/** file → line → the ids of the units whose request tags that line, and whether any tagged it changed. */
export function unitLineIndex(units: ReplayUnit[]): Map<string, Map<number, { ids: string[]; changed: boolean }>> {
  const index = new Map<string, Map<number, { ids: string[]; changed: boolean }>>();
  for (const u of units) {
    for (const [file, lines] of requestLineTags(u.request)) {
      const byLine = index.get(normPath(file)) ?? new Map<number, { ids: string[]; changed: boolean }>();
      index.set(normPath(file), byLine);
      for (const [line, tagged] of lines) {
        const at = byLine.get(line) ?? { ids: [], changed: false };
        if (!at.ids.includes(u.id)) at.ids.push(u.id);
        at.changed ||= tagged.changed;
        byLine.set(line, at);
      }
    }
  }
  return index;
}

export function goldUnitCoverage(
  units: ReplayUnit[],
  gold: (Pick<GoldComment, "file" | "line"> & { start_line?: number; end_line?: number })[],
): GoldUnitCell[] {
  const index = unitLineIndex(units);
  return gold.map((g) => {
    if (!g.file) return { verdict: "unlocatable", units: [] };
    const byLine = index.get(normPath(g.file));
    if (!byLine || byLine.size === 0) return { verdict: "uncovered", units: [] };
    const fileUnits = [...new Set([...byLine.values()].flatMap((x) => x.ids))].sort();
    const lines = goldLines(g);
    if (lines === null) return { verdict: "covered", units: fileUnits, changed: [...byLine.values()].some((x) => x.changed) };
    const at = lines.flatMap((l) => (byLine.has(l) ? [byLine.get(l)!] : []));
    const hit = [...new Set(at.flatMap((x) => x.ids))].sort();
    return hit.length
      ? { verdict: "covered", units: hit, changed: at.some((x) => x.changed) }
      : { verdict: "file-only", units: fileUnits };
  });
}

/** The cost-side shape of one units document — what stage 1 reports beside coverage. */
export interface UnitsShape {
  units: number;
  byKind: Record<string, number>;
  /** Sum of every request's length: what the survey SENDS, before any prefix caching. */
  requestChars: number;
  /** Characters of the shared prefix — sent once per unit, cacheable after the first. */
  sharedPrefixChars: number;
  /** requestChars minus the prefix on every unit that opens with it: the uncacheable part. */
  unitSpecificChars: number;
  maxRequestChars: number;
  truncated: number;
  coverage: string | null;
  promptVersion: string | null;
  degraded: string[];
  specObligations: number;
}

export function unitsShape(doc: ReplayUnitsDoc): UnitsShape {
  const prefix = typeof doc.sharedPrefix === "string" ? doc.sharedPrefix : "";
  const byKind: Record<string, number> = {};
  let requestChars = 0;
  let unitSpecificChars = 0;
  let maxRequestChars = 0;
  for (const u of doc.units) {
    byKind[u.kind ?? "unknown"] = (byKind[u.kind ?? "unknown"] ?? 0) + 1;
    requestChars += u.request.length;
    unitSpecificChars += prefix && u.request.startsWith(prefix) ? u.request.length - prefix.length : u.request.length;
    maxRequestChars = Math.max(maxRequestChars, u.request.length);
  }
  return {
    units: doc.units.length,
    byKind,
    requestChars,
    sharedPrefixChars: prefix.length,
    unitSpecificChars,
    maxRequestChars,
    truncated: doc.units.filter((u) => u.truncated === true).length,
    coverage: doc.coverage ?? null,
    promptVersion: doc.promptVersion ?? null,
    degraded: (doc.degraded ?? []).map((d) => `${d.extractor ?? "?"}: ${(d.reason ?? "").slice(0, 200)}`),
    specObligations: Array.isArray(doc.specObligations) ? doc.specObligations.length : 0,
  };
}

export interface CoverageTally {
  gold: number;
  locatable: number;
  covered: number;
  /** Of `covered`, shown as a CHANGED line (the rest only as context). */
  coveredChanged: number;
  fileOnly: number;
  uncovered: number;
  unlocatable: number;
}

export function tallyCoverage(cells: GoldUnitCell[]): CoverageTally {
  const n = (v: GoldUnitVerdict) => cells.filter((c) => c.verdict === v).length;
  return {
    gold: cells.length,
    locatable: cells.length - n("unlocatable"),
    covered: n("covered"),
    coveredChanged: cells.filter((c) => c.verdict === "covered" && c.changed === true).length,
    fileOnly: n("file-only"),
    uncovered: n("uncovered"),
    unlocatable: n("unlocatable"),
  };
}

// ── The replay inputs: seed flags and spec obligations ──────────────────────

/** What `seed` was run with, recovered so the replayed obligations are comparable. */
export interface SeedArgs {
  contract: string;
  maxObligations: number;
  /** The `--mint` comma-list, or null for none. */
  mint: string | null;
  /** Where each value came from — the report says, so nothing reads as assumed. */
  source: { contract: string; maxObligations: string; mint: string };
}

/** `obligations.json`'s `minting` stamp → the `--mint` spelling. */
const MINT_ARMS: Record<string, string> = { allInDiff: "all-in-diff", registrations: "registrations" };

/**
 * The `seed` flags the fixture's run used. `contract` and `minting` are stamped
 * into `obligations.json`; `--max-obligations` is not, so it is read from the
 * seed phase's recorded command (`MAX_OBLIGATIONS="40"` — the rendered bash
 * the transcript opens with), falling back to the CLI default (48) and saying
 * so. The recorded command wins over nothing but the document: where both carry
 * a value, the document is what `seed` actually wrote. A fixture built with no
 * agent run (`scripts/seed-fixtures.ts`) has no transcript, so it stamps a
 * `maxObligations` field into its minimal `obligations.json`, which wins over both.
 */
export function seedArgsOf(
  doc: { contract?: string; minting?: Record<string, boolean> | null; maxObligations?: number },
  seedCommand: string | null,
): SeedArgs {
  const fromCmd = (name: string): string | undefined =>
    seedCommand ? new RegExp(`\\b${name}="([^"]*)"`).exec(seedCommand)?.[1] : undefined;
  const cmdContract = fromCmd("CONTRACT");
  const cmdMax = fromCmd("MAX_OBLIGATIONS");
  const cmdMint = fromCmd("MINT");
  const docMint = doc.minting
    ? Object.entries(doc.minting)
        .filter(([, on]) => on === true)
        .map(([k]) => MINT_ARMS[k] ?? k)
    : null;
  const contract = doc.contract ?? (cmdContract || "minimal");
  const docMax = typeof doc.maxObligations === "number" && Number.isInteger(doc.maxObligations) ? doc.maxObligations : undefined;
  const max = docMax ?? (cmdMax && /^\d+$/.test(cmdMax) ? Number(cmdMax) : 48);
  const mint = docMint !== null ? (docMint.length ? docMint.join(",") : null) : cmdMint ? cmdMint : null;
  return {
    contract,
    maxObligations: max,
    mint,
    source: {
      contract: doc.contract ? "obligations.json" : cmdContract ? "seed transcript" : "default (minimal)",
      maxObligations: docMax !== undefined ? "obligations.json" : cmdMax ? "seed transcript" : "default (48) — not recorded in the fixture",
      mint: docMint !== null ? "obligations.json" : cmdMint !== undefined ? "seed transcript" : "none recorded",
    },
  };
}

/**
 * Does a rebuilt spec obligation set match what the agent survey was given?
 * The agent's `spec` branch had them rendered into its first user message, so
 * each rebuilt criterion should appear there verbatim, and the ids it names
 * (`S-1` … `S-n`) should number the same. A set with NO obligations renders its
 * degraded reasons instead, so those are what must appear.
 */
export function specFidelity(
  rebuilt: { obligations: { id: string; criterion: string }[]; degraded?: string[] },
  transcriptPrompt: string | null,
): { rebuilt: number; inTranscript: number | null; transcriptIds: number | null; match: boolean | null } {
  if (transcriptPrompt === null) return { rebuilt: rebuilt.obligations.length, inTranscript: null, transcriptIds: null, match: null };
  if (rebuilt.obligations.length === 0) {
    const reasons = rebuilt.degraded ?? [];
    const inTranscript = reasons.filter((r) => transcriptPrompt.includes(r)).length;
    return { rebuilt: 0, inTranscript, transcriptIds: null, match: reasons.length > 0 && inTranscript === reasons.length };
  }
  const inTranscript = rebuilt.obligations.filter((o) => transcriptPrompt.includes(o.criterion)).length;
  const transcriptIds = new Set(transcriptPrompt.match(/\bS-\d+\b/g) ?? []).size;
  return {
    rebuilt: rebuilt.obligations.length,
    inTranscript,
    transcriptIds,
    match: inTranscript === rebuilt.obligations.length && transcriptIds === rebuilt.obligations.length,
  };
}

// ── The agent survey's own record ──────────────────────────────────────────

export interface AgentSurveyPhase {
  /** First survey-branch message → last survey-branch `result` line. */
  wallMs: number | null;
  costUsd: number;
  branches: { phase: string; durationMs: number | null; costUsd: number }[];
  source: string;
}

interface SessionLine {
  type?: string;
  timestamp?: string;
  phase?: string;
  duration_ms?: number;
  total_cost_usd?: number;
}

function* sessionFiles(dir: string): Generator<string> {
  let entries: string[] = [];
  try {
    entries = readdirSync(dir);
  } catch {
    return;
  }
  for (const e of entries) {
    const p = join(dir, e);
    let isDir = false;
    try {
      isDir = statSync(p).isDirectory();
    } catch {
      continue;
    }
    if (isDir) yield* sessionFiles(p);
    else if (e.endsWith(".jsonl")) yield p;
  }
}

/** The first and the `result` lines of one transcript — all this reads. */
export function sessionEnds(text: string): { first: SessionLine | null; result: SessionLine | null } {
  const lines = text.split("\n").filter((l) => l.trim());
  const parse = (l: string | undefined): SessionLine | null => {
    if (!l) return null;
    try {
      return JSON.parse(l) as SessionLine;
    } catch {
      return null;
    }
  };
  let result: SessionLine | null = null;
  for (let i = lines.length - 1; i >= 0 && i >= lines.length - 3; i--) {
    const o = parse(lines[i]);
    if (o?.type === "result") {
      result = o;
      break;
    }
  }
  return { first: parse(lines[0]), result };
}

/**
 * The agent survey phase, from the fixture's `agent-sessions/` transcripts:
 * every session whose `result` line is stamped `phase: survey_branch_*`. Wall
 * clock is the earliest branch's first line to the latest branch's result —
 * the fan-out's span, which is what a pipeline waits on — and cost is the sum
 * of the branches' `total_cost_usd`. `null` wall when nothing was stamped.
 */
export function agentSurveyPhase(sessionsDir: string, phasePrefix = "survey_branch_"): AgentSurveyPhase {
  const branches: AgentSurveyPhase["branches"] = [];
  let start = Infinity;
  let end = -Infinity;
  for (const file of sessionFiles(sessionsDir)) {
    const { first, result } = sessionEnds(readFileSync(file, "utf8"));
    if (!result?.phase?.startsWith(phasePrefix)) continue;
    branches.push({
      phase: result.phase,
      durationMs: typeof result.duration_ms === "number" ? result.duration_ms : null,
      costUsd: typeof result.total_cost_usd === "number" ? result.total_cost_usd : 0,
    });
    const s = Date.parse(first?.timestamp ?? "");
    const e = Date.parse(result.timestamp ?? "");
    if (Number.isFinite(s)) start = Math.min(start, s);
    else if (Number.isFinite(e) && typeof result.duration_ms === "number") start = Math.min(start, e - result.duration_ms);
    if (Number.isFinite(e)) end = Math.max(end, e);
  }
  branches.sort((a, b) => a.phase.localeCompare(b.phase));
  return {
    wallMs: branches.length && Number.isFinite(start) && Number.isFinite(end) ? end - start : null,
    costUsd: branches.reduce((s, b) => s + b.costUsd, 0),
    branches,
    source: `agent-sessions/**/*.jsonl — ${branches.length} session(s) whose result line is stamped phase ${phasePrefix}*; wall = first line → last result timestamp`,
  };
}

// ── Stage 2 scoring: ONE instrument for both sides ──────────────────────────

export type GradeFn = typeof gradeInternalRecall;

export function goldRefs(gold: GoldComment[]): MicroGoldRef[] {
  return gold.map((g) => ({
    ...(g.file ? { file: g.file } : {}),
    ...(typeof g.line === "number" ? { line: g.line } : {}),
    severity: g.severity,
    summary: g.description.replace(/\*\*[^*]*\*\*/g, "").replace(/\s+/g, " ").trim().slice(0, 160),
  }));
}

/**
 * Score one side's hypothesis rows against the case's gold — the same overlay
 * `micro-survey.ts` computes for a replay: the internal-recall judge decides
 * `asserted` (majority over `votes` passes; a failed pass is dropped, never
 * counted as a miss), `microRowReachesGold` decides `reached`. Called with the
 * units' rows and the agent's rows alike, so the two are comparable by
 * construction. `judgeModel: null` = location only (`asserted` unknown, not 0).
 * `undefined` when the case has no gold.
 */
export async function scoreRows(
  rows: SurveyRow[],
  gold: GoldComment[],
  opts: { judgeModel: string | null; votes: number; grade?: GradeFn },
): Promise<MicroGoldRepeat | undefined> {
  if (!gold.length) return undefined;
  const base = { rows, gold: goldRefs(gold), probeOf: (r: SurveyRow) => needsProbeOf(r), claimOf };
  if (!opts.judgeModel || !rows.length) {
    // No rows: nothing can have asserted anything — a measured zero. No judge:
    // unknown, which `rowForGold: null` records as `asserted: null`.
    return microGoldRepeat({ ...base, rowForGold: rows.length ? null : gold.map(() => null) });
  }
  const grade = opts.grade ?? gradeInternalRecall;
  const findings = rowsAsJudgeFindings(rows);
  const passes = await Promise.all(
    Array.from({ length: Math.max(1, opts.votes) }, () => grade({ gold, findings, judgeModel: opts.judgeModel as string })),
  );
  const ok = passes.filter((g) => g && !g.error);
  if (!ok.length) {
    const err = passes.find((g) => g?.error)?.error ?? "no grade returned";
    return { ...microGoldRepeat({ ...base, rowForGold: null }), judgeError: err };
  }
  const { rowForGold, creditVotes } = microGoldVote(ok.map((g) => g!.goldToFinding), gold.length);
  const unconfirmed = ok.find((g) => g!.confirmUngraded)?.confirmUngraded;
  return {
    ...microGoldRepeat({ ...base, rowForGold }),
    ...(ok.length > 1 ? { votes: ok.length, creditVotes } : {}),
    ...(unconfirmed ? { confirmUngraded: unconfirmed } : {}),
  };
}

/** Gold indices each side asserted, and the ones only one side did. */
export function compareSides(
  units: MicroGoldRepeat | undefined,
  agent: MicroGoldRepeat | undefined,
): { units: number[]; agent: number[]; onlyUnits: number[]; onlyAgent: number[]; both: number[] } {
  const asserted = (o: MicroGoldRepeat | undefined) =>
    o ? o.cells.flatMap((c, j) => (c.verdict === "asserted" ? [j] : [])) : [];
  const u = asserted(units);
  const a = asserted(agent);
  return {
    units: u,
    agent: a,
    onlyUnits: u.filter((j) => !a.includes(j)),
    onlyAgent: a.filter((j) => !u.includes(j)),
    both: u.filter((j) => a.includes(j)),
  };
}

// ── The report ──────────────────────────────────────────────────────────────

export interface ReplayModelRun {
  model: string;
  variant: string | null;
  concurrency: number;
  wallMs: number;
  costUsd: number;
  calls: number;
  unitsOk: number;
  unitsFailed: number;
  /** `units/ingest.json` per-unit statuses, counted. */
  ingest: Record<string, number>;
  /** Hypothesis rows ingest wrote, per family. */
  rowsByFamily: Record<string, number>;
  unitsScore: MicroGoldRepeat | null;
  agentScore: MicroGoldRepeat | null;
  agentRows: number;
  agentSurvey: AgentSurveyPhase;
  sides: ReturnType<typeof compareSides>;
  judgeModel: string | null;
  error?: string;
}

export interface ReplayCase {
  instanceId: string;
  arm: string;
  fixture: string;
  /** Case-level gold refs (review_gold). */
  gold: MicroGoldRef[];
  seed: SeedArgs;
  /** Obligations per family: what the fixture's seed wrote vs what the replay's did. */
  obligations: { fixture: Record<string, number>; replay: Record<string, number> };
  spec: {
    status: "written" | "no-spec" | "degraded-only" | "error";
    note: string;
    obligations: number;
    degraded: string[];
    fidelity: ReturnType<typeof specFidelity> | null;
  };
  shape: UnitsShape;
  coverage: GoldUnitCell[];
  coverageTally: CoverageTally;
  /** `review_gold_neutral`, same rule — secondary, never in the headline. */
  neutralTally: CoverageTally | null;
  deterministicMs: { facts: number; seed: number; units: number };
  model?: ReplayModelRun;
  error?: string;
}

/** One case the replay intends to run, recorded up front so a report in flight
 * can say how far through it is. */
export interface ReplayPlannedCase {
  arm: string;
  instanceId: string;
  fixture: string;
}

/**
 * Where a report's writer is.
 *
 * The script writes the report at START (`running`, the planned case list),
 * rewrites it after every case and on a 15 s heartbeat ticker, and finalises it
 * `done` — or `failed`, with the error, if the run itself threw. A report with
 * NO `status` predates live writes and was written once, at the end: it is
 * `done`. Whether a `running` report's writer is still alive is a read-time
 * question — `unitSurveyStatus` in `unit-survey-index.ts`.
 */
export type ReplayWriteStatus = "running" | "done" | "failed";

export interface ReplayReport {
  version: 1;
  label: string;
  startedAt: string;
  /** `null` while the replay is still running (or died without finalising). */
  finishedAt: string | null;
  /** Absent on reports written before live writes — read as `done`. */
  status?: ReplayWriteStatus;
  /** Refreshed on every write, including the independent heartbeat ticker. */
  heartbeat?: string;
  /** Every case the run set out to replay, in order. Absent on old reports. */
  planned?: ReplayPlannedCase[];
  /** Why a `failed` run failed. */
  error?: string;
  stage: "coverage" | "replay";
  codeFacts: { cli: string; promptVersion: string | null };
  cases: ReplayCase[];
  aggregate: {
    cases: number;
    coverage: CoverageTally;
    units: number;
    requestChars: number;
    truncated: number;
    model?: {
      cases: number;
      gold: number;
      unitsAsserted: number | null;
      agentAsserted: number | null;
      onlyUnits: number;
      onlyAgent: number;
      unitsRows: number;
      agentRows: number;
      unitsCostUsd: number;
      agentCostUsd: number;
      unitsWallMs: number;
      agentWallMs: number | null;
    };
  };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function aggregateReport(cases: ReplayCase[]): ReplayReport["aggregate"] {
  const ok = cases.filter((c) => !c.error);
  const t = ok.map((c) => c.coverageTally);
  const coverage: CoverageTally = {
    gold: sum(t.map((x) => x.gold)),
    locatable: sum(t.map((x) => x.locatable)),
    covered: sum(t.map((x) => x.covered)),
    coveredChanged: sum(t.map((x) => x.coveredChanged)),
    fileOnly: sum(t.map((x) => x.fileOnly)),
    uncovered: sum(t.map((x) => x.uncovered)),
    unlocatable: sum(t.map((x) => x.unlocatable)),
  };
  const out: ReplayReport["aggregate"] = {
    cases: ok.length,
    coverage,
    units: sum(ok.map((c) => c.shape.units)),
    requestChars: sum(ok.map((c) => c.shape.requestChars)),
    truncated: sum(ok.map((c) => c.shape.truncated)),
  };
  const m = ok.flatMap((c) => (c.model && !c.model.error ? [c.model] : []));
  if (m.length) {
    // An unjudged side is unknown, not zero: one null makes the total null.
    const assertedTotal = (pick: (r: ReplayModelRun) => MicroGoldRepeat | null) =>
      m.some((r) => pick(r)?.asserted === null) ? null : sum(m.map((r) => pick(r)?.asserted ?? 0));
    const agentWalls = m.map((r) => r.agentSurvey.wallMs);
    out.model = {
      cases: m.length,
      gold: sum(ok.filter((c) => c.model && !c.model.error).map((c) => c.gold.length)),
      unitsAsserted: assertedTotal((r) => r.unitsScore),
      agentAsserted: assertedTotal((r) => r.agentScore),
      onlyUnits: sum(m.map((r) => r.sides.onlyUnits.length)),
      onlyAgent: sum(m.map((r) => r.sides.onlyAgent.length)),
      unitsRows: sum(m.map((r) => sum(Object.values(r.rowsByFamily)))),
      agentRows: sum(m.map((r) => r.agentRows)),
      unitsCostUsd: sum(m.map((r) => r.costUsd)),
      agentCostUsd: sum(m.map((r) => r.agentSurvey.costUsd)),
      unitsWallMs: sum(m.map((r) => r.wallMs)),
      agentWallMs: agentWalls.some((w) => w === null) ? null : sum(agentWalls as number[]),
    };
  }
  return out;
}

export function buildReport(opts: {
  label: string;
  startedAt: string;
  cli: string;
  cases: ReplayCase[];
  /** Default `done` — the one-shot final write. */
  status?: ReplayWriteStatus;
  planned?: ReplayPlannedCase[];
  error?: string;
  /** The stage the run was LAUNCHED as. Without it the stage is inferred from
   * the cases, which reads a replay with no finished case yet as `coverage`. */
  stage?: ReplayReport["stage"];
  now?: Date;
}): ReplayReport {
  const status = opts.status ?? "done";
  const now = (opts.now ?? new Date()).toISOString();
  const stage = opts.stage ?? (opts.cases.some((c) => c.model) ? "replay" : "coverage");
  return {
    version: 1,
    label: opts.label,
    startedAt: opts.startedAt,
    finishedAt: status === "running" ? null : now,
    status,
    heartbeat: now,
    ...(opts.planned ? { planned: opts.planned } : {}),
    ...(opts.error ? { error: opts.error } : {}),
    stage,
    codeFacts: { cli: opts.cli, promptVersion: opts.cases.find((c) => c.shape.promptVersion)?.shape.promptVersion ?? null },
    cases: opts.cases,
    aggregate: aggregateReport(opts.cases),
  };
}

/**
 * Write a report so a reader NEVER sees it torn: the JSON goes to a sibling
 * temp file, then `rename` swaps it in (atomic on one filesystem). The temp name
 * starts with `.` and ends `.tmp`, so the index's `*.json` scan never lists it.
 * The report is rewritten every 15 s while the dashboard polls every 1.5 s — a
 * plain `writeFileSync` truncates first, and a poll in that window would drop
 * the run from the list.
 */
export function writeReportAtomic(file: string, report: ReplayReport): void {
  const tmp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  writeFileSync(tmp, `${JSON.stringify(report, null, 2)}\n`);
  renameSync(tmp, file);
}

const pad = (s: string | number, n: number) => String(s).padEnd(n);
const lpad = (s: string | number, n: number) => String(s).padStart(n);
const shortId = (id: string) => id.replace(/^prreview__/, "");
const secs = (ms: number | null) => (ms === null ? "?" : `${(ms / 1000).toFixed(0)}s`);
const usd = (x: number) => `$${x.toFixed(3)}`;
const verdictMark: Record<GoldUnitVerdict, string> = { covered: "C", "file-only": "f", uncovered: "-", unlocatable: "?" };

/** The compact table the script prints. One line per case, then the totals. */
export function formatReport(r: ReplayReport): string {
  const L: string[] = [];
  L.push(
    `${pad("arm/case", 26)} ${lpad("gold", 4)} ${lpad("cov", 5)} ${pad("per-gold", 9)} ${lpad("units", 5)} ${lpad("chars", 8)} ${lpad("prefix", 6)} ${lpad("trunc", 5)} ${pad("spec", 13)} obl fix→replay`,
  );
  for (const c of r.cases) {
    if (c.error) {
      L.push(`${pad(`${c.arm}/${shortId(c.instanceId)}`, 26)} ERROR ${c.error.slice(0, 120)}`);
      continue;
    }
    const t = c.coverageTally;
    const oblF = sum(Object.values(c.obligations.fixture));
    const oblR = sum(Object.values(c.obligations.replay));
    L.push(
      `${pad(`${c.arm}/${shortId(c.instanceId)}`, 26)} ${lpad(t.gold, 4)} ${lpad(`${t.covered}/${t.locatable}`, 5)} ${pad(c.coverage.map((x) => (x.verdict === "covered" && !x.changed ? "c" : verdictMark[x.verdict])).join("") || "·", 9)} ${lpad(c.shape.units, 5)} ${lpad(c.shape.requestChars, 8)} ${lpad(c.shape.sharedPrefixChars, 6)} ${lpad(c.shape.truncated, 5)} ${pad(`${c.spec.status}:${c.spec.obligations}`, 13)} ${oblF}→${oblR}`,
    );
  }
  const a = r.aggregate;
  L.push(
    `TOTAL ${a.cases} case(s): gold lines shown by some unit ${a.coverage.covered}/${a.coverage.locatable} locatable (${a.coverage.coveredChanged} on a changed line; ${a.coverage.gold} gold; ${a.coverage.fileOnly} file-only, ${a.coverage.uncovered} file not in any unit, ${a.coverage.unlocatable} with no file) · ${a.units} units · ${a.requestChars} request chars · ${a.truncated} truncated`,
  );
  L.push("per-gold: C = a unit tags the gold line as CHANGED · c = only as context · f = a unit shows the file, not the line · - = no unit shows the file · ? = gold names no file");

  const withModel = r.cases.filter((c) => c.model);
  if (withModel.length) {
    L.push("");
    L.push(`${pad("arm/case", 26)} ${pad("side", 6)} ${lpad("asserted", 8)} ${lpad("reached", 7)} ${lpad("rows", 5)} ${lpad("claims", 6)} ${lpad("wall", 6)} ${lpad("cost", 8)}`);
    for (const c of withModel) {
      const m = c.model!;
      const name = `${c.arm}/${shortId(c.instanceId)}`;
      if (m.error) {
        L.push(`${pad(name, 26)} ERROR ${m.error.slice(0, 120)}`);
        continue;
      }
      const g = c.gold.length;
      const row = (side: string, s: MicroGoldRepeat | null, rows: number, wall: number | null, cost: number) =>
        `${pad(name, 26)} ${pad(side, 6)} ${lpad(s ? `${s.asserted ?? "?"}/${g}` : "-", 8)} ${lpad(s ? `${s.reached}` : "-", 7)} ${lpad(rows, 5)} ${lpad(s?.claimed ?? "-", 6)} ${lpad(secs(wall), 6)} ${lpad(usd(cost), 8)}`;
      L.push(row("units", m.unitsScore, sum(Object.values(m.rowsByFamily)), m.wallMs, m.costUsd));
      L.push(row("agent", m.agentScore, m.agentRows, m.agentSurvey.wallMs, m.agentSurvey.costUsd));
      const gid = (j: number) => `#${j + 1}${c.gold[j]?.file ? ` ${c.gold[j].file}:${c.gold[j].line ?? "?"}` : ""}`;
      if (m.sides.onlyUnits.length) L.push(`   only units found: ${m.sides.onlyUnits.map(gid).join(", ")}`);
      if (m.sides.onlyAgent.length) L.push(`   only agent found: ${m.sides.onlyAgent.map(gid).join(", ")}`);
      L.push(`   units: ${m.calls} call(s), ${m.unitsOk} ok / ${m.unitsFailed} failed · ingest ${JSON.stringify(m.ingest)} · judge ${m.judgeModel ?? "NONE (location only)"}`);
    }
    if (a.model) {
      const am = a.model;
      L.push(
        `TOTAL replay ${am.cases} case(s), ${am.gold} gold: units asserted ${am.unitsAsserted ?? "?"} vs agent ${am.agentAsserted ?? "?"} · only-units ${am.onlyUnits} · only-agent ${am.onlyAgent} · rows ${am.unitsRows} vs ${am.agentRows} · wall ${secs(am.unitsWallMs)} vs ${secs(am.agentWallMs)} · ${usd(am.unitsCostUsd)} vs ${usd(am.agentCostUsd)}`,
      );
    }
  }
  return L.join("\n");
}

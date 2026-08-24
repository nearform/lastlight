#!/usr/bin/env -S npx tsx
/**
 * Back-fill the evidence pipeline's own telemetry — and **internal recall** —
 * onto a scorecard measured before the instrument existed.
 *
 * `ReviewPipelineStats` was declared and consumed and never produced:
 * `boundaryMetrics()` and `familyFunnels()` (`src/review-metrics.ts`) both begin
 * by filtering for `review.pipeline`, and no run has ever carried one, so both
 * returned `undefined` on every measurement in the plan's history. The producer
 * now exists (`src/review-pipeline-stats.ts` + `run-instance.ts`), but it only
 * runs forward. The runs the plan's conclusions actually rest on are already
 * measured, and their workspaces were preserved — so the instrument can be
 * pointed at them retrospectively instead of re-running $7-17 arms.
 *
 * Two halves, and only one of them spends:
 *
 *  1. **Free.** `readPipelineArtifacts()` reads `obligations.json`,
 *     `hypotheses/*.jsonl`, `findings.json` and `disposition.json` out of the
 *     preserved workspace. Obligations, the discharge histogram, clean
 *     discharges, unprovenanced findings, the tier split, coverage — all
 *     deterministic, no model.
 *  2. **Spends.** Internal recall needs a judge: "did the pipeline FIND it at
 *     all?" is a different question from "did it SAY it?", and only the second is
 *     answerable from the posted review the original run already graded. One
 *     MATCH call per case (`gradeInternalRecall` — no EXTRACT step, because
 *     `findings.json` is already structured).
 *
 * The archived workspaces are laid out `<run>/<instance_id>/pr-review/` — the
 * `.lastlight` level is not in the archive — which is why `readPipelineArtifacts`
 * takes the artifact directory rather than the checkout.
 *
 * ── `--no-judge`: re-read the free half, keep the paid one ──────────────────
 *
 * The two halves age differently. The judge half is bought once and stays true:
 * a MATCH between the gold text and the findings the run generated does not
 * change when the *reader* changes. The mechanism half is a pure function of
 * artifacts on disk, so it goes stale the moment `readPipelineArtifacts` learns
 * something — and on 2026-08-23 it learned two things (a clean discharge now
 * requires `failureScenario` PRESENT and `null`, and citations resolve through
 * the canonical `<family>-NNN` identity). Re-running the whole back-fill to pick
 * those up would re-buy every MATCH call at full price to arrive at the same
 * answers.
 *
 * `--no-judge` therefore re-reads the artifacts, rewrites ONLY the mechanism
 * fields, and carries `internalMatched` / `internalGold` / `inlineMatched` /
 * `internalUngraded` and the per-family `matched` / `internalMatched` across
 * untouched
 * ({@link mergePreservedJudgement}). It makes zero model calls, so there is no
 * estimate and no confirmation — there is nothing to consent to. Two rules make
 * it safe to point at an already-published scorecard:
 *
 *  - **A run with no stored internal recall does not gain one.** The merge only
 *    ever copies a value that is already there; it never invents, and never
 *    turns a stored `internalUngraded` into a zero.
 *  - **It refuses to write if the judged half moved at all** ({@link judgedHalf}),
 *    alongside the existing published-number check. The whole promise of the mode
 *    is that the expensive column is untouched, so that promise is asserted
 *    rather than assumed.
 *
 * ── Safety, all of it bought with incidents (same rules as `rescore.ts`) ─────
 *
 *  - READ-ONLY unless `--write`; the write is tmp + rename, so a dashboard
 *    polling the file never reads half a JSON.
 *  - It prints a cost estimate and asks before spending, and refuses outright
 *    above `--max-spend` (default $1.00).
 *  - It REFUSES to write if any already-published number moved. Back-filling
 *    adds columns; it must not be able to rewrite the comparator every gate in
 *    `docs/plans/review-evidence-pipeline/` is read against.
 *  - An errored judge call is EXCLUDED and NAMED, never folded in as 0.000. A
 *    judge outage and a pipeline that found nothing produce the same number, and
 *    that number is the most dangerous one this script could print.
 *
 * Usage:
 *   npx tsx scripts/backfill-pipeline.ts <artifactDir> [more ...] \
 *       --results <eval-results/pr-review> [--env <dir>] [--write] [--yes] \
 *       [--judge-model <id>] [--max-spend <usd>]
 *   npx tsx scripts/backfill-pipeline.ts <artifactDir> --scorecard <path> [...]
 *   npx tsx scripts/backfill-pipeline.ts <artifactDir> [more ...] \
 *       --results <eval-results/pr-review> --no-judge [--write]   # free; keeps the judged half
 *
 * `<artifactDir>` is a preserved run's archive root (it holds one directory per
 * instance_id). Its scorecard is located by matching the archive's leading
 * `YYYY-MM-DD_HHMMSS` against the run directories under `--results`; the derived
 * mapping is PRINTED before anything spends, and `--scorecard` overrides it for a
 * single archive. Nothing is guessed silently.
 */

import { existsSync, readFileSync, readdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { pathToFileURL } from "node:url";

import chalk from "chalk";

import type { GoldComment, InstanceResult, ReviewFamilyStats, ReviewPipelineStats } from "../src/schema.js";
import { fmtRatio, summarizeModels, type ModelSummary, type Scorecard } from "../src/report.js";
import { gradedReviews, microReview } from "../src/review-metrics.js";
import {
  internalJudgeInputs,
  readPipelineArtifacts,
  withInternalRecall,
  type PipelineReadout,
} from "../src/review-pipeline-stats.js";
import { gradeInternalRecall } from "../src/grade.js";
import { defaultJudgeModel } from "../src/judge.js";
import { loadDotEnv } from "../src/env.js";
import { mapPool } from "../src/pool.js";

/** Floating-point slack for "the recomputed number equals the stored one".
 * The arithmetic is untouched, so anything above this is a real change. */
const EPS = 1e-9;

/** One MATCH judge call per case. No EXTRACT step — `findings.json` is already a
 * structured list, which is the whole reason `gradeInternalRecall` exists. */
const JUDGE_CALLS_PER_CASE = 1;

/** Concurrent judge calls. Temperature-0 calls are independent; kept low so a
 * back-fill never trips a rate limit the original run did not. */
const CONCURRENCY = 4;

/** Rough per-million-token prices for the estimate ONLY, at the Sonnet-class
 * default judge. Deliberately an over-estimate: the number exists to stop a
 * surprise, not to bill anyone. Override the ceiling with `--max-spend`. */
const PRICE_IN_PER_M = 3;
const PRICE_OUT_PER_M = 15;
/** Output is a small fixed JSON shape (`{matches:[{finding,gold}]}`). */
const EST_OUTPUT_TOKENS = 400;

function die(msg: string): never {
  console.error(chalk.red(`backfill-pipeline: ${msg}`));
  process.exit(1);
}

// ── argv ────────────────────────────────────────────────────────────────────

interface Args {
  artifacts: string[];
  results?: string;
  scorecard?: string;
  envDir: string;
  write: boolean;
  yes: boolean;
  /** Refresh the deterministic half only; carry the stored judgement across. */
  noJudge: boolean;
  judgeModel?: string;
  maxSpend: number;
}

const VALUE_FLAGS = new Set(["--results", "--scorecard", "--env", "--judge-model", "--max-spend"]);

export function parseArgs(argv: string[]): Args {
  const out: Args = { artifacts: [], envDir: process.cwd(), write: false, yes: false, noJudge: false, maxSpend: 1.0 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--write") {
      out.write = true;
      continue;
    }
    if (a === "--yes" || a === "-y") {
      out.yes = true;
      continue;
    }
    if (a === "--no-judge") {
      out.noJudge = true;
      continue;
    }
    if (VALUE_FLAGS.has(a)) {
      const v = argv[++i];
      if (v === undefined) die(`${a} needs a value`);
      if (a === "--results") out.results = v;
      else if (a === "--scorecard") out.scorecard = v;
      else if (a === "--env") out.envDir = v;
      else if (a === "--judge-model") out.judgeModel = v;
      else {
        const n = Number(v);
        if (!Number.isFinite(n) || n <= 0) die(`--max-spend must be a positive number of USD, got "${v}"`);
        out.maxSpend = n;
      }
      continue;
    }
    if (a.startsWith("-")) die(`unknown flag ${a}`);
    out.artifacts.push(a);
  }
  return out;
}

// ── The archive → scorecard mapping ─────────────────────────────────────────

/**
 * The `YYYY-MM-DD_HHMMSS` a runId and its archive directory share.
 *
 * The archive names are hand-made (`2026-08-22_184650-wp3-run1`) and do NOT
 * carry the git SHA the runId ends with, so only the timestamp is common ground.
 * It is unique per run by construction (`makeRunId`), which is what makes this a
 * lookup rather than a guess.
 */
export function runStampOf(name: string): string | undefined {
  return /^(\d{4}-\d{2}-\d{2}_\d{6})/.exec(basename(name))?.[1];
}

/** Resolve one archive dir to its run directory under `--results`, or die
 * naming exactly what was ambiguous. The result is printed before any spend. */
export function findRunDir(resultsRoot: string, artifactDir: string): string {
  const stamp = runStampOf(artifactDir);
  if (!stamp) die(`"${basename(artifactDir)}" does not begin with a YYYY-MM-DD_HHMMSS run stamp; pass --scorecard instead`);
  let entries: string[];
  try {
    entries = readdirSync(resultsRoot);
  } catch {
    die(`cannot list --results ${resultsRoot}`);
  }
  const hits = entries.filter((e) => e.startsWith(stamp));
  if (!hits.length) die(`no run under ${resultsRoot} starts with "${stamp}" (from ${basename(artifactDir)})`);
  if (hits.length > 1) die(`"${stamp}" matches ${hits.length} runs under ${resultsRoot}: ${hits.join(", ")} — pass --scorecard`);
  return join(resultsRoot, hits[0]);
}

// ── Loading + writing ───────────────────────────────────────────────────────

function loadCard(path: string): Scorecard {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch {
    die(`cannot read scorecard at ${path}`);
  }
  try {
    return JSON.parse(raw) as Scorecard;
  } catch {
    die(`scorecard at ${path} is not valid JSON`);
  }
}

/** Atomic, matching `writeScorecard` and `rescore.ts`. */
function writeCard(path: string, card: Scorecard): void {
  const tmp = join(dirname(path), ".scorecard.backfill.tmp");
  writeFileSync(tmp, JSON.stringify(card, null, 2));
  renameSync(tmp, path);
}

// ── Rebuilding the judge's gold input ───────────────────────────────────────

/**
 * The case's gold set, reconstructed from what the scorecard stored.
 *
 * `trace.gold[]` carries description + severity but **not `file`/`line`**; the
 * file is recoverable for MISSED gold only, because it rides on
 * `falseNegatives`. (The same lossy spot `rescore.ts` documents — matched gold
 * simply has nowhere in the artifact to have kept it.) Order is `trace.gold`'s,
 * so `goldToFinding[j]` indexes the same gold finding the posted grade did.
 *
 * `null` when the case was never traced: no gold text ⇒ nothing to judge, and
 * inventing one would be worse than skipping the case.
 */
export function goldFor(r: InstanceResult): GoldComment[] | null {
  const trace = r.review?.trace;
  if (!trace?.gold?.length) return null;
  const fileByDescription = new Map((r.review?.falseNegatives ?? []).map((g) => [g.description, g.file]));
  return trace.gold.map((g) => ({
    description: g.description,
    severity: g.severity as GoldComment["severity"],
    file: fileByDescription.get(g.description),
  }));
}

// ── Keeping the judged half (`--no-judge`) ──────────────────────────────────

/**
 * A freshly-read mechanism half, wearing the judgement the scorecard already
 * paid for.
 *
 * The split is not cosmetic. `withInternalRecall` builds the judged fields by
 * walking `internal.goldToFinding` back into `readout.findings` — it needs the
 * judge's reply, which only `internalGold` (the stored copy of that reply)
 * preserves, and only on runs measured after it existed. So the fields it
 * produced (`internalMatched`, `internalGold`, `inlineMatched`, and the
 * per-family `matched` / `internalMatched`) can only be CARRIED, never
 * recomputed, and this merge is the carry.
 *
 * Everything else on `fresh` wins outright: that is the point of re-reading.
 * Three rules earn their keep:
 *
 *  - **`prev === undefined` ⇒ `fresh`, unchanged.** A case that was never judged
 *    must not come out of here holding a number, and there is no shape of merge
 *    that could give it one.
 *  - **Only DEFINED values are copied.** A stored `internalUngraded` survives
 *    with `internalMatched` still absent, which is the one distinction the whole
 *    "a judge outage is not a recall of zero" rule rests on.
 *  - **A family the fresh read no longer knows is kept** for its judged columns
 *    alone. `withInternalRecall` mints a family row for a matched finding whose
 *    family has no obligations and no hypotheses file, so such a row legitimately
 *    exists in `prev` and legitimately does not in `fresh`; dropping it would
 *    silently lose a match.
 */
export function mergePreservedJudgement(
  fresh: ReviewPipelineStats,
  prev: ReviewPipelineStats | undefined,
): ReviewPipelineStats {
  if (!prev) return fresh;

  const byFamily: Record<string, ReviewFamilyStats> = {};
  for (const [name, f] of Object.entries(fresh.byFamily ?? {})) byFamily[name] = { ...f };
  for (const [name, f] of Object.entries(prev.byFamily ?? {})) {
    if (f.matched === undefined && f.internalMatched === undefined) continue;
    const target = (byFamily[name] ??= {});
    if (f.matched !== undefined) target.matched = f.matched;
    if (f.internalMatched !== undefined) target.internalMatched = f.internalMatched;
  }

  return {
    ...fresh,
    ...(prev.internalMatched !== undefined ? { internalMatched: prev.internalMatched } : {}),
    // The judge's per-gold reply — as unrecomputable as the count it sums to,
    // so it is carried on exactly the same terms.
    ...(prev.internalGold !== undefined ? { internalGold: prev.internalGold } : {}),
    ...(prev.inlineMatched !== undefined ? { inlineMatched: prev.inlineMatched } : {}),
    ...(prev.internalUngraded !== undefined ? { internalUngraded: prev.internalUngraded } : {}),
    // Not produced by `readPipelineArtifacts` at all (no artifact records it
    // yet), so re-reading would DELETE a stored value rather than refresh it.
    ...(prev.probes !== undefined ? { probes: prev.probes } : {}),
    ...(Object.keys(byFamily).length ? { byFamily } : {}),
  };
}

/**
 * The judged half as one comparable string — the assertion behind `--no-judge`.
 *
 * `publishedDrift` guards the numbers a reader already saw; this guards the
 * numbers a *wallet* already bought. Family order is sorted rather than
 * insertion-ordered because `fresh` and `prev` build `byFamily` from different
 * inputs, and a re-ordered object is not a changed measurement.
 */
export function judgedHalf(stats: ReviewPipelineStats | undefined): string {
  if (!stats) return "(no stats)";
  const families: Record<string, ReviewFamilyStats> = {};
  for (const name of Object.keys(stats.byFamily ?? {}).sort()) {
    const f = stats.byFamily![name];
    if (f.matched === undefined && f.internalMatched === undefined) continue;
    families[name] = {
      ...(f.matched !== undefined ? { matched: f.matched } : {}),
      ...(f.internalMatched !== undefined ? { internalMatched: f.internalMatched } : {}),
    };
  }
  return JSON.stringify({
    internalMatched: stats.internalMatched ?? null,
    // `null` here means ABSENT; a stored all-null vector serialises as
    // `[null, …]`, so "not recorded" and "found nothing" cannot collide.
    internalGold: stats.internalGold ?? null,
    inlineMatched: stats.inlineMatched ?? null,
    internalUngraded: stats.internalUngraded ?? null,
    families,
  });
}

// ── The plan (free) ─────────────────────────────────────────────────────────

type Skip = "no-artifacts" | "no-trace" | "no-gold" | "no-findings";

interface CasePlan {
  instanceId: string;
  artifactDir: string;
  result: InstanceResult;
  readout?: PipelineReadout;
  gold?: GoldComment[];
  /** Why this case will not be judged, when it will not be. */
  skip?: Skip;
  /** Estimated prompt characters for the one MATCH call. */
  promptChars: number;
  /**
   * The `review.pipeline` the scorecard arrived with, captured BEFORE anything
   * is assigned over it.
   *
   * It is what `--no-judge` carries forward and what the judged-half check is
   * read against. Holding the reference is enough because every write below
   * assigns a NEW object rather than mutating this one.
   */
  prior?: ReviewPipelineStats;
}

interface RunPlan {
  artifactRoot: string;
  scorecardPath: string;
  card: Scorecard;
  cases: CasePlan[];
}

function planRun(artifactRoot: string, scorecardPath: string): RunPlan {
  const card = loadCard(scorecardPath);
  const cases: CasePlan[] = [];
  for (const r of gradedReviews(card.results ?? [])) {
    const artifactDir = join(artifactRoot, r.instance_id, "pr-review");
    const plan: CasePlan = { instanceId: r.instance_id, artifactDir, result: r, promptChars: 0, prior: r.review?.pipeline };
    const readout = readPipelineArtifacts(artifactDir);
    if (!readout) {
      plan.skip = "no-artifacts";
      cases.push(plan);
      continue;
    }
    plan.readout = readout;
    const gold = goldFor(r);
    if (!gold) {
      // A case the judge never traced — or the empty-gold precision canary.
      plan.skip = r.review!.gold === 0 ? "no-gold" : "no-trace";
      cases.push(plan);
      continue;
    }
    plan.gold = gold;
    if (!readout.findings.length) {
      plan.skip = "no-findings";
      cases.push(plan);
      continue;
    }
    // The same payload `gradeInternalRecall` will build, used only to size the
    // estimate. Cheaper than being surprised.
    plan.promptChars = JSON.stringify({ findings: internalJudgeInputs(readout.findings), gold }).length;
    cases.push(plan);
  }
  return { artifactRoot, scorecardPath, card, cases };
}

const judgeable = (p: RunPlan): CasePlan[] => p.cases.filter((c) => !c.skip);

// ── The history check ───────────────────────────────────────────────────────

/**
 * Every already-published number must come back bit-identical.
 *
 * A back-fill ADDS `review.pipeline` (and therefore the `boundaries`/`families`
 * columns that were always `undefined`). It must not be able to move
 * precision/recall/F-beta or any micro count — those are what every prior
 * decision was made on, and a silent rewrite of them would be undetectable.
 */
export function publishedDrift(before: ModelSummary[], after: ModelSummary[]): string[] {
  const drift: string[] = [];
  for (const b of before) {
    const a = after.find((m) => m.model === b.model);
    if (!a) {
      drift.push(`${b.model}: arm disappeared on re-summarise`);
      continue;
    }
    for (const k of ["avgPrecision", "avgRecall", "avgFbeta", "reviewTotal", "behavioralOk", "codeFixResolved"] as const) {
      if (Math.abs((b[k] ?? 0) - (a[k] ?? 0)) > EPS) drift.push(`${b.model}: ${k} ${b[k]} → ${a[k]}`);
    }
    // The micro block is the recall-first headline; it is published too.
    for (const k of ["posted", "gold", "matched"] as const) {
      const x = b.micro?.[k];
      const y = a.micro?.[k];
      if (x !== undefined && x !== y) drift.push(`${b.model}: micro.${k} ${x} → ${y}`);
    }
    const br = b.micro?.microRecall;
    const ar = a.micro?.microRecall;
    if (br != null && ar != null && Math.abs(br - ar) > EPS) drift.push(`${b.model}: micro.microRecall ${br} → ${ar}`);
  }
  return drift;
}

// ── Reporting ───────────────────────────────────────────────────────────────

/** The comparison the whole back-fill exists to produce: what the pipeline KNEW
 * against what the reviewer SAID, over the same cases. */
interface RecallReport {
  /** Cases whose internal pass was graded cleanly. */
  graded: string[];
  internalMatched: number;
  postedMatched: number;
  gold: number;
  /** Named exclusions, never folded in as zeros. */
  ungraded: { instanceId: string; why: string }[];
}

function recallReport(plans: CasePlan[]): RecallReport {
  const out: RecallReport = { graded: [], internalMatched: 0, postedMatched: 0, gold: 0, ungraded: [] };
  for (const c of plans) {
    const stats = c.result.review?.pipeline;
    if (c.skip) {
      out.ungraded.push({ instanceId: c.instanceId, why: skipReason(c.skip, c.result) });
      continue;
    }
    if (!stats || stats.internalUngraded) {
      out.ungraded.push({ instanceId: c.instanceId, why: stats?.internalUngraded ?? "no stats produced" });
      continue;
    }
    if (stats.internalMatched === undefined) {
      out.ungraded.push({ instanceId: c.instanceId, why: "internal recall not measured" });
      continue;
    }
    out.graded.push(c.instanceId);
    out.internalMatched += stats.internalMatched;
    out.postedMatched += c.result.review!.matched;
    out.gold += c.result.review!.gold;
  }
  return out;
}

function skipReason(skip: Skip, r: InstanceResult): string {
  switch (skip) {
    case "no-artifacts":
      return "no preserved .lastlight/pr-review artifacts for this case";
    case "no-trace":
      return `no judge trace stored (${r.review?.gold ?? 0} gold), so the gold text cannot be reconstructed`;
    case "no-gold":
      return "empty gold set (the precision canary) — nothing to recall";
    case "no-findings":
      return "the pipeline generated no findings at all";
  }
}

/** The mechanism metrics, summed over a run — the numbers 08-evals.md says the
 * WP gates are actually read on (n in the hundreds, not 25). */
function mechanismSummary(plans: CasePlan[]): {
  obligations: number;
  hypotheses: number;
  discharged: number;
  cleanDischarges: number;
  unprovenanced: number;
  codes: Record<string, number>;
  tiers: Record<string, number>;
  coverage: Record<string, number>;
} {
  const acc = {
    obligations: 0,
    hypotheses: 0,
    discharged: 0,
    cleanDischarges: 0,
    unprovenanced: 0,
    codes: {} as Record<string, number>,
    tiers: {} as Record<string, number>,
    coverage: {} as Record<string, number>,
  };
  for (const c of plans) {
    const s: ReviewPipelineStats | undefined = c.result.review?.pipeline ?? c.readout?.stats;
    if (!s) continue;
    acc.obligations += s.obligations ?? 0;
    acc.hypotheses += s.hypotheses ?? 0;
    acc.discharged += s.discharged ?? 0;
    acc.cleanDischarges += s.cleanDischarges ?? 0;
    acc.unprovenanced += s.unprovenanced ?? 0;
    for (const [k, v] of Object.entries(s.dischargeCodes ?? {})) acc.codes[k] = (acc.codes[k] ?? 0) + v;
    for (const [k, v] of Object.entries(s.tiers ?? {})) acc.tiers[k] = (acc.tiers[k] ?? 0) + (v ?? 0);
    if (s.coverage) acc.coverage[s.coverage] = (acc.coverage[s.coverage] ?? 0) + 1;
  }
  return acc;
}

/**
 * Ask before spending.
 *
 * **Non-interactive is a REFUSAL here, not consent.** `rescore.ts` treats a
 * missing TTY as consent, and that is right there: its spending mode is behind an
 * explicit `--repeat-judge N` flag, so the flag is the opt-in. This script spends
 * on its plain invocation, so the same rule would mean a pipe — `… | head`, a CI
 * step, a shell function — bought a round of judge calls without anyone typing
 * anything. (It did, once, while this was being written.) Non-TTY therefore
 * requires `--yes` to be spelled out.
 */
async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log(chalk.yellow("stdin is not a TTY and --yes was not passed — refusing to spend. Nothing spent."));
    return false;
  }
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

// ── main ────────────────────────────────────────────────────────────────────

async function main(): Promise<number> {
  const args = parseArgs(process.argv.slice(2));
  if (!args.artifacts.length) die("need at least one preserved-artifact directory. See the usage header in this file.");
  if (args.scorecard && args.artifacts.length > 1) die("--scorecard applies to a single archive; use --results for several");
  if (!args.scorecard && !args.results) die("need --results <eval-results/<tier>> (or --scorecard for a single archive)");

  loadDotEnv(resolve(args.envDir));
  // `--no-judge` resolves no model on purpose: `defaultJudgeModel()` throws
  // without a provider key, and a mode that cannot call a model has no business
  // demanding one. It is also the difference between this being runnable on a
  // machine with no keys at all and not.
  let judgeModel: string | undefined;
  if (!args.noJudge) {
    try {
      judgeModel = args.judgeModel ?? defaultJudgeModel();
    } catch (err) {
      return die(`${(err as Error).message} — pass --env <dir with .env> or --judge-model`);
    }
  }

  // ── Resolve the mapping, and PRINT it ─────────────────────────────────────
  const plans: RunPlan[] = args.artifacts.map((a) => {
    const root = resolve(a);
    if (!existsSync(root) || !statSync(root).isDirectory()) die(`${root} is not a directory`);
    const scorecardPath = args.scorecard ? resolve(args.scorecard) : join(findRunDir(resolve(args.results!), root), "scorecard.json");
    return planRun(root, scorecardPath);
  });

  const totalCalls = plans.reduce((a, p) => a + judgeable(p).length, 0) * JUDGE_CALLS_PER_CASE;
  const promptChars = plans.reduce((a, p) => a + judgeable(p).reduce((b, c) => b + c.promptChars, 0), 0);
  // ≈4 chars/token is the usual English rule of thumb; the system prompt adds a
  // fixed few hundred. Over-estimating is the safe direction here.
  const estIn = Math.ceil(promptChars / 4) + totalCalls * 600;
  const estUsd = (estIn / 1e6) * PRICE_IN_PER_M + ((totalCalls * EST_OUTPUT_TOKENS) / 1e6) * PRICE_OUT_PER_M;

  const withArtifacts = (p: RunPlan): number => p.cases.filter((c) => c.readout).length;
  const withJudgement = (p: RunPlan): number => p.cases.filter((c) => c.prior?.internalMatched !== undefined).length;

  console.log(`\n${"─".repeat(78)}`);
  console.log(
    chalk.bold(
      args.noJudge
        ? `backfill-pipeline --no-judge — MECHANISM ONLY. No model call, no spend, nothing to consent to.`
        : `backfill-pipeline — mechanism metrics are FREE; internal recall SPENDS.`,
    ),
  );
  if (!args.noJudge) console.log(`  judge model   ${judgeModel}`);
  console.log(`  runs          ${plans.length}`);
  for (const p of plans) {
    const j = judgeable(p).length;
    console.log(`    ${chalk.cyan(p.card.meta?.runId ?? basename(dirname(p.scorecardPath)))}`);
    console.log(`      artifacts ${p.artifactRoot}`);
    console.log(`      scorecard ${p.scorecardPath}`);
    console.log(
      args.noJudge
        ? `      ${p.cases.length} graded case(s), ${withArtifacts(p)} with preserved artifacts, ` +
            `${withJudgement(p)} carrying a stored internal recall`
        : `      ${p.cases.length} graded case(s), ${j} judgeable, ${p.cases.length - j} skipped`,
    );
    if (!args.noJudge) {
      for (const c of p.cases.filter((x) => x.skip)) {
        console.log(chalk.dim(`        skip ${c.instanceId.padEnd(34)} ${skipReason(c.skip!, c.result)}`));
      }
    }
  }
  if (args.noJudge) {
    console.log(`  judge calls   ${chalk.bold("0")}   (the stored internalMatched / internalGold / inlineMatched / per-family matched are CARRIED, not recomputed)`);
    console.log(`  rewrites      obligations, hypotheses, discharge codes, clean discharges, unprovenanced,`);
    console.log(`                tiers, per-family obligations/hypotheses/posted, coverage, degraded, toolchain`);
  } else {
    console.log(`  judge calls   ${totalCalls}   (${JUDGE_CALLS_PER_CASE} MATCH call per case — no EXTRACT step; + 1 retry per errored case)`);
    console.log(`  est. cost     ${chalk.bold(`$${estUsd.toFixed(3)}`)}   (~${estIn.toLocaleString()} input tokens at $${PRICE_IN_PER_M}/M — an estimate, not a quote)`);
    console.log(`  ceiling       $${args.maxSpend.toFixed(2)}   (--max-spend)`);
  }
  console.log(
    `  mode          ${args.write ? chalk.yellow(`WRITE (atomic; refuses on any published-number drift${args.noJudge ? " OR any judged-half drift" : ""})`) : "read-only (pass --write to persist)"}`,
  );
  if (!args.noJudge) {
    console.log(`  caveats       the PR diff is not stored, so the internal match is diff-blind;`);
    console.log(`                gold file/line is absent for MATCHED gold (recoverable only for misses).`);
  }
  console.log(`${"─".repeat(78)}\n`);

  if (args.noJudge) {
    // The whole of `--no-judge`: re-read, keep the paid column. Cases with no
    // preserved artifacts keep whatever they had — an absent read is not a
    // measurement of zero, and deleting a stored row on the strength of a
    // missing directory would be the worst kind of "refresh".
    for (const p of plans) {
      for (const c of p.cases) {
        if (!c.readout) continue;
        c.result.review!.pipeline = mergePreservedJudgement(c.readout.stats, c.prior);
      }
    }
    return report(args, plans);
  }

  if (!totalCalls) {
    console.log(chalk.yellow("nothing to judge — no case has both stored gold and generated findings."));
    return 1;
  }
  if (estUsd > args.maxSpend) {
    die(`estimated $${estUsd.toFixed(3)} exceeds the --max-spend ceiling of $${args.maxSpend.toFixed(2)}. Refusing.`);
  }
  if (!args.yes && !(await confirm("Proceed?"))) {
    console.log("aborted — nothing spent.");
    return 0;
  }

  // ── Spend ─────────────────────────────────────────────────────────────────
  const jobs = plans.flatMap((p) => judgeable(p).map((c) => ({ p, c })));
  let done = 0;
  const retried: string[] = [];
  await mapPool(jobs, CONCURRENCY, async ({ c }) => {
    const call = () =>
      gradeInternalRecall({
        gold: c.gold!,
        findings: internalJudgeInputs(c.readout!.findings),
        judgeModel: judgeModel!,
        // No diff: it is not stored on a scorecard, so this is diff-blind even
        // for a run measured with `--judge-with-diff`. Stated in the header.
      });
    let internal = await call();
    // ONE retry on a judge failure, then give up and let it be excluded + named.
    // An excluded case is a real loss of measurement, and an unparseable reply is
    // often a one-off; retrying forever would hide a systematic failure, which is
    // why the retry is counted and reported rather than silent.
    if (internal?.error) {
      retried.push(c.instanceId);
      internal = await call();
    }
    // `withInternalRecall` handles `undefined` (nothing to measure) and the
    // error case (records `internalUngraded`, leaves `internalMatched` absent).
    c.result.review!.pipeline = withInternalRecall(c.readout!, internal);
    done++;
    if (process.stderr.isTTY) process.stderr.write(`\r  judging ${done}/${jobs.length} …   `);
  });
  if (process.stderr.isTTY) process.stderr.write("\r" + " ".repeat(40) + "\r");
  if (retried.length) {
    console.log(chalk.yellow(`\n  note: the judge failed once and was retried on ${retried.length} case(s): ${retried.join(", ")}`));
  }

  // Cases that were skipped still get their FREE mechanism stats — the discharge
  // histogram and the tier split do not need a judge, and dropping them because
  // there was no gold to match would throw away most of the instrument.
  for (const p of plans) {
    for (const c of p.cases) {
      if (c.skip && c.readout) c.result.review!.pipeline = c.readout.stats;
    }
  }

  return report(args, plans);
}

/**
 * Print what changed, check nothing that must not have changed did, and write.
 *
 * Shared by both modes deliberately: the published-number refusal and the
 * atomic write are the two things it would be most expensive to have a second,
 * subtly different copy of.
 */
function report(args: Args, plans: RunPlan[]): number {
  let failed = false;
  for (const p of plans) {
    const runId = p.card.meta?.runId ?? basename(dirname(p.scorecardPath));
    console.log(chalk.bold.cyan(`\n${runId}`));

    const posted = microReview(p.card.results ?? []);
    const rep = recallReport(p.cases);
    const mech = mechanismSummary(p.cases);

    console.log(chalk.bold(`\n  ${"case".padEnd(34)} ${"gold".padStart(4)} ${"posted".padStart(6)} ${"matched".padStart(7)} ${"gener'd".padStart(7)} ${"internal".padStart(8)}`));
    console.log(chalk.dim(`  ${"-".repeat(34)} ---- ------ ------- ------- --------`));
    for (const c of p.cases) {
      const s = c.result.review!.pipeline;
      const internal =
        c.skip ? chalk.dim("  —") : s?.internalUngraded ? chalk.red(" err") : s?.internalMatched !== undefined ? String(s.internalMatched) : "  ?";
      console.log(
        `  ${c.instanceId.padEnd(34)} ${String(c.result.review!.gold).padStart(4)} ${String(c.result.review!.posted).padStart(6)} ` +
          `${String(c.result.review!.matched).padStart(7)} ${String(c.readout?.findings.length ?? 0).padStart(7)} ${internal.padStart(8)}`,
      );
    }

    console.log(chalk.bold(`\n  POSTED vs INTERNAL`) + chalk.dim(`  (over the ${rep.graded.length} case(s) whose internal pass graded cleanly)`));
    const pr = rep.gold ? rep.postedMatched / rep.gold : null;
    const ir = rep.gold ? rep.internalMatched / rep.gold : null;
    console.log(`    posted recall     ${fmtRatio(pr)}   (${rep.postedMatched} of ${rep.gold})   ` + chalk.dim("what the reviewer SAID"));
    console.log(`    internal recall   ${chalk.bold(fmtRatio(ir))}   (${rep.internalMatched} of ${rep.gold})   ` + chalk.dim("what the pipeline KNEW"));
    if (pr !== null && ir !== null) {
      const gap = ir - pr;
      console.log(
        `    gap               ${gap >= 0 ? "+" : ""}${gap.toFixed(3)}   ` +
          chalk.dim(gap > 0 ? "found and not said — an attention-boundary problem, not a discovery ceiling" : "nothing was found that was not said"),
      );
    }
    console.log(chalk.dim(`    (whole-run posted micro-recall, all ${posted.cases} graded case(s): ${fmtRatio(posted.microRecall)} — ${posted.matched}/${posted.gold})`));
    if (rep.ungraded.length) {
      console.log(chalk.yellow(`\n  EXCLUDED from the two numbers above (${rep.ungraded.length}) — named, never folded in as 0.000:`));
      for (const u of rep.ungraded) console.log(chalk.yellow(`    ${u.instanceId.padEnd(34)} ${u.why}`));
      if (rep.ungraded.some((u) => !u.why.startsWith("no ") && !u.why.startsWith("empty"))) failed = true;
    }

    console.log(chalk.bold(`\n  MECHANISM`) + chalk.dim("  (deterministic, no judge — the n-in-the-hundreds gates)"));
    console.log(`    obligations ${mech.obligations}   hypotheses ${mech.hypotheses}   discharged-into-findings ${mech.discharged}`);
    console.log(`    discharge codes  ${Object.entries(mech.codes).map(([k, v]) => `${k}=${v}`).join("  ") || "none recorded"}`);
    const priorClean = p.cases.reduce((a, c) => a + (c.prior?.cleanDischarges ?? 0), 0);
    console.log(
      `    clean discharges ${mech.cleanDischarges}` +
        (args.noJudge ? chalk.dim(`  (stored: ${priorClean}${priorClean === mech.cleanDischarges ? ", unchanged" : ""})`) : "") +
        `   unprovenanced findings ${mech.unprovenanced}`,
    );
    console.log(`    tiers            ${Object.entries(mech.tiers).map(([k, v]) => `${k}=${v}`).join("  ") || "none recorded"}`);
    console.log(`    facts coverage   ${Object.entries(mech.coverage).map(([k, v]) => `${k}×${v}`).join("  ") || "not recorded"}`);

    // ── The judged half must be exactly what it was ─────────────────────────
    // `--no-judge` promises the expensive column is carried, not recomputed.
    // Assert it per case rather than trusting the merge: a bug here spends
    // nothing and destroys $0.66 of measurement, which is the worst trade in
    // this file.
    if (args.noJudge) {
      const moved = p.cases.filter((c) => judgedHalf(c.result.review?.pipeline) !== judgedHalf(c.prior));
      if (moved.length) {
        for (const c of moved) {
          console.error(chalk.red(`  ✗ ${c.instanceId}: the JUDGED half moved — ${judgedHalf(c.prior)} → ${judgedHalf(c.result.review?.pipeline)}`));
        }
        console.error(chalk.red(`  refusing to write: --no-judge may not touch what a judge was paid for`));
        failed = true;
        continue;
      }
      const carried = p.cases.filter((c) => c.prior?.internalMatched !== undefined).length;
      console.log(
        chalk.green(`    judged half      preserved byte-for-byte on all ${p.cases.length} case(s)`) +
          chalk.dim(` (${carried} carrying a stored internalMatched)`),
      );
    }

    // ── History check, then write ───────────────────────────────────────────
    const after = summarizeModels(p.card.results ?? []);
    const drift = publishedDrift(p.card.models ?? [], after);
    if (drift.length) {
      for (const d of drift) console.error(chalk.red(`  ✗ ${d} — the back-fill ALTERED HISTORY; refusing to write`));
      failed = true;
      continue;
    }
    if (args.write) {
      writeCard(p.scorecardPath, { ...p.card, models: after });
      console.log(chalk.green(`\n  ✓ written ${p.scorecardPath}`));
    }
  }

  if (!args.write) console.log(chalk.dim(`\n(read-only — pass --write to persist review.pipeline onto these scorecards)\n`));
  else console.log("");
  return failed ? 1 : 0;
}

// Only when run as a script — so the pure helpers above stay importable from a
// test, the same guard `band.ts` uses. A bare `main()` at module scope would
// mean importing this file to test `mergePreservedJudgement` invoked the whole
// back-fill, which in the spending mode is not a thing a test may do.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main()
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}

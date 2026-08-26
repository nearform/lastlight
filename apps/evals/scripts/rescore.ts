#!/usr/bin/env -S npx tsx
/**
 * Re-score an existing `scorecard.json` with the recall-first metrics — offline,
 * with **zero model spend**.
 *
 * `InstanceResult.review` already stores `posted` / `gold` / `matched`, the full
 * FP/FN lists and the judge trace. Micro-recall, SNR, the attention boundaries
 * and the per-family funnel are all arithmetic over those, so a run measured
 * before those metrics existed can gain them without being re-run. That is what
 * makes the shipped `pr-review` baseline usable as the comparator for every gate
 * in `docs/plans/deterministic-pr-levers.md` instead of costing a fresh arm.
 *
 * It also **verifies history was not rewritten**: the per-case means are
 * recomputed from the stored results and compared against the summary already on
 * disk. If they disagree, the metric change has altered history and must be
 * versioned rather than applied in place — so this exits non-zero and refuses to
 * write.
 *
 * READ-ONLY unless `--write`.
 *
 * ── `--repeat-judge N`: how much of the spread is the GRADER? ────────────────
 *
 * Everything above is free. `--repeat-judge N` is not: it re-runs the LLM judge
 * N times over the review text and gold set an existing scorecard already
 * stores, and reports the spread. That partitions grader noise from pipeline
 * noise — matching is entirely LLM-judged (`grade.ts` extract-then-match via
 * `judge.ts` at temperature 0), and `review-metrics.ts` puts LLM-judge/developer
 * agreement at 0.44–0.62, so a 0.320 ↔ 0.080 swing between two identical arms
 * could be the pipeline, the judge, or both, and nothing measured said which.
 * It SPENDS MONEY (2 judge calls per case per repeat), so it never runs by
 * default, prints its estimate first, and refuses to combine with `--write`.
 *
 * Usage:
 *   npx tsx scripts/rescore.ts <scorecard.json> [more.json ...] [--write] [--json]
 *   npx tsx scripts/rescore.ts <scorecard.json> --repeat-judge 3 [--yes]
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";

import type { GoldComment, InstanceResult } from "../src/schema.js";
import { fmtRatio, summarizeModels, type Scorecard } from "../src/report.js";
import { DETECTION_FLOOR_MICRO_RECALL, gradedReviews, microReview } from "../src/review-metrics.js";
import { collectMetricsFromFiles } from "../src/metrics.js";
import { gradeReview } from "../src/grade.js";
import { defaultJudgeModel } from "../src/judge.js";
import { loadDotEnv } from "../src/env.js";
import { mapPool } from "../src/pool.js";

/** Floating-point slack for "the recomputed mean equals the stored mean". The
 * arithmetic is identical, so anything above this is a real change in meaning. */
const EPS = 1e-9;

function die(msg: string): never {
  console.error(`rescore: ${msg}`);
  process.exit(1);
}

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

/** Atomic write, matching `writeScorecard` — a dashboard polling this file must
 * never read a half-written JSON. */
function writeCard(path: string, card: Scorecard): void {
  const tmp = join(dirname(path), ".scorecard.rescore.tmp");
  writeFileSync(tmp, JSON.stringify(card, null, 2));
  renameSync(tmp, path);
}

/**
 * Back-fill the per-phase latency/cost split onto a run measured before
 * `PhaseMetric.durationMs` was populated — with no re-run and no model spend.
 *
 * The evidence is already on disk: every archived `NN-<phase>.jsonl` carries the
 * `result` envelopes for that phase, and each one reports its own `duration_ms`.
 * Summing them reproduces the per-agent-call breakdown that previously had to be
 * read out of transcripts by hand.
 *
 * It fills {@link PhaseMetric.agentMs}, never `durationMs`: the wall-clock phase
 * window (which also covers provisioning and skill staging) was never recorded
 * for these runs, and writing a narrower number into the wider field would make
 * an old run silently incomparable with a new one.
 *
 * Returns how many phases it touched.
 */
function backfillPhaseTiming(card: Scorecard, scorecardPath: string): number {
  const runDir = dirname(scorecardPath);
  let filled = 0;
  for (const r of card.results ?? []) {
    if (!r.phases?.length) continue;
    const trial = r.sessionTrial ?? r.sessions?.[0];
    if (!trial?.phases?.length) continue;
    const logByPhase = new Map(trial.phases.map((p) => [p.phase, p.log]));
    for (const pm of r.phases) {
      if (pm.agentMs != null) continue; // already measured — never overwrite
      const rel = logByPhase.get(pm.phase);
      if (!rel) continue;
      const m = collectMetricsFromFiles([join(runDir, rel)]);
      if (m.agentMs <= 0) continue;
      pm.agentMs = m.agentMs;
      // Cost/tokens too when the run never recorded them per phase. The case-level
      // totals are untouched, so the history check above still governs.
      if (pm.costUsd == null) pm.costUsd = m.costUsd;
      if (pm.inputTokens == null) pm.inputTokens = m.inputTokens;
      if (pm.cachedTokens == null) pm.cachedTokens = m.cachedTokens;
      if (pm.outputTokens == null) pm.outputTokens = m.outputTokens;
      filled++;
    }
  }
  return filled;
}

// ── `--repeat-judge N` — grader noise, measured (SPENDS MONEY) ──────────────

/** Judge calls one case costs per repeat: extract, then match. */
const JUDGE_CALLS_PER_CASE = 2;

/** How many re-judges run at once. Temperature-0 calls are independent, so this
 * only buys wall clock; kept low so a re-judge never trips a rate limit that the
 * original run did not. */
const REJUDGE_CONCURRENCY = 4;

/**
 * Rebuild the judge's INPUTS for one already-graded case out of what the
 * scorecard stored, so a re-judge sees exactly the same thing twice.
 *
 * Two lossy spots, both reported rather than hidden:
 *  - `trace.reviewText` is capped at `TRACE_TEXT_CAP` (8 000 chars) where the
 *    live grade fed up to 24 000, so a very long review is re-judged truncated.
 *  - `trace.gold` carries description + severity but not `file`/`line`. The
 *    `file` is recoverable for MISSED gold (it rides on `falseNegatives`), never
 *    for matched gold. Both repeats see the same reconstruction, so the SPREAD
 *    is honest; the absolute level may sit slightly off the stored number, which
 *    is why the stored value is printed beside the samples instead of among them.
 */
function judgeInputsFor(r: InstanceResult): { gold: GoldComment[]; text: string; judgeModel: string } | null {
  const trace = r.review?.trace;
  if (!trace || !trace.reviewText.trim()) return null;
  const fileByDescription = new Map((r.review?.falseNegatives ?? []).map((g) => [g.description, g.file]));
  const gold: GoldComment[] = trace.gold.map((g) => ({
    description: g.description,
    severity: g.severity as GoldComment["severity"],
    file: fileByDescription.get(g.description),
  }));
  return { gold, text: trace.reviewText, judgeModel: trace.judgeModel };
}

/** One case, re-judged: the stored matched count and the N re-judged ones. */
interface RejudgedCase {
  instanceId: string;
  gold: number;
  storedMatched: number;
  samples: { matched: number; posted: number; error?: string }[];
}

async function repeatJudge(card: Scorecard, n: number, model: string): Promise<{ cases: RejudgedCase[]; perSample: InstanceResult[][] }> {
  const graded = gradedReviews(card.results ?? []).filter((r) => judgeInputsFor(r));
  const cases: RejudgedCase[] = graded.map((r) => ({
    instanceId: r.instance_id,
    gold: r.review!.gold,
    storedMatched: r.review!.matched,
    samples: [],
  }));
  // `perSample[s]` is a whole results array with sample `s`'s reviews spliced in,
  // so the arm-level numbers come out of `microReview` — the same definition the
  // scorecard uses — rather than a second copy of the arithmetic here.
  const perSample: InstanceResult[][] = Array.from({ length: n }, () => [...(card.results ?? [])]);

  const jobs = graded.flatMap((r, ci) => Array.from({ length: n }, (_, s) => ({ r, ci, s })));
  let done = 0;
  await mapPool(jobs, REJUDGE_CONCURRENCY, async ({ r, ci, s }) => {
    const inputs = judgeInputsFor(r)!;
    const grade = await gradeReview({
      gold: inputs.gold,
      reviews: [{ body: inputs.text, event: "COMMENT", comments: [] }],
      judgeModel: model,
      beta: r.review!.beta,
      // The stored `reviewText` is already the flattened body+inline blob; the
      // diff is NOT stored, so a `--judge-with-diff` run re-judges diff-blind.
      // Reported in the header rather than silently changing what is measured.
    });
    cases[ci].samples[s] = { matched: grade.matched, posted: grade.posted, error: grade.error };
    const idx = perSample[s].indexOf(r);
    if (idx >= 0) perSample[s][idx] = { ...r, review: { ...r.review!, ...grade } };
    done++;
    if (process.stderr.isTTY) process.stderr.write(`\r  re-judging ${done}/${jobs.length} …   `);
  });
  if (process.stderr.isTTY) process.stderr.write("\r" + " ".repeat(40) + "\r");
  return { cases, perSample };
}

/** Collapse a (possibly multi-line JSON) provider error to one short line, so a
 * per-case table stays a table. */
function oneLine(msg: string): string {
  return msg.replace(/\s+/g, " ").trim().slice(0, 90);
}

function spread(xs: number[]): { min: number; max: number; mean: number } | null {
  if (!xs.length) return null;
  return { min: Math.min(...xs), max: Math.max(...xs), mean: xs.reduce((a, b) => a + b, 0) / xs.length };
}

async function confirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) return true; // automation: the flag IS the consent
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await rl.question(`${question} [y/N] `)).trim().toLowerCase();
    return answer === "y" || answer === "yes";
  } finally {
    rl.close();
  }
}

async function runRepeatJudge(paths: string[], n: number, skipConfirm: boolean): Promise<number> {
  loadDotEnv(); // the judge needs a provider key, exactly as a live run does
  let model: string;
  try {
    model = defaultJudgeModel();
  } catch (err) {
    console.error(`rescore: ${(err as Error).message}`);
    return 1;
  }

  const loaded = paths.map((path) => {
    const card = loadCard(path);
    return { path, card, graded: gradedReviews(card.results ?? []).filter((r) => judgeInputsFor(r)).length };
  });
  const totalCalls = loaded.reduce((a, l) => a + l.graded, 0) * n * JUDGE_CALLS_PER_CASE;
  if (!totalCalls) {
    console.error("rescore: no case in these scorecards carries a judge trace to re-judge.");
    return 1;
  }

  console.log(`\n${"─".repeat(72)}`);
  console.log(`--repeat-judge ${n} — THIS SPENDS MONEY.`);
  console.log(`  judge model     ${model}`);
  console.log(`  scorecards      ${loaded.length}`);
  console.log(`  graded cases    ${loaded.reduce((a, l) => a + l.graded, 0)}`);
  console.log(`  judge calls     ${totalCalls}   (${JUDGE_CALLS_PER_CASE} per case per repeat: extract + match)`);
  console.log(`  measures        GRADER noise only — the pipeline output is fixed, read off disk.`);
  console.log(`  caveats         reviewText is the stored (8k-capped) copy; gold file/line is`);
  console.log(`                  absent for matched gold; the PR diff is not stored, so this is`);
  console.log(`                  diff-blind even for a --judge-with-diff run.`);
  console.log(`${"─".repeat(72)}\n`);
  if (!skipConfirm && !(await confirm("Proceed?"))) {
    console.log("aborted — nothing spent.");
    return 0;
  }

  /** Set when a scorecard could not produce a band (judge errors) — exit non-zero
   * so a script that shells out to this never reads "no band" as "no noise". */
  let failed = false;
  for (const { path, card } of loaded) {
    console.log(`\n${path}`);
    const { cases, perSample } = await repeatJudge(card, n, model);

    const storedMicro = microReview(card.results ?? []);
    const sampleMicro = perSample.map((results) => microReview(results));
    // A judge failure returns matched 0 / posted 0 — arithmetically identical to
    // "the judge ran and found nothing". Folding an errored sample into the band
    // therefore turns a TOTAL judge outage into a beautifully stable 0.000 spread,
    // which is the single most dangerous number this script could print. An
    // errored sample is EXCLUDED and named; `gradeReview` takes the same line
    // per case (`error` ⇒ ungraded, never a silent zero).
    const errorsPerSample = sampleMicro.map((_, s) => cases.filter((c) => c.samples[s]?.error).length);
    const cleanSamples = sampleMicro.map((m, s) => ({ m, s })).filter(({ s }) => errorsPerSample[s] === 0);
    const recalls = cleanSamples.map(({ m }) => m.microRecall).filter((v): v is number => v !== null);
    const band = recalls.length >= 2 ? spread(recalls) : null;

    console.log(`  stored micro-recall   ${fmtRatio(storedMicro.microRecall)}   (matched ${storedMicro.matched}/${storedMicro.gold})`);
    sampleMicro.forEach((m, i) => {
      const errs = errorsPerSample[i];
      const value = errs
        ? `ERRORED  (${errs}/${cases.length} case(s) — judge did not run; excluded from the band)`
        : `${fmtRatio(m.microRecall)}   (matched ${m.matched}/${m.gold}, posted ${m.posted})`;
      console.log(`  re-judge ${i + 1}            ${value}`);
    });
    if (band) {
      console.log(
        `  GRADER BAND           ${fmtRatio(band.max - band.min)}   (min ${fmtRatio(band.min)} · mean ${fmtRatio(band.mean)} · max ${fmtRatio(band.max)}, over ${recalls.length} clean repeat(s))`,
      );
      console.log(
        `    ↑ this much of any run-to-run spread is the judge, not the pipeline. A candidate's`,
      );
      console.log(
        `      Δ has to clear BOTH this and the arm's own --repeats band to mean anything.`,
      );
    } else {
      // Same rule as `VarianceRollup.band`: one point has no band, it has an
      // unmeasured one, and a zero band lets any delta clear it.
      console.log(
        `  GRADER BAND           NOT MEASURED — only ${recalls.length} of ${n} repeat(s) completed cleanly.` +
          (errorsPerSample.some(Boolean) ? " Fix the judge errors above and re-run." : ""),
      );
      failed = true;
    }
    if (storedMicro.gold > 0 && storedMicro.gold < 100) {
      console.log(`  ⚠ detection floor ≈ ${DETECTION_FLOOR_MICRO_RECALL.toFixed(2)} μrec on ${storedMicro.gold} gold findings`);
    }

    // A case is UNSTABLE only if it was judged every time and still disagreed;
    // one that errored is UNJUDGED, which is a different (and louder) problem.
    const judged = cases.filter((c) => c.samples.every((s) => s && !s.error));
    const unstable = judged.filter((c) => new Set(c.samples.map((s) => s.matched)).size > 1);
    console.log(`\n  per-case matched (stored → re-judges):`);
    for (const c of cases) {
      const errs = c.samples.filter((s) => s?.error).length;
      const flag = errs ? "  ← UNJUDGED" : unstable.includes(c) ? "  ← UNSTABLE" : "";
      console.log(
        `    ${c.instanceId.padEnd(40)} ${c.storedMatched}/${c.gold} → ${c.samples
          .map((s) => (s?.error ? "err" : (s?.matched ?? "?")))
          .join(", ")}${errs ? `  (${errs} judge error(s): ${oneLine(c.samples.find((s) => s?.error)!.error!)})` : ""}${flag}`,
      );
    }
    console.log(
      `\n  ${unstable.length}/${judged.length} fully-judged case(s) changed matched count across the repeats` +
        (judged.length < cases.length ? `; ${cases.length - judged.length} case(s) were never judged.` : "."),
    );
  }

  console.log(`\n(read-only — --repeat-judge never writes; these are a measurement of the grader, not a correction to the run.)\n`);
  return failed ? 1 : 0;
}

async function main(): Promise<number> {
  const args = process.argv.slice(2);
  const paths = args.filter((a) => !a.startsWith("--")).map((p) => resolve(p));
  const write = args.includes("--write");
  const asJson = args.includes("--json");
  if (!paths.length) die("need at least one scorecard path. See --help in the file header.");

  // `--repeat-judge N` is the one mode that spends. It is mutually exclusive with
  // `--write`: re-judged numbers are a measurement OF the grader, and persisting
  // them would rewrite the published number every gate compares against —
  // precisely what the history check below exists to prevent.
  const rjIdx = args.findIndex((a) => a === "--repeat-judge" || a.startsWith("--repeat-judge="));
  if (rjIdx >= 0) {
    const raw = args[rjIdx].includes("=") ? args[rjIdx].split("=")[1] : args[rjIdx + 1];
    const n = parseInt(raw ?? "", 10);
    if (!Number.isFinite(n) || n < 2) {
      die(`--repeat-judge needs a repeat count >= 2 (a single re-judge has no spread), got "${raw ?? ""}".`);
    }
    if (write) die("--repeat-judge cannot be combined with --write: a re-judge measures the grader, it does not correct the run.");
    return runRepeatJudge(
      paths.filter((p) => p !== resolve(raw ?? "")),
      n,
      args.includes("--yes") || args.includes("-y"),
    );
  }

  let drift = false;

  for (const path of paths) {
    const card = loadCard(path);
    const rescored = summarizeModels(card.results ?? []);
    const phasesFilled = backfillPhaseTiming(card, path);

    // ── The history check (AC5) ────────────────────────────────────────────
    // Every pre-existing field must come back bit-identical. A metric addition
    // is allowed to ADD columns; it is not allowed to change what an old run
    // said it scored.
    for (const before of card.models ?? []) {
      const after = rescored.find((m) => m.model === before.model);
      if (!after) {
        console.error(`  ✗ ${before.model}: arm disappeared on re-score`);
        drift = true;
        continue;
      }
      for (const k of ["avgPrecision", "avgRecall", "avgFbeta", "reviewTotal", "behavioralOk", "codeFixResolved"] as const) {
        if (Math.abs((before[k] ?? 0) - (after[k] ?? 0)) > EPS) {
          console.error(`  ✗ ${before.model}: ${k} ${before[k]} → ${after[k]} — the metric change ALTERED HISTORY; version it instead`);
          drift = true;
        }
      }
    }

    if (asJson) {
      console.log(JSON.stringify({ path, models: rescored }, null, 2));
    } else {
      console.log(`\n${path}`);
      const meta = card.meta;
      if (meta) console.log(`  run ${meta.runId}  tiers=${(meta.tiers ?? []).join("+")}  ${meta.generatedAt ?? ""}`);
      if (phasesFilled) console.log(`  + per-phase timing back-filled for ${phasesFilled} phase(s) from the archived transcripts`);
      for (const m of rescored) {
        const mi = m.micro;
        if (!mi) {
          console.log(`  ${m.model}: no graded reviews`);
          continue;
        }
        console.log(`  ${m.model}`);
        console.log(`    posted=${mi.posted}  gold=${mi.gold}  matched=${mi.matched}   (${mi.cases} graded case(s))`);
        console.log(`    micro-recall     ${fmtRatio(mi.microRecall)}      ← the headline`);
        console.log(`    micro-precision  ${fmtRatio(mi.microPrecision)}`);
        console.log(`    micro-F1         ${fmtRatio(mi.microF1)}`);
        console.log(`    SNR              ${fmtRatio(mi.snr)}      (matched per unmatched posted)`);
        console.log(`    comments/PR      ${mi.commentsPerPr.toFixed(2)}`);
        console.log(`    per-case means   prec ${m.avgPrecision.toFixed(3)}  rec ${m.avgRecall.toFixed(3)}  F${m.reviewBeta ?? 1} ${m.avgFbeta.toFixed(3)}`);
        if (mi.emptyGoldCases.length) {
          console.log(`    ⚠ empty-gold (precision canary, free 1.00 in the means): ${mi.emptyGoldCases.join(", ")}`);
        }
        if (mi.gold > 0 && mi.gold < 100) {
          console.log(`    ⚠ detection floor ≈ ${DETECTION_FLOOR_MICRO_RECALL.toFixed(2)} μrec on ${mi.gold} gold findings — below it, movement is not distinguishable from chance`);
        }
        if (m.boundaries) {
          const b = m.boundaries;
          console.log(`    internal-recall  ${fmtRatio(b.internalRecall)}  (${b.internalMatched} matched, ${b.internalCount} recorded-not-posted)`);
          console.log(`    inline           ${b.inlinePosted} posted, ${b.inlineMatched} matched, prec ${fmtRatio(b.inlinePrecision)}, ${b.inlinePerPr.toFixed(2)}/PR`);
        }
        for (const f of m.families ?? []) {
          const funnel = `${f.obligations} → ${f.hypotheses} → ${f.posted} → ${f.matched}`;
          console.log(`    family ${f.family.padEnd(12)} ${funnel}${f.notMeasured ? "   [NOT MEASURED]" : ""}`);
        }
      }
    }

    if (write && !drift) {
      // `card` already carries the back-filled `results[]` (mutated in place).
      writeCard(path, { ...card, models: rescored });
      console.log(`  ✓ written`);
    }
  }

  if (drift) {
    console.error(`\nrescore: REFUSING to write — re-scoring changed a published number.`);
    return 1;
  }
  if (!write) console.log(`\n(read-only — pass --write to persist the new columns)\n`);
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

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
 * in `docs/plans/review-evidence-pipeline/` instead of costing a fresh arm.
 *
 * It also **verifies history was not rewritten**: the per-case means are
 * recomputed from the stored results and compared against the summary already on
 * disk. If they disagree, the metric change has altered history and must be
 * versioned rather than applied in place — so this exits non-zero and refuses to
 * write.
 *
 * READ-ONLY unless `--write`.
 *
 * Usage:
 *   npx tsx scripts/rescore.ts <scorecard.json> [more.json ...] [--write] [--json]
 */

import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import type { Scorecard } from "../src/schema.js";
import { fmtRatio, summarizeModels } from "../src/report.js";
import { DETECTION_FLOOR_MICRO_RECALL } from "../src/review-metrics.js";
import { collectMetricsFromFiles } from "../src/metrics.js";

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

function main(): void {
  const args = process.argv.slice(2);
  const paths = args.filter((a) => !a.startsWith("--")).map((p) => resolve(p));
  const write = args.includes("--write");
  const asJson = args.includes("--json");
  if (!paths.length) die("need at least one scorecard path. See --help in the file header.");

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
    process.exit(1);
  }
  if (!write) console.log(`\n(read-only — pass --write to persist the new columns)\n`);
}

main();

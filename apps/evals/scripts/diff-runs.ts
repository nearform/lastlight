#!/usr/bin/env -S npx tsx
/**
 * Compare two eval runs' `scorecard.json` for the pr-review self-improvement loop.
 *
 * Reads a BASELINE and a CANDIDATE scorecard and reports, for one arm (model):
 *   - per-case F1 before → after with Δ and a ▲/▼/= flag (regressions marked),
 *   - the arm-summary delta (avg precision / recall / F1),
 *   - and — given a TRAIN / HELD-OUT id split — the mean-F1 delta per split plus
 *     the loop's KEEP/REVERT verdict (KEEP iff train improves AND held-out does
 *     not regress beyond an epsilon).
 *
 * This is the honesty gate made mechanical: a change is kept only if it
 * generalizes to the blind held-out cases, not just the ones the loop diagnosed.
 *
 * READ-ONLY — it never writes or mutates anything.
 *
 * Usage:
 *   npx tsx scripts/diff-runs.ts <baseline-scorecard.json> <candidate-scorecard.json> \
 *       [--model <label>] [--train id1,id2,...] [--heldout id3,id4,...] \
 *       [--epsilon 0.01] [--symmetric]
 *
 * With no split, it prints just the per-case + arm deltas (no verdict). `--model`
 * selects the arm when a scorecard holds several (a `--compare` run); with one
 * arm it's inferred. Ids are exact `instance_id`s (as in `--instance`).
 *
 * `--symmetric` swaps the default (train-driven) gate for the paper's
 * non-regressive rule — KEEP iff neither split regresses beyond epsilon AND at
 * least one improves beyond it (`trainΔ ≥ -eps ∧ heldoutΔ ≥ -eps ∧
 * max(trainΔ,heldoutΔ) > eps`). Use it when a best-of-K candidate may legitimately
 * be held-out-driven with flat train; the default stays asymmetric because train
 * is the diagnosis set. Either way it emits a machine-readable, split-partitioned
 * `REGRESSED(train)/REGRESSED(heldout)` line — only the train ids may feed the
 * next round's mine-failures.ts (`--baseline`); held-out ids stay informational.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// `Scorecard`/`ModelSummary` live in report.ts, not schema.ts. This file sits
// outside the `src` rootDir so `tsc --noEmit` never checks it, and type imports
// erase at runtime — so importing them from the wrong module resolved to
// nothing and failed silently rather than erroring.
import type { InstanceResult } from "../src/schema.js";
import type { Scorecard, ModelSummary } from "../src/report.js";
import { microReview, pairedRecall, DETECTION_FLOOR_MICRO_RECALL } from "../src/review-metrics.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function ids(name: string): string[] {
  return (flag(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
function die(msg: string): never {
  console.error(`diff-runs: ${msg}`);
  process.exit(1);
}

function loadCard(path: string): Scorecard {
  let raw: string;
  try {
    raw = readFileSync(resolve(path), "utf8");
  } catch {
    die(`cannot read scorecard at ${path}`);
  }
  try {
    return JSON.parse(raw) as Scorecard;
  } catch {
    die(`scorecard at ${path} is not valid JSON`);
  }
}

/** Pick the arm to compare: an explicit --model (exact, else case-insensitive
 * substring), else the sole arm when a run has exactly one. */
function pickModel(card: Scorecard, want: string | undefined, which: string): string {
  const labels = [...new Set(card.results.map((r) => r.model))];
  if (want) {
    const exact = labels.find((l) => l === want);
    if (exact) return exact;
    const fuzzy = labels.filter((l) => l.toLowerCase().includes(want.toLowerCase()));
    if (fuzzy.length === 1) return fuzzy[0];
    if (fuzzy.length > 1) die(`--model "${want}" is ambiguous in the ${which} run: ${fuzzy.join(", ")}`);
    die(`--model "${want}" not found in the ${which} run (have: ${labels.join(", ") || "none"})`);
  }
  if (labels.length === 1) return labels[0];
  die(`the ${which} run has ${labels.length} arms (${labels.join(", ")}); pass --model to choose one`);
}

/** instance_id → F1 for one arm (only graded pr-review cases). */
function fbetaByCase(card: Scorecard, model: string): Map<string, number> {
  const m = new Map<string, number>();
  for (const r of card.results) {
    if (r.model === model && r.review) m.set(r.instance_id, r.review.fbeta);
  }
  return m;
}

/** One arm's graded pr-review results, for the micro/paired sections below. */
function armResults(card: Scorecard, model: string): InstanceResult[] {
  return card.results.filter((r) => r.model === model);
}

/** Restrict an arm's results to a split (all of them when the split is empty). */
function inSplit(results: InstanceResult[], split: Set<string>): InstanceResult[] {
  return split.size ? results.filter((r) => split.has(r.instance_id)) : results;
}

const ratio = (x: number | null | undefined) => (x === null || x === undefined || !Number.isFinite(x) ? "  n/a" : x.toFixed(3));

/**
 * Micro-recall, SNR and the paired significance for one slice.
 *
 * Micro-recall is the headline (`docs/plans/deterministic-pr-levers.md` §WP8)
 * because the per-case F1 mean weights a 1-gold case like a 6-gold one and hands
 * an empty-gold case a free 1.00. The McNemar line is the detection floor made
 * mechanical: on a 25-finding gold set ONE extra hit is p = 0.50, and without
 * that number printed beside the delta a reader will call a coin flip progress.
 */
function renderMicro(label: string, base: InstanceResult[], cand: InstanceResult[]): string[] {
  const b = microReview(base);
  const c = microReview(cand);
  if (!b.cases && !c.cases) return [];
  const paired = pairedRecall(base, cand);
  const d = (x: number | null, y: number | null) =>
    x === null || y === null ? "   —  " : delta(y - x);

  const out = [
    `  ${label.padEnd(9)} μrec ${ratio(b.microRecall)} → ${ratio(c.microRecall)}  ${d(b.microRecall, c.microRecall)}` +
      `   SNR ${ratio(b.snr)} → ${ratio(c.snr)}` +
      `   posted ${b.posted}→${c.posted}  matched ${b.matched}→${c.matched}  gold ${c.gold || b.gold}`,
  ];
  if (paired.gained || paired.lost) {
    out.push(
      `  ${" ".repeat(9)} paired: +${paired.gained} new / -${paired.lost} lost   ` +
        `McNemar p=${paired.oneSided.toFixed(3)} one-sided, ${paired.twoSided.toFixed(3)} two-sided` +
        `${paired.approximate ? "   (APPROXIMATE — a case had no judge trace; discordance is a lower bound)" : ""}`,
    );
  }
  return out;
}

function fmt(x: number | undefined): string {
  return x === undefined ? " n/a" : x.toFixed(3);
}
function delta(x: number | undefined): string {
  if (x === undefined) return "   —  ";
  const s = (x >= 0 ? "+" : "") + x.toFixed(3);
  return s.padStart(7);
}
function mark(base: number | undefined, cand: number | undefined, eps: number): string {
  if (base === undefined || cand === undefined) return "?";
  const d = cand - base;
  if (d > eps) return "▲";
  if (d < -eps) return "▼";
  return "=";
}
function mean(xs: number[]): number | undefined {
  return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : undefined;
}

function summaryFor(card: Scorecard, model: string): ModelSummary | undefined {
  return card.models.find((s) => s.model === model);
}

function main(): void {
  const [basePath, candPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!basePath || !candPath) {
    die("need two scorecard paths — <baseline.json> <candidate.json>. See --help in the file header.");
  }
  const eps = Number(flag("epsilon") ?? "0.005");
  if (!Number.isFinite(eps) || eps < 0) die(`--epsilon must be a non-negative number, got "${flag("epsilon")}"`);

  const base = loadCard(basePath);
  const cand = loadCard(candPath);
  const wantModel = flag("model");
  const baseModel = pickModel(base, wantModel, "baseline");
  const candModel = pickModel(cand, wantModel, "candidate");

  const baseF = fbetaByCase(base, baseModel);
  const candF = fbetaByCase(cand, candModel);
  const allIds = [...new Set([...baseF.keys(), ...candF.keys()])].sort();

  const train = new Set(ids("train"));
  const heldout = new Set(ids("heldout"));
  const splitOf = (id: string) => (train.has(id) ? "train" : heldout.has(id) ? "heldout" : "");

  console.log(`\nBASELINE  ${basePath}  [arm: ${baseModel}]`);
  console.log(`CANDIDATE ${candPath}  [arm: ${candModel}]`);
  console.log(`epsilon=${eps}  (Δ within ±epsilon counts as unchanged)\n`);

  // A grader-version mismatch means the Δ below measures the JUDGE, not the
  // arm: `match-v1` paired one-to-one, `match-v2` lets one comment carry two
  // golds and neutralizes sibling-round findings. Warn loudly rather than
  // refuse — the per-case table is still useful for eyeballing — but the
  // verdict line cannot be trusted across versions.
  const promptOf = (card: Scorecard, arm: string): string => {
    const versions = new Set(
      (card.results ?? [])
        .filter((r) => r.model === arm && r.review?.trace)
        .map((r) => r.review!.trace!.matchPrompt ?? "match-v1"),
    );
    return [...versions].sort().join("+") || "unknown";
  };
  const basePrompt = promptOf(base, baseModel);
  const candPrompt = promptOf(cand, candModel);
  if (basePrompt !== candPrompt) {
    console.log(
      `  ⚠ MATCH-PROMPT MISMATCH: baseline graded by ${basePrompt}, candidate by ${candPrompt}. ` +
        `The Δ measures the grader as much as the arm — re-grade one side (rescore cannot do this; re-run or re-judge) before trusting any verdict.\n`,
    );
  }

  // Per-case table.
  const hdrSplit = train.size || heldout.size ? "  split" : "";
  console.log(`  ${"instance_id".padEnd(38)}  base   cand    Δ      ${hdrSplit}`);
  console.log(`  ${"-".repeat(38)}  -----  -----  -------  ${hdrSplit ? "-------" : ""}`);
  const regressedIds: string[] = [];
  for (const id of allIds) {
    const b = baseF.get(id);
    const c = candF.get(id);
    const d = b !== undefined && c !== undefined ? c - b : undefined;
    if (d !== undefined && d < -eps) regressedIds.push(id);
    const sp = splitOf(id);
    const spCol = hdrSplit ? `  ${sp || "-"}` : "";
    console.log(`${mark(b, c, eps)} ${id.padEnd(38)}  ${fmt(b)}  ${fmt(c)}  ${delta(d)}${spCol}`);
  }

  // Arm summary delta.
  const bs = summaryFor(base, baseModel);
  const cs = summaryFor(cand, candModel);
  if (bs && cs) {
    const line = (label: string, x: number, y: number) =>
      `  ${label.padEnd(10)} ${x.toFixed(3)} → ${y.toFixed(3)}   ${delta(y - x)}`;
    console.log(`\nARM SUMMARY (all ${cs.reviewTotal} graded cases in each run):`);
    console.log(line("precision", bs.avgPrecision, cs.avgPrecision));
    console.log(line("recall", bs.avgRecall, cs.avgRecall));
    console.log(line(`F${cs.reviewBeta ?? 1}`, bs.avgFbeta, cs.avgFbeta));
  }

  // Micro-aggregated section — the headline for recall-first work, reported at
  // arm AND split level. The per-case means above stay for leaderboard parity.
  //
  // Micro-aggregation is only meaningful over the SAME cases: summing gold from
  // an 8-case baseline against a 1-case candidate compares two different
  // denominators and reads as a collapse. So both sides are restricted to the
  // cases BOTH runs graded, and anything dropped is named — an incomplete run
  // silently changing the denominator has produced a wrong verdict here before.
  const gradedIds = (c: Scorecard, m: string) =>
    new Set(c.results.filter((r) => r.model === m && r.review && !r.error).map((r) => r.instance_id));
  const baseIds = gradedIds(base, baseModel);
  const candIds = gradedIds(cand, candModel);
  const shared = new Set([...baseIds].filter((id) => candIds.has(id)));
  const onlyBase = [...baseIds].filter((id) => !shared.has(id));
  const onlyCand = [...candIds].filter((id) => !shared.has(id));
  if (onlyBase.length || onlyCand.length) {
    console.log(`\n⚠ INCOMPLETE COMPARISON — the two runs do not cover the same cases.`);
    console.log(`  compared on ${shared.size} shared case(s); the micro + verdict sections below use ONLY those.`);
    if (onlyBase.length) console.log(`  baseline-only  (${onlyBase.length}): ${onlyBase.sort().join(", ")}`);
    if (onlyCand.length) console.log(`  candidate-only (${onlyCand.length}): ${onlyCand.sort().join(", ")}`);
    console.log(`  The per-case table above still lists every case, with "n/a" where a run has none.`);
  }
  const baseArm = armResults(base, baseModel).filter((r) => shared.has(r.instance_id));
  const candArm = armResults(cand, candModel).filter((r) => shared.has(r.instance_id));
  const microLines = [
    ...renderMicro("arm", baseArm, candArm),
    ...(train.size ? renderMicro("train", inSplit(baseArm, train), inSplit(candArm, train)) : []),
    ...(heldout.size ? renderMicro("heldout", inSplit(baseArm, heldout), inSplit(candArm, heldout)) : []),
  ];
  if (microLines.length) {
    console.log(`\nMICRO (matched ÷ gold, summed — an empty-gold case cannot inflate it):`);
    for (const l of microLines) console.log(l);
    const goldTotal = microReview(candArm).gold || microReview(baseArm).gold;
    if (goldTotal > 0 && goldTotal < 100) {
      console.log(
        `\n  ⚠ ${goldTotal} gold findings — the paired detection floor is ≈ ${DETECTION_FLOOR_MICRO_RECALL.toFixed(2)} μrec.` +
          `\n    Read the McNemar p, not the Δ: one extra hit is p = 0.50. Gate on mechanism metrics.`,
      );
    }
  }

  // Split-aware verdict.
  if (train.size || heldout.size) {
    const meanOver = (m: Map<string, number>, set: Set<string>) =>
      mean([...set].map((id) => m.get(id)).filter((x): x is number => x !== undefined));
    const trainB = meanOver(baseF, train);
    const trainC = meanOver(candF, train);
    const heldB = meanOver(baseF, heldout);
    const heldC = meanOver(candF, heldout);
    const trainD = trainB !== undefined && trainC !== undefined ? trainC - trainB : undefined;
    const heldD = heldB !== undefined && heldC !== undefined ? heldC - heldB : undefined;

    console.log(`\nSPLIT MEANS (F1):`);
    if (train.size) console.log(`  train    ${fmt(trainB)} → ${fmt(trainC)}   ${delta(trainD)}  (${train.size} cases)`);
    if (heldout.size) console.log(`  heldout  ${fmt(heldB)} → ${fmt(heldC)}   ${delta(heldD)}  (${heldout.size} cases)`);

    const symmetric = process.argv.includes("--symmetric");
    let verdict: string;
    if (symmetric) {
      // Non-regressive gate (paper): KEEP iff neither split regresses beyond
      // epsilon AND at least one improves beyond it. For best-of-K candidates
      // that may legitimately be held-out-driven with flat train.
      const trainDown = trainD !== undefined && trainD < -eps;
      const heldDown = heldD !== undefined && heldD < -eps;
      const best = Math.max(trainD ?? -Infinity, heldD ?? -Infinity);
      if (trainD === undefined && heldD === undefined) {
        verdict = "INCONCLUSIVE — no split deltas to judge (symmetric)";
      } else if (trainDown || heldDown) {
        const which = [trainDown ? `train Δ ${delta(trainD).trim()}` : "", heldDown ? `held-out Δ ${delta(heldD).trim()}` : ""].filter(Boolean).join(", ");
        verdict = `REVERT — REGRESSED a split (symmetric): ${which}`;
      } else if (best > eps) {
        verdict = `KEEP — non-regressive and improved (symmetric; train Δ ${delta(trainD).trim()}, heldout Δ ${delta(heldD).trim()})`;
      } else {
        verdict = "INCONCLUSIVE — no split improved beyond epsilon (symmetric)";
      }
    } else {
      // Default: KEEP iff train improved AND held-out did not regress beyond
      // epsilon. If a split is absent we can't judge it — say so rather than
      // pretend. Train is the diagnosis set, so it must strictly improve.
      const trainUp = trainD !== undefined && trainD > eps;
      const heldNotDown = heldD === undefined ? undefined : heldD >= -eps;
      if (!train.size || trainD === undefined) {
        verdict = "INCONCLUSIVE — no train delta to judge improvement";
      } else if (!trainUp) {
        verdict = `REVERT — train did not improve (Δ ${delta(trainD).trim()})`;
      } else if (heldNotDown === undefined) {
        verdict = "REVIEW — train improved but no held-out set to confirm it generalizes";
      } else if (!heldNotDown) {
        verdict = `REVERT — OVERFIT: train ↑ but held-out regressed (Δ ${delta(heldD).trim()})`;
      } else {
        verdict = `KEEP — train ↑ and held-out held (train Δ ${delta(trainD).trim()}, heldout Δ ${delta(heldD!).trim()})`;
      }
    }
    // A verdict on runs that graded different cases is not a weak signal, it is
    // a wrong one: a split mean over 5 ids where 4 are missing compares one case
    // against five. Say INCOMPLETE rather than REVERT — the eval-loop skill
    // parses this line, and a false REVERT throws away a good candidate.
    if (onlyBase.length || onlyCand.length) {
      verdict = `INCOMPLETE — the runs graded different case sets (${shared.size} shared, ${onlyBase.length + onlyCand.length} unmatched); re-run the missing cases before judging. Original verdict on the partial data would have been: ${verdict}`;
    }
    console.log(`\nVERDICT: ${verdict}`);
    if (regressedIds.length) {
      console.log(`(note: ${regressedIds.length} individual case(s) regressed beyond epsilon — inspect before keeping)`);
      // Split-partitioned, machine-readable. Only the train ids may feed the next
      // round's mine-failures.ts --baseline; held-out ids stay informational
      // (feeding them into diagnosis would leak the blind split).
      const rTrain = regressedIds.filter((id) => train.has(id));
      const rHeld = regressedIds.filter((id) => heldout.has(id));
      if (rTrain.length) console.log(`REGRESSED(train): ${rTrain.join(",")}`);
      if (rHeld.length) console.log(`REGRESSED(heldout): ${rHeld.join(",")}`);
    }
  }
  console.log("");
}

main();

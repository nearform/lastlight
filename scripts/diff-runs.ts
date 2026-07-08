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

import type { Scorecard, InstanceResult, ModelSummary } from "../src/schema.js";

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

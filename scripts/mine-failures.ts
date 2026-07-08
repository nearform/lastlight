#!/usr/bin/env -S npx tsx
/**
 * Mine a pr-review `scorecard.json` for a RANKED evidence bundle of failure
 * signatures — the "weakness mining" step of the self-improvement loop.
 *
 * This is the mechanical version of reading judge traces by hand: it reads the
 * per-case `review.falseNegatives` (recall loss) and `review.falsePositives`
 * (precision loss), clusters them into signatures, and prints two ranked blocks
 * (recall first, then precision) so the loop can target the highest-impact,
 * systematic pattern instead of a one-off. Inspired by "Self-Harness: Harnesses
 * That Improve Themselves" (arXiv:2606.09498), whose weakness-mining stage
 * clusters failing traces by verifier-grounded signature rather than symptom.
 *
 * READ-ONLY — it never writes or mutates anything, and (like diff-runs.ts) it
 * reads ONLY the TRAIN split when `--train` is given, so the blind HELD-OUT set
 * stays blind. NEVER pass held-out ids here.
 *
 * Usage:
 *   npx tsx scripts/mine-failures.ts <scorecard.json> \
 *       [--model <label>] [--train id1,id2,...] [--keywords] \
 *       [--baseline <prev-train-scorecard.json>]
 *
 * With `--train` it mines only those ids; without it, every graded case in the
 * arm (a whole-run triage view — never use this form to diagnose during the
 * loop, it would read held-out cases). `--model` selects the arm when a run
 * holds several (a `--compare` run); with one arm it's inferred. `--keywords`
 * adds a heuristic category column guessed from the description text (labelled a
 * guess). `--baseline` diffs signature frequencies against a previous TRAIN
 * scorecard and marks worsened signatures with ▲ (feeds regressions back into
 * the next round without touching held-out).
 */

import { readFileSync } from "node:fs";
import { extname, resolve } from "node:path";

import type { Scorecard, InstanceResult } from "../src/schema.js";

// ── CLI plumbing (shared shape with scripts/diff-runs.ts) ────────────────────
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`);
}
function ids(name: string): string[] {
  return (flag(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);
}
function die(msg: string): never {
  console.error(`mine-failures: ${msg}`);
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
/** Pick the arm: an explicit --model (exact, else case-insensitive substring),
 * else the sole arm when a run has exactly one. */
function pickModel(card: Scorecard, want: string | undefined): string {
  const labels = [...new Set(card.results.map((r) => r.model))];
  if (want) {
    const exact = labels.find((l) => l === want);
    if (exact) return exact;
    const fuzzy = labels.filter((l) => l.toLowerCase().includes(want.toLowerCase()));
    if (fuzzy.length === 1) return fuzzy[0];
    if (fuzzy.length > 1) die(`--model "${want}" is ambiguous: ${fuzzy.join(", ")}`);
    die(`--model "${want}" not found (have: ${labels.join(", ") || "none"})`);
  }
  if (labels.length === 1) return labels[0];
  die(`the run has ${labels.length} arms (${labels.join(", ")}); pass --model to choose one`);
}

// ── Mining ───────────────────────────────────────────────────────────────────

type Review = NonNullable<InstanceResult["review"]>;

/** Severity → weight. A cluster of critical misses outranks many low ones,
 * matching where F1 gain is largest. Unknown/absent severities count as 1. */
const SEV_WEIGHT: Record<string, number> = { critical: 4, high: 3, medium: 2, low: 1 };
function sevWeight(sev: string): number {
  return SEV_WEIGHT[sev.toLowerCase()] ?? 1;
}

/** Coarse "area" of a finding: its file extension, else (global) when unlocated.
 * A deliberately blunt clustering key — a triage aid, not ground truth. */
function areaOf(file: string | undefined): string {
  if (!file) return "(global)";
  const ext = extname(file);
  return ext || "(global)";
}

/** A tiny, opt-in keyword lexicon (`--keywords`) that GUESSES a category from the
 * description. Fuzzy by construction — labelled "(guess)" in the output. */
const LEXICON: [string, RegExp][] = [
  ["security", /\b(security|auth|authz|authn|injection|xss|csrf|secret|token|credential|sanitiz)/i],
  ["concurrency", /\b(race|concurren|deadlock|lock|atomic|thread|async|await\b)/i],
  ["error-handling", /\b(error|exception|throw|catch|unhandled|reject|fallback|retry)/i],
  ["correctness", /\b(off-by-one|boundary|edge case|null|undefined|nan|overflow|incorrect|wrong)/i],
  ["perf", /\b(perf|performance|n\+1|allocation|memory|leak|slow|o\(n)/i],
  ["test", /\b(test|coverage|assert|mock|fixture)/i],
  ["style", /\b(nit|style|naming|typo|format|lint|readab)/i],
];
function categoryOf(desc: string): string {
  for (const [cat, re] of LEXICON) if (re.test(desc)) return cat;
  return "other";
}

interface Cluster {
  signature: string;
  count: number;       // number of findings in this signature
  weight: number;      // summed severity weight (recall); == count for precision
  cases: Set<string>;  // distinct instance_ids
  cats: Map<string, number>; // category tallies (only when --keywords)
}

/** Build signature clusters for one axis over the selected rows. */
function cluster(
  rows: InstanceResult[],
  axis: "recall" | "precision",
  keywords: boolean,
): Map<string, Cluster> {
  const out = new Map<string, Cluster>();
  for (const r of rows) {
    const rev = r.review as Review;
    const items =
      axis === "recall"
        ? rev.falseNegatives.map((f) => ({ desc: f.description, file: f.file, sev: f.severity }))
        : rev.falsePositives.map((f) => ({ desc: f.description, file: f.file, sev: "—" }));
    for (const it of items) {
      const sig = `${axis}·${it.sev}·${areaOf(it.file)}`;
      let c = out.get(sig);
      if (!c) {
        c = { signature: sig, count: 0, weight: 0, cases: new Set(), cats: new Map() };
        out.set(sig, c);
      }
      c.count += 1;
      c.weight += axis === "recall" ? sevWeight(it.sev) : 1;
      c.cases.add(r.instance_id);
      if (keywords) {
        const cat = categoryOf(it.desc);
        c.cats.set(cat, (c.cats.get(cat) ?? 0) + 1);
      }
    }
  }
  return out;
}

function domCategory(c: Cluster): string {
  let best = "";
  let n = -1;
  for (const [cat, k] of c.cats) if (k > n) [best, n] = [cat, k];
  return best || "-";
}

function exampleIds(cases: Set<string>): string {
  const arr = [...cases].sort();
  const head = arr.slice(0, 3).join(", ");
  return arr.length > 3 ? `${head}, +${arr.length - 3}` : head;
}

function main(): void {
  const positional = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  const cardPath = positional[0];
  if (!cardPath) die("need a scorecard path — <scorecard.json>. See the file header for usage.");

  const keywords = has("keywords");
  const card = loadCard(cardPath);
  const arm = pickModel(card, flag("model"));

  const trainIds = new Set(ids("train"));
  const scoped = trainIds.size > 0;

  // Graded pr-review rows only — mirror report.ts's "graded" filter (has a
  // review AND not errored/ungraded), optionally restricted to the TRAIN split.
  const rows = card.results.filter(
    (r) =>
      r.model === arm &&
      r.review &&
      !r.error &&
      (!scoped || trainIds.has(r.instance_id)),
  );

  console.log(`\nSCORECARD  ${cardPath}  [arm: ${arm}]`);
  console.log(
    scoped
      ? `SCOPE      TRAIN split — ${rows.length} graded case(s) of ${trainIds.size} train id(s)`
      : `SCOPE      ALL ${rows.length} graded case(s) (no --train — do NOT use to diagnose during the loop)`,
  );
  if (rows.some((r) => (r.reviewTrials ?? 1) > 1)) {
    console.log(`NOTE       --runs>1: false-positive/negative lists are the WORST trial per case.`);
  }
  const silent = rows.filter((r) => (r.review as Review).posted === 0).length;
  const nogold = rows.filter((r) => (r.review as Review).gold === 0).length;
  if (silent || nogold) {
    console.log(`CONTEXT    ${silent} case(s) posted nothing (all-recall-loss), ${nogold} with no gold (all-precision-loss).`);
  }

  const base = flag("baseline");
  const baseline = base ? loadCard(base) : undefined;
  const baseArm = baseline ? pickModel(baseline, flag("model")) : undefined;
  const baseRows = baseline
    ? baseline.results.filter(
        (r) => r.model === baseArm && r.review && !r.error && (!scoped || trainIds.has(r.instance_id)),
      )
    : [];

  for (const axis of ["recall", "precision"] as const) {
    const clusters = cluster(rows, axis, keywords);
    const prev = baseline ? cluster(baseRows, axis, false) : undefined;
    const sorted = [...clusters.values()].sort((a, b) =>
      axis === "recall" ? b.weight - a.weight || b.count - a.count : b.count - a.count,
    );
    const title =
      axis === "recall"
        ? "RECALL LOSS — missed gold (falseNegatives), ranked by severity weight"
        : "PRECISION LOSS — noise (falsePositives), ranked by frequency";
    console.log(`\n${title}`);
    if (!sorted.length) {
      console.log(`  (none)`);
      continue;
    }
    const metric = axis === "recall" ? "wt" : "  ";
    const catCol = keywords ? "  category(guess)" : "";
    const dCol = baseline ? "   Δ" : "";
    console.log(`  ${"signature".padEnd(30)}  ${metric}  freq  cases${dCol}${catCol}  examples`);
    console.log(`  ${"-".repeat(30)}  --  ----  -----${baseline ? "  ---" : ""}${keywords ? "  ---------------" : ""}  --------`);
    for (const c of sorted) {
      const wt = axis === "recall" ? String(c.weight).padStart(2) : "  ";
      let d = "";
      if (baseline) {
        const was = prev!.get(c.signature)?.count ?? 0;
        const dd = c.count - was;
        d = `  ${was === 0 ? " new" : (dd > 0 ? `▲+${dd}` : dd < 0 ? `▽${dd}` : "  =")}`.padEnd(5);
      }
      const cat = keywords ? `  ${domCategory(c).padEnd(15)}` : "";
      console.log(
        `  ${c.signature.padEnd(30)}  ${wt}  ${String(c.count).padStart(4)}  ${String(c.cases.size).padStart(5)}${d}${cat}  ${exampleIds(c.cases)}`,
      );
    }
  }

  const rClusters = cluster(rows, "recall", false).size;
  const pClusters = cluster(rows, "precision", false).size;
  console.log(`\nSUMMARY    ${rClusters} recall signature(s), ${pClusters} precision signature(s) over ${rows.length} case(s).`);
  console.log(`Target the top recall signature first (biggest F1 headroom), then the top precision one.\n`);
}

main();

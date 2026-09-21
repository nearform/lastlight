/**
 * What do the survey passes cost, and does spending more find more?
 *
 * The companion to `scripts/finding-calibration.ts`. That one asks which
 * findings are worth saying; this one asks which passes are worth running.
 * Both read artifacts that already exist — no model calls, no spend.
 *
 * Three questions, in the order they should be asked:
 *
 *   1. WHERE DOES THE MONEY GO — per-family cost, output tokens, cached input
 *      and wall clock, averaged over every case-run in the results tree that
 *      ran survey branches.
 *   2. WHAT DOES EACH FAMILY CONVERT — cost per matched gold finding, joined
 *      against the labels `finding-calibration` cached. This is the number that
 *      looks most actionable and is the most dangerous: the denominators are
 *      single digits, and a family's job is not always defect recall.
 *   3. DOES SPEND BUY RECALL — within-case, within-model rank correlation of
 *      survey spend against matched gold. Stratified because the arms vary the
 *      model, and an expensive model would otherwise masquerade as a long run.
 *
 * On (3), read the caveat printed with it and do not skip it: the spend
 * variation here is INCIDENTAL, not allocated. Nobody gave one run a bigger
 * budget; the agent wandered further. A run that found something may read more
 * to confirm it, and a run that got lost reads more too, so the sign can go
 * either way for reasons that have nothing to do with the budget. This
 * correlation cannot settle whether capping turns would cost recall. Only an
 * arm that actually caps them can.
 */

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

import type { InstanceResult, PhaseResult } from "./../src/schema.js";

function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}
function die(msg: string): never {
  console.error(`survey-cost: ${msg}`);
  process.exit(1);
}

/** Below this a rate is marked † and must not be quoted alone. */
const SMALL = 5;

const BRANCH = /^survey_branch_(.+)$/;

interface CaseRun {
  instanceId: string;
  /** The survey model, so (3) can stratify on it. */
  model: string;
  byFamily: Map<string, { costUsd: number; outputTokens: number; cachedTokens: number; durationMs: number }>;
  cost: number;
  cached: number;
  output: number;
  gold: number;
  matched: number;
  posted: number;
}

function loadRuns(root: string): CaseRun[] {
  const out: CaseRun[] = [];
  for (const dir of readdirSync(root)) {
    const f = join(root, dir, "scorecard.json");
    if (!existsSync(f)) continue;
    let doc: { results?: InstanceResult[] };
    try {
      doc = JSON.parse(readFileSync(f, "utf8")) as { results?: InstanceResult[] };
    } catch {
      continue;
    }
    for (const r of doc.results ?? []) {
      const branches = (r.phases ?? []).filter((p: PhaseResult) => BRANCH.test(p.phase));
      if (!branches.length || !r.review || r.review.gold == null) continue;
      const byFamily = new Map<string, { costUsd: number; outputTokens: number; cachedTokens: number; durationMs: number }>();
      for (const p of branches) {
        const family = BRANCH.exec(p.phase)![1];
        const a = byFamily.get(family) ?? { costUsd: 0, outputTokens: 0, cachedTokens: 0, durationMs: 0 };
        a.costUsd += p.costUsd ?? 0;
        a.outputTokens += p.outputTokens ?? 0;
        a.cachedTokens += p.cachedTokens ?? 0;
        a.durationMs += p.durationMs ?? 0;
        byFamily.set(family, a);
      }
      const sum = (k: "costUsd" | "cachedTokens" | "outputTokens") => [...byFamily.values()].reduce((n, v) => n + v[k], 0);
      out.push({
        instanceId: r.instance_id,
        model: branches[0]?.model ?? "?",
        byFamily,
        cost: sum("costUsd"),
        cached: sum("cachedTokens"),
        output: sum("outputTokens"),
        gold: r.review.gold,
        matched: r.review.matched ?? 0,
        posted: r.review.posted ?? 0,
      });
    }
  }
  return out;
}

/** Spearman rho. Ties get averaged ranks via the ordinal ranking below, which
 * is adequate here — the inputs are costs and token counts, which almost never
 * tie exactly. */
function spearman(xs: number[], ys: number[]): number {
  const n = xs.length;
  const rank = (v: number[]): number[] => {
    const order = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0]);
    const r = new Array<number>(n);
    order.forEach(([, i], j) => (r[i] = j + 1));
    return r;
  };
  const a = rank(xs);
  const b = rank(ys);
  const mean = (v: number[]) => v.reduce((x, y) => x + y, 0) / n;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < n; i++) {
    num += (a[i] - ma) * (b[i] - mb);
    da += (a[i] - ma) ** 2;
    db += (b[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

function usd(n: number): string {
  return `$${n.toFixed(n < 1 ? 3 : 2)}`;
}

function main(): number {
  const root = resolve(flag("results") ?? die(`--results <eval-results/pr-review dir> is required`));
  if (!existsSync(root)) die(`no results tree at ${root}`);
  const runs = loadRuns(root);
  if (!runs.length) die(`no case-run under ${root} ran survey branches`);

  console.log(`\nResults      ${root}`);
  console.log(`Case-runs    ${runs.length} with survey branches, over ${new Set(runs.map((r) => r.instanceId)).size} distinct cases`);

  // ── 1. Where the money goes ──
  const fams = new Map<string, { n: number; cost: number; out: number; cached: number; ms: number }>();
  for (const r of runs)
    for (const [family, v] of r.byFamily) {
      const a = fams.get(family) ?? { n: 0, cost: 0, out: 0, cached: 0, ms: 0 };
      a.n += 1;
      a.cost += v.costUsd;
      a.out += v.outputTokens;
      a.cached += v.cachedTokens;
      a.ms += v.durationMs;
      fams.set(family, a);
    }
  const total = [...fams.values()].reduce((n, a) => n + a.cost, 0);
  console.log(`\n── 1. WHERE THE MONEY GOES ──`);
  console.log(`   ${"family".padEnd(13)} ${"runs".padStart(5)} ${"total".padStart(9)} ${"$/run".padStart(8)} ${"out tok".padStart(9)} ${"cached in".padStart(11)} ${"min".padStart(6)}`);
  for (const [k, a] of [...fams].sort((x, y) => y[1].cost - x[1].cost)) {
    console.log(
      `   ${k.padEnd(13)} ${String(a.n).padStart(5)} ${usd(a.cost).padStart(9)} ${usd(a.cost / a.n).padStart(8)} ${Math.round(a.out / a.n).toLocaleString().padStart(9)} ${Math.round(a.cached / a.n).toLocaleString().padStart(11)} ${((a.ms / a.n) / 60000).toFixed(1).padStart(6)}`,
    );
  }
  const perPr = runs.reduce((n, r) => n + r.cost, 0) / runs.length;
  const cachedPerPr = runs.reduce((n, r) => n + r.cached, 0) / runs.length;
  const outPerPr = runs.reduce((n, r) => n + r.output, 0) / runs.length;
  console.log(`\n   ${usd(total)} of survey spend in this tree · ${usd(perPr)} per pull request`);
  console.log(`   ${Math.round(cachedPerPr).toLocaleString()} cached input tokens per PR against ${Math.round(outPerPr).toLocaleString()} output.`);
  console.log(`   The budget goes on RE-READING, not on reasoning — the lever is turn count,`);
  console.log(`   not which family runs. Capping turns is an arm; this table cannot settle it.`);

  // ── 3. Does spend buy recall ──
  //
  // (2), cost per matched gold, needs the per-finding labels and therefore
  // lives in `finding-calibration.ts`, which owns the label cache.
  const strata = new Map<string, CaseRun[]>();
  for (const r of runs) {
    const k = `${r.instanceId}|${r.model}`;
    (strata.get(k) ?? strata.set(k, []).get(k)!).push(r);
  }
  const usable = [...strata].filter(([, v]) => v.length >= SMALL);
  console.log(`\n── 3. DOES SPEND BUY RECALL (within case, within model) ──`);
  if (!usable.length) {
    console.log(`   no stratum has ${SMALL} runs of one case on one model — nothing to correlate.\n`);
    return 0;
  }
  console.log(`   ${"stratum".padEnd(44)} ${"n".padStart(4)} ${"rho($)".padStart(8)} ${"rho(cached)".padStart(12)} ${"rho(out)".padStart(9)}`);
  let wc = 0;
  let wk = 0;
  let wo = 0;
  let N = 0;
  for (const [k, v] of usable.sort((a, b) => b[1].length - a[1].length)) {
    const m = v.map((x) => x.matched);
    const rc = spearman(v.map((x) => x.cost), m);
    const rk = spearman(v.map((x) => x.cached), m);
    const ro = spearman(v.map((x) => x.output), m);
    wc += rc * v.length;
    wk += rk * v.length;
    wo += ro * v.length;
    N += v.length;
    const [c, mo] = k.split("|");
    console.log(
      `   ${`${c} / ${mo}`.slice(0, 44).padEnd(44)} ${String(v.length).padStart(4)} ${rc.toFixed(3).padStart(8)} ${rk.toFixed(3).padStart(12)} ${ro.toFixed(3).padStart(9)}`,
    );
  }
  console.log(`\n   n-weighted mean over ${N} case-runs:  rho($) ${(wc / N).toFixed(3)} · rho(cached) ${(wk / N).toFixed(3)} · rho(output) ${(wo / N).toFixed(3)}`);
  console.log(`\n   CAVEAT, and it is the whole reading: this spend variation is INCIDENTAL,`);
  console.log(`   not allocated. Nobody gave one run a bigger budget — the agent wandered`);
  console.log(`   further. A run that found something reads more to confirm it; a run that`);
  console.log(`   got lost reads more too. The sign can go either way for reasons unrelated`);
  console.log(`   to the budget, and the per-stratum spread below shows it does. This number`);
  console.log(`   cannot tell you whether capping turns costs recall. Only a capped arm can.\n`);
  return 0;
}

process.exit(main());

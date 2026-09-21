/**
 * Does anything the pipeline already RECORDS about a finding predict whether it
 * matches gold — better than the `confidence` the model volunteers?
 *
 * This is the say-side twin of `scripts/aacr-adjudicate.ts`. That script asks
 * whether a model handed a review comment can tell a correct one from an
 * incorrect one, and the answer, over 2,145 expert-labelled rows and three
 * unrelated models, is no: nothing has ever beaten posting everything. The
 * conclusion drawn there was that the comment TEXT is not enough. This script
 * tests the other half of that conclusion — we hold far more about each finding
 * than its text (which family produced it, how its supporting hypotheses
 * discharged, whether both ends of the mechanism were named, how many passes
 * converged on it, whether it is a defect claim or a verification report) and
 * none of it has ever been scored.
 *
 * Every axis here is **deterministic and free**. The only model call is the one
 * that produces the LABEL, and it is the same `gradeInternalRecall` pass a live
 * run makes, so a back-filled label and a live one cannot disagree.
 *
 * ── The floors, and why they are the whole point ───────────────────────────
 *
 *   post-everything   every finding posted. Recall 1.0 by construction,
 *                     precision = the base rate. This is the bar: an axis that
 *                     cannot beat it is trading recall for nothing.
 *   model-confidence  rank by `finding.confidence`. The incumbent — this is
 *                     what `review-poster.ts` reads today.
 *   adjudicator-tier  the tier the adjudicator actually assigned. Not a
 *                     candidate axis: the third floor, and the hardest, because
 *                     it is what production already does.
 *
 * Without those three rows in the table a plausible AUROC reads as a result.
 * With them, most plausible AUROCs read as a failure — which is the only reason
 * the AACR script was worth writing before the thing it grades.
 *
 * ── Usage ──────────────────────────────────────────────────────────────────
 *
 *   tsx scripts/finding-calibration.ts --archive ~/lastlight-run-artifacts \
 *       --instances <path to pr-review instances.json> [--dry-run | --yes]
 *
 * Labels are cached by (case, findings digest) so a re-run of the analysis
 * costs nothing. `--dry-run` exercises everything except the judge.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { loadDotEnv } from "../src/env.js";
import { gradeInternalRecall } from "../src/grade.js";
import { defaultJudgeModel } from "../src/judge.js";
import { readPipelineArtifacts, internalJudgeInputs, type PipelineFinding } from "../src/review-pipeline-stats.js";
import type { GoldComment } from "../src/schema.js";

// ── CLI plumbing (same shape as scripts/aacr-adjudicate.ts) ─────────────────
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith("--")) return process.argv[i + 1];
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`) || process.argv.some((a) => a.startsWith(`--${name}=`));
}
function die(msg: string): never {
  console.error(`finding-calibration: ${msg}`);
  process.exit(1);
}

/** Below this an n is marked † and must not be quoted on its own. Same bar as
 * the AACR report, for the same reason: the breakdown tables are where the real
 * result lives and a cell of four is not a rate. */
const SMALL = 20;

// ── Reading the archive ─────────────────────────────────────────────────────

/**
 * One case's preserved artifacts. The archive layout is
 * `<run>/<instance_id>/pr-review/`, which `readPipelineArtifacts` already
 * speaks — it was split out of `readPipelineStats` for exactly this back-fill.
 */
interface ArchivedCase {
  run: string;
  instanceId: string;
  dir: string;
  findings: PipelineFinding[];
  /** `<family>-<NNN>` → the raw hypothesis row, for the discharge/quote axes. */
  hypotheses: Map<string, Record<string, unknown>>;
  /**
   * sha1 of this case's obligation id list.
   *
   * The deterministic stage IS deterministic — verified 2026-09-21, every
   * repeat of every case in the archive produced a byte-identical obligation
   * set. That makes the digest a self-validating definition of "these runs are
   * repeats of each other": no naming convention to trust, no config to
   * compare. Two runs are siblings iff they were handed the same questions.
   */
  obligationDigest: string;
}

function readHypotheses(dir: string): Map<string, Record<string, unknown>> {
  const out = new Map<string, Record<string, unknown>>();
  let files: string[] = [];
  try {
    files = readdirSync(join(dir, "hypotheses")).filter((f) => f.endsWith(".jsonl"));
  } catch {
    return out;
  }
  for (const f of files) {
    const family = f.replace(/\.jsonl$/, "");
    let n = 0;
    for (const line of readFileSync(join(dir, "hypotheses", f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let row: Record<string, unknown>;
      try {
        row = JSON.parse(line) as Record<string, unknown>;
      } catch {
        continue;
      }
      n += 1;
      // Canonical id is positional — the model's own `id` is an alias at best
      // and a collision at worst (two families both emitting `H-001` is the
      // documented failure `hypotheses.ts` exists to prevent).
      out.set(`${family}-${String(n).padStart(3, "0")}`, row);
      const declared = row.id;
      if (typeof declared === "string" && !out.has(declared)) out.set(declared, row);
    }
  }
  return out;
}

/** Identity of the question set this case was handed. See {@link ArchivedCase.obligationDigest}. */
function obligationDigest(dir: string): string {
  try {
    const doc = JSON.parse(readFileSync(join(dir, "obligations.json"), "utf8")) as {
      obligations?: { id?: string; obligation?: string }[];
    };
    const ids = (doc.obligations ?? []).map((o, i) => o.id ?? o.obligation ?? `#${i}`);
    return createHash("sha1").update(JSON.stringify(ids)).digest("hex").slice(0, 8);
  } catch {
    return "none";
  }
}

function loadArchive(root: string): ArchivedCase[] {
  if (!existsSync(root)) die(`no archive at ${root}`);
  const cases: ArchivedCase[] = [];
  for (const run of readdirSync(root)) {
    const runDir = join(root, run);
    let entries: string[] = [];
    try {
      entries = readdirSync(runDir);
    } catch {
      continue;
    }
    for (const instanceId of entries) {
      const dir = join(runDir, instanceId, "pr-review");
      const readout = readPipelineArtifacts(dir);
      if (!readout || !readout.findings.length) continue;
      cases.push({
        run,
        instanceId,
        dir,
        findings: readout.findings,
        hypotheses: readHypotheses(dir),
        obligationDigest: obligationDigest(dir),
      });
    }
  }
  return cases;
}

// ── Gold ────────────────────────────────────────────────────────────────────

function loadGold(path: string): Map<string, GoldComment[]> {
  const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const list = (Array.isArray(raw) ? raw : (raw as { instances?: unknown[] }).instances) as
    | { instance_id: string; review_gold?: GoldComment[] }[]
    | undefined;
  if (!list) die(`${path} is neither an array nor { instances: [...] }`);
  const out = new Map<string, GoldComment[]>();
  for (const inst of list) if (inst.review_gold?.length) out.set(inst.instance_id, inst.review_gold);
  return out;
}

// ── The axes ────────────────────────────────────────────────────────────────

/**
 * A scored finding: the label, and every candidate axis, all computed without a
 * model. Higher is "more worth posting" on every axis, so the sweep reads the
 * same way for all of them.
 */
interface Scored {
  run: string;
  instanceId: string;
  title: string;
  tier: string;
  family: string;
  severity: string;
  /** 1 if the judge matched this finding to a gold defect. */
  y: number;
  axes: Record<string, number>;
}

/**
 * The claim-direction test. Not "does the sentence contain the word correctly"
 * — the adjudicate prompt already learned that lesson the expensive way (part
 * two: the rule fired on the wording and buried both real defects in the one
 * adjudication read line by line). This tests the SHAPE of the whole title:
 * a verification report asserts the mechanism holds, a finding asserts it does
 * not. Scored 1 for "asserts a defect", 0 for "asserts correctness", so that
 * higher is better like every other axis.
 */
const VERIFICATION_TITLE = /^\s*(\w+\s+)?(verification|check passed|verified)\b|\b(properly|correctly)\s+\w+(ed|ing)?\b(?!.*\b(not|fails?|missing|absent|never)\b)/i;
const DEFECT_WORDS = /\b(missing|not enforced|unhandled|never|fails?|incorrect|wrong|leak|race|unchecked|off[- ]by|null|undefined|stale|silently)\b/i;

function claimDirection(f: PipelineFinding): number {
  const title = f.title ?? "";
  if (DEFECT_WORDS.test(title)) return 1;
  return VERIFICATION_TITLE.test(title) ? 0 : 1;
}

const DISCHARGE_RANK: Record<string, number> = {
  // A probe that ran outranks a quote, which outranks an assertion that a thing
  // is absent, which outranks a partial. `QUOTE` sits LOW on purpose: a clean
  // quote with no failure scenario is the anti-finding shape.
  PROBE: 4,
  ABSENT: 3,
  PARTIAL: 2,
  QUOTE: 1,
};

function axesFor(f: PipelineFinding, hyp: Map<string, Record<string, unknown>>): Record<string, number> {
  const rows = f.hypotheses.map((id) => hyp.get(id)).filter((r): r is Record<string, unknown> => !!r);
  const sev = String(f.severity ?? "").toLowerCase();
  const sevWeight = sev === "critical" ? 3 : sev === "minor" ? 1 : 2;
  const conf = f.confidence ?? 1;

  const discharge = Math.max(0, ...rows.map((r) => DISCHARGE_RANK[String(r.discharge ?? "")] ?? 0));
  const bothEnds = rows.filter((r) => {
    const be = r.bothEnds as { introducedAt?: unknown; enforcedAt?: unknown } | undefined;
    return !!be?.introducedAt && !!be?.enforcedAt;
  }).length;
  const quotes = rows.reduce((n, r) => n + (Array.isArray(r.quotes) ? r.quotes.length : 0), 0);
  const failureScenario = rows.filter((r) => typeof r.failureScenario === "string" && r.failureScenario.trim()).length;

  return {
    // ── the floors ──
    "post-everything": 1, // constant: the sweep degenerates to "post all"
    "model-confidence": conf,
    // Not a proposal — a measurement. If `model-confidence` lands well BELOW
    // 0.5 then the field carries real information pointing the wrong way, and
    // the only honest way to report that is to score the flip too.
    "inverted confidence (1-c)": 1 - conf,
    "rank-of (conf x severity)": conf * sevWeight, // what review-poster.ts ranks on today
    "adjudicator-tier": f.tier === "inline" ? 2 : f.tier === "body" ? 1 : 0,
    // ── the candidate axes, none of which cost a token ──
    // Is the flip ADDITIVE to what production already does, or is it the same
    // information the adjudicator used to set the tier? Tier dominates; the
    // flip only breaks ties inside a tier.
    "tier + inverted confidence": (f.tier === "inline" ? 2 : f.tier === "body" ? 1 : 0) + (1 - conf),
    "claim-direction": claimDirection(f),
    "not-clean-discharge": f.cleanDischarge ? 0 : 1,
    "provenance count": f.hypotheses.length,
    "has provenance": f.hypotheses.length > 0 ? 1 : 0,
    "discharge rank": discharge,
    "both ends named": bothEnds,
    "quote count": quotes,
    "failure scenario present": failureScenario,
    "severity weight": sevWeight,
  };
}

// ── Metrics ─────────────────────────────────────────────────────────────────

/** Rank-based AUROC, ties counted as half — the same estimator the AACR report
 * uses, so the two numbers are comparable. */
function auroc(rows: Scored[], axis: string): number | null {
  const pos = rows.filter((r) => r.y === 1).map((r) => r.axes[axis]);
  const neg = rows.filter((r) => r.y === 0).map((r) => r.axes[axis]);
  if (!pos.length || !neg.length) return null;
  let w = 0;
  for (const a of pos) for (const b of neg) w += a > b ? 1 : a === b ? 0.5 : 0;
  return w / (pos.length * neg.length);
}

/** Percentile bootstrap over cases, not over findings — findings within a case
 * are not independent (one PR, one diff, one survey run), and resampling them
 * individually would report a confidence interval several times too narrow. */
function bootstrapAuroc(rows: Scored[], axis: string, iters = 2000): [number, number] | null {
  const byCase = new Map<string, Scored[]>();
  for (const r of rows) {
    const k = `${r.run}/${r.instanceId}`;
    (byCase.get(k) ?? byCase.set(k, []).get(k)!).push(r);
  }
  const keys = [...byCase.keys()];
  if (keys.length < 3) return null;
  const draws: number[] = [];
  let seed = 0x9e3779b9;
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 1e6) / 1e6;
  };
  for (let i = 0; i < iters; i++) {
    const sample: Scored[] = [];
    for (let k = 0; k < keys.length; k++) sample.push(...byCase.get(keys[Math.floor(rnd() * keys.length)])!);
    const a = auroc(sample, axis);
    if (a !== null) draws.push(a);
  }
  if (draws.length < iters / 2) return null;
  draws.sort((a, b) => a - b);
  return [draws[Math.floor(draws.length * 0.025)], draws[Math.floor(draws.length * 0.975)]];
}

/** Precision / recall / F1 at every cut-off the axis actually takes, so the
 * sweep cannot miss the one threshold that matters by landing between values. */
function sweep(rows: Scored[], axis: string): { t: number; kept: number; matched: number; precision: number; recall: number; f1: number }[] {
  const total = rows.filter((r) => r.y === 1).length;
  const cuts = [...new Set(rows.map((r) => r.axes[axis]))].sort((a, b) => a - b);
  return cuts.map((t) => {
    const kept = rows.filter((r) => r.axes[axis] >= t);
    const matched = kept.filter((r) => r.y === 1).length;
    const precision = kept.length ? matched / kept.length : 0;
    const recall = total ? matched / total : 0;
    const f1 = precision + recall ? (2 * precision * recall) / (precision + recall) : 0;
    return { t, kept: kept.length, matched, precision, recall, f1 };
  });
}

// ── Labelling (the only spend) ──────────────────────────────────────────────

function cachePath(): string {
  return resolve(process.env.LASTLIGHT_EVALS_CACHE ?? ".eval-cache", "finding-calibration", "labels.json");
}

/** Keyed on the findings themselves, not the case id: two runs of the same case
 * produced different findings and must not share a label vector. */
function caseDigest(c: ArchivedCase, gold: GoldComment[]): string {
  const h = createHash("sha256");
  for (const f of c.findings) h.update(`${f.title}\u0000${f.path ?? ""}\u0000`);
  for (const g of gold) h.update(`${g.description}\u0000`);
  return h.digest("hex").slice(0, 16);
}

type LabelCache = Record<string, { goldToFinding: (number | null)[]; matched: number; error?: string }>;

function readCache(): LabelCache {
  try {
    return JSON.parse(readFileSync(cachePath(), "utf8")) as LabelCache;
  } catch {
    return {};
  }
}

function writeCache(c: LabelCache): void {
  mkdirSync(dirname(cachePath()), { recursive: true });
  writeFileSync(cachePath(), `${JSON.stringify(c, null, 2)}\n`);
}

// ── Report ──────────────────────────────────────────────────────────────────

function pct(n: number, d: number): string {
  if (!d) return "    —";
  return `${((100 * n) / d).toFixed(1).padStart(5)}%`;
}

function mark(n: number): string {
  return n < SMALL ? "†" : " ";
}


// ── Recurrence (rung 1) ─────────────────────────────────────────────────────

/**
 * Candidate equivalence keys — "did two independent runs raise the same thing?"
 *
 * The obvious key was the obligation id, because the deterministic stage is
 * genuinely deterministic (verified: every repeat of every case in the archive
 * produced a byte-identical obligation set). It does not work, and the reason
 * is worth recording: `hypotheses[].obligation` is written by the MODEL, not
 * resolved by the harness. One case's repeats reference 44 distinct obligation
 * ids against a question set of 33, and two repeats of `1667` reference
 * disjoint sets — an id that names nothing is not a join key.
 *
 * So the key has to come from the anchors, which are quoted out of real files.
 * Every candidate is scored below rather than chosen: which granularity counts
 * as "the same finding" is a researcher's free parameter, and a single key in a
 * report is a number somebody picked.
 */
const KEYS: Record<string, (f: PipelineFinding) => string> = {
  "path": (f) => norm(f.path),
  "path:line": (f) => `${norm(f.path)}:${f.line ?? "?"}`,
  "family + path": (f) => `${norm(f.family)}|${norm(f.path)}`,
  "family + path:line": (f) => `${norm(f.family)}|${norm(f.path)}:${f.line ?? "?"}`,
};

function norm(s: unknown): string {
  return String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

interface Unit {
  caseId: string;
  key: string;
  /** How many sibling repeats raised something under this key, out of `n`. */
  votes: number;
  n: number;
  y: number;
}

/** Sibling groups: same case, same question set. See {@link ArchivedCase.obligationDigest}. */
function siblingGroups(cases: ArchivedCase[]): ArchivedCase[][] {
  const groups = new Map<string, ArchivedCase[]>();
  for (const c of cases) {
    const k = `${c.instanceId}|${c.obligationDigest}`;
    (groups.get(k) ?? groups.set(k, []).get(k)!).push(c);
  }
  return [...groups.values()].filter((v) => v.length >= 2);
}

function unitsFor(groups: ArchivedCase[][], cache: LabelCache, gold: Map<string, GoldComment[]>, key: (f: PipelineFinding) => string): Unit[] {
  const units: Unit[] = [];
  for (const sibs of groups) {
    const caseId = sibs[0].instanceId;
    const g = gold.get(caseId);
    if (!g) continue;
    const votes = new Map<string, number>();
    const hit = new Set<string>();
    const seen = new Set<string>();
    for (const c of sibs) {
      const label = cache[caseDigest(c, g)];
      const matched = new Set((label?.goldToFinding ?? []).filter((i): i is number => i !== null));
      const here = new Set<string>();
      c.findings.forEach((f, i) => {
        const k = key(f);
        seen.add(k);
        here.add(k);
        // A gold match in ANY repeat makes the key a positive. The question is
        // whether recurrence predicts a real defect, and a defect does not stop
        // being real in the repeat that happened to miss it.
        if (matched.has(i)) hit.add(k);
      });
      for (const k of here) votes.set(k, (votes.get(k) ?? 0) + 1);
    }
    for (const k of seen) units.push({ caseId, key: k, votes: votes.get(k) ?? 0, n: sibs.length, y: hit.has(k) ? 1 : 0 });
  }
  return units;
}

function unitAuroc(units: Unit[]): number | null {
  const frac = (u: Unit) => u.votes / u.n;
  const p = units.filter((u) => u.y === 1).map(frac);
  const n = units.filter((u) => u.y === 0).map(frac);
  if (!p.length || !n.length) return null;
  let w = 0;
  for (const a of p) for (const b of n) w += a > b ? 1 : a === b ? 0.5 : 0;
  return w / (p.length * n.length);
}

function recurrenceReport(cases: ArchivedCase[], cache: LabelCache, gold: Map<string, GoldComment[]>): void {
  const groups = siblingGroups(cases);
  console.log(`\n── RUNG 1: recurrence across sibling repeats ──`);
  if (!groups.length) {
    console.log(`   no case in this archive has two runs of the same question set — nothing to vote on.\n`);
    return;
  }
  console.log(`   groups        ${groups.length} · repeats each: ${groups.map((g) => g.length).join(", ")}`);
  console.log(`   NOTE the group of ${Math.max(...groups.map((g) => g.length))} spans two contract variants of one case —`);
  console.log(`   same questions, different rendering. Diverse sampling, not identical repeats.`);

  console.log(`\n   ${"equivalence key".padEnd(22)} ${"units".padStart(5)}  ${"pos".padStart(4)}  ${"recur".padStart(6)}  ${"AUROC".padStart(6)}`);
  let best: { name: string; units: Unit[]; auc: number } | null = null;
  for (const [name, key] of Object.entries(KEYS)) {
    const units = unitsFor(groups, cache, gold, key);
    const auc = unitAuroc(units);
    const pos = units.filter((u) => u.y === 1).length;
    const recur = units.filter((u) => u.votes > 1).length;
    console.log(
      `   ${name.padEnd(22)} ${String(units.length).padStart(5)}${mark(units.length)} ${String(pos).padStart(4)}  ${pct(recur, units.length).padStart(6)}  ${auc === null ? "   —  " : auc.toFixed(3).padStart(6)}`,
    );
    if (auc !== null && (!best || auc > best.auc)) best = { name, units, auc };
  }
  if (!best) {
    console.log(`\n   no key produced both positives and negatives — nothing to measure.\n`);
    return;
  }

  const { name, units } = best;
  console.log(`\n   ── vote table for the best key (${name}) ──`);
  console.log(`   ${"votes".padStart(8)}  ${"units".padStart(5)}  ${"matched".padStart(7)}  ${"hit rate".padStart(8)}`);
  const buckets = new Map<string, Unit[]>();
  for (const u of units) {
    const k = `${u.votes}/${u.n}`;
    (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(u);
  }
  for (const [k, v] of [...buckets].sort((a, b) => a[0].localeCompare(b[0]))) {
    const m = v.filter((u) => u.y === 1).length;
    console.log(`   ${k.padStart(8)}  ${String(v.length).padStart(5)}${mark(v.length)} ${String(m).padStart(7)}  ${pct(m, v.length).padStart(8)}`);
  }

  // The number that decides whether voting is a good idea here. Cursor drops
  // anything a single pass found; this is what that rule would cost US.
  const once = units.filter((u) => u.votes === 1 && u.n > 1);
  const more = units.filter((u) => u.votes > 1);
  console.log(`\n   raised in exactly one repeat   ${String(once.length).padStart(4)} units, ${once.filter((u) => u.y === 1).length} matched gold`);
  console.log(`   raised in more than one        ${String(more.length).padStart(4)} units, ${more.filter((u) => u.y === 1).length} matched gold`);
  const lost = once.filter((u) => u.y === 1).length;
  const kept = more.filter((u) => u.y === 1).length;
  console.log(`\n   Cursor's rule — drop anything only one pass found — would cost ${lost} of ${lost + kept}`);
  console.log(`   real defects here (${pct(lost, lost + kept).trim()} of recall) to remove ${pct(once.length, units.length).trim()} of the volume.\n`);
}

async function main(): Promise<number> {
  loadDotEnv();
  const archive = resolve(flag("archive") ?? join(homedir(), "lastlight-run-artifacts"));
  const instances = flag("instances");
  if (!instances) die(`--instances <path to a pr-review instances.json> is required (it carries review_gold)`);

  const gold = loadGold(resolve(instances));
  const cases = loadArchive(archive).filter((c) => gold.has(c.instanceId));
  if (!cases.length) die(`no archived case under ${archive} has gold in ${instances}`);

  const findings = cases.reduce((n, c) => n + c.findings.length, 0);
  console.log(`\nArchive      ${archive}`);
  console.log(`Cases        ${cases.length} (${new Set(cases.map((c) => c.instanceId)).size} distinct, over ${new Set(cases.map((c) => c.run)).size} runs)`);
  console.log(`Findings     ${findings}`);
  console.log(`Gold         ${cases.reduce((n, c) => n + gold.get(c.instanceId)!.length, 0)} across those cases`);

  const cache = readCache();
  const todo = cases.filter((c) => !cache[caseDigest(c, gold.get(c.instanceId)!)]);

  if (todo.length) {
    let model = "unknown";
    try {
      model = defaultJudgeModel();
    } catch {
      /* reported by the gate below */
    }
    console.log(`\n── SPEND GATE ───────────────────────────────────────────────────────────`);
    console.log(`   labelling      ${todo.length} case${todo.length === 1 ? "" : "s"} (${cases.length - todo.length} already cached)`);
    console.log(`   model          ${model}`);
    console.log(`   model calls    ${todo.length}  (one MATCH pass per case — the same call a live run makes)`);
    console.log(`   est. tokens    ~${(todo.reduce((n, c) => n + c.findings.length, 0) * 120).toLocaleString()} in  (crude: ~120 tokens a finding)`);
    if (has("dry-run")) {
      console.log(`   --dry-run given; no labels, no report.\n`);
      return 0;
    }
    if (!has("yes")) {
      console.log(`\n   REFUSING. Model spend needs human sign-off. Re-run with --yes, or --dry-run.\n`);
      return 2;
    }
    console.log(`   --yes given; labelling.\n`);
    for (const c of todo) {
      const g = gold.get(c.instanceId)!;
      const res = await gradeInternalRecall({ gold: g, findings: internalJudgeInputs(c.findings) });
      cache[caseDigest(c, g)] = res ?? { goldToFinding: g.map(() => null), matched: 0, error: "no result" };
      writeCache(cache); // after every case: a crash must not throw away paid-for labels
      process.stdout.write(`   ${c.run}/${c.instanceId}: ${res?.matched ?? 0} matched${res?.error ? ` (${res.error})` : ""}\n`);
    }
  }

  // ── Score ──
  const rows: Scored[] = [];
  for (const c of cases) {
    const label = cache[caseDigest(c, gold.get(c.instanceId)!)];
    if (!label || label.error) continue;
    const matchedIdx = new Set(label.goldToFinding.filter((i): i is number => i !== null));
    c.findings.forEach((f, i) => {
      rows.push({
        run: c.run,
        instanceId: c.instanceId,
        title: f.title ?? "",
        tier: f.tier ?? "?",
        family: f.family ?? "?",
        severity: String(f.severity ?? "?"),
        y: matchedIdx.has(i) ? 1 : 0,
        axes: axesFor(f, c.hypotheses),
      });
    });
  }

  const pos = rows.filter((r) => r.y === 1).length;
  console.log(`\nScored       ${rows.length} findings, ${pos} matched gold (base rate ${pct(pos, rows.length).trim()})`);
  if (pos < SMALL) {
    console.log(`\n   † ONLY ${pos} POSITIVES. Every AUROC below is a small-sample number and none of them`);
    console.log(`     settles anything on its own. Read the direction, not the digit.`);
  }

  // ── AUROC table ──
  const axes = Object.keys(rows[0]?.axes ?? {});
  console.log(`\n── AUROC (higher = separates matched from unmatched; 0.500 is a coin) ───`);
  console.log(`   ${"axis".padEnd(28)} ${"AUROC".padStart(6)}   95% CI (bootstrap over cases)`);
  const ranked = axes
    .map((a) => ({ a, v: auroc(rows, a) }))
    .filter((x): x is { a: string; v: number } => x.v !== null)
    .sort((x, y) => y.v - x.v);
  for (const { a, v } of ranked) {
    const ci = bootstrapAuroc(rows, a);
    console.log(`   ${a.padEnd(28)} ${v.toFixed(3).padStart(6)}   ${ci ? `[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}]` : "—"}`);
  }

  // ── Sweep for the best non-floor axis ──
  const FLOORS = new Set(["post-everything", "model-confidence", "rank-of (conf x severity)", "adjudicator-tier"]);
  const best = ranked.find((r) => !FLOORS.has(r.a));
  if (best) {
    console.log(`\n── SWEEP: ${best.a} ──────────────────────────────────`);
    console.log(`   ${"t".padStart(6)}  ${"kept".padStart(5)}  ${"matched".padStart(7)}  ${"precision".padStart(9)}  ${"recall".padStart(7)}  ${"F1".padStart(6)}`);
    for (const s of sweep(rows, best.a)) {
      console.log(
        `   ${s.t.toFixed(2).padStart(6)}  ${String(s.kept).padStart(5)}${mark(s.kept)} ${String(s.matched).padStart(7)}  ${pct(s.matched, s.kept).padStart(9)}  ${pct(s.matched, pos).padStart(7)}  ${s.f1.toFixed(3).padStart(6)}`,
      );
    }
    const floor = sweep(rows, "post-everything")[0];
    console.log(`\n   floor (post everything):  precision ${pct(floor.matched, floor.kept).trim()}  recall 100.0%  F1 ${floor.f1.toFixed(3)}`);
  }

  // ── The disambiguation ──
  //
  // If `model-confidence` is inverted only because verification reports are
  // written at 1.0, then it is a claim-direction detector wearing a confidence
  // coat and it carries nothing extra. Re-score with those rows removed: an
  // axis that survives the restriction knows something the regex does not.
  const defectsOnly = rows.filter((r) => r.axes["claim-direction"] === 1);
  const dPos = defectsOnly.filter((r) => r.y === 1).length;
  console.log(`\n── RESTRICTED to defect claims only (n=${defectsOnly.length}, ${dPos} matched) ──`);
  console.log(`   does any axis survive once verification reports are removed?`);
  for (const { a } of ranked) {
    const v = auroc(defectsOnly, a);
    if (v === null) continue;
    const ci = bootstrapAuroc(defectsOnly, a);
    console.log(`   ${a.padEnd(28)} ${v.toFixed(3).padStart(6)}   ${ci ? `[${ci[0].toFixed(3)}, ${ci[1].toFixed(3)}]` : "—"}`);
  }

  // ── RUNG 1: recurrence across sibling repeats ──
  //
  // The obligations are identical across repeats, so there is nothing to
  // cluster and no equivalence function to get wrong — the expensive part of
  // semantic entropy (Farquhar, Nature 2024) is free here by construction. The
  // unit is (case, obligation) and the question is: in how many independent
  // runs handed THIS question did the pipeline come back with a defect claim
  // rather than a clean bill of health?
  //
  // That is Cursor's majority-vote-of-8 and SWR-Bench v2's Self-Agg, on a fixed
  // question set. It is union-preserving by construction: recurrence is counted,
  // never merged, so no claim can be deleted by a vote.
  recurrenceReport(cases, cache, gold);

  // ── Breakdowns: the tables that caught the last mistake ──
  const group = (key: (r: Scored) => string, title: string) => {
    const buckets = new Map<string, Scored[]>();
    for (const r of rows) (buckets.get(key(r)) ?? buckets.set(key(r), []).get(key(r))!).push(r);
    console.log(`\n── ${title} ──`);
    console.log(`   ${"bucket".padEnd(20)} ${"n".padStart(5)}  ${"matched".padStart(7)}  ${"hit rate".padStart(8)}`);
    for (const [k, v] of [...buckets].sort((a, b) => b[1].length - a[1].length)) {
      const m = v.filter((r) => r.y === 1).length;
      console.log(`   ${k.padEnd(20)} ${String(v.length).padStart(5)}${mark(v.length)} ${String(m).padStart(7)}  ${pct(m, v.length).padStart(8)}`);
    }
  };
  group((r) => r.tier, "BY TIER (what the adjudicator decided)");
  group((r) => r.family, "BY FAMILY");
  group((r) => r.severity, "BY SEVERITY");
  group((r) => (r.axes["claim-direction"] ? "defect claim" : "verification"), "BY CLAIM DIRECTION");
  console.log(`\n   † n < ${SMALL} — do not quote alone.\n`);
  return 0;
}

main().then(
  (code) => process.exit(code),
  (err) => die(err instanceof Error ? err.message : String(err)),
);

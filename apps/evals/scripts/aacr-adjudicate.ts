#!/usr/bin/env -S npx tsx
/**
 * Measure an **adjudicator** against Alibaba's AACR-Bench — "handed a review
 * comment somebody else wrote, can this arm tell a correct one from a wrong
 * one, and does it pay for that in recall?"
 *
 * This is a **measurement script**, not a test: it never asserts, never tunes,
 * and writes nothing unless `--out` is passed. It exists BEFORE
 * [WP6](docs/plans/deterministic-pr-levers.md#adjudication-and-the-attention-boundary-wp6) so WP6 has an
 * external target to hit, rather than being graded only by the instrument it
 * was designed against.
 *
 * Usage:
 *   npx tsx scripts/aacr-adjudicate.ts [--arm <name>] [--limit N | --all]
 *       [--seed N] [--model <id>] [--concurrency N] [--dry-run] [--yes]
 *       [--dataset <path>] [--out [<resultsRoot>]] [--print-prompt] [--help]
 *
 *   --arm          keep-all (default) | drop-all | llm      (see ARMS below)
 *   --limit N      sample size, deterministic + stratified  (default 50)
 *   --all          score all 2,145 rows. Required to go past --limit
 *   --seed N       sampling seed                            (default 1)
 *   --model <id>   judge model for the `llm` arm; else EVAL_JUDGE_MODEL, else
 *                  defaultJudgeModel()
 *   --concurrency  parallel model calls                     (default 4)
 *   --dry-run      zero model calls; a stub decision drives the whole pipeline
 *   --yes          the spend acknowledgement. Without it, a model arm prints its
 *                  estimate and REFUSES
 *   --dataset      a local dataset.json instead of the cache
 *   --out          also write report.json + report.md (optionally under a
 *                  different results root)
 *   --print-prompt dump the first constructed prompt (llm arm) before deciding
 *   --help         print this block
 *
 * ── What this measures ───────────────────────────────────────────────────────
 *
 * Exactly one thing: **given the text of a review comment plus its file/line
 * metadata, can an arm separate the expert-verified-correct ones from the
 * expert-verified-incorrect ones.** That is the WP6 adjudicate phase's job and
 * nothing else's.
 *
 * ── What this does NOT measure ───────────────────────────────────────────────
 *
 * **It is not review recall.** Every comment here already exists. Nothing in
 * this script asks whether *our* reviewer would ever have generated the comment
 * — which is the actual bottleneck (1 of 25 gold findings on skillspro) and the
 * thing WP3/WP4 exist to move. An arm can score 100% here and change review
 * recall by zero, because the recall loss happens upstream of adjudication.
 *
 * It is also **not comparable to AACR-Bench's own leaderboard**. That board
 * scores review *generation* — Open Code Review at 20.0% recall (301/1505),
 * Claude Code at 28.9% (435/1505), see
 * [external validation (WP9)](docs/plans/deterministic-pr-levers.md#external-validation-wp9).
 * Those denominators are the 1,505 label=1 rows treated as a gold set to be
 * *found*. Ours is a classification over rows already handed to us. Never put
 * the two in the same column (`01b` house rule: our number and theirs are never
 * averaged, pooled, or presented together).
 *
 * ── The dataset's own bias, carried in the output, not in a footnote ─────────
 *
 * **1,597 of the 2,145 comments are AI-generated** (GPT-5.2, Claude-4.5-Sonnet,
 * Qwen-Coder-480B, GLM-4.7, Deepseek-V3.2, Gemini-3-Pro) and then
 * expert-verified. Only **548 are human-authored**. So the set over-represents
 * the findings AI reviewers already produce, and an adjudicator tuned on it is
 * tuned to police machine output. The human-authored half is the more honest
 * distribution and is **always reported separately, never pooled** — a single
 * pooled retention figure is 74% a statement about how well we adjudicate other
 * models' comments.
 *
 * Base rates are close enough that the split is about provenance, not
 * difficulty: label=1 is 1114/1597 (69.8%) of AI rows and 391/548 (71.4%) of
 * human rows.
 *
 * ── The asymmetry this is built to detect ────────────────────────────────────
 *
 * WP6's adjudicator **may re-rank, re-tier and DEMOTE, but may not DELETE a
 * finding without a probe transcript refuting it**, because filtering a
 * conservative reviewer has cost recall every single time it has been measured:
 * our own candidate v2 (micro-recall 1/25 → 2/25 but F1 halved — reverted),
 * BitsAI-CR's ReviewFilter (precision 54.5 → 67.1, recall 45.5 → **39.8**), and
 * Open Code Review's deterministic layer (discards ~5,100 findings to buy
 * precision and loses 134 real defects doing it).
 *
 * So **retention is the headline and interception is the sidebar**, not the
 * reverse. A high-interception arm is not a good arm; it is candidate v2.
 *
 * ── The metrics, and their denominators ──────────────────────────────────────
 *
 *   retention     = kept / total, over label=1 rows ONLY. The recall-protecting
 *                   number. Arithmetically identical to the positive class's
 *                   recall below; both are printed because the *name* is the
 *                   point — this is the budget that must not be spent.
 *   interception  = dropped / total, over label=0 rows ONLY.
 *
 * The confusion matrix takes **"kept a valid comment" as the positive class**,
 * so precision/recall/F1 mean what they mean in the literature:
 *
 *   TP  label=1 & keep   FP  label=0 & keep
 *   FN  label=1 & drop   TN  label=0 & drop
 *
 * Note the floors this pins, and they are the reason the deterministic arms are
 * not filler. A bound is only a guard if the number it would be WITHOUT the
 * intervention is pinned too
 * ([the instrument, WP8](docs/plans/deterministic-pr-levers.md#the-instrument-wp8)):
 *
 *   keep-all   retention 100%  interception   0%   precision = the base rate
 *   drop-all   retention   0%  interception 100%   precision = undefined (0/0)
 *
 * `keep-all` is **what production does today** — there is no adjudicate phase —
 * so it is the rung-0 row, not a strawman. Any arm that does not beat its F1 is
 * costing recall for nothing.
 *
 * ── Every rate is printed with its n ─────────────────────────────────────────
 *
 * A rate over a tiny subset is not a measurement. Some language and category
 * cells are small (C# is 52 rows of 2,145; Security Vulnerability is 74), and at
 * `--limit 50` most cells are single digits. Cells with n < 20 are marked `†`.
 *
 * ── What is deliberately kept OUT of the prompt ──────────────────────────────
 *
 * `label`, `is_ai_comment`, `source_model`, `category` and `context` are never
 * shown to a model arm. The first three are direct leakage. The last two are
 * *annotator-assigned* fields, and feeding an annotation into the input while
 * also breaking the score down by it makes the breakdown circular. They are
 * scoring axes here, nothing more.
 *
 * ── An arm that errors is UNGRADED, never a silent decision ──────────────────
 *
 * A failed or unparseable model reply does not become a keep and does not become
 * a drop; the row is excluded from every denominator and the excluded count is
 * printed beside the headline. Silently defaulting an error to `keep` would
 * flatter retention, and to `drop` would flatter interception. Both are lies of
 * the kind 08-evals §5 already forbids for the pr-review judge.
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { defaultJudgeModel, judge, parseJudgeJson } from "../src/judge.js";
import { gitShortSha, makeRunId, resultsRoot } from "../src/paths.js";
import { mapPool } from "../src/pool.js";

const DATASET_URL = "https://huggingface.co/datasets/Alibaba-Aone/aacr-bench/resolve/main/dataset.json";

// ── CLI plumbing (shared shape with scripts/facts-evidence.ts) ───────────────
function flag(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq ? eq.slice(name.length + 3) : undefined;
}
function has(name: string): boolean {
  return process.argv.includes(`--${name}`) || process.argv.some((a) => a.startsWith(`--${name}=`));
}
function die(msg: string): never {
  console.error(`aacr-adjudicate: ${msg}`);
  process.exit(1);
}

// ── The dataset ─────────────────────────────────────────────────────────────

/**
 * One AACR-Bench row, verified present on all 2,145. Field names are the
 * dataset's, not ours — renaming them here would make the provenance stamp a
 * translation rather than a record.
 */
interface Row {
  project_main_language: string;
  pr_url: string;
  /** NOTE: this is the PR's **base** sha (verified 12/12), not the head. The
   * head is `pr_target_commit`. Nothing in this script needs either — the
   * comment text plus its metadata is the whole input, which is precisely why
   * this instrument can exist before any repo-checkout work. */
  pr_source_commit: string;
  pr_target_commit: string;
  pr_change_line_count: number;
  pr_category: string;
  is_ai_comment: boolean;
  /** The review comment text. THE input. */
  note: string;
  path: string;
  side: string;
  /** Which model wrote it — empty string on the 548 human-authored rows. */
  source_model: string;
  from_line: number;
  to_line: number;
  category: string;
  context: string;
  /** 1 = expert-verified CORRECT (1,505 rows), 0 = INCORRECT (640). */
  label: number;
}

/** A row plus its stable position in the file — the sampling id. The dataset
 * sha256 is stamped in the report, so an index is reproducible. */
interface Indexed {
  idx: number;
  row: Row;
}

function cacheRoot(): string {
  return resolve(process.env.LASTLIGHT_EVALS_CACHE ?? ".eval-cache");
}

/**
 * Load the dataset, downloading once into the cache if absent. Deliberately NOT
 * committed: 2.1 MB of someone else's Apache-2.0 corpus does not belong in this
 * tree, and a cached copy pinned by sha256 in the report is the reproducibility
 * story instead. See `datasets/aacr-bench/README.md`.
 */
async function loadDataset(explicit?: string): Promise<{ path: string; sha256: string; rows: Row[] }> {
  const path = explicit ? resolve(explicit) : join(cacheRoot(), "aacr-bench", "dataset.json");
  if (!existsSync(path)) {
    if (explicit) die(`no dataset at ${path}`);
    mkdirSync(dirname(path), { recursive: true });
    console.log(`Fetching AACR-Bench → ${path} …`);
    const res = await fetch(DATASET_URL);
    if (!res.ok) die(`download failed: HTTP ${res.status} from ${DATASET_URL}`);
    writeFileSync(path, Buffer.from(await res.arrayBuffer()));
  }
  const raw = readFileSync(path);
  const sha256 = createHash("sha256").update(raw).digest("hex");
  const rows = JSON.parse(raw.toString("utf8")) as Row[];
  if (!Array.isArray(rows) || !rows.length) die(`${path} is not a non-empty JSON array`);
  for (const k of ["note", "label", "project_main_language", "is_ai_comment"] as const) {
    if (rows[0][k] === undefined) die(`${path} row 0 has no "${k}" — is this AACR-Bench?`);
  }
  return { path, sha256, rows };
}

// ── Deterministic stratified sampling ───────────────────────────────────────
//
// Never silently sample the whole set, and never sample it differently twice.
// Strata are (label × project_main_language) so a small subset keeps both the
// 1505/640 label balance and the 10-language mix rather than turning into a
// referendum on C++. Largest-remainder allocation, seeded shuffle within each
// stratum, strata visited in sorted key order — the same --seed and --limit
// against the same dataset sha256 always yields the same rows.

function fnv1a(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled<T>(xs: T[], rng: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function sample(rows: Row[], limit: number, seed: number): Indexed[] {
  const all: Indexed[] = rows.map((row, idx) => ({ idx, row }));
  if (limit >= all.length) return all;

  const strata = new Map<string, Indexed[]>();
  for (const r of all) {
    const key = `${r.row.label}|${r.row.project_main_language}`;
    const bucket = strata.get(key);
    if (bucket) bucket.push(r);
    else strata.set(key, [r]);
  }
  const keys = [...strata.keys()].sort((a, b) => a.localeCompare(b));

  // Largest remainder, ties broken by stratum key so it is order-independent.
  const exact = keys.map((k) => (strata.get(k)!.length * limit) / all.length);
  const alloc = new Map(keys.map((k, i) => [k, Math.floor(exact[i])]));
  let short = limit - [...alloc.values()].reduce((a, b) => a + b, 0);
  const byRemainder = keys
    .map((k, i) => ({ k, rem: exact[i] - Math.floor(exact[i]) }))
    .sort((a, b) => b.rem - a.rem || a.k.localeCompare(b.k));
  for (const { k } of byRemainder) {
    if (short <= 0) break;
    if (alloc.get(k)! < strata.get(k)!.length) {
      alloc.set(k, alloc.get(k)! + 1);
      short -= 1;
    }
  }
  // A stratum smaller than its allocation gives its slack back; keep handing out
  // singles in key order until the target is met or every stratum is exhausted.
  for (let guard = 0; short > 0 && guard < limit + keys.length; guard++) {
    let moved = false;
    for (const k of keys) {
      if (short <= 0) break;
      if (alloc.get(k)! < strata.get(k)!.length) {
        alloc.set(k, alloc.get(k)! + 1);
        short -= 1;
        moved = true;
      }
    }
    if (!moved) break;
  }

  const picked: Indexed[] = [];
  for (const k of keys) {
    const n = Math.min(alloc.get(k)!, strata.get(k)!.length);
    if (!n) continue;
    // Per-stratum rng so adding a stratum does not reshuffle the others.
    const rng = mulberry32(fnv1a(`${seed}:${k}`));
    picked.push(...shuffled(strata.get(k)!, rng).slice(0, n));
  }
  return picked.sort((a, b) => a.idx - b.idx);
}

// ── The arm interface ───────────────────────────────────────────────────────
//
// Deliberately narrow: a row in, a keep/drop (+ optional confidence) out. WP6's
// real adjudicator drops in as a fourth arm by implementing this and registering
// in ARMS — no reshaping of sampling, scoring, or reporting. `estimateTokens` is
// how an arm declares its spend to the gate; an arm without it is assumed free.

interface Decision {
  keep: boolean;
  /** P(the comment is VALID), on a single monotone axis so the sweep can
   * re-threshold it independently of the arm's own keep/drop call. */
  confidence?: number;
  reason?: string;
  /** Set when the arm could not produce a decision. The row is then UNGRADED —
   * excluded from every denominator, never defaulted to keep or drop. */
  error?: string;
}

interface Arm {
  name: string;
  /** Drives the spend gate. */
  usesModel: boolean;
  /** One line for the header, so a report says what was actually run. */
  describe(): string;
  decide(row: Row): Promise<Decision>;
  estimateTokens?(rows: Row[]): { input: number; output: number };
}

interface ArmOpts {
  model: string;
  dryRun: boolean;
  printPrompt: boolean;
}

// ── The two deterministic floors ────────────────────────────────────────────

function keepAllArm(): Arm {
  return {
    name: "keep-all",
    usesModel: false,
    describe: () => "the null adjudicator — keeps every comment. This IS production today (no adjudicate phase exists).",
    decide: async () => ({ keep: true, reason: "null adjudicator" }),
  };
}

function dropAllArm(): Arm {
  return {
    name: "drop-all",
    usesModel: false,
    describe: () => "the opposite floor — drops every comment. Interception 100%, and worthless.",
    decide: async () => ({ keep: false, reason: "null suppressor" }),
  };
}

// ── The llm arm ─────────────────────────────────────────────────────────────

const SYSTEM = [
  "You are adjudicating a single code-review comment that another reviewer already wrote.",
  "",
  "You cannot see the diff or the repository. Judge the comment on its own terms: is it a correct,",
  "specific, actionable observation about the code it points at, or is it wrong, hallucinated, vacuous,",
  "or a restatement of what the code obviously does?",
  "",
  "Bias: a reviewer that says nothing is useless, so a comment that is plausibly correct but that you",
  "cannot fully verify from the text should be KEPT. Drop only what you have positive reason to believe",
  "is wrong or worthless. Deleting a correct finding costs far more than showing a mediocre one.",
  "",
  'Reply with JSON only: {"decision":"keep"|"drop","confidence":<0..1>,"reason":"<one sentence>"}',
  "`confidence` is your probability that the comment identifies a real, correct issue — it is about the",
  "COMMENT's validity, not about how sure you are of your own decision.",
].join("\n");

interface LlmReply {
  decision?: string;
  confidence?: number;
  reason?: string;
}

/** The user turn. Annotator fields (`category`, `context`) and provenance
 * fields (`label`, `is_ai_comment`, `source_model`) are absent by design — see
 * the header. Everything here is something a real adjudicator would hold. */
function buildUserPrompt(row: Row): string {
  const note = row.note.length > 4000 ? `${row.note.slice(0, 4000)}\n[…truncated]` : row.note;
  const lines = row.from_line === row.to_line ? `line ${row.from_line}` : `lines ${row.from_line}–${row.to_line}`;
  return [
    `Repository language: ${row.project_main_language}`,
    `Pull request: ${row.pr_category} (${row.pr_change_line_count} changed lines)`,
    `File: ${row.path}`,
    `Anchor: ${row.side} side, ${lines}`,
    "",
    "Review comment:",
    "---",
    note,
    "---",
    "",
    "Keep or drop?",
  ].join("\n");
}

/** ~4 chars per token. Deliberately crude and labelled as such wherever it is
 * printed — it exists to size a spend decision, not to bill anyone. */
function approxTokens(s: string): number {
  return Math.ceil(s.length / 4);
}

function llmArm(opts: ArmOpts): Arm {
  let dumped = false;
  return {
    name: "llm",
    usesModel: !opts.dryRun,
    describe: () =>
      opts.dryRun
        ? `stubbed (--dry-run): prompts are built for ${opts.model} but nothing is sent`
        : `one call per row to ${opts.model} via src/judge.ts (temperature 0)`,
    estimateTokens: (rows) => ({
      input: rows.reduce((n, r) => n + approxTokens(SYSTEM) + approxTokens(buildUserPrompt(r)), 0),
      // The reply is a three-field JSON object; 120 tokens is generous for it.
      output: rows.length * 120,
    }),
    decide: async (row) => {
      const user = buildUserPrompt(row);
      if (opts.printPrompt && !dumped) {
        dumped = true;
        console.log(`\n── PROMPT (row 0 of the sample) ──────────────────────────────────────────\n`);
        console.log(`[system]\n${SYSTEM}\n\n[user]\n${user}\n`);
      }
      if (opts.dryRun) return stubDecision(row);
      let text: string;
      try {
        text = await judge(opts.model, SYSTEM, user);
      } catch (err) {
        return { keep: false, error: (err as Error).message.slice(0, 200) };
      }
      const parsed = parseJudgeJson<LlmReply>(text);
      if (!parsed) return { keep: false, error: `unparseable reply: ${text.slice(0, 120)}` };
      const d = String(parsed.decision ?? "").toLowerCase();
      if (d !== "keep" && d !== "drop") return { keep: false, error: `bad decision field: ${JSON.stringify(parsed.decision)}` };
      const c = typeof parsed.confidence === "number" && parsed.confidence >= 0 && parsed.confidence <= 1 ? parsed.confidence : undefined;
      return { keep: d === "keep", confidence: c, reason: parsed.reason?.slice(0, 200) };
    },
  };
}

/**
 * The `--dry-run` stub. Deterministic per row (hash of the pr/path/line), and
 * deliberately NOT constant — a constant stub would leave the confusion matrix
 * degenerate and the threshold sweep untested, which is exactly the code a dry
 * run is supposed to exercise. Its numbers mean NOTHING; the run prints a banner
 * saying so.
 */
function stubDecision(row: Row): Decision {
  const h = fnv1a(`${row.pr_url}|${row.path}|${row.from_line}|${row.note.length}`);
  const confidence = (h % 1000) / 1000;
  return { keep: confidence >= 0.35, confidence, reason: "stub (--dry-run)" };
}

const ARMS: Record<string, (opts: ArmOpts) => Arm> = {
  "keep-all": keepAllArm,
  "drop-all": dropAllArm,
  llm: llmArm,
};

// ── Scoring ─────────────────────────────────────────────────────────────────

interface Outcome {
  idx: number;
  label: number;
  keep: boolean;
  confidence: number | null;
  reason: string | null;
  error: string | null;
  isAi: boolean;
  language: string;
  category: string;
  context: string;
  sourceModel: string;
}

interface Cell {
  label: string;
  /** Graded rows only. Ungraded ones are counted separately and excluded. */
  tp: number;
  fp: number;
  fn: number;
  tn: number;
  ungraded: number;
}

function emptyCell(label: string): Cell {
  return { label, tp: 0, fp: 0, fn: 0, tn: 0, ungraded: 0 };
}

function tally(cell: Cell, o: Outcome): void {
  if (o.error) {
    cell.ungraded += 1;
    return;
  }
  if (o.label === 1) o.keep ? (cell.tp += 1) : (cell.fn += 1);
  else o.keep ? (cell.fp += 1) : (cell.tn += 1);
}

interface CellMetrics {
  /** label=1 rows: kept / total. THE headline. */
  retention: { n: number; d: number };
  /** label=0 rows: dropped / total. */
  interception: { n: number; d: number };
  precision: { n: number; d: number };
  recall: { n: number; d: number };
  f1: number | null;
  graded: number;
  ungraded: number;
}

function metrics(c: Cell): CellMetrics {
  const pos = c.tp + c.fn;
  const neg = c.fp + c.tn;
  const p = c.tp + c.fp === 0 ? null : c.tp / (c.tp + c.fp);
  const r = pos === 0 ? null : c.tp / pos;
  return {
    retention: { n: c.tp, d: pos },
    interception: { n: c.tn, d: neg },
    precision: { n: c.tp, d: c.tp + c.fp },
    recall: { n: c.tp, d: pos },
    f1: p === null || r === null || p + r === 0 ? null : (2 * p * r) / (p + r),
    graded: pos + neg,
    ungraded: c.ungraded,
  };
}

/** A grouped breakdown, sorted by size descending so the big cells lead and the
 * `†` ones trail — the reading order that stops a 3-row cell being quoted. */
function breakdown(outcomes: Outcome[], key: (o: Outcome) => string): Cell[] {
  const cells = new Map<string, Cell>();
  for (const o of outcomes) {
    const k = key(o);
    const cell = cells.get(k) ?? emptyCell(k);
    cells.set(k, cell);
    tally(cell, o);
  }
  return [...cells.values()].sort((a, b) => b.tp + b.fp + b.fn + b.tn - (a.tp + a.fp + a.fn + a.tn) || a.label.localeCompare(b.label));
}

/** The trade curve, for arms that return a confidence. Keeps iff conf >= t, so
 * t=0 reproduces keep-all and t>1 reproduces drop-all — the two floors bracket
 * the sweep by construction, which is the check that the axis is monotone. */
interface SweepRow {
  threshold: number;
  retention: { n: number; d: number };
  interception: { n: number; d: number };
  precision: { n: number; d: number };
  f1: number | null;
}

function sweep(outcomes: Outcome[]): SweepRow[] {
  const usable = outcomes.filter((o) => !o.error && o.confidence !== null);
  if (!usable.length) return [];
  const rows: SweepRow[] = [];
  for (let i = 0; i <= 10; i++) {
    const t = i / 10;
    const c = emptyCell(`t=${t.toFixed(1)}`);
    for (const o of usable) tally(c, { ...o, keep: (o.confidence as number) >= t });
    const m = metrics(c);
    rows.push({ threshold: t, retention: m.retention, interception: m.interception, precision: m.precision, f1: m.f1 });
  }
  return rows;
}

// ── Rendering ───────────────────────────────────────────────────────────────

const SMALL = 20; // below this an n is marked † and should not be quoted alone

function rate(n: number, d: number): string {
  const pct = d === 0 ? "  n/a" : `${((100 * n) / d).toFixed(1).padStart(5)}%`;
  const small = d > 0 && d < SMALL ? "†" : " ";
  return `${pct}${small} (${n}/${d})`;
}
function num(x: number | null, digits = 3): string {
  return x === null ? "n/a" : x.toFixed(digits);
}
/** The same rate, minus the column padding that makes a markdown cell ugly. */
function mdRate(n: number, d: number): string {
  return rate(n, d).replace(/\s+/g, " ").trim();
}

function cellRow(c: Cell, width: number): string {
  const m = metrics(c);
  return (
    `  ${c.label.slice(0, width).padEnd(width)} ` +
    `${rate(m.retention.n, m.retention.d).padEnd(20)} ` +
    `${rate(m.interception.n, m.interception.d).padEnd(20)} ` +
    `${rate(m.precision.n, m.precision.d).padEnd(20)} ` +
    `${num(m.f1).padStart(5)} ` +
    `${String(m.graded).padStart(5)} ` +
    `${String(m.ungraded).padStart(4)}`
  );
}

function cellHeader(title: string, width: number): string {
  return (
    `  ${title.slice(0, width).padEnd(width)} ` +
    `${"RETENTION (L1)".padEnd(20)} ` +
    `${"interception (L0)".padEnd(20)} ` +
    `${"precision".padEnd(20)} ` +
    `${"F1".padStart(5)} ` +
    `${"n".padStart(5)} ` +
    `${"ungr".padStart(4)}`
  );
}

function printBreakdown(title: string, cells: Cell[], width: number, note?: string): void {
  console.log("");
  console.log(`  ── ${title} ${"─".repeat(Math.max(0, 68 - title.length))}`);
  if (note) console.log(`     ${note}`);
  console.log(cellHeader("", width));
  for (const c of cells) console.log(cellRow(c, width));
}

// ── Report shape (report.json) ──────────────────────────────────────────────

interface Report {
  meta: {
    runId: string;
    generatedAt: string;
    gitSha?: string;
    node: string;
    /** Provenance is recorded, never remembered (01b house rule). */
    argv: string[];
    arm: string;
    armDescription: string;
    model: string | null;
    /** `reasoning_effort` sent to an OpenAI-compatible provider, or null for the
     * provider default. Load-bearing, not trivia: GLM-5.2 spends ~119 hidden
     * tokens before its first content token, so a reasoning-on and a
     * reasoning-off run of the same model are DIFFERENT arms and must not be
     * compared as if they were one. Env vars are provenance too. */
    reasoningEffort: string | null;
    dryRun: boolean;
    dataset: { url: string; path: string; sha256: string; rows: number };
    sampling: { mode: "all" | "stratified"; limit: number | null; seed: number; selected: number; strata: "label × project_main_language" };
  };
  headline: CellMetrics;
  baseRate: { label1: number; label0: number; total: number };
  breakdowns: {
    byIsAiComment: Cell[];
    byLanguage: Cell[];
    byCategory: Cell[];
    byContext: Cell[];
    bySourceModel: Cell[];
  };
  sweep: SweepRow[];
  outcomes: Outcome[];
}

function renderMarkdown(r: Report): string {
  const L: string[] = [];
  const m = r.headline;
  L.push(`# AACR-Bench adjudication — arm \`${r.meta.arm}\``);
  L.push("");
  L.push(`Run \`${r.meta.runId}\`${r.meta.gitSha ? ` (git ${r.meta.gitSha})` : ""}, ${r.meta.generatedAt}.`);
  if (r.meta.reasoningEffort) L.push(`Reasoning effort: \`${r.meta.reasoningEffort}\` — a different arm from the same model at provider default.`);
  L.push("");
  L.push(`**What this measures:** whether an adjudicator can tell a valid review comment from an invalid one *when handed the comment*. It does **not** measure whether our reviewer would have generated that comment, so it is **not review recall**, and it is **not comparable to AACR-Bench's own generation leaderboard**.`);
  L.push("");
  L.push(`**Dataset bias:** 1,597 of 2,145 comments are AI-generated and expert-verified; only 548 are human-authored. The set over-represents findings AI reviewers already produce. The two halves are reported separately below and are never pooled.`);
  L.push("");
  if (r.meta.dryRun) L.push(`> **--dry-run.** Decisions are a deterministic stub. Every number below is meaningless and exists only to prove the pipeline runs.`);
  L.push("");
  L.push(`| | value |`);
  L.push(`|---|---|`);
  L.push(`| **retention** (kept / label=1) | **${mdRate(m.retention.n, m.retention.d)}** |`);
  L.push(`| interception (dropped / label=0) | ${mdRate(m.interception.n, m.interception.d)} |`);
  L.push(`| precision (positive = valid comment kept) | ${mdRate(m.precision.n, m.precision.d)} |`);
  L.push(`| recall (= retention, by construction) | ${mdRate(m.recall.n, m.recall.d)} |`);
  L.push(`| F1 | ${num(m.f1)} |`);
  L.push(`| graded / ungraded | ${m.graded} / ${m.ungraded} |`);
  L.push("");
  L.push(`Confusion (positive class = "kept a valid comment"): TP ${m.retention.n}, FP ${m.precision.d - m.precision.n}, FN ${m.retention.d - m.retention.n}, TN ${m.interception.n}.`);
  L.push("");

  const table = (title: string, cells: Cell[], note?: string): void => {
    L.push(`## ${title}`);
    L.push("");
    if (note) {
      L.push(note);
      L.push("");
    }
    L.push(`| | retention (L1) | interception (L0) | precision | F1 | n | ungraded |`);
    L.push(`|---|---|---|---|---|---|---|`);
    for (const c of cells) {
      const cm = metrics(c);
      L.push(
        `| ${c.label} | ${mdRate(cm.retention.n, cm.retention.d)} | ${mdRate(cm.interception.n, cm.interception.d)} | ` +
          `${mdRate(cm.precision.n, cm.precision.d)} | ${num(cm.f1)} | ${cm.graded} | ${cm.ungraded} |`,
      );
    }
    L.push("");
  };

  table(
    "By authorship — never pool these",
    r.breakdowns.byIsAiComment,
    "The `human` rows are the more honest distribution: they are what a real reviewer wrote, not what a model produced and an expert then graded.",
  );
  table("By language", r.breakdowns.byLanguage);
  table("By category", r.breakdowns.byCategory);
  table("By context level", r.breakdowns.byContext);
  table("By source model (empty = human-authored)", r.breakdowns.bySourceModel);

  if (r.sweep.length) {
    L.push(`## Threshold sweep`);
    L.push("");
    L.push(`Keeps iff \`confidence >= t\`. \`t=0.0\` must reproduce keep-all and the last row must approach drop-all — that bracketing is the check that the confidence axis is monotone.`);
    L.push("");
    L.push(`| t | retention (L1) | interception (L0) | precision | F1 |`);
    L.push(`|---|---|---|---|---|`);
    for (const s of r.sweep) {
      L.push(
        `| ${s.threshold.toFixed(1)} | ${mdRate(s.retention.n, s.retention.d)} | ${mdRate(s.interception.n, s.interception.d)} | ` +
          `${mdRate(s.precision.n, s.precision.d)} | ${num(s.f1)} |`,
      );
    }
    L.push("");
  }

  L.push(`## Provenance`);
  L.push("");
  L.push("```json");
  L.push(JSON.stringify(r.meta, null, 2));
  L.push("```");
  L.push("");
  L.push(`† marks a cell with n < ${SMALL}. A rate over a tiny subset is not a measurement.`);
  return L.join("\n");
}

// ── Execution ───────────────────────────────────────────────────────────────

/**
 * Rough USD per million tokens, for sizing a spend decision only. Prices as of
 * 2026-08 and NOT authoritative — they are printed with a `≈` and a warning
 * because the alternative is a gate that says nothing. An unknown model prints
 * tokens with no dollar figure rather than guessing.
 */
const PRICES: { match: RegExp; input: number; output: number }[] = [
  { match: /claude-opus/i, input: 15, output: 75 },
  { match: /claude-sonnet/i, input: 3, output: 15 },
  { match: /claude-haiku/i, input: 1, output: 5 },
  { match: /gpt-5(\.\d+)?-mini|gpt-5-\d-mini/i, input: 0.25, output: 2 },
  { match: /gpt-5/i, input: 1.25, output: 10 },
  { match: /deepseek/i, input: 0.28, output: 0.42 },
];

function priceOf(model: string): { input: number; output: number } | null {
  return PRICES.find((p) => p.match.test(model)) ?? null;
}

/**
 * The spend gate. Model spend needs human sign-off in this project ("every
 * eval arm is human-authorised spend" — `docs/plans/deterministic-pr-levers.md`
 * §"Money traps"), and a sub-agent must never do it
 * unprompted — so this REFUSES rather than prompting, and `--yes` is the
 * acknowledgement. Refusal exits 2 so a script can tell it from a real failure.
 */
function spendGate(arm: Arm, rows: Row[], model: string): void {
  if (!arm.usesModel) return;
  const est = arm.estimateTokens?.(rows);
  console.log(`\n── SPEND GATE ───────────────────────────────────────────────────────────`);
  console.log(`   arm            ${arm.name}`);
  console.log(`   model          ${model}`);
  console.log(`   model calls    ${rows.length}`);
  if (est) {
    const price = priceOf(model);
    console.log(`   est. tokens    ${est.input.toLocaleString()} in / ${est.output.toLocaleString()} out  (~4 chars per token; crude)`);
    if (price) {
      const usd = (est.input / 1e6) * price.input + (est.output / 1e6) * price.output;
      console.log(`   est. cost      ≈ $${usd.toFixed(2)}  (list price as of 2026-08, NOT authoritative — check your provider)`);
    } else {
      console.log(`   est. cost      unknown — no price on file for "${model}". Tokens above are the whole estimate.`);
    }
  }
  if (has("yes")) {
    console.log(`   --yes given; proceeding.\n`);
    return;
  }
  console.log("");
  console.log(`   REFUSING. Model spend needs human sign-off (deterministic-pr-levers.md: every eval arm is human-authorised spend).`);
  console.log(`   Re-run with --yes to authorise, or --dry-run to exercise the pipeline for free.`);
  console.log("");
  process.exit(2);
}

async function main(): Promise<number> {
  if (has("help") || has("h")) {
    console.log(readFileSync(import.meta.filename, "utf8").split("*/")[0]);
    return 0;
  }

  const armName = flag("arm") ?? "keep-all";
  if (!ARMS[armName]) die(`unknown --arm "${armName}" (have: ${Object.keys(ARMS).join(", ")})`);
  const dryRun = has("dry-run");
  const all = has("all");
  const limit = flag("limit") ? Number(flag("limit")) : 50;
  if (!Number.isFinite(limit) || limit < 1) die(`--limit must be a positive integer`);
  const seed = flag("seed") ? Number(flag("seed")) : 1;
  const concurrency = flag("concurrency") ? Number(flag("concurrency")) : 4;

  const { path: dsPath, sha256, rows: allRows } = await loadDataset(flag("dataset"));

  // A model arm needs a model id even in --dry-run, so the prompt header and the
  // provenance stamp say which model the prompts were built for. Resolving it
  // must not explode when no key is set and no call will be made.
  const armNeedsModel = armName === "llm";
  let model = flag("model") ?? process.env.EVAL_JUDGE_MODEL?.trim() ?? "";
  if (armNeedsModel && !model) {
    try {
      model = defaultJudgeModel();
    } catch (err) {
      if (!dryRun) die((err as Error).message);
      model = "(unresolved — no provider key; --dry-run makes no calls)";
    }
  }

  const arm = ARMS[armName]({ model, dryRun, printPrompt: has("print-prompt") });

  const selected = all ? allRows.map((row, idx) => ({ idx, row })) : sample(allRows, limit, seed);
  if (!all && limit < allRows.length) {
    // Never silently sample the whole set, and never silently sample a subset
    // either — say which, every time.
    console.log(
      `Sampling ${selected.length} of ${allRows.length} rows — stratified by (label × project_main_language), seed ${seed}. ` +
        `Pass --all for the full set.`,
    );
  } else if (!all) {
    console.log(`--limit ${limit} >= dataset size; scoring all ${allRows.length} rows.`);
  } else {
    console.log(`--all: scoring every one of ${allRows.length} rows.`);
  }

  spendGate(arm, selected.map((s) => s.row), model);

  const started = Date.now();
  const decisions = await mapPool(selected, concurrency, async (s) => arm.decide(s.row));

  const outcomes: Outcome[] = selected.map((s, i) => ({
    idx: s.idx,
    label: s.row.label,
    keep: decisions[i].keep,
    confidence: decisions[i].confidence ?? null,
    reason: decisions[i].reason ?? null,
    error: decisions[i].error ?? null,
    isAi: s.row.is_ai_comment,
    language: s.row.project_main_language,
    category: s.row.category,
    context: s.row.context,
    sourceModel: s.row.source_model || "(human)",
  }));

  const overall = emptyCell("ALL");
  for (const o of outcomes) tally(overall, o);
  const m = metrics(overall);

  const gitSha = gitShortSha();
  const outRoot = join(flag("out") ? resolve(flag("out")!) : resultsRoot(), "aacr-adjudicate");
  const runId = makeRunId(new Date(), gitSha, has("out") && existsSync(outRoot) ? outRoot : undefined);

  const report: Report = {
    meta: {
      runId,
      generatedAt: new Date().toISOString(),
      gitSha,
      node: process.version,
      argv: process.argv.slice(2),
      arm: arm.name,
      armDescription: arm.describe(),
      model: armNeedsModel ? model : null,
      reasoningEffort: armNeedsModel ? (process.env.EVAL_JUDGE_REASONING_EFFORT?.trim() || null) : null,
      dryRun,
      dataset: { url: DATASET_URL, path: dsPath, sha256, rows: allRows.length },
      sampling: {
        mode: all || limit >= allRows.length ? "all" : "stratified",
        limit: all ? null : limit,
        seed,
        selected: selected.length,
        strata: "label × project_main_language",
      },
    },
    headline: m,
    baseRate: {
      label1: selected.filter((s) => s.row.label === 1).length,
      label0: selected.filter((s) => s.row.label === 0).length,
      total: selected.length,
    },
    breakdowns: {
      byIsAiComment: breakdown(outcomes, (o) => (o.isAi ? "AI-authored" : "human-authored")),
      byLanguage: breakdown(outcomes, (o) => o.language),
      byCategory: breakdown(outcomes, (o) => o.category),
      byContext: breakdown(outcomes, (o) => o.context),
      bySourceModel: breakdown(outcomes, (o) => o.sourceModel),
    },
    sweep: sweep(outcomes),
    outcomes,
  };

  // ── stdout: always ────────────────────────────────────────────────────────
  console.log(`\n══ AACR-BENCH ADJUDICATION ═══════════════════════════════════════════════`);
  console.log(`   arm       ${arm.name} — ${arm.describe()}`);
  console.log(`   dataset   ${dsPath}`);
  console.log(`             sha256 ${sha256.slice(0, 16)}…  ${allRows.length} rows  (Apache-2.0, Alibaba-Aone/aacr-bench)`);
  console.log(`   scored    ${selected.length} rows — ${report.baseRate.label1} valid (label=1), ${report.baseRate.label0} invalid (label=0)`);
  console.log(`   elapsed   ${((Date.now() - started) / 1000).toFixed(1)}s`);
  if (dryRun) {
    console.log("");
    console.log(`   ⚠ --dry-run: decisions come from a deterministic STUB, not from ${model}.`);
    console.log(`     Every number below is meaningless. It proves the pipeline runs, nothing else.`);
  }
  console.log("");
  console.log(`   This measures whether an arm can tell a VALID review comment from an INVALID one`);
  console.log(`   WHEN HANDED THE COMMENT. It does NOT measure whether our reviewer would ever have`);
  console.log(`   generated it — so it is NOT review recall, and it is NOT comparable to AACR-Bench's`);
  console.log(`   own generation leaderboard (Open Code Review 20.0%, Claude Code 28.9% recall).`);
  console.log("");
  console.log(`── HEADLINE ─────────────────────────────────────────────────────────────`);
  console.log(`   RETENTION      ${rate(m.retention.n, m.retention.d)}   kept / label=1.  THE number that must not fall:`);
  console.log(`                                            filtering a conservative reviewer has cost recall`);
  console.log(`                                            every time it has been measured (v2, BitsAI-CR, OCR).`);
  console.log(`   interception   ${rate(m.interception.n, m.interception.d)}   dropped / label=0`);
  console.log(`   precision      ${rate(m.precision.n, m.precision.d)}   positive class = "kept a valid comment"`);
  console.log(`   recall         ${rate(m.recall.n, m.recall.d)}   identical to retention by construction`);
  console.log(`   F1             ${num(m.f1)}`);
  console.log(`   confusion      TP ${m.retention.n}  FP ${m.precision.d - m.precision.n}  FN ${m.retention.d - m.retention.n}  TN ${m.interception.n}`);
  console.log(`   ungraded       ${m.ungraded}   (arm errors — excluded from every denominator, never defaulted)`);

  const width = 26;
  printBreakdown(
    "BY AUTHORSHIP — never pool these",
    report.breakdowns.byIsAiComment,
    width,
    "1,597 of 2,145 rows are AI-authored + expert-verified; only 548 are human-authored.\n     The human rows are the more honest distribution — the AI rows over-represent what\n     AI reviewers already produce, which is the population an adjudicator most flatters.",
  );
  printBreakdown("BY LANGUAGE", report.breakdowns.byLanguage, width);
  printBreakdown("BY CATEGORY", report.breakdowns.byCategory, width);
  printBreakdown("BY CONTEXT LEVEL (how much context the annotators needed)", report.breakdowns.byContext, width);
  printBreakdown("BY SOURCE MODEL", report.breakdowns.bySourceModel, width);

  if (report.sweep.length) {
    console.log("");
    console.log(`  ── THRESHOLD SWEEP (keep iff confidence >= t) ────────────────────────`);
    console.log(`     t=0.0 must reproduce keep-all; the top of the curve must approach drop-all.`);
    console.log(`     That bracketing is the check that the confidence axis is monotone.`);
    console.log(`     ${"t".padEnd(5)} ${"RETENTION (L1)".padEnd(20)} ${"interception (L0)".padEnd(20)} ${"precision".padEnd(20)} ${"F1".padStart(5)}`);
    for (const s of report.sweep) {
      console.log(
        `     ${s.threshold.toFixed(1).padEnd(5)} ${rate(s.retention.n, s.retention.d).padEnd(20)} ` +
          `${rate(s.interception.n, s.interception.d).padEnd(20)} ${rate(s.precision.n, s.precision.d).padEnd(20)} ${num(s.f1).padStart(5)}`,
      );
    }
  }

  console.log("");
  console.log(`── CAVEATS (carry these with the numbers) ───────────────────────────────`);
  console.log(`  · † marks n < ${SMALL}. A rate over a tiny subset is not a measurement — do not quote those cells alone.`);
  if (selected.length < 300) {
    console.log(
      `  · n=${selected.length}: the LANGUAGE / CATEGORY / SOURCE-MODEL tables are decoration at this size — ` +
        `10 strata over ${selected.length} rows leaves single-digit cells.`,
    );
    console.log(`    Only the headline and the authorship split carry enough n to read. Use --all (or --limit 500+) for the rest.`);
  }
  console.log(`  · Not review recall. Every comment here already exists; nothing asks whether we'd have written it.`);
  console.log(`  · Not the AACR-Bench leaderboard's metric. Different denominator, different task. Never pool them.`);
  console.log(`  · 74% of the corpus is machine-authored. Read the human-authored row before the pooled one.`);
  console.log(`  · keep-all is production TODAY (no adjudicate phase). An arm that does not beat its F1 is`);
  console.log(`    costing recall for nothing — which is the exact shape of the reverted candidate v2.`);
  console.log("");

  if (has("out")) {
    mkdirSync(outRoot, { recursive: true });
    const runDir = join(outRoot, runId);
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "report.json"), JSON.stringify(report, null, 2) + "\n");
    writeFileSync(join(runDir, "report.md"), renderMarkdown(report) + "\n");
    console.log(`  report.json / report.md  →  ${runDir}\n`);
  }

  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });

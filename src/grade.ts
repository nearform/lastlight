/**
 * Deterministic grading — two signals, no LLM judge.
 *
 *  - Execution (code-fix): copy the held-out tests into the workspace the agent
 *    left behind, run them, and require every FAIL_TO_PASS test to pass and
 *    every PASS_TO_PASS test to stay green. This is SWE-bench's resolved
 *    criterion.
 *  - Behavioral: compare the GitHub mutations the workflow performed (recorded
 *    by the fake GitHub) against the instance's expectations. For triage this
 *    is the primary signal (its output IS GitHub state).
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import type { ExpectGithub, GoldComment } from "./schema.js";
import type { FakeGitHub, SubmittedReview } from "./fake-github.js";
import { judge, parseJudgeJson, defaultJudgeModel } from "./judge.js";

export interface Check {
  name: string;
  ok: boolean;
  detail?: string;
}

// ── Behavioral grade ────────────────────────────────────────────────────────

export function gradeBehavioral(
  expect: ExpectGithub | undefined,
  fake: FakeGitHub,
  ctx: { issueNumber: number; branch: string },
): { ok: boolean; checks: Check[] } {
  const checks: Check[] = [];
  if (!expect) return { ok: true, checks };

  const labels = fake.labelsOn(ctx.issueNumber);
  for (const want of expect.labels_added ?? []) {
    checks.push({ name: `label:${want}`, ok: labels.includes(want), detail: `labels=[${labels.join(", ")}]` });
  }
  for (const absent of expect.labels_absent ?? []) {
    checks.push({ name: `no-label:${absent}`, ok: !labels.includes(absent) });
  }
  if (expect.issue_closed !== undefined) {
    const closed = fake.issueState(ctx.issueNumber) === "closed";
    checks.push({ name: "issue-closed", ok: closed === expect.issue_closed });
  }
  if (expect.comment_matches) {
    const re = new RegExp(expect.comment_matches, "i");
    const comments = fake.commentsOn(ctx.issueNumber);
    checks.push({
      name: `comment~/${expect.comment_matches}/`,
      ok: comments.some((c) => re.test(c)),
      detail: `${comments.length} comment(s)`,
    });
  }
  if (expect.pr_opened) {
    const prs = fake.pulls();
    const pr = prs[0];
    let ok = prs.length > 0;
    let detail = `${prs.length} PR(s)`;
    if (pr) {
      if (expect.pr_opened.base) ok = ok && pr.base.ref === expect.pr_opened.base;
      if (expect.pr_opened.head_is_branch) ok = ok && pr.head.ref === ctx.branch;
      if (expect.pr_opened.title_matches) ok = ok && new RegExp(expect.pr_opened.title_matches, "i").test(pr.title);
      detail = `head=${pr.head.ref} base=${pr.base.ref} title="${pr.title}"`;
    }
    checks.push({ name: "pr-opened", ok, detail });
  }

  if (expect.review_submitted) {
    const reviews = fake.submittedReviews(ctx.issueNumber);
    const r = reviews[0];
    let ok = reviews.length > 0;
    let detail = `${reviews.length} review(s)`;
    if (r) {
      if (expect.review_submitted.event) ok = ok && r.event === expect.review_submitted.event;
      if (expect.review_submitted.body_matches) ok = ok && new RegExp(expect.review_submitted.body_matches, "i").test(r.body);
      detail = `event=${r.event} bodyLen=${r.body.length}`;
    }
    checks.push({ name: "review-submitted", ok, detail });
  }

  return { ok: checks.every((c) => c.ok), checks };
}

// ── Triage gold grade (label-accuracy) ──────────────────────────────────────

/** Canonical triage role names ARE the label strings (see skills/issue-triage). */
export function gradeTriage(
  gold: { category?: string; state?: string } | undefined,
  fake: FakeGitHub,
  issueNumber: number,
): { ok: boolean; checks: Check[] } {
  const checks: Check[] = [];
  if (!gold) return { ok: true, checks };
  const labels = fake.labelsOn(issueNumber);
  if (gold.category) checks.push({ name: `category=${gold.category}`, ok: labels.includes(gold.category), detail: `labels=[${labels.join(", ")}]` });
  if (gold.state) checks.push({ name: `state=${gold.state}`, ok: labels.includes(gold.state), detail: `labels=[${labels.join(", ")}]` });
  return { ok: checks.every((c) => c.ok), checks };
}

// ── PR-review grade (LLM judge → precision / recall / F-beta) ────────────────

export interface ReviewGrade {
  precision: number;
  recall: number;
  /** The F-beta score at {@link ReviewGrade.beta}. Defaults to F1 (β=1), matching
   * Martian's Code Review Bench leaderboard; override with `EVAL_F_BETA`. */
  fbeta: number;
  /** The β used for {@link ReviewGrade.fbeta} (1 = F1 = equal weight; 0.5 = F0.5
   * = precision weighted 2×). */
  beta: number;
  posted: number;
  gold: number;
  matched: number;
  falsePositives: { description: string; file?: string }[];
  falseNegatives: { description: string; file?: string; severity: string }[];
  /** Set if the judge couldn't be run (missing key, HTTP error, unparseable) —
   * the case is ungraded, not zero-scored. */
  error?: string;
  /** The judge's work, so the F-beta score is inspectable in the dashboard rather
   * than a black box: what it read, the findings it distilled, the gold set, the
   * finding↔gold pairing, and its raw replies. Absent when the judge never ran
   * (no review posted / no key). */
  trace?: ReviewTrace;
}

/** An inspectable record of one judge grade — surfaced by the dashboard's
 * "judge" button next to the F-beta score. `matchedGold`/`matchedFinding` are the
 * paired index (into the sibling array) or null when unmatched (a false positive
 * / a missed gold). Text fields are trimmed for the scorecard. */
export interface ReviewTrace {
  judgeModel: string;
  /** The flattened review text (body + inline comments) fed to the extractor. */
  reviewText: string;
  /** Distinct findings the judge distilled from the review. */
  findings: { description: string; file?: string; matchedGold: number | null }[];
  /** The gold set the findings are matched against. */
  gold: { description: string; severity: string; matchedFinding: number | null }[];
  /** The judge's raw reply for the extraction step. */
  rawExtract?: string;
  /** The judge's raw reply for the matching step. */
  rawMatch?: string;
  /** Whether the PR diff was fed to the judge (`--judge-with-diff`). */
  usedDiff?: boolean;
}

/** Cap on trimmed text fields in a {@link ReviewTrace}, keeping the scorecard
 * lean while preserving enough to eyeball the judge's reasoning. */
const TRACE_TEXT_CAP = 8_000;
function capTrace(s: string): string {
  return s.length > TRACE_TEXT_CAP ? s.slice(0, TRACE_TEXT_CAP) + "\n\n[…trimmed]" : s;
}

interface ExtractedFinding {
  description: string;
  file?: string | null;
}

/** F-beta. β=1 (default) is F1 — precision and recall weighted equally, matching
 * Martian's Code Review Bench leaderboard. β<1 weights precision higher (β=0.5 →
 * 2×), β>1 weights recall higher. */
export function fBeta(precision: number, recall: number, beta = 1): number {
  const b2 = beta * beta;
  const denom = b2 * precision + recall;
  return denom > 0 ? ((1 + b2) * precision * recall) / denom : 0;
}

/** The F-beta β for the pr-review grade. Defaults to 1 (F1, Martian's leaderboard
 * metric); `EVAL_F_BETA` overrides it (e.g. 0.5 to weight precision 2×, mirroring
 * Martian's adjustable F-beta). Ignores a non-positive / unparseable value. */
export function defaultBeta(): number {
  const raw = process.env.EVAL_F_BETA?.trim();
  if (!raw) return 1;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/** Human label for a β: `F1`, `F0.5`, `F2`, … */
export function fLabel(beta: number): string {
  return `F${beta}`;
}

/** Flatten a submitted review (body + inline comments) into one text blob for
 * the extractor. Inline comments carry their location so the judge can match on
 * file/line. */
function reviewText(reviews: SubmittedReview[]): string {
  const parts: string[] = [];
  for (const r of reviews) {
    if (r.body?.trim()) parts.push(r.body.trim());
    for (const c of r.comments) {
      const loc = c.line ? `${c.path}:${c.line}` : c.path;
      parts.push(`[inline ${loc}] ${c.body}`);
    }
  }
  return parts.join("\n\n").slice(0, 24_000);
}

const EXTRACT_SYSTEM =
  "You extract the distinct, concrete code-review findings from a reviewer's writeup. " +
  "A finding is a SPECIFIC problem the reviewer identified in the code — a bug, correctness issue, " +
  "security flaw, missing test, performance problem, etc. — tied to a location. " +
  "IGNORE: summaries of what the PR does, praise, approvals, meta commentary, and vague remarks with no concrete problem. " +
  "Merge duplicates that describe the same issue. " +
  "If a PR DIFF is provided, use it ONLY to understand terse or location-anchored comments (what the reviewer's `here`/`this` refers to) — " +
  "NEVER invent a finding from the diff that the reviewer did not raise. " +
  'Output ONLY JSON: {"findings":[{"description":"<the problem>","file":"<path or null>"}]}';

const MATCH_SYSTEM =
  "You judge whether a reviewer's findings match a gold set of KNOWN real issues in a pull request. " +
  "Two items MATCH when they describe the SAME underlying issue — the same root cause or the same required fix — " +
  "even if worded differently or the line is slightly off. Wording need not match; substance must. " +
  "If a PR DIFF is provided, use it to resolve whether a finding and a gold issue point at the same code change. " +
  "Each gold issue matches AT MOST ONE finding, and each finding matches at most one gold issue (choose the best pairing). " +
  'Output ONLY JSON: {"matches":[{"finding":<finding index>,"gold":<gold index>}]}';

/** Cap on the PR diff fed to the judge (diff-aware mode). */
const DIFF_CAP = 20_000;
/** Prefix a judge user turn with the PR diff for context, when provided. */
function withDiffContext(diff: string | undefined, purpose: string, body: string): string {
  if (!diff?.trim()) return body;
  return `PR DIFF (${purpose}):\n\`\`\`diff\n${diff.slice(0, DIFF_CAP)}\n\`\`\`\n\n${body}`;
}

/**
 * Grade a posted PR review against the gold set via an LLM judge, mirroring
 * Martian's Code Review Bench: extract the review's distinct findings, then match
 * each to a golden comment ("same underlying issue?"). Precision = matched ÷
 * posted, recall = matched ÷ gold, combined as F-beta — β=1 (F1) by default to
 * match Martian's leaderboard, `EVAL_F_BETA` to reweight (e.g. 0.5 for precision
 * 2×). A judge failure yields `error` (ungraded), never a silent zero.
 */
export async function gradeReview(opts: {
  gold: GoldComment[];
  reviews: SubmittedReview[];
  judgeModel?: string;
  beta?: number;
  /** The PR diff. When provided (opt-in `--judge-with-diff`), the judge sees the
   * code so it can resolve terse, location-anchored review comments — at the cost
   * of leaderboard parity (Martian's offline judge is diff-blind). */
  diff?: string;
}): Promise<ReviewGrade> {
  const gold = opts.gold;
  const beta = opts.beta ?? defaultBeta();
  const diff = opts.diff?.trim() ? opts.diff : undefined;
  const empty = (partial: Partial<ReviewGrade>): ReviewGrade => ({
    precision: 0,
    recall: 0,
    fbeta: 0,
    beta,
    posted: 0,
    gold: gold.length,
    matched: 0,
    falsePositives: [],
    falseNegatives: gold.map((g) => ({ description: g.description, file: g.file, severity: g.severity })),
    ...partial,
  });
  // A perfectly-clean case (nothing to catch, nothing flagged): precision/recall/F all 1.
  const perfect = (): ReviewGrade => ({
    precision: 1,
    recall: 1,
    fbeta: 1,
    beta,
    posted: 0,
    gold: 0,
    matched: 0,
    falsePositives: [],
    falseNegatives: [],
  });

  const text = reviewText(opts.reviews);
  // No review posted: nothing caught. Perfect only if there was nothing to catch.
  if (!text.trim()) {
    return gold.length === 0 ? perfect() : empty({});
  }

  let model: string;
  try {
    model = opts.judgeModel ?? defaultJudgeModel();
  } catch (err) {
    return empty({ error: (err as Error).message });
  }

  // Raw judge replies, kept for the inspectable trace built at the end.
  let rawExtract = "";
  let rawMatch = "";

  // 1. Extract distinct findings from the review.
  let findings: ExtractedFinding[];
  try {
    rawExtract = await judge(model, EXTRACT_SYSTEM, withDiffContext(diff, "context only — extract findings ONLY from the reviewer's writeup below", `REVIEWER'S WRITEUP:\n${text}`));
    const parsed = parseJudgeJson<{ findings?: ExtractedFinding[] }>(rawExtract);
    if (!parsed?.findings) return empty({ error: "judge: unparseable extraction reply" });
    findings = parsed.findings.filter((f) => f && typeof f.description === "string" && f.description.trim());
  } catch (err) {
    return empty({ error: `judge extract: ${(err as Error).message}` });
  }

  const posted = findings.length;
  if (posted === 0) return gold.length === 0 ? perfect() : empty({});
  if (gold.length === 0) {
    // Findings on a PR with no gold issues are all noise.
    return {
      precision: 0,
      recall: 1,
      fbeta: 0,
      beta,
      posted,
      gold: 0,
      matched: 0,
      falsePositives: findings.map((f) => ({ description: f.description, file: f.file ?? undefined })),
      falseNegatives: [],
    };
  }

  // 2. Match findings ↔ gold.
  const matchUser = JSON.stringify({
    findings: findings.map((f, i) => ({ index: i, description: f.description, file: f.file ?? null })),
    gold: gold.map((g, i) => ({ index: i, file: g.file ?? null, line: g.line ?? null, severity: g.severity, description: g.description })),
  });
  let matches: { finding: number; gold: number }[];
  try {
    rawMatch = await judge(model, MATCH_SYSTEM, withDiffContext(diff, "resolve whether a finding and a gold issue point at the same code", matchUser));
    const parsed = parseJudgeJson<{ matches?: { finding: number; gold: number }[] }>(rawMatch);
    if (!parsed?.matches) return empty({ error: "judge: unparseable match reply", posted });
    matches = parsed.matches;
  } catch (err) {
    return empty({ error: `judge match: ${(err as Error).message}`, posted });
  }

  // De-dup the matching: each finding + each gold used at most once (guard the
  // judge over-pairing), and drop out-of-range indices. Keep the accepted pairing
  // (finding→gold) for the trace.
  const usedFinding = new Set<number>();
  const usedGold = new Set<number>();
  const findingToGold = new Map<number, number>();
  for (const m of matches) {
    if (!Number.isInteger(m.finding) || !Number.isInteger(m.gold)) continue;
    if (m.finding < 0 || m.finding >= posted || m.gold < 0 || m.gold >= gold.length) continue;
    if (usedFinding.has(m.finding) || usedGold.has(m.gold)) continue;
    usedFinding.add(m.finding);
    usedGold.add(m.gold);
    findingToGold.set(m.finding, m.gold);
  }

  const matched = usedFinding.size;
  const precision = matched / posted;
  const recall = matched / gold.length;
  const fbeta = fBeta(precision, recall, beta);

  const falsePositives = findings
    .map((f, i) => ({ f, i }))
    .filter(({ i }) => !usedFinding.has(i))
    .map(({ f }) => ({ description: f.description, file: f.file ?? undefined }));
  const falseNegatives = gold
    .map((g, i) => ({ g, i }))
    .filter(({ i }) => !usedGold.has(i))
    .map(({ g }) => ({ description: g.description, file: g.file, severity: g.severity }));

  const goldToFinding = new Map<number, number>();
  for (const [f, g] of findingToGold) goldToFinding.set(g, f);
  const trace: ReviewTrace = {
    judgeModel: model,
    reviewText: capTrace(text),
    findings: findings.map((f, i) => ({
      description: f.description,
      file: f.file ?? undefined,
      matchedGold: findingToGold.has(i) ? findingToGold.get(i)! : null,
    })),
    gold: gold.map((g, j) => ({
      description: g.description,
      severity: g.severity,
      matchedFinding: goldToFinding.has(j) ? goldToFinding.get(j)! : null,
    })),
    rawExtract: capTrace(rawExtract),
    rawMatch: capTrace(rawMatch),
    usedDiff: !!diff,
  };

  return { precision, recall, fbeta, beta, posted, gold: gold.length, matched, falsePositives, falseNegatives, trace };
}

// ── Execution grade (SWE-bench resolved) ────────────────────────────────────

const TAP_LINE = /^(ok|not ok)\s+\d+\s+-\s+(.+?)(?:\s+#.*)?$/;

export interface ExecutionGrade {
  resolved: boolean;
  failToPass: { id: string; pass: boolean }[];
  passToPass: { id: string; pass: boolean }[];
  raw: string;
}

export function gradeExecution(opts: {
  workDir: string;
  /** Directory of held-out test files to copy in before running (SWE-bench's test_patch, file form). */
  heldOutDir?: string;
  /** Or a unified diff to `git apply` (real SWE-bench instances). */
  testPatch?: string;
  failToPass: string[];
  passToPass: string[];
  /** Override the test command argv (default: node --test over *.test.ts). */
  testCmd?: string[];
  /** Optional install/build argv run in `workDir` BEFORE the tests (git-source
   * repos that need deps, e.g. `["npm","ci"]`). Runs untrusted repo code. */
  setupCmd?: string[];
}): ExecutionGrade {
  // Apply held-out tests the agent never saw.
  if (opts.heldOutDir && existsSync(opts.heldOutDir)) {
    cpSync(opts.heldOutDir, opts.workDir, { recursive: true });
  }
  if (opts.testPatch) {
    const patchFile = join(opts.workDir, ".eval-test.patch");
    writeFileSync(patchFile, opts.testPatch);
    execFileSync("git", ["apply", patchFile], { cwd: opts.workDir, stdio: ["ignore", "pipe", "pipe"] });
  }

  let setupLog = "";
  if (opts.setupCmd?.length) {
    const [bin, ...rest] = opts.setupCmd;
    try {
      setupLog = execFileSync(bin, rest, {
        cwd: opts.workDir,
        env: process.env,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 600_000,
      }).toString();
    } catch (err) {
      const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
      setupLog = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
    }
  }

  // The default runner emits TAP we can parse per-test; a custom `test_cmd` may
  // not — that's fine, suite mode below falls back to the exit code.
  const isDefaultRunner = !opts.testCmd;
  const testFiles = isDefaultRunner ? listTestFiles(opts.workDir) : [];
  const argv = opts.testCmd ?? [
    process.execPath,
    "--test",
    "--test-reporter=tap",
    "--experimental-strip-types",
    ...testFiles,
  ];

  let raw = "";
  let exitOk = false;
  try {
    raw = execFileSync(argv[0], argv.slice(1), {
      cwd: opts.workDir,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 120_000,
    }).toString();
    exitOk = true;
  } catch (err) {
    // A failing test run exits non-zero; its stdout still holds the TAP/log.
    const e = err as { stdout?: Buffer | string; stderr?: Buffer | string };
    raw = (e.stdout?.toString() ?? "") + (e.stderr?.toString() ?? "");
  }

  const passed = parseTap(raw);
  // Named mode when at least one FAIL_TO_PASS id shows up in the TAP stream;
  // otherwise suite mode — grade on the command's exit code.
  const named = opts.failToPass.length > 0 && opts.failToPass.some((id) => passed.has(id));

  // `PASS_TO_PASS: ["*"]` is a wildcard meaning "the ENTIRE suite must stay
  // green" — far more robust than pinning every test by name (which breaks the
  // moment a test is renamed or added). It resolves to the run being green: the
  // command exited 0 and no TAP line reported `not ok`. Other PASS_TO_PASS names
  // (if any) are still checked individually alongside it.
  const passAll = opts.passToPass.includes("*");
  const explicitPass = opts.passToPass.filter((id) => id !== "*");
  const suiteGreen = exitOk && [...passed.values()].every(Boolean);

  let fail: { id: string; pass: boolean }[];
  let pass: { id: string; pass: boolean }[];
  let resolved: boolean;
  if (named) {
    fail = opts.failToPass.map((id) => ({ id, pass: passed.get(id) === true }));
    pass = explicitPass.map((id) => ({ id, pass: passed.get(id) === true }));
    if (passAll) pass.push({ id: "* (all tests)", pass: suiteGreen });
    resolved = fail.every((t) => t.pass) && pass.every((t) => t.pass);
  } else {
    // Suite mode: the held-out tests pass iff the command exited 0. Report each
    // declared id against that single outcome; honor any PASS_TO_PASS names that
    // did surface in TAP.
    fail = opts.failToPass.map((id) => ({ id, pass: exitOk }));
    pass = explicitPass.map((id) => ({ id, pass: passed.has(id) ? passed.get(id) === true : exitOk }));
    if (passAll) pass.push({ id: "* (all tests)", pass: suiteGreen });
    resolved = exitOk && pass.every((t) => t.pass);
  }
  return { resolved, failToPass: fail, passToPass: pass, raw: setupLog ? `${setupLog}\n${raw}` : raw };
}

function parseTap(raw: string): Map<string, boolean> {
  const out = new Map<string, boolean>();
  for (const line of raw.split("\n")) {
    const m = line.trim().match(TAP_LINE);
    if (!m) continue;
    out.set(m[2].trim(), m[1] === "ok");
  }
  return out;
}

function listTestFiles(dir: string, prefix = ""): string[] {
  const out: string[] = [];
  for (const ent of readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === "node_modules" || ent.name === ".git") continue;
    const rel = prefix ? `${prefix}/${ent.name}` : ent.name;
    if (ent.isDirectory()) out.push(...listTestFiles(join(dir, ent.name), rel));
    else if (/\.test\.(ts|tsx|mts|js|mjs)$/.test(ent.name)) out.push(rel);
  }
  return out;
}

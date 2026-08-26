/**
 * Deterministic grading — three signals, no LLM judge.
 *
 *  - Execution (code-fix): copy the held-out tests into the workspace the agent
 *    left behind, run them, and require every FAIL_TO_PASS test to pass and
 *    every PASS_TO_PASS test to stay green. This is SWE-bench's resolved
 *    criterion.
 *  - Behavioral: compare the GitHub mutations the workflow performed (recorded
 *    by the fake GitHub) against the instance's expectations. For triage this
 *    is the primary signal (its output IS GitHub state).
 *  - Markers (fix / dependency-merge): the marker LINES a run signed off with.
 *    For those tiers the verdict is the deliverable — a diagnosis that reaches
 *    the wrong class sends the whole retry loop the wrong way while touching
 *    no GitHub state at all, so behavioral grading alone would score it green.
 */

import { execFileSync } from "node:child_process";
import { cpSync, existsSync, writeFileSync } from "node:fs";
import { readdirSync } from "node:fs";
import { join } from "node:path";

import {
  parseDiagnosisMarker,
  parseFixOutcomeMarker,
  type DiagnosisMarker,
  type FixOutcomeMarker,
} from "lastlight-core/evals";

import type { ExpectGithub, ExpectMarkers, GoldComment } from "./schema.js";
import type { FakeGitHub, SubmittedReview } from "./fake-github.js";
import { judge, parseJudgeJson, defaultJudgeModel } from "./judge.js";

/**
 * One judge call with retries on an UNPARSEABLE reply. Temp-0 judges still
 * occasionally return truncated/malformed JSON (three cases in one day,
 * 2026-08-25 — each erroring a fully-run case as ungraded), and a fresh call
 * almost always parses. A single retry was not enough: the same day's ladder
 * still lost a fully-run case to two bad replies in a row, and each lost case
 * silently shrinks the arm's micro denominator (the exclusion is now also
 * named in `micro.ungradedCases`). Retries parse failures only: a thrown
 * HTTP/key error keeps its existing meaning and path. Returns the LAST raw
 * reply for the trace either way.
 */
const JUDGE_PARSE_ATTEMPTS = 3;
async function judgeParsed<T>(
  model: string,
  system: string,
  user: string,
  valid: (parsed: T | null) => boolean,
): Promise<{ raw: string; parsed: T | null }> {
  let raw = "";
  let parsed: T | null = null;
  for (let attempt = 0; attempt < JUDGE_PARSE_ATTEMPTS; attempt++) {
    raw = await judge(model, system, user);
    parsed = parseJudgeJson<T>(raw);
    if (valid(parsed)) break;
  }
  return { raw, parsed };
}

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
  if (expect.pr_merged !== undefined) {
    const merged = fake.mergeOf(ctx.issueNumber);
    checks.push({
      name: expect.pr_merged ? "pr-merged" : "pr-not-merged",
      ok: !!merged === expect.pr_merged,
      detail: merged ? `merged via ${merged.method}` : "not merged",
    });
  }
  if (expect.auto_merge_enabled !== undefined) {
    const auto = fake.autoMergeOf(ctx.issueNumber);
    checks.push({
      name: expect.auto_merge_enabled ? "auto-merge-enabled" : "auto-merge-not-enabled",
      ok: !!auto === expect.auto_merge_enabled,
      detail: auto ? `auto-merge via ${auto.method}` : "auto-merge off",
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
    // Two checks, not one: "a review exists (with the right event)" and "its
    // body matches" are different failures, and folding them under one name
    // made a body_matches miss read as "failed to post a review" — while the
    // detail string (`event=… bodyLen=6365`) was proving a review existed
    // (the 1641 misread, 2026-08-24).
    let submitted = reviews.length > 0;
    let detail = `${reviews.length} review(s)`;
    if (r) {
      if (expect.review_submitted.event) submitted = submitted && r.event === expect.review_submitted.event;
      detail = `event=${r.event} bodyLen=${r.body.length}`;
    }
    checks.push({ name: "review-submitted", ok: submitted, detail });
    if (expect.review_submitted.body_matches) {
      const pattern = expect.review_submitted.body_matches;
      const bodyOk = !!r && new RegExp(pattern, "i").test(r.body);
      checks.push({ name: "review-body", ok: bodyOk, detail: `body ~ /${pattern}/i` });
    }
  }

  return { ok: checks.every((c) => c.ok), checks };
}

// ── Marker grade (fix / dependency-merge) ───────────────────────────────────

/**
 * The `ASSESSMENT_COMPLETE` marker the merge workflow signs off with.
 *
 * Parsed here rather than in core because core never reads it back: the merge
 * run's postcondition only requires the tag to be PRESENT, and the impact tier
 * it carries is a self-report the code deliberately does not enforce
 * (`spec/02-configuration.md` → "Where `dependencies` is enforced"). That is
 * exactly why it needs an eval — a self-report nothing checks is measurable
 * only by measuring it.
 */
export function parseAssessmentMarker(
  output: string,
): { verdict?: string; impact?: string; action?: string } | null {
  // Last marker wins, and the tag must carry its colon — a sentence that merely
  // mentions `ASSESSMENT_COMPLETE` is not a verdict. Same rule as core's
  // `lastMarkerLine`, which is why the two fix markers below go through core.
  const lines = output.split(/\r?\n/).filter((l) => l.includes("ASSESSMENT_COMPLETE:"));
  const line = lines.at(-1);
  if (!line) return null;
  const field = (k: string) => new RegExp(`\\b${k}=([^\\s]+)`).exec(line)?.[1];
  return { verdict: field("verdict"), impact: field("impact"), action: field("action") };
}

/** Every phase's output, newest last — a loop's iterations included. */
function allOutput(phases: { output?: string }[]): string {
  return phases.map((p) => p.output ?? "").join("\n");
}

/**
 * Grade the marker lines a run emitted.
 *
 * The parsers are CORE's (`parseDiagnosisMarker` / `parseFixOutcomeMarker`), so
 * a bare tag with no colon scores as "no marker" here exactly as it does in the
 * harvest that feeds the next attempt — the disagreement that let a silent
 * no-op run pass as a diagnosis (issue #251).
 */
export function gradeMarkers(
  expect: ExpectMarkers | undefined,
  phases: { output?: string }[],
): { ok: boolean; checks: Check[] } {
  const checks: Check[] = [];
  if (!expect) return { ok: true, checks };

  const output = allOutput(phases);
  const diagnosis: DiagnosisMarker | null = parseDiagnosisMarker(output);
  const fix: FixOutcomeMarker | null = parseFixOutcomeMarker(output);
  const assessment = parseAssessmentMarker(output);

  const eq = (name: string, want: string | undefined, got: string | undefined) => {
    if (want === undefined) return;
    checks.push({ name: `${name}=${want}`, ok: got === want, detail: `got ${got ?? "(no marker)"}` });
  };
  const oneOf = (name: string, want: string[] | undefined, got: string | undefined) => {
    if (!want || want.length === 0) return;
    checks.push({
      name: `${name}∈{${want.join("|")}}`,
      ok: got !== undefined && want.includes(got),
      detail: `got ${got ?? "(no marker)"}`,
    });
  };

  // `?? undefined`: core's parsers return `null` for a field the marker line
  // omitted, and a missing field must read as "(no marker)" rather than as the
  // string "null".
  eq("diagnosis.class", expect.diagnosis_class, diagnosis?.class ?? undefined);
  oneOf("diagnosis.class", expect.diagnosis_class_any_of, diagnosis?.class ?? undefined);
  eq("fix.outcome", expect.fix_outcome, fix?.outcome ?? undefined);
  eq("fix.gate", expect.fix_gate, fix?.gate ?? undefined);
  eq("assessment.impact", expect.assessment_impact, assessment?.impact);
  eq("assessment.action", expect.assessment_action, assessment?.action);
  oneOf("assessment.action", expect.assessment_action_any_of, assessment?.action);

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
  /** Findings scored against gold — excludes any neutralized ones. */
  posted: number;
  gold: number;
  /** Gold comments caught — recall's numerator. */
  matched: number;
  /** Findings that matched ≥1 gold — precision's numerator. Diverges from
   * {@link matched} only under `match-v2`, where one posted comment can carry
   * two gold defects. Consumers read `matchedFindings ?? matched`. */
  matchedFindings?: number;
  /** Findings before neutral-set exclusion; absent when nothing was neutralized. */
  postedRaw?: number;
  /** Findings excluded from scoring: they matched the case's sibling-round
   * neutral gold, so they are real defects of this PR that this case's gold
   * doesn't credit. Neither matched nor false positives. */
  neutralized?: { description: string; file?: string }[];
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
  /** Distinct findings the judge distilled from the review. `matchedGold` is
   * the first (usually only) matched gold; `matchedGolds` appears when
   * `match-v2` paired one finding with several. */
  findings: { description: string; file?: string; matchedGold: number | null; matchedGolds?: number[] }[];
  /** The gold set the findings are matched against. */
  gold: { description: string; severity: string; matchedFinding: number | null }[];
  /** The neutral (sibling-round) set and which finding each entry absorbed. */
  neutral?: { description: string; matchedFinding: number | null }[];
  /** The judge's raw reply for the extraction step. */
  rawExtract?: string;
  /** The judge's raw reply for the matching step. */
  rawMatch?: string;
  /** The judge's raw reply for the neutral-set matching step. */
  rawNeutralMatch?: string;
  /** Which MATCH prompt graded this case; absent = the original one-to-one
   * `match-v1`. A cross-version comparison measures the grader, not the arm. */
  matchPrompt?: string;
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

/**
 * The current posted-side MATCH prompt — **`match-v2`**, many-to-one.
 *
 * v1's one-to-one pairing under-scores a review whose single comment genuinely
 * asserts two gold defects. Measured on the 2026-08-25 ladder: a posted
 * paragraph stating both the MIME-type trust defect and the shared-drive
 * omission was credited with one match and charged one false negative for the
 * defect its own text stated — twice, on the arm with the best recall in the
 * set. One gold still matches at most one finding (a defect caught once is
 * caught once); the relaxation is only that one FINDING may carry several
 * distinct gold defects it explicitly asserts.
 *
 * Versioned rather than edited in place ({@link MATCH_SYSTEM} stays frozen):
 * published numbers were graded under v1, `--repeat-judge` measures a specific
 * grader, and the anchors artifact set the precedent — ship a better instrument
 * as v2 and stamp it (`trace.matchPrompt`), never rewrite what past numbers
 * meant. {@link INTERNAL_MATCH_SYSTEM} deliberately stays on the v1 base for
 * the same reason: internal recall was back-filled across preserved runs under
 * that prompt.
 */
const MATCH_SYSTEM_V2 =
  "You judge whether a reviewer's findings match a gold set of KNOWN real issues in a pull request. " +
  "Two items MATCH when they describe the SAME underlying issue — the same root cause or the same required fix — " +
  "even if worded differently or the line is slightly off. Wording need not match; substance must. " +
  "If a PR DIFF is provided, use it to resolve whether a finding and a gold issue point at the same code change. " +
  "Each gold issue matches AT MOST ONE finding (choose the best one). A single finding MAY match several gold issues, " +
  "but only when its text explicitly asserts each of those distinct defects — never because they are merely related. " +
  'Output ONLY JSON: {"matches":[{"finding":<finding index>,"gold":<gold index>}]}';

/** Stamped on every trace graded by {@link MATCH_SYSTEM_V2}. */
export const MATCH_PROMPT_VERSION = "match-v2";

/**
 * The internal-recall MATCH prompt — {@link MATCH_SYSTEM} plus a
 * claim-direction requirement, as its OWN constant on purpose.
 *
 * The posted path never needed the clause because EXTRACT filters praise and
 * approvals before MATCH sees them. The internal path has no EXTRACT —
 * `findings.json` is fed to MATCH directly — and the pipeline's findings
 * include VERIFICATION REPORTS: *"Enforcement check passed:
 * SILENT_SIGN_IN_NONCE_MAX_AGE_SECONDS — properly enforced"*, confidence 1.00.
 * Measured on the stored X1 repeats (journal §2f, git history; summarised in
 * `docs/plans/deterministic-pr-levers.md` §"The instrument (WP8)"), the shared prompt
 * credited exactly those against gold whose entire point is the opposite claim
 * ("nothing compares `issuedAt` against the max-age constant") — same
 * constant, same file, opposite verdict, scored as "found". Every
 * "found-but-withheld" credit on the audited one-case repeats traced to an
 * opposite-direction or neutral-description match, which is what H-A1 was
 * standing on.
 *
 * Kept separate rather than editing {@link MATCH_SYSTEM}: the posted-side
 * numbers are published and pinned by the rescore/backfill drift refusals, and
 * `--repeat-judge` measures THAT grader — its prompt must not move under it.
 */
const INTERNAL_MATCH_SYSTEM =
  MATCH_SYSTEM.replace("Output ONLY JSON:", "") +
  "A finding matches a gold issue ONLY if it asserts the same DEFECT or RISK — the same thing being wrong. " +
  "A finding that asserts the mechanism is correctly handled, properly enforced, satisfied, unchanged, or merely " +
  "DESCRIBES the code's behaviour without claiming anything is wrong is a NON-match for every gold issue, even when " +
  "it names the same constant, file, or mechanism: a verification report about the right location is still not a " +
  "report of the defect. " +
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
  /** Sibling-round gold (`review_gold_neutral`): real defects of this PR that
   * this case's gold doesn't credit. A finding matching one is excluded from
   * scoring — neither a match nor a false positive. */
  neutralGold?: GoldComment[];
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
  const perfect = (trace?: ReviewTrace): ReviewGrade => ({
    precision: 1,
    recall: 1,
    fbeta: 1,
    beta,
    posted: 0,
    gold: 0,
    matched: 0,
    falsePositives: [],
    falseNegatives: [],
    trace,
  });

  // A minimal trace for the zero-findings outcomes, so the dashboard's judge modal
  // explains the 0 instead of rendering nothing. Two cases both land here: no review
  // was posted at all, OR the judge read a review but distilled no concrete findings
  // from it (e.g. an APPROVE that only lists confirmations). Every finding/gold is
  // unmatched by definition. Distinguishable in the modal by whether `reviewText` and
  // the extracted `findings` are present.
  const bareTrace = (t: { judgeModel: string; reviewText: string; findings?: ExtractedFinding[]; rawExtract?: string }): ReviewTrace => ({
    judgeModel: t.judgeModel,
    reviewText: capTrace(t.reviewText),
    findings: (t.findings ?? []).map((f) => ({ description: f.description, file: f.file ?? undefined, matchedGold: null })),
    gold: gold.map((g) => ({ description: g.description, severity: g.severity, matchedFinding: null })),
    rawExtract: t.rawExtract ? capTrace(t.rawExtract) : undefined,
    usedDiff: !!diff,
  });

  const text = reviewText(opts.reviews);

  // Resolve the judge model up front. If it can't be resolved (missing key) AND a
  // review WAS posted, the case is ungraded (errored) — never a silent zero. With
  // nothing posted there's nothing to judge, so we still return a clean traced result.
  let model: string;
  try {
    model = opts.judgeModel ?? defaultJudgeModel();
  } catch (err) {
    if (text.trim()) return empty({ error: (err as Error).message });
    model = "";
  }

  // No review posted: nothing caught. Perfect only if there was nothing to catch.
  if (!text.trim()) {
    const trace = bareTrace({ judgeModel: model, reviewText: text });
    return gold.length === 0 ? perfect(trace) : empty({ trace });
  }

  // Raw judge replies, kept for the inspectable trace built at the end.
  let rawExtract = "";
  let rawMatch = "";

  // 1. Extract distinct findings from the review.
  let findings: ExtractedFinding[];
  try {
    const { raw, parsed } = await judgeParsed<{ findings?: ExtractedFinding[] }>(
      model,
      EXTRACT_SYSTEM,
      withDiffContext(diff, "context only — extract findings ONLY from the reviewer's writeup below", `REVIEWER'S WRITEUP:\n${text}`),
      (p) => !!p?.findings,
    );
    rawExtract = raw;
    if (!parsed?.findings) return empty({ error: "judge: unparseable extraction reply" });
    findings = parsed.findings.filter((f) => f && typeof f.description === "string" && f.description.trim());
  } catch (err) {
    return empty({ error: `judge extract: ${(err as Error).message}` });
  }

  const posted = findings.length;
  if (posted === 0) {
    // The judge read the review but extracted no concrete findings (e.g. an
    // approval). Trace it so the 0 is inspectable, not a blank modal.
    const trace = bareTrace({ judgeModel: model, reviewText: text, findings, rawExtract });
    return gold.length === 0 ? perfect(trace) : empty({ trace });
  }
  // 2. Match findings ↔ gold (match-v2: one finding may carry several golds).
  // A no-gold case skips the call — its findings go straight to the neutral
  // pass, then to falsePositives. Every path below still builds a full trace:
  // the no-gold early return was the ONE path that used to omit it, so a canary
  // case's false positives rendered with no review text behind them — which
  // read as "false positives on a review that was never posted" (the 1641
  // misread, 2026-08-24).
  let findingToGolds = new Map<number, number[]>();
  if (gold.length > 0) {
    const matchUser = JSON.stringify({
      findings: findings.map((f, i) => ({ index: i, description: f.description, file: f.file ?? null })),
      gold: gold.map((g, i) => ({ index: i, file: g.file ?? null, line: g.line ?? null, severity: g.severity, description: g.description })),
    });
    try {
      const { raw, parsed } = await judgeParsed<{ matches?: { finding: number; gold: number }[] }>(
        model,
        MATCH_SYSTEM_V2,
        withDiffContext(diff, "resolve whether a finding and a gold issue point at the same code", matchUser),
        (p) => !!p?.matches,
      );
      rawMatch = raw;
      if (!parsed?.matches) return empty({ error: "judge: unparseable match reply", posted });
      findingToGolds = acceptPairsManyToOne(parsed.matches, posted, gold.length);
    } catch (err) {
      return empty({ error: `judge match: ${(err as Error).message}`, posted });
    }
  }

  // 2b. Neutral pass: findings that matched no gold get one chance to be
  // absorbed by the sibling-round neutral set (see `review_gold_neutral`).
  // Runs AFTER the gold match so the case's own gold always wins a finding.
  // A judge failure here errors the case like any other judge failure — a
  // silently skipped neutral pass would grade the same review two different
  // ways depending on a transient network error.
  const neutralGold = opts.neutralGold ?? [];
  let rawNeutralMatch = "";
  const neutralOfFinding = new Map<number, number>();
  if (neutralGold.length > 0) {
    const candidates = findings.map((f, i) => ({ f, i })).filter(({ i }) => !findingToGolds.has(i));
    if (candidates.length > 0) {
      const neutralUser = JSON.stringify({
        findings: candidates.map(({ f }, k) => ({ index: k, description: f.description, file: f.file ?? null })),
        gold: neutralGold.map((g, i) => ({ index: i, file: g.file ?? null, line: g.line ?? null, severity: g.severity, description: g.description })),
      });
      try {
        const { raw, parsed } = await judgeParsed<{ matches?: { finding: number; gold: number }[] }>(
          model,
          MATCH_SYSTEM_V2,
          withDiffContext(diff, "resolve whether a finding and a gold issue point at the same code", neutralUser),
          (p) => !!p?.matches,
        );
        rawNeutralMatch = raw;
        if (!parsed?.matches) return empty({ error: "judge: unparseable neutral match reply", posted });
        for (const m of parsed.matches) {
          if (!Number.isInteger(m.finding) || !Number.isInteger(m.gold)) continue;
          if (m.finding < 0 || m.finding >= candidates.length || m.gold < 0 || m.gold >= neutralGold.length) continue;
          const original = candidates[m.finding].i;
          if (!neutralOfFinding.has(original)) neutralOfFinding.set(original, m.gold);
        }
      } catch (err) {
        return empty({ error: `judge neutral match: ${(err as Error).message}`, posted });
      }
    }
  }

  const usedGold = new Set<number>();
  for (const golds of findingToGolds.values()) for (const g of golds) usedGold.add(g);
  const matchedFindings = findingToGolds.size;
  const matched = usedGold.size;
  const neutralized = findings
    .map((f, i) => ({ f, i }))
    .filter(({ i }) => neutralOfFinding.has(i))
    .map(({ f }) => ({ description: f.description, file: f.file ?? undefined }));
  const postedScored = posted - neutralized.length;

  // With everything posted neutralized on a no-gold case, the review said
  // nothing wrong that wasn't true of the PR: that is the clean outcome, not a
  // precision 0.
  const precision = postedScored > 0 ? matchedFindings / postedScored : gold.length === 0 ? 1 : 0;
  const recall = gold.length > 0 ? matched / gold.length : 1;
  const fbeta = fBeta(precision, recall, beta);

  const falsePositives = findings
    .map((f, i) => ({ f, i }))
    .filter(({ i }) => !findingToGolds.has(i) && !neutralOfFinding.has(i))
    .map(({ f }) => ({ description: f.description, file: f.file ?? undefined }));
  const falseNegatives = gold
    .map((g, i) => ({ g, i }))
    .filter(({ i }) => !usedGold.has(i))
    .map(({ g }) => ({ description: g.description, file: g.file, severity: g.severity }));

  const goldToFinding = new Map<number, number>();
  for (const [f, golds] of findingToGolds) for (const g of golds) if (!goldToFinding.has(g)) goldToFinding.set(g, f);
  const findingOfNeutral = new Map<number, number>();
  for (const [f, n] of neutralOfFinding) if (!findingOfNeutral.has(n)) findingOfNeutral.set(n, f);
  const trace: ReviewTrace = {
    judgeModel: model,
    reviewText: capTrace(text),
    findings: findings.map((f, i) => {
      const golds = findingToGolds.get(i);
      return {
        description: f.description,
        file: f.file ?? undefined,
        matchedGold: golds?.length ? golds[0] : null,
        ...(golds && golds.length > 1 ? { matchedGolds: golds } : {}),
      };
    }),
    gold: gold.map((g, j) => ({
      description: g.description,
      severity: g.severity,
      matchedFinding: goldToFinding.has(j) ? goldToFinding.get(j)! : null,
    })),
    ...(neutralGold.length
      ? { neutral: neutralGold.map((g, j) => ({ description: g.description, matchedFinding: findingOfNeutral.get(j) ?? null })) }
      : {}),
    rawExtract: capTrace(rawExtract),
    ...(rawMatch ? { rawMatch: capTrace(rawMatch) } : {}),
    ...(rawNeutralMatch ? { rawNeutralMatch: capTrace(rawNeutralMatch) } : {}),
    matchPrompt: MATCH_PROMPT_VERSION,
    usedDiff: !!diff,
  };

  return {
    precision,
    recall,
    fbeta,
    beta,
    posted: postedScored,
    gold: gold.length,
    matched,
    matchedFindings,
    ...(neutralized.length ? { postedRaw: posted, neutralized } : {}),
    falsePositives,
    falseNegatives,
    trace,
  };
}

/**
 * De-dup a judge's pairing: each finding and each gold used at most once, and
 * out-of-range indices dropped.
 *
 * The judge is instructed to pair one-to-one and mostly does; this is the guard
 * for when it does not, and it must be the SAME guard on both passes below —
 * internal recall differing from posted recall because the two ends counted
 * over-pairing differently would be a measurement artifact wearing a result's
 * clothes.
 */
/**
 * Accept a `match-v2` pairing: each gold used at most once, findings reusable
 * across golds (one comment may assert two distinct defects), out-of-range
 * indices dropped. The 1-to-1 {@link acceptPairs} guard stays for the internal
 * pass, which is frozen on the v1 prompt (see {@link MATCH_SYSTEM_V2}).
 */
function acceptPairsManyToOne(matches: { finding: number; gold: number }[], nFindings: number, nGold: number): Map<number, number[]> {
  const usedGold = new Set<number>();
  const findingToGolds = new Map<number, number[]>();
  for (const m of matches) {
    if (!Number.isInteger(m.finding) || !Number.isInteger(m.gold)) continue;
    if (m.finding < 0 || m.finding >= nFindings || m.gold < 0 || m.gold >= nGold) continue;
    if (usedGold.has(m.gold)) continue;
    usedGold.add(m.gold);
    const golds = findingToGolds.get(m.finding) ?? [];
    golds.push(m.gold);
    findingToGolds.set(m.finding, golds);
  }
  return findingToGolds;
}

function acceptPairs(matches: { finding: number; gold: number }[], nFindings: number, nGold: number): Map<number, number> {
  const usedFinding = new Set<number>();
  const usedGold = new Set<number>();
  const findingToGold = new Map<number, number>();
  for (const m of matches) {
    if (!Number.isInteger(m.finding) || !Number.isInteger(m.gold)) continue;
    if (m.finding < 0 || m.finding >= nFindings || m.gold < 0 || m.gold >= nGold) continue;
    if (usedFinding.has(m.finding) || usedGold.has(m.gold)) continue;
    usedFinding.add(m.finding);
    usedGold.add(m.gold);
    findingToGold.set(m.finding, m.gold);
  }
  return findingToGold;
}

/** Gold matched by everything the pipeline generated, posted or not. */
export interface InternalRecallGrade {
  /** `goldToFinding[j]` — the index into the supplied findings that matched gold
   * `j`, or `null`. Same index space the caller passed in, so a match can be
   * attributed back to the finding's family and tier. */
  goldToFinding: (number | null)[];
  matched: number;
  /** The judge failed. `matched` is then 0 and must NOT be read as a result —
   * an ungraded internal pass is not an internal recall of zero. */
  error?: string;
}

/**
 * **Internal recall** — did the pipeline find it at all, as against did it say
 * it.
 *
 * `gradeReview` judges the posted review text, so a finding the attention
 * boundary tiered `internal` is indistinguishable from one that was never
 * generated. Those are completely different failures: the first is an attention
 * problem with a threshold to turn, the second is the discovery ceiling this
 * plan's whole thesis is about
 * (`docs/plans/deterministic-pr-levers.md`). Measuring them as one number
 * is how "the filters kept their hands off gold" and "the boundary is inert"
 * were both believed at once.
 *
 * **One judge call, not two.** The EXTRACT step exists to distil free-text prose
 * into discrete findings; `findings.json` is already a structured list, so this
 * runs only MATCH. That is what makes it ~$0.01 a case and affordable to
 * back-fill across every preserved run.
 */
export async function gradeInternalRecall(opts: {
  gold: GoldComment[];
  findings: ExtractedFinding[];
  judgeModel?: string;
  diff?: string;
}): Promise<InternalRecallGrade | undefined> {
  const { gold, findings } = opts;
  // Nothing to measure. Distinct from "measured zero", hence `undefined`.
  if (!gold.length || !findings.length) return undefined;

  let model: string;
  try {
    model = opts.judgeModel ?? defaultJudgeModel();
  } catch (err) {
    return { goldToFinding: gold.map(() => null), matched: 0, error: (err as Error).message };
  }

  const diff = opts.diff?.trim() ? opts.diff : undefined;
  const user = JSON.stringify({
    findings: findings.map((f, i) => ({ index: i, description: f.description, file: f.file ?? null })),
    gold: gold.map((g, i) => ({ index: i, file: g.file ?? null, line: g.line ?? null, severity: g.severity, description: g.description })),
  });

  let matches: { finding: number; gold: number }[];
  try {
    const { parsed } = await judgeParsed<{ matches?: { finding: number; gold: number }[] }>(
      model,
      INTERNAL_MATCH_SYSTEM,
      withDiffContext(diff, "resolve whether a finding and a gold issue point at the same code", user),
      (p) => !!p?.matches,
    );
    if (!parsed?.matches) return { goldToFinding: gold.map(() => null), matched: 0, error: "judge: unparseable match reply" };
    matches = parsed.matches;
  } catch (err) {
    return { goldToFinding: gold.map(() => null), matched: 0, error: `internal match: ${(err as Error).message}` };
  }

  const findingToGold = acceptPairs(matches, findings.length, gold.length);
  const goldToFinding: (number | null)[] = gold.map(() => null);
  for (const [f, g] of findingToGold) goldToFinding[g] = f;
  return { goldToFinding, matched: findingToGold.size };
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

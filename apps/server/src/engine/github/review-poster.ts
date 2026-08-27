/**
 * Pure PR-review composition: turn a set of structured findings + the PR diff
 * into the payload for one formal GitHub review (`POST /pulls/{n}/reviews`).
 *
 * This is the tested core of the first-class `post-review` action
 * (`PhaseExecutor.runPostReview`). It replaces the ~150-line JS blob that used
 * to live inline in `workflows/pr-review.yaml` — that script depended on the AI
 * agent hand-writing `pr_number`/`base_ref`/`head_sha` into the findings file
 * and silently `exit 0`'d on any mismatch. Here the harness owns all of that:
 * the agent supplies only *content* (`summary`, `event`, `findings`), and this
 * module anchors each finding to the diff, demoting anything off-diff to the
 * body (GitHub 422s on comments that don't sit on a changed line).
 *
 * No I/O — every function is a pure transform, so the anchoring rules are
 * exercised directly in `review-poster.test.ts` rather than by eval-extracting
 * a function out of a YAML string.
 */

export type ReviewEvent = "APPROVE" | "REQUEST_CHANGES" | "COMMENT";
export type ReviewSide = "LEFT" | "RIGHT";

/** One finding as written by the `pr-review` skill into findings.json. */
export interface ReviewFinding {
  path: string;
  /**
   * ADVISORY since WP6a. The model is asked for it, but {@link resolveAnchor}
   * derives the real value from {@link ReviewFinding.existingCode} and
   * overwrites this when it succeeds. Optional because a finding whose excerpt
   * resolves needs no line at all, and one whose excerpt does not resolve is
   * demoted to the body — where a wrong number is worse than none.
   */
  line?: number;
  side?: ReviewSide;
  start_line?: number;
  severity?: string;
  title?: string;
  body?: string;
  suggestion?: string;
  /**
   * The verbatim excerpt the finding is about — the anchor of record.
   *
   * **Models quote code well and count lines badly.** `alibaba/open-code-review`
   * names the failure "position drift" and lists it second of the three its
   * architecture is built against; our own cost is worse than theirs, because
   * `post-review` DEMOTES an off-diff line rather than correcting it, so a
   * finding whose analysis is perfect and whose arithmetic is off by two pays
   * the full price of a wrong answer. See {@link resolveAnchor}.
   */
  existingCode?: string;
  /** The obligation family this came from — the key for the per-family threshold (WP6b). */
  family?: string;
  /** 0..1. Absent is NOT zero — see {@link tierFindings}. */
  confidence?: number;
  /**
   * The survey hypothesis ids this finding was built from, as written by the
   * `adjudicate` phase (`findings[].hypotheses[]`, the same field the
   * conservation gate reads).
   *
   * **Optional, and an empty array is not the same as a clean one.** A finding
   * with none is either the shipped reviewer's own — which was never
   * hypothesis-derived — or one the adjudicator generated downstream of the
   * surveys. Neither can be judged by its provenance, so both keep the
   * confidence path. See {@link tierFindings}.
   */
  hypotheses?: string[];
  /**
   * An EXPLICIT destination, set by the `adjudicate` phase (and by
   * `lastlight-facts findings --repair`, which records an unaccounted-for
   * hypothesis at `internal`).
   *
   * Honoured in one direction only: `internal` and `body` are obeyed, `inline`
   * is a request that still has to clear anchorability and the budget. A
   * document may not grant itself a scarce inline slot — but it must always be
   * able to say "record this, do not post it", or the conservation floor's
   * repaired findings would be POSTED, which is the opposite of what recording
   * them means.
   */
  tier?: "inline" | "body" | "internal";
}

/** A finding that has an anchor. Narrowed by {@link splitFindings}. */
export type AnchoredFinding = ReviewFinding & { line: number };

/** One axis of the split verdict. `unknown` = not assessed, which is not a pass. */
export type AxisVerdict = "pass" | "fail" | "unknown";

/**
 * The per-axis verdict — issue #271's fix 7.
 *
 * > *"A blended verdict lets the passing axis hide the failing one."*
 *
 * A change that is clean by every standards check but does not do what the
 * issue asked is exactly the case a single `event` cannot express, and the
 * production numbers say it is not hypothetical: 71% APPROVE, 58 of 59
 * approvals carrying zero inline findings.
 *
 * `unknown` is a first-class value and deliberately does NOT block: it is the
 * honest answer when a PR states no acceptance criteria, which is most of them.
 * Treating "not assessed" as "failed" would stop the reviewer approving
 * anything, which is a worse reviewer, not a stricter one.
 */
export interface SplitVerdict {
  spec?: AxisVerdict;
  standards?: AxisVerdict;
}

/**
 * The findings document the agent writes. `pr_number` / `base_ref` /
 * `head_sha` are intentionally NOT here — the harness knows them from its own
 * run context and the PR object, so the agent never hand-copies metadata.
 */
export interface ReviewFindingsDoc {
  skip?: boolean;
  summary?: string;
  event?: ReviewEvent;
  findings?: ReviewFinding[];
  /**
   * Optional per-axis verdict. Absent ⇒ today's behaviour exactly, which is
   * what makes the field safe to add before anything writes it.
   *
   * The `post-review` handler strips this unless `review.analysis.enabled`, so
   * inertness is structural rather than a promise about what a prompt says.
   */
  verdict?: SplitVerdict;
}

/** An inline review comment in the shape GitHub's create-review API expects. */
export interface InlineComment {
  path: string;
  line: number;
  side: ReviewSide;
  body: string;
  start_line?: number;
  start_side?: ReviewSide;
}

/** Everything needed to POST one review, ready for `createPullRequestReview`. */
export interface BuiltReview {
  event: ReviewEvent;
  body: string;
  comments: InlineComment[];
  inlineCount: number;
  demotedCount: number;
  /** Below the floor: recorded, never posted. Always 0 without an {@link AttentionBoundary}. */
  internalCount: number;
  /**
   * The tiering this review was built from, present only when an
   * {@link AttentionBoundary} was supplied.
   *
   * Returned rather than recomputed by the caller so that the review that gets
   * POSTED and the disposition record that gets AUDITED are the same object.
   * Two calls to a pure function on identical arguments cannot disagree today —
   * but the audit trail claiming something the post did not do is precisely the
   * failure the `internal` tier's auditability exists to rule out, and one edit
   * to either branch is all it would take.
   */
  tiered?: TieredFindings;
}

const FENCE = "```";

/** One line of one hunk, with the line number it carries on each side. */
export interface DiffLine {
  /** `+` added · `-` removed · ` ` context. */
  prefix: "+" | "-" | " ";
  /** The line's text, with the diff prefix character stripped. */
  text: string;
  /** Old-file line number, or `null` for an added line. */
  left: number | null;
  /** New-file line number, or `null` for a removed line. */
  right: number | null;
}

/** One `@@` hunk. Lines within a hunk are contiguous; across hunks they are not. */
export interface DiffHunk {
  lines: DiffLine[];
}

/** One file's worth of a unified diff, keyed by its NEW path. */
export interface DiffFile {
  path: string;
  hunks: DiffHunk[];
}

/**
 * Parse a unified diff into per-file hunks, **keeping the line text**.
 *
 * `parseDiff` used to be the only parser and threw the text away, which made
 * the WP6a anchor cascade structurally impossible: you cannot match an excerpt
 * against a corpus of line numbers. This is the same single pass, retaining
 * what it already read.
 *
 * A `+++ /dev/null` (a deletion) yields no file — there is no new-side path to
 * anchor against — matching the old parser exactly.
 */
export function parseDiffFiles(diff: string): DiffFile[] {
  const files: DiffFile[] = [];
  const byPath = new Map<string, DiffFile>();
  let file: DiffFile | null = null;
  let hunk: DiffHunk | null = null;
  let right = 0;
  let left = 0;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/^b\//, "");
      if (p === "/dev/null") {
        file = null;
      } else {
        file = byPath.get(p) ?? { path: p, hunks: [] };
        if (!byPath.has(p)) {
          byPath.set(p, file);
          files.push(file);
        }
      }
      hunk = null;
    } else if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        left = parseInt(m[1]!, 10);
        right = parseInt(m[2]!, 10);
        hunk = { lines: [] };
        if (file) file.hunks.push(hunk);
      }
    } else if (hunk && file) {
      if (line.startsWith("+")) {
        hunk.lines.push({
          prefix: "+",
          text: line.slice(1),
          left: null,
          right: right++,
        });
      } else if (line.startsWith("-")) {
        hunk.lines.push({
          prefix: "-",
          text: line.slice(1),
          left: left++,
          right: null,
        });
      } else if (line.startsWith(" ")) {
        hunk.lines.push({
          prefix: " ",
          text: line.slice(1),
          left: left++,
          right: right++,
        });
      } else if (line.startsWith("\\")) {
        /* "\ No newline at end of file" */
      } else {
        hunk = null;
      }
    }
  }
  return files;
}

/**
 * The commentable set: `path -> Set<"SIDE:line">`. Added/`+` and context lines
 * are `RIGHT:<newLine>`; removed/`-` and context lines are `LEFT:<oldLine>` —
 * mirroring GitHub's three-dot PR diff anchoring. A finding may be commented
 * inline only when its `side:line` appears in this set.
 */
export function commentableOf(files: DiffFile[]): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  for (const file of files) {
    const set = map.get(file.path) ?? new Set<string>();
    map.set(file.path, set);
    for (const hunk of file.hunks) {
      for (const l of hunk.lines) {
        if (l.right !== null) set.add("RIGHT:" + l.right);
        if (l.left !== null) set.add("LEFT:" + l.left);
      }
    }
  }
  return map;
}

/** Map a unified diff straight to its commentable set. */
export function parseDiff(diff: string): Map<string, Set<string>> {
  return commentableOf(parseDiffFiles(diff));
}

/* ------------------------------------------------------------------ *
 * WP6a — the anchor cascade
 * ------------------------------------------------------------------ */

/** How an anchor was arrived at. `model` = the cascade declined and the model's own line stands. */
export type AnchorVia = "model" | "hunk" | "file" | "relocated";

/** A resolved anchor. `path` may differ from the finding's — that is step 3. */
export interface AnchorResolution {
  path: string;
  line: number;
  side: ReviewSide;
  start_line?: number;
  via: AnchorVia;
}

/** Normalise one line for matching: leading/trailing whitespace is not evidence. */
function norm(s: string): string {
  return s.trim();
}

/** Split an excerpt into the normalised line sequence to look for. Empty ⇒ no match possible. */
function needleOf(excerpt: string | undefined): string[] {
  if (!excerpt) return [];
  const lines = excerpt.split("\n").map(norm);
  while (lines.length && lines[0] === "") lines.shift();
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** One candidate line in a haystack: its text and the line number it sits at. */
interface HayLine {
  text: string;
  line: number;
}

/**
 * Every consecutive run in `hay` matching `needle`. `hay` must be contiguous —
 * hence one haystack per HUNK rather than per file, so a match can never span
 * the gap between two hunks and claim lines that are not adjacent.
 */
function findRuns(
  hay: HayLine[],
  needle: string[],
): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  if (needle.length === 0 || hay.length < needle.length) return out;
  for (let i = 0; i + needle.length <= hay.length; i++) {
    let ok = true;
    for (let j = 0; j < needle.length; j++) {
      if (norm(hay[i + j]!.text) !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok)
      out.push({ start: hay[i]!.line, end: hay[i + needle.length - 1]!.line });
  }
  return out;
}

/** The new-side (context + added) view of a hunk, in new-file line numbers. */
function newSide(hunk: DiffHunk): HayLine[] {
  return hunk.lines
    .filter((l) => l.right !== null)
    .map((l) => ({ text: l.text, line: l.right! }));
}

/** The old-side (context + removed) view of a hunk, in old-file line numbers. */
function oldSide(hunk: DiffHunk): HayLine[] {
  return hunk.lines
    .filter((l) => l.left !== null)
    .map((l) => ({ text: l.text, line: l.left! }));
}

/**
 * Pick one run when several matched. Within the finding's OWN file the model's
 * advisory line is a legitimate tie-breaker — it is usually close and only ever
 * wrong by a little, which is the whole premise of this cascade. Across files
 * there is no such signal, which is why step 3 requires uniqueness instead.
 */
function nearest(
  runs: { start: number; end: number }[],
  advisory: number | undefined,
) {
  if (runs.length <= 1 || advisory === undefined) return runs[0];
  return runs.reduce((best, r) =>
    Math.abs(r.start - advisory) < Math.abs(best.start - advisory) ? r : best,
  );
}

function resolutionOf(
  path: string,
  side: ReviewSide,
  run: { start: number; end: number },
  via: AnchorVia,
): AnchorResolution {
  const res: AnchorResolution = { path, line: run.end, side, via };
  if (run.end !== run.start) res.start_line = run.start;
  return res;
}

/**
 * Derive a finding's anchor from its verbatim `existingCode`, instead of
 * trusting the line number the model counted.
 *
 * | # | Step | Model? |
 * |---|---|---|
 * | 1 | Match the excerpt against the file's own hunks — new side, then old side | no |
 * | 2 | Scan the full head-side file content | no |
 * | 3 | Relocate across files: a **unique** hit anywhere in the diff re-files the finding | no |
 * | 4 | Ask a model to regenerate the excerpt and retry step 1 | yes |
 * | 5 | Still unlocated — demote to the body, exactly as today | — |
 *
 * **Step 4 is deliberately NOT built**, and the reason is the same one that
 * makes step 3 mandatory. `post-review` is a deterministic phase-type handler
 * with no model binding, so step 4 is new machinery; and Open Code Review's
 * source records what that machinery does when it fires — handed the *wrong
 * file's* diff and a prompt demanding a code block back, the model answers with
 * whatever token in that diff looks closest, overwriting the one piece of
 * evidence that pointed at the real code. The comment then ends up **looking
 * located while pointing at unrelated code**, which is strictly worse than the
 * demotion it was trying to avoid. A declaration/implementation split is the
 * normal shape of a finding from a contract delta, so that is not an exotic
 * case for us. Step 3 covers it without a model; step 5 is the honest floor.
 *
 * Returns `null` when nothing resolved — the caller then leaves the model's own
 * `line` alone and lets {@link splitFindings} demote it if it is off-diff.
 */
export function resolveAnchor(
  f: ReviewFinding,
  files: DiffFile[],
  readHeadFile?: (path: string) => string | null,
): AnchorResolution | null {
  const needle = needleOf(f.existingCode);
  if (needle.length === 0) return null;

  const own = files.find((x) => x.path === f.path);

  // Step 1 — the finding's own file, new side first. An excerpt that is present
  // on both sides is the same text either way; preferring RIGHT keeps the
  // comment on the author's code rather than on what they deleted.
  if (own) {
    for (const [side, view] of [
      ["RIGHT", newSide],
      ["LEFT", oldSide],
    ] as const) {
      const runs = own.hunks.flatMap((h) => findRuns(view(h), needle));
      const run = nearest(runs, f.line);
      if (run) return resolutionOf(f.path, side, run, "hunk");
    }
  }

  // Step 2 — the whole head-side file. Covers an excerpt that sits outside any
  // hunk; the result is very likely off-diff and demoted, but a body entry that
  // cites the right line beats one that cites a wrong one.
  const content = readHeadFile?.(f.path);
  if (content) {
    const hay = content.split("\n").map((text, i) => ({ text, line: i + 1 }));
    const run = nearest(findRuns(hay, needle), f.line);
    if (run) return resolutionOf(f.path, "RIGHT", run, "file");
  }

  // Step 3 — relocate across files. UNIQUE hit only: zero hits and multiple
  // hits both decline, because guessing which file a repeated excerpt came from
  // is exactly the corruption step 4 would commit, done deterministically.
  const hits: { path: string; run: { start: number; end: number } }[] = [];
  for (const file of files) {
    if (file.path === f.path) continue;
    for (const h of file.hunks) {
      for (const run of findRuns(newSide(h), needle))
        hits.push({ path: file.path, run });
    }
  }
  if (hits.length === 1) {
    const hit = hits[0]!;
    return resolutionOf(hit.path, "RIGHT", hit.run, "relocated");
  }

  return null;
}

/** What {@link anchorFindings} did, for the log line and the eval. */
export interface AnchorStats {
  hunk: number;
  file: number;
  relocated: number;
  /** Had an `existingCode` and still could not be placed. */
  unresolved: number;
  /** Carried no `existingCode` at all — the model's line stands unchecked. */
  noExcerpt: number;
}

/**
 * Run the cascade over every finding, returning NEW finding objects with the
 * derived anchor written on. Pure: the only I/O is the injected `readHeadFile`.
 *
 * The anchor must be written back onto the finding before {@link splitFindings}
 * sees it — that function partitions on `f.line`, so a resolution that is not
 * persisted is a resolution that demotes anyway.
 */
export function anchorFindings(
  findings: ReviewFinding[],
  files: DiffFile[],
  readHeadFile?: (path: string) => string | null,
): { findings: ReviewFinding[]; stats: AnchorStats } {
  const stats: AnchorStats = {
    hunk: 0,
    file: 0,
    relocated: 0,
    unresolved: 0,
    noExcerpt: 0,
  };
  const out = findings.map((f) => {
    if (!f || !f.path) return f;
    if (!needleOf(f.existingCode).length) {
      stats.noExcerpt++;
      return f;
    }
    const res = resolveAnchor(f, files, readHeadFile);
    if (!res) {
      stats.unresolved++;
      return f;
    }
    if (res.via === "hunk") stats.hunk++;
    else if (res.via === "file") stats.file++;
    else stats.relocated++;
    // start_line is REPLACED, never merged: a stale multi-line range paired
    // with a freshly derived end line is a comment GitHub 422s on.
    const { start_line: _drop, ...rest } = f;
    return {
      ...rest,
      path: res.path,
      line: res.line,
      side: res.side,
      ...(res.start_line ? { start_line: res.start_line } : {}),
    };
  });
  return { findings: out, stats };
}

/** True when a finding anchors onto a line that appears in the diff. */
export function isAnchored(
  f: ReviewFinding,
  commentable: Map<string, Set<string>> | null,
): boolean {
  if (!commentable || !f.line) return false;
  const side: ReviewSide = f.side === "LEFT" ? "LEFT" : "RIGHT";
  const set = commentable.get(f.path);
  if (!set || !set.has(side + ":" + f.line)) return false;
  if (f.start_line && !set.has(side + ":" + f.start_line)) return false;
  return true;
}

/**
 * Partition findings into `inline` (anchor is on the diff) and `demoted`
 * (off-diff, or missing path/line — folded into the body). When `commentable`
 * is null (the diff couldn't be computed) every finding is demoted, so the
 * review still posts and nothing is lost.
 */
export function splitFindings(
  findings: ReviewFinding[],
  commentable: Map<string, Set<string>> | null,
): { inline: AnchoredFinding[]; demoted: ReviewFinding[] } {
  const inline: AnchoredFinding[] = [];
  const demoted: ReviewFinding[] = [];
  for (const f of findings) {
    if (f && f.path && f.line && isAnchored(f, commentable))
      inline.push(f as AnchoredFinding);
    else if (f) demoted.push(f);
  }
  return { inline, demoted };
}

/* ------------------------------------------------------------------ *
 * WP6b — the attention boundary
 * ------------------------------------------------------------------ */

/**
 * Why a finding is in the review body rather than inline. Three causes, and
 * they must stay distinguishable: "Additional findings" meaning off-diff AND
 * below-threshold AND overflowed-the-cap, under one heading, is a worse review
 * to read than the one it replaced (§D11).
 */
export type DemotionReason =
  "off-diff" | "below-threshold" | "overflow" | "adjudicated";

/** One demoted finding, carrying the reason it did not earn an inline comment. */
export interface DemotedFinding {
  finding: ReviewFinding;
  reason: DemotionReason;
}

/**
 * Why a finding was recorded rather than posted. The same treatment
 * {@link DemotionReason} gives the body tier, and for the same reason: three
 * causes under one label is a record that cannot answer *"what did we know and
 * not say, and why?"* — which is the only thing separating an attention
 * boundary from v2's suppressor.
 *
 * - `adjudicated` — the document said `tier: "internal"` itself. That includes
 *   every hypothesis the conservation floor repaired, which carries no
 *   confidence at all.
 * - `clean-discharge` — every supporting hypothesis is a clean QUOTE, so the
 *   finding is an ANTI-finding. See {@link tierFindings}.
 * - `below-floor` — under {@link AttentionBoundary.internalFloor}.
 * - `body-budget` — demoted to the body and then past
 *   {@link AttentionBoundary.maxBodyComments}. The only reason applied to a
 *   finding the boundary had already ROUTED somewhere visible, which is why it
 *   must stay its own token: folded into any of the other three it would read
 *   as a judgement about the finding's content, when it is a judgement about
 *   the reader's attention.
 */
export type InternalReason =
  "adjudicated" | "clean-discharge" | "below-floor" | "body-budget";

/** One recorded-not-posted finding, carrying the reason it was withheld. */
export interface InternalFinding {
  finding: ReviewFinding;
  reason: InternalReason;
}

/**
 * The attention budget. Absent ⇒ today's behaviour exactly: no cap, no
 * thresholds, no `internal` tier — every finding is inline or body, decided by
 * anchorability alone.
 */
export interface AttentionBoundary {
  /** Rank by confidence × severity; everything past this goes to the body, never away. */
  maxInlineComments: number;
  /** Per-obligation-family confidence bar for an INLINE comment. Below it: the body. */
  thresholds: Record<string, number>;
  /** Below this, recorded but not posted. See {@link TieredFindings.internal}. */
  internalFloor: number;
  /**
   * Cap on the FINAL body list — applied last, after every other rule has
   * routed findings there (including the inline overflow), because it governs
   * what the "Additional findings" section may cost a reader, not how any
   * single finding was judged.
   *
   * Unlike `maxInlineComments` this budget DOES filter: the excess is tiered
   * `internal` with reason `body-budget` — recorded in the disposition, never
   * posted. `null` or absent = unlimited, the legacy funnel; `0` = nothing
   * tiers to body at all. Ranked by {@link rankOf} — the same severity ×
   * confidence rank the inline budget spends, so an absent confidence ranks
   * as 1.0 (severity order), never as low confidence. Shipped default is `5`
   * (see `ReviewAnalysisConfig.maxBodyComments` in lastlight-shared for the
   * measurements, and for why the measured-best `0` is not the shipped one);
   * optional here so every existing constructor keeps today's behaviour.
   */
  maxBodyComments?: number | null;
}

/** The three destinations. Nothing is dropped; `internal` is recorded, not posted. */
export interface TieredFindings {
  inline: AnchoredFinding[];
  body: DemotedFinding[];
  /**
   * Below the floor: kept in `findings.json` with its reason, never posted.
   *
   * **This is an attention boundary, not v2's suppressor**, and the difference
   * is that it is auditable — WP7's `review_findings` table is where it becomes
   * queryable; until then the run's own findings document is the record.
   */
  internal: InternalFinding[];
}

const SEVERITY_WEIGHT: Record<string, number> = {
  critical: 3,
  important: 2,
  minor: 1,
};

/**
 * Rank for the inline budget: confidence × severity.
 *
 * **An absent `confidence` ranks as 1.0, not as 0.** Nothing the shipped
 * reviewer writes carries the field, so treating absence as low confidence
 * would push every one of today's findings below every hypothesis-derived one —
 * a silent re-ranking of the reviewer that ships, caused by a field it does not
 * know about. With 1.0 the ranking degenerates to severity order, which is what
 * a document with no confidences should get.
 *
 * **An UNRECOGNISED severity is warned about, not just defaulted.** Absence is a
 * known state and ranks Important on purpose (above). A string nobody defined —
 * `Blocker`, `High`, `p1` — is a different thing: it means some prompt is
 * emitting a vocabulary this code does not share, and the `?? 2` below turns
 * that into an ordinary-looking Important. See {@link unknownSeverity}.
 */
function rankOf(f: ReviewFinding): number {
  const sev = SEVERITY_WEIGHT[(f.severity || "important").toLowerCase()] ?? 2;
  return (f.confidence ?? 1) * sev;
}

/**
 * A severity string no {@link SEVERITY_WEIGHT} entry matches — see `rankOf`.
 *
 * A PREDICATE, not a warning, because this module does no I/O: every function
 * here is a pure transform, which is what lets the anchoring and tiering rules
 * be exercised directly rather than through an eval. `post-review.ts` owns the
 * logger and calls this.
 *
 * **Absence is deliberately NOT unknown.** The shipped reviewer writes no
 * severity at all, and ranking that Important is the documented default above,
 * not a drift. What this catches is a spelling from some other vocabulary —
 * severity is written by prompts, in more than one schema, and nothing between
 * them normalises it.
 */
export function unknownSeverity(f: ReviewFinding): boolean {
  const raw = f.severity?.trim();
  return (
    raw !== undefined &&
    raw !== "" &&
    SEVERITY_WEIGHT[raw.toLowerCase()] === undefined
  );
}

/**
 * This pipeline's OWN vocabulary, which must never reach a pull request.
 *
 * The maintainer reading a review did not build this and has no idea what an
 * adjudication or a hypothesis ledger is; a review that names them spends the
 * reader's attention explaining our architecture instead of their change.
 * Measured on `cliftonc/drizzle-cube#891`, where a posted summary opened
 * *"This adjudication keeps those findings reconciled as not applicable and
 * adds the hypothesis ledger"* — three internal terms in one sentence, about a
 * quick-search feature.
 *
 * Deliberately biased toward RECALL over precision. Every entry is a word this
 * codebase uses as a term of art, and some of them are also ordinary English
 * that a review of the right codebase could legitimately use — `obligation` in
 * a billing system, `discharge` in a battery driver. That trade is only sound
 * because the consequence is a log line: see {@link internalJargon}.
 */
const INTERNAL_JARGON: RegExp[] = [
  /\badjudicat\w*/i,
  /\bhypothes[ie]s\b/i,
  /\bobligations?\b/i,
  /\bsurvey (?:pass|passes|branch|branches|famil\w+)\b/i,
  /\bfalsify\b/i,
  /\bprobe transcripts?\b/i,
  /\bconservation (?:holds|floor)\b/i,
  /\battention boundary\b/i,
  /\binternal tier\b/i,
  /\bdischarges?d?\b/i,
  /\.lastlight\//i,
];

/**
 * The internal terms a review's own prose uses, if any.
 *
 * A PREDICATE, not a warning, for the same reason as {@link unknownSeverity}:
 * this module does no I/O. `post-review.ts` owns the logger and calls this.
 *
 * **It reports; it never rewrites.** Silently editing a review's wording would
 * change a claim nobody re-read, and the failure this catches is a prompt
 * drifting rather than a one-off — which is a thing to fix upstream, not to
 * paper over per-post. It is also why the term list can afford to be greedy: a
 * false positive costs one log line, while a false negative ships our
 * architecture to somebody else's pull request.
 *
 * Scans the prose fields only — `summary`, and each finding's `title` and
 * `body`. Never `suggestion` or `existingCode`, which are verbatim excerpts of
 * the author's own code and would match on their identifiers, not on ours.
 */
export function internalJargon(doc: {
  summary?: string;
  findings?: ReviewFinding[];
}): string[] {
  const prose = [
    doc.summary ?? "",
    ...(doc.findings ?? []).flatMap((f) => [f.title ?? "", f.body ?? ""]),
  ].join("\n");
  const hits = new Set<string>();
  for (const re of INTERNAL_JARGON) {
    const m = prose.match(re);
    if (m) hits.add(m[0].toLowerCase());
  }
  return [...hits].sort();
}

/**
 * Is every hypothesis behind this finding a CLEAN DISCHARGE — i.e. is the
 * finding an anti-finding?
 *
 * Two absences are deliberately NOT clean, and both are the same rule read
 * twice: **absence of provenance is not evidence of innocence.**
 *
 * - **No `hypotheses[]` at all.** Measured on the three `1587-r2` repeats of
 *   2026-08-23: 0, 1 and 1 findings carried none. Those are either the shipped
 *   reviewer's own or generated downstream of the surveys; nothing about them
 *   is knowable from a set of ids that does not exist, so they take the
 *   confidence path unchanged.
 * - **An id that resolves to no row.** It falls out of `every` for free —
 *   `clean` holds only ids that resolved AND were clean — which is the correct
 *   direction: a citation naming provenance that does not exist is exactly the
 *   case where the boundary must not act on the citation.
 */
function allHypothesesClean(
  f: ReviewFinding,
  clean: ReadonlySet<string> | undefined,
): boolean {
  if (!clean || clean.size === 0) return false;
  const ids = f.hypotheses;
  if (!Array.isArray(ids) || ids.length === 0) return false;
  return ids.every((id) => typeof id === "string" && clean.has(id));
}

/**
 * Split findings across the three destinations.
 *
 * Order matters and each step is a different question: does this SAY anything
 * (the clean-discharge rule) · is it worth a human's attention at all (the
 * floor) · can it even be anchored (GitHub's constraint) · is it confident
 * enough for an inline comment (the family threshold) · is there room (the
 * budget) · and, last, may the body still grow (the body budget,
 * {@link AttentionBoundary.maxBodyComments} — the one step that moves a
 * finding OUT of the posted review, to `internal` with reason `body-budget`).
 *
 * **A missing `confidence` never demotes and never suppresses.** Both bars are
 * `confidence !== undefined && confidence < bar`, so a finding that declines to
 * self-score is treated as passing — the alternative silently deletes every
 * finding from any prompt that has not been taught the field.
 *
 * ## The clean-discharge rule, and why it is not a confidence rule
 *
 * A survey discharges each obligation with QUOTE / ABSENT / PARTIAL / PROBE,
 * and the row shape's own contract is *"on a clean QUOTE write
 * `failureScenario: null`"*. So a row that is a `QUOTE` with an explicit null
 * scenario is the pass saying **"I looked, I quote the line, and it is fine"**.
 * A finding built ENTIRELY out of such rows is an anti-finding: it cannot match
 * a gold defect by construction, and posting it spends a maintainer's attention
 * on a report that nothing is wrong.
 *
 * **Measured on `prreview__skillspro-1587-r2`, three identical repeats**: of the
 * 45 / 48 / 46 hypotheses, **23 / 25 / 23** are clean discharges under the rule
 * this file implements — `QUOTE` with `failureScenario` PRESENT and explicitly
 * `null` — and 17 / 14 / 7 findings trace entirely to them.
 *
 * The looser reading that counts a merely ABSENT key scores 23 / 25 / 30, and
 * the seven-row gap is the whole reason the strict form is the one here. Under
 * the pre-2026-08-23 obligation contract the field did not exist at all, and the
 * `spec` pass's row shape has nowhere to record one, so 37 rows across the
 * preserved minimal-contract runs are `QUOTE` with no key — silence that carries
 * no information. Reading it as "clean" would demote 28 findings across 4 of 16
 * of those instances on the strength of a field nobody asked for. Strictly, the
 * count there is **0 of 16** and this rule is a verified no-op, which is what
 * keeps the control arm single-variable. On the first repeat **all 17 were posted**
 * — "Type contract: consolidateData correctly accepts…", "GOOGLE_CLIENT_ID
 * constant imported and passed correctly". The confidence bars cannot catch
 * them: confidence on those rows is uniformly ≥ 0.7 (median 0.95–1.00, minimum
 * 0.75 across the whole document), so `internalFloor` and every family
 * threshold pass them. That is the point — **an anti-finding is not an
 * unconfident finding, it is a confident report of nothing**, and only its
 * provenance says so.
 *
 * It is checked BEFORE the floor because it is the more specific answer to
 * "why was this withheld?", not because the two disagree about the tier — they
 * cannot; both are `internal`.
 *
 * `clean` is supplied by the caller (`post-review` reads the sibling
 * `hypotheses/*.jsonl`), never read here: this module does no I/O. Absent or
 * empty ⇒ the rule cannot fire, which is the inertness guarantee for every
 * deployment and every arm that runs no evidence pipeline.
 */
export function tierFindings(
  findings: ReviewFinding[],
  commentable: Map<string, Set<string>> | null,
  boundary: AttentionBoundary,
  clean?: ReadonlySet<string>,
): TieredFindings {
  const internal: InternalFinding[] = [];
  const body: DemotedFinding[] = [];
  const candidates: AnchoredFinding[] = [];

  for (const f of findings) {
    if (!f) continue;
    // An explicit `internal` is obeyed unconditionally and FIRST. The
    // conservation floor writes unaccounted-for hypotheses at this tier with no
    // `confidence` at all, and a confidence-only rule would have posted every
    // one of them — turning "we recorded what we could not adjudicate" into
    // "we published what we could not adjudicate".
    if (f.tier === "internal") {
      internal.push({ finding: f, reason: "adjudicated" });
      continue;
    }
    if (allHypothesesClean(f, clean)) {
      internal.push({ finding: f, reason: "clean-discharge" });
      continue;
    }
    if (f.confidence !== undefined && f.confidence < boundary.internalFloor) {
      internal.push({ finding: f, reason: "below-floor" });
      continue;
    }
    if (!f.path || !f.line || !isAnchored(f, commentable)) {
      body.push({ finding: f, reason: "off-diff" });
      continue;
    }
    // An explicit `body` is a demotion, and a demotion is always safe to obey.
    if (f.tier === "body") {
      body.push({ finding: f, reason: "adjudicated" });
      continue;
    }
    const bar = f.family ? boundary.thresholds[f.family] : undefined;
    if (bar !== undefined && f.confidence !== undefined && f.confidence < bar) {
      body.push({ finding: f, reason: "below-threshold" });
      continue;
    }
    candidates.push(f as AnchoredFinding);
  }

  // Stable within equal rank: `sort` is stable in V8, so the model's own
  // ordering breaks ties rather than something arbitrary.
  candidates.sort((a, b) => rankOf(b) - rankOf(a));
  const inline = candidates.slice(0, Math.max(0, boundary.maxInlineComments));
  for (const f of candidates.slice(Math.max(0, boundary.maxInlineComments))) {
    body.push({ finding: f, reason: "overflow" });
  }

  // The body budget — LAST, over the FINAL body list, so the inline overflow
  // has already landed there and competes for body slots like everything else
  // (under a cap of 0 the inline excess therefore goes `internal`, not to a
  // body the cap just closed). Ranked by the same severity × confidence rank
  // the inline budget spends — {@link rankOf}, absent confidence = 1.0 — and
  // the sort is over a COPY: the survivors keep their document order, so the
  // grouped rendering and the disposition rows read as before. Ties across
  // the cut fall to document order (stable sort), the same tie-break the
  // inline budget uses. `null`/absent = unlimited, the legacy funnel.
  const cap = boundary.maxBodyComments;
  if (cap === null || cap === undefined || body.length <= Math.max(0, cap)) {
    return { inline, body, internal };
  }
  const keep = new Set(
    [...body]
      .sort((a, b) => rankOf(b.finding) - rankOf(a.finding))
      .slice(0, Math.max(0, cap)),
  );
  const kept: DemotedFinding[] = [];
  for (const e of body) {
    if (keep.has(e)) kept.push(e);
    else internal.push({ finding: e.finding, reason: "body-budget" });
  }
  return { inline, body: kept, internal };
}

function commentBody(f: ReviewFinding): string {
  let b =
    "**[" +
    (f.severity || "Important") +
    "] " +
    (f.title || "") +
    "**\n\n" +
    (f.body || "");
  if (f.suggestion)
    b += "\n\n" + FENCE + "suggestion\n" + f.suggestion + "\n" + FENCE;
  return b;
}

/** The bullet list itself — shared by the flat and the grouped renderings. */
function renderDemotedItems(list: ReviewFinding[]): string {
  return list
    .map(
      (f) =>
        "- **[" +
        (f.severity || "Important") +
        "] " +
        (f.title || "") +
        "** (" +
        f.path +
        // A finding the cascade could not place has no line, and `path:undefined`
        // reads as a bug in the reviewer rather than as an honest "somewhere in
        // this file". WP6a made `line` optional; this is where that surfaces.
        (f.line ? ":" + f.line : "") +
        ") — " +
        (f.body || ""),
    )
    .join("\n");
}

/**
 * The flat "Additional findings" section — no reasons, one heading. Still the
 * whole story when there is no attention boundary configured, and the shape the
 * body-only retry uses (there every finding is demoted for the same reason).
 */
export function renderDemoted(list: ReviewFinding[]): string {
  if (!list.length) return "";
  return "\n\n### Additional findings\n" + renderDemotedItems(list);
}

/**
 * The reason lead-ins for the grouped body section. Three causes under one
 * heading is a worse review to read, so each group says what it is — and the
 * wording matters: none of these mean "we were not sure", they mean "this did
 * not earn an inline comment", which is a different claim.
 *
 * **These are read by a maintainer who has never heard of this pipeline.** They
 * are the one part of the posted review this repository writes verbatim, so
 * they say what happened in ordinary review language and never name internal
 * machinery — no "adjudicating pass", no obligation "family". Measured on
 * `cliftonc/drizzle-cube#891`, where a real review told its author that a
 * finding was "reported here rather than inline by the adjudicating pass",
 * which names a phase of ours and tells them nothing they can act on.
 */
const DEMOTION_LEAD: Record<DemotionReason, string> = {
  "off-diff": "_Outside this PR's diff — GitHub cannot anchor a comment here._",
  "below-threshold": "_Below the confidence bar for an inline comment._",
  overflow: "_Beyond this review's inline comment limit, ranked by severity._",
  adjudicated: "_Raised for context rather than as an inline comment._",
};

const DEMOTION_ORDER: DemotionReason[] = [
  "off-diff",
  "below-threshold",
  "adjudicated",
  "overflow",
];

/**
 * The "Additional findings" section, grouped by why each finding is here.
 *
 * Everything in it is still POSTED and still visible — demotion is not
 * suppression. What it is not is an inline comment at the defect site, and the
 * evidence says that difference is large ("Does AI Code Review Lead to Code
 * Changes?", 22k+ real comments: concise, hunk-level, actionable findings are
 * substantially likelier to cause a change).
 */
export function renderDemotedGrouped(entries: DemotedFinding[]): string {
  if (!entries.length) return "";
  const out = ["\n\n### Additional findings"];
  for (const reason of DEMOTION_ORDER) {
    const group = entries.filter((e) => e.reason === reason);
    if (!group.length) continue;
    out.push(
      "",
      DEMOTION_LEAD[reason],
      renderDemotedItems(group.map((e) => e.finding)),
    );
  }
  return out.join("\n");
}

/** Build the inline-comment objects GitHub's create-review API expects. */
export function toInlineComments(list: AnchoredFinding[]): InlineComment[] {
  return list.map((f) => {
    const side: ReviewSide = f.side === "LEFT" ? "LEFT" : "RIGHT";
    const c: InlineComment = {
      path: f.path,
      line: f.line,
      side,
      body: commentBody(f),
    };
    if (f.start_line) {
      c.start_line = f.start_line;
      c.start_side = side;
    }
    return c;
  });
}

/**
 * The worse of the two axes, or `undefined` when neither was recorded.
 *
 * Ordering is `fail` > `unknown` > `pass`, and only `fail` is load-bearing —
 * see {@link SplitVerdict} for why `unknown` must not block.
 */
export function worstAxis(
  verdict: SplitVerdict | undefined,
): AxisVerdict | undefined {
  if (!verdict) return undefined;
  const axes = [verdict.spec, verdict.standards].filter(
    (v): v is AxisVerdict => v === "pass" || v === "fail" || v === "unknown",
  );
  if (axes.length === 0) return undefined;
  if (axes.includes("fail")) return "fail";
  if (axes.includes("unknown")) return "unknown";
  return "pass";
}

/**
 * Resolve the review event. An explicit `doc.event` wins; otherwise an empty
 * findings set is an `APPROVE` and anything else is a `COMMENT` (never an
 * automatic `REQUEST_CHANGES` — that stays an explicit, deliberate call).
 *
 * ## The split verdict's one effect
 *
 * A `fail` on EITHER axis stops the review being an `APPROVE`; it becomes a
 * `COMMENT`. Nothing else changes: the event is never escalated to
 * `REQUEST_CHANGES`, and among the non-APPROVE events an explicit `doc.event`
 * still wins, so a fork choosing `REQUEST_CHANGES` over `COMMENT` keeps its
 * choice.
 *
 * **Why the downgrade also applies to an EXPLICIT `APPROVE`**, which is the one
 * judgement call in this function. The retired WP6 doc (git history; condensed
 * in `docs/plans/deterministic-pr-levers.md` §"Adjudication and the attention
 * boundary (WP6)") says `resolveEvent` "takes
 * the worse of the two axes" while `event` "remains explicit-wins". Read
 * strictly, those contradict: today's skill makes `event` a REQUIRED field, so
 * an always-present explicit event would make the split verdict inert by
 * construction — the passing axis would go on hiding the failing one, which is
 * the entire defect #271 filed. So "explicit-wins" is read as governing the
 * CHOICE OF EVENT, and the axis verdict as a FLOOR under it, exactly like the
 * skill's existing "never APPROVE over an open human CHANGES_REQUESTED" rule.
 * An agent that writes `event: APPROVE` beside `verdict.spec: "fail"` has
 * contradicted itself, and the safe reading of a self-contradiction is the one
 * that does not silently approve a change that does not do what was asked.
 */
export function resolveEvent(doc: ReviewFindingsDoc): ReviewEvent {
  const findings = Array.isArray(doc.findings) ? doc.findings : [];
  const event = doc.event || (findings.length === 0 ? "APPROVE" : "COMMENT");
  if (event === "APPROVE" && worstAxis(doc.verdict) === "fail")
    return "COMMENT";
  return event;
}

/**
 * Compose the full review payload. Pass `commentable = null` to force every
 * finding into the body (the diff-unavailable fallback).
 */
export function buildReview(
  doc: ReviewFindingsDoc,
  commentable: Map<string, Set<string>> | null,
  boundary?: AttentionBoundary,
  clean?: ReadonlySet<string>,
): BuiltReview {
  const findings = Array.isArray(doc.findings) ? doc.findings : [];
  if (!boundary) {
    // No attention boundary — anchorability is the only question, exactly as
    // before WP6b. This branch is what makes the feature inert on a deployment
    // that has not enabled the evidence pipeline.
    const { inline, demoted } = splitFindings(findings, commentable);
    return {
      event: resolveEvent(doc),
      body: (doc.summary || "") + renderDemoted(demoted),
      comments: toInlineComments(inline),
      inlineCount: inline.length,
      demotedCount: demoted.length,
      internalCount: 0,
    };
  }
  const tiered = tierFindings(findings, commentable, boundary, clean);
  return {
    event: resolveEvent(doc),
    body: (doc.summary || "") + renderDemotedGrouped(tiered.body),
    comments: toInlineComments(tiered.inline),
    inlineCount: tiered.inline.length,
    demotedCount: tiered.body.length,
    internalCount: tiered.internal.length,
    tiered,
  };
}

/**
 * The body-only fallback: when the inline POST is rejected (e.g. a stale diff
 * yields a 422 on a comment line), re-render with every POSTABLE finding in the
 * body so the review still lands. Same event as the inline attempt.
 *
 * **Pass `tiered` whenever the boundary produced one.** Without it this
 * re-reads `doc.findings` wholesale, which republishes the `internal` tier —
 * the conservation floor's repaired hypotheses and the anti-findings alike — so
 * "recorded, never posted" would hold on the happy path and quietly stop
 * holding on the retry. That is a dark drop's mirror image: a publication
 * nobody decided on, reached by a failure in an unrelated request. Omitted ⇒
 * today's behaviour exactly, which is what every no-boundary caller gets.
 */
export function buildBodyOnlyReview(
  doc: ReviewFindingsDoc,
  tiered?: TieredFindings,
): BuiltReview {
  const findings = tiered
    ? [...tiered.inline, ...tiered.body.map((d) => d.finding)]
    : Array.isArray(doc.findings)
      ? doc.findings
      : [];
  return {
    event: resolveEvent(doc),
    body: (doc.summary || "") + renderDemoted(findings),
    comments: [],
    inlineCount: 0,
    demotedCount: findings.length,
    internalCount: 0,
  };
}

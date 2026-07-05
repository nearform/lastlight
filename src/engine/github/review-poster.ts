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
  line: number;
  side?: ReviewSide;
  start_line?: number;
  severity?: string;
  title?: string;
  body?: string;
  suggestion?: string;
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
}

const FENCE = "```";

/**
 * Map a unified diff to `path -> Set<"SIDE:line">`. Added/`+` and context lines
 * are `RIGHT:<newLine>`; removed/`-` and context lines are `LEFT:<oldLine>` —
 * mirroring GitHub's three-dot PR diff anchoring. A finding may be commented
 * inline only when its `side:line` appears in this set.
 */
export function parseDiff(diff: string): Map<string, Set<string>> {
  const map = new Map<string, Set<string>>();
  let path: string | null = null;
  let right = 0;
  let left = 0;
  let inHunk = false;
  for (const line of diff.split("\n")) {
    if (line.startsWith("+++ ")) {
      const p = line.slice(4).replace(/^b\//, "");
      path = p === "/dev/null" ? null : p;
      if (path && !map.has(path)) map.set(path, new Set());
      inHunk = false;
    } else if (line.startsWith("@@")) {
      const m = /@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
      if (m) {
        left = parseInt(m[1]!, 10);
        right = parseInt(m[2]!, 10);
        inHunk = true;
      }
    } else if (inHunk && path) {
      const set = map.get(path)!;
      if (line.startsWith("+")) {
        set.add("RIGHT:" + right);
        right++;
      } else if (line.startsWith("-")) {
        set.add("LEFT:" + left);
        left++;
      } else if (line.startsWith(" ")) {
        set.add("RIGHT:" + right);
        set.add("LEFT:" + left);
        right++;
        left++;
      } else if (line.startsWith("\\")) {
        /* "\ No newline at end of file" */
      } else {
        inHunk = false;
      }
    }
  }
  return map;
}

/** True when a finding anchors onto a line that appears in the diff. */
export function isAnchored(
  f: ReviewFinding,
  commentable: Map<string, Set<string>> | null,
): boolean {
  if (!commentable) return false;
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
): { inline: ReviewFinding[]; demoted: ReviewFinding[] } {
  const inline: ReviewFinding[] = [];
  const demoted: ReviewFinding[] = [];
  for (const f of findings) {
    if (f && f.path && f.line && isAnchored(f, commentable)) inline.push(f);
    else if (f) demoted.push(f);
  }
  return { inline, demoted };
}

function commentBody(f: ReviewFinding): string {
  let b = "**[" + (f.severity || "Important") + "] " + (f.title || "") + "**\n\n" + (f.body || "");
  if (f.suggestion) b += "\n\n" + FENCE + "suggestion\n" + f.suggestion + "\n" + FENCE;
  return b;
}

/** The "Additional findings" section appended to the body for demoted findings. */
export function renderDemoted(list: ReviewFinding[]): string {
  if (!list.length) return "";
  return (
    "\n\n### Additional findings\n" +
    list
      .map(
        (f) =>
          "- **[" +
          (f.severity || "Important") +
          "] " +
          (f.title || "") +
          "** (" +
          f.path +
          ":" +
          f.line +
          ") — " +
          (f.body || ""),
      )
      .join("\n")
  );
}

/** Build the inline-comment objects GitHub's create-review API expects. */
export function toInlineComments(list: ReviewFinding[]): InlineComment[] {
  return list.map((f) => {
    const side: ReviewSide = f.side === "LEFT" ? "LEFT" : "RIGHT";
    const c: InlineComment = { path: f.path, line: f.line, side, body: commentBody(f) };
    if (f.start_line) {
      c.start_line = f.start_line;
      c.start_side = side;
    }
    return c;
  });
}

/**
 * Resolve the review event. An explicit `doc.event` wins; otherwise an empty
 * findings set is an `APPROVE` and anything else is a `COMMENT` (never an
 * automatic `REQUEST_CHANGES` — that stays an explicit, deliberate call).
 */
export function resolveEvent(doc: ReviewFindingsDoc): ReviewEvent {
  const findings = Array.isArray(doc.findings) ? doc.findings : [];
  return doc.event || (findings.length === 0 ? "APPROVE" : "COMMENT");
}

/**
 * Compose the full review payload. Pass `commentable = null` to force every
 * finding into the body (the diff-unavailable fallback).
 */
export function buildReview(
  doc: ReviewFindingsDoc,
  commentable: Map<string, Set<string>> | null,
): BuiltReview {
  const findings = Array.isArray(doc.findings) ? doc.findings : [];
  const { inline, demoted } = splitFindings(findings, commentable);
  return {
    event: resolveEvent(doc),
    body: (doc.summary || "") + renderDemoted(demoted),
    comments: toInlineComments(inline),
    inlineCount: inline.length,
    demotedCount: demoted.length,
  };
}

/**
 * The body-only fallback: when the inline POST is rejected (e.g. a stale diff
 * yields a 422 on a comment line), re-render with ALL findings in the body so
 * the review still lands. Same event as the inline attempt.
 */
export function buildBodyOnlyReview(doc: ReviewFindingsDoc): BuiltReview {
  const findings = Array.isArray(doc.findings) ? doc.findings : [];
  return {
    event: resolveEvent(doc),
    body: (doc.summary || "") + renderDemoted(findings),
    comments: [],
    inlineCount: 0,
    demotedCount: findings.length,
  };
}

/**
 * WP6a — the anchor cascade.
 *
 * The defect being fixed: `line` was a REQUIRED, model-produced field, and
 * `post-review` demotes anything outside the commentable set. So a finding whose
 * analysis is perfect and whose line number is off by two paid the full price of
 * a wrong answer — a body entry instead of an inline comment at the defect site,
 * which the attention-boundary evidence says is worth substantially less.
 *
 * These tests are the AC1a gate. The cross-file case (§3) is the one with a
 * trap under it: `alibaba/open-code-review` records that asking a model to
 * regenerate an excerpt against the WRONG file's diff yields a comment that
 * looks located while pointing at unrelated code. Hence "unique hit only", and
 * hence the ambiguity test below being as important as the success one.
 */
import { describe, expect, it } from "vitest";
import {
  anchorFindings,
  buildReview,
  commentableOf,
  parseDiff,
  parseDiffFiles,
  renderDemoted,
  resolveAnchor,
  type ReviewFinding,
} from "#src/engine/github/review-poster.js";

/**
 * Two files. `auth.ts` has one hunk; `config.ts` has two, the second of which
 * repeats a line from `auth.ts` verbatim — that repetition is what makes the
 * ambiguity case real rather than contrived.
 *
 * auth.ts   RIGHT: 70 ctx · 71 added · 72 added · 73 ctx · 74 ctx
 *           LEFT:  70 ctx · 71 removed · 72 ctx · 73 ctx
 * config.ts RIGHT: 10 ctx · 11 added · 12 ctx  ‖  41 ctx · 42 added · 43 ctx
 */
const DIFF = [
  "diff --git a/src/auth.ts b/src/auth.ts",
  "index 1111111..2222222 100644",
  "--- a/src/auth.ts",
  "+++ b/src/auth.ts",
  "@@ -70,6 +70,8 @@ export function verify() {",
  "   const token = read();",
  "-  if (!token) return null;",
  '+  if (!token) throw new Error("no token");',
  "+  const age = Date.now() - token.issuedAt;",
  "   return token;",
  " }",
  "diff --git a/src/config.ts b/src/config.ts",
  "index 3333333..4444444 100644",
  "--- a/src/config.ts",
  "+++ b/src/config.ts",
  "@@ -10,3 +10,4 @@",
  " export const MAX_TOKEN_AGE = 900;",
  "+export const MIN_TOKEN_AGE = 1;",
  ' export const NAME = "x";',
  "@@ -40,2 +41,3 @@",
  " function guard() {",
  "+  const age = Date.now() - token.issuedAt;",
  " }",
  "",
].join("\n");

const FILES = parseDiffFiles(DIFF);
const COMMENTABLE = commentableOf(FILES);

function finding(over: Partial<ReviewFinding>): ReviewFinding {
  return { path: "src/auth.ts", severity: "Critical", title: "t", body: "b", ...over };
}

describe("parseDiffFiles — the text the old parser threw away", () => {
  it("keeps each line's text alongside both side's line numbers", () => {
    const auth = FILES.find((f) => f.path === "src/auth.ts")!;
    expect(auth.hunks).toHaveLength(1);
    expect(auth.hunks[0]!.lines.map((l) => [l.prefix, l.left, l.right, l.text])).toEqual([
      [" ", 70, 70, "  const token = read();"],
      ["-", 71, null, "  if (!token) return null;"],
      ["+", null, 71, '  if (!token) throw new Error("no token");'],
      ["+", null, 72, "  const age = Date.now() - token.issuedAt;"],
      [" ", 72, 73, "  return token;"],
      [" ", 73, 74, "}"],
    ]);
  });

  it("keeps multiple hunks per file separate", () => {
    const config = FILES.find((f) => f.path === "src/config.ts")!;
    expect(config.hunks).toHaveLength(2);
  });

  it("derives exactly the commentable set the old parser produced", () => {
    // The parity that lets `parseDiff` become a one-line derivation instead of
    // a second, drifting implementation.
    expect(commentableOf(parseDiffFiles(DIFF))).toEqual(parseDiff(DIFF));
    expect(COMMENTABLE.get("src/auth.ts")!.has("RIGHT:72")).toBe(true);
    expect(COMMENTABLE.get("src/auth.ts")!.has("LEFT:71")).toBe(true);
  });
});

describe("resolveAnchor — step 1, the file's own hunks", () => {
  it("derives the line from the excerpt and ignores the model's wrong number", () => {
    const res = resolveAnchor(
      finding({ line: 999, existingCode: "const age = Date.now() - token.issuedAt;" }),
      FILES,
    );
    expect(res).toEqual({ path: "src/auth.ts", line: 72, side: "RIGHT", via: "hunk" });
  });

  it("matches on indentation-insensitive text — whitespace is not evidence", () => {
    const res = resolveAnchor(
      finding({ existingCode: "        const age = Date.now() - token.issuedAt;   " }),
      FILES,
    );
    expect(res?.line).toBe(72);
  });

  it("spans a multi-line excerpt as start_line..line", () => {
    const res = resolveAnchor(
      finding({
        existingCode:
          '  if (!token) throw new Error("no token");\n  const age = Date.now() - token.issuedAt;',
      }),
      FILES,
    );
    expect(res).toEqual({
      path: "src/auth.ts",
      line: 72,
      start_line: 71,
      side: "RIGHT",
      via: "hunk",
    });
  });

  it("falls to the old side, as LEFT, for an excerpt that was deleted", () => {
    const res = resolveAnchor(finding({ existingCode: "if (!token) return null;" }), FILES);
    expect(res).toEqual({ path: "src/auth.ts", line: 71, side: "LEFT", via: "hunk" });
  });

  it("never matches across the gap between two hunks", () => {
    // `export const NAME = "x";` ends hunk 1 and ` function guard() {` opens
    // hunk 2. They are 29 lines apart in the real file; a haystack built per
    // FILE rather than per hunk would splice them and report a run that does
    // not exist.
    const res = resolveAnchor(
      finding({ path: "src/config.ts", existingCode: 'export const NAME = "x";\nfunction guard() {' }),
      FILES,
    );
    expect(res).toBeNull();
  });
});

describe("resolveAnchor — step 2, the full head-side file", () => {
  it("locates an excerpt that sits outside every hunk", () => {
    const head = ["// header", "", "import x from 'y';", "", "const untouched = 1;", ""].join("\n");
    const res = resolveAnchor(finding({ existingCode: "const untouched = 1;" }), FILES, () => head);
    expect(res).toEqual({ path: "src/auth.ts", line: 5, side: "RIGHT", via: "file" });
  });

  it("is skipped entirely when there is no local checkout to read", () => {
    expect(resolveAnchor(finding({ existingCode: "const untouched = 1;" }), FILES)).toBeNull();
  });
});

describe("resolveAnchor — step 3, cross-file relocation", () => {
  it("re-files a finding whose excerpt uniquely lives in another changed file", () => {
    // The declaration/implementation split: the model filed the finding against
    // the file it was reviewing and quoted code from the file that declares it.
    // This is the normal shape of a contract-delta finding, not an exotic case.
    const res = resolveAnchor(
      finding({ path: "src/auth.ts", line: 71, existingCode: "export const MIN_TOKEN_AGE = 1;" }),
      FILES,
    );
    expect(res).toEqual({ path: "src/config.ts", line: 11, side: "RIGHT", via: "relocated" });
  });

  it("DECLINES rather than guessing when the excerpt appears in two files", () => {
    // The whole reason step 4 (ask a model to regenerate the excerpt) is not
    // built. A guess here produces a comment that looks located and points at
    // unrelated code, which is strictly worse than the demotion it avoids.
    const res = resolveAnchor(
      finding({ path: "src/nowhere.ts", existingCode: "const age = Date.now() - token.issuedAt;" }),
      FILES,
    );
    expect(res).toBeNull();
  });

  it("declines on zero hits", () => {
    expect(resolveAnchor(finding({ existingCode: "this text is in no diff" }), FILES)).toBeNull();
  });
});

describe("anchorFindings — writing the anchor back, and the counts", () => {
  it("leaves a finding with no excerpt completely untouched", () => {
    // Inertness: a deployment whose prompts never learned about `existingCode`
    // gets byte-identical behaviour.
    const f = finding({ line: 71 });
    const out = anchorFindings([f], FILES);
    expect(out.findings[0]).toBe(f);
    expect(out.stats).toEqual({ hunk: 0, file: 0, relocated: 0, unresolved: 0, noExcerpt: 1 });
  });

  it("writes path, line and side back onto the finding", () => {
    const out = anchorFindings(
      [finding({ line: 999, existingCode: "export const MIN_TOKEN_AGE = 1;" })],
      FILES,
    );
    expect(out.findings[0]).toMatchObject({ path: "src/config.ts", line: 11, side: "RIGHT" });
    expect(out.stats.relocated).toBe(1);
  });

  it("REPLACES a stale start_line rather than merging it", () => {
    // A stale multi-line range paired with a freshly derived end line is a
    // comment GitHub 422s on — the failure would surface as a body-only retry,
    // i.e. every finding demoted, for one bad field.
    const out = anchorFindings(
      [finding({ line: 999, start_line: 990, existingCode: "const age = Date.now() - token.issuedAt;" })],
      FILES,
    );
    expect(out.findings[0]).not.toHaveProperty("start_line");
    expect(out.findings[0]!.line).toBe(72);
  });

  it("counts an excerpt it could not place, distinctly from one that was never given", () => {
    const out = anchorFindings(
      [finding({ existingCode: "nowhere at all" }), finding({ line: 71 })],
      FILES,
    );
    expect(out.stats).toMatchObject({ unresolved: 1, noExcerpt: 1 });
  });
});

describe("AC1a — a wrong line with a right excerpt anchors inline anyway", () => {
  it("posts inline where it would previously have been demoted to the body", () => {
    const doc = {
      summary: "s",
      findings: [finding({ line: 999, existingCode: "const age = Date.now() - token.issuedAt;" })],
    };

    // Before: the model's 999 is off-diff, so the finding lands in the body.
    const before = buildReview(doc, COMMENTABLE);
    expect(before.inlineCount).toBe(0);
    expect(before.demotedCount).toBe(1);

    // After: the cascade rewrites the anchor and it becomes an inline comment.
    const after = buildReview(
      { ...doc, findings: anchorFindings(doc.findings, FILES).findings },
      COMMENTABLE,
    );
    expect(after.inlineCount).toBe(1);
    expect(after.demotedCount).toBe(0);
    expect(after.comments[0]).toMatchObject({ path: "src/auth.ts", line: 72, side: "RIGHT" });
  });

  it("still demotes an unlocatable finding — step 5 is the honest floor", () => {
    const doc = { summary: "s", findings: [finding({ existingCode: "nowhere at all" })] };
    const after = buildReview(
      { ...doc, findings: anchorFindings(doc.findings, FILES).findings },
      COMMENTABLE,
    );
    expect(after.demotedCount).toBe(1);
  });
});

describe("renderDemoted — `line` is optional now", () => {
  it("cites the path alone rather than printing `path:undefined`", () => {
    const out = renderDemoted([finding({ title: "Unplaced" })]);
    expect(out).toContain("(src/auth.ts)");
    expect(out).not.toContain("undefined");
  });

  it("still cites path:line when there is a line", () => {
    expect(renderDemoted([finding({ line: 72 })])).toContain("(src/auth.ts:72)");
  });
});

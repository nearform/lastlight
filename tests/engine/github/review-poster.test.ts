import { describe, it, expect } from "vitest";
import {
  parseDiff,
  splitFindings,
  buildReview,
  buildBodyOnlyReview,
  resolveEvent,
  type ReviewFinding,
} from "#src/engine/github/review-poster.js";

const DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -10,3 +10,4 @@ function x() {",
  " context1",
  "-removed",
  "+added1",
  "+added2",
  " context2",
].join("\n");

describe("parseDiff", () => {
  it("maps added lines to RIGHT and removed lines to LEFT with correct numbering", () => {
    const set = parseDiff(DIFF).get("src/foo.ts")!;
    expect(set).toBeDefined();
    expect(set.has("RIGHT:10")).toBe(true); // context1
    expect(set.has("LEFT:11")).toBe(true); // removed
    expect(set.has("RIGHT:11")).toBe(true); // added1
    expect(set.has("RIGHT:12")).toBe(true); // added2
    expect(set.has("RIGHT:13")).toBe(true); // context2 new side
    expect(set.has("LEFT:12")).toBe(true); // context2 old side
  });

  it("does not mark off-diff lines as commentable", () => {
    const set = parseDiff(DIFF).get("src/foo.ts")!;
    expect(set.has("RIGHT:99")).toBe(false);
    expect(set.has("RIGHT:100")).toBe(false);
  });

  it("handles a pure-addition file (/dev/null base)", () => {
    const added = [
      "--- /dev/null",
      "+++ b/new.ts",
      "@@ -0,0 +1,2 @@",
      "+line1",
      "+line2",
    ].join("\n");
    const set = parseDiff(added).get("new.ts")!;
    expect(set.has("RIGHT:1")).toBe(true);
    expect(set.has("RIGHT:2")).toBe(true);
    expect(set.has("LEFT:1")).toBe(false);
  });
});

describe("splitFindings", () => {
  const onDiff: ReviewFinding = { path: "src/foo.ts", line: 11, side: "RIGHT", title: "on", body: "b" };
  const offDiff: ReviewFinding = { path: "src/foo.ts", line: 99, side: "RIGHT", title: "off", body: "b" };
  const otherFile: ReviewFinding = { path: "src/bar.ts", line: 1, side: "RIGHT", title: "other", body: "b" };

  it("keeps on-diff findings inline and demotes off-diff ones", () => {
    const commentable = parseDiff(DIFF);
    const { inline, demoted } = splitFindings([onDiff, offDiff, otherFile], commentable);
    expect(inline.map((f) => f.title)).toEqual(["on"]);
    expect(demoted.map((f) => f.title)).toEqual(["off", "other"]);
  });

  it("demotes every finding when the diff is unavailable (null)", () => {
    const { inline, demoted } = splitFindings([onDiff, offDiff], null);
    expect(inline).toHaveLength(0);
    expect(demoted).toHaveLength(2);
  });

  it("demotes a finding missing path or line", () => {
    const commentable = parseDiff(DIFF);
    const bad = { path: "src/foo.ts" } as unknown as ReviewFinding;
    const { inline, demoted } = splitFindings([bad], commentable);
    expect(inline).toHaveLength(0);
    expect(demoted).toHaveLength(1);
  });
});

describe("resolveEvent", () => {
  it("defaults an empty findings set to APPROVE", () => {
    expect(resolveEvent({ findings: [] })).toBe("APPROVE");
  });
  it("defaults a non-empty findings set to COMMENT (never auto REQUEST_CHANGES)", () => {
    expect(resolveEvent({ findings: [{ path: "a", line: 1 }] })).toBe("COMMENT");
  });
  it("honours an explicit event", () => {
    expect(resolveEvent({ event: "REQUEST_CHANGES", findings: [] })).toBe("REQUEST_CHANGES");
  });
});

describe("buildReview", () => {
  it("anchors on-diff findings inline and folds off-diff ones into the body", () => {
    const doc = {
      summary: "Looks good overall.",
      event: "COMMENT" as const,
      findings: [
        { path: "src/foo.ts", line: 11, side: "RIGHT" as const, severity: "Critical", title: "Null deref", body: "boom", suggestion: "const x = 1;" },
        { path: "src/foo.ts", line: 99, side: "RIGHT" as const, severity: "Important", title: "Off diff", body: "nope" },
      ],
    };
    const review = buildReview(doc, parseDiff(DIFF));
    expect(review.event).toBe("COMMENT");
    expect(review.inlineCount).toBe(1);
    expect(review.demotedCount).toBe(1);
    expect(review.comments[0]!.path).toBe("src/foo.ts");
    expect(review.comments[0]!.line).toBe(11);
    expect(review.comments[0]!.body).toContain("```suggestion");
    expect(review.body).toContain("Looks good overall.");
    expect(review.body).toContain("### Additional findings");
    expect(review.body).toContain("Off diff");
  });

  it("carries start_line/start_side for a multi-line range when anchored", () => {
    const doc = {
      findings: [
        { path: "src/foo.ts", line: 12, start_line: 11, side: "RIGHT" as const, title: "range", body: "b" },
      ],
    };
    const review = buildReview(doc, parseDiff(DIFF));
    expect(review.comments[0]!.start_line).toBe(11);
    expect(review.comments[0]!.start_side).toBe("RIGHT");
  });

  it("produces a clean APPROVE with no comments for an empty review", () => {
    const review = buildReview({ summary: "LGTM", findings: [] }, parseDiff(DIFF));
    expect(review.event).toBe("APPROVE");
    expect(review.comments).toHaveLength(0);
    expect(review.body).toBe("LGTM");
  });
});

describe("buildBodyOnlyReview", () => {
  it("folds every finding into the body and drops inline comments", () => {
    const doc = {
      summary: "sum",
      event: "COMMENT" as const,
      findings: [
        { path: "src/foo.ts", line: 11, side: "RIGHT" as const, title: "a", body: "x" },
        { path: "src/foo.ts", line: 99, side: "RIGHT" as const, title: "b", body: "y" },
      ],
    };
    const review = buildBodyOnlyReview(doc);
    expect(review.comments).toHaveLength(0);
    expect(review.demotedCount).toBe(2);
    expect(review.body).toContain("### Additional findings");
    expect(review.body).toContain("a");
    expect(review.body).toContain("b");
  });
});

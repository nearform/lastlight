import { describe, it, expect } from "vitest";
import { parseReviewerVerdict } from "./verdict.js";

describe("parseReviewerVerdict — explicit VERDICT: marker", () => {
  it("reads VERDICT: APPROVED with no fallback", () => {
    expect(parseReviewerVerdict("VERDICT: APPROVED\nLooks great!")).toEqual({
      verdict: "APPROVED",
      viaFallback: false,
    });
  });

  it("reads VERDICT: REQUEST_CHANGES with no fallback", () => {
    expect(parseReviewerVerdict("VERDICT: REQUEST_CHANGES\nFix the bug")).toEqual({
      verdict: "REQUEST_CHANGES",
      viaFallback: false,
    });
  });

  it("matches a case-insensitive marker on a non-first line (/im)", () => {
    const output = "Here is my review.\n\nverdict: approved\n";
    expect(parseReviewerVerdict(output)).toEqual({
      verdict: "APPROVED",
      viaFallback: false,
    });
  });
});

describe("parseReviewerVerdict — fallback (no VERDICT: marker)", () => {
  it("approves when output starts with APPROVED and never says REQUEST_CHANGES", () => {
    expect(parseReviewerVerdict("APPROVED — ship it")).toEqual({
      verdict: "APPROVED",
      viaFallback: true,
    });
  });

  it("requests changes when output mentions REQUEST_CHANGES", () => {
    expect(parseReviewerVerdict("I think this needs work: REQUEST_CHANGES")).toEqual({
      verdict: "REQUEST_CHANGES",
      viaFallback: true,
    });
  });

  it("treats ambiguous output as not approved", () => {
    expect(parseReviewerVerdict("This looks mostly fine but I'm unsure.")).toEqual({
      verdict: "REQUEST_CHANGES",
      viaFallback: true,
    });
  });
});

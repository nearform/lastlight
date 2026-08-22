/**
 * WP6b — the attention boundary.
 *
 * The line this work package walks: **a candidate is never deleted for being
 * noisy, but neither does every surviving candidate earn an inline comment.**
 * Preserving internal recall and spending a human's attention are two different
 * budgets, and v2 is what happens when they are conflated — a suppressor that
 * "worked mechanically" and cost recall anyway.
 *
 * So the tests below are mostly conservation tests. With 20 findings and a
 * budget of 8, the interesting assertion is not that 8 are inline; it is that
 * the other 12 are still in the body.
 */
import { describe, expect, it } from "vitest";
import {
  buildReview,
  renderDemotedGrouped,
  tierFindings,
  type AttentionBoundary,
  type ReviewFinding,
} from "#src/engine/github/review-poster.js";

const BOUNDARY: AttentionBoundary = {
  maxInlineComments: 8,
  thresholds: { contract: 0.35, security: 0.3, tests: 0.6 },
  internalFloor: 0.15,
};

/** Every line 1..40 on the RIGHT of one file is commentable. */
const COMMENTABLE = new Map([
  ["src/a.ts", new Set(Array.from({ length: 40 }, (_, i) => `RIGHT:${i + 1}`))],
]);

function f(over: Partial<ReviewFinding> & { line: number }): ReviewFinding {
  return { path: "src/a.ts", severity: "Important", title: "t", body: "b", ...over };
}

describe("tierFindings — AC1b, nothing is lost past the budget", () => {
  it("puts 8 inline and the other 12 in the BODY, not nowhere", () => {
    const findings = Array.from({ length: 20 }, (_, i) => f({ line: i + 1 }));
    const t = tierFindings(findings, COMMENTABLE, BOUNDARY);
    expect(t.inline).toHaveLength(8);
    expect(t.body).toHaveLength(12);
    expect(t.internal).toHaveLength(0);
    expect(t.inline.length + t.body.length + t.internal.length).toBe(20);
    expect(t.body.every((d) => d.reason === "overflow")).toBe(true);
  });

  it("ranks by severity × confidence, so the budget is spent on the worst", () => {
    const t = tierFindings(
      [
        f({ line: 1, severity: "Minor", title: "minor" }),
        f({ line: 2, severity: "Critical", title: "critical" }),
        f({ line: 3, severity: "Important", title: "important" }),
      ],
      COMMENTABLE,
      { ...BOUNDARY, maxInlineComments: 1 },
    );
    expect(t.inline.map((x) => x.title)).toEqual(["critical"]);
    // The overflow keeps the same ranking, so the body reads worst-first too
    // rather than in whatever order the model happened to emit.
    expect(t.body.map((d) => d.finding.title)).toEqual(["important", "minor"]);
  });

  it("a budget of 0 sends everything to the body and still loses nothing", () => {
    const t = tierFindings([f({ line: 1 }), f({ line: 2 })], COMMENTABLE, {
      ...BOUNDARY,
      maxInlineComments: 0,
    });
    expect(t.inline).toHaveLength(0);
    expect(t.body).toHaveLength(2);
  });
});

describe("tierFindings — the three demotion causes stay distinguishable", () => {
  it("labels off-diff, below-threshold and overflow separately", () => {
    const t = tierFindings(
      [
        f({ line: 999, title: "off" }),
        f({ line: 1, family: "tests", confidence: 0.4, title: "under" }),
        f({ line: 2, title: "in" }),
        f({ line: 3, title: "over" }),
      ],
      COMMENTABLE,
      { ...BOUNDARY, maxInlineComments: 1 },
    );
    expect(t.inline.map((x) => x.title)).toEqual(["in"]);
    expect(t.body.map((d) => [d.finding.title, d.reason])).toEqual([
      ["off", "off-diff"],
      ["under", "below-threshold"],
      ["over", "overflow"],
    ]);
  });
});

describe("tierFindings — an absent confidence never demotes and never suppresses", () => {
  it("keeps a finding with no confidence inline even under a high family bar", () => {
    // The failure this guards: every finding today's shipped reviewer writes
    // carries no `confidence`. Reading absence as 0 would delete all of them.
    const t = tierFindings([f({ line: 1, family: "tests" })], COMMENTABLE, BOUNDARY);
    expect(t.inline).toHaveLength(1);
    expect(t.internal).toHaveLength(0);
  });

  it("ranks an unscored finding by its severity alone", () => {
    const t = tierFindings(
      [f({ line: 1, severity: "Critical", title: "unscored" }), f({ line: 2, severity: "Critical", confidence: 0.4, title: "scored" })],
      COMMENTABLE,
      { ...BOUNDARY, maxInlineComments: 1 },
    );
    expect(t.inline.map((x) => x.title)).toEqual(["unscored"]);
  });

  it("applies no bar at all to a finding with no family", () => {
    const t = tierFindings([f({ line: 1, confidence: 0.2 })], COMMENTABLE, BOUNDARY);
    expect(t.inline).toHaveLength(1);
  });

  it("applies no bar to a family the operator did not configure", () => {
    const t = tierFindings([f({ line: 1, family: "state", confidence: 0.2 })], COMMENTABLE, BOUNDARY);
    expect(t.inline).toHaveLength(1);
  });
});

describe("tierFindings — the internal tier", () => {
  it("holds back a finding below the floor, and nothing else", () => {
    const t = tierFindings(
      [
        f({ line: 1, confidence: 0.1, title: "dark" }),
        f({ line: 2, confidence: 0.15, title: "at the floor" }),
        f({ line: 3, confidence: 0.2, title: "above" }),
      ],
      COMMENTABLE,
      BOUNDARY,
    );
    expect(t.internal.map((x) => x.title)).toEqual(["dark"]);
    expect(t.inline).toHaveLength(2);
  });

  it("does not consider anchorability first — an off-diff low-confidence finding is internal", () => {
    // Order matters: "is this worth a human's attention at all" is asked before
    // "can GitHub anchor it". Otherwise the body fills with sub-floor findings
    // purely because they happened to be off-diff.
    const t = tierFindings([f({ line: 999, confidence: 0.05 })], COMMENTABLE, BOUNDARY);
    expect(t.internal).toHaveLength(1);
    expect(t.body).toHaveLength(0);
  });
});

describe("buildReview — the boundary is opt-in, and absent means today", () => {
  it("is byte-identical to the pre-WP6b behaviour with no boundary", () => {
    const doc = { summary: "s", findings: Array.from({ length: 20 }, (_, i) => f({ line: i + 1 })) };
    const before = buildReview(doc, COMMENTABLE);
    expect(before.inlineCount).toBe(20);
    expect(before.demotedCount).toBe(0);
    expect(before.internalCount).toBe(0);
    expect(before.body).toBe("s");
  });

  it("caps and groups once a boundary is supplied", () => {
    const doc = { summary: "s", findings: Array.from({ length: 20 }, (_, i) => f({ line: i + 1 })) };
    const after = buildReview(doc, COMMENTABLE, BOUNDARY);
    expect(after.inlineCount).toBe(8);
    expect(after.demotedCount).toBe(12);
    expect(after.body).toContain("### Additional findings");
    expect(after.body).toContain("Beyond the inline comment budget");
  });

  it("never posts an internal-tier finding, inline or in the body", () => {
    const doc = {
      summary: "s",
      findings: [f({ line: 1, confidence: 0.01, title: "dark", body: "SHOULD NOT APPEAR" })],
    };
    const after = buildReview(doc, COMMENTABLE, BOUNDARY);
    expect(after.internalCount).toBe(1);
    expect(after.comments).toHaveLength(0);
    expect(after.body).not.toContain("SHOULD NOT APPEAR");
  });
});

describe("renderDemotedGrouped — three causes must not share one heading", () => {
  it("gives each cause its own lead-in under the single heading", () => {
    const out = renderDemotedGrouped([
      { finding: f({ line: 1, title: "A" }), reason: "overflow" },
      { finding: f({ line: 2, title: "B" }), reason: "off-diff" },
      { finding: f({ line: 3, title: "C" }), reason: "below-threshold" },
    ]);
    expect(out.match(/### Additional findings/g)).toHaveLength(1);
    expect(out).toContain("Outside this PR's diff");
    expect(out).toContain("Below the reporting confidence bar");
    expect(out).toContain("Beyond the inline comment budget");
    // Ordered off-diff → below-threshold → overflow regardless of input order.
    expect(out.indexOf("Outside this PR's diff")).toBeLessThan(out.indexOf("Below the reporting"));
    expect(out.indexOf("Below the reporting")).toBeLessThan(out.indexOf("Beyond the inline"));
  });

  it("omits a group with no members rather than printing an empty heading", () => {
    const out = renderDemotedGrouped([{ finding: f({ line: 1 }), reason: "overflow" }]);
    expect(out).not.toContain("Outside this PR's diff");
    expect(out).toContain("Beyond the inline comment budget");
  });

  it("renders nothing at all for an empty list", () => {
    expect(renderDemotedGrouped([])).toBe("");
  });
});

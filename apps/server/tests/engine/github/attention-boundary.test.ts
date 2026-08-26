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
  buildBodyOnlyReview,
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
    expect(t.internal.map((x) => x.finding.title)).toEqual(["dark"]);
    expect(t.internal.map((x) => x.reason)).toEqual(["below-floor"]);
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

describe("tierFindings — an EXPLICIT tier, which is a cross-package seam", () => {
  it("never posts a finding the conservation floor recorded at `internal`", () => {
    // `lastlight-facts findings --repair` writes every unaccounted-for
    // hypothesis into findings.json at `tier: "internal"` with NO confidence.
    // A confidence-only internal rule would have posted every one of them,
    // turning "we recorded what we could not adjudicate" into "we published
    // what we could not adjudicate" — the exact inversion of the floor's job.
    const t = tierFindings([f({ line: 1, tier: "internal", title: "repaired" })], COMMENTABLE, BOUNDARY);
    expect(t.internal.map((x) => x.finding.title)).toEqual(["repaired"]);
    expect(t.internal.map((x) => x.reason)).toEqual(["adjudicated"]);
    expect(t.inline).toHaveLength(0);
    expect(t.body).toHaveLength(0);
  });

  it("obeys an explicit `body`, and labels it as the adjudicator's own call", () => {
    const t = tierFindings([f({ line: 1, tier: "body" })], COMMENTABLE, BOUNDARY);
    expect(t.body.map((d) => d.reason)).toEqual(["adjudicated"]);
    expect(t.inline).toHaveLength(0);
  });

  it("does NOT let an explicit `inline` bypass anchorability or the budget", () => {
    // The asymmetry: a document may demote itself, never promote itself. A
    // finding that is off-diff cannot be commented on at all (GitHub 422s), and
    // a document that could grant itself inline slots would make the attention
    // budget advisory.
    const off = tierFindings([f({ line: 999, tier: "inline" })], COMMENTABLE, BOUNDARY);
    expect(off.body.map((d) => d.reason)).toEqual(["off-diff"]);

    const many = tierFindings(
      [f({ line: 1, tier: "inline" }), f({ line: 2, tier: "inline" })],
      COMMENTABLE,
      { ...BOUNDARY, maxInlineComments: 1 },
    );
    expect(many.inline).toHaveLength(1);
    expect(many.body.map((d) => d.reason)).toEqual(["overflow"]);
  });

  it("still applies the floor to an untagged low-confidence finding", () => {
    const t = tierFindings([f({ line: 1, confidence: 0.01 })], COMMENTABLE, BOUNDARY);
    expect(t.internal).toHaveLength(1);
  });
});

/**
 * The anti-finding rule.
 *
 * A finding whose supporting hypotheses are ALL clean discharges — `QUOTE` with
 * an explicit `failureScenario: null`, the survey saying "I looked, I quote the
 * line, and it is fine" — is a confident report that nothing is wrong. It
 * cannot match a gold defect by construction, so posting it is pure attention
 * cost.
 *
 * Measured on `prreview__skillspro-1587-r2` (three identical repeats,
 * 2026-08-23): 23 / 25 / 30 of 45 / 48 / 46 hypotheses were clean discharges,
 * 17 / 14 / 7 findings traced entirely to them, and on the first repeat all 17
 * were POSTED. The confidence bars cannot reach them — minimum confidence
 * across that whole document is 0.75 — which is why this is a rule about what
 * the finding SAYS, not about how sure it is.
 */
describe("tierFindings — findings whose evidence is entirely clean discharges", () => {
  const CLEAN = new Set(["contract-002", "contract-003", "spec-001"]);

  it("records a finding built only from clean discharges, and does not post it", () => {
    const t = tierFindings(
      [f({ line: 1, confidence: 0.95, hypotheses: ["contract-002"], title: "anti" })],
      COMMENTABLE,
      BOUNDARY,
      CLEAN,
    );
    expect(t.internal.map((x) => [x.finding.title, x.reason])).toEqual([["anti", "clean-discharge"]]);
    expect(t.inline).toHaveLength(0);
    expect(t.body).toHaveLength(0);
  });

  it("holds back a HIGH-confidence one, which is the whole point", () => {
    // 1.00 confidence, no family bar, on-diff: every existing gate passes it.
    // Only its provenance says it reports nothing.
    const t = tierFindings(
      [f({ line: 1, confidence: 1, hypotheses: ["contract-002", "contract-003"] })],
      COMMENTABLE,
      BOUNDARY,
      CLEAN,
    );
    expect(t.internal).toHaveLength(1);
  });

  it("does NOT touch a finding with no hypotheses at all — absence of provenance is not innocence", () => {
    // Measured: 0 / 1 / 1 findings across the three repeats carried no ids.
    // They are generated downstream of the surveys, or are the shipped
    // reviewer's own, and nothing about them is knowable from an empty list.
    const t = tierFindings(
      [f({ line: 1, title: "none" }), f({ line: 2, hypotheses: [], title: "empty" })],
      COMMENTABLE,
      BOUNDARY,
      CLEAN,
    );
    expect(t.internal).toHaveLength(0);
    expect(t.inline.map((x) => x.title)).toEqual(["none", "empty"]);
  });

  it("does NOT touch a finding citing an id that resolves to no row", () => {
    const t = tierFindings(
      [f({ line: 1, hypotheses: ["contract-002", "ghost-001"], title: "unresolvable" })],
      COMMENTABLE,
      BOUNDARY,
      CLEAN,
    );
    expect(t.internal).toHaveLength(0);
    expect(t.inline.map((x) => x.title)).toEqual(["unresolvable"]);
  });

  it("posts a MIXED finding — one defect hypothesis is enough to earn the review", () => {
    // `contract-009` is not in the clean set: either it discharged a defect or
    // it is not a clean QUOTE. Either way the finding is not an anti-finding,
    // and demoting it would be the recall loss this boundary exists to avoid.
    const t = tierFindings(
      [f({ line: 1, hypotheses: ["contract-002", "contract-009"], title: "mixed" })],
      COMMENTABLE,
      BOUNDARY,
      CLEAN,
    );
    expect(t.internal).toHaveLength(0);
    expect(t.inline.map((x) => x.title)).toEqual(["mixed"]);
  });

  it("is inert with no clean set and with an empty one — no pipeline, no change", () => {
    const findings = [f({ line: 1, hypotheses: ["contract-002"], title: "anti" })];
    for (const clean of [undefined, new Set<string>()]) {
      const t = tierFindings(findings, COMMENTABLE, BOUNDARY, clean);
      expect(t.internal, String(clean)).toHaveLength(0);
      expect(t.inline.map((x) => x.title)).toEqual(["anti"]);
    }
  });

  it("still obeys an explicit `internal` first, and labels it as the document's own call", () => {
    // Ordering is load-bearing: the conservation floor's repaired findings have
    // no confidence and may cite any hypothesis. They must read as
    // `adjudicated`, not be re-explained by whichever rule happened to run.
    const t = tierFindings(
      [f({ line: 1, tier: "internal", hypotheses: ["contract-002"] })],
      COMMENTABLE,
      BOUNDARY,
      CLEAN,
    );
    expect(t.internal.map((x) => x.reason)).toEqual(["adjudicated"]);
  });

  it("prefers `clean-discharge` over `below-floor` when both apply", () => {
    // Same tier either way; the more specific reason is the one worth keeping,
    // because "we withheld it because it says nothing" and "we withheld it
    // because we were unsure" are different facts about the same run.
    const t = tierFindings(
      [f({ line: 1, confidence: 0.01, hypotheses: ["spec-001"] })],
      COMMENTABLE,
      BOUNDARY,
      CLEAN,
    );
    expect(t.internal.map((x) => x.reason)).toEqual(["clean-discharge"]);
  });

  it("holds back an OFF-DIFF anti-finding too, rather than folding it into the body", () => {
    const t = tierFindings(
      [f({ line: 999, hypotheses: ["spec-001"] })],
      COMMENTABLE,
      BOUNDARY,
      CLEAN,
    );
    expect(t.internal.map((x) => x.reason)).toEqual(["clean-discharge"]);
    expect(t.body).toHaveLength(0);
  });

  it("conserves: nothing is dropped, only re-routed", () => {
    const findings = [
      f({ line: 1, hypotheses: ["contract-002"], title: "anti" }),
      f({ line: 2, hypotheses: ["contract-009"], title: "real" }),
      f({ line: 3, title: "unprovenanced" }),
    ];
    const t = tierFindings(findings, COMMENTABLE, BOUNDARY, CLEAN);
    expect(t.inline.length + t.body.length + t.internal.length).toBe(3);
    expect(t.internal.map((x) => x.finding.title)).toEqual(["anti"]);
  });
});

/**
 * The body budget (`maxBodyComments`) — the one budget that DOES filter.
 *
 * It is applied LAST, over the FINAL body list, so the inline overflow has
 * already landed there and competes for body slots like everything else. The
 * excess is not dropped: it is tiered `internal` with its own machine reason,
 * `body-budget`, so the disposition record can still answer "what did we know
 * and not say, and why?".
 */
describe("tierFindings — the body budget (maxBodyComments)", () => {
  it("absent and explicit null both leave the legacy body list untouched", () => {
    const findings = Array.from({ length: 12 }, (_, i) => f({ line: i + 1 }));
    for (const boundary of [BOUNDARY, { ...BOUNDARY, maxBodyComments: null }]) {
      const t = tierFindings(findings, COMMENTABLE, boundary);
      expect(t.inline).toHaveLength(8);
      expect(t.body).toHaveLength(4);
      expect(t.internal).toHaveLength(0);
    }
  });

  it("a cap of 0 sends nothing to the body — every demotion is recorded `body-budget` instead", () => {
    const t = tierFindings(
      [
        f({ line: 999, title: "off" }),
        f({ line: 1, family: "tests", confidence: 0.4, title: "under" }),
        f({ line: 2, title: "in" }),
      ],
      COMMENTABLE,
      { ...BOUNDARY, maxBodyComments: 0 },
    );
    expect(t.inline.map((x) => x.title)).toEqual(["in"]);
    expect(t.body).toHaveLength(0);
    expect(t.internal.map((x) => [x.finding.title, x.reason])).toEqual([
      ["off", "body-budget"],
      ["under", "body-budget"],
    ]);
    // Conservation: re-routed, never dropped.
    expect(t.inline.length + t.body.length + t.internal.length).toBe(3);
  });

  it("a cap of 2 keeps the top 2 by severity × confidence, in document order", () => {
    // Ranks: critHigh 0.9×3=2.7 · imp (no confidence → 1.0)×2=2.0 ·
    // critLow 0.5×3=1.5 · minor 1.0×1=1.0. Keep critHigh + imp; the kept
    // entries keep their document order rather than being re-sorted.
    const t = tierFindings(
      [
        f({ line: 999, severity: "Minor", title: "minor" }),
        f({ line: 999, severity: "Critical", confidence: 0.9, title: "critHigh" }),
        f({ line: 999, severity: "Important", title: "imp" }),
        f({ line: 999, severity: "Critical", confidence: 0.5, title: "critLow" }),
      ],
      COMMENTABLE,
      { ...BOUNDARY, maxBodyComments: 2 },
    );
    expect(t.body.map((d) => d.finding.title)).toEqual(["critHigh", "imp"]);
    expect(t.internal.map((x) => [x.finding.title, x.reason])).toEqual([
      ["minor", "body-budget"],
      ["critLow", "body-budget"],
    ]);
  });

  it("ranks an absent confidence as 1.0 — severity order, exactly as the inline overflow does", () => {
    // Same rule as `rankOf` for the inline budget: absence is not low
    // confidence. An unscored Important (2.0) outranks a scored one (1.8).
    const t = tierFindings(
      [
        f({ line: 999, severity: "Important", title: "unscored" }),
        f({ line: 999, severity: "Important", confidence: 0.9, title: "scored" }),
      ],
      COMMENTABLE,
      { ...BOUNDARY, maxBodyComments: 1 },
    );
    expect(t.body.map((d) => d.finding.title)).toEqual(["unscored"]);
    expect(t.internal.map((x) => [x.finding.title, x.reason])).toEqual([["scored", "body-budget"]]);
  });

  it("inline overflow under a cap of 0 goes internal, not to a body the cap just closed", () => {
    const findings = Array.from({ length: 3 }, (_, i) => f({ line: i + 1, title: `t${i}` }));
    const t = tierFindings(findings, COMMENTABLE, {
      ...BOUNDARY,
      maxInlineComments: 1,
      maxBodyComments: 0,
    });
    expect(t.inline).toHaveLength(1);
    expect(t.body).toHaveLength(0);
    expect(t.internal).toHaveLength(2);
    expect(t.internal.every((x) => x.reason === "body-budget")).toBe(true);
  });

  it("does not relabel findings that were internal for a more specific reason", () => {
    const t = tierFindings(
      [f({ line: 1, confidence: 0.01, title: "dark" }), f({ line: 999, title: "off" })],
      COMMENTABLE,
      { ...BOUNDARY, maxBodyComments: 0 },
    );
    expect(t.internal.map((x) => [x.finding.title, x.reason])).toEqual([
      ["dark", "below-floor"],
      ["off", "body-budget"],
    ]);
  });
});

describe("buildReview + the 422 retry — the body budget's withholding is real", () => {
  it("renders no 'Additional findings' section at all under a cap of 0", () => {
    const doc = {
      summary: "s",
      findings: [f({ line: 999, title: "capped", body: "SHOULD NOT APPEAR" }), f({ line: 1, title: "in" })],
    };
    const r = buildReview(doc, COMMENTABLE, { ...BOUNDARY, maxBodyComments: 0 });
    expect(r.body).toBe("s");
    expect(r.inlineCount).toBe(1);
    expect(r.demotedCount).toBe(0);
    expect(r.internalCount).toBe(1);
    expect(r.tiered?.internal.map((x) => x.reason)).toEqual(["body-budget"]);
  });

  it("the body-only retry cannot republish what the body budget withheld", () => {
    const doc = {
      summary: "s",
      findings: [f({ line: 1, title: "posted" }), f({ line: 999, title: "capped" })],
    };
    const tiered = tierFindings(doc.findings, COMMENTABLE, { ...BOUNDARY, maxBodyComments: 0 });
    const retry = buildBodyOnlyReview(doc, tiered);
    expect(retry.body).toContain("posted");
    expect(retry.body).not.toContain("capped");
  });
});

describe("buildReview — an anti-finding never reaches the review text", () => {
  it("keeps it out of both the comments and the body", () => {
    const doc = {
      summary: "s",
      findings: [
        f({ line: 1, hypotheses: ["contract-002"], title: "anti", body: "SHOULD NOT APPEAR" }),
        f({ line: 2, hypotheses: ["contract-009"], title: "real", body: "keep" }),
      ],
    };
    const after = buildReview(doc, COMMENTABLE, BOUNDARY, new Set(["contract-002"]));
    expect(after.internalCount).toBe(1);
    expect(after.inlineCount).toBe(1);
    expect(after.body).not.toContain("SHOULD NOT APPEAR");
    expect(after.comments[0]!.body).toContain("real");
  });

  it("ignores the clean set entirely when no boundary is configured", () => {
    // The pre-WP6b branch: anchorability is the only question, so a deployment
    // that never opted in cannot be moved by a hypotheses directory.
    const doc = { summary: "s", findings: [f({ line: 1, hypotheses: ["contract-002"], title: "anti" })] };
    const before = buildReview(doc, COMMENTABLE, undefined, new Set(["contract-002"]));
    expect(before.inlineCount).toBe(1);
    expect(before.internalCount).toBe(0);
  });
});

describe("buildBodyOnlyReview — the 422 retry must not republish the internal tier", () => {
  it("posts the inline+body tiers and withholds the rest when given the tiering", () => {
    // Without this the guarantee is conditional on GitHub accepting the first
    // POST: a stale anchor 422s and the retry publishes every anti-finding and
    // every hypothesis the conservation floor repaired — a publication nobody
    // decided on, reached through a failure in an unrelated request.
    const doc = {
      summary: "s",
      findings: [
        f({ line: 1, title: "posted" }),
        f({ line: 2, title: "anti", hypotheses: ["contract-002"] }),
        f({ line: 3, title: "repaired", tier: "internal" as const }),
      ],
    };
    const tiered = tierFindings(doc.findings, COMMENTABLE, BOUNDARY, new Set(["contract-002"]));
    const retry = buildBodyOnlyReview(doc, tiered);
    expect(retry.demotedCount).toBe(1);
    expect(retry.body).toContain("posted");
    expect(retry.body).not.toContain("anti");
    expect(retry.body).not.toContain("repaired");
  });

  it("is byte-identical to today when no tiering is supplied", () => {
    const doc = { summary: "s", findings: [f({ line: 1, title: "a" }), f({ line: 2, title: "b" })] };
    expect(buildBodyOnlyReview(doc).demotedCount).toBe(2);
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

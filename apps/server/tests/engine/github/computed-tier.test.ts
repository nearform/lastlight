/**
 * #399's output half — the adjudicator writes typed attributes and
 * {@link computeTier} decides the tier.
 *
 * Why the question moved, in one line each, because every one of these is a
 * measurement and not a preference:
 *
 *  - Asking a model *"is this finding correct?"* loses to keeping everything.
 *    2,145 labelled AACR comments: keep-all F1 **0.825**, Haiku 0.803, Jev
 *    0.789, GLM 0.745. Three unrelated models, same bar, all under it.
 *  - The same probabilities separate **Code Defect from Maintainability at AUC
 *    0.897**. The model was never miscalibrated; the question was wrong.
 *  - The failures this phase actually had were *unstated* decisions. On
 *    `1680-r1` it judged two claims non-defects, wrote that in the title and
 *    body prose, left `tier` unset, and both took an inline slot.
 *
 * The two properties that must hold whatever else changes:
 *
 *  - **inertness.** A finding with no attributes — every finding written under
 *    `adjudicate: "legacy"`, and every one the shipped reviewer writes — must
 *    route exactly as it does today.
 *  - **attribution.** A tier this function derived is recorded as `computed`,
 *    not as `adjudicated`. "How often does the computed tier withhold
 *    something, and what?" is the question the arm exists to answer, and
 *    `disposition.json` is the only place it can be answered from.
 */
import { describe, expect, it } from "vitest";
import {
  computeTier,
  tierFindings,
  type AttentionBoundary,
  type ReviewFinding,
} from "#src/engine/github/review-poster.js";

const BOUNDARY: AttentionBoundary = { maxInlineComments: 8 };
const COMMENTABLE = new Map([["src/a.ts", new Set(["RIGHT:1", "RIGHT:2", "RIGHT:3"])]]);

function f(over: Partial<ReviewFinding>): ReviewFinding {
  return { path: "src/a.ts", line: 1, severity: "Important", title: "t", body: "b", ...over };
}

const DEFECT = { claim: "the guard never runs", category: "defect" as const, fix: "move it to onRequest" };

describe("computeTier", () => {
  it("is undefined for a finding with no attributes — the inertness guarantee", () => {
    expect(computeTier(f({}))).toBeUndefined();
    expect(computeTier(f({ claim: "something is wrong", fix: "change it" }))).toBeUndefined();
  });

  it("routes a verification report to internal however confidently it is written", () => {
    // The long-standing rule, machine-checkable for the first time. The
    // confidence bars that used to sit here could never catch these: an
    // anti-finding is not an unconfident finding, it is a confident report of
    // nothing.
    expect(computeTier(f({ category: "verification", claim: "the constant is enforced", fix: "none" }))).toBe("internal");
  });

  it("withholds a finding that can state no claim, or no fix", () => {
    // Nothing wrong, or nothing to do about it. Recorded, never posted.
    expect(computeTier(f({ category: "defect", claim: "", fix: "do x" }))).toBe("internal");
    expect(computeTier(f({ category: "defect", claim: "x is wrong", fix: "   " }))).toBe("internal");
    expect(computeTier(f({ category: "defect" }))).toBe("internal");
  });

  it("asks for inline on both correctness categories, and body on the rest", () => {
    // Deliberately generous at the top: the measured constraint is the
    // found→said gap, and the cascade below — anchorability, the inline cap,
    // the body cap — narrows with evidence this function does not have.
    expect(computeTier(f(DEFECT))).toBe("inline");
    expect(computeTier(f({ ...DEFECT, category: "correctness-risk" }))).toBe("inline");
    expect(computeTier(f({ ...DEFECT, category: "maintainability" }))).toBe("body");
    expect(computeTier(f({ ...DEFECT, category: "nit" }))).toBe("body");
  });
});

describe("computeTier inside the cascade", () => {
  it("records a derived withholding as `computed`, not as `adjudicated`", () => {
    const t = tierFindings([f({ category: "verification", claim: "fine", fix: "none" })], COMMENTABLE, BOUNDARY);
    expect(t.internal).toHaveLength(1);
    expect(t.internal[0]!.reason).toBe("computed");
  });

  it("leaves an explicitly-tiered finding alone", () => {
    // The conservation floor writes `internal` with no attributes at all, and
    // an operator mid-migration may have both shapes in one document. Neither
    // may have its stated tier recomputed out from under it.
    const t = tierFindings([f({ tier: "internal", ...DEFECT })], COMMENTABLE, BOUNDARY);
    expect(t.internal[0]!.reason).toBe("adjudicated");
  });

  it("puts a typed defect inline, through the ordinary anchoring path", () => {
    const t = tierFindings([f(DEFECT)], COMMENTABLE, BOUNDARY);
    expect(t.inline).toHaveLength(1);
    expect(t.internal).toHaveLength(0);
  });

  it("still demotes a typed defect the diff cannot carry", () => {
    // A derived `inline` is a REQUEST, exactly like a stated one: it does not
    // grant itself a slot on a line nobody can comment on.
    const t = tierFindings([f({ ...DEFECT, line: 99 })], COMMENTABLE, BOUNDARY);
    expect(t.inline).toHaveLength(0);
    expect(t.body).toHaveLength(1);
    expect(t.body[0]!.reason).toBe("off-diff");
  });

  it("does not re-file a legacy finding that has no attributes", () => {
    const t = tierFindings([f({}), f({ line: 2, tier: "body" })], COMMENTABLE, BOUNDARY);
    expect(t.inline).toHaveLength(1);
    expect(t.body).toHaveLength(1);
    expect(t.internal).toHaveLength(0);
  });

  it("catches in the field the mistake prose-disposition was a patch for", () => {
    // `1680-r1`, restated with attributes. Under the old shape this reached a
    // maintainer as an inline comment reading "— dismissed"; the
    // prose-disposition rule later caught it by string-matching the label.
    // With a category it never gets that far, and it is attributed to the
    // decision rather than to the wording.
    const t = tierFindings(
      [f({ title: "finally-purge correctness — dismissed", category: "verification", claim: "", fix: "" })],
      COMMENTABLE,
      BOUNDARY,
    );
    expect(t.inline).toHaveLength(0);
    expect(t.internal[0]!.reason).toBe("computed");
  });
});

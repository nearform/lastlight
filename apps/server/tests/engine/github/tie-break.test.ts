/**
 * Issue #405 — ranking WITHIN a severity band. Three bands and a stable sort
 * meant a tie across the inline or body cut fell to the order the adjudicator
 * wrote findings in; `tieBreakOf` orders it on the evidence reconcile stamps.
 */
import { describe, expect, it } from "vitest";
import {
  tieBreakOf,
  tierFindings,
  type AttentionBoundary,
  type ReviewFinding,
} from "#src/engine/github/review-poster.js";

const COMMENTABLE = new Map([
  ["src/a.ts", new Set(Array.from({ length: 40 }, (_, i) => `RIGHT:${i + 1}`))],
]);

function f(over: Partial<ReviewFinding> & { line: number }): ReviewFinding {
  return { path: "src/a.ts", severity: "Important", title: `t${over.line}`, body: "b", ...over };
}

const MAX_EVIDENCE = { crossesBoundary: true, probe: "executed" as const, hypotheses: 99 };

describe("tieBreakOf", () => {
  it("scores nothing without stamped evidence", () => {
    expect(tieBreakOf(f({ line: 1 }))).toBe(0);
    expect(tieBreakOf(f({ line: 1, rankEvidence: null }))).toBe(0);
  });

  it("orders boundary > executed > corroborated > none, each alone", () => {
    const boundary = tieBreakOf(f({ line: 1, rankEvidence: { crossesBoundary: true, probe: "none", hypotheses: 1 } }));
    const executed = tieBreakOf(f({ line: 1, rankEvidence: { crossesBoundary: false, probe: "executed", hypotheses: 1 } }));
    const corroborated = tieBreakOf(f({ line: 1, rankEvidence: { crossesBoundary: false, probe: "corroborated", hypotheses: 1 } }));
    const none = tieBreakOf(f({ line: 1, rankEvidence: { crossesBoundary: false, probe: "none", hypotheses: 1 } }));
    expect(boundary).toBeGreaterThan(executed);
    expect(executed).toBeGreaterThan(corroborated);
    expect(corroborated).toBeGreaterThan(none);
    expect(none).toBe(0);
  });

  it("counts merged hypotheses beyond the first, capped", () => {
    const score = (hypotheses: number) =>
      tieBreakOf(f({ line: 1, rankEvidence: { crossesBoundary: false, probe: "none", hypotheses } }));
    expect(score(0)).toBe(0);
    expect(score(1)).toBe(0);
    expect(score(3)).toBeGreaterThan(score(2));
    expect(score(99)).toBe(score(5));
  });

  it("never lifts a finding across a severity band", () => {
    expect(tieBreakOf(f({ line: 1, rankEvidence: MAX_EVIDENCE }))).toBeLessThan(1);
    const t = tierFindings(
      [f({ line: 1, severity: "Minor", rankEvidence: MAX_EVIDENCE }), f({ line: 2, severity: "Important" })],
      COMMENTABLE,
      { maxInlineComments: 1 },
    );
    expect(t.inline.map((x) => x.line)).toEqual([2]);
  });
});

describe("tierFindings — ties are cut on evidence, not document order", () => {
  it("spends the inline budget on the stronger evidence even when it was written last", () => {
    const weak = [1, 2, 3].map((line) => f({ line, rankEvidence: { crossesBoundary: false, probe: "corroborated", hypotheses: 1 } }));
    const strong = f({ line: 4, rankEvidence: { crossesBoundary: true, probe: "executed", hypotheses: 2 } });
    const t = tierFindings([...weak, strong], COMMENTABLE, { maxInlineComments: 2 });
    expect(t.inline.map((x) => x.line)).toEqual([4, 1]);
  });

  it("keeps the stronger evidence under the body cap and records the rest", () => {
    const boundary: AttentionBoundary = { maxInlineComments: 0, maxBodyComments: 1 };
    const t = tierFindings(
      [
        f({ line: 1 }),
        f({ line: 2, rankEvidence: { crossesBoundary: false, probe: "executed", hypotheses: 1 } }),
      ],
      COMMENTABLE,
      boundary,
    );
    expect(t.body.map((x) => x.finding.line)).toEqual([2]);
    expect(t.internal.map((x) => [x.finding.line, x.reason])).toEqual([[1, "body-budget"]]);
  });

  it("falls back to document order only on a full tie", () => {
    const same = { crossesBoundary: true, probe: "executed" as const, hypotheses: 1 };
    const t = tierFindings(
      [f({ line: 3, rankEvidence: same }), f({ line: 1, rankEvidence: same })],
      COMMENTABLE,
      { maxInlineComments: 1 },
    );
    expect(t.inline.map((x) => x.line)).toEqual([3]);
  });
});

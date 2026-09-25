/**
 * Issue #405 — the impact rule, and the rank the posting caps spend.
 *
 * A reproduced mechanism is not a defect: on the all-open Martian arm every
 * claim was "confirmed" and adjudicate dropped nothing, so true-but-harmless
 * findings (a locale default, a layering preference) posted beside the gold.
 * The adjudicator now states an `impact` class and the tier follows by
 * arithmetic. These pin the mechanism, never the prompt's wording.
 */
import { describe, expect, it } from "vitest";
import {
  IMPACT_CLASSES,
  buildReview,
  impactDemotes,
  tierFindings,
  unknownImpact,
  type AttentionBoundary,
  type ReviewFinding,
} from "#src/engine/github/review-poster.js";
import { defaultReviewPolicy } from "lastlight-shared/config-types";

const COMMENTABLE = new Map([["src/a.ts", new Set(["RIGHT:1", "RIGHT:2", "RIGHT:3", "RIGHT:4", "RIGHT:5", "RIGHT:6", "RIGHT:7"])]]);
const BOUNDARY: AttentionBoundary = { maxInlineComments: 8, maxBodyComments: null };

function f(over: Partial<ReviewFinding>): ReviewFinding {
  return { path: "src/a.ts", line: 1, severity: "Important", title: "t", body: "b", ...over };
}

const DEFECT = { claim: "the guard never runs", category: "defect" as const, fix: "move it" };
const RISK = { claim: "unreachable today, nothing enforces it", category: "correctness-risk" as const, fix: "guard it" };
const DEMOTING = Object.entries(IMPACT_CLASSES).filter(([, v]) => v === "internal").map(([k]) => k);
const POSTING = Object.entries(IMPACT_CLASSES).filter(([, v]) => v === "post").map(([k]) => k);

describe("the impact rule", () => {
  it("records a preference, no-tests, dead-code or convention finding at internal, with the reason", () => {
    expect(DEMOTING.sort()).toEqual(["convention", "dead-code", "no-tests", "preference"]);
    for (const impact of DEMOTING) {
      const t = tierFindings([f({ ...RISK, impact })], COMMENTABLE, BOUNDARY);
      expect(t.inline, impact).toEqual([]);
      expect(t.body, impact).toEqual([]);
      expect(t.internal.map((x) => x.reason), impact).toEqual(["no-impact"]);
      // Recorded, never dropped: the finding itself — impact included — is kept.
      expect(t.internal[0]!.finding.impact).toBe(impact);
    }
  });

  it("never demotes a finding the adjudicator categorised as a defect", () => {
    // Martian cal-com-8330: a `===` guard on two dayjs objects "can never fire"
    // — `dead-code` as the impact, a real bug as the category, and gold.
    for (const impact of DEMOTING) {
      expect(impactDemotes(f({ ...DEFECT, impact })), impact).toBe(false);
      const t = tierFindings([f({ ...DEFECT, impact })], COMMENTABLE, BOUNDARY);
      expect(t.inline.length, impact).toBe(1);
    }
    // …while every other category still demotes on the same impact.
    for (const category of ["correctness-risk", "maintainability", "nit", "verification"] as const) {
      expect(impactDemotes(f({ category, impact: "dead-code" })), category).toBe(true);
    }
  });

  it("overrides an explicit tier: a demotion is always safe to obey", () => {
    for (const tier of ["inline", "body"] as const) {
      const t = tierFindings([f({ tier, impact: "preference" })], COMMENTABLE, BOUNDARY);
      expect(t.internal.map((x) => x.reason)).toEqual(["no-impact"]);
    }
  });

  it("leaves a posting impact, an absent impact and an unknown one to the rest of the cascade", () => {
    for (const impact of [...POSTING, undefined, null, "", "vibes"]) {
      const t = tierFindings([f({ ...DEFECT, impact })], COMMENTABLE, BOUNDARY);
      expect(t.inline.length, String(impact)).toBe(1);
      expect(impactDemotes(f({ impact }))).toBe(false);
    }
  });

  it("is case- and whitespace-tolerant, and names an unknown class for the log", () => {
    expect(impactDemotes(f({ impact: "  Preference " }))).toBe(true);
    expect(unknownImpact(f({ impact: "vibes" }))).toBe(true);
    expect(unknownImpact(f({ impact: "data" }))).toBe(false);
    expect(unknownImpact(f({}))).toBe(false);
  });

  it("is inert with no attention boundary — the poster's no-pipeline path never reads it", () => {
    // `buildReview` without a boundary routes by anchorability alone; the rule
    // lives in `tierFindings`, which that path does not call.
    const review = buildReview({ summary: "s", event: "COMMENT", findings: [f({ impact: "preference" })] }, COMMENTABLE);
    expect(review.internalCount).toBe(0);
    expect(review.inlineCount).toBe(1);
  });
});

describe("the shipped caps rank a severity that varies", () => {
  it("defaults to a tighter inline budget and a finite body budget", () => {
    const { maxInlineComments, maxBodyComments } = defaultReviewPolicy().analysis;
    expect(maxInlineComments).toBeLessThan(10);
    expect(maxBodyComments).not.toBeNull();
    expect(Number.isFinite(maxBodyComments)).toBe(true);
  });

  it("keeps the strongest derived severities inline and cuts Minor first", () => {
    const { maxInlineComments, maxBodyComments } = defaultReviewPolicy().analysis;
    const findings: ReviewFinding[] = [];
    for (let i = 0; i < 6; i++) findings.push(f({ title: `minor-${i}`, severity: "Minor", line: (i % 7) + 1 }));
    findings.push(f({ title: "important", severity: "Important", line: 7 }));
    findings.push(f({ title: "critical", severity: "Critical", line: 6 }));
    for (let i = 0; i < 6; i++) findings.push(f({ title: `minor-late-${i}`, severity: "Minor", line: (i % 7) + 1 }));
    const t = tierFindings(findings, COMMENTABLE, { maxInlineComments, maxBodyComments });
    const inline = t.inline.map((x) => x.title);
    expect(inline.slice(0, 2)).toEqual(["critical", "important"]);
    expect(inline.length).toBe(maxInlineComments);
    expect(t.body.length).toBe(maxBodyComments);
    expect(t.internal.every((x) => x.reason === "body-budget" && x.finding.severity === "Minor")).toBe(true);
  });
});

import { describe, expect, it } from "vitest";

import type { ModelSummary } from "../types";
import { fmtPct, fmtRatio, tierMetric } from "./format";

/** An arm whose micro-recall and per-case F-beta mean are deliberately far
 * apart, so a test can tell which one the UI is reading. */
const summary = (over: Partial<ModelSummary> = {}): ModelSummary => ({
  model: "arm",
  total: 8,
  codeFixResolved: 0,
  codeFixTotal: 0,
  behavioralOk: 0,
  behavioralTotal: 0,
  reviewTotal: 8,
  avgPrecision: 0.5,
  avgRecall: 0.7,
  avgFbeta: 0.9,
  reviewBeta: 1,
  micro: {
    cases: 8,
    posted: 47,
    gold: 25,
    matched: 8,
    microRecall: 0.32,
    microPrecision: 0.17,
    microF1: 0.222,
    snr: 0.205,
    emptyGoldCases: ["case-with-no-gold"],
    commentsPerPr: 5.875,
  },
  avgInputTokens: 0,
  avgCachedTokens: 0,
  avgOutputTokens: 0,
  totalCostUsd: 0,
  p50DurationMs: 0,
  errors: 0,
  ...over,
});

describe("the pr-review headline", () => {
  const metric = tierMetric("pr-review");

  it("is micro-recall, not the per-case F-beta mean", () => {
    // The bug this guards: the UI showed `avgFbeta` while every planning
    // document reasoned in micro-recall, so the number on screen was not the
    // number under discussion.
    expect(metric.label).toBe("micro-recall");
    expect(metric.rate(summary())).toBe(0.32);
    expect(metric.rate(summary())).not.toBe(0.9);
  });

  it("shows the matched/gold counts, so the denominator is visible", () => {
    expect(metric.frac(summary())).toBe("32% · 8/25");
  });

  it("reads an em dash — never 0% — when no case carried gold", () => {
    const noGold = summary({
      micro: { ...summary().micro!, gold: 0, matched: 0, microRecall: null },
    });
    expect(metric.frac(noGold)).toBe("—");
    expect(fmtRatio(noGold.micro!.microRecall)).toBe("—");
  });

  it("degrades to 0 rate (and an em dash) on a summary with no micro at all", () => {
    const legacy = summary({ micro: undefined });
    expect(metric.rate(legacy)).toBe(0);
    expect(metric.frac(legacy)).toBe("—");
  });
});

describe("the other tiers are untouched", () => {
  it("code-fix stays resolved%", () => {
    const m = summary({ codeFixTotal: 4, codeFixResolved: 3 });
    expect(tierMetric("code-fix").label).toBe("resolved");
    expect(tierMetric("code-fix").rate(m)).toBe(0.75);
  });

  it("everything else stays behavioral%", () => {
    const m = summary({ behavioralTotal: 4, behavioralOk: 1 });
    expect(tierMetric("triage").label).toBe("behavioral");
    expect(tierMetric("triage").rate(m)).toBe(0.25);
  });
});

describe("undefined is not zero", () => {
  it.each([null, undefined, NaN])("renders %s as an em dash", (x) => {
    expect(fmtRatio(x as number | null)).toBe("—");
    expect(fmtPct(x as number | null)).toBe("—");
  });

  it("renders a real zero as zero", () => {
    expect(fmtRatio(0)).toBe("0.000");
    expect(fmtPct(0)).toBe("0%");
  });
});

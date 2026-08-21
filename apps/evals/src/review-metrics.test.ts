/**
 * Recall-first metric tests — deterministic and AI-free, like `mechanism.test.ts`.
 *
 * Two of these are load-bearing rather than incidental:
 *
 *  - **the back-fill reproduces published history exactly.** Every gate in
 *    `docs/plans/review-evidence-pipeline/` compares a candidate against the
 *    already-measured shipped reviewer. If adding micro-recall silently changed
 *    what an old run scored, the comparator would be fiction. Run against the
 *    vendored `sample-results/pr-review` scorecard, so it is a real artifact and
 *    not a shape we invented.
 *  - **the empty-gold case is visible.** One of the eight `skillspro` cases has
 *    no gold findings and therefore scores 1.00 for posting nothing. It is the
 *    reason the arm F1 mean reads higher than the reviewer deserves.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import type { InstanceResult, ReviewGradeResult } from "./schema.js";
import { summarizeModels, type Scorecard } from "./report.js";
import {
  boundaryMetrics,
  familyFunnels,
  goldHits,
  mcnemarExact,
  microReview,
  pairedRecall,
  snrOf,
} from "./review-metrics.js";

// ── fixtures ────────────────────────────────────────────────────────────────

/** A graded pr-review result with only the fields the metrics read. */
function reviewed(instance_id: string, review: Partial<ReviewGradeResult>, extra: Partial<InstanceResult> = {}): InstanceResult {
  const posted = review.posted ?? 0;
  const gold = review.gold ?? 0;
  const matched = review.matched ?? 0;
  return {
    instance_id,
    model: "arm",
    tier: "pr-review",
    workflowSucceeded: true,
    review: {
      precision: posted ? matched / posted : 0,
      recall: gold ? matched / gold : 1,
      fbeta: 0,
      beta: 1,
      posted,
      gold,
      matched,
      falsePositives: [],
      falseNegatives: [],
      ...review,
    },
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: 0,
    phases: [],
    ...extra,
  };
}

/** A trace whose gold vector encodes exactly which gold items were hit. */
function traceOf(hits: boolean[]): ReviewGradeResult["trace"] {
  return {
    judgeModel: "test",
    reviewText: "",
    findings: [],
    gold: hits.map((h, i) => ({ description: `g${i}`, severity: "medium", matchedFinding: h ? i : null })),
  };
}

/** The shipped `pr-review` baseline's shape: 8 cases, 25 gold, 2 posted, 1
 * matched — including the empty-gold case that scores a free 1.00. */
const BASELINE: InstanceResult[] = [
  reviewed("1587-r1", { posted: 1, gold: 3, matched: 1, fbeta: 0.5 }),
  reviewed("1587-r2", { posted: 0, gold: 5, matched: 0 }),
  reviewed("1641", { posted: 0, gold: 0, matched: 0, fbeta: 1 }),
  reviewed("1680-r1", { posted: 0, gold: 4, matched: 0 }),
  reviewed("1680-r2", { posted: 1, gold: 3, matched: 0 }),
  reviewed("1667", { posted: 0, gold: 5, matched: 0 }),
  reviewed("1587-r3", { posted: 0, gold: 4, matched: 0 }),
  reviewed("1641-r2", { posted: 0, gold: 1, matched: 0 }),
];

// ── micro-aggregation ───────────────────────────────────────────────────────

describe("microReview", () => {
  it("reproduces the shipped pr-review baseline's published headline", () => {
    const m = microReview(BASELINE);
    expect(m.posted).toBe(2);
    expect(m.gold).toBe(25);
    expect(m.matched).toBe(1);
    expect(m.microRecall).toBeCloseTo(0.04, 10);
    expect(m.microPrecision).toBeCloseTo(0.5, 10);
    expect(m.snr).toBeCloseTo(1, 10); // 1 matched ÷ 1 unmatched posted
    expect(m.commentsPerPr).toBeCloseTo(0.25, 10);
  });

  it("names the empty-gold case rather than averaging its free 1.00 in silently", () => {
    const m = microReview(BASELINE);
    expect(m.emptyGoldCases).toEqual(["1641"]);
    // …and it contributes nothing to micro-recall, which is the whole point:
    // dropping it leaves the headline unchanged.
    const withoutCanary = microReview(BASELINE.filter((r) => r.instance_id !== "1641"));
    expect(withoutCanary.microRecall).toBe(m.microRecall);
  });

  it("distinguishes 'no gold' from 'missed everything'", () => {
    expect(microReview([reviewed("clean", { posted: 0, gold: 0 })]).microRecall).toBeNull();
    expect(microReview([reviewed("missed", { posted: 0, gold: 3 })]).microRecall).toBe(0);
  });

  it("excludes errored cases — an ungraded case is never a silent zero", () => {
    const withError = [...BASELINE, reviewed("boom", { posted: 0, gold: 10 }, { error: "provider 429" })];
    expect(microReview(withError).gold).toBe(25);
  });

  it("micro-recall diverges from the per-case mean exactly where it should", () => {
    // Two cases: one tiny gold set fully caught, one large gold set missed. The
    // per-case mean says 0.5; micro says 1/7. This is the failure mode the
    // headline change exists to fix.
    const rs = [reviewed("small", { posted: 1, gold: 1, matched: 1 }), reviewed("big", { posted: 0, gold: 6, matched: 0 })];
    expect(microReview(rs).microRecall).toBeCloseTo(1 / 7, 10);
  });
});

describe("snrOf", () => {
  it("is undefined when there is no noise to measure, not infinite", () => {
    expect(snrOf(3, 3)).toBeNull(); // every posted finding matched
    expect(snrOf(0, 0)).toBeNull(); // nothing posted at all
  });

  it("is zero when findings were posted and none matched", () => {
    expect(snrOf(0, 4)).toBe(0);
  });

  it("degrades when an intervention adds more noise than signal", () => {
    const before = snrOf(2, 4)!; // 2 matched / 2 noise = 1.0
    const after = snrOf(3, 12)!; // recall up, 3 matched / 9 noise = 0.33
    expect(after).toBeLessThan(before);
  });
});

// ── the detection floor ─────────────────────────────────────────────────────

describe("mcnemarExact", () => {
  it("reproduces the detection-floor table", () => {
    // k new hits, none lost — the table in DETECTION_FLOOR_MICRO_RECALL, which
    // rounds these to 3dp. Asserted at full precision: with no losses the test
    // reduces to 0.5^k, and THAT is the fact the floor rests on.
    const p = (k: number) => mcnemarExact(k, 0);
    expect(p(1).oneSided).toBeCloseTo(0.5, 10); // 2/25 — a coin flip
    expect(p(2).oneSided).toBeCloseTo(0.25, 10); // 3/25
    expect(p(4).oneSided).toBeCloseTo(0.0625, 10); // 5/25
    expect(p(5).oneSided).toBeCloseTo(0.03125, 10); // 6/25 — first below 0.05
    expect(p(6).oneSided).toBeCloseTo(0.015625, 10); // 7/25
    expect(p(5).twoSided).toBeCloseTo(0.0625, 10);
    expect(p(6).twoSided).toBeCloseTo(0.03125, 10);
  });

  it("gives no evidence when nothing is discordant", () => {
    expect(mcnemarExact(0, 0).oneSided).toBe(1);
  });

  it("counts losses against the candidate", () => {
    expect(mcnemarExact(3, 3).oneSided).toBeGreaterThan(mcnemarExact(3, 0).oneSided);
  });
});

describe("pairedRecall", () => {
  it("sees a swap that the matched counts hide", () => {
    // Same `matched` count either way, but different gold items — a net-zero
    // delta over two real changes. Differencing counts would report nothing.
    const base = [reviewed("a", { posted: 1, gold: 2, matched: 1, trace: traceOf([true, false]) })];
    const cand = [reviewed("a", { posted: 1, gold: 2, matched: 1, trace: traceOf([false, true]) })];
    const p = pairedRecall(base, cand);
    expect(p.gained).toBe(1);
    expect(p.lost).toBe(1);
    expect(p.approximate).toBe(false);
  });

  it("falls back to counts when a trace is missing, and says so", () => {
    const base = [reviewed("a", { posted: 0, gold: 3, matched: 0 })];
    const cand = [reviewed("a", { posted: 2, gold: 3, matched: 2 })];
    const p = pairedRecall(base, cand);
    expect(p.gained).toBe(2);
    expect(p.approximate).toBe(true);
  });

  it("ignores cases the two runs do not share", () => {
    const base = [reviewed("a", { posted: 0, gold: 1, matched: 0, trace: traceOf([false]) })];
    const cand = [
      reviewed("a", { posted: 1, gold: 1, matched: 1, trace: traceOf([true]) }),
      reviewed("b", { posted: 1, gold: 1, matched: 1, trace: traceOf([true]) }),
    ];
    expect(pairedRecall(base, cand).gained).toBe(1);
  });

  it("reads gold hits off the trace", () => {
    expect(goldHits(reviewed("a", { trace: traceOf([true, false, true]) }))).toEqual([true, false, true]);
    expect(goldHits(reviewed("a", {}))).toBeUndefined();
  });
});

// ── the attention boundary + per-family attribution ─────────────────────────

describe("evidence-packet metrics", () => {
  it("degrade cleanly to absent for an arm that emits no packet (the baseline)", () => {
    expect(boundaryMetrics(BASELINE)).toBeUndefined();
    expect(familyFunnels(BASELINE)).toBeUndefined();
    expect(summarizeModels(BASELINE)[0].families).toBeUndefined();
  });

  it("makes 'found more, showed less' legible instead of looking like a regression", () => {
    const rs = [
      reviewed("a", {
        posted: 3,
        gold: 6,
        matched: 2,
        pipeline: {
          internalMatched: 5, // found five of six…
          tiers: { inline: 2, body: 1, internal: 4 },
          inlinePosted: 2,
          inlineMatched: 2,
        },
      }),
    ];
    const b = boundaryMetrics(rs)!;
    expect(b.internalRecall).toBeCloseTo(5 / 6, 10); // …knew about five
    expect(microReview(rs).microRecall).toBeCloseTo(2 / 6, 10); // …said two
    expect(b.internalCount).toBe(4);
    expect(b.inlinePrecision).toBe(1);
    expect(b.inlinePerPr).toBe(2);
  });

  it("never reads a missing internal count as 'found nothing'", () => {
    const rs = [reviewed("a", { posted: 2, gold: 4, matched: 2, pipeline: { tiers: { inline: 2 } } })];
    // No `internalMatched` recorded ⇒ fall back to what was posted-and-matched,
    // so internal recall can never be reported BELOW posted recall.
    expect(boundaryMetrics(rs)!.internalMatched).toBe(2);
  });

  it("rolls the per-family funnel up in declared order", () => {
    const rs = [
      reviewed("a", {
        posted: 2,
        gold: 3,
        matched: 1,
        pipeline: {
          byFamily: {
            spec: { obligations: 2, hypotheses: 3, posted: 1, matched: 1 },
            contract: { obligations: 5, hypotheses: 4, posted: 1, matched: 0 },
          },
        },
      }),
      reviewed("b", {
        posted: 1,
        gold: 2,
        matched: 0,
        pipeline: { byFamily: { contract: { obligations: 3, hypotheses: 2, posted: 1, matched: 0 } } },
      }),
    ];
    const fams = familyFunnels(rs)!;
    expect(fams.map((f) => f.family)).toEqual(["contract", "spec"]); // declared order, not first-seen
    expect(fams[0]).toMatchObject({ obligations: 8, hypotheses: 6, posted: 2, matched: 0 });
  });

  it("keeps 'not measured' distinct from 'did not convert'", () => {
    const rs = [
      reviewed("a", { posted: 0, gold: 1, pipeline: { byFamily: { security: { obligations: 0, notMeasured: true } } } }),
      reviewed("b", { posted: 0, gold: 1, pipeline: { byFamily: { security: { obligations: 4, hypotheses: 2 } } } }),
    ];
    // One case could not run the scanner ⇒ the whole family's roll-up is tainted.
    // A partial measurement reported as a whole one is the failure this guards.
    expect(familyFunnels(rs)![0].notMeasured).toBe(true);
  });
});

// ── the back-fill (AC5) ─────────────────────────────────────────────────────

describe("offline back-fill of an existing scorecard", () => {
  const path = join(import.meta.dirname, "..", "sample-results", "pr-review", "2026-07-05_095214-f2cc826", "scorecard.json");
  const card = JSON.parse(readFileSync(path, "utf8")) as Scorecard;

  it("reproduces the published per-case means EXACTLY", () => {
    // If this fails, the metric change has altered history and must be versioned
    // rather than applied in place. `scripts/rescore.ts` refuses to write on it.
    const rescored = summarizeModels(card.results);
    for (const before of card.models) {
      const after = rescored.find((m) => m.model === before.model)!;
      expect(after.avgPrecision).toBe(before.avgPrecision);
      expect(after.avgRecall).toBe(before.avgRecall);
      expect(after.avgFbeta).toBe(before.avgFbeta);
      expect(after.reviewTotal).toBe(before.reviewTotal);
    }
  });

  it("adds micro-recall and SNR to a run measured before they existed", () => {
    const m = summarizeModels(card.results)[0].micro!;
    // 10 of 28 gold across 10 cases, 25 posted — arithmetic over stored fields,
    // no judge re-run, no spend.
    expect(m.gold).toBe(28);
    expect(m.posted).toBe(25);
    expect(m.matched).toBe(10);
    expect(m.microRecall).toBeCloseTo(10 / 28, 10);
    expect(m.snr).toBeCloseTo(10 / 15, 10);
  });

  it("is not interchangeable with the per-case mean it sits beside", () => {
    const summary = summarizeModels(card.results)[0];
    // On THIS run the mean F1 (0.325) reads LOWER than the micro F1 (0.377):
    // the mean over-weights small-gold cases the reviewer missed entirely. The
    // baseline fixture above shows the opposite direction, where an empty-gold
    // case lifts the mean. Which way it leans is a property of the case mix —
    // that the two disagree at all is why both are reported.
    expect(summary.avgFbeta).not.toBeCloseTo(summary.micro!.microF1!, 2);
    // No empty-gold canary in this dataset, so nothing to flag here.
    expect(summary.micro!.emptyGoldCases).toEqual([]);
  });
});

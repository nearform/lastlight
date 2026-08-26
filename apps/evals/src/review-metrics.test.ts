/**
 * Recall-first metric tests — deterministic and AI-free, like `mechanism.test.ts`.
 *
 * Two of these are load-bearing rather than incidental:
 *
 *  - **the back-fill reproduces published history exactly.** Every gate in
 *    `docs/plans/deterministic-pr-levers.md` compares a candidate against the
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
  bandVerdict,
  boundaryMetrics,
  DETECTION_FLOOR_MICRO_RECALL,
  familyFunnels,
  goldHits,
  mcnemarExact,
  microReview,
  pairedBand,
  pairedRecall,
  snrOf,
  varianceRollup,
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

// ── run-to-run variance ─────────────────────────────────────────────────────

/** A minimal scorecard around one arm's results. */
function card(runId: string, results: InstanceResult[]): Scorecard {
  return {
    models: [],
    results,
    meta: { runId, generatedAt: "1970-01-01T00:00:00.000Z", tiers: ["pr-review"], models: ["arm"], runs: 1 },
  };
}

/** N repeats of one case, each repeat's gold-hit vector given explicitly. */
function repeatsOf(id: string, vectors: boolean[][]): Scorecard[] {
  return vectors.map((hits, i) =>
    card(`run-${i}`, [
      reviewed(id, { posted: hits.length, gold: hits.length, matched: hits.filter(Boolean).length, trace: traceOf(hits) }),
    ]),
  );
}

describe("varianceRollup", () => {
  it("orders union >= mean >= intersection, always", () => {
    // Three repeats that each find one of three gold items — a DIFFERENT one
    // each time. Mean recall 1/3, union 3/3, intersection 0/3: the arm's reach
    // is three times its expectation and its reliable recall is zero.
    const v = varianceRollup(repeatsOf("a", [[true, false, false], [false, true, false], [false, false, true]]));
    expect(v.meanMicroRecall).toBeCloseTo(1 / 3, 10);
    expect(v.unionRecall).toBe(1);
    expect(v.intersectionRecall).toBe(0);
    expect(v.unionRecall!).toBeGreaterThanOrEqual(v.meanMicroRecall!);
    expect(v.meanMicroRecall!).toBeGreaterThanOrEqual(v.intersectionRecall!);
    expect(v.band).toBe(0); // all three scored 1/3 — a stable arm with unstable content
  });

  it("refuses to call a single run's band zero", () => {
    // max − min over one point is 0, and a zero band lets ANY delta clear it.
    // "I did not repeat this" must not read as "this arm has no noise".
    const v = varianceRollup(repeatsOf("a", [[true, false]]));
    expect(v.band).toBeNull();
    expect(v.meanMicroRecall).toBeCloseTo(0.5, 10);
    // One repeat: everything found is also found by "every" repeat.
    expect(v.unionMatched).toBe(v.intersectionMatched);
  });

  it("excludes a zero-gold case without crashing, and without calling it untraced", () => {
    const canary = (i: number) => card(`run-${i}`, [
      reviewed("1641", { posted: 2, gold: 0, matched: 0, trace: traceOf([]) }),
      reviewed("real", { posted: 1, gold: 2, matched: 1, trace: traceOf([true, false]) }),
    ]);
    const v = varianceRollup([canary(0), canary(1)]);
    expect(v.perInstance.map((m) => m.instanceId)).toEqual(["real"]);
    expect(v.untraced).toEqual([]); // it aligned fine — it just has no gold to hit
    expect(v.gold).toBe(2);
  });

  it("names a case whose trace is missing in any repeat rather than guessing at it", () => {
    const v = varianceRollup([
      card("run-0", [reviewed("a", { posted: 1, gold: 2, matched: 1, trace: traceOf([true, false]) })]),
      card("run-1", [reviewed("a", { posted: 1, gold: 2, matched: 1 })]), // judge never ran
    ]);
    expect(v.untraced).toEqual(["a"]);
    expect(v.perInstance).toEqual([]);
    expect(v.gold).toBe(0);
    expect(v.unionRecall).toBeNull(); // nobody looked — not "found none"
    // …but the per-run micro numbers are still real: they read the counts.
    expect(v.repeats.map((r) => r.microRecall)).toEqual([0.5, 0.5]);
  });

  it("treats a gold set that changed shape as dataset drift, not as alignment", () => {
    const v = varianceRollup([
      card("run-0", [reviewed("a", { posted: 1, gold: 2, matched: 1, trace: traceOf([true, false]) })]),
      card("run-1", [reviewed("a", { posted: 1, gold: 3, matched: 1, trace: traceOf([true, false, false]) })]),
    ]);
    expect(v.untraced).toEqual(["a"]);
    expect(v.perInstance).toEqual([]);
  });

  it("names a case one repeat never ran at all", () => {
    const v = varianceRollup([
      card("run-0", [reviewed("a", { gold: 1, trace: traceOf([true]) }), reviewed("b", { gold: 1, trace: traceOf([true]) })]),
      card("run-1", [reviewed("a", { gold: 1, trace: traceOf([false]) })]),
    ]);
    expect(v.untraced).toEqual(["b"]);
    expect(v.perInstance.map((m) => m.instanceId)).toEqual(["a"]);
  });

  it("carries each repeat's runId so a point in the band is traceable to a run", () => {
    const v = varianceRollup(repeatsOf("a", [[true], [false]]));
    expect(v.repeats.map((r) => r.runId)).toEqual(["run-0", "run-1"]);
    expect(v.band).toBe(1);
  });
});

// ── the internal side of the band ───────────────────────────────────────────

describe("varianceRollup — internal union/intersection over pipeline.internalGold", () => {
  /** One repeat of one case with the internal vector given explicitly (or
   * omitted — a pre-vector run, a judge failure). Posted trace rides along so
   * the posted side stays measured either way. */
  const repeat = (runId: string, internalGold?: (number | null)[]) =>
    card(runId, [
      reviewed("a", {
        posted: 1,
        gold: 3,
        matched: 1,
        trace: traceOf([true, false, false]),
        ...(internalGold ? { pipeline: { internalMatched: internalGold.filter((g) => g !== null).length, internalGold } } : {}),
      }),
    ]);

  it("is ABSENT when no repeat carries a vector — an unrecorded surface, not an empty one", () => {
    expect(varianceRollup([repeat("run-0"), repeat("run-1")]).internal).toBeUndefined();
    expect(varianceRollup(repeatsOf("a", [[true], [false]])).internal).toBeUndefined();
  });

  it("computes internal union/intersection parallel to the posted side", () => {
    // Two repeats, three gold: repeat 0 found gold 0+1, repeat 1 found gold 1+2.
    const v = varianceRollup([repeat("run-0", [4, 0, null]), repeat("run-1", [null, 2, 7])]);
    const i = v.internal!;
    expect(i.gold).toBe(3);
    expect(i.unionMatched).toBe(3); // every gold found by ≥ 1 repeat
    expect(i.intersectionMatched).toBe(1); // only gold 1 found by both
    expect(i.unionRecall).toBe(1);
    expect(i.intersectionRecall).toBeCloseTo(1 / 3, 10);
    expect(i.perInstance[0].rows).toEqual([[true, false], [true, true], [false, true]]);
    expect(i.unvectoredRepeats).toEqual([]);
    // …and the posted side is untouched by any of it.
    expect(v.unionMatched).toBe(1);
  });

  it("degrades a vector-less repeat to ABSENT columns that cannot poison the rest", () => {
    // run-1 predates the vector. Its column is null — not misses — so the
    // intersection is over the repeats that measured, and the union cannot
    // shrink. Folding it in as zeros would zero the intersection of every
    // mixed repeat set, which is most of history.
    const v = varianceRollup([repeat("run-0", [0, null, 2]), repeat("run-1")]);
    const i = v.internal!;
    expect(i.unvectoredRepeats).toEqual(["run-1"]);
    expect(i.perInstance[0].missingRepeats).toEqual([1]);
    expect(i.perInstance[0].rows).toEqual([[true, null], [false, null], [true, null]]);
    expect(i.unionMatched).toBe(2);
    expect(i.intersectionMatched).toBe(2); // over the one vector-carrying repeat
    expect(i.untraced).toEqual([]);
  });

  it("an all-null vector is a MEASURED nothing — it zeroes the intersection where absence must not", () => {
    const v = varianceRollup([repeat("run-0", [0, 1, 2]), repeat("run-1", [null, null, null])]);
    expect(v.internal!.unionMatched).toBe(3);
    expect(v.internal!.intersectionMatched).toBe(0);
    expect(v.internal!.unvectoredRepeats).toEqual([]);
  });

  it("names a case whose vectors drifted in length instead of padding them", () => {
    const v = varianceRollup([repeat("run-0", [0, null, 2]), repeat("run-1", [0, null])]);
    expect(v.internal!.untraced).toEqual(["a"]);
    expect(v.internal!.perInstance).toEqual([]);
    expect(v.internal!.gold).toBe(0);
    expect(v.internal!.unionRecall).toBeNull(); // nothing aligned — not "found none"
  });

  it("names a case with no vector in ANY repeat once another case has one", () => {
    const withB = (runId: string, vec?: (number | null)[]) =>
      card(runId, [
        ...repeat(runId, vec).results,
        reviewed("b", { posted: 0, gold: 2, matched: 0, trace: traceOf([false, false]) }),
      ]);
    const v = varianceRollup([withB("run-0", [0, null, null]), withB("run-1", [0, null, null])]);
    expect(v.internal!.untraced).toEqual(["b"]);
    expect(v.internal!.perInstance.map((m) => m.instanceId)).toEqual(["a"]);
    // "b" still counts on the posted side — the two surfaces degrade separately.
    expect(v.perInstance.map((m) => m.instanceId)).toEqual(["a", "b"]);
  });
});

// ── the per-gold paired comparison across two repeat GROUPS ─────────────────

describe("pairedBand", () => {
  /** One repeat of one case: posted hits per gold slot, internal vector
   * optional (omitted = a pre-vector run — an UNRECORDED internal surface). */
  const rep = (runId: string, hits: boolean[], internalGold?: (number | null)[]) =>
    card(runId, [
      reviewed("a", {
        posted: hits.filter(Boolean).length,
        gold: hits.length,
        matched: hits.filter(Boolean).length,
        trace: traceOf(hits),
        ...(internalGold ? { pipeline: { internalMatched: internalGold.filter((g) => g !== null).length, internalGold } } : {}),
      }),
    ]);

  it("pairs the POSTED unions per gold slot — a slot hit by ANY repeat of an arm counts", () => {
    // Baseline hits only slot 0, in both repeats. The candidate hits slot 1 in
    // one repeat and slot 2 in the other — its union is {1, 2}. Per-slot that
    // is +2/−1; a matched-count diff of the same runs reads "1 vs 1, nothing
    // changed" and hides all three discordant slots.
    const baseline = varianceRollup([rep("b0", [true, false, false]), rep("b1", [true, false, false])]);
    const candidate = varianceRollup([rep("c0", [false, true, false]), rep("c1", [false, false, true])]);
    const p = pairedBand(baseline, candidate);
    expect(p.posted.gained).toBe(2);
    expect(p.posted.lost).toBe(1);
    expect(p.posted.compared).toBe(3);
    expect(p.posted.approximate).toBe(false);
    // Exact one-sided McNemar on 2-of-3 discordant in the candidate's favour.
    expect(p.posted.oneSided).toBeCloseTo(0.5, 10);
  });

  it("pairs the INTERNAL unions when both arms recorded vectors", () => {
    // Baseline generated gold 0 (repeat 0) and gold 2 (repeat 1) — union {0, 2}.
    // Candidate generated gold 1 and 2 — union {1, 2}. A `null` cell (that
    // repeat's judge saw nothing for the slot) is a miss for that repeat, but
    // the union across the arm's repeats is what gets paired.
    const baseline = varianceRollup([rep("b0", [true, false, false], [0, null, null]), rep("b1", [true, false, false], [null, null, 2])]);
    const candidate = varianceRollup([rep("c0", [false, true, false], [null, 1, 2]), rep("c1", [false, true, false], [null, 1, null])]);
    const p = pairedBand(baseline, candidate);
    expect(p.internal).toBeDefined();
    expect(p.internal!.gained).toBe(1); // gold 1
    expect(p.internal!.lost).toBe(1); // gold 0
    expect(p.internal!.compared).toBe(3);
    expect(p.internal!.approximate).toBe(false);
  });

  it("reports the internal surface ABSENT — never zeros — when either arm has no vector", () => {
    // The baseline predates the vector. Pairing its unrecorded surface against
    // the candidate's measured one would count every candidate internal hit as
    // a gain — fabricated evidence, in the flattering direction.
    const preVector = varianceRollup([rep("b0", [true, false]), rep("b1", [true, false])]);
    const vectored = varianceRollup([rep("c0", [true, true], [0, 1]), rep("c1", [true, false], [0, null])]);
    expect(pairedBand(preVector, vectored).internal).toBeUndefined();
    expect(pairedBand(vectored, preVector).internal).toBeUndefined();
    // …while the posted surface, which every run records, is still paired.
    expect(pairedBand(preVector, vectored).posted.compared).toBe(2);
    expect(pairedBand(preVector, vectored).posted.gained).toBe(1);
  });
});

describe("bandVerdict", () => {
  /** An arm whose repeats scored exactly these micro-recalls, over 10 gold. */
  const arm = (...recalls: number[]) =>
    varianceRollup(
      recalls.map((r, i) =>
        card(`run-${i}`, [
          reviewed("a", {
            posted: 10,
            gold: 10,
            matched: r * 10,
            trace: traceOf(Array.from({ length: 10 }, (_, j) => j < r * 10)),
          }),
        ]),
      ),
    );

  it("returns INDISTINGUISHABLE inside the band — the whole reason it exists", () => {
    // The measured shape: three identical runs spanning 0.320/0.080/0.200. A
    // candidate at 0.300 is +0.100 on the mean and still well inside 0.240.
    const baseline = arm(0.3, 0.1, 0.2);
    const out = bandVerdict(baseline, arm(0.3, 0.3, 0.3));
    expect(out.verdict).toBe("INDISTINGUISHABLE");
    expect(out.delta).toBeCloseTo(0.1, 10);
    expect(out.reason).toContain("does not clear");
  });

  it("returns KEEP once the delta clears the band", () => {
    const out = bandVerdict(arm(0.3, 0.2), arm(0.6, 0.6));
    expect(out.verdict).toBe("KEEP");
    expect(out.delta).toBeCloseTo(0.35, 10);
    expect(out.reason).toContain("McNemar"); // the paired p rides along
  });

  it("returns REVERT once the delta clears the band downward", () => {
    const out = bandVerdict(arm(0.6, 0.5), arm(0.2, 0.2));
    expect(out.verdict).toBe("REVERT");
    expect(out.delta).toBeCloseTo(-0.35, 10);
  });

  it("refuses a verdict when the baseline was run once", () => {
    // This is the failure that produced KEEP/REVERT/REVERT from ONE config.
    const out = bandVerdict(arm(0.2), arm(0.6));
    expect(out.verdict).toBe("INDISTINGUISHABLE");
    expect(out.delta).toBeCloseTo(0.4, 10);
    expect(out.reason).toContain("UNMEASURED");
  });

  it("refuses a verdict when an arm has no gold to be recalled against", () => {
    const empty = varianceRollup([card("run-0", [reviewed("a", { posted: 2, gold: 0, matched: 0 })])]);
    const out = bandVerdict(empty, arm(0.6, 0.6));
    expect(out.verdict).toBe("INDISTINGUISHABLE");
    expect(out.delta).toBeNull();
  });

  it("says so when a cleared band still sits under the detection floor", () => {
    const out = bandVerdict(arm(0.0, 0.0), arm(0.2, 0.2));
    expect(out.verdict).toBe("KEEP");
    expect(out.reason).toContain("detection floor");
  });

  it("flags a candidate whose own band is wider than the baseline's", () => {
    const out = bandVerdict(arm(0.1, 0.1), arm(0.9, 0.5));
    expect(out.verdict).toBe("KEEP");
    expect(out.reason).toContain("candidate's OWN band is wider");
  });
});

// ── the acceptance fixture: three IDENTICAL runs of one arm ─────────────────

/**
 * The measured variance, pinned to real artifacts.
 *
 * These three scorecards are the same `skillspro` arm run three times with a
 * byte-identical configuration. They scored micro-recall 0.320 / 0.080 / 0.200.
 * Every expectation below is a number computed from the stored judge traces —
 * if the implementation disagrees with one, the implementation is wrong.
 *
 * Vendored (reduced: no session paths, no raw judge text, no gold text) so the
 * test owns its inputs, following the `sample-results/` precedent above.
 *
 * They live under `src/__fixtures__/`, NOT beside that precedent in
 * `sample-results/`, and the reason is `scripts/build-site.ts`: it falls back to
 * `sample-results/` whenever `eval-results/` is empty, which is exactly the CI
 * path that publishes evals.lastlight.dev. Every subdirectory there reads as a
 * tier, so vendoring these beside it put three extra runs on the public demo
 * site — with hollow judge modals, since the reduction strips `reviewText`,
 * `findings` and the gold descriptions that a judge modal renders. A test
 * fixture and a demo artifact are different jobs; `buildIndex` never scans here.
 */
describe("the measured run-to-run variance (real artifacts)", () => {
  const RUNS = ["2026-08-22_184650-00cc469", "2026-08-22_194234-00cc469", "2026-08-22_201607-64862d5"];
  const cards = RUNS.map(
    (id) =>
      JSON.parse(
        readFileSync(join(import.meta.dirname, "__fixtures__", "repeat-band", id, "scorecard.json"), "utf8"),
      ) as Scorecard,
  );
  const v = varianceRollup(cards);

  it("reproduces each repeat's published micro-recall", () => {
    expect(v.repeats.map((r) => r.runId)).toEqual(RUNS);
    expect(v.repeats.map((r) => r.microRecall!.toFixed(3))).toEqual(["0.320", "0.080", "0.200"]);
    expect(v.repeats.map((r) => r.matched)).toEqual([8, 2, 5]);
    expect(v.repeats.every((r) => r.gold === 25)).toBe(true);
  });

  it("measures a band as wide as the entire detection floor", () => {
    expect(v.meanMicroRecall).toBeCloseTo(0.2, 10);
    expect(v.minMicroRecall).toBeCloseTo(0.08, 10);
    expect(v.maxMicroRecall).toBeCloseTo(0.32, 10);
    expect(v.band).toBeCloseTo(0.24, 10);
    // …which is DETECTION_FLOOR_MICRO_RECALL itself. The noise on three
    // identical runs is exactly the size of the smallest effect this gold set
    // can resolve, so no single-run delta on this instrument means anything.
    expect(v.band).toBeCloseTo(DETECTION_FLOOR_MICRO_RECALL, 10);
  });

  it("finds 11 of 25 gold across the three runs and 1 of 25 in all of them", () => {
    expect(v.gold).toBe(25);
    expect(v.unionMatched).toBe(11);
    expect(v.unionRecall).toBeCloseTo(0.44, 10);
    expect(v.intersectionMatched).toBe(1);
    expect(v.intersectionRecall).toBeCloseTo(0.04, 10);
    // The ordering that makes the roll-up worth reading: reach 0.44, expectation
    // 0.20, reliable 0.04. Sampling is throwing away more than half the reach.
    expect(v.unionRecall!).toBeGreaterThan(v.meanMicroRecall!);
    expect(v.meanMicroRecall!).toBeGreaterThan(v.intersectionRecall!);
  });

  it("pins the per-case union vectors", () => {
    const got = Object.fromEntries(v.perInstance.map((m) => [m.instanceId.replace("prreview__skillspro-", ""), [m.union, m.gold]]));
    expect(got).toEqual({
      "1587-r1": [1, 3],
      "1587-r2": [4, 5],
      "1587-r3": [1, 4],
      "1641-r2": [1, 1],
      "1667": [0, 5],
      "1680-r1": [2, 4],
      "1680-r2": [2, 3],
    });
    // The single gold item all three runs found — the arm's whole reliable recall.
    const reliable = v.perInstance.filter((m) => m.intersection > 0).map((m) => m.instanceId);
    expect(reliable).toEqual(["prreview__skillspro-1680-r1"]);
  });

  it("excludes the zero-gold canary, which lost its trace in two of the three runs", () => {
    // 1641 has gold: 0. Run 1 judged it (an empty trace); runs 2 and 3 recorded
    // no trace at all. Missing in >= 1 repeat ⇒ untraced, and it must not crash
    // the hit maths on the way.
    expect(v.untraced).toEqual(["prreview__skillspro-1641"]);
    expect(v.perInstance.some((m) => m.instanceId.endsWith("1641"))).toBe(false);
    // Dropping it costs nothing: it carries no gold, so the denominator is
    // still the full 25.
    expect(v.gold).toBe(25);
  });

  it("calls two halves of this one arm INDISTINGUISHABLE from each other", () => {
    // The acceptance criterion. Split the three identical runs into the best
    // one against the other two — the exact comparison `diff-runs` scored as
    // KEEP on one pairing and REVERT on the others.
    const best = varianceRollup([cards[0], cards[0]]);
    const rest = varianceRollup([cards[1], cards[2]]);
    // Naively this is Δ+0.180, and on a single-run diff it reads as a win.
    expect(bandVerdict(rest, best).delta).toBeCloseTo(0.18, 10);
    // Against the arm's OWN measured band it is nothing at all.
    expect(bandVerdict(v, best).verdict).toBe("INDISTINGUISHABLE");
    expect(bandVerdict(v, rest).verdict).toBe("INDISTINGUISHABLE");
  });
});

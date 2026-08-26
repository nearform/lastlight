import { describe, expect, it } from "vitest";

import { varianceRollup } from "../../../src/review-metrics.js";
import fixture from "../__fixtures__/repeat-group.json" with { type: "json" };
import type { IndexRun, Scorecard } from "../types";
import { buildRepeatBand, inRepeatGroup, repeatCandidates, repeatGroupKey, tierResults } from "./repeats";

/**
 * The fixture is the REAL three-run repeat group
 * (`2026-08-22_{184650,194234,201607}`), reduced to what a band needs: per-case
 * `review` counts and the judge trace's per-gold `matchedFinding` flags. The
 * review text, the extracted findings, the FP/FN lists and **the gold comment
 * text** are stripped — the gold set is private customer data and never belongs
 * in this repo (the same rule `scripts/facts-anchors.ts` follows). Nothing that
 * feeds a number here is stripped, so the arithmetic is over the real verdicts.
 *
 * Its published numbers are 0.320 / 0.080 / 0.200 micro-recall, and the claim
 * this whole view exists to make visible is that the three together found 11 of
 * 25 gold findings while all three found exactly 1. If this test ever starts
 * disagreeing with those figures, the arithmetic changed — not the data.
 */
const cards = fixture as unknown as Scorecard[];
const TIER = "pr-review";

const asIndexRun = (card: Scorecard, i: number): IndexRun => ({
  id: `r${i}`,
  scorecard: `/data/pr-review/${card.meta!.runId}/scorecard.json`,
  runId: card.meta!.runId,
  generatedAt: card.meta!.generatedAt,
  gitSha: card.meta!.gitSha,
  runType: card.meta!.runType,
  tiers: card.meta!.tiers,
  labels: {},
  byTier: [{ tier: TIER, models: [] }],
  runs: 1,
  live: false,
});

const group = cards.map((card, i) => ({ id: `r${i}`, run: asIndexRun(card, i), card }));

describe("the preserved three-run repeat group", () => {
  const band = buildRepeatBand(group, TIER);

  it("reproduces each repeat's published micro-recall", () => {
    expect(band.columns.map((c) => c.microRecall)).toEqual([0.32, 0.08, 0.2]);
  });

  it("spans two git SHAs — which is why the group key must not include one", () => {
    // The fallback grouping suggested for this view keyed on `gitSha`; a docs
    // commit landed between run 2 and run 3, so that key would have split the
    // group in half and hidden exactly the variance it exists to show.
    expect(new Set(band.columns.map((c) => c.gitSha)).size).toBe(2);
    expect(repeatGroupKey(group[0].run, TIER)).toBe(repeatGroupKey(group[2].run, TIER));
  });

  it("is a band, not a point: mean 0.200 over a 0.080–0.320 spread", () => {
    expect(band.meanRecall).toBeCloseTo(0.2, 10);
    expect(band.minRecall).toBeCloseTo(0.08, 10);
    expect(band.maxRecall).toBeCloseTo(0.32, 10);
  });

  it("union 11/25 = 0.440, intersection 1/25 = 0.040", () => {
    expect(band.totalGold).toBe(25);
    expect(band.unionMatched).toBe(11);
    expect(band.unionRecall).toBeCloseTo(0.44, 10);
    expect(band.intersectionMatched).toBe(1);
    expect(band.intersectionRecall).toBeCloseTo(0.04, 10);
  });

  it("discovery is near-disjoint: most findings that were found, were found once", () => {
    expect(band.onceOnly).toBe(8);
    // Union far above the mean is the definition of the problem.
    expect(band.unionRecall!).toBeGreaterThan(band.meanRecall! * 2);
  });

  it("builds one row per gold finding, matrix-shaped", () => {
    expect(band.rows).toHaveLength(25);
    for (const row of band.rows) expect(row.hits).toHaveLength(3);
    expect(band.rows.every((r) => r.description.length > 0)).toBe(true);
  });

  it("groups the three runs together and would not group an unrelated case set", () => {
    expect(inRepeatGroup(cards[0], cards[2], TIER)).toBe(true);
    const different: Scorecard = {
      ...cards[0],
      results: cards[0].results.slice(0, 3),
    };
    expect(inRepeatGroup(cards[0], different, TIER)).toBe(false);
  });

  it("prefers an explicit meta.repeat.group over the case-set heuristic", () => {
    const a: Scorecard = { ...cards[0], meta: { ...cards[0].meta!, repeat: { group: "g1", index: 1, of: 2 } } };
    const b: Scorecard = { ...cards[1], meta: { ...cards[1].meta!, repeat: { group: "g1", index: 2, of: 2 } } };
    const c: Scorecard = { ...cards[2], meta: { ...cards[2].meta!, repeat: { group: "other" } } };
    expect(inRepeatGroup(a, b, TIER)).toBe(true);
    // Same case set, different declared group ⇒ not a repeat of `a`.
    expect(inRepeatGroup(a, c, TIER)).toBe(false);
  });
});

describe("unmeasured cells", () => {
  it("distinguishes 'no judge trace' from 'missed'", () => {
    // Two of the three repeats have no trace for the empty-gold case, which
    // contributes no rows. Drop a trace from a case that DOES carry gold and the
    // cell must read unknown, not missed — collapsing them would inflate the
    // apparent agreement between repeats.
    const stripped: Scorecard = {
      ...cards[0],
      results: cards[0].results.map((r) =>
        r.instance_id === "prreview__skillspro-1587-r2" && r.review
          ? { ...r, review: { ...r.review, trace: undefined } }
          : r,
      ),
    };
    const band = buildRepeatBand(
      [{ id: "r0", run: asIndexRun(stripped, 0), card: stripped }, group[1], group[2]],
      TIER,
    );
    const affected = band.rows.filter((r) => r.instanceId === "prreview__skillspro-1587-r2");
    expect(affected).toHaveLength(5);
    for (const row of affected) expect(row.hits[0]).toBeUndefined();
    expect(affected.every((r) => r.knownCount === 2)).toBe(true);
    // r1 found none of these five and r2 found two, so the intersection cannot
    // gain from an unknown cell.
    expect(affected.filter((r) => r.hits.every((h) => h === true))).toHaveLength(0);
    expect(band.columns[0].partial).toBe(true);
  });
});

/**
 * The anti-divergence gate for the two band implementations.
 *
 * `buildRepeatBand` (here, for the screen) and `varianceRollup`
 * (`src/review-metrics.ts`, for `scripts/band.ts`) are separate on purpose — the
 * header comment in `repeats.ts` says why, and it comes down to this file needing
 * a third cell state (`undefined` = no trace = UNKNOWN) that the harness roll-up
 * does not have. What must never differ is the arithmetic they share, so it is
 * asserted here rather than assumed.
 */
describe("agrees with the harness's own varianceRollup", () => {
  const roll = varianceRollup(cards.map((card) => ({ results: tierResults(card, TIER), meta: card.meta })));
  const band = buildRepeatBand(group, TIER);

  it("produces the same points, band, union and intersection on a fully-traced group", () => {
    expect(roll.repeats.map((r) => r.microRecall)).toEqual(band.columns.map((c) => c.microRecall));
    expect(roll.meanMicroRecall).toBe(band.meanRecall);
    expect(roll.minMicroRecall).toBe(band.minRecall);
    expect(roll.maxMicroRecall).toBe(band.maxRecall);
    expect(roll.band).toBeCloseTo(band.maxRecall! - band.minRecall!, 10);
    expect(roll.gold).toBe(band.totalGold);
    expect(roll.unionMatched).toBe(band.unionMatched);
    expect(roll.intersectionMatched).toBe(band.intersectionMatched);
  });

  it("parts company only where a trace is MISSING — the reason they are separate", () => {
    // Strip one repeat's trace from a 5-gold case. This view keeps the case and
    // marks those cells unknown; the harness roll-up cannot express "unknown", so
    // it excludes the case entirely and NAMES it. Both are right; a delegation
    // would have to pick one and silently lose the other.
    const stripped: Scorecard = {
      ...cards[0],
      results: cards[0].results.map((r) =>
        r.instance_id === "prreview__skillspro-1587-r2" && r.review
          ? { ...r, review: { ...r.review, trace: undefined } }
          : r,
      ),
    };
    const partialCards = [stripped, cards[1], cards[2]];
    const partialBand = buildRepeatBand(
      [{ id: "r0", run: asIndexRun(stripped, 0), card: stripped }, group[1], group[2]],
      TIER,
    );
    const partialRoll = varianceRollup(partialCards.map((card) => ({ results: tierResults(card, TIER), meta: card.meta })));

    expect(partialBand.totalGold).toBe(25); // the case stays, its cells read unknown
    expect(partialRoll.gold).toBe(20); // the case is excluded from the denominator
    expect(partialRoll.untraced).toContain("prreview__skillspro-1587-r2");
    // Neither treats an unknown cell as a hit.
    expect(partialRoll.intersectionMatched).toBeLessThanOrEqual(partialBand.intersectionMatched);
  });
});

describe("repeatCandidates", () => {
  it("keeps runs of the same arm + tier and drops others", () => {
    const runs = group.map((g) => g.run);
    const other: IndexRun = { ...asIndexRun(cards[0], 9), id: "other", tiers: ["triage"], byTier: [{ tier: "triage", models: [] }] };
    expect(repeatCandidates([...runs, other], runs[0], TIER).map((r) => r.id)).toEqual(["r0", "r1", "r2"]);
  });
});

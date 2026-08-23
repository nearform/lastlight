/**
 * Repeat groups: N runs of ONE arm, read as a band rather than a point.
 *
 * Three identical runs of the same arm scored micro-recall 0.320 / 0.080 / 0.200.
 * Their mean is 0.200, their union is 0.440 (11 of 25 gold) and their
 * intersection is 0.040 — exactly ONE gold finding in twenty-five was found by
 * every run. A single arm's number is therefore a draw from a wide distribution,
 * and reading one run as "the result" is the single easiest way to mistake noise
 * for progress. Everything here exists to make that visible.
 *
 * Pure functions over already-fetched scorecards: no fetching, no React, so the
 * arithmetic is testable against the real preserved runs.
 */

import { microReview } from "../../../src/review-metrics.js";
import type { IndexRun, InstanceResult, Scorecard } from "../types";

/**
 * The heuristic group key for a run, used when `meta.repeat.group` is absent —
 * which is every run measured before that field existed.
 *
 * **`gitSha` is deliberately NOT part of this key.** The three preserved repeats
 * of the arm this view was built for span two SHAs (`00cc469` ×2, `64862d5` ×1),
 * because a docs commit landed between run 2 and run 3. Keying on the SHA would
 * split that group in half and hide precisely the variance it exists to show.
 * The SHA is rendered per column instead, so a reader can see when the code
 * moved underneath a repeat and judge for themselves.
 */
export function repeatGroupKey(run: IndexRun, tier: string): string {
  return [tier, run.runType ?? "models", [...run.tiers].sort().join("+"), armsOf(run, tier).join("+")].join("|");
}

/** The arm labels a run measured in one tier (model ids, or config names). */
function armsOf(run: IndexRun, tier: string): string[] {
  const models = run.byTier.find((b) => b.tier === tier)?.models ?? [];
  return models.map((m) => m.model).sort();
}

/**
 * Runs that plausibly repeat `anchor`: same tier, same arm(s), same run type.
 *
 * This is a CANDIDATE set, not a verdict — membership is refined once the
 * scorecards are loaded (a repeat runs the same cases, see
 * {@link sameCaseSet}), and the view lets a reader include or exclude any
 * column. Newest first, matching the index order.
 */
export function repeatCandidates(runs: IndexRun[], anchor: IndexRun, tier: string): IndexRun[] {
  const key = repeatGroupKey(anchor, tier);
  return runs.filter((r) => r.id === anchor.id || (hasTier(r, tier) && repeatGroupKey(r, tier) === key));
}

function hasTier(run: IndexRun, tier: string): boolean {
  return run.byTier.some((b) => b.tier === tier) || run.tiers.includes(tier);
}

/**
 * Which loaded candidates are genuinely repeats of the anchor.
 *
 * `meta.repeat.group` is authoritative when the harness stamped it. Otherwise a
 * repeat is identified by covering the SAME graded case set — a much better
 * proxy than the git SHA (see {@link repeatGroupKey}), because a repeat by
 * definition re-runs the same cases while an unrelated run of the same arm
 * usually does not.
 */
export function inRepeatGroup(anchor: Scorecard, candidate: Scorecard, tier: string): boolean {
  const group = anchor.meta?.repeat?.group;
  if (group) return candidate.meta?.repeat?.group === group;
  return sameCaseSet(caseSetOf(anchor, tier), caseSetOf(candidate, tier));
}

/** Graded case ids in a tier, sorted — repeats of one arm cover the same cases. */
export function caseSetOf(card: Scorecard | undefined, tier: string): string[] {
  if (!card) return [];
  return [...new Set(tierResults(card, tier).map((r) => r.instance_id))].sort();
}

export function sameCaseSet(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** A run's results for one tier (a run may span several). */
export function tierResults(card: Scorecard, tier: string): InstanceResult[] {
  const results = card.results ?? [];
  const fallback = card.meta?.tiers?.[0];
  return results.filter((r) => (r.tier ?? fallback) === tier);
}

// ── The band + the per-gold hit matrix ──────────────────────────────────────

export interface RepeatColumn {
  /** Index-run id (the route segment). */
  id: string;
  runId: string;
  generatedAt: string;
  gitSha?: string;
  /** This repeat's own micro-recall, recomputed from its results so a scorecard
   * predating the `micro` field still contributes a point to the band. */
  microRecall: number | null;
  matched: number;
  gold: number;
  posted: number;
  snr: number | null;
  /** The repeat produced no readable trace for at least one graded case, so some
   * cells below are unknown rather than missed. */
  partial: boolean;
}

/** One gold finding, and whether each repeat found it. `undefined` = that repeat
 * has no judge trace for the case, which is NOT the same as a miss. */
export interface GoldRow {
  instanceId: string;
  goldIndex: number;
  description: string;
  severity: string;
  hits: (boolean | undefined)[];
  /** Repeats that found it (counting only known cells). */
  hitCount: number;
  /** Repeats with a known verdict for this row. */
  knownCount: number;
}

export interface RepeatBand {
  columns: RepeatColumn[];
  rows: GoldRow[];
  /** Gold findings in the union of the repeats' case sets. */
  totalGold: number;
  /** Found by at least one repeat. */
  unionMatched: number;
  unionRecall: number | null;
  /** Found by EVERY repeat — the number that says how reproducible discovery is. */
  intersectionMatched: number;
  intersectionRecall: number | null;
  /** Found by exactly one repeat. */
  onceOnly: number;
  meanRecall: number | null;
  minRecall: number | null;
  maxRecall: number | null;
}

/**
 * Build the band + hit matrix from N loaded scorecards of one arm.
 *
 * Gold order is fixed by the dataset, so `trace.gold[j]` is index-comparable
 * across runs — the same property the harness's own `pairedRecall` relies on.
 * A case a repeat never graded, or graded without a trace, yields `undefined`
 * cells: union treats them as not-found and intersection requires a positive, so
 * both are conservative in the honest direction.
 */
export function buildRepeatBand(cards: { id: string; run: IndexRun; card: Scorecard }[], tier: string): RepeatBand {
  const perRun = cards.map(({ card }) => {
    const results = tierResults(card, tier);
    const byId = new Map<string, InstanceResult>();
    for (const r of results) if (r.review && !r.error) byId.set(r.instance_id, r);
    return { results, byId };
  });

  const columns: RepeatColumn[] = cards.map(({ id, run, card }, i) => {
    const micro = microReview(perRun[i].results);
    const partial = [...perRun[i].byId.values()].some((r) => !r.review?.trace && (r.review?.gold ?? 0) > 0);
    return {
      id,
      runId: card.meta?.runId ?? run.runId,
      generatedAt: card.meta?.generatedAt ?? run.generatedAt,
      gitSha: card.meta?.gitSha ?? run.gitSha,
      microRecall: micro.microRecall,
      matched: micro.matched,
      gold: micro.gold,
      posted: micro.posted,
      snr: micro.snr,
      partial,
    };
  });

  // Every instance any repeat graded, in a stable order.
  const ids = [...new Set(perRun.flatMap((p) => [...p.byId.keys()]))].sort();

  const rows: GoldRow[] = [];
  for (const instanceId of ids) {
    const perCase = perRun.map((p) => p.byId.get(instanceId));
    // Gold count: the widest any repeat saw. A trace is authoritative when
    // present; `review.gold` is the fallback for a case the judge never traced.
    const goldN = Math.max(0, ...perCase.map((r) => r?.review?.trace?.gold.length ?? r?.review?.gold ?? 0));
    const described = perCase.find((r) => r?.review?.trace?.gold.length);
    for (let j = 0; j < goldN; j++) {
      const g = described?.review?.trace?.gold[j];
      const hits = perCase.map((r) => {
        const trace = r?.review?.trace;
        if (!trace || j >= trace.gold.length) return undefined;
        return trace.gold[j].matchedFinding !== null;
      });
      rows.push({
        instanceId,
        goldIndex: j,
        description: g?.description ?? `gold #${j + 1}`,
        severity: g?.severity ?? "",
        hits,
        hitCount: hits.filter((h) => h === true).length,
        knownCount: hits.filter((h) => h !== undefined).length,
      });
    }
  }

  const totalGold = rows.length;
  const unionMatched = rows.filter((r) => r.hitCount > 0).length;
  const intersectionMatched = rows.filter((r) => r.hits.every((h) => h === true)).length;
  const onceOnly = rows.filter((r) => r.hitCount === 1).length;
  const recalls = columns.map((c) => c.microRecall).filter((x): x is number => x !== null);

  return {
    columns,
    rows,
    totalGold,
    unionMatched,
    unionRecall: totalGold ? unionMatched / totalGold : null,
    intersectionMatched,
    intersectionRecall: totalGold ? intersectionMatched / totalGold : null,
    onceOnly,
    meanRecall: recalls.length ? recalls.reduce((a, b) => a + b, 0) / recalls.length : null,
    minRecall: recalls.length ? Math.min(...recalls) : null,
    maxRecall: recalls.length ? Math.max(...recalls) : null,
  };
}

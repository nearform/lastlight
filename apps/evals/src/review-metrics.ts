/**
 * Recall-first review metrics — the instrument the evidence pipeline is read on.
 *
 * `gradeReview` computes per-case precision / recall / F-beta, and the scorecard
 * averages them across cases. That is the right instrument for comparing models
 * on Martian's leaderboard and the WRONG one for steering a recall-first
 * architecture, for two reasons
 * (`docs/plans/review-evidence-pipeline/08-evals.md`):
 *
 *  1. **The arm mean flatters an empty-gold case.** A PR with no gold findings
 *     scores 1.00 for posting nothing, so it contributes a free point to every
 *     average. One of the eight `skillspro` cases is exactly that.
 *  2. **We deliberately over-generate.** Frontier precision on this task is 3-5%,
 *     so an F1 that weights precision equally penalises the intervention we
 *     intend: an arm that surfaces four extra correct findings and two wrong ones
 *     can score *worse*.
 *
 * So the headline becomes **micro-recall** — matched ÷ gold summed over cases,
 * not the mean of per-case recalls — guarded by **SNR** rather than precision.
 *
 * Everything here is pure arithmetic over what `InstanceResult.review` already
 * stores, which is what lets an existing scorecard be re-scored offline with no
 * model spend (`scripts/rescore.ts`).
 */

import type { InstanceResult, ReviewGradeResult } from "./schema.js";

// ── The definitions, written down once ──────────────────────────────────────

/**
 * **Signal-to-noise ratio: matched ÷ (posted − matched).** True positives per
 * false positive, micro-aggregated over an arm.
 *
 * This is the guardrail that replaces precision when the pipeline is tuned to
 * over-produce. CR-Bench reports Reflexion improving recall +5.75pts while SNR
 * fell 5.11 → 1.95 — a trade that is visible in SNR and invisible in F1.
 *
 * `null` when nothing was posted, or when every posted finding matched (no
 * noise, so the ratio is undefined rather than infinite). `0` when findings were
 * posted and none matched.
 *
 * **Do not change this formula silently.** Every number in the plan's ablation
 * ladder is read against it; a redefinition invalidates the comparison without
 * anything erroring.
 */
export function snrOf(matched: number, posted: number): number | null {
  if (posted <= 0) return null;
  const noise = posted - matched;
  return noise <= 0 ? null : matched / noise;
}

/**
 * The six obligation families ([WP3](../../../docs/plans/review-evidence-pipeline/03-seed-and-survey.md)).
 * The fan-out partition: one survey phase per family, and the axis per-family
 * attribution groups on.
 */
export const OBLIGATION_FAMILIES = ["contract", "enforcement", "security", "state", "tests", "spec"] as const;
export type ObligationFamily = (typeof OBLIGATION_FAMILIES)[number];

/**
 * Where an adjudicated finding lands ([WP6](../../../docs/plans/review-evidence-pipeline/06-adjudicate.md)).
 * `internal` is recorded to `review_findings` and never posted — recall and user
 * attention are separate budgets, so they are separate numbers here too.
 */
export const FINDING_TIERS = ["inline", "body", "internal"] as const;
export type FindingTier = (typeof FINDING_TIERS)[number];

// ── The detection floor ─────────────────────────────────────────────────────

/**
 * **What this instrument can and cannot detect** — the number that tells a
 * reader how to interpret every other number in a pr-review scorecard.
 *
 * The `skillspro` set is 25 gold findings across 8 cases (really four PRs, since
 * rounds of the same PR are correlated). Paired (McNemar) over those 25, keeping
 * the baseline's single hit and adding *k* new ones:
 *
 * | Candidate | Micro-recall | New hits | One-sided p | Two-sided p |
 * |---|---|---|---|---|
 * | 2/25 | 0.080 | 1 | 0.50  | 1.00  |
 * | 3/25 | 0.120 | 2 | 0.25  | 0.50  |
 * | 5/25 | 0.200 | 4 | 0.063 | 0.125 |
 * | 6/25 | 0.240 | 5 | 0.031 | 0.063 |
 * | 7/25 | 0.280 | 6 | 0.016 | 0.031 |
 *
 * **Detection floor ≈ 0.24-0.28 micro-recall** — at or above CR-Bench's GPT-5.2
 * (27.0%). This instrument cannot distinguish a real improvement from chance
 * until we are at the field frontier. And that is the optimistic read: it assumes
 * the 25 items are independent (they cluster inside four PRs), zero run-to-run
 * variance (never measured), and a clean judge (LLM-judge/developer agreement is
 * 0.44-0.62).
 *
 * Consequence, and it is binding: **WP3's and WP4's gates are mechanism gates**
 * (obligations generated and well-formed, discharge rate, the per-family funnel),
 * whose n is in the hundreds. Micro-recall is reported at every rung and gated on
 * at none of them until external validation.
 */
export const DETECTION_FLOOR_MICRO_RECALL = 0.24;

/**
 * Exact McNemar (binomial sign test) on the discordant pairs.
 *
 * `gained` = gold findings the candidate hit and the baseline missed; `lost` =
 * the reverse. Concordant pairs carry no information and are excluded, which is
 * the whole point of a paired test on a set this small.
 *
 * Returns the one-sided p (is the candidate better?) and the two-sided p. With
 * `lost = 0` this reduces to `0.5 ^ gained`, which is where the table in
 * {@link DETECTION_FLOOR_MICRO_RECALL} comes from.
 */
export function mcnemarExact(gained: number, lost: number): { oneSided: number; twoSided: number } {
  const n = gained + lost;
  if (n === 0) return { oneSided: 1, twoSided: 1 };
  // P(X >= gained) under X ~ Binomial(n, 0.5).
  let tail = 0;
  for (let i = gained; i <= n; i++) tail += binom(n, i);
  const oneSided = tail / 2 ** n;
  return { oneSided, twoSided: Math.min(1, 2 * oneSided) };
}

function binom(n: number, k: number): number {
  let out = 1;
  for (let i = 1; i <= k; i++) out = (out * (n - i + 1)) / i;
  return out;
}

// ── Micro-aggregation ───────────────────────────────────────────────────────

/**
 * An arm's review performance, micro-aggregated: sum the per-case counts first,
 * then divide. The arm mean of per-case ratios is deliberately NOT this — it
 * weights a 1-gold case the same as a 6-gold one and hands a free 1.00 to the
 * empty-gold case.
 */
export interface MicroReview {
  /** Graded cases (a `review` block, no run error). */
  cases: number;
  /** Distinct findings the arm posted, summed. */
  posted: number;
  /** Gold findings across those cases, summed. */
  gold: number;
  /** Posted findings that matched a gold finding, summed. */
  matched: number;
  /** matched ÷ gold. **The headline.** `null` when no case carried gold. */
  microRecall: number | null;
  /** matched ÷ posted. `null` when nothing was posted. */
  microPrecision: number | null;
  /** F1 over the micro precision/recall. Reported beside micro-recall, never
   * instead of it — the Martian comparison still needs an F1. */
  microF1: number | null;
  /** {@link snrOf} — the over-generation guardrail. */
  snr: number | null;
  /** Cases whose gold set is EMPTY. They cannot contribute recall and score 1.00
   * in the arm mean for posting nothing, so they are precision canaries and are
   * named rather than silently averaged in (AC2). */
  emptyGoldCases: string[];
  /** The attention bill: posted findings per graded PR. Graphite scored 100%
   * precision at 8.8% recall — a reviewer that says nothing looks perfect on
   * precision alone, and this is the number that catches the opposite failure. */
  commentsPerPr: number;
}

/** The gold/posted/matched triple a micro roll-up needs from one case. */
type Counted = Pick<ReviewGradeResult, "posted" | "gold" | "matched">;

function microOf(counted: Counted[], emptyGoldCases: string[]): MicroReview {
  let posted = 0;
  let gold = 0;
  let matched = 0;
  for (const r of counted) {
    posted += r.posted;
    gold += r.gold;
    matched += r.matched;
  }
  const microRecall = gold > 0 ? matched / gold : null;
  const microPrecision = posted > 0 ? matched / posted : null;
  const microF1 =
    microRecall !== null && microPrecision !== null && microRecall + microPrecision > 0
      ? (2 * microRecall * microPrecision) / (microRecall + microPrecision)
      : null;
  return {
    cases: counted.length,
    posted,
    gold,
    matched,
    microRecall,
    microPrecision,
    microF1,
    snr: snrOf(matched, posted),
    emptyGoldCases,
    commentsPerPr: counted.length ? posted / counted.length : 0,
  };
}

/** Graded pr-review results only: a `review` block and no run error (an errored
 * case is UNGRADED, never a silent zero — preserve that here too). */
export function gradedReviews(results: InstanceResult[]): InstanceResult[] {
  return results.filter((r) => r.review !== undefined && !r.error);
}

/** Micro-aggregate an arm's graded review cases. */
export function microReview(results: InstanceResult[]): MicroReview {
  const graded = gradedReviews(results);
  return microOf(
    graded.map((r) => r.review!),
    graded.filter((r) => r.review!.gold === 0).map((r) => r.instance_id),
  );
}

// ── The two boundaries (WP6's attention split) ──────────────────────────────

/**
 * Recall and attention measured at three different boundaries, so an
 * intervention that **finds more and shows less** reads as exactly that instead
 * of as a regression:
 *
 * | Measured over | Metric |
 * |---|---|
 * | everything the pipeline generated (hypotheses ∪ findings) | internal recall |
 * | everything posted (inline + body) | {@link MicroReview} above |
 * | everything inline | attention cost |
 *
 * Requires the evidence packet's `tier` and `family`. Absent for an arm that
 * emits neither (the shipped baseline), and that is a clean degrade — the posted
 * numbers are still complete.
 */
export interface BoundaryMetrics {
  /** Gold findings matched by ANYTHING the pipeline generated, posted or not.
   * "What did we know and not say?" is a query, not a guess. */
  internalRecall: number | null;
  internalMatched: number;
  /** Findings recorded but deliberately not posted. */
  internalCount: number;
  /** Inline comments — the actual attention bill. */
  inlinePosted: number;
  inlineMatched: number;
  inlinePrecision: number | null;
  inlinePerPr: number;
  /** Findings posted into the review body ("Additional findings"). */
  bodyPosted: number;
}

/** Compute the attention boundaries, or `undefined` for an arm that emits no
 * evidence packet (AC3's "degrades cleanly"). */
export function boundaryMetrics(results: InstanceResult[]): BoundaryMetrics | undefined {
  const withPipeline = gradedReviews(results).filter((r) => r.review!.pipeline);
  if (!withPipeline.length) return undefined;

  let gold = 0;
  let internalMatched = 0;
  let internalCount = 0;
  let inlinePosted = 0;
  let inlineMatched = 0;
  let bodyPosted = 0;
  for (const r of withPipeline) {
    const p = r.review!.pipeline!;
    gold += r.review!.gold;
    // An arm that records no internal-recall count still matched whatever it
    // posted — never let a missing field read as "found nothing".
    internalMatched += p.internalMatched ?? r.review!.matched;
    internalCount += p.tiers?.internal ?? 0;
    inlinePosted += p.inlinePosted ?? 0;
    inlineMatched += p.inlineMatched ?? 0;
    bodyPosted += p.tiers?.body ?? 0;
  }
  return {
    internalRecall: gold > 0 ? internalMatched / gold : null,
    internalMatched,
    internalCount,
    inlinePosted,
    inlineMatched,
    inlinePrecision: inlinePosted > 0 ? inlineMatched / inlinePosted : null,
    inlinePerPr: inlinePosted / withPipeline.length,
    bodyPosted,
  };
}

// ── Per-family attribution ──────────────────────────────────────────────────

/**
 * The per-family funnel — obligations → hypotheses → posted → matched.
 *
 * This is what makes a measurement answer *"which kind of reasoning got
 * better?"* rather than *"the number moved"*, and it is the axis the ablation
 * ladder is legible on.
 */
export interface FamilyFunnel {
  family: string;
  obligations: number;
  hypotheses: number;
  posted: number;
  matched: number;
  /** The family could not be measured on this arm — e.g. `security` on a host
   * without Opengrep/gitleaks on PATH (§D2). It must be reported as **"not
   * measured"**, never as "did not convert": a missing scanner and a scanner
   * that found nothing are different facts. */
  notMeasured: boolean;
}

/** Roll the per-case family funnels up across an arm, or `undefined` when no
 * case carried one. */
export function familyFunnels(results: InstanceResult[]): FamilyFunnel[] | undefined {
  const withFamilies = gradedReviews(results).filter((r) => r.review!.pipeline?.byFamily);
  if (!withFamilies.length) return undefined;

  const acc = new Map<string, FamilyFunnel>();
  for (const r of withFamilies) {
    for (const [family, f] of Object.entries(r.review!.pipeline!.byFamily!)) {
      const cur =
        acc.get(family) ?? { family, obligations: 0, hypotheses: 0, posted: 0, matched: 0, notMeasured: false };
      cur.obligations += f.obligations ?? 0;
      cur.hypotheses += f.hypotheses ?? 0;
      cur.posted += f.posted ?? 0;
      cur.matched += f.matched ?? 0;
      // Unmeasurable on ANY case taints the family's roll-up: a partial
      // measurement reported as a whole one is the failure mode this guards.
      cur.notMeasured = cur.notMeasured || !!f.notMeasured;
      acc.set(family, cur);
    }
  }
  // Declared family order first (so the table reads the same every run), then
  // anything unexpected an arm emitted.
  const known = OBLIGATION_FAMILIES.filter((f) => acc.has(f)).map((f) => acc.get(f)!);
  const extra = [...acc.values()].filter((f) => !(OBLIGATION_FAMILIES as readonly string[]).includes(f.family));
  return [...known, ...extra];
}

// ── Paired comparison (the detection floor, made mechanical) ────────────────

/**
 * Per-gold-item hit vector for one case, read off the judge trace
 * (`gold[j].matchedFinding !== null`).
 *
 * Gold order is fixed by the dataset, so the vectors of two runs over the same
 * instance are index-comparable — which is what makes an EXACT paired test
 * possible instead of differencing two `matched` counts (a case that gains one
 * and loses one nets to zero and hides both).
 *
 * `undefined` when the case has no trace (the judge never ran).
 */
export function goldHits(r: InstanceResult): boolean[] | undefined {
  const trace = r.review?.trace;
  if (!trace) return undefined;
  return trace.gold.map((g) => g.matchedFinding !== null);
}

export interface PairedRecall {
  /** Gold findings the candidate hit that the baseline missed. */
  gained: number;
  /** Gold findings the baseline hit that the candidate missed. */
  lost: number;
  /** Gold items compared (both runs had a trace for the case). */
  compared: number;
  oneSided: number;
  twoSided: number;
  /** True when the comparison fell back to per-case `matched` counts because a
   * trace was missing — `gained`/`lost` are then a LOWER bound on discordance
   * and the p-value is correspondingly optimistic. Say so wherever it renders. */
  approximate: boolean;
}

/**
 * Paired McNemar over two runs' gold hits, keyed on `instance_id`.
 *
 * This is the detection floor made operational: it answers *"could this
 * difference be chance?"* on the instrument we actually have, rather than
 * leaving a reader to compare two micro-recalls that differ by one finding.
 */
export function pairedRecall(baseline: InstanceResult[], candidate: InstanceResult[]): PairedRecall {
  const byId = (rs: InstanceResult[]) => new Map(gradedReviews(rs).map((r) => [r.instance_id, r]));
  const base = byId(baseline);
  const cand = byId(candidate);

  let gained = 0;
  let lost = 0;
  let compared = 0;
  let approximate = false;
  for (const [id, b] of base) {
    const c = cand.get(id);
    if (!c) continue;
    const bh = goldHits(b);
    const ch = goldHits(c);
    if (bh && ch && bh.length === ch.length) {
      compared += bh.length;
      for (let i = 0; i < bh.length; i++) {
        if (ch[i] && !bh[i]) gained++;
        else if (bh[i] && !ch[i]) lost++;
      }
    } else {
      // No trace (or a gold set that changed shape between runs): fall back to
      // the counts, which can only UNDER-count discordance.
      approximate = true;
      compared += Math.max(b.review!.gold, c.review!.gold);
      const d = c.review!.matched - b.review!.matched;
      if (d > 0) gained += d;
      else if (d < 0) lost += -d;
    }
  }
  return { ...mcnemarExact(gained, lost), gained, lost, compared, approximate };
}

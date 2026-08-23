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

/**
 * The two fields a variance rollup reads off a scorecard — its graded results,
 * and the run id to label the repeat with.
 *
 * Deliberately structural rather than an import of `Scorecard` from
 * `report.ts`. A `Scorecard` is assignable to this, so every caller passes one
 * unchanged; what it buys is that this module keeps importing **nothing** from
 * `report.ts`. That import was type-only and erased at bundle time, but a
 * type-checker still walks it — `report.ts` → `grade.ts` → `judge.ts` →
 * `fake-github.ts` — and dragged `node:fs` into the dashboard's browser
 * program, which had to declare Node globals to compile. Narrowing the
 * parameter to what the function actually uses is also the more honest
 * signature: `varianceRollup` has no interest in the other fields.
 */
export interface RepeatCard {
  results: InstanceResult[];
  meta?: { runId?: string };
}

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

// ── Run-to-run variance (the instrument's own noise floor) ──────────────────

/**
 * **The measurement that says how much of a delta is the arm and how much is the
 * dice.** Three IDENTICAL runs of one `skillspro` arm scored micro-recall
 * 0.320 / 0.080 / 0.200 — a band of 0.240, which is the entire detection floor
 * ({@link DETECTION_FLOOR_MICRO_RECALL}) — while the obligations they were
 * scored against were byte-identical. So the spread is the survey models, not
 * the pipeline, and **a single run is not a number**.
 *
 * The consequence for every gate in the plan: a candidate must beat the
 * baseline's *measured band*, not the baseline's *last run*. Comparing two
 * single runs of the same configuration produced KEEP once and REVERT twice.
 * {@link bandVerdict} exists to make that outcome unreadable as a result.
 *
 * Union and intersection are reported beside the mean because they answer two
 * different questions the mean cannot:
 *
 * | Statistic | Question |
 * |---|---|
 * | mean (0.200) | what one run is worth in expectation |
 * | **union** (0.440) | what the pipeline is CAPABLE of surfacing — the ceiling sampling is throwing away |
 * | **intersection** (0.040) | what it surfaces RELIABLY — the only part a user would actually get every time |
 *
 * On the measured three runs that is 11 of 25 gold found by at least one run
 * and 1 of 25 found by all three: the arm's reliable recall is a fifth of its
 * mean, and its mean is under half its reach.
 */

/** One repeat of an identical arm — a single point in the band. */
export interface RepeatPoint {
  /** `meta.runId` of the scorecard this point came from; `repeat-N` when the
   * card carries no meta (a live, in-flight write). */
  runId: string;
  microRecall: number | null;
  microPrecision: number | null;
  snr: number | null;
  posted: number;
  matched: number;
  gold: number;
}

/**
 * Per-gold-item hits for ONE case across every repeat — `rows[goldIndex][repeatIndex]`.
 *
 * Gold order is fixed by the dataset, so column *j* is the same gold finding in
 * every repeat (the same property {@link pairedRecall} rests on). That is what
 * makes union/intersection meaningful rather than a count comparison: two runs
 * that each matched 1 of 3 may have matched *different* items, and the mean
 * cannot tell you which.
 */
export interface GoldHitMatrix {
  instanceId: string;
  /** `rows[goldIndex][repeatIndex]` — one row per gold finding. */
  rows: boolean[][];
  /** Gold findings in this case (= `rows.length`). */
  gold: number;
  /** Gold findings matched by AT LEAST ONE repeat. */
  union: number;
  /** Gold findings matched by EVERY repeat. */
  intersection: number;
}

export interface VarianceRollup {
  repeats: RepeatPoint[];
  meanMicroRecall: number | null;
  minMicroRecall: number | null;
  maxMicroRecall: number | null;
  /**
   * `max − min` — the arm's measured run-to-run spread, and the bar a candidate
   * has to clear.
   *
   * **`null` with fewer than two measured repeats**, deliberately: a single run
   * would give `max − min = 0`, and a zero band lets *any* delta clear it. "I
   * did not repeat this" must not read as "this arm has no noise" — that is the
   * exact misreading this whole roll-up exists to prevent.
   */
  band: number | null;
  /** Gold matched by >= 1 repeat, summed over {@link perInstance}. */
  unionMatched: number;
  /** Gold matched by EVERY repeat, summed over {@link perInstance}. */
  intersectionMatched: number;
  /** Gold findings the hit matrices cover — the denominator for both recalls
   * below. Excludes anything in {@link untraced}. */
  gold: number;
  unionRecall: number | null;
  intersectionRecall: number | null;
  perInstance: GoldHitMatrix[];
  /**
   * Cases that could NOT be aligned across the repeats, and are therefore absent
   * from the hit maths entirely rather than folded in at a guess. Three causes,
   * all real:
   *
   *  - the judge trace was missing in at least one repeat (the judge never ran);
   *  - the case was absent from at least one repeat's results;
   *  - the gold arrays differ in LENGTH between repeats — dataset drift, i.e.
   *    the repeats were not scored against the same gold set at all. That is an
   *    error to go and fix, never something to pad or truncate into alignment.
   *
   * A zero-gold case (the precision canary) is NOT here: it aligned fine, it
   * simply has no gold to hit, so it contributes an empty matrix's worth of
   * nothing and is dropped from {@link perInstance}.
   */
  untraced: string[];
}

/**
 * Roll a set of repeats of ONE arm up into its band.
 *
 * **Pass one arm's repeats.** A scorecard with several arms micro-aggregates all
 * of them together here (there is no arm selector in this signature) — filter
 * `card.results` by `model` first if a card carries more than one.
 */
export function varianceRollup(cards: RepeatCard[]): VarianceRollup {
  const repeats: RepeatPoint[] = cards.map((card, i) => {
    const m = microReview(card.results);
    return {
      runId: card.meta?.runId ?? `repeat-${i + 1}`,
      microRecall: m.microRecall,
      microPrecision: m.microPrecision,
      snr: m.snr,
      posted: m.posted,
      matched: m.matched,
      gold: m.gold,
    };
  });

  const byId = cards.map((c) => new Map(gradedReviews(c.results).map((r) => [r.instance_id, r])));
  const ids = [...new Set(byId.flatMap((m) => [...m.keys()]))].sort();

  const perInstance: GoldHitMatrix[] = [];
  const untraced: string[] = [];
  for (const id of ids) {
    const vectors = byId.map((m) => {
      const r = m.get(id);
      return r ? goldHits(r) : undefined;
    });
    // Missing in a repeat, or never judged in one ⇒ not comparable. Name it.
    if (vectors.some((v) => v === undefined)) {
      untraced.push(id);
      continue;
    }
    const vecs = vectors as boolean[][];
    const width = vecs[0].length;
    // Gold sets of different shapes are two different datasets wearing one id.
    if (vecs.some((v) => v.length !== width)) {
      untraced.push(id);
      continue;
    }
    // The zero-gold precision canary: aligned, but nothing to hit.
    if (width === 0) continue;

    const rows: boolean[][] = [];
    let union = 0;
    let intersection = 0;
    for (let j = 0; j < width; j++) {
      const row = vecs.map((v) => v[j]);
      rows.push(row);
      if (row.some(Boolean)) union++;
      if (row.every(Boolean)) intersection++;
    }
    perInstance.push({ instanceId: id, rows, gold: width, union, intersection });
  }

  const gold = perInstance.reduce((a, m) => a + m.gold, 0);
  const unionMatched = perInstance.reduce((a, m) => a + m.union, 0);
  const intersectionMatched = perInstance.reduce((a, m) => a + m.intersection, 0);

  const measured = repeats.map((r) => r.microRecall).filter((v): v is number => v !== null);
  const meanMicroRecall = measured.length ? measured.reduce((a, b) => a + b, 0) / measured.length : null;
  const minMicroRecall = measured.length ? Math.min(...measured) : null;
  const maxMicroRecall = measured.length ? Math.max(...measured) : null;

  return {
    repeats,
    meanMicroRecall,
    minMicroRecall,
    maxMicroRecall,
    // See the field doc: one repeat has no band, it has an unmeasured one.
    band: measured.length >= 2 ? maxMicroRecall! - minMicroRecall! : null,
    unionMatched,
    intersectionMatched,
    gold,
    unionRecall: gold > 0 ? unionMatched / gold : null,
    intersectionRecall: gold > 0 ? intersectionMatched / gold : null,
    perInstance,
    untraced,
  };
}

/**
 * `KEEP` / `REVERT` — the candidate cleared the baseline's noise, in that
 * direction. `INDISTINGUISHABLE` — **the instrument cannot tell**, which is a
 * measurement and not a failure to produce one.
 */
export type BandVerdict = "KEEP" | "REVERT" | "INDISTINGUISHABLE";

const fmt = (n: number) => n.toFixed(3);

/**
 * Compare two arms **band-first**: a mean delta only counts if it clears the
 * baseline's measured run-to-run spread.
 *
 * `scripts/diff-runs.ts` returned KEEP on one run of a configuration and REVERT
 * on two others *of that same configuration*, because it differenced single
 * runs. Every verdict here is gated on {@link VarianceRollup.band} first, so
 * that outcome comes back as INDISTINGUISHABLE — the honest answer — instead of
 * as whichever sign the dice landed on.
 *
 * When the band IS cleared, the reason carries the exact paired McNemar p from
 * {@link pairedRecall} over the two arms' union hits (found by >= 1 repeat), so
 * "cleared the noise" and "is not chance" stay separate claims.
 */
export function bandVerdict(
  baseline: VarianceRollup,
  candidate: VarianceRollup,
): { verdict: BandVerdict; reason: string; delta: number | null } {
  const b = baseline.meanMicroRecall;
  const c = candidate.meanMicroRecall;
  if (b === null || c === null) {
    const which = b === null && c === null ? "neither arm" : b === null ? "the baseline" : "the candidate";
    return {
      verdict: "INDISTINGUISHABLE",
      reason: `no micro-recall measured on ${which} — nothing was compared.`,
      delta: null,
    };
  }

  const delta = c - b;
  if (baseline.band === null) {
    const n = baseline.repeats.length;
    return {
      verdict: "INDISTINGUISHABLE",
      reason:
        `Δ${fmt(delta)} (${fmt(b)} → ${fmt(c)}), but the baseline's band is UNMEASURED ` +
        `(${n} repeat${n === 1 ? "" : "s"}): a single run cannot bound its own noise, so the whole ` +
        `delta could be it. Repeat the baseline before reading this.`,
      delta,
    };
  }

  const band = baseline.band;
  const spread = `baseline band ${fmt(band)} (${fmt(baseline.minMicroRecall!)}–${fmt(baseline.maxMicroRecall!)} over ${baseline.repeats.length} repeats)`;
  if (Math.abs(delta) <= band) {
    return {
      verdict: "INDISTINGUISHABLE",
      reason: `Δ${fmt(delta)} (${fmt(b)} → ${fmt(c)}) does not clear the ${spread}.`,
      delta,
    };
  }

  const paired = pairedRecall(unionResults(baseline), unionResults(candidate));
  const caveats: string[] = [
    `paired McNemar over union hits: +${paired.gained}/−${paired.lost} of ${paired.compared} gold, one-sided p=${fmt(paired.oneSided)}${paired.approximate ? " (APPROXIMATE — a trace was missing)" : ""}`,
  ];
  if (candidate.band !== null && candidate.band > band) {
    caveats.push(`the candidate's OWN band is wider (${fmt(candidate.band)}) — read this against that, not the baseline's`);
  }
  const better = delta > 0;
  if (Math.max(b, c) < DETECTION_FLOOR_MICRO_RECALL) {
    caveats.push(
      `both arms sit below the ${fmt(DETECTION_FLOOR_MICRO_RECALL)} detection floor, where this gold set cannot separate a real effect from chance`,
    );
  }

  return {
    verdict: better ? "KEEP" : "REVERT",
    reason: `Δ${fmt(delta)} (${fmt(b)} → ${fmt(c)}) clears the ${spread}. ${caveats.join("; ")}.`,
    delta,
  };
}

/**
 * Project a roll-up's per-case UNION hit vectors back into `InstanceResult`
 * shape so {@link pairedRecall} — the one exact-paired differ — can run over
 * them unmodified. Deliberately not a second implementation of the diff: the
 * fallback rules, the `approximate` flag and the McNemar call all stay in one
 * place, and a change to how discordance is counted cannot diverge between the
 * two callers.
 */
function unionResults(v: VarianceRollup): InstanceResult[] {
  return v.perInstance.map((m) => {
    const hits = m.rows.map((row) => row.some(Boolean));
    const matched = hits.filter(Boolean).length;
    return {
      instance_id: m.instanceId,
      model: "union",
      tier: "pr-review",
      workflowSucceeded: true,
      review: {
        precision: 0,
        recall: m.gold ? matched / m.gold : 0,
        fbeta: 0,
        beta: 1,
        posted: matched,
        gold: m.gold,
        matched,
        falsePositives: [],
        falseNegatives: [],
        trace: {
          judgeModel: "union",
          reviewText: "",
          findings: [],
          gold: hits.map((h, j) => ({ description: `gold-${j}`, severity: "unknown", matchedFinding: h ? j : null })),
        },
      },
      inputTokens: 0,
      cachedTokens: 0,
      outputTokens: 0,
      costUsd: 0,
      durationMs: 0,
      phases: [],
    };
  });
}

import { boundaryMetrics, familyFunnels, microReview } from "../../../src/review-metrics.js";
import type { InstanceResult, ModelSummary } from "../types";

const avg = (xs: number[]): number => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

/**
 * Per-model roll-up over a set of results. Used in the run view to summarize a
 * single tier's slice of a multi-tier scorecard, which the top-level
 * `card.models` (aggregated across tiers) can't give us.
 *
 * **This is a mirror of the harness `summarizeModels` (`src/report.ts`) and that
 * is a liability, not a design.** The harness function lives in a module that
 * imports `node:fs`, so it cannot be pulled into the bundle; only the grouping
 * and the plain averages are re-stated here. Everything with real arithmetic in
 * it — `micro`, `boundaries`, `families` — is delegated to the harness's OWN
 * `src/review-metrics.ts`, which is pure and imports cleanly.
 *
 * The previous copy omitted those three fields entirely, so the dashboard fetched
 * a scorecard carrying `micro` and threw it away, and showed the per-case F-beta
 * mean as the pr-review headline while every planning document reasoned in
 * micro-recall. `summarize.test.ts` now runs the harness function in Node and
 * asserts field-for-field agreement, so that cannot recur silently.
 *
 * Recomputing rather than reading `card.models[i].micro` is also what makes the
 * whole `sample-results/` corpus (and every `eval-results/` run predating the
 * field) render: `microReview` derives it from `review.{posted,gold,matched}`.
 */
export function summarizeModels(results: InstanceResult[]): ModelSummary[] {
  const byModel = new Map<string, InstanceResult[]>();
  for (const r of results) {
    const list = byModel.get(r.model) ?? [];
    list.push(r);
    byModel.set(r.model, list);
  }

  const models: ModelSummary[] = [];
  for (const [model, list] of byModel) {
    const codeFix = list.filter((r) => r.resolved !== undefined);
    const behavioral = list.filter((r) => r.behavioral !== undefined && !r.error);
    const review = list.filter((r) => r.review !== undefined && !r.error);
    const durations = list.map((r) => r.durationMs).sort((a, b) => a - b);
    models.push({
      model,
      total: list.length,
      codeFixResolved: codeFix.filter((r) => r.resolved).length,
      codeFixTotal: codeFix.length,
      behavioralOk: behavioral.filter((r) => r.behavioral?.ok).length,
      behavioralTotal: behavioral.length,
      reviewTotal: review.length,
      avgPrecision: avg(review.map((r) => r.review!.precision)),
      avgRecall: avg(review.map((r) => r.review!.recall)),
      avgFbeta: avg(review.map((r) => r.review!.fbeta)),
      reviewBeta: review[0]?.review!.beta,
      micro: review.length ? microReview(list) : undefined,
      boundaries: boundaryMetrics(list),
      families: familyFunnels(list),
      avgInputTokens: avg(list.map((r) => r.inputTokens)),
      avgCachedTokens: avg(list.map((r) => r.cachedTokens)),
      avgOutputTokens: avg(list.map((r) => r.outputTokens)),
      totalCostUsd: list.reduce((s, r) => s + r.costUsd, 0),
      p50DurationMs: durations[Math.floor(durations.length / 2)] ?? 0,
      errors: list.filter((r) => r.error).length,
    });
  }
  return models;
}

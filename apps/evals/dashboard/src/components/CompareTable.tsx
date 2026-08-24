import type { ModelSummary } from "../types";
import { fbetaLabel, fmtMs, fmtPct, fmtRatio, fmtTokens, isPrReviewTier, modelLabel, rankModels, tierMetric } from "../lib/format";
import { Bar } from "./ui";

/** Comparison table for one tier: arms (models, or configs in a `config` run) as
 * rows, ranked by the tier's primary metric, with inline bars + best-in-column
 * stars. `axisLabel` names the row axis ("Model" by default, "Config" for a
 * `config` run). */
export function CompareTable({
  models,
  tier,
  labels,
  axisLabel = "model",
}: {
  models: ModelSummary[];
  tier: string;
  labels: Record<string, string>;
  axisLabel?: string;
}) {
  // pr-review label reflects the β the run graded with (F1 by default).
  const reviewBeta = models.find((m) => m.reviewBeta !== undefined)?.reviewBeta ?? 1;
  const metric = tierMetric(tier, reviewBeta);
  const ranked = rankModels(models, metric);
  const isReview = isPrReviewTier(tier);

  const bestRate = Math.max(0, ...ranked.map(metric.rate));
  const costs = ranked.filter((m) => m.totalCostUsd > 0).map((m) => m.totalCostUsd);
  const lats = ranked.filter((m) => m.p50DurationMs > 0).map((m) => m.p50DurationMs);
  const minCost = costs.length ? Math.min(...costs) : Infinity;
  const minLat = lats.length ? Math.min(...lats) : Infinity;
  const maxCost = costs.length ? Math.max(...costs) : 1;
  const maxLat = lats.length ? Math.max(...lats) : 1;

  return (
    <div className="overflow-x-auto rounded-xl border border-base-300 bg-base-200">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-neutral text-2xs uppercase tracking-wide text-neutral-content/70">
            <th className="w-8 px-3 py-3 text-center font-semibold">#</th>
            <th className="px-3 py-3 text-left font-semibold">{axisLabel.toLowerCase()}</th>
            <th className="px-3 py-3 text-left font-semibold">{metric.label} →</th>
            {isReview && (
              <>
                <th className="px-3 py-3 text-right font-semibold" title="matched ÷ (posted − matched) — true positives per false positive. The over-generation guardrail that replaces precision.">
                  snr →
                </th>
                <th className="px-3 py-3 text-right font-semibold" title="matched ÷ posted, micro-aggregated">
                  µ-prec
                </th>
                <th className="px-3 py-3 text-right font-semibold" title="Posted findings per graded PR — the attention bill.">
                  cmts/pr
                </th>
                <th
                  className="px-3 py-3 text-right font-normal text-neutral-content/40"
                  title="Secondary: the MEAN of per-case F-beta. Weights a 1-gold case like a 6-gold one and scores 1.00 on an empty-gold case; kept for the Martian leaderboard comparison."
                >
                  {fbetaLabel(reviewBeta)} mean
                </th>
              </>
            )}
            <th className="px-3 py-3 text-left font-semibold">total cost ↓</th>
            <th className="px-3 py-3 text-left font-semibold">p50 latency ↓</th>
            <th className="px-3 py-3 text-right font-semibold">avg in/cached/out tok</th>
            <th className="px-3 py-3 text-right font-semibold">err</th>
          </tr>
        </thead>
        <tbody>
          {ranked.map((m, i) => {
            const rate = metric.rate(m);
            const isBestRate = metric.frac(m) !== "—" && rate >= bestRate && bestRate > 0;
            const isBestCost = m.totalCostUsd > 0 && m.totalCostUsd === minCost;
            const isBestLat = m.p50DurationMs > 0 && m.p50DurationMs === minLat;
            return (
              <tr key={m.model} className="border-t border-base-300">
                <td className="px-3 py-2.5 text-center font-mono text-base-content/50">{i + 1}</td>
                <td className="whitespace-nowrap px-3 py-2.5 font-mono font-semibold text-accent">
                  {modelLabel(labels, m.model)}
                </td>
                <td className="w-[22%] min-w-[160px] px-3 py-2.5">
                  <Bar frac={rate} value={metric.frac(m)} color="accent" best={isBestRate} />
                </td>
                {isReview && (
                  <>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono">{fmtRatio(m.micro?.snr, 2)}</td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-base-content/70">
                      {fmtPct(m.micro?.microPrecision)}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-base-content/70">
                      {m.micro ? m.micro.commentsPerPr.toFixed(1) : "—"}
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-base-content/40">
                      {m.reviewTotal ? m.avgFbeta.toFixed(3) : "—"}
                    </td>
                  </>
                )}
                <td className="w-[22%] min-w-[140px] px-3 py-2.5">
                  <Bar frac={maxCost ? m.totalCostUsd / maxCost : 0} value={`$${m.totalCostUsd.toFixed(3)}`} color="info" best={isBestCost} />
                </td>
                <td className="w-[22%] min-w-[140px] px-3 py-2.5">
                  <Bar frac={maxLat ? m.p50DurationMs / maxLat : 0} value={fmtMs(m.p50DurationMs)} color="primary" best={isBestLat} />
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono">
                  {fmtTokens(m.avgInputTokens)}
                  <span className="text-base-content/40">/</span>
                  {fmtTokens(m.avgCachedTokens)}
                  <span className="text-base-content/40">/</span>
                  {fmtTokens(m.avgOutputTokens)}
                </td>
                <td className={`px-3 py-2.5 text-right font-mono ${m.errors ? "text-error" : "text-base-content/50"}`}>
                  {m.errors}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

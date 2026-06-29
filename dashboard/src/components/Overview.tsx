import type { IndexRun, IndexTier, ModelSummary } from "../types";
import { fmtDate, modelLabel, tierMetric } from "../lib/format";
import { useNavigate } from "../lib/router";
import { LiveBadge, RunTypeBadge, Sparkline } from "./ui";

const tierModels = (run: IndexRun, tier: string): ModelSummary[] =>
  run.byTier.find((b) => b.tier === tier)?.models ?? [];

/** History page for one tier-combo: per actual tier, a per-model trend table +
 * a chronological runs table that links into each run's full scorecard. */
export function Overview({ tier }: { tier: IndexTier }) {
  const runs = tier.runs; // newest first
  const labels: Record<string, string> = {};
  for (const r of runs) Object.assign(labels, r.labels);

  // Actual tiers measured across these runs (first-seen, newest run first).
  // Include each run's declared tiers too, so a still-live run with no finished
  // cases yet (empty byTier) still renders its section instead of a blank page.
  const tiers: string[] = [];
  for (const r of runs) {
    for (const b of r.byTier) if (!tiers.includes(b.tier)) tiers.push(b.tier);
    for (const t of r.tiers) if (!tiers.includes(t)) tiers.push(t);
  }

  if (!runs.length) {
    return <p className="py-10 font-mono text-sm text-base-content/50">No runs yet for {tier.key}.</p>;
  }

  return (
    <div>
      {tiers.map((t) => (
        <TierSection key={t} tierKey={tier.key} tier={t} runs={runs} labels={labels} />
      ))}
    </div>
  );
}

function TierSection({
  tierKey,
  tier,
  runs,
  labels,
}: {
  tierKey: string;
  tier: string;
  runs: IndexRun[];
  labels: Record<string, string>;
}) {
  const navigate = useNavigate();
  const metric = tierMetric(tier);
  const chrono = [...runs].reverse(); // oldest → newest for sparklines

  // Model set across all runs (first-seen over chrono). May be empty while a
  // run is still live (no finished cases yet) — we still list the runs below.
  const models: string[] = [];
  for (const r of chrono) for (const m of tierModels(r, tier)) if (!models.includes(m.model)) models.push(m.model);

  const summariesFor = (r: IndexRun) => new Map(tierModels(r, tier).map((m) => [m.model, m]));

  return (
    <section className="mb-10">
      <h2 className="mb-3.5 text-lg font-semibold text-base-content">
        {tier}{" "}
        <span className="font-normal text-base-content/50">
          — {metric.label} over {runs.length} run{runs.length === 1 ? "" : "s"}
        </span>
      </h2>

      {models.length > 0 && (
        <div className="overflow-hidden rounded-xl border border-base-300 bg-base-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-neutral text-2xs uppercase tracking-wide text-base-content/50">
                <th className="px-3 py-3 text-left font-semibold">model</th>
                <th className="px-3 py-3 text-left font-semibold">trend (oldest → newest)</th>
                <th className="px-3 py-3 text-right font-semibold">latest</th>
              </tr>
            </thead>
            <tbody>
              {models.map((model) => {
                const rates = chrono
                  .map((r) => summariesFor(r).get(model))
                  .filter((m): m is ModelSummary => !!m)
                  .map(metric.rate);
                const latest = rates.length ? rates[rates.length - 1] : 0;
                return (
                  <tr key={model} className="border-t border-base-300">
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono font-semibold text-accent">
                      {modelLabel(labels, model)}
                    </td>
                    <td className="px-3 py-2.5">
                      <Sparkline rates={rates} />
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold text-base-content">
                      {rates.length ? `${(latest * 100).toFixed(0)}%` : "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 overflow-x-auto rounded-xl border border-base-300 bg-base-200">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-neutral text-2xs uppercase tracking-wide text-base-content/50">
              <th className="px-3 py-3 text-left font-semibold">run</th>
              <th className="px-3 py-3 text-left font-semibold">git</th>
              {models.map((m) => (
                <th key={m} className="px-3 py-3 text-right font-semibold">
                  {modelLabel(labels, m)}
                </th>
              ))}
              <th className="px-3 py-3 text-right font-semibold">cost</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => {
              const summaries = summariesFor(r);
              const cost = tierModels(r, tier).reduce((s, m) => s + (m.totalCostUsd || 0), 0);
              return (
                <tr
                  key={r.id}
                  onClick={() => navigate(tierKey, r.id)}
                  className="cursor-pointer border-t border-base-300 hover:bg-base-300/40"
                >
                  <td className="px-3 py-2.5 font-mono">
                    <span className="text-info hover:underline">{fmtDate(r.generatedAt)}</span>
                    <RunTypeBadge runType={r.runType} className="ml-2" />
                    <LiveBadge run={r} className="ml-2" />
                  </td>
                  <td className="px-3 py-2.5 font-mono text-base-content/50">{r.gitSha ?? "—"}</td>
                  {models.map((m) => {
                    const s = summaries.get(m);
                    return (
                      <td key={m} className="px-3 py-2.5 text-right font-mono">
                        {s ? metric.frac(s) : <span className="text-base-content/40">—</span>}
                      </td>
                    );
                  })}
                  <td className="px-3 py-2.5 text-right font-mono">${cost.toFixed(3)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

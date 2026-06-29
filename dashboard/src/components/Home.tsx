import type { IndexTier, ModelSummary } from "../types";
import { fmtDate, modelLabel, tierMetric } from "../lib/format";
import { useNavigate } from "../lib/router";
import { LiveBadge, RunTypeBadge } from "./ui";

/** Landing page: every tier as a card + the most recent runs across all tiers.
 * Each tier now lives in its own folder, so this is the place that ties them
 * back together (the per-tier history lives behind each card). */
export function Home({ tiers }: { tiers: IndexTier[] }) {
  const navigate = useNavigate();

  // All runs across every tier, newest first, carrying their tier key.
  const recent = tiers
    .flatMap((t) => t.runs.map((run) => ({ tierKey: t.key, run })))
    .sort((a, b) => (a.run.generatedAt < b.run.generatedAt ? 1 : a.run.generatedAt > b.run.generatedAt ? -1 : 0));

  const labels: Record<string, string> = {};
  for (const t of tiers) for (const r of t.runs) Object.assign(labels, r.labels);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold text-base-content">Overview</h1>
      <p className="mb-6 font-mono text-xs text-base-content/50">
        {tiers.length} tier{tiers.length === 1 ? "" : "s"} · {recent.length} run{recent.length === 1 ? "" : "s"} ·
        click a tier for its history, or a run for its scorecard
      </p>

      <div className="mb-9 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiers.map((t) => {
          const latest = t.runs[0];
          const liveRun = t.runs.find((r) => r.live);
          return (
            <button
              key={t.key}
              onClick={() => navigate(t.key)}
              className="group rounded-xl border border-base-300 bg-base-200 px-4 py-4 text-left hover:border-info"
            >
              <div className="flex items-center gap-2">
                <span className="font-mono text-sm font-semibold text-base-content">{t.key}</span>
                {liveRun && <LiveBadge run={liveRun} />}
                <span className="ml-auto font-mono text-2xs text-base-content/40">
                  {t.runs.length} run{t.runs.length === 1 ? "" : "s"}
                </span>
              </div>
              <div className="mt-2 font-mono text-2xs text-base-content/50">
                {latest ? `latest ${fmtDate(latest.generatedAt)}` : "no runs"}
              </div>
            </button>
          );
        })}
      </div>

      <h2 className="mb-3.5 text-lg font-semibold text-base-content">Recent runs</h2>
      <div className="overflow-x-auto rounded-xl border border-base-300 bg-base-200">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-neutral text-2xs uppercase tracking-wide text-base-content/50">
              <th className="px-3 py-3 text-left font-semibold">run</th>
              <th className="px-3 py-3 text-left font-semibold">tier</th>
              <th className="px-3 py-3 text-left font-semibold">models</th>
              <th className="px-3 py-3 text-left font-semibold">git</th>
              <th className="px-3 py-3 text-right font-semibold">score</th>
              <th className="px-3 py-3 text-right font-semibold">cost</th>
            </tr>
          </thead>
          <tbody>
            {recent.map(({ tierKey, run }) => {
              const all: ModelSummary[] = run.byTier.flatMap((b) => b.models);
              const cost = all.reduce((s, m) => s + (m.totalCostUsd || 0), 0);
              // Best score across this run's tiers (per-tier metric).
              const score = run.byTier
                .map((b) => {
                  const metric = tierMetric(b.tier);
                  const rates = b.models.map(metric.rate);
                  return rates.length ? Math.max(...rates) : null;
                })
                .filter((x): x is number => x !== null);
              const best = score.length ? Math.max(...score) : null;
              const modelNames = [...new Set(all.map((m) => modelLabel(labels, m.model)))];
              return (
                <tr
                  key={`${tierKey}/${run.id}`}
                  onClick={() => navigate(tierKey, run.id)}
                  className="cursor-pointer border-t border-base-300 hover:bg-base-300/40"
                >
                  <td className="whitespace-nowrap px-3 py-2.5 font-mono">
                    <span className="text-info hover:underline">{fmtDate(run.generatedAt)}</span>
                    <RunTypeBadge runType={run.runType} className="ml-2" />
                    <LiveBadge run={run} className="ml-2" />
                  </td>
                  <td className="px-3 py-2.5 font-mono text-base-content/70">{tierKey}</td>
                  <td className="px-3 py-2.5 font-mono text-2xs text-base-content/50">{modelNames.join(", ")}</td>
                  <td className="px-3 py-2.5 font-mono text-base-content/50">{run.gitSha ?? "—"}</td>
                  <td className="px-3 py-2.5 text-right font-mono">
                    {best === null ? <span className="text-base-content/40">—</span> : `${(best * 100).toFixed(0)}%`}
                  </td>
                  <td className="px-3 py-2.5 text-right font-mono">${cost.toFixed(3)}</td>
                </tr>
              );
            })}
            {recent.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center font-mono text-base-content/40">
                  no runs yet
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}

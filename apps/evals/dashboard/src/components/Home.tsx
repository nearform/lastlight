import type { IndexRun, IndexTier, ModelSummary, UnitSurveyEntry } from "../types";
import { fmtDate, modelDisplay, tierMetric } from "../lib/format";
import { mergeRecent } from "../lib/recentRuns";
import { UNIT_SURVEY_TIER_KEY, useNavigate } from "../lib/router";
import { coverageText, entryModelCells, NA, unitSurveyProgress } from "../lib/unitSurvey";
import { LiveBadge, RunTypeBadge } from "./ui";
import { UnitStatusChip, UnitSurveyKindChip } from "./UnitSurvey";

/** Landing page: every tier as a card + the most recent runs across all tiers.
 * Each tier now lives in its own folder, so this is the place that ties them
 * back together (the per-tier history lives behind each card). */
export function Home({ tiers, unitReports = [] }: { tiers: IndexTier[]; unitReports?: UnitSurveyEntry[] }) {
  const navigate = useNavigate();

  // All runs across every tier plus every unit-survey replay report, newest
  // first (`mergeRecent`). A replay links to its own page, not a scorecard.
  const recent = mergeRecent(tiers, unitReports);
  const runCount = recent.filter((r) => r.kind === "run").length;

  const labels: Record<string, string> = {};
  for (const t of tiers) for (const r of t.runs) Object.assign(labels, r.labels);

  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold text-base-content">Overview</h1>
      <p className="mb-6 font-mono text-xs text-base-content/50">
        {tiers.length} tier{tiers.length === 1 ? "" : "s"} · {runCount} run{runCount === 1 ? "" : "s"}
        {unitReports.length > 0 && ` · ${unitReports.length} unit-survey report${unitReports.length === 1 ? "" : "s"}`} ·
        click a tier for its history, or a run for its scorecard
      </p>

      <div className="mb-9 grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {tiers.map((t) => {
          const latest = t.runs[0];
          // Prefer a genuinely-live run for the card badge; otherwise surface an
          // interrupted one so a killed/crashed run is visible, not silent.
          const liveRun = t.runs.find((r) => r.live) ?? t.runs.find((r) => r.interrupted);
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
            <tr className="bg-neutral text-2xs uppercase tracking-wide text-neutral-content/70">
              <th className="px-3 py-3 text-left font-semibold">run</th>
              <th className="px-3 py-3 text-left font-semibold">tier</th>
              <th className="px-3 py-3 text-left font-semibold">arm</th>
              <th className="px-3 py-3 text-left font-semibold">git</th>
              <th className="px-3 py-3 text-right font-semibold">score</th>
              <th className="px-3 py-3 text-right font-semibold">cost</th>
            </tr>
          </thead>
          <tbody>
            {recent.map((item) =>
              item.kind === "unit-survey" ? (
                <UnitSurveyRow
                  key={item.key}
                  entry={item.entry}
                  onOpen={() => navigate(UNIT_SURVEY_TIER_KEY, item.entry.id)}
                />
              ) : (
                <RunRow
                  key={item.key}
                  tierKey={item.tierKey}
                  run={item.run}
                  labels={labels}
                  onOpen={() => navigate(item.tierKey, item.run.id)}
                />
              ),
            )}
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

function RunRow({
  tierKey,
  run,
  labels,
  onOpen,
}: {
  tierKey: string;
  run: IndexRun;
  labels: Record<string, string>;
  onOpen: () => void;
}) {
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
  // Collapse a pinned snapshot id onto its registry label, so one
  // model does not read as two arms (see `modelDisplay`). A `config`
  // run's arms are config names, which have no registry entry.
  const modelNames = [
    ...new Set(
      all.map((m) => (run.runType === "config" ? m.model : modelDisplay(labels, m.model).label)),
    ),
  ];
  const overlay = run.overlay?.replace(/\/+$/, "").split("/").pop();
  return (
    <tr
      onClick={onOpen}
      className="cursor-pointer border-t border-base-300 hover:bg-base-300/40"
    >
      <td className="whitespace-nowrap px-3 py-2.5 font-mono">
        <span className="text-info hover:underline">{fmtDate(run.generatedAt)}</span>
        <RunTypeBadge runType={run.runType} className="ml-2" />
        <LiveBadge run={run} className="ml-2" />
      </td>
      <td className="px-3 py-2.5 font-mono text-base-content/70">{tierKey}</td>
      <td className="px-3 py-2.5 font-mono text-2xs text-base-content/50" title={run.overlay}>
        {overlay && <span className="text-base-content/70">{overlay}</span>}
        {overlay && modelNames.length > 0 && " · "}
        {modelNames.join(", ")}
      </td>
      <td className="px-3 py-2.5 font-mono text-base-content/50">{run.gitSha ?? "—"}</td>
      <td className="px-3 py-2.5 text-right font-mono">
        {best === null ? <span className="text-base-content/40">—</span> : `${(best * 100).toFixed(0)}%`}
      </td>
      <td className="px-3 py-2.5 text-right font-mono">${cost.toFixed(3)}</td>
    </tr>
  );
}

/** A unit-survey replay among the runs: kind chip + status/progress, the label
 * and arms, and the headline — credited gold units vs agent (stage 2) or the
 * $0 gold coverage (stage 1) — labelled partial while the run is unfinished. */
function UnitSurveyRow({ entry, onOpen }: { entry: UnitSurveyEntry; onOpen: () => void }) {
  const p = unitSurveyProgress(entry, Date.now());
  const m = entryModelCells(entry);
  const partial = p.partial ? " (partial)" : "";
  const headline = entry.model ? `${m.unitsRecall} vs ${m.agentRecall}` : `cov ${coverageText(entry.coverage)}`;
  const cost = entry.model ? `${m.unitsCost} vs ${m.agentCost}` : NA;
  return (
    <tr onClick={onOpen} className="cursor-pointer border-t border-base-300 hover:bg-base-300/40">
      <td className="whitespace-nowrap px-3 py-2.5 font-mono">
        <span className="text-info hover:underline">{fmtDate(entry.generatedAt)}</span>
        <UnitSurveyKindChip className="ml-2" />
        <UnitStatusChip entry={entry} className="ml-2" />
        <span className="ml-2 text-2xs text-base-content/40">{p.elapsed}</span>
      </td>
      <td className="px-3 py-2.5 font-mono text-base-content/70">{UNIT_SURVEY_TIER_KEY}</td>
      <td className="px-3 py-2.5 font-mono text-2xs text-base-content/50">
        <span className="text-base-content/70">{entry.label}</span>
        {entry.arms.length > 0 && ` · ${entry.arms.join(", ")}`}
      </td>
      <td className="px-3 py-2.5 font-mono text-base-content/50">—</td>
      <td
        className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-xs"
        title={
          entry.model
            ? `Credited gold — units vs agent${partial}`
            : `Stage 1 ($0): gold lines some unit shows, over locatable gold${partial}`
        }
      >
        {headline}
        {p.partial && <span className="ml-1 text-2xs font-semibold uppercase text-warning">partial</span>}
      </td>
      <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono text-xs" title={`Survey $ — units vs agent${partial}`}>
        {cost}
      </td>
    </tr>
  );
}

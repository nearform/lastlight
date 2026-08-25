import { useState } from "react";
import { ChevronDown, ChevronRight } from "lucide-react";
import clsx from "clsx";

import type { IndexRun, IndexTier } from "../types";
import { fmtDate, fmtPct, modelDisplay, modelKey, tierMetric } from "../lib/format";
import { groupRuns, tierModels, type Arm, type RunGroup, type ScorePoint } from "../lib/runGroups";
import { useNavigate } from "../lib/router";
import { LiveBadge, RunTypeBadge, Sparkline } from "./ui";

/** History page for one tier-combo: per actual tier, a per-arm trend table +
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
  const metric = tierMetric(tier);
  const chrono = [...runs].reverse(); // oldest → newest for sparklines

  // Trend rows are keyed by the model's COLLAPSED identity, not its raw id: a
  // run pinned to `anthropic/claude-haiku-4-5-20251001` and one on the registry
  // id `anthropic/claude-haiku-4-5` are the same model, and keying on the id
  // gave that model two trend lines under two different names.
  const trends = new Map<string, { label: string; ids: Set<string>; rates: number[] }>();
  for (const r of chrono) {
    for (const m of tierModels(r, tier)) {
      const key = r.runType === "config" ? m.model : modelKey(m.model);
      const { label } = r.runType === "config" ? { label: m.model } : modelDisplay(labels, m.model);
      const row = trends.get(key) ?? { label, ids: new Set<string>(), rates: [] };
      row.ids.add(m.model);
      row.rates.push(metric.rate(m));
      trends.set(key, row);
    }
  }

  const groups = groupRuns(runs, tier, labels);

  return (
    <section className="mb-10">
      <h2 className="mb-3.5 text-lg font-semibold text-base-content">
        {tier}{" "}
        <span className="font-normal text-base-content/50">
          — {metric.label} over {runs.length} run{runs.length === 1 ? "" : "s"}
        </span>
      </h2>

      {trends.size > 0 && (
        <div className="overflow-hidden rounded-xl border border-base-300 bg-base-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-neutral text-2xs uppercase tracking-wide text-neutral-content/70">
                <th className="px-3 py-3 text-left font-semibold">model</th>
                <th className="px-3 py-3 text-left font-semibold">trend (oldest → newest)</th>
                <th className="px-3 py-3 text-right font-semibold">latest</th>
              </tr>
            </thead>
            <tbody>
              {[...trends].map(([key, row]) => (
                <tr key={key} className="border-t border-base-300">
                  <td
                    className="whitespace-nowrap px-3 py-2.5 font-mono font-semibold text-accent"
                    title={[...row.ids].join("\n")}
                  >
                    {row.label}
                  </td>
                  <td className="px-3 py-2.5">
                    <Sparkline rates={row.rates} />
                  </td>
                  <td className="px-3 py-2.5 text-right font-semibold text-base-content">
                    {row.rates.length ? fmtPct(row.rates[row.rates.length - 1]) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <div className="mt-4 overflow-x-auto rounded-xl border border-base-300 bg-base-200">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-neutral text-2xs uppercase tracking-wide text-neutral-content/70">
              <th className="px-3 py-3 text-left font-semibold">run</th>
              <th className="px-3 py-3 text-left font-semibold">git</th>
              <th className="px-3 py-3 text-left font-semibold">arm</th>
              <th className="px-3 py-3 text-left font-semibold">score</th>
              <th className="px-3 py-3 text-right font-semibold">cases</th>
              <th className="px-3 py-3 text-right font-semibold">cost</th>
            </tr>
          </thead>
          {groups.map((g) => (
            <GroupRows key={g.key} tierKey={tierKey} group={g} />
          ))}
        </table>
      </div>
    </section>
  );
}

/**
 * One row of the runs table — a repeat band folded into a single line, or an
 * ordinary single run. A band's own row opens the REPEAT view (the band is the
 * result; a single repeat's scorecard is not it) — the individual repeats
 * behind the disclosure are each still a link into their own scorecard.
 *
 * Its own `<tbody>` so the disclosure rows stay attached to their group.
 */
function GroupRows({ tierKey, group }: { tierKey: string; group: RunGroup }) {
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const expandable = group.runs.length > 1;

  return (
    <tbody className="border-t border-base-300">
      <tr
        onClick={() =>
          expandable ? navigate(tierKey, group.anchor.id, "repeats") : navigate(tierKey, group.latest.id)
        }
        className="cursor-pointer hover:bg-base-300/40"
      >
        <td className="whitespace-nowrap px-3 py-2.5 font-mono">
          {expandable ? (
            <button
              onClick={(e) => {
                e.stopPropagation();
                setOpen((v) => !v);
              }}
              aria-label={open ? "Collapse repeats" : "Expand repeats"}
              className="mr-1 inline-flex align-middle text-base-content/40 hover:text-base-content"
            >
              {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
            </button>
          ) : (
            <span className="mr-1 inline-block w-[13px] align-middle" />
          )}
          <span className="text-info hover:underline">{fmtDate(group.latest.generatedAt)}</span>
          <RunTypeBadge runType={group.latest.runType} className="ml-2" />
          {group.runs.length > 1 && (
            <span
              title={`A repeat band: ${group.runs.length} runs of one arm, read as a band rather than a point.`}
              className="ml-2 inline-block whitespace-nowrap rounded-full bg-accent/15 px-2 py-0.5 text-2xs font-semibold text-accent"
            >
              ×{group.runs.length}
              {group.of && group.of !== group.runs.length ? ` of ${group.of}` : ""}
            </span>
          )}
          <LiveBadge run={{ live: group.live, interrupted: group.interrupted, ...liveCounts(group) }} className="ml-2" />
        </td>
        <td className="px-3 py-2.5 font-mono text-base-content/50" title={group.gitShas.join("\n")}>
          {group.gitShas.length ? group.gitShas.join(" · ") : "—"}
        </td>
        <td className="px-3 py-2.5">
          <ArmCell arm={group.arm} />
        </td>
        <td className="px-3 py-2.5">
          <ScoreCell group={group} />
        </td>
        <td className="px-3 py-2.5 text-right font-mono text-base-content/70">{group.cases || "—"}</td>
        <td className="px-3 py-2.5 text-right font-mono">${group.cost.toFixed(3)}</td>
      </tr>

      {open &&
        group.runs.map((run, i) => (
          <tr
            key={run.id}
            onClick={() => navigate(tierKey, run.id)}
            className="cursor-pointer bg-base-100/40 hover:bg-base-300/40"
          >
            <td className="whitespace-nowrap py-1.5 pl-9 pr-3 font-mono text-2xs">
              <span className="mr-2 text-base-content/40">#{run.repeat?.index ?? i + 1}</span>
              <span className="text-info hover:underline">{fmtDate(run.generatedAt)}</span>
              <LiveBadge run={run} className="ml-2" />
            </td>
            <td className="px-3 py-1.5 font-mono text-2xs text-base-content/50">{run.gitSha ?? "—"}</td>
            <td className="px-3 py-1.5 font-mono text-2xs text-base-content/40">{run.runId}</td>
            <td className="px-3 py-1.5">
              <div className="flex flex-wrap gap-1">
                {group.points
                  .filter((p) => p.runId === run.id)
                  .map((p, j) => (
                    <ScoreChip key={j} point={p} bare />
                  ))}
              </div>
            </td>
            <td />
            <td />
          </tr>
        ))}

      {open && group.banded && (
        <tr className="bg-base-100/40">
          <td colSpan={6} className="py-1.5 pl-9 pr-3">
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigate(tierKey, group.anchor.id, "repeats");
              }}
              className="font-mono text-2xs text-info hover:underline"
            >
              open the repeat view → per-gold hit matrix, union &amp; intersection recall
            </button>
          </td>
        </tr>
      )}
    </tbody>
  );
}

/** Live counts for the group badge — summed across its repeats, since a band's
 * repeats can be in flight simultaneously (`--repeat-concurrency`). */
function liveCounts(group: RunGroup): { running: number; queued: number; progress?: string } {
  const running = group.runs.reduce((n, r) => n + (r.running ?? 0), 0);
  const queued = group.runs.reduce((n, r) => n + (r.queued ?? 0), 0);
  const progress = group.runs.find((r) => r.live && r.progress)?.progress;
  return { running, queued, progress };
}

/** Overlay + model — what the run actually measured, in one cell. A missing
 * overlay reads "—" (not recorded), never "none". */
function ArmCell({ arm }: { arm: Arm }) {
  return (
    <div className="flex flex-col gap-0.5 font-mono text-2xs leading-4">
      <span className="text-base-content/80" title={arm.overlayPath}>
        {arm.overlay ?? <span className="text-base-content/30">—</span>}
      </span>
      <span className="text-base-content/50">
        {arm.models.length === 0 ? (
          "—"
        ) : arm.models.length <= 2 ? (
          arm.models.map((m, i) => (
            <span key={i} title={m.title}>
              {i > 0 && ", "}
              {m.label}
            </span>
          ))
        ) : (
          <span title={arm.models.map((m) => m.title).join("\n")}>{arm.models.length} models</span>
        )}
      </span>
    </div>
  );
}

/**
 * The score cell: one chip per landed repeat (or per arm on a multi-arm run),
 * plus the band once every repeat has landed.
 *
 * While a band is in flight the landed repeats' chips are shown beside a
 * `n of m` spinner, so a partial band never masquerades as a finished one — and
 * the mean is deliberately withheld until it is complete, because the mean of
 * the repeats that happen to have finished first is not the band's mean.
 */
function ScoreCell({ group }: { group: RunGroup }) {
  if (!group.points.length && !group.outstanding) {
    return <span className="font-mono text-2xs text-base-content/30">—</span>;
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      {group.points.map((p, i) => (
        <ScoreChip key={i} point={p} />
      ))}
      {group.outstanding > 0 && (
        <span
          className="inline-flex items-center gap-1 font-mono text-2xs text-base-content/50"
          title={`${group.runs.length} of ${group.of} repeats have landed.`}
        >
          <span className="loading loading-spinner loading-xs opacity-60" />
          {group.runs.length} of {group.of}
        </span>
      )}
      {group.mean !== null && (
        <span
          className="ml-1 whitespace-nowrap font-mono text-2xs font-semibold text-base-content"
          title={
            `mean ${group.mean.toFixed(3)} · band ${group.band?.toFixed(3)} ` +
            `(${group.min?.toFixed(3)}–${group.max?.toFixed(3)}) over ${group.points.length} repeats.\n` +
            `band = max − min, the harness's own definition; ± is half of it. ` +
            `A delta smaller than the band is not a result.`
          }
        >
          μ {fmtPct(group.mean)} ±{fmtPct((group.band ?? 0) / 2)}
        </span>
      )}
    </div>
  );
}

/** One score point. `bare` drops the pill styling for the expanded sub-rows,
 * where the repeat index is already in the first column. */
function ScoreChip({ point, bare = false }: { point: ScorePoint; bare?: boolean }) {
  const body = (
    <>
      {point.label && !bare && <span className="mr-1 text-base-content/40">{point.label}</span>}
      <span className={point.rate === null ? "text-base-content/40" : ""}>{point.text}</span>
    </>
  );
  if (bare) return <span className="font-mono text-2xs text-base-content/70">{body}</span>;
  return (
    <span
      title={`${point.label ? `${point.label} — ` : ""}${fmtDate(point.generatedAt)}${point.gitSha ? ` · ${point.gitSha}` : ""}`}
      className={clsx(
        "inline-block whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-2xs",
        point.live ? "border-accent/40 text-accent" : "border-base-300 text-base-content/80",
      )}
    >
      {body}
    </span>
  );
}

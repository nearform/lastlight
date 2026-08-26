import { useMemo, useState } from "react";

import { DETECTION_FLOOR_MICRO_RECALL } from "../../../src/review-metrics.js";
import type { IndexRun, Scorecard } from "../types";
import { useScorecards } from "../lib/api";
import { fmtDate, fmtPct, fmtRatio, modelLabel } from "../lib/format";
import { buildRepeatBand, inRepeatGroup, repeatCandidates } from "../lib/repeats";

/**
 * N runs of one arm, read as a band instead of a point.
 *
 * The reason this view exists: three identical runs of one arm scored 0.320 /
 * 0.080 / 0.200 micro-recall. Reported as any one of those numbers it looks like
 * a result; reported as a band with its union and intersection it is visibly a
 * draw. The **hit matrix** is the payload — gold findings down, repeats across —
 * because it is the only rendering in which "found once, never twice" is legible
 * at a glance, and on the preserved data exactly one gold finding in twenty-five
 * was found by every repeat.
 *
 * Every repeat is already fully preserved on disk with its judge traces, so this
 * needs no harness change and no re-run.
 */
export function RepeatView({
  tierKey,
  anchor,
  runs,
  labels,
  onOpenRun,
}: {
  tierKey: string;
  anchor: IndexRun;
  runs: IndexRun[];
  labels: Record<string, string>;
  onOpenRun: (runId: string) => void;
}) {
  // The tier whose repeats we're reading. A run usually measures one; prefer the
  // first that actually graded reviews, since that is what a band is about.
  const tier =
    anchor.byTier.find((b) => b.models.some((m) => m.reviewTotal > 0))?.tier ??
    anchor.byTier[0]?.tier ??
    anchor.tiers[0] ??
    tierKey;

  const candidates = useMemo(() => repeatCandidates(runs, anchor, tier), [runs, anchor, tier]);
  const queries = useScorecards(candidates.map((r) => r.scorecard));
  const loading = queries.some((q) => q.isLoading);

  // Refine candidates → the actual group, once the scorecards are in.
  const anchorCard = queries[candidates.findIndex((c) => c.id === anchor.id)]?.data as Scorecard | undefined;
  const loaded = candidates
    .map((run, i) => ({ run, card: queries[i].data as Scorecard | undefined }))
    .filter((x): x is { run: IndexRun; card: Scorecard } => !!x.card);
  const group = anchorCard
    ? loaded.filter((x) => x.run.id === anchor.id || inRepeatGroup(anchorCard, x.card, tier))
    : [];

  // Oldest → newest: a repeat group reads chronologically.
  const ordered = [...group].sort((a, b) => (a.run.generatedAt < b.run.generatedAt ? -1 : 1));

  const [excluded, setExcluded] = useState<Set<string>>(new Set());
  const selected = ordered.filter((x) => !excluded.has(x.run.id));
  const toggle = (id: string) =>
    setExcluded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const band = useMemo(
    () => buildRepeatBand(selected.map((x) => ({ id: x.run.id, run: x.run, card: x.card })), tier),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [selected.map((x) => x.run.id).join(","), tier],
  );

  const arm = anchor.byTier.find((b) => b.tier === tier)?.models[0]?.model ?? anchor.tiers[0] ?? "—";
  const shas = [...new Set(band.columns.map((c) => c.gitSha).filter(Boolean))];

  return (
    <div>
      <header className="mb-6 border-b border-base-300 pb-5">
        <h1 className="text-2xl font-semibold text-base-content">
          Repeat group <span className="font-normal text-base-content/50">— {tier}</span>
        </h1>
        <div className="mt-1.5 font-mono text-xs text-base-content/50">
          arm <b className="font-semibold text-base-content">{modelLabel(labels, arm)}</b> &nbsp;·&nbsp;{" "}
          {band.columns.length} repeat{band.columns.length === 1 ? "" : "s"} &nbsp;·&nbsp; anchored on{" "}
          <span className="text-base-content/70">{anchor.runId}</span>
        </div>
        <p className="mt-3 max-w-3xl text-2xs leading-5 text-base-content/50">
          Repeats of one arm are grouped by{" "}
          {anchorCard?.meta?.repeat?.group ? (
            <>
              their stamped <span className="font-mono text-base-content/70">meta.repeat.group</span>
            </>
          ) : (
            <>
              arm + tier + identical graded case set. <b className="font-semibold text-base-content/70">Not</b> by git
              SHA — the preserved three-run group spans two SHAs, so keying on it would split the group and hide the
              variance. Each column shows its own SHA
              {shas.length > 1 ? " and they differ here — read the band accordingly." : "."}
            </>
          )}
        </p>
      </header>

      {loading && !band.columns.length ? (
        <div className="py-16 text-center font-mono text-sm text-base-content/40">loading repeats…</div>
      ) : !band.columns.length ? (
        <div className="rounded-xl border border-base-300 bg-base-200 px-5 py-10 text-center font-mono text-sm text-base-content/50">
          No sibling runs of this arm over the same case set.
        </div>
      ) : (
        <>
          <BandSummary band={band} />
          <ColumnPicker
            ordered={ordered}
            excluded={excluded}
            toggle={toggle}
            onOpenRun={onOpenRun}
            loading={loading}
          />
          <HitMatrix band={band} />
        </>
      )}
    </div>
  );
}

function BandSummary({ band }: { band: ReturnType<typeof buildRepeatBand> }) {
  const spread =
    band.minRecall !== null && band.maxRecall !== null ? band.maxRecall - band.minRecall : null;
  // Only claim "identical runs" when the columns really are the same code. The
  // heuristic group is arm + case set, which can span commits.
  const shas = new Set(band.columns.map((c) => c.gitSha ?? "—"));
  return (
    <div className="rounded-xl border border-base-300 bg-base-200 px-4 py-4">
      <div className="flex flex-wrap items-end gap-x-10 gap-y-4">
        <div>
          <div className="font-mono text-2xs uppercase tracking-wide text-base-content/40">
            micro-recall — mean (min–max)
          </div>
          <div className="font-mono text-3xl font-bold tabular-nums text-base-content">
            {fmtRatio(band.meanRecall)}
            <span className="ml-2 align-middle font-mono text-base font-normal text-base-content/50">
              ({fmtRatio(band.minRecall)}–{fmtRatio(band.maxRecall)})
            </span>
          </div>
          {spread !== null && spread > 0 && (
            <div className="mt-1 font-mono text-2xs text-warning">
              spread {fmtRatio(spread)} across{" "}
              {shas.size > 1 ? (
                <>
                  {band.columns.length} runs spanning {shas.size} commits — deselect columns to compare like with like
                </>
              ) : (
                <>identical runs — a single run is a draw, not a number</>
              )}
            </div>
          )}
        </div>
        <div>
          <div className="font-mono text-2xs uppercase tracking-wide text-base-content/40">
            union — found by any repeat
          </div>
          <div className="font-mono text-3xl font-bold tabular-nums text-success">
            {fmtRatio(band.unionRecall)}
            <span className="ml-2 align-middle font-mono text-base font-normal text-base-content/50">
              {band.unionMatched}/{band.totalGold}
            </span>
          </div>
        </div>
        <div>
          <div className="font-mono text-2xs uppercase tracking-wide text-base-content/40">
            intersection — found by every repeat
          </div>
          <div className="font-mono text-3xl font-bold tabular-nums text-error">
            {fmtRatio(band.intersectionRecall)}
            <span className="ml-2 align-middle font-mono text-base font-normal text-base-content/50">
              {band.intersectionMatched}/{band.totalGold}
            </span>
          </div>
        </div>
        <div>
          <div className="font-mono text-2xs uppercase tracking-wide text-base-content/40">found exactly once</div>
          <div className="font-mono text-3xl font-bold tabular-nums text-base-content/70">{band.onceOnly}</div>
        </div>
      </div>
      <p className="mt-4 max-w-3xl text-2xs leading-5 text-base-content/50">
        Union far above the mean and an intersection near zero means discovery is close to <b>disjoint</b> across
        repeats: the arm is capable of finding much more than any one run does, and which findings surface is largely
        chance. A mean below the ≈{fmtPct(DETECTION_FLOOR_MICRO_RECALL)} detection floor cannot be distinguished from
        another arm's by one or two findings — gate on mechanism metrics, report this.
      </p>
    </div>
  );
}

function ColumnPicker({
  ordered,
  excluded,
  toggle,
  onOpenRun,
  loading,
}: {
  ordered: { run: IndexRun; card: Scorecard }[];
  excluded: Set<string>;
  toggle: (id: string) => void;
  onOpenRun: (runId: string) => void;
  loading: boolean;
}) {
  return (
    <div className="mt-5">
      <h3 className="mb-2 font-mono text-xs font-semibold uppercase tracking-wide text-base-content/50">
        repeats {loading && <span className="ml-2 font-normal text-base-content/30">loading…</span>}
      </h3>
      <div className="flex flex-wrap gap-2">
        {ordered.map((x, i) => {
          const on = !excluded.has(x.run.id);
          return (
            <div
              key={x.run.id}
              className={
                "flex items-center gap-2 rounded-lg border px-3 py-1.5 font-mono text-2xs " +
                (on ? "border-accent/50 bg-accent/10 text-base-content" : "border-base-300 bg-base-200 text-base-content/40")
              }
            >
              <button onClick={() => toggle(x.run.id)} title={on ? "Exclude from the band" : "Include in the band"}>
                {on ? "☑" : "☐"} R{i + 1}
              </button>
              <button className="text-info hover:underline" onClick={() => onOpenRun(x.run.id)}>
                {fmtDate(x.run.generatedAt)}
              </button>
              <span className="text-base-content/40">{x.card.meta?.gitSha ?? x.run.gitSha ?? "—"}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The per-gold hit matrix: gold findings down, repeats across.
 *
 * `undefined` renders as `?` (that repeat produced no judge trace for the case)
 * and is deliberately distinct from a miss — an unmeasured cell and a measured
 * miss are different facts, and collapsing them would inflate the apparent
 * agreement between repeats.
 */
/** Repeats where this gold was actually judged — `undefined` cells excluded. */
function measuredOf(r: { hits: readonly (boolean | undefined)[] }): number {
  return r.hits.filter((h) => h !== undefined).length;
}

function HitMatrix({ band }: { band: ReturnType<typeof buildRepeatBand> }) {
  // Sort so the reproducible findings sit at the top and the never-found at the
  // bottom; within a tier, keep dataset order (grouped by case).
  const rows = [...band.rows].sort(
    (a, b) => b.hitCount - a.hitCount || a.instanceId.localeCompare(b.instanceId) || a.goldIndex - b.goldIndex,
  );

  return (
    <div className="mt-8">
      <h3 className="mb-1 text-lg font-semibold text-base-content">Per-gold hit matrix</h3>
      <p className="mb-3 max-w-3xl text-2xs leading-5 text-base-content/50">
        One row per gold finding, one column per repeat. Gold order is fixed by the dataset, so the columns are
        index-comparable — the same property the harness's paired McNemar relies on. Sorted by how many repeats found
        it: everything at the bottom was never found, and anything with a single tick was a coin flip.
      </p>
      <div className="overflow-x-auto rounded-xl border border-base-300 bg-base-200">
        <table className="w-full border-collapse text-sm">
          <thead>
            <tr className="bg-neutral text-2xs uppercase tracking-wide text-neutral-content/70">
              <th className="px-3 py-3 text-left font-semibold">case</th>
              <th className="px-3 py-3 text-left font-semibold">gold finding</th>
              <th className="px-3 py-3 text-center font-semibold">sev</th>
              {band.columns.map((c, i) => (
                <th key={c.id} className="w-10 px-2 py-3 text-center font-semibold" title={`${c.runId} · ${c.gitSha ?? "—"}`}>
                  R{i + 1}
                </th>
              ))}
              <th className="px-3 py-3 text-center font-semibold">n</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={`${r.instanceId}#${r.goldIndex}`} className="border-t border-base-300">
                <td className="whitespace-nowrap px-3 py-2 font-mono text-2xs text-base-content/50">
                  {r.instanceId.replace(/^prreview__/, "")}
                </td>
                <td className="max-w-xl px-3 py-2 text-xs text-base-content/80" title={r.description}>
                  <span className="line-clamp-2">{r.description}</span>
                </td>
                <td className="px-3 py-2 text-center font-mono text-2xs text-base-content/40">{r.severity || "—"}</td>
                {r.hits.map((h, i) => (
                  <td key={band.columns[i].id} className="px-2 py-2 text-center font-mono text-sm">
                    {h === undefined ? (
                      <span className="text-base-content/30" title="no judge trace for this case in this repeat">
                        ?
                      </span>
                    ) : h ? (
                      <span className="font-bold text-success">●</span>
                    ) : (
                      <span className="text-base-content/20">·</span>
                    )}
                  </td>
                ))}
                {/* The denominator is MEASURED repeats only — a repeat with no
                    judge trace is unknown, not a miss, and counting it would
                    read a judge flake (or an in-flight repeat) as "missed". */}
                <td
                  className={
                    "px-3 py-2 text-center font-mono text-2xs tabular-nums " +
                    (measuredOf(r) === 0
                      ? "text-base-content/40"
                      : r.hitCount === 0
                        ? "text-error/70"
                        : r.hitCount === measuredOf(r)
                          ? "font-bold text-success"
                          : "text-warning")
                  }
                  title={
                    measuredOf(r) < r.hits.length
                      ? `${r.hits.length - measuredOf(r)} repeat(s) unmeasured (no judge trace) — excluded from the denominator`
                      : undefined
                  }
                >
                  {measuredOf(r) === 0 ? "—" : `${r.hitCount}/${measuredOf(r)}`}
                  {measuredOf(r) < r.hits.length ? <span className="text-base-content/40"> +?</span> : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-2 flex flex-wrap gap-4 font-mono text-2xs text-base-content/40">
        <span>
          <span className="font-bold text-success">●</span> found
        </span>
        <span>
          <span className="text-base-content/20">·</span> missed
        </span>
        <span>? not measured (no trace)</span>
        <span className="ml-auto">
          per-repeat micro-recall:{" "}
          {band.columns.map((c, i) => (
            <span key={c.id} className="ml-2 text-base-content/60">
              R{i + 1} {fmtRatio(c.microRecall)}
            </span>
          ))}
        </span>
      </div>
    </div>
  );
}

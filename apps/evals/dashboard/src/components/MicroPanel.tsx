import { useState } from "react";

import { DETECTION_FLOOR_MICRO_RECALL } from "../../../src/review-metrics.js";
import type { InstanceResult, ModelSummary } from "../types";
import { fmtPct, fmtRatio, modelLabel } from "../lib/format";
import { FamilyDrilldownModal, type DrilldownCase } from "./FamilyDrilldown";

/**
 * The recall-first instrument, rendered.
 *
 * Micro-recall (matched ÷ gold, summed over cases) and SNR are what the evidence
 * pipeline is steered on; the per-case F-beta mean beside them is what the
 * Martian leaderboard comparison needs. Both are shown, and the detection floor
 * is stated inline — on a 25-finding gold set a one-finding difference is a coin
 * flip, and a reader who does not know that will read noise as progress.
 *
 * `boundaries` and `families` render only for an arm that emitted an evidence
 * packet. Their absence is a clean degrade (the posted numbers above are still
 * complete), never a row of zeros.
 *
 * A funnel row is a **button** when the arm's cases recorded a
 * `pipelineArtifactRel` — the run then still holds the obligations, hypotheses
 * and findings the counts were computed from, and {@link FamilyDrilldownModal}
 * shows them. When it did not (every run before the artifacts became durable),
 * the row stays inert and says so: the counts are real, the evidence behind
 * them was written to a temp dir the OS reclaimed.
 */
export function MicroPanel({
  models,
  labels,
  results = [],
  scorecardUrl,
}: {
  models: ModelSummary[];
  labels: Record<string, string>;
  /** This tier's results — the source of each case's `pipelineArtifactRel`. */
  results?: InstanceResult[];
  /** This run's `scorecard.json` URL; artifact paths resolve relative to it. */
  scorecardUrl?: string;
}) {
  const withMicro = models.filter((m) => m.micro);
  const [open, setOpen] = useState<{ family: string; arm: string; cases: DrilldownCase[] } | null>(null);
  // `pipelineArtifactRel` is relative to the run dir, deliberately, so the run
  // stays portable — resolve it the same way session logs are resolved.
  const artifactUrl = (rel: string) => (scorecardUrl ? scorecardUrl.replace(/scorecard\.json$/, rel) : rel);
  const casesOf = (model: string): DrilldownCase[] =>
    results
      .filter((r) => r.model === model)
      .map((r) => ({
        instanceId: r.instance_id,
        ...(r.pipelineArtifactRel ? { base: artifactUrl(r.pipelineArtifactRel) } : {}),
      }));
  if (!withMicro.length) return null;

  return (
    <div className="mt-5">
      <h3 className="mb-1 text-lg font-semibold text-base-content">Recall, micro-aggregated</h3>
      <p className="mb-3 max-w-3xl text-2xs leading-5 text-base-content/50">
        Counts summed across cases, then divided — not the mean of per-case ratios. The mean weights a 1-gold case
        like a 6-gold one and hands a free 1.00 to a case with no gold at all.{" "}
        <b className="font-semibold text-base-content/70">SNR</b> (matched ÷ noise) is the guardrail that replaces
        precision when the pipeline is deliberately tuned to over-produce.
      </p>
      <div className="flex flex-col gap-3">
        {withMicro.map((m) => {
          const micro = m.micro!;
          const belowFloor = micro.microRecall !== null && micro.microRecall < DETECTION_FLOOR_MICRO_RECALL;
          return (
            <div key={m.model} className="rounded-xl border border-base-300 bg-base-200 px-4 py-3">
              <div className="mb-3 flex flex-wrap items-baseline gap-x-3 gap-y-1">
                <span className="font-mono text-xs font-semibold text-accent">{modelLabel(labels, m.model)}</span>
                <span className="font-mono text-2xl font-bold tabular-nums text-base-content">
                  {fmtRatio(micro.microRecall)}
                </span>
                <span className="font-mono text-2xs text-base-content/50">
                  micro-recall · {micro.matched}/{micro.gold} gold over {micro.cases} case
                  {micro.cases === 1 ? "" : "s"}
                </span>
                {belowFloor && (
                  <span
                    className="rounded-full bg-warning/15 px-2 py-0.5 font-mono text-2xs font-semibold text-warning"
                    title={`Below the ≈${DETECTION_FLOOR_MICRO_RECALL} detection floor for a 25-finding gold set: a one- or two-finding difference from another run is not distinguishable from chance (McNemar p ≥ 0.25). Gate on mechanism metrics, report this.`}
                  >
                    below detection floor ({DETECTION_FLOOR_MICRO_RECALL})
                  </span>
                )}
              </div>

              <div className="flex flex-wrap gap-x-6 gap-y-2">
                <Stat label="posted" value={String(micro.posted)} />
                <Stat label="matched" value={String(micro.matched)} />
                <Stat label="gold" value={String(micro.gold)} />
                <Stat label="µ-precision" value={fmtRatio(micro.microPrecision)} />
                <Stat label="µ-F1" value={fmtRatio(micro.microF1)} />
                <Stat label="snr" value={fmtRatio(micro.snr, 2)} hint="matched ÷ (posted − matched)" />
                <Stat label="comments/PR" value={micro.commentsPerPr.toFixed(1)} hint="the attention bill" />
                <Stat
                  label="F-beta mean"
                  value={m.reviewTotal ? m.avgFbeta.toFixed(3) : "—"}
                  hint="secondary — the mean of per-case F-beta (leaderboard metric)"
                  dim
                />
              </div>

              {micro.emptyGoldCases.length > 0 && (
                <p className="mt-2.5 font-mono text-2xs text-base-content/40">
                  precision canary — no gold at all:{" "}
                  <span className="text-base-content/60">{micro.emptyGoldCases.join(", ")}</span>
                </p>
              )}

              {m.boundaries && (
                <div className="mt-3 border-t border-base-300 pt-2.5">
                  <div className="mb-1.5 font-mono text-2xs uppercase tracking-wide text-base-content/40">
                    attention boundaries
                  </div>
                  <div className="flex flex-wrap gap-x-6 gap-y-2">
                    <Stat
                      label="internal recall"
                      value={fmtRatio(m.boundaries.internalRecall)}
                      hint="gold matched by anything generated, posted or not"
                    />
                    <Stat label="internal (unposted)" value={String(m.boundaries.internalCount)} />
                    <Stat label="inline posted" value={String(m.boundaries.inlinePosted)} />
                    <Stat label="inline precision" value={fmtRatio(m.boundaries.inlinePrecision)} />
                    <Stat label="inline/PR" value={m.boundaries.inlinePerPr.toFixed(1)} />
                    <Stat label="body posted" value={String(m.boundaries.bodyPosted)} />
                  </div>
                </div>
              )}

              {m.families && m.families.length > 0 && (
                <FamilyFunnelTable
                  families={m.families}
                  arm={modelLabel(labels, m.model)}
                  cases={casesOf(m.model)}
                  onOpen={(family, arm, cases) => setOpen({ family, arm, cases })}
                />
              )}
            </div>
          );
        })}
      </div>
      <p className="mt-2 max-w-3xl font-mono text-2xs leading-5 text-base-content/40">
        Detection floor ≈ {fmtPct(DETECTION_FLOOR_MICRO_RECALL)} micro-recall on this gold set: below it, a difference
        of one or two findings between runs is indistinguishable from chance. Gate on mechanism metrics; report this.
      </p>
      {open && (
        <FamilyDrilldownModal
          family={open.family}
          arm={open.arm}
          cases={open.cases}
          onClose={() => setOpen(null)}
        />
      )}
    </div>
  );
}

/**
 * The funnel, with each row a door into the evidence behind it.
 *
 * Pooled, exactly like the counts: one row sums every case in the arm, so the
 * drill-down pools too and names the case beside every obligation, hypothesis
 * and finding it shows.
 */
function FamilyFunnelTable({
  families,
  arm,
  cases,
  onOpen,
}: {
  families: NonNullable<ModelSummary["families"]>;
  arm: string;
  cases: DrilldownCase[];
  onOpen: (family: string, arm: string, cases: DrilldownCase[]) => void;
}) {
  const retained = cases.filter((c) => c.base).length;
  return (
    <div className="mt-3 border-t border-base-300 pt-2.5">
      <div className="mb-1.5 flex flex-wrap items-baseline gap-2 font-mono text-2xs uppercase tracking-wide text-base-content/40">
        per-family funnel
        {retained > 0 ? (
          <span className="normal-case tracking-normal text-base-content/30">
            click a row — obligations, hypotheses and what became of them ({retained} of {cases.length}{" "}
            case{cases.length === 1 ? "" : "s"} retained artifacts)
          </span>
        ) : (
          <span
            className="normal-case tracking-normal text-base-content/30"
            title="No case in this arm recorded a pipelineArtifactRel. Runs before the artifacts became durable wrote them into a temp workspace the OS reclaims; the counts below were read while it existed and stand."
          >
            artifacts not retained for this run — counts only
          </span>
        )}
      </div>
      <table className="w-full max-w-xl border-collapse font-mono text-2xs">
        <thead>
          <tr className="text-base-content/40">
            <th className="py-1 text-left font-normal">family</th>
            <th className="py-1 text-right font-normal">obligations</th>
            <th className="py-1 text-right font-normal">hypotheses</th>
            <th className="py-1 text-right font-normal">posted</th>
            <th className="py-1 text-right font-normal">matched</th>
          </tr>
        </thead>
        <tbody>
          {families.map((f) => (
            <tr
              key={f.family}
              onClick={retained ? () => onOpen(f.family, arm, cases) : undefined}
              onKeyDown={
                retained
                  ? (e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        onOpen(f.family, arm, cases);
                      }
                    }
                  : undefined
              }
              {...(retained ? { role: "button" as const, tabIndex: 0 } : {})}
              title={
                retained
                  ? `Open the obligations, hypotheses and findings behind ${f.family}`
                  : "Artifacts not retained for this run — the evidence behind these counts was not kept"
              }
              className={
                "border-t border-base-300/60 " +
                (retained ? "cursor-pointer hover:bg-base-300/40" : "cursor-default")
              }
            >
              <td className="py-1 text-base-content/70">
                {retained && <span className="mr-1 text-base-content/30" aria-hidden>›</span>}
                {f.family}
                {f.notMeasured && (
                  <span
                    className="ml-1.5 rounded bg-base-300 px-1 text-base-content/50"
                    title="The analyser for this family was absent on the measuring host. Not measured is a different fact from did not convert."
                  >
                    not measured
                  </span>
                )}
              </td>
              <td className="py-1 text-right tabular-nums text-base-content/60">{f.obligations}</td>
              <td className="py-1 text-right tabular-nums text-base-content/60">{f.hypotheses}</td>
              <td className="py-1 text-right tabular-nums text-base-content/60">{f.posted}</td>
              <td className="py-1 text-right tabular-nums text-base-content">{f.matched}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Stat({ label, value, hint, dim }: { label: string; value: string; hint?: string; dim?: boolean }) {
  return (
    <div title={hint} className="min-w-[5.5rem]">
      <div className="font-mono text-2xs uppercase tracking-wide text-base-content/40">{label}</div>
      <div className={"font-mono text-sm tabular-nums " + (dim ? "text-base-content/50" : "text-base-content")}>
        {value}
      </div>
    </div>
  );
}

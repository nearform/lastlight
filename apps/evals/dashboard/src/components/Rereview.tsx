import { useEffect } from "react";

import { summarizeRereview } from "../../../src/rereview.js";
import type { InstanceResult, RereviewResult, RereviewRound } from "../types";
import { fmtDuration, modelLabel } from "../lib/format";

/** `n/of`, or an em dash when the round was not measured. */
function frac(n: number | null | undefined, of: number | null | undefined): string {
  if (n === null || n === undefined) return "—";
  return of !== null && of !== undefined ? `${n}/${of}` : String(n);
}

const short = (sha: string) => sha.slice(0, 8);

/**
 * Multi-round re-review cases (issue #429), per arm: how many later-round
 * comments were LATE discoveries (posted on lines unchanged since the previous
 * round's head), what the pipeline withheld as converged / already raised,
 * and the gold every round together found. Renders nothing for a tier with no
 * chained case, so a single-round run looks exactly as before.
 */
export function RereviewPanel({ results, labels }: { results: InstanceResult[]; labels: Record<string, string> }) {
  const arms = summarizeRereview(results);
  if (!arms.length) return null;
  return (
    <div className="mt-6 overflow-x-auto rounded-xl border border-base-300 bg-base-200">
      <div className="border-b border-base-300 px-4 py-2.5">
        <h3 className="text-sm font-semibold text-base-content">Re-review rounds</h3>
        <p className="mt-0.5 text-2xs text-base-content/50">
          Chained cases only. <b className="font-semibold text-base-content/70">Late</b> = a round ≥ 2 inline comment whose anchored lines were
          all already there at the previous round's head (code-facts' <code>anchorDelta</code>) — a point the last review could have raised.
          Converged / already raised = findings the pipeline withheld for those reasons. Cumulative gold = gold matched by ANY round's posted
          review, each credited once.
        </p>
      </div>
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="text-2xs uppercase tracking-wide text-base-content/50">
            <th className="px-3 py-2 text-left font-semibold">arm</th>
            <th className="px-3 py-2 text-right font-semibold">cases · rounds</th>
            <th className="px-3 py-2 text-right font-semibold">late / later comments</th>
            <th className="px-3 py-2 text-right font-semibold">converged</th>
            <th className="px-3 py-2 text-right font-semibold">already raised</th>
            <th className="px-3 py-2 text-right font-semibold">cumulative gold</th>
            <th className="px-3 py-2 text-right font-semibold">cost (all rounds)</th>
          </tr>
        </thead>
        <tbody>
          {arms.map((a) => (
            <tr key={a.model} className="border-t border-base-300">
              <td className="px-3 py-2 font-mono text-xs">{modelLabel(labels, a.model)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs">
                {a.cases} · {a.rounds}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs" title={`${a.laterInlinePosted} inline comment(s) posted by rounds ≥ 2`}>
                {frac(a.lateDiscovery, a.lateDiscoveryOf)}
              </td>
              <td className="px-3 py-2 text-right font-mono text-xs">{frac(a.converged, null)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs">{frac(a.alreadyRaised, null)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs">{frac(a.cumulativeMatched, a.gold)}</td>
              <td className="px-3 py-2 text-right font-mono text-xs">${a.costUsd.toFixed(4)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** The compact per-case summary beside a chained case's grade. */
export function rereviewChip(rr: RereviewResult): string {
  const late = rr.lateDiscovery !== undefined ? ` · late ${rr.lateDiscovery}/${rr.lateDiscoveryOf ?? 0}` : "";
  const gold = rr.cumulativeMatched !== undefined ? ` · Σgold ${rr.cumulativeMatched}/${rr.gold ?? 0}` : "";
  return `${rr.rounds.length} rounds${late}${gold}`;
}

function RoundRow({ r, artifactUrl }: { r: RereviewRound; artifactUrl?: (rel: string) => string }) {
  const tiers = r.tiers ? `${r.tiers.inline ?? 0}/${r.tiers.body ?? 0}/${r.tiers.internal ?? 0}` : "—";
  const cov = r.coverage
    ? `${r.coverage.investigatedWeighted ?? "—"}% inv · ${r.coverage.carriedUnits} carried${r.coverage.notInvestigated ? ` · ${r.coverage.notInvestigated} not inv.` : ""}`
    : "—";
  const delta = r.delta ? `${r.delta.new ?? 0}/${r.delta.changed ?? 0}/${r.delta.affected ?? 0}/${r.delta.unchanged ?? 0}` : "—";
  const ledger = r.ledger ? `${r.ledger.open ?? 0} open · ${r.ledger.withheld ?? 0} held · ${(r.ledger.addressed ?? 0) + (r.ledger.resolved ?? 0)} closed` : "—";
  return (
    <tr className="border-t border-base-300 align-top">
      <td className="px-3 py-2 font-mono text-xs">
        {r.round}
        {r.label && <div className="max-w-40 truncate font-sans text-2xs text-base-content/50" title={r.label}>{r.label}</div>}
      </td>
      <td className="px-3 py-2 font-mono text-xs" title={r.headSha}>
        {short(r.headSha)}
        {r.artifactRel && artifactUrl && (
          <a href={artifactUrl(`${r.artifactRel}/round.json`)} target="_blank" rel="noreferrer" className="ml-2 font-sans text-2xs text-info hover:underline">
            round.json
          </a>
        )}
      </td>
      <td className="px-3 py-2 font-mono text-xs">
        {r.workflowSucceeded ? (r.event ?? "no review") : <span className="text-error" title={r.error}>failed</span>}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs">{r.inlinePosted}</td>
      <td className="px-3 py-2 text-right font-mono text-xs" title="inline / body / internal (disposition.json)">{tiers}</td>
      <td
        className="px-3 py-2 text-right font-mono text-xs"
        title={r.lateDiscoveryUnavailable ?? (r.lateDiscoverySource ? `units + prior review from: ${r.lateDiscoverySource}` : undefined)}
      >
        {r.round === 1 ? "n/a" : frac(r.lateDiscovery, r.lateDiscoveryOf)}
        {r.lateLabelled ? <span className="ml-1 text-2xs text-warning" title="posted as must-fix 'missed earlier'">+{r.lateLabelled} labelled</span> : null}
      </td>
      <td className="px-3 py-2 text-right font-mono text-xs">{frac(r.converged, null)}</td>
      <td className="px-3 py-2 text-right font-mono text-xs">{frac(r.alreadyRaised, null)}</td>
      <td className="px-3 py-2 text-right font-mono text-xs" title="new / changed / affected / unchanged units">{delta}</td>
      <td className="px-3 py-2 text-right font-mono text-2xs">{cov}</td>
      <td className="px-3 py-2 text-right font-mono text-2xs">{ledger}</td>
      <td className="px-3 py-2 text-right font-mono text-xs">{r.goldMatched ? r.goldMatched.map((g) => `#${g}`).join(" ") || "0" : "—"}</td>
      <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs">
        ${r.costUsd.toFixed(4)}
        <div className="text-2xs text-base-content/50">{fmtDuration(r.durationMs)}</div>
      </td>
    </tr>
  );
}

/** Every round of one chained case — the per-round evidence behind its chip. */
export function RereviewModal({
  title,
  rereview,
  artifactUrl,
  onClose,
}: {
  title: string;
  rereview: RereviewResult;
  artifactUrl?: (rel: string) => string;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  const rr = rereview;
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex max-h-[calc(100vh-2rem)] w-full max-w-7xl flex-col overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-base-300 bg-base-200/80 px-4 py-2.5">
          <span className="truncate font-mono text-xs text-base-content/70">{title}</span>
          <span className="ml-auto shrink-0 font-mono text-2xs text-base-content/60">
            late {frac(rr.lateDiscovery, rr.lateDiscoveryOf)} · converged {frac(rr.converged, null)} · already raised {frac(rr.alreadyRaised, null)} ·
            cumulative gold {frac(rr.cumulativeMatched, rr.gold)} · ${rr.costUsd.toFixed(4)}
          </span>
          <button onClick={onClose} className="btn btn-ghost btn-xs" aria-label="close">
            ✕
          </button>
        </div>
        <div className="overflow-auto">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-neutral text-2xs uppercase tracking-wide text-neutral-content/70">
                <th className="px-3 py-2 text-left font-semibold">round</th>
                <th className="px-3 py-2 text-left font-semibold">head</th>
                <th className="px-3 py-2 text-left font-semibold">review</th>
                <th className="px-3 py-2 text-right font-semibold">inline</th>
                <th className="px-3 py-2 text-right font-semibold">tiers i/b/int</th>
                <th className="px-3 py-2 text-right font-semibold">late</th>
                <th className="px-3 py-2 text-right font-semibold">converged</th>
                <th className="px-3 py-2 text-right font-semibold">already raised</th>
                <th className="px-3 py-2 text-right font-semibold">units n/c/a/u</th>
                <th className="px-3 py-2 text-right font-semibold">coverage</th>
                <th className="px-3 py-2 text-right font-semibold">ledger after</th>
                <th className="px-3 py-2 text-right font-semibold">gold matched</th>
                <th className="px-3 py-2 text-right font-semibold">cost</th>
              </tr>
            </thead>
            <tbody>
              {rr.rounds.map((r) => (
                <RoundRow key={r.round} r={r} artifactUrl={artifactUrl} />
              ))}
            </tbody>
          </table>
          <p className="px-4 py-3 text-2xs text-base-content/50">
            The last round is the case's scored head: its grade, cost and artifacts are the ones in the main table. A "—" is "not measured"
            (e.g. a baseline arm writes no disposition.json), never zero.
          </p>
        </div>
      </div>
    </div>
  );
}

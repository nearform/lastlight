import { useState } from "react";

import type { InstanceResult, PendingCase, ReviewTrace } from "../types";
import { fmtMs, isPrReviewTier, modelLabel } from "../lib/format";
import { Chip, Frac, Pill } from "./ui";
import { SessionModal, type SessionSource } from "./SessionModal";
import { DiffModal } from "./DiffModal";
import { JudgeModal } from "./JudgeModal";

/** Hover text listing the review's false positives + missed gold comments, for
 * eyeballing where a case lost precision/recall (Martian's gold set is known to
 * be incomplete, so "false positives" are worth a look). */
function reviewTooltip(r: InstanceResult): string {
  const rev = r.review;
  if (!rev) return "";
  const fp = rev.falsePositives.length
    ? "False positives:\n" + rev.falsePositives.map((f) => `- ${f.file ? `${f.file}: ` : ""}${f.description}`).join("\n")
    : "No false positives.";
  const fn = rev.falseNegatives.length
    ? "Missed gold:\n" + rev.falseNegatives.map((f) => `- [${f.severity}] ${f.file ? `${f.file}: ` : ""}${f.description}`).join("\n")
    : "No missed gold.";
  return `${fp}\n\n${fn}`;
}

/** Per-instance result rows for one tier, plus running/queued rows for a live
 * run. Mirrors the old static report's detail table. */
export function InstanceTable({
  tier,
  results,
  pending,
  labels,
  scorecardUrl,
}: {
  tier: string;
  results: InstanceResult[];
  pending: PendingCase[];
  labels: Record<string, string>;
  /** URL of this run's scorecard.json — session logs resolve relative to it. */
  scorecardUrl?: string;
}) {
  const showCodeFix = tier === "code-fix";
  const showReview = isPrReviewTier(tier);
  // The β the graded cases used (F1 by default) — labels the review column.
  const reviewBeta = results.find((r) => r.review)?.review?.beta ?? 1;
  const cols = 6 + (showCodeFix ? 1 : 0) + (showReview ? 1 : 0);
  // running before queued, so in-flight rows sit nearest the finished ones.
  const ordered = [...pending].sort((a, b) => (a.status === b.status ? 0 : a.status === "running" ? -1 : 1));

  // The open session viewer (live transcript or a finished case's per-phase
  // logs), or null.
  const [openLog, setOpenLog] = useState<SessionSource | null>(null);
  // The open diff viewer (code-fix changed files), or null. Kept separate from
  // `openLog` since the diff modal is two-pane, unlike the single-pane SessionModal.
  const [openDiff, setOpenDiff] = useState<{ title: string; url: string } | null>(null);
  // The open judge viewer (pr-review trace: findings ↔ gold + raw judge replies),
  // or null. Reads the trace embedded in the scorecard — no fetch.
  const [openJudge, setOpenJudge] = useState<{ title: string; trace: ReviewTrace } | null>(null);
  const sessionUrl = (rel: string) => (scorecardUrl ? scorecardUrl.replace(/scorecard\.json$/, rel) : rel);
  const titleFor = (id: string, model: string) => `${id} · ${modelLabel(labels, model)}`;
  const hasDiff = (r: InstanceResult) => !!r.modelPatchFile;
  const openDiffView = (r: InstanceResult) =>
    setOpenDiff({ title: `${titleFor(r.instance_id, r.model)} · changed files`, url: sessionUrl(r.modelPatchFile!) });
  // Finished case → browse per-trial / per-phase logs.
  const openResult = (r: InstanceResult) =>
    setOpenLog({
      kind: "trials",
      title: titleFor(r.instance_id, r.model),
      sessions: r.sessions ?? [],
      baseUrl: scorecardUrl ?? "",
      metrics: r.phases,
    });
  // Code-fix case → the held-out test breakdown + captured test output.
  const openTests = (r: InstanceResult) =>
    setOpenLog({
      kind: "execution",
      title: `${titleFor(r.instance_id, r.model)} · held-out tests`,
      logUrl: r.executionLog ? sessionUrl(r.executionLog) : undefined,
      failToPass: r.failToPass,
      passToPass: r.passToPass,
    });
  const hasTestDetail = (r: InstanceResult) =>
    !!(r.executionLog || r.failToPass?.length || r.passToPass?.length);
  // Running case → follow the live consolidated transcript.
  const openLive = (rel: string, id: string, model: string) =>
    setOpenLog({ kind: "live", title: titleFor(id, model), url: sessionUrl(rel) });

  return (
    <>
    <div className="overflow-x-auto rounded-xl border border-base-300 bg-base-200">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-neutral text-2xs uppercase tracking-wide text-neutral-content/70">
            <th className="px-3 py-3 text-left font-semibold">instance</th>
            <th className="px-3 py-3 text-left font-semibold">model</th>
            {showCodeFix && <th className="px-3 py-3 text-left font-semibold">code-fix</th>}
            {showReview && <th className="px-3 py-3 text-left font-semibold">review (F{reviewBeta})</th>}
            <th className="px-3 py-3 text-left font-semibold">behavioral</th>
            <th className="px-3 py-3 text-left font-semibold">checks</th>
            <th className="px-3 py-3 text-right font-semibold">cost</th>
            <th className="px-3 py-3 text-right font-semibold">latency</th>
          </tr>
        </thead>
        <tbody>
          {results.map((r, i) => {
            const checks = r.behavioral?.checks ?? [];
            return (
              <tr key={`${r.instance_id}:${r.model}:${i}`} className="border-t border-base-300 align-middle">
                <td className="px-3 py-2.5 font-mono">
                  {r.instance_id}
                  {r.sessions && r.sessions.length > 0 && (
                    <button
                      onClick={() => openResult(r)}
                      className="ml-2 rounded border border-base-300 px-1.5 py-0.5 align-middle font-sans text-2xs text-info hover:border-info hover:text-base-content"
                      title="View the agent session log (per phase)"
                    >
                      log
                    </button>
                  )}
                </td>
                <td className="px-3 py-2.5 font-mono text-base-content/50">{modelLabel(labels, r.model)}</td>
                {showCodeFix && (
                  <td className="px-3 py-2.5">
                    {r.blocked ? (
                      <Pill kind="blocked">blocked</Pill>
                    ) : r.resolved === undefined ? (
                      <Pill kind="na">—</Pill>
                    ) : r.resolved ? (
                      <Pill kind="pass">resolved</Pill>
                    ) : (
                      <Pill kind="fail">unresolved</Pill>
                    )}
                    {!r.blocked && <Frac pass={r.resolvedPass} trials={r.trials} />}
                    {hasTestDetail(r) && (
                      <button
                        onClick={() => openTests(r)}
                        className="ml-2 rounded border border-base-300 px-1.5 py-0.5 align-middle font-sans text-2xs text-info hover:border-info hover:text-base-content"
                        title="View the held-out test results + captured output"
                      >
                        tests
                      </button>
                    )}
                    {hasDiff(r) && (
                      <button
                        onClick={() => openDiffView(r)}
                        className="ml-2 rounded border border-base-300 px-1.5 py-0.5 align-middle font-sans text-2xs text-info hover:border-info hover:text-base-content"
                        title="Browse the files the agent changed (diff)"
                      >
                        files
                      </button>
                    )}
                  </td>
                )}
                {showReview && (
                  <td className="px-3 py-2.5 whitespace-nowrap">
                    {r.error ? (
                      <Pill kind="fail">error</Pill>
                    ) : r.review ? (
                      <span className="inline-flex items-center gap-2">
                        <span title={reviewTooltip(r)} className="cursor-help">
                          <Pill kind={r.review.fbeta >= 0.5 ? "pass" : "fail"}>{(r.review.fbeta * 100).toFixed(0)}%</Pill>
                          <span className="ml-2 font-mono text-2xs text-base-content/60">
                            P{r.review.precision.toFixed(2)}/R{r.review.recall.toFixed(2)} · {r.review.matched}/{r.review.gold} gold · {r.review.falsePositives.length} FP
                          </span>
                        </span>
                        {r.review.trace && (
                          <button
                            onClick={() =>
                              setOpenJudge({ title: `${titleFor(r.instance_id, r.model)} · judge`, trace: r.review!.trace! })
                            }
                            className="btn btn-ghost btn-xs h-5 min-h-0 px-1.5 font-mono text-2xs text-info"
                            title="Inspect the judge: extracted findings ↔ gold + raw replies"
                          >
                            judge
                          </button>
                        )}
                      </span>
                    ) : (
                      <Pill kind="na">—</Pill>
                    )}
                  </td>
                )}
                <td className="px-3 py-2.5">
                  {r.error ? (
                    <Pill kind="fail">error</Pill>
                  ) : r.blocked ? (
                    <Pill kind="blocked">blocked</Pill>
                  ) : r.behavioral ? (
                    r.behavioral.ok ? (
                      <Pill kind="pass">ok</Pill>
                    ) : (
                      <Pill kind="fail">miss</Pill>
                    )
                  ) : (
                    <Pill kind="na">—</Pill>
                  )}
                  {!r.error && !r.blocked && <Frac pass={r.behavioralPass} trials={r.trials} />}
                </td>
                <td className="px-3 py-2.5 leading-7">
                  {checks.length ? (
                    checks.map((c, j) => <Chip key={j} ok={c.ok} name={c.name} detail={c.detail} />)
                  ) : (
                    <span className="text-base-content/40">—</span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono">${r.costUsd.toFixed(4)}</td>
                <td className="whitespace-nowrap px-3 py-2.5 text-right font-mono">{fmtMs(r.durationMs)}</td>
              </tr>
            );
          })}
          {results.length === 0 && pending.length === 0 && (
            <tr>
              <td colSpan={cols} className="px-3 py-6 text-center font-mono text-base-content/40">
                no results yet
              </td>
            </tr>
          )}
          {ordered.map((pn, i) => {
            const isRunning = pn.status === "running";
            return (
            <tr
              key={`pending:${pn.instance_id}:${pn.model}:${i}`}
              className={
                "border-t border-base-300 " +
                (isRunning ? "bg-accent/5" : "opacity-50")
              }
            >
              <td className="px-3 py-2.5 font-mono text-base-content/50">
                {pn.instance_id}
                {isRunning && pn.sessionLog && (
                  <button
                    onClick={() => openLive(pn.sessionLog!, pn.instance_id, pn.model)}
                    className="ml-2 rounded border border-accent/40 px-1.5 py-0.5 align-middle font-sans text-2xs text-accent hover:border-accent hover:text-base-content"
                    title="Follow the agent session log live"
                  >
                    follow
                  </button>
                )}
              </td>
              <td className="px-3 py-2.5 font-mono text-base-content/50">{modelLabel(labels, pn.model)}</td>
              {showCodeFix && (
                <td className="px-3 py-2.5">
                  {pn.status === "running" ? <Pill kind="run">running…</Pill> : <Pill kind="wait">queued</Pill>}
                </td>
              )}
              {showReview && (
                <td className="px-3 py-2.5">
                  {pn.status === "running" ? <Pill kind="run">running…</Pill> : <Pill kind="wait">queued</Pill>}
                </td>
              )}
              <td className="px-3 py-2.5">
                {!showCodeFix && !showReview &&
                  (pn.status === "running" ? <Pill kind="run">running…</Pill> : <Pill kind="wait">queued</Pill>)}
                {(showCodeFix || showReview) && <span className="text-base-content/40">—</span>}
              </td>
              <td className="px-3 py-2.5 text-base-content/40">—</td>
              <td className="px-3 py-2.5 text-right font-mono text-base-content/40">—</td>
              <td className="px-3 py-2.5 text-right font-mono text-base-content/40">—</td>
            </tr>
            );
          })}
        </tbody>
      </table>
    </div>
    {openLog && <SessionModal source={openLog} onClose={() => setOpenLog(null)} />}
    {openDiff && <DiffModal title={openDiff.title} url={openDiff.url} onClose={() => setOpenDiff(null)} />}
    {openJudge && <JudgeModal title={openJudge.title} trace={openJudge.trace} onClose={() => setOpenJudge(null)} />}
    </>
  );
}

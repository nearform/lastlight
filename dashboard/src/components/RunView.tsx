import { useState } from "react";

import type { IndexRun, InstanceResult, MartianRanking, PendingCase } from "../types";
import { useScorecard } from "../lib/api";
import { fmtDate, modelLabel } from "../lib/format";
import { summarizeModels } from "../lib/summarize";
import { CompareTable } from "./CompareTable";
import { InstanceTable } from "./InstanceTable";
import { LiveBadge, RunTypeBadge } from "./ui";

/** One run's full scorecard: tier tabs, each with a model-comparison table and
 * the per-instance detail rows. Live runs poll + show running/queued rows. */
export function RunView({ run }: { run: IndexRun }) {
  const { data: card, isLoading, error } = useScorecard(run.scorecard, run.live);
  const labels = card?.meta?.labels ?? run.labels;
  const results = card?.results ?? [];
  const pending: PendingCase[] = card?.meta?.pending ?? [];

  // Tiers present in this run, first-seen order; fall back to declared tiers.
  const tierOrder: string[] = [];
  for (const r of results) {
    const t = r.tier ?? run.tiers[0] ?? "—";
    if (!tierOrder.includes(t)) tierOrder.push(t);
  }
  for (const p of pending) if (!tierOrder.includes(p.tier)) tierOrder.push(p.tier);
  const tiers = tierOrder.length ? tierOrder : run.tiers;

  const [active, setActive] = useState(0);
  const tier = tiers[Math.min(active, Math.max(0, tiers.length - 1))] ?? run.tiers[0] ?? "—";

  const tierResults = results.filter((r) => (r.tier ?? tiers[0]) === tier);
  const tierPending = pending.filter((p) => p.tier === tier);
  const models = summarizeModels(tierResults);
  // β this pr-review run graded with (F1 by default; EVAL_F_BETA overrides).
  const reviewBeta = models.find((m) => m.reviewBeta !== undefined)?.reviewBeta ?? 1;

  // `config` runs compare deployment configs (per-step model maps), not models —
  // relabel the axis and surface the per-step model assignment.
  const runType = card?.meta?.runType ?? run.runType ?? "models";
  const isConfig = runType === "config";
  const axisNoun = isConfig ? "configs" : "models";

  const modelNames = [...new Set(results.map((r) => r.model))].map((m) => modelLabel(labels, m));
  const caseCount = countCases(results);
  const totalCases = caseCount + pending.length;

  return (
    <div>
      <header className="mb-6 border-b border-base-300 pb-5">
        <h1 className="text-2xl font-semibold text-base-content">
          Eval Scorecard
          <RunTypeBadge runType={runType} className="ml-3 align-middle" />
          <LiveBadge run={run} className="ml-3 align-middle font-mono" size="sm" />
        </h1>
        <div className="mt-1.5 font-mono text-xs text-base-content/50">
          <b className="font-semibold text-base-content">{tiers.join(" + ")}</b> &nbsp;·&nbsp; {axisNoun}:{" "}
          <b className="font-semibold text-base-content">{modelNames.join(", ")}</b> &nbsp;·&nbsp;
          {caseCount}
          {pending.length ? ` / ${totalCases}` : ""} cases
          {run.runs > 1 && (
            <>
              {" "}
              &nbsp;·&nbsp; <b className="font-semibold text-base-content">{run.runs}×</b> per case{" "}
              <span className="text-base-content/40">(worst-case verdict · mean cost)</span>
            </>
          )}
          {run.gitSha && (
            <>
              {" "}
              &nbsp;·&nbsp; <span className="text-base-content/70">{run.gitSha}</span>
            </>
          )}
          &nbsp;·&nbsp; {fmtDate(card?.meta?.generatedAt ?? run.generatedAt)}
        </div>
        {tier === "pr-review" && card?.meta?.martian?.models[0] && (
          <button
            onClick={() => document.getElementById("martian-rank")?.scrollIntoView({ behavior: "smooth", block: "start" })}
            className="mt-3 inline-flex items-center gap-1.5 rounded-lg border border-accent/40 bg-accent/10 px-3 py-1.5 font-mono text-xs text-accent transition-colors hover:bg-accent/20"
          >
            <span className="font-bold">
              Lastlight ranks #{card.meta.martian.models[0].rank} of {card.meta.martian.models[0].of}
            </span>
            <span className="text-accent/70">
              vs Martian tools over these {card.meta.martian.prCount} PR{card.meta.martian.prCount === 1 ? "" : "s"}
            </span>
            <span aria-hidden>↓</span>
          </button>
        )}
      </header>

      {error && <ErrorNote message={(error as Error).message} />}
      {isLoading && !card ? (
        <Loading />
      ) : (
        <>
          {tiers.length > 1 && (
            <nav className="mb-4 flex flex-wrap gap-2">
              {tiers.map((t, i) => (
                <button
                  key={t}
                  onClick={() => setActive(i)}
                  className={
                    "rounded-lg border px-4 py-2 font-mono text-xs font-semibold " +
                    (t === tier
                      ? "border-accent bg-accent text-accent-content"
                      : "border-base-300 bg-base-200 text-base-content/60 hover:border-info hover:text-base-content")
                  }
                >
                  {t}
                </button>
              ))}
            </nav>
          )}

          <h2 className={(tier === "pr-review" ? "mb-2" : "mb-3.5") + " mt-2 text-lg font-semibold text-base-content"}>
            {isConfig ? "Config comparison" : "Model comparison"}{" "}
            <span className="font-normal text-base-content/50">— {tier}</span>
          </h2>
          {tier === "pr-review" && (
            <details className="group mb-4 max-w-2xl">
              <summary className="inline-flex cursor-pointer list-none items-center gap-1.5 text-2xs text-base-content/50 transition-colors hover:text-base-content/80 [&::-webkit-details-marker]:hidden">
                <span className="flex h-4 w-4 items-center justify-center rounded-full border border-base-content/30 font-mono text-[10px] leading-none">
                  ?
                </span>
                Comparison methodology
                <span className="text-base-content/30 transition-transform group-open:rotate-90">›</span>
              </summary>
              <p className="mt-2 text-2xs leading-5 text-base-content/50">
                An LLM judge matches the posted review against a human-verified gold set of real issues, giving{" "}
                <span className="text-base-content/70">precision</span> (matched ÷ posted) and{" "}
                <span className="text-base-content/70">recall</span> (matched ÷ gold), combined as{" "}
                <b className="font-semibold text-base-content/70">F{reviewBeta}</b>
                {reviewBeta === 1 ? (
                  <> — the F-beta with <span className="font-mono">β=1</span> (equal weight), matching the benchmark leaderboard</>
                ) : (
                  <> — the F-beta with <span className="font-mono">β={reviewBeta}</span> (via <span className="font-mono">EVAL_F_BETA</span>; β&lt;1 weights precision higher)</>
                )}
                . Click <b className="font-semibold text-base-content/70">judge</b> on any row to inspect the match. Cases
                come from the offline set of{" "}
                <a
                  href="https://github.com/withmartian/code-review-benchmark"
                  target="_blank"
                  rel="noreferrer"
                  className="text-info hover:underline"
                >
                  Martian's Code Review Bench
                </a>
                ; its gold set is known to be incomplete, so unrecognized-but-real findings can score as false positives.
              </p>
            </details>
          )}
          <CompareTable models={models} tier={tier} labels={labels} axisLabel={isConfig ? "Config" : "Model"} />

          {isConfig && <PhaseModelPanel results={tierResults} labels={labels} />}

          <h2 className="mb-3.5 mt-8 text-lg font-semibold text-base-content">Per-instance results</h2>
          <InstanceTable tier={tier} results={tierResults} pending={tierPending} labels={labels} scorecardUrl={run.scorecard} />

          {tier === "pr-review" && card?.meta?.martian && (
            <MartianRankPanel ranking={card.meta.martian} labels={labels} />
          )}
        </>
      )}
    </div>
  );
}

/** Distinct cases (instance × model), so trials don't inflate the count. */
function countCases(results: InstanceResult[]): number {
  return new Set(results.map((r) => `${r.tier ?? ""}|${r.model}|${r.instance_id}`)).size;
}

/**
 * The payoff view for `config` runs: which model each workflow phase resolved to,
 * per config arm. The map is identical across a config's instances, so we read it
 * off the first result of each arm. Phase order follows declaration order.
 */
function PhaseModelPanel({ results, labels }: { results: InstanceResult[]; labels: Record<string, string> }) {
  // arm (config label) → ordered [phase, model] pairs, from its first result.
  const byArm = new Map<string, [string, string][]>();
  for (const r of results) {
    if (byArm.has(r.model) || !r.phases?.length) continue;
    byArm.set(
      r.model,
      r.phases.filter((p) => p.model).map((p) => [p.phase, p.model as string]),
    );
  }
  const arms = [...byArm].filter(([, pairs]) => pairs.length);
  if (!arms.length) return null;

  return (
    <div className="mt-5">
      <h3 className="mb-2 font-mono text-xs font-semibold uppercase tracking-wide text-base-content/50">
        Per-step models
      </h3>
      <div className="flex flex-col gap-3">
        {arms.map(([arm, pairs]) => (
          <div key={arm} className="rounded-xl border border-base-300 bg-base-200 px-4 py-3">
            <div className="mb-2 font-mono text-xs font-semibold text-base-content">{modelLabel(labels, arm)}</div>
            <div className="flex flex-wrap gap-x-4 gap-y-1 font-mono text-2xs">
              {pairs.map(([phase, model], i) => (
                <span key={`${phase}-${i}`} className="whitespace-nowrap text-base-content/60">
                  <span className="text-base-content/40">{phase}</span>
                  <span className="mx-1 text-base-content/30">→</span>
                  <span className="text-info">{model}</span>
                </span>
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

/**
 * "Where would we rank?" — our model(s) slotted into Martian's Code Review Bench
 * tools, all scored over the SAME PRs this run covered (subset-fair). Rows are
 * sorted by F1; our arm(s) are highlighted at their rank. Cross-judge caveat is
 * shown: our reviews are judged by our judge, Martian's tools by `judgeModel`.
 */
function MartianRankPanel({ ranking, labels }: { ranking: MartianRanking; labels: Record<string, string> }) {
  // Merge tools + our arm(s) into one leaderboard, sorted by F1 desc. Our rows are
  // flagged so we can highlight them and show the rank badge.
  const usKeys = new Set(ranking.models.map((m) => m.key));
  const rows = [
    ...ranking.tools.map((t) => ({ ...t, us: false, display: t.name })),
    // Our row is the whole Lastlight harness (skills + workflow + model), not the
    // raw model — the honest peer to Martian's tools, which are also full products.
    ...ranking.models.map((m) => ({ ...m, us: true, display: `Lastlight (${modelLabel(labels, m.key)})` })),
  ].sort((a, b) => b.f1 - a.f1);
  const maxF1 = Math.max(...rows.map((r) => r.f1), 0.01);
  const primary = ranking.models[0]; // single-model runs: the headline rank

  return (
    <div className="mt-8 scroll-mt-4" id="martian-rank">
      <h3 className="mb-1 text-lg font-semibold text-base-content">
        Where would this rank?{" "}
        {primary && (
          <span className="ml-1 align-middle font-mono text-sm font-bold text-accent">
            #{primary.rank} of {primary.of}
          </span>
        )}
      </h3>
      <p className="mb-3 max-w-2xl text-2xs leading-5 text-base-content/50">
        Ranked against{" "}
        <a
          href="https://github.com/withmartian/code-review-benchmark"
          target="_blank"
          rel="noreferrer"
          className="text-info hover:underline"
        >
          Martian's Code Review Bench
        </a>{" "}
        tools over the <b className="font-semibold text-base-content/70">same {ranking.prCount} PR{ranking.prCount === 1 ? "" : "s"}</b>{" "}
        this run covered — not the full leaderboard. Micro-averaged F1. Only tools with data on every one of
        these PRs are shown.{" "}
        <span className="text-base-content/40">
          Cross-judge: our reviews are graded by our judge; Martian's tools by{" "}
          <span className="font-mono">{ranking.judgeModel.split("/").pop()}</span>.
        </span>
      </p>
      <div className="max-w-2xl overflow-hidden rounded-xl border border-base-300 bg-base-200">
        {rows.map((r, i) => {
          const pct = Math.round((r.f1 / maxF1) * 100);
          return (
            <div
              key={`${r.us ? "us" : "tool"}-${r.key}`}
              className={
                "flex items-center gap-3 px-3 py-1.5 " +
                (i > 0 ? "border-t border-base-300/60 " : "") +
                (r.us ? "bg-accent/15" : "")
              }
            >
              <span className="w-6 shrink-0 text-right font-mono text-2xs tabular-nums text-base-content/40">
                {i + 1}
              </span>
              <span
                className={
                  "w-56 shrink-0 truncate font-mono text-xs " +
                  (r.us ? "font-bold text-accent" : "text-base-content/80")
                }
                title={r.display}
              >
                {r.display}
              </span>
              <div className="relative h-3 flex-1 overflow-hidden rounded bg-base-300/50">
                <div
                  className={"h-full rounded " + (r.us ? "bg-accent" : "bg-info/50")}
                  style={{ width: `${pct}%` }}
                />
              </div>
              <span
                className={
                  "w-10 shrink-0 text-right font-mono text-xs tabular-nums " +
                  (r.us ? "font-bold text-accent" : "text-base-content/60")
                }
              >
                {(r.f1 * 100).toFixed(1)}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Loading() {
  return <div className="py-16 text-center font-mono text-sm text-base-content/40">loading scorecard…</div>;
}

function ErrorNote({ message }: { message: string }) {
  return (
    <div className="mb-4 rounded-xl border border-error/40 bg-error/10 px-4 py-3 font-mono text-xs text-error">
      {message}
    </div>
  );
}

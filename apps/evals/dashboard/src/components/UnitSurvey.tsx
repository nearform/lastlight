import clsx from "clsx";
import { Fragment } from "react";

import { oneSidedGold, type OneSidedGold } from "../../../src/unit-survey-index.js";
import type { ReplayCase, ReplayReport, UnitSurveyEntry } from "../types";
import { useUnitSurveyReport } from "../lib/api";
import { fmtDate, modelDisplay } from "../lib/format";
import { UNIT_SURVEY_TIER_KEY, useNavigate } from "../lib/router";
import { caseRow, coverageText, entryModelCells, fmtChars, NA, unitSurveyProgress } from "../lib/unitSurvey";

/**
 * The unit-survey replay views — `scripts/unit-survey-replay.ts` rendered.
 *
 * A replay answers two questions of the per-unit survey
 * (`docs/plans/pr-review-units-sites.md` → "Evals"): stage 1 ($0) — does some unit even
 * SHOW the model each gold line; stage 2 — scored by the same judge on the same
 * gold, do the units' hypotheses find what the preserved AGENT survey found, at
 * what cost and wall clock.
 *
 * Two rules the markup keeps:
 *
 *  1. **Units and agent are always side by side** — a units number without the
 *     agent's comparator says nothing, so every stage-2 cell is a pair.
 *  2. **n/a is not 0.** A stage-1 report has no model side; an unjudged side
 *     has no credited gold; a fixture that recorded no survey branch has no
 *     agent wall or $. Those render `n/a` (see `lib/unitSurvey.ts`).
 */

const COVERAGE_HINT =
  "Stage 1 ($0): gold lines some unit's request SHOWS the model (line-tagged), over gold that names a file. A gold with no file is unlocatable — counted in the gold total, not the denominator.";
const CREDITED_HINT =
  "Stage 2: gold the internal-recall judge credited to a hypothesis row (majority over its votes). Both sides are scored by the same judge on the same gold. n/a = that side was not judged.";

function StageChip({ stage }: { stage: UnitSurveyEntry["stage"] }) {
  return (
    <span
      className={clsx(
        "whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-2xs font-semibold",
        stage === "replay" ? "bg-info/15 text-info" : "bg-base-300 text-base-content/60",
      )}
      title={stage === "replay" ? "stage 1 + stage 2 (model replay, judged)" : "stage 1 only — $0 coverage, no model"}
    >
      {stage === "replay" ? "stage 2" : "stage 1"}
    </span>
  );
}

/**
 * Status + progress: `running · 3/8`, `stale (killed) · 3/8`, `failed · 3/8`,
 * `done · 8 cases`. `stale` is as loud as `failed` on purpose — a `running`
 * file whose heartbeat stopped is the ONLY evidence the script died, and the
 * failure being guarded against is silence read as progress
 * ({@link unitSurveyProgress} → `unitSurveyStatus`, shared with the index).
 */
export function UnitStatusChip({ entry, className = "" }: { entry: UnitSurveyEntry; className?: string }) {
  const p = unitSurveyProgress(entry, Date.now());
  const style =
    p.status === "running"
      ? "bg-success/15 text-success"
      : p.status === "done"
        ? "bg-base-300 text-base-content/60"
        : "bg-error/15 text-error";
  const title =
    p.status === "running"
      ? `Still running: ${p.cases} done, ${p.elapsed} elapsed, last written ${fmtDate(entry.heartbeat ?? "")}. Every total is PARTIAL and will move.`
      : p.status === "stale"
        ? `STALE — killed? The report still says running, but nothing has been written since ${
            entry.heartbeat ? fmtDate(entry.heartbeat) : "— (no heartbeat recorded)"
          }. ${p.cases} completed; the rest never will. Totals are partial.`
        : p.status === "failed"
          ? `FAILED after ${p.cases}: ${entry.error ?? "no error recorded"}`
          : `Done: ${p.cases} in ${p.elapsed}.`;
  return (
    <span
      className={clsx(
        "inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-2xs font-semibold",
        style,
        className,
      )}
      title={title}
    >
      {p.status === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />}
      {p.status !== "running" && p.status !== "done" && <span className="h-1.5 w-1.5 rounded-full bg-error" />}
      {p.chip}
    </span>
  );
}

/** The kind chip that marks a unit-survey report among eval runs (home page). */
export function UnitSurveyKindChip({ className = "" }: { className?: string }) {
  return (
    <span
      className={clsx(
        "inline-block whitespace-nowrap rounded-full bg-accent/15 px-2 py-0.5 font-mono text-2xs font-semibold text-accent",
        className,
      )}
      title="Unit-survey replay — the per-unit survey over preserved pr-review fixtures, vs the agent survey"
    >
      unit-survey
    </span>
  );
}

/** `partial` beside an aggregate computed from the cases done so far. */
function PartialTag({ show }: { show: boolean }) {
  if (!show) return null;
  return (
    <span
      className="ml-1 rounded bg-warning/15 px-1 py-px font-mono text-2xs font-semibold uppercase text-warning"
      title="Computed from the cases finished so far — the run has not completed."
    >
      partial
    </span>
  );
}

/** `units … vs agent …` — the pair, never one half. */
function Pair({ units, agent, className = "" }: { units: string; agent: string; className?: string }) {
  return (
    <div className={clsx("whitespace-nowrap font-mono tabular-nums", className)}>
      <span className={units === NA ? "text-base-content/40" : "text-base-content"}>{units}</span>
      <span className="text-base-content/40"> vs </span>
      <span className={agent === NA ? "text-base-content/40" : "text-base-content/70"}>{agent}</span>
    </div>
  );
}

// ── list ────────────────────────────────────────────────────────────────────

export function UnitSurveyList({ reports }: { reports: UnitSurveyEntry[] }) {
  const navigate = useNavigate();
  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold text-base-content">unit-survey</h1>
      <p className="mb-4 max-w-3xl font-mono text-xs text-base-content/50">
        {reports.length} report{reports.length === 1 ? "" : "s"} · the per-unit survey replayed over preserved pr-review
        fixtures · click a report for its cases
      </p>
      <p className="mb-6 max-w-3xl text-2xs leading-5 text-base-content/50">
        <b className="font-semibold text-base-content/70">coverage</b> (stage 1, $0) is gold lines some unit shows the
        model over gold that names a file. <b className="font-semibold text-base-content/70">credited</b> (stage 2) is
        gold the internal-recall judge credited, <b className="font-semibold text-base-content/70">units vs agent</b> —
        the agent side is the survey preserved in each fixture, written by an older pipeline, so the two are different
        code generations. $ is the survey only (no judge). <b className="font-semibold text-base-content/70">n/a</b>{" "}
        means that side has no data — never a zero.
      </p>

      {!reports.length ? (
        <div className="rounded-xl border border-base-300 bg-base-200 px-5 py-10 text-center">
          <p className="font-mono text-sm text-base-content/60">No unit-survey reports yet.</p>
          <p className="mt-2 font-mono text-xs text-base-content/40">
            Record one with{" "}
            <span className="text-accent">
              npx tsx scripts/unit-survey-replay.ts --fixtures &lt;dir&gt; --instances &lt;instances.json&gt;
            </span>
          </p>
        </div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-base-300 bg-base-200">
          <table className="w-full border-collapse text-sm">
            <thead>
              <tr className="bg-neutral text-2xs uppercase tracking-wide text-neutral-content/70">
                <th className="px-3 py-3 text-left font-semibold">report</th>
                <th className="px-3 py-3 text-left font-semibold">stage · cases</th>
                <th className="px-3 py-3 text-left font-semibold" title={COVERAGE_HINT}>
                  coverage · units
                </th>
                <th className="px-3 py-3 text-left font-semibold" title={CREDITED_HINT}>
                  credited gold — units vs agent
                </th>
                <th className="px-3 py-3 text-right font-semibold">$ — units vs agent</th>
                <th className="px-3 py-3 text-right font-semibold">wall — units vs agent</th>
              </tr>
            </thead>
            <tbody>
              {reports.map((r) => {
                const m = entryModelCells(r);
                const p = unitSurveyProgress(r, Date.now());
                return (
                  <tr
                    key={r.id}
                    onClick={() => navigate(UNIT_SURVEY_TIER_KEY, r.id)}
                    className="cursor-pointer border-t border-base-300 align-top hover:bg-base-300/40"
                  >
                    <td className="px-3 py-2.5">
                      <div className="whitespace-nowrap font-mono text-xs text-info hover:underline">
                        {fmtDate(r.generatedAt)}
                      </div>
                      <div className="whitespace-nowrap font-mono text-sm text-base-content">{r.label}</div>
                      <div className="whitespace-nowrap font-mono text-2xs text-base-content/50">
                        {r.arms.join(", ")}
                        {r.promptVersion && <span className="text-base-content/40"> · {r.promptVersion}</span>}
                        {r.model?.models.length ? (
                          <span className="text-base-content/40">
                            {" "}
                            · {r.model.models.map((x) => modelDisplay({}, x).label).join(", ")}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 font-mono text-xs">
                      <div className="flex flex-wrap items-center gap-1">
                        <StageChip stage={r.stage} />
                        <UnitStatusChip entry={r} />
                      </div>
                      <div className="mt-1 whitespace-nowrap text-base-content/70">
                        {p.cases} · {p.elapsed}
                        {r.errored > 0 && <span className="text-error"> · {r.errored} errored</span>}
                      </div>
                    </td>
                    <td className="whitespace-nowrap px-3 py-2.5 font-mono text-xs tabular-nums" title={COVERAGE_HINT}>
                      <div className="text-sm font-semibold text-base-content">
                        {coverageText(r.coverage)}
                        <PartialTag show={p.partial} />
                      </div>
                      <div className="text-2xs text-base-content/50">
                        {r.coverage.gold} gold · {r.units} units · {fmtChars(r.requestChars)} chars
                        {r.truncated > 0 && <span className="text-warning"> · {r.truncated} truncated</span>}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-xs" title={CREDITED_HINT}>
                      <div className="flex items-center">
                        <Pair units={m.unitsRecall} agent={m.agentRecall} className="text-sm font-semibold" />
                        <PartialTag show={p.partial} />
                      </div>
                      {r.model && (
                        <div className="whitespace-nowrap font-mono text-2xs text-base-content/50">
                          only units {r.model.onlyUnits} · only agent {r.model.onlyAgent} · {r.model.cases} case
                          {r.model.cases === 1 ? "" : "s"}
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs">
                      <Pair units={m.unitsCost} agent={m.agentCost} />
                    </td>
                    <td className="px-3 py-2.5 text-right text-xs">
                      <Pair units={m.unitsWall} agent={m.agentWall} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

// ── detail ──────────────────────────────────────────────────────────────────

export function UnitSurveyDetail({ entry }: { entry: UnitSurveyEntry }) {
  const p = unitSurveyProgress(entry, Date.now());
  const { data, isLoading, error } = useUnitSurveyReport(entry.report, p.status === "running");
  const m = entryModelCells(entry);
  const partial = p.partial ? " (partial)" : "";
  return (
    <div>
      <div className="mb-1 flex flex-wrap items-baseline gap-x-3">
        <h1 className="text-2xl font-semibold text-base-content">{entry.label}</h1>
        <StageChip stage={entry.stage} />
        <UnitStatusChip entry={entry} />
        <span className="font-mono text-xs text-base-content/40">
          {fmtDate(entry.generatedAt)} · {p.cases} · {p.elapsed}
        </span>
      </div>
      {p.status !== "done" && (
        <p
          className={clsx(
            "mb-4 max-w-4xl rounded-lg border px-3 py-2 font-mono text-2xs leading-5",
            p.status === "running" ? "border-success/40 bg-success/10 text-success" : "border-error/40 bg-error/10 text-error",
          )}
        >
          {p.status === "running"
            ? `Running — ${p.cases} done, ${p.elapsed} elapsed. Every figure below is PARTIAL: computed from the cases finished so far, and it will move.`
            : p.status === "stale"
              ? `STALE — the report says running but nothing has been written since ${entry.heartbeat ? fmtDate(entry.heartbeat) : "— (no heartbeat)"}; the script was killed. ${p.cases} completed and the rest never will — the figures below are partial.`
              : `FAILED after ${p.cases}: ${entry.error ?? "no error recorded"}. The figures below cover only the cases that finished.`}
        </p>
      )}
      <div className="mb-5 flex flex-wrap items-center gap-x-6 gap-y-1 font-mono text-2xs text-base-content/50">
        <span>
          arms <span className="text-base-content/70">{entry.arms.join(", ") || "—"}</span>
        </span>
        <span>
          prompt <span className="text-base-content/70">{entry.promptVersion ?? "not recorded"}</span>
        </span>
        {entry.model && (
          <>
            <span>
              units model <span className="text-base-content/70">{entry.model.models.join(", ")}</span>
            </span>
            <span>
              judge{" "}
              <span className="text-base-content/70">
                {entry.model.judgeModels.map((j) => j ?? "none (location only)").join(", ")}
              </span>
              {entry.model.votes.length > 0 && (
                <span className="text-base-content/40"> · {entry.model.votes.join("/")} vote(s)</span>
              )}
            </span>
          </>
        )}
        <span className="break-all">
          report <a className="text-info hover:underline" href={entry.report}>{entry.id}.json</a>
        </span>
      </div>

      <div className="mb-6 grid max-w-4xl grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label={`coverage (stage 1)${partial}`} title={COVERAGE_HINT} value={coverageText(entry.coverage)} sub={`${entry.coverage.gold} gold`} />
        <Stat label={`credited — units vs agent${partial}`} title={CREDITED_HINT} value={<Pair units={m.unitsRecall} agent={m.agentRecall} />} />
        <Stat label={`$ — units vs agent${partial}`} value={<Pair units={m.unitsCost} agent={m.agentCost} />} />
        <Stat label={`wall — units vs agent${partial}`} value={<Pair units={m.unitsWall} agent={m.agentWall} />} />
      </div>

      {error ? (
        <p className="mt-5 rounded-lg border border-error/40 bg-error/10 px-3 py-2 font-mono text-2xs text-error">
          Couldn't load the report — {(error as Error).message}
        </p>
      ) : isLoading || !data ? (
        <p className="mt-5 font-mono text-xs text-base-content/40">loading cases…</p>
      ) : (
        <>
          <CaseTable cases={data.cases ?? []} />
          <Pending report={data} />
        </>
      )}
    </div>
  );
}

/** The planned cases with no result yet — what a running (or killed) replay
 * still owes. Nothing on a finished report or one that predates the plan. */
function Pending({ report }: { report: ReplayReport }) {
  const done = new Set((report.cases ?? []).map((c) => `${c.arm}/${c.instanceId}`));
  const pending = (report.planned ?? []).filter((c) => !done.has(`${c.arm}/${c.instanceId}`));
  if (!pending.length || report.status === "done") return null;
  return (
    <p className="mt-3 font-mono text-2xs text-base-content/50">
      {report.status === "running" ? "not yet replayed" : "never replayed"} ({pending.length}):{" "}
      <span className="text-base-content/70">
        {pending.map((c) => `${c.arm}/${c.instanceId.replace(/^prreview__/, "")}`).join(", ")}
      </span>
    </p>
  );
}

function Stat({ label, value, sub, title }: { label: string; value: React.ReactNode; sub?: string; title?: string }) {
  return (
    <div className="rounded-lg border border-base-300 bg-base-200 px-3 py-2" title={title}>
      <div className="font-mono text-2xs uppercase tracking-wide text-base-content/50">{label}</div>
      <div className="font-mono text-sm font-semibold text-base-content">{value}</div>
      {sub && <div className="font-mono text-2xs text-base-content/40">{sub}</div>}
    </div>
  );
}

function CaseTable({ cases }: { cases: ReplayCase[] }) {
  const anyModel = cases.some((c) => c.model);
  return (
    <div className="overflow-x-auto rounded-xl border border-base-300 bg-base-200">
      <table className="w-full border-collapse text-sm">
        <thead>
          <tr className="bg-neutral text-2xs uppercase tracking-wide text-neutral-content/70">
            <th className="px-3 py-3 text-left font-semibold">case · arm</th>
            <th className="px-3 py-3 text-right font-semibold">units</th>
            <th className="px-3 py-3 text-right font-semibold">request chars</th>
            <th className="px-3 py-3 text-right font-semibold">truncated</th>
            <th className="px-3 py-3 text-right font-semibold" title={COVERAGE_HINT}>
              gold shown
            </th>
            {anyModel && (
              <>
                <th className="px-3 py-3 text-right font-semibold" title={CREDITED_HINT}>
                  credited — units vs agent
                </th>
                <th className="px-3 py-3 text-right font-semibold">hypotheses — units vs agent</th>
                <th className="px-3 py-3 text-right font-semibold">unit calls</th>
                <th className="px-3 py-3 text-right font-semibold">wall — units vs agent</th>
                <th className="px-3 py-3 text-right font-semibold">$ — units vs agent</th>
              </>
            )}
          </tr>
        </thead>
        <tbody>
          {cases.map((c) => {
            const row = caseRow(c);
            const oneSided = oneSidedGold(c);
            const span = anyModel ? 10 : 5;
            return (
              <Fragment key={row.key}>
                <tr className="border-t border-base-300 align-top">
                  <td className="px-3 py-2.5">
                    <div className="whitespace-nowrap font-mono text-sm text-base-content">
                      {row.instanceId.replace(/^prreview__/, "")}
                    </div>
                    <div className="whitespace-nowrap font-mono text-2xs text-base-content/50" title={row.fixture}>
                      {row.arm} · {row.gold} gold
                    </div>
                  </td>
                  {row.error ? (
                    <td colSpan={span - 1} className="px-3 py-2.5 font-mono text-2xs text-error">
                      errored — {row.error}
                    </td>
                  ) : (
                    <>
                      <Num>{row.units}</Num>
                      <Num>{row.requestChars}</Num>
                      <Num warn={row.truncated !== "0"}>{row.truncated}</Num>
                      <Num>{row.coverage}</Num>
                      {anyModel &&
                        (row.modelError ? (
                          <td colSpan={5} className="px-3 py-2.5 font-mono text-2xs text-error">
                            unit survey errored — {row.modelError}
                          </td>
                        ) : (
                          <>
                            <td className="px-3 py-2.5 text-right text-xs">
                              <Pair units={row.unitsCredited} agent={row.agentCredited} />
                            </td>
                            <td className="px-3 py-2.5 text-right text-xs">
                              <Pair units={row.unitsRows} agent={row.agentRows} />
                            </td>
                            <Num>{row.calls}</Num>
                            <td className="px-3 py-2.5 text-right text-xs">
                              <Pair units={row.unitsWall} agent={row.agentWall} />
                            </td>
                            <td className="px-3 py-2.5 text-right text-xs">
                              <Pair units={row.unitsCost} agent={row.agentCost} />
                            </td>
                          </>
                        ))}
                    </>
                  )}
                </tr>
                {oneSided.length > 0 && (
                  <tr className="bg-base-100/40">
                    <td colSpan={span} className="px-3 pb-2.5">
                      <OneSided items={oneSided} />
                    </td>
                  </tr>
                )}
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function Num({ children, warn = false }: { children: React.ReactNode; warn?: boolean }) {
  return (
    <td
      className={clsx(
        "whitespace-nowrap px-3 py-2.5 text-right font-mono text-xs tabular-nums",
        children === NA ? "text-base-content/40" : warn ? "text-warning" : "text-base-content",
      )}
    >
      {children}
    </td>
  );
}

/** The gold exactly one side's judge credited — collapsed to a count, expanded
 * to the gold text and the crediting rows. */
function OneSided({ items }: { items: OneSidedGold[] }) {
  const units = items.filter((i) => i.side === "units").length;
  const agent = items.length - units;
  return (
    <details className="rounded border border-base-300 bg-base-100">
      <summary className="cursor-pointer px-2.5 py-1.5 font-mono text-2xs uppercase tracking-wide text-base-content/50">
        gold only one side found — {units} units only · {agent} agent only
      </summary>
      <ul className="space-y-2 px-2.5 py-2">
        {items.map((i) => (
          <li key={`${i.side}-${i.index}`} className="font-mono text-2xs leading-5">
            <span
              className={clsx(
                "mr-2 rounded px-1.5 py-0.5 font-semibold",
                i.side === "units" ? "bg-info/15 text-info" : "bg-accent/15 text-accent",
              )}
            >
              only {i.side}
            </span>
            <span className="text-base-content/50">
              #{i.index + 1}
              {i.gold?.severity ? ` [${i.gold.severity}]` : ""}{" "}
              {i.gold?.file ? `${i.gold.file}:${i.gold.line ?? "?"}` : "(no file)"}
            </span>
            <div className="mt-0.5 text-base-content/80">{i.gold?.summary ?? "(gold text not in the report)"}</div>
            <div className="text-base-content/50">
              credited row{i.rows.length === 1 ? "" : "s"}:{" "}
              <span className="text-base-content/70">{i.rows.length ? i.rows.join(", ") : NA}</span>
              {i.creditVotes !== null && i.votes !== null && (
                <span className="text-base-content/40">
                  {" "}
                  · {i.creditVotes}/{i.votes} judge votes
                </span>
              )}
            </div>
          </li>
        ))}
      </ul>
    </details>
  );
}

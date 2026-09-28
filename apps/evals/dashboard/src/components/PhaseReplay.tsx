import clsx from "clsx";
import { useState } from "react";

import { phaseReplayStatus, phaseReplayTotals, type PhaseRange } from "../../../src/phase-replay.js";
import type { FalsifySite, SiteReviewSite, PhaseReplayCase, PhaseReplayEntry, PhaseReplayReport } from "../types";
import { usePhaseReplayReport } from "../lib/api";
import { fmtDate, fmtDuration, fmtTokens } from "../lib/format";
import { PHASE_REPLAY_TIER_KEY, useNavigate } from "../lib/router";
import { SessionModal, type SessionSource } from "./SessionModal";
import { HumanGradesBox } from "./Grade";

/**
 * Phase replays — `scripts/micro-falsify.ts`, `scripts/micro-adjudicate.ts`
 * and `scripts/micro-site-review.ts` rendered. One pr-review phase re-run over preserved fixtures, so a prompt,
 * model, skill or deterministic filter can be measured in minutes.
 *
 * Two rules, as on the unit-survey page: **n/a is not 0** (an audit ran no
 * model, so it has no cost and no wall clock; an unjudged grade has no F1),
 * and **ranges, not means** — a phase is sampled, so every per-case quality
 * number is shown as min–max across cases/repeats.
 */

const NA = "n/a";

const fmtUsd = (x: number | null) => (x === null ? NA : `$${x.toFixed(2)}`);
/** Summary calls cost fractions of a cent — show three places. */
const fmtUsdFine = (x: number | null) => (x === null ? NA : `$${x.toFixed(3)}`);
const fmtMs = (x: number | null) => (x === null ? NA : fmtDuration(x));
const fmtR = (r: PhaseRange | null) =>
  r === null ? NA : r.min === r.max ? r.min.toFixed(2) : `${r.min.toFixed(2)}–${r.max.toFixed(2)}`;

function KindChip({ kind }: { kind: PhaseReplayEntry["kind"] }) {
  return (
    <span
      className={clsx(
        "whitespace-nowrap rounded px-1.5 py-0.5 font-mono text-2xs font-semibold",
        kind === "adjudicate" ? "bg-accent/15 text-accent" : kind === "site-review" ? "bg-success/15 text-success" : "bg-info/15 text-info",
      )}
    >
      {kind}
    </span>
  );
}

function StatusChip({ entry }: { entry: Pick<PhaseReplayEntry, "status" | "heartbeat" | "error" | "planned"> & { done: number } }) {
  const s = phaseReplayStatus(entry, Date.now());
  const style = s === "running" ? "bg-success/15 text-success" : s === "done" ? "bg-base-300 text-base-content/60" : "bg-error/15 text-error";
  const title =
    s === "stale"
      ? `STALE — the report says running but nothing was written since ${entry.heartbeat ? fmtDate(entry.heartbeat) : "—"}. Killed?`
      : s === "failed"
        ? `FAILED: ${entry.error ?? "no error recorded"}`
        : undefined;
  return (
    <span className={clsx("inline-flex items-center gap-1.5 whitespace-nowrap rounded-full px-2 py-0.5 font-mono text-2xs font-semibold", style)} title={title}>
      {s === "running" && <span className="h-1.5 w-1.5 animate-pulse rounded-full bg-success" />}
      {s} · {entry.done}/{entry.planned}
    </span>
  );
}

/** The knobs this arm turned, one line. */
function configLine(e: Pick<PhaseReplayEntry, "kind" | "config" | "audit">): string {
  const c = e.config;
  const parts = [
    e.audit ? "audit (no model)" : `${c.model}${c.thinking ? ` · thinking ${c.thinking}` : ""}`,
    e.kind === "falsify"
      ? `${c.plan && c.plan !== "rows" ? `plan ${c.plan} ±${c.window} · ` : ""}max-probes ${c.maxProbes ?? "none"}`
      : e.kind === "site-review"
        ? `leads ${c.leads ?? "?"} · top ${c.topSites ?? "?"} sites ±${c.window ?? "?"} · span ≤${c.maxSpan ?? "∞"} · voters ${c.voters ?? "?"}${c.skipTests === false ? " · tests ranked" : ""}`
        : `admit ${c.rules ?? "all"}`,
  ];
  if (!e.audit) parts.push(`${c.rounds} round${c.rounds === 1 ? "" : "s"}`);
  if (c.promptOverride) parts.push(`prompt ${c.prompt.split("/").pop()}`);
  if (c.skillOverride && c.skill) parts.push(`skill ${c.skill.split("/").pop()}`);
  return parts.join(" · ");
}

// ── list ────────────────────────────────────────────────────────────────────

export function PhaseReplayList({ reports }: { reports: PhaseReplayEntry[] }) {
  const navigate = useNavigate();
  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold text-base-content">phase-replay</h1>
      <p className="mb-4 max-w-3xl font-mono text-xs text-base-content/50">
        {reports.length} report{reports.length === 1 ? "" : "s"} · one pr-review phase (falsify or adjudicate) replayed over
        preserved fixtures · click a report for its cases
      </p>
      <p className="mb-6 max-w-3xl text-2xs leading-5 text-base-content/50">
        <b className="font-semibold text-base-content/70">falsify</b>: of the rows <code>probe-plan</code> selected, how many
        got a verdict, and whether any row the judge matched to gold was <b>refuted</b> (the one outcome that loses recall).{" "}
        <b className="font-semibold text-base-content/70">adjudicate</b>: rows <code>admit</code> filed before the model, gold
        among them, and the judged P/R/F1 of the promoted findings — a range across cases.{" "}
        <b className="font-semibold text-base-content/70">site-review</b>: one investigator per top site; the findings
        written, the gold they state (judged) and their precision, beside the gold-mapped rows the selected sites hold.
      </p>
      <div className="overflow-x-auto rounded-xl border border-base-300">
        <table className="w-full font-mono text-xs">
          <thead className="bg-base-200 text-left text-2xs uppercase tracking-wide text-base-content/50">
            <tr>
              <th className="px-3 py-2">report</th>
              <th className="px-3 py-2">status</th>
              <th className="px-3 py-2">config</th>
              <th className="whitespace-nowrap px-3 py-2 text-right">rows</th>
              <th className="whitespace-nowrap px-3 py-2">phase result</th>
              <th className="whitespace-nowrap px-3 py-2 text-right">wall p50 / max</th>
              <th className="whitespace-nowrap px-3 py-2 text-right">out tok</th>
              <th className="whitespace-nowrap px-3 py-2 text-right">$</th>
            </tr>
          </thead>
          <tbody>
            {reports.map((e) => (
              <tr
                key={e.id}
                onClick={() => navigate(PHASE_REPLAY_TIER_KEY, e.id)}
                className="cursor-pointer border-t border-base-300 hover:bg-base-200/60"
              >
                <td className="px-3 py-2">
                  <div className="flex items-center gap-2">
                    <KindChip kind={e.kind} />
                    <span className="font-semibold text-base-content">{e.label}</span>
                  </div>
                  <div className="text-2xs text-base-content/40">{fmtDate(e.generatedAt)}</div>
                </td>
                <td className="px-3 py-2">
                  <StatusChip entry={{ ...e, done: e.totals.cases }} />
                  {e.totals.errored > 0 && <div className="mt-1 text-2xs text-error">{e.totals.errored} errored</div>}
                </td>
                <td className="max-w-sm px-3 py-2 text-2xs text-base-content/70">{configLine(e)}</td>
                <td className="px-3 py-2 text-right tabular-nums">{e.totals.rows}</td>
                <td className="min-w-[20rem] px-3 py-2 text-2xs">
                  <ResultCell entry={e} />
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">
                  {fmtMs(e.totals.wallMedianMs)} / {fmtMs(e.totals.wallMaxMs)}
                </td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{e.totals.outputTokens === null ? NA : fmtTokens(e.totals.outputTokens)}</td>
                <td className="whitespace-nowrap px-3 py-2 text-right tabular-nums">{fmtUsd(e.totals.costUsd)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function ResultCell({ entry }: { entry: Pick<PhaseReplayEntry, "totals" | "audit"> }) {
  const t = entry.totals;
  if (t.falsify) {
    const f = t.falsify;
    return (
      <div className="space-y-0.5">
        <div>
          selected {f.selected}/{f.owed} · answered {entry.audit ? NA : f.answered}
          {f.sites !== null && ` · ${f.sites} sites${f.claims !== null ? ` · ${f.claims} claims` : ""}`}
        </div>
        <div className={clsx((f.goldRefuted ?? 0) > 0 ? "font-semibold text-error" : "text-base-content/60")}>
          {f.goldSelected === null
            ? "gold n/a — not judged"
            : `gold selected ${f.goldSelected} · refuted ${f.goldRefuted} · reproduced ${f.goldReproduced}`}
        </div>
      </div>
    );
  }
  if (t.siteReview) {
    const r = t.siteReview;
    return (
      <div className="space-y-0.5">
        <div>
          {r.sites} sites · {r.rowsInSites} rows · {r.leads} leads · gold in sites {r.goldInSites ?? "n/a"}
        </div>
        {r.summary && (
          <div className="text-base-content/70">
            summaries: {r.summary.concerns} concerns
            {r.summary.uncovered > 0 && <span className="text-warning"> ({r.summary.uncovered} rows unmerged)</span>}
            {r.summary.fallbacks > 0 && <span className="text-warning"> · {r.summary.fallbacks} fallback</span>} · {fmtUsdFine(r.summary.costUsd)}
          </div>
        )}
        {!entry.audit && (
          <div className="text-base-content/70">
            findings {r.findings ?? NA} ({r.noneSites ?? NA} none) · gold stated {r.goldStated ?? NA} · P{" "}
            {r.precision === null ? NA : r.precision.toFixed(2)}
            {r.gateFailures > 0 && <span className="text-warning"> · {r.gateFailures} gate unsat</span>}
          </div>
        )}
      </div>
    );
  }
  if (t.adjudicate) {
    const a = t.adjudicate;
    return (
      <div className="space-y-0.5">
        <div>
          admitted {a.admitted} · filed {a.filed}
          <span className={clsx("ml-1", (a.goldFiled ?? 0) > 0 ? "font-semibold text-error" : "text-base-content/60")}>
            (gold {a.goldFiled ?? "n/a — not judged"})
          </span>
        </div>
        {!entry.audit && (
          <div className="text-base-content/70">
            F1 {fmtR(a.f1)} · P {fmtR(a.precision)} · R {fmtR(a.recall)} · promoted {a.promoted}
          </div>
        )}
      </div>
    );
  }
  return <span className="text-base-content/40">{NA}</span>;
}

// ── detail ──────────────────────────────────────────────────────────────────

export function PhaseReplayDetail({ entry }: { entry: PhaseReplayEntry }) {
  const live = phaseReplayStatus(entry, Date.now()) === "running";
  const { data: report, error } = usePhaseReplayReport(entry.report, live);
  return (
    <div>
      <div className="mb-1 flex items-center gap-2">
        <KindChip kind={entry.kind} />
        <h1 className="text-2xl font-semibold text-base-content">{entry.label}</h1>
        <StatusChip entry={{ ...entry, done: report?.cases.length ?? entry.totals.cases }} />
      </div>
      <p className="mb-4 font-mono text-xs text-base-content/50">
        {fmtDate(entry.generatedAt)} · {configLine(entry)}
        {entry.config.judgeModel ? ` · judge ${entry.config.judgeModel}` : " · no judge — no gold map"}
      </p>
      {entry.error && (
        <div className="mb-4 rounded-lg border border-error/40 bg-error/10 px-3 py-2 font-mono text-2xs text-error">{entry.error}</div>
      )}
      {error && <div className="font-mono text-xs text-error">could not load the report: {(error as Error).message}</div>}
      {entry.kind === "site-review" && !entry.audit && <HumanGradesBox reportId={entry.id} reportLabel={entry.label} />}
      {report && <InFlight report={report} live={live} />}
      {report && <CaseTable report={report} />}
    </div>
  );
}

/** A transcript button — the same live viewer the eval runs use. */
function LogButton({ title, url, live }: { title: string; url: string; live: boolean }) {
  const [open, setOpen] = useState<SessionSource | null>(null);
  return (
    <>
      <button
        onClick={(e) => {
          e.stopPropagation();
          setOpen({ kind: "live", title, url });
        }}
        className={clsx("rounded border px-1.5 py-0.5 font-mono text-2xs", live ? "border-accent text-accent" : "border-base-300 text-base-content/60 hover:border-info")}
      >
        {live ? "● follow log" : "log"}
      </button>
      {open && <SessionModal source={open} onClose={() => setOpen(null)} />}
    </>
  );
}

/** Cases running right now, each with its live transcript — so a stalled
 * case is visible as stalled, not hidden behind a "running" chip. */
function InFlight({ report, live }: { report: PhaseReplayReport; live: boolean }) {
  const rows = live ? (report.inFlight ?? []) : [];
  if (!rows.length) return null;
  return (
    <div className="mb-4 rounded-xl border border-accent/40 bg-accent/5 px-4 py-3">
      <div className="mb-2 font-mono text-2xs font-semibold uppercase tracking-wide text-accent">in flight</div>
      {rows.map((f) => (
        <div key={`${f.arm}/${f.instanceId}/${f.repeat}/${f.site ?? ""}`} className="flex items-center gap-3 py-1 font-mono text-xs">
          <span className="text-base-content">
            {f.instanceId.replace(/^prreview__/, "")}
            {f.site && <span className="text-accent"> · {f.site}</span>}
          </span>
          <span className="text-2xs text-base-content/40">
            {f.arm} · repeat {f.repeat} · started {fmtDate(f.startedAt)}
          </span>
          <LogButton title={`${report.kind} · ${f.instanceId} · ${f.arm} r${f.repeat}${f.site ? ` · ${f.site}` : ""}`} url={f.session} live />
        </div>
      ))}
    </div>
  );
}

function CaseTable({ report }: { report: PhaseReplayReport }) {
  const totals = phaseReplayTotals(report);
  const isF = report.kind === "falsify";
  const isS = report.kind === "site-review";
  return (
    <div className="overflow-x-auto rounded-xl border border-base-300">
      <table className="w-full font-mono text-xs">
        <thead className="bg-base-200 text-left text-2xs uppercase tracking-wide text-base-content/50">
          <tr>
            <th className="px-3 py-2">case</th>
            <th className="px-3 py-2 text-right">rows</th>
            {isS ? (
              <>
                <th className="px-3 py-2">sites</th>
                <th className="px-3 py-2">findings</th>
                <th className="px-3 py-2">gold stated</th>
                <th className="px-3 py-2 text-right">P</th>
              </>
            ) : isF ? (
              <>
                <th className="px-3 py-2">plan</th>
                <th className="px-3 py-2">verdicts</th>
                <th className="px-3 py-2">gold rows</th>
              </>
            ) : (
              <>
                <th className="px-3 py-2">admission</th>
                <th className="px-3 py-2">dispositions</th>
                <th className="px-3 py-2">gold</th>
                <th className="px-3 py-2 text-right">P / R / F1</th>
              </>
            )}
            <th className="px-3 py-2 text-right">wall</th>
            <th className="px-3 py-2 text-right">turns</th>
            <th className="px-3 py-2 text-right">out tok</th>
            <th className="px-3 py-2 text-right">$</th>
          </tr>
        </thead>
        <tbody>
          {report.cases.map((c) => (
            <tr key={`${c.arm}/${c.instanceId}/${c.repeat}`} className="border-t border-base-300 align-top">
              <td className="px-3 py-2">
                <div className="text-base-content">{c.instanceId.replace(/^prreview__/, "")}</div>
                <div className="text-2xs text-base-content/40">
                  {c.arm} · repeat {c.repeat}
                  {c.iterations !== null && ` · ${c.iterations} iter`}
                </div>
                {!c.ok && <div className="mt-1 max-w-xs text-2xs text-error">{c.error}</div>}
                {c.session && (
                  <div className="mt-1">
                    <LogButton title={`${report.kind} · ${c.instanceId} · ${c.arm} r${c.repeat}`} url={c.session} live={false} />
                  </div>
                )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{c.rows}</td>
              {isS ? <SiteReviewCells c={c} audit={report.audit} /> : isF ? <FalsifyCells c={c} audit={report.audit} /> : <AdjudicateCells c={c} audit={report.audit} />}
              <td className="px-3 py-2 text-right tabular-nums">{fmtMs(c.wallMs)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{c.turns ?? NA}</td>
              <td className="px-3 py-2 text-right tabular-nums">{c.outputTokens === null ? NA : fmtTokens(c.outputTokens)}</td>
              <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(c.costUsd)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot className="border-t-2 border-base-300 bg-base-200/60 text-2xs">
          <tr>
            <td className="px-3 py-2 font-semibold">
              {totals.cases} case{totals.cases === 1 ? "" : "s"}
              {report.status === "running" && <span className="ml-1 text-warning">(partial)</span>}
            </td>
            <td className="px-3 py-2 text-right tabular-nums">{totals.rows}</td>
            <td className="px-3 py-2" colSpan={isF ? 3 : 4}>
              <ResultCell entry={{ totals, audit: report.audit }} />
            </td>
            <td className="px-3 py-2 text-right tabular-nums">p50 {fmtMs(totals.wallMedianMs)}</td>
            <td />
            <td className="px-3 py-2 text-right tabular-nums">{totals.outputTokens === null ? NA : fmtTokens(totals.outputTokens)}</td>
            <td className="px-3 py-2 text-right tabular-nums">{fmtUsd(totals.costUsd)}</td>
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function goldCell(c: PhaseReplayCase): string {
  if (c.goldRows === null) return `${c.gold.length} gold · unjudged`;
  const mapped = c.goldRows.filter((x) => x !== null).length;
  return `${mapped}/${c.gold.length} gold matched a row`;
}

/** An audit ran no model: the phase's own outputs do not exist, which is not zero. */
const NOT_RUN = <span className="text-base-content/40">not run (audit)</span>;

function FalsifyCells({ c, audit }: { c: PhaseReplayCase; audit: boolean }) {
  const f = c.falsify;
  if (!f) return <td className="px-3 py-2 text-base-content/40" colSpan={3}>{NA}</td>;
  return (
    <>
      <td className="px-3 py-2 text-2xs">
        {f.selected} of {f.owed} owed{f.deferred ? ` · ${f.deferred} deferred` : ""}
        {!audit && (
          <div className={clsx(f.gateSatisfied ? "text-base-content/40" : "text-warning")}>
            gate {f.gateSatisfied ? "pass" : `${f.gaps} gap${f.gaps === 1 ? "" : "s"}`}
          </div>
        )}
      </td>
      <td className="px-3 py-2 text-2xs">
        {audit ? NOT_RUN : Object.entries(f.verdicts)
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([k, v]) => `${k} ${v}`)
          .join(" · ") || "none"}
      </td>
      <td className="px-3 py-2 text-2xs">
        <div className="text-base-content/60">
          {goldCell(c)}
          {c.goldRows !== null && ` · ${f.goldSelected.length} selected`}
        </div>
        {f.goldRefuted.length > 0 && <div className="font-semibold text-error">refuted {f.goldRefuted.join(", ")}</div>}
        {f.goldReproduced.length > 0 && <div className="text-success">reproduced {f.goldReproduced.join(", ")}</div>}
        {f.sites && <SiteList sites={f.sites} caseLabel={c.instanceId} audit={audit} />}
      </td>
    </>
  );
}

/** `--plan sites:<k>`: one falsify session per site. */
function SiteList({ sites, caseLabel, audit }: { sites: FalsifySite[]; caseLabel: string; audit: boolean }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-base-content/50">
        {sites.length} site{sites.length === 1 ? "" : "s"} ({sites.filter((x) => x.origin === "owed").length} owed)
      </summary>
      <ul className="mt-1 space-y-1">
        {sites.map((x) => (
          <li key={x.id} className={clsx(!x.ok && "text-error")}>
            <span className={clsx(x.gold.length > 0 && "font-semibold")}>{x.id}</span>{" "}
            <span className="text-base-content/40">
              {x.path ? `${x.path.split("/").pop()}${x.startLine !== null ? `:${x.startLine}–${x.endLine}` : ""}` : "unanchored"} · {x.rows} row{x.rows === 1 ? "" : "s"}
              {x.gold.length > 0 && ` · gold ${x.gold.join(", ")}`}
            </span>
            {!audit && (
              <div className="text-base-content/60">
                {Object.entries(x.verdicts)
                  .sort(([a], [b]) => a.localeCompare(b))
                  .map(([k, v]) => `${k} ${v}`)
                  .join(" · ") || "none"}
                {x.claims !== null && ` · ${x.claims} claim${x.claims === 1 ? "" : "s"}`}
                {x.gateSatisfied === false && <span className="text-warning"> · gate unsatisfied</span>}
                {x.gapsByRound?.some((g) => Object.keys(g).length > 0) && (
                  <div className="text-warning/80" title={(x.gateNotes ?? []).join("\n")}>
                    gate gaps by round:{" "}
                    {x.gapsByRound
                      .map((g, i) => `r${i + 1} ${Object.entries(g).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`)
                      .join(" → ")}
                  </div>
                )}
                {x.wallMs !== null && ` · ${fmtMs(x.wallMs)} · ${fmtUsd(x.costUsd)}`}
                {x.error && <span className="text-error"> · {x.error}</span>}
                {x.session && (
                  <span className="ml-1">
                    <LogButton title={`falsify · ${caseLabel} · ${x.id}`} url={x.session} live={false} />
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

function AdjudicateCells({ c, audit }: { c: PhaseReplayCase; audit: boolean }) {
  const a = c.adjudicate;
  if (!a) return <td className="px-3 py-2 text-base-content/40" colSpan={4}>{NA}</td>;
  const g = a.grade;
  return (
    <>
      <td className="px-3 py-2 text-2xs">
        admitted {a.admitted} · filed {a.filed}
        <div className="text-base-content/40">
          {Object.entries(a.filedByRule)
            .map(([k, v]) => `${k} ${v}`)
            .join(" · ")}
        </div>
      </td>
      <td className="px-3 py-2 text-2xs">
        {audit ? (
          NOT_RUN
        ) : (
          <>
            inline {a.promotedInline} · body {a.promotedBody} · internal {a.internal} · dropped {a.dropped}
            {!a.gateSatisfied && <div className="text-warning">gate unsatisfied — repaired</div>}
          </>
        )}
      </td>
      <td className="px-3 py-2 text-2xs">
        <div className="text-base-content/60">{goldCell(c)}</div>
        {a.goldFiled.length > 0 && <div className="font-semibold text-error">filed by admit: {a.goldFiled.join(", ")}</div>}
        {a.goldPromoted !== null && <div>promoted {a.goldPromoted}</div>}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {g === null ? NA : g.error ? <span className="text-error" title={g.error}>judge failed</span> : `${g.precision.toFixed(2)} / ${g.recall.toFixed(2)} / ${g.f1.toFixed(2)}`}
      </td>
    </>
  );
}

function SiteReviewCells({ c, audit }: { c: PhaseReplayCase; audit: boolean }) {
  const r = c.siteReview;
  if (!r) return <td className="px-3 py-2 text-base-content/40" colSpan={4}>{NA}</td>;
  const matched = r.matchedFindings;
  return (
    <>
      <td className="px-3 py-2 text-2xs">
        {r.sites.length} of {r.sitesFormed} sites · {r.sites.reduce((a, s) => a + s.rows, 0)} rows
        {r.skippedRows > 0 && <span className="text-base-content/40"> · {r.skippedRows} test rows skipped</span>}
        <div className="text-base-content/60">
          {goldCell(c)}
          {c.goldRows !== null && ` · ${r.goldInSites.length} in sites`}
        </div>
        <SiteReviewList sites={r.sites} caseLabel={c.instanceId} audit={audit} />
      </td>
      <td className="px-3 py-2 text-2xs">
        {audit ? (
          NOT_RUN
        ) : (
          <>
            {r.findings.length} finding{r.findings.length === 1 ? "" : "s"} · {r.sites.filter((s) => s.none).length} none
            <ul className="mt-1 space-y-0.5">
              {r.findings.map((f, i) => (
                <li key={i} className={clsx(typeof f.gold === "number" ? "font-semibold text-success" : "text-base-content/60")}>
                  {f.site} {f.path.split("/").pop()}:{f.line} [{f.strength}] {f.title}
                  {typeof f.gold === "number" && ` → gold ${f.gold + 1}`}
                </li>
              ))}
            </ul>
          </>
        )}
      </td>
      <td className="px-3 py-2 text-2xs">
        {audit ? NOT_RUN : r.goldStated === null ? (
          <span className={clsx(r.judgeError ? "text-error" : "text-base-content/40")} title={r.judgeError ?? undefined}>
            {r.judgeError ? "judge failed" : "n/a — not judged"}
          </span>
        ) : (
          `${r.goldStated.length}/${c.gold.length}${r.goldStated.length ? ` (${r.goldStated.map((g) => g + 1).join(", ")})` : ""}`
        )}
      </td>
      <td className="px-3 py-2 text-right tabular-nums">
        {audit || matched === null || r.findings.length === 0 ? NA : `${(matched / r.findings.length).toFixed(2)} (${matched}/${r.findings.length})`}
      </td>
    </>
  );
}

/** One investigator session per site. */
function SiteReviewList({ sites, caseLabel, audit }: { sites: SiteReviewSite[]; caseLabel: string; audit: boolean }) {
  return (
    <details className="mt-1">
      <summary className="cursor-pointer text-base-content/50">
        {sites.length} site{sites.length === 1 ? "" : "s"}
      </summary>
      <ul className="mt-1 space-y-1">
        {sites.map((x) => (
          <li key={x.id} className={clsx(!x.ok && "text-error")}>
            <span className={clsx(x.gold.length > 0 && "font-semibold")}>{x.id}</span>{" "}
            <span className="text-base-content/40">
              {x.path ? `${x.path.split("/").pop()}${x.startLine !== null ? `:${x.startLine}–${x.endLine}` : ""}` : "unanchored"} · {x.rows} row
              {x.rows === 1 ? "" : "s"} · {x.voters} voter{x.voters === 1 ? "" : "s"} · {x.leads} lead{x.leads === 1 ? "" : "s"}
              {x.gold.length > 0 && ` · gold ${x.gold.join(", ")}`}
            </span>
            {x.summary && <SiteSummaryDetails site={x} />}
            {!audit && (
              <div className="text-base-content/60">
                {x.none ? "none" : `${x.findings ?? NA} finding${x.findings === 1 ? "" : "s"}`}
                {x.gateSatisfied === false && <span className="text-warning"> · gate unsatisfied</span>}
                {x.gapsByRound?.some((g) => Object.keys(g).length > 0) && (
                  <div className="text-warning/80" title={(x.gateNotes ?? []).join("\n")}>
                    gate gaps by round:{" "}
                    {x.gapsByRound
                      .map((g, i) => `r${i + 1} ${Object.entries(g).map(([k, v]) => `${k} ${v}`).join(", ") || "none"}`)
                      .join(" → ")}
                  </div>
                )}
                {x.wallMs !== null && ` · ${fmtMs(x.wallMs)} · ${x.turns ?? NA} turns · ${fmtUsd(x.costUsd)}`}
                {x.error && <span className="text-error"> · {x.error}</span>}
                {x.session && (
                  <span className="ml-1">
                    <LogButton title={`site-review · ${caseLabel} · ${x.id}`} url={x.session} live={false} />
                  </span>
                )}
              </div>
            )}
          </li>
        ))}
      </ul>
    </details>
  );
}

/** Arm C: the site's rows merged into concerns (gold-mapped rows in bold, `*` = the concern's specific row). */
function SiteSummaryDetails({ site }: { site: SiteReviewSite }) {
  const sum = site.summary!;
  const gold = new Set(site.gold);
  const ids = (rows: string[], specific: string | null) =>
    rows.map((id, i) => (
      <span key={id} className={clsx(gold.has(id) && "font-semibold text-success")}>
        {i > 0 && ", "}
        {id}
        {id === specific && "*"}
      </span>
    ));
  return (
    <details className="ml-2">
      <summary className="cursor-pointer text-base-content/50">
        summary: {sum.concerns.length} concern{sum.concerns.length === 1 ? "" : "s"} (cap {sum.maxConcerns})
        {sum.uncovered.length > 0 && <span className="text-warning"> · {sum.uncovered.length} rows unmerged</span>}
        {sum.fallback && <span className="text-warning"> · fallback to subject leads</span>} · {fmtUsdFine(sum.costUsd)}
        {sum.cached && " · cached"}
      </summary>
      <ol className="ml-4 list-decimal space-y-0.5">
        {sum.concerns.map((c, i) => (
          <li key={i} className={clsx(c.unmerged && "text-warning/80")}>
            {c.concern}
            <span className="text-base-content/40">
              {c.line !== null && ` · L${c.line}`} · [{ids(c.rows, c.specific)}]
            </span>
          </li>
        ))}
      </ol>
      {sum.errors.length > 0 && <div className="text-warning/80">rejected: {sum.errors.join(" | ")}</div>}
    </details>
  );
}

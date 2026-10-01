import { useState, type ReactNode } from "react";
import clsx from "clsx";
import type { LedgerFinding, ReviewCoverageUnit, ReviewLedger, WorkflowRun } from "../api";
import {
  dispatchedLedgerOf,
  groupLedgerFindings,
  pct,
  reviewCoverageOf,
  reviewLedgerOf,
  sortCoverageUnits,
  unitLocation,
  weighted,
} from "../lib/review-ledger";

/**
 * Repos → Workflows → Review: pr-review's coverage report and the PR's review
 * ledger (issue #429), as `post-review` recorded them on the run.
 *
 * Coverage answers "what did this review actually look at" — units surveyed by
 * a model call, units an investigator worked — over the IN-SCOPE units; on a
 * re-review, `unchanged` units are carried from the last round and counted
 * separately. The ledger answers "what has every review of this PR found, and
 * what became of it". Everything is read off the run row; nothing is
 * recomputed here. Renders nothing when the run carries neither (analysis off,
 * or a run from before the ledger existed) — the tab is gated on the same
 * readers, so in practice that branch is a guard.
 */

const RISK_TONE: Record<string, string> = {
  critical: "bg-error/20 text-error",
  high: "bg-warning/20 text-warning",
  medium: "bg-info/15 text-info",
  low: "bg-base-300 text-muted",
};

const DELTA_TONE: Record<string, string> = {
  new: "bg-success/20 text-success",
  changed: "bg-warning/20 text-warning",
  affected: "bg-info/15 text-info",
  unchanged: "bg-base-300 text-faint",
};

const STATUS_TONE: Record<string, string> = {
  open: "text-warning",
  withheld: "text-muted",
  addressed: "text-success",
  resolved: "text-success",
};

/** Units shown before the table collapses behind a "show all". */
const UNIT_PREVIEW = 12;

function Chip({ text, tone }: { text: string; tone?: string }) {
  return (
    <span
      className={clsx(
        "rounded px-1.5 py-0.5 text-[10px] font-medium whitespace-nowrap",
        tone ?? "bg-base-300 text-muted",
      )}
    >
      {text}
    </span>
  );
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-faint">{label}</span>
      <span className="font-mono text-xs text-strong">{value}</span>
      {hint && <span className="text-[10px] text-muted">{hint}</span>}
    </div>
  );
}

function Heading({ children }: { children: ReactNode }) {
  return <h4 className="mb-1 text-[10px] uppercase tracking-wide text-faint">{children}</h4>;
}

const shortSha = (s: string | null | undefined) => (s ? s.slice(0, 7) : "—");

function UnitRow({ u }: { u: ReviewCoverageUnit }) {
  return (
    <tr className="border-t border-hairline">
      <td className="py-0.5 pr-2 font-mono text-[11px] text-strong break-all" title={u.key}>
        {unitLocation(u)}
      </td>
      <td className="py-0.5 pr-2 text-right font-mono text-[11px] text-muted">{u.touched}</td>
      <td className="py-0.5 pr-2">
        <Chip text={u.risk} tone={RISK_TONE[u.risk]} />
      </td>
      <td className="py-0.5 pr-2">
        {u.delta ? <Chip text={u.delta} tone={DELTA_TONE[u.delta]} /> : <span className="text-faint">–</span>}
      </td>
      <td className={clsx("py-0.5 pr-2 text-center", u.surveyed ? "text-success" : "text-faint")}>
        {u.surveyed ? "✓" : "–"}
      </td>
      <td className="py-0.5 text-[11px]">
        {u.investigated === "findings" ? (
          <span className="text-warning">findings</span>
        ) : u.investigated === "none" ? (
          <span className="text-muted">none</span>
        ) : (
          <span className="text-faint">–</span>
        )}
      </td>
    </tr>
  );
}

function CoverageSection({ run }: { run: WorkflowRun }) {
  const [allUnits, setAllUnits] = useState(false);
  const cov = reviewCoverageOf(run);
  if (!cov) return null;
  const s = cov.inScope;
  const units = sortCoverageUnits(cov.units);
  const shown = allUnits ? units : units.slice(0, UNIT_PREVIEW);

  return (
    <div className="space-y-3">
      <div>
        <Heading>Coverage{cov.rereview ? " — re-review" : ""}</Heading>
        <div className="grid grid-cols-1 gap-x-6 gap-y-2 @xs:grid-cols-2 @2xl:grid-cols-4">
          <Fact label="in scope" value={`${s.units} units · ${s.touched} lines`} />
          <Fact
            label="surveyed"
            value={`${s.surveyedUnits}/${s.units} units · ${pct(s.surveyedTouched, s.touched)} lines`}
            hint={`${weighted(s.surveyedWeighted)} risk-weighted`}
          />
          <Fact
            label="investigated"
            value={`${s.investigatedUnits}/${s.units} units · ${pct(s.investigatedTouched, s.touched)} lines`}
            hint={`${weighted(s.investigatedWeighted)} risk-weighted`}
          />
          {cov.rereview && (
            <Fact
              label="carried"
              value={`${cov.carried.units} units · ${cov.carried.touched} lines`}
              hint="unchanged since the last review"
            />
          )}
        </div>
      </div>

      {cov.notInvestigated.length > 0 && (
        <div>
          <Heading>Not investigated ({cov.notInvestigated.length}) — highest risk first</Heading>
          <div className="flex flex-wrap gap-1">
            {cov.notInvestigated.map((k) => (
              <code key={k} className="rounded bg-base-300 px-1.5 py-0.5 font-mono text-[10px] text-muted">
                {k}
              </code>
            ))}
          </div>
        </div>
      )}

      {units.length > 0 && (
        <div>
          <Heading>Units ({units.length})</Heading>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-[10px] uppercase tracking-wide text-faint">
                  <th className="pb-1 pr-2 font-normal">unit</th>
                  <th className="pb-1 pr-2 text-right font-normal">touched</th>
                  <th className="pb-1 pr-2 font-normal">risk</th>
                  <th className="pb-1 pr-2 font-normal">delta</th>
                  <th className="pb-1 pr-2 text-center font-normal">surveyed</th>
                  <th className="pb-1 font-normal">investigated</th>
                </tr>
              </thead>
              <tbody>
                {shown.map((u) => (
                  <UnitRow key={u.key} u={u} />
                ))}
              </tbody>
            </table>
          </div>
          {units.length > UNIT_PREVIEW && (
            <button
              type="button"
              onClick={() => setAllUnits((v) => !v)}
              className="mt-1 text-[11px] text-faint hover:text-strong"
            >
              {allUnits ? "show fewer" : `show all ${units.length} units`}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function FindingRow({ f }: { f: LedgerFinding }) {
  const where = f.line != null ? `${f.path}:${f.line}` : f.path;
  const grade = [f.importance, f.severity].filter(Boolean).join(" / ");
  return (
    <li className="py-1">
      <div className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5">
        <span className="text-[11px] text-strong">{f.title || "(untitled)"}</span>
        {grade && <Chip text={grade} />}
        <Chip text={f.tier} tone={f.tier === "inline" ? "bg-info/15 text-info" : undefined} />
      </div>
      <div className="mt-0.5 flex flex-wrap gap-x-2 font-mono text-[10px] text-muted">
        <span className="break-all">{where}</span>
        <span>
          found {shortSha(f.foundAt)} · seen {shortSha(f.lastSeenAt)}
          {f.closedAt ? ` · closed ${shortSha(f.closedAt)}` : ""}
        </span>
      </div>
      {f.reason && <div className="mt-0.5 text-[10px] text-faint">{f.reason}</div>}
    </li>
  );
}

function LedgerSection({ ledger, label }: { ledger: ReviewLedger; label: string }) {
  const groups = groupLedgerFindings(ledger.findings);
  return (
    <div className="space-y-2">
      <div>
        <Heading>{label}</Heading>
        <div className="flex flex-wrap gap-x-3 font-mono text-[11px] text-muted">
          <span>
            {ledger.rounds} round{ledger.rounds === 1 ? "" : "s"}
          </span>
          <span>head {shortSha(ledger.head)}</span>
          <span>{ledger.findings.length} findings</span>
          <span>{ledger.units.length} units remembered</span>
          {ledger.truncated && <span className="text-warning">truncated at the cap</span>}
        </div>
      </div>
      {groups.length === 0 ? (
        <p className="text-[11px] text-muted">No findings recorded.</p>
      ) : (
        groups.map((g) => (
          <div key={g.status}>
            <div className={clsx("text-[11px] font-semibold", STATUS_TONE[g.status] ?? "text-strong")}>
              {g.status} ({g.findings.length})
            </div>
            <ul className="divide-y divide-hairline">
              {g.findings.map((f) => (
                <FindingRow key={f.fp} f={f} />
              ))}
            </ul>
          </div>
        ))
      )}
    </div>
  );
}

export function ReviewLedgerPanel({ run }: { run: WorkflowRun }) {
  const coverage = reviewCoverageOf(run);
  const ledger = reviewLedgerOf(run);
  const dispatched = dispatchedLedgerOf(run);
  if (!coverage && !ledger && !dispatched) return null;

  return (
    <section className="@container space-y-4 px-3 py-2.5">
      {coverage && <CoverageSection run={run} />}
      {ledger ? (
        <LedgerSection ledger={ledger} label="Review ledger — after this round" />
      ) : (
        dispatched && (
          // The run never folded its own round in (it stopped before
          // post-review, or posted nothing) — show what it started from.
          <LedgerSection ledger={dispatched} label="Review ledger — at dispatch (this round not folded in)" />
        )
      )}
      {ledger && dispatched && (
        <p className="text-[10px] text-faint">
          Dispatched with {dispatched.rounds} round{dispatched.rounds === 1 ? "" : "s"} at{" "}
          {shortSha(dispatched.head)} · {dispatched.findings.length} findings.
        </p>
      )}
    </section>
  );
}

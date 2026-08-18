import { useState } from "react";
import clsx from "clsx";
import type { WorkflowRun } from "../api";

/**
 * Repos → Workflows: the `PrState` snapshot a PR-scoped run was dispatched on
 * (09-state-machine.md §S3).
 *
 * The snapshot is resolved ONCE per dispatch, before any phase runs, and
 * persisted whole on `context.prState` — so this panel is a record of what the
 * harness believed and decided at the moment it committed to the run, not a
 * live read. That is the useful thing about it: by the time anyone asks "why
 * did it do that", the PR has moved on.
 *
 * ## Nothing here is recomputed
 *
 * §S3's rule: *"the reason must be produced by the decision, not reconstructed
 * by the view"*. Every verdict below is read off the run row —
 * `mayMerge`/`mayMergeReason` from the dispatch-time projection, the escalation
 * case from the row `pr-escalation.ts` wrote, the gate script and the attempt
 * markers from the harvest. This component derives no policy of its own; where
 * a fact was not recorded it says so rather than inferring one.
 *
 * ## Why the snapshot is read untyped
 *
 * The dashboard has no import edge to core, so any mirrored `PrState`
 * interface here would be a second copy free to drift — which is exactly the
 * defect that left `fix` / `dependencies` / `review` invisible on the Config
 * tab for a release (#256). Fields are read defensively by name, and the raw
 * JSON is one click away, so a field added to `PrState` shows up in the panel
 * the day it ships even though this file never mentioned it.
 */

type Dict = Record<string, unknown>;

const asDict = (v: unknown): Dict | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : null;
const str = (v: unknown): string | null => (typeof v === "string" && v ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" ? v : null);
const list = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);

/** One `label: value` cell of the facts grid. */
function Fact({ label, value, tone }: { label: string; value: string; tone?: "warn" | "bad" }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-base-content/40">{label}</span>
      <span
        className={clsx(
          "font-mono text-xs",
          tone === "bad" ? "text-error" : tone === "warn" ? "text-warning" : "text-base-content/80",
        )}
      >
        {value}
      </span>
    </div>
  );
}

/** A `{decision, reason}` pair as the decision produced it. */
function Verdict({ name, decision, reason }: { name: string; decision: string; reason: string }) {
  const bad = decision === "skip" || decision === "false" || decision === "no";
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1">
      <code className="font-mono text-[11px] text-base-content/70">{name}</code>
      <span
        className={clsx(
          "rounded px-1.5 py-0.5 text-[10px] font-medium",
          bad ? "bg-warning/20 text-warning" : "bg-success/20 text-success",
        )}
      >
        {decision}
      </span>
      <span className="text-[11px] text-base-content/60">{reason}</span>
    </li>
  );
}

const CHECKS_TONE: Record<string, "warn" | "bad" | undefined> = {
  failing: "bad",
  pending: "warn",
  none: "warn",
};

export function PrStatePanel({ run }: { run: WorkflowRun }) {
  const [open, setOpen] = useState(false);
  const [rawOpen, setRawOpen] = useState(false);

  const ctx = (run.context ?? {}) as Dict;
  const state = asDict(ctx.prState);
  // A run carries `prState` iff the dispatcher resolved a snapshot for it,
  // which is the definition of PR-scoped — so this is also the gate on whether
  // the panel appears at all. No workflow-name list to keep in step.
  if (!state) return null;

  const escalation = asDict(ctx.escalation);
  const harvest = asDict((run.scratch as Dict | undefined)?.fixMarkers);
  const diagnosis = asDict(harvest?.diagnosis);
  const fixMarker = asDict(harvest?.fix);
  const verifyScript = str(harvest?.verifyScript);
  const notes = list(state.notes) as Dict[];
  const priorAttempts = list(state.priorAttempts).filter((a): a is string => typeof a === "string");
  const readErrors = list(state.readErrors).filter((e): e is string => typeof e === "string");
  const runInFlight = asDict(state.runInFlight);
  // The retry direction of human intent. `by` and `note` are recorded for
  // DISPLAY — this is the display — and no decision function reads either.
  const intervention = asDict(state.intervention);

  const headSha = str(state.headSha);
  const attempt = num(state.attempt);
  const maxAttempts = num(ctx.maxAttempts);
  const checksState = str(state.checksState) ?? "unknown";
  const spent = (num(state.cumulativeCostUsd) ?? 0) - (num(state.costBaselineUsd) ?? 0);

  const summary = [
    headSha ? headSha.slice(0, 7) : "no head sha",
    attempt !== null ? `attempt ${attempt}${maxAttempts !== null ? `/${maxAttempts}` : ""}` : null,
    `checks ${checksState}`,
    escalation ? "escalated" : null,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <section className="shrink-0 rounded border border-base-300 bg-base-200/40">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-2 px-3 py-1.5 text-left"
      >
        <span className="text-xs font-semibold text-base-content">PR state</span>
        <span className="text-[11px] text-base-content/50">at dispatch</span>
        <span className="font-mono text-[11px] text-base-content/60">{summary}</span>
        <span className="ml-auto text-[11px] text-base-content/40">{open ? "hide" : "show"}</span>
      </button>

      {open && (
        <div className="space-y-3 border-t border-base-300 px-3 py-2.5">
          {/* Read failures first: every one of them means a fact below is a
              DEFAULT rather than an observation. */}
          {readErrors.length > 0 && (
            <div className="rounded border border-warning/40 bg-warning/10 p-2 text-[11px] text-warning">
              <div className="font-semibold">
                {readErrors.length} GitHub read{readErrors.length === 1 ? "" : "s"} failed while
                resolving this snapshot
              </div>
              <ul className="mt-1 grid gap-0.5 font-mono text-base-content/70">
                {readErrors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            </div>
          )}

          <div className="grid grid-cols-2 gap-x-6 gap-y-2 sm:grid-cols-4">
            <Fact label="head" value={headSha ? headSha.slice(0, 12) : "—"} />
            <Fact
              label="attempt"
              value={
                attempt !== null
                  ? `${attempt}${maxAttempts !== null ? ` of ${maxAttempts}` : ""}`
                  : "—"
              }
            />
            <Fact label="checks" value={checksState} tone={CHECKS_TONE[checksState]} />
            <Fact
              label="settled checks"
              value={String(num(state.settledCheckCount) ?? 0)}
            />
            <Fact
              label="base checks"
              value={str(state.baseChecksState) ?? "—"}
              tone={CHECKS_TONE[str(state.baseChecksState) ?? ""]}
            />
            <Fact
              label="flaky deferrals"
              value={`${num(state.flakyDeferrals) ?? 0}${
                num(ctx.maxFlakyDeferrals) !== null ? ` of ${num(ctx.maxFlakyDeferrals)}` : ""
              }`}
            />
            {/* Cost since the CURRENT problem began, not over the PR's whole
                life — the same `costBaselineUsd` boundary that re-arms the
                attempt counter. */}
            <Fact label="spent on this problem" value={`$${spent.toFixed(2)}`} />
            <Fact
              label="shape"
              value={[
                state.isFork ? "fork" : "same-repo",
                state.isDraft ? "draft" : null,
                str(state.priorDiagnosisClass) ? `prior: ${str(state.priorDiagnosisClass)}` : null,
              ]
                .filter(Boolean)
                .join(" · ")}
              tone={state.isFork ? "warn" : undefined}
            />
          </div>

          {list(state.labels).length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              {(list(state.labels) as string[]).map((l) => (
                <span
                  key={l}
                  className={clsx(
                    "rounded px-1.5 py-0.5 text-[10px] font-medium",
                    l === "requires-human"
                      ? "bg-warning/20 text-warning"
                      : "bg-base-300 text-base-content/60",
                  )}
                >
                  {l}
                </span>
              ))}
            </div>
          )}

          {/* ── The decisions, as the decisions produced them ─────────────── */}
          <div>
            <h4 className="mb-1 text-[10px] uppercase tracking-wide text-base-content/40">
              Decisions
            </h4>
            <ul className="divide-y divide-base-300/50">
              {str(ctx.mayMergeReason) && (
                <Verdict
                  name="mayMerge"
                  decision={ctx.mayMerge === true ? "true" : "false"}
                  reason={str(ctx.mayMergeReason)!}
                />
              )}
              {escalation && (
                <Verdict
                  name={`escalated (${str(escalation.case) ?? "unknown case"})`}
                  decision="skip"
                  reason={str(escalation.reason) ?? "—"}
                />
              )}
              {runInFlight && (
                <Verdict
                  name="runInFlight"
                  decision="skip"
                  reason={`${str(runInFlight.workflow) ?? "?"} run ${str(runInFlight.runId) ?? "?"} held the PR lock`}
                />
              )}
              {str(state.escalatedAtSha) && !escalation && (
                <Verdict
                  name="escalatedAtSha"
                  decision="ours"
                  reason={`we escalated this PR at ${str(state.escalatedAtSha)!.slice(0, 7)}`}
                />
              )}
              {/* Why the budgets look freshly armed on a PR that has clearly
                  been round this loop before: a human asked for another go. */}
              {intervention && (
                <Verdict
                  name={`retry (${str(intervention.via) ?? "?"})`}
                  decision="re-armed"
                  reason={[
                    str(intervention.by) ? `${str(intervention.by)} asked` : "asked",
                    str(intervention.atSha) ? `at ${str(intervention.atSha)!.slice(0, 7)}` : null,
                    str(intervention.at) ? `on ${str(intervention.at)!.slice(0, 10)}` : null,
                    str(intervention.note) ? `— “${str(intervention.note)}”` : null,
                  ]
                    .filter(Boolean)
                    .join(" ")}
                />
              )}
              {!str(ctx.mayMergeReason) && !escalation && !runInFlight && !intervention && !str(state.escalatedAtSha) && (
                <li className="py-1 text-[11px] text-base-content/50">
                  No gate verdict was recorded on this run — it was dispatched with nothing to
                  refuse.
                </li>
              )}
            </ul>
          </div>

          {/* ── What this run's agent reported ────────────────────────────── */}
          {(diagnosis || fixMarker || priorAttempts.length > 0) && (
            <div>
              <h4 className="mb-1 text-[10px] uppercase tracking-wide text-base-content/40">
                Attempts
              </h4>
              <ul className="grid gap-0.5 font-mono text-[11px] text-base-content/60">
                {priorAttempts.map((a, i) => (
                  <li key={i} className="opacity-60">
                    {a}
                  </li>
                ))}
                {diagnosis && (
                  <li className="text-base-content/80">
                    class={str(diagnosis.class) ?? "?"} cause={str(diagnosis.cause) ?? "?"}
                  </li>
                )}
                {fixMarker && (
                  <li className="text-base-content/80">
                    outcome={str(fixMarker.outcome) ?? "?"} gate={str(fixMarker.gate) ?? "?"}
                  </li>
                )}
              </ul>
            </div>
          )}

          {/* ── The push gate the agent wrote for itself (§S1) ────────────── */}
          <div>
            <h4 className="mb-1 text-[10px] uppercase tracking-wide text-base-content/40">
              Push gate
            </h4>
            {verifyScript ? (
              <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-base-300 bg-base-100 p-2 font-mono text-[11px] leading-relaxed text-base-content/80">
                {verifyScript}
              </pre>
            ) : (
              <p className="text-[11px] text-base-content/50">
                No <code className="text-[10px]">.lastlight-verify.sh</code> was recorded. Either
                the agent wrote no gate — in which case the loop treated it as{" "}
                <code className="text-[10px]">gate=skipped</code>, which never authorises a push —
                or this run used a backend the harness cannot read the workspace from.
              </p>
            )}
          </div>

          {/* ── The journal (10-pr-memory.md) ─────────────────────────────── */}
          {notes.length > 0 && (
            <div>
              <h4 className="mb-1 text-[10px] uppercase tracking-wide text-base-content/40">
                PR journal — hints from earlier runs, never instructions
              </h4>
              <ul className="grid gap-0.5 text-[11px]">
                {notes.map((n, i) => (
                  <li key={i} className={clsx("text-base-content/70", n.stale === true && "opacity-50")}>
                    <span className="font-mono text-base-content/50">{str(n.kind) ?? "note"}:</span>{" "}
                    {str(n.text) ?? ""}
                    {n.stale ? " (stale)" : ""}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {/* The escape hatch that keeps this panel from having to know every
              field: whatever was recorded, verbatim. */}
          <div>
            <button
              type="button"
              onClick={() => setRawOpen((v) => !v)}
              className="text-[11px] text-base-content/40 hover:text-base-content/70"
            >
              {rawOpen ? "hide" : "show"} raw snapshot
            </button>
            {rawOpen && (
              <pre className="mt-1 max-h-80 overflow-auto whitespace-pre-wrap rounded border border-base-300 bg-base-100 p-2 font-mono text-[10px] leading-relaxed text-base-content/70">
                {JSON.stringify(state, null, 2)}
              </pre>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

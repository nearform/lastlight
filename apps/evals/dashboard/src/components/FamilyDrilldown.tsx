import { useEffect } from "react";

import { useFamilyDrilldowns, type CaseDrilldown } from "../lib/api";
import type { DrilldownFinding, DrilldownHypothesis, FamilyDrilldown } from "../lib/pipelineArtifacts";

/** A case in the arm, and where (if anywhere) its artifacts were kept. */
export interface DrilldownCase {
  instanceId: string;
  /** `/data/…/<sessions/case__arm/trial-1>/pr-review`, from the result's
   * `pipelineArtifactRel`. Absent ⇒ the run kept nothing for this case. */
  base?: string;
}

const TIER_STYLE: Record<string, string> = {
  inline: "border-success/40 bg-success/10 text-success",
  body: "border-info/40 bg-info/10 text-info",
  internal: "border-warning/40 bg-warning/10 text-warning",
};

const DISCHARGE_STYLE: Record<string, string> = {
  QUOTE: "border-success/40 bg-success/10 text-success",
  ABSENT: "border-error/40 bg-error/10 text-error",
  PARTIAL: "border-warning/40 bg-warning/10 text-warning",
  PROBE: "border-info/40 bg-info/10 text-info",
  "bad-code": "border-error/40 bg-error/10 text-error",
  none: "border-base-300 bg-base-200 text-base-content/50",
};

function Chip({ label, cls, title }: { label: string; cls?: string; title?: string }) {
  return (
    <span
      title={title}
      className={`shrink-0 whitespace-nowrap rounded border px-1.5 py-0.5 font-mono text-2xs ${
        cls ?? "border-base-300 bg-base-200 text-base-content/60"
      }`}
    >
      {label}
    </span>
  );
}

/**
 * The evidence behind ONE row of the per-family funnel, per case.
 *
 * The funnel table above it pools every case in the arm, so this does too — and
 * every section is headed by the `instance_id` it came from, because a pooled
 * number whose rows cannot be attributed to a case is the thing that made the
 * funnel un-actionable in the first place.
 *
 * Three distinctions it exists to keep visible, all of them the same lesson:
 *
 * - **A run with no artifacts is not a family that produced nothing.** Only runs
 *   since `persistPipelineArtifacts()` carry `pipelineArtifactRel`; anything
 *   older lives in a `$TMPDIR` the OS reaped. Such a case renders as "artifacts
 *   not retained", never as an empty panel and never as a spinner.
 * - **`notMeasured` is not 0.** `tests` has no seeder, no branch in the workflow
 *   and no coverage artifact; it is reported as not measured and the reason the
 *   document gives is quoted verbatim.
 * - **Unknown is not 0.** `spec`'s axis is built harness-side under its own cap,
 *   so code-facts writes `measured: false` meaning "I cannot COUNT these" while
 *   the survey still runs — 0 obligations, 50 hypotheses, both true.
 */
export function FamilyDrilldownModal({
  family,
  arm,
  cases,
  onClose,
}: {
  family: string;
  arm: string;
  cases: DrilldownCase[];
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const retained = cases.filter((c) => !!c.base) as { instanceId: string; base: string }[];
  const notRetained = cases.filter((c) => !c.base);
  const queries = useFamilyDrilldowns(retained, family, true);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" onClick={onClose}>
      <div
        className="flex h-[calc(100vh-2rem)] w-full max-w-5xl flex-col overflow-hidden rounded-xl border border-base-300 bg-base-100 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex shrink-0 items-center gap-3 border-b border-base-300 bg-base-200/80 px-4 py-2.5">
          <span className="font-mono text-xs font-semibold text-accent">{family}</span>
          <span className="truncate font-mono text-2xs text-base-content/60">{arm}</span>
          <Chip
            label={`${cases.length} case${cases.length === 1 ? "" : "s"} pooled`}
            title="The funnel row above pools every case in this arm; so does this panel. Each section below names the case it came from."
          />
          {notRetained.length > 0 && (
            <Chip
              label={`${notRetained.length} without artifacts`}
              cls="border-base-300 bg-base-200 text-base-content/50"
              title="These cases recorded no pipelineArtifactRel — the evidence was not retained, which is not the same as the family producing nothing."
            />
          )}
          <button onClick={onClose} className="btn btn-ghost btn-xs ml-auto h-6 min-h-0" aria-label="Close">
            ✕
          </button>
        </div>

        <div className="min-h-0 flex-1 space-y-4 overflow-y-auto px-4 py-3">
          {retained.length === 0 && <NoArtifacts cases={notRetained.map((c) => c.instanceId)} />}

          {queries.map((q, i) => {
            const c = retained[i];
            if (q.isPending)
              return (
                <p key={c.base} className="font-mono text-2xs text-base-content/50">
                  {c.instanceId} — reading artifacts…
                </p>
              );
            if (q.isError)
              return (
                <p key={c.base} className="font-mono text-2xs text-error">
                  {c.instanceId} — could not read artifacts: {(q.error as Error).message}
                </p>
              );
            return <CaseSection key={c.base} data={q.data as CaseDrilldown} />;
          })}

          {retained.length > 0 && notRetained.length > 0 && (
            <NoArtifacts cases={notRetained.map((c) => c.instanceId)} />
          )}
        </div>
      </div>
    </div>
  );
}

/** The honest empty state: the run did not keep the evidence. Never a spinner,
 * never a blank panel that reads as "this family produced nothing". */
function NoArtifacts({ cases }: { cases: string[] }) {
  return (
    <div className="rounded-lg border border-dashed border-base-300 bg-base-200/40 px-4 py-3">
      <div className="font-mono text-2xs font-semibold uppercase tracking-wide text-base-content/50">
        artifacts not retained
      </div>
      <p className="mt-1 max-w-3xl text-2xs leading-5 text-base-content/60">
        {cases.length ? (
          <>
            <span className="font-mono text-base-content/70">{cases.join(", ")}</span> recorded no{" "}
            <code className="font-mono">pipelineArtifactRel</code>.{" "}
          </>
        ) : null}
        Runs before the artifacts became durable wrote their evidence into a temporary workspace the operating system
        reclaims within days. The funnel counts above were read while it still existed and stand; the obligations,
        hypotheses and findings behind them are gone. This is not a family that produced nothing.
      </p>
    </div>
  );
}

function CaseSection({ data }: { data: CaseDrilldown }) {
  const d = data.drilldown;
  const nothing =
    !d.hypothesesFilePresent && !d.obligations.length && !d.findings.length && d.obligationCount === undefined;

  return (
    <section className="rounded-lg border border-base-300 bg-base-200/30">
      <header className="flex flex-wrap items-center gap-2 border-b border-base-300 px-3 py-2">
        <span className="font-mono text-xs font-semibold text-base-content">{data.instanceId}</span>
        <Obligations d={d} />
        <Chip
          label={
            d.hypothesesFilePresent
              ? `${d.hypotheses.filter((h) => !h.notMeasuredMarker).length} hypotheses`
              : "no hypotheses file"
          }
          title={
            d.hypothesesFilePresent
              ? "Rows in hypotheses/<family>.jsonl, excluding the dead-family tombstone."
              : "There is no hypotheses/<family>.jsonl — the survey for this family never ran. Different from a file with no rows."
          }
        />
        <Chip label={`${d.findings.length} findings`} />
        {d.notMeasured && (
          <Chip
            label="not measured"
            cls="border-warning/40 bg-warning/10 text-warning"
            title="The family declared measured:false and its survey produced no live row. A missing analyser and an analyser that found nothing are different facts."
          />
        )}
        {!d.findingsPresent && (
          <Chip
            label="no findings.json"
            cls="border-warning/40 bg-warning/10 text-warning"
            title="The adjudicator never ran or never wrote, so what became of these hypotheses is UNKNOWN — not nothing."
          />
        )}
        {d.findingsPresent && !d.dispositionPresent && (
          <Chip
            label="no disposition.json"
            cls="border-warning/40 bg-warning/10 text-warning"
            title="The boundary wrote nothing, so where each finding landed is UNKNOWN — not internal, not withheld. One measured case wrote no disposition at all while posting nine findings."
          />
        )}
      </header>

      {nothing ? (
        <p className="px-3 py-3 text-2xs leading-5 text-base-content/60">
          The artifact directory exists at{" "}
          <code className="font-mono text-base-content/70">{data.base}</code> but holds no document naming this family.
        </p>
      ) : (
        <div className="space-y-3 px-3 py-3">
          {d.notMeasuredReason && (
            <p className="rounded border border-warning/30 bg-warning/5 px-2.5 py-2 text-2xs leading-5 text-base-content/70">
              <b className="font-semibold text-warning">not measured — </b>
              {d.notMeasuredReason}
            </p>
          )}
          {d.declaredMeasured === false && !d.notMeasured && (
            <p className="rounded border border-info/30 bg-info/5 px-2.5 py-2 text-2xs leading-5 text-base-content/70">
              <b className="font-semibold text-info">obligations UNKNOWN, not zero — </b>
              the seeder recorded <code className="font-mono">measured: false</code> for this family, meaning it could
              not COUNT the questions, while the survey below plainly ran. {d.notMeasuredReason ?? ""} A zero in the
              funnel's obligations column here means "could not count", never "nothing to check".
            </p>
          )}

          <ObligationList d={d} />
          <HypothesisList d={d} />
          <Unreached d={d} />
        </div>
      )}
    </section>
  );
}

function Obligations({ d }: { d: FamilyDrilldown }) {
  if (d.obligationCount === undefined)
    return <Chip label="obligations unknown" title="The document carried no count for this family — unknown, not 0." />;
  return (
    <Chip
      label={`${d.obligationCount} obligations${d.minted !== undefined ? ` of ${d.minted} minted` : ""}`}
      title={
        d.cap != null
          ? `Ceiling ${d.cap} for this family. minted − obligations = ${d.cappedOut ?? "?"} of its own questions fell past its own ceiling.`
          : "No per-family ceiling recorded."
      }
    />
  );
}

/** What was ASKED — and, for the ones that never made the cut, why. */
function ObligationList({ d }: { d: FamilyDrilldown }) {
  const dropped = (d.cappedOut ?? 0) > 0 || d.droppedNamingFamily.length > 0;
  if (!d.obligations.length && !dropped) return null;
  return (
    <details open className="rounded border border-base-300 bg-base-100">
      <summary className="cursor-pointer px-2.5 py-1.5 font-mono text-2xs uppercase tracking-wide text-base-content/50">
        what was asked — {d.obligations.length} obligation{d.obligations.length === 1 ? "" : "s"} survived
        {dropped ? `, ${d.cappedOut ?? 0} dropped` : ""}
      </summary>
      <ul className="divide-y divide-base-300/60">
        {d.obligations.map((o, i) => (
          <li key={o.id ?? i} className="px-2.5 py-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-2xs text-accent">{o.id ?? `#${i + 1}`}</span>
              {o.discharge && <Chip label={o.discharge} />}
              {o.rank !== undefined && (
                <span className="font-mono text-2xs text-base-content/40" title="Seeder rank — the budget order.">
                  rank {o.rank}
                </span>
              )}
            </div>
            {o.question && <p className="mt-1 text-2xs leading-5 text-base-content/80">{o.question}</p>}
            {o.mechanism && <p className="mt-0.5 text-2xs leading-5 text-base-content/50">{o.mechanism}</p>}
            {o.introducedAt?.path && (
              <p className="mt-0.5 font-mono text-2xs text-base-content/40">
                {o.introducedAt.path}
                {o.introducedAt.line !== undefined ? `:${o.introducedAt.line}` : ""}
              </p>
            )}
          </li>
        ))}
        {dropped && (
          <li className="px-2.5 py-2">
            <div className="font-mono text-2xs uppercase tracking-wide text-error/70">
              dropped — {d.cappedOut ?? 0} question{d.cappedOut === 1 ? "" : "s"} nobody ever asked
            </div>
            <p className="mt-1 text-2xs leading-5 text-base-content/60">
              <b className="font-semibold text-base-content/70">
                The dropped questions' TEXT is not on disk.
              </b>{" "}
              <code className="font-mono">obligations.json</code>'s <code className="font-mono">dropped[]</code> is{" "}
              <code className="font-mono">{"{reason, count}"}</code> only — no ids, no text, no family field. The
              per-family count above is <code className="font-mono">minted − obligations</code>, which code-facts
              records precisely so nobody has to recover it by parsing prose. The reasons below are matched to this
              family by their text and are shown as written.
            </p>
            <ul className="mt-1.5 space-y-1">
              {d.droppedNamingFamily.map((r, i) => (
                <li key={i} className="text-2xs leading-5 text-base-content/70">
                  <span className="font-mono text-error/80">×{r.count}</span> {r.reason}
                </li>
              ))}
              {d.droppedRunWide.map((r, i) => (
                <li key={`w${i}`} className="text-2xs leading-5 text-base-content/50">
                  <span className="font-mono text-base-content/40">×{r.count}</span> {r.reason}{" "}
                  <span className="italic">(run-wide — names no family)</span>
                </li>
              ))}
            </ul>
          </li>
        )}
      </ul>
    </details>
  );
}

/** What CAME BACK, and what became of it. */
function HypothesisList({ d }: { d: FamilyDrilldown }) {
  if (!d.hypothesesFilePresent)
    return (
      <p className="rounded border border-base-300 bg-base-100 px-2.5 py-2 text-2xs leading-5 text-base-content/60">
        No <code className="font-mono">hypotheses/{d.family}.jsonl</code> — the survey branch for this family never ran
        or never wrote. Not the same as a survey that ran and found nothing.
      </p>
    );
  const live = d.hypotheses.filter((h) => !h.notMeasuredMarker);
  const tomb = d.hypotheses.filter((h) => h.notMeasuredMarker);
  return (
    <details open className="rounded border border-base-300 bg-base-100">
      <summary className="cursor-pointer px-2.5 py-1.5 font-mono text-2xs uppercase tracking-wide text-base-content/50">
        what came back — {live.length} hypothes{live.length === 1 ? "is" : "es"}
        {tomb.length ? ` + ${tomb.length} notMeasured tombstone` : ""}
      </summary>
      <ul className="divide-y divide-base-300/60">
        {tomb.map((h) => (
          <li key={h.id} className="px-2.5 py-2">
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-2xs text-base-content/50">{h.id}</span>
              <Chip
                label="notMeasured tombstone"
                cls="border-warning/40 bg-warning/10 text-warning"
                title="The single line a dead family writes. It holds its ordinal (identity must not shift) but it is the family saying it did not run — not a hypothesis."
              />
            </div>
            {h.claim && <p className="mt-1 text-2xs leading-5 text-base-content/60">{h.claim}</p>}
          </li>
        ))}
        {live.map((h) => (
          <HypothesisRowView key={h.id} h={h} findings={d.findings} adjudicated={d.findingsPresent} />
        ))}
      </ul>
    </details>
  );
}

function HypothesisRowView({
  h,
  findings,
  adjudicated,
}: {
  h: DrilldownHypothesis;
  findings: DrilldownFinding[];
  /** Did the run write a `findings.json`? Without one, "reached no finding" is
   * unknown rather than a conservation failure. */
  adjudicated: boolean;
}) {
  return (
    <li className="px-2.5 py-2">
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-mono text-2xs text-accent" title="Canonical id: filename family + append order.">
          {h.id}
        </span>
        <Chip label={h.discharge} cls={DISCHARGE_STYLE[h.discharge]} />
        {h.cleanDischarge && (
          <Chip
            label="clean discharge"
            cls="border-base-300 bg-base-200 text-base-content/50"
            title="QUOTE with failureScenario present and explicitly null — the pass looked, found the line, and found it fine. An anti-finding: it cannot match gold by construction."
          />
        )}
        {h.failureScenario === "absent" && (
          <Chip
            label="no failureScenario key"
            title="The key is absent, which carries no information — under the pre-2026-08-23 contract the field did not exist. Different from an explicit null."
          />
        )}
        {h.obligation && (
          <span className="font-mono text-2xs text-base-content/40" title="The obligation the row says it answers.">
            ← {h.obligation}
          </span>
        )}
        {h.confidence !== undefined && (
          <span className="font-mono text-2xs text-base-content/40">conf {h.confidence}</span>
        )}
        {h.severity && <span className="font-mono text-2xs text-base-content/40">{h.severity}</span>}
        {h.declaredId && (
          <span
            className="font-mono text-2xs text-base-content/30"
            title="The model declared this id. It is an alias at best and a collision at worst — never the identity."
          >
            declared {h.declaredId}
          </span>
        )}
      </div>
      {h.claim && <p className="mt-1 text-2xs leading-5 text-base-content/80">{h.claim}</p>}
      {h.failureScenarioText && (
        <p className="mt-0.5 text-2xs leading-5 text-base-content/60">
          <b className="font-semibold text-base-content/70">failure scenario — </b>
          {h.failureScenarioText}
        </p>
      )}
      {h.anchors.length > 0 && (
        <p className="mt-0.5 font-mono text-2xs text-base-content/40">{h.anchors.join("  ·  ")}</p>
      )}
      {h.quotes.length > 0 && (
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap wrap-break-word rounded bg-base-200/60 px-2 py-1 font-mono text-2xs leading-5 text-base-content/70">
          {h.quotes.map((q) => `${q.path ?? "?"}:${q.line ?? "?"}  ${q.text ?? ""}`).join("\n")}
        </pre>
      )}
      <div className="mt-1.5 space-y-1">
        {h.findings.length === 0 ? (
          adjudicated ? (
            <p className="font-mono text-2xs text-warning/80">
              reached no finding — the conservation floor is supposed to make this set empty
            </p>
          ) : (
            <p className="font-mono text-2xs text-base-content/40">
              no findings.json — what became of this is unrecorded, not nothing
            </p>
          )
        ) : (
          h.findings.map((i) => <FindingLine key={i} f={findings[i]} />)
        )}
      </div>
    </li>
  );
}

function FindingLine({ f }: { f: DrilldownFinding }) {
  return (
    <div className="rounded border border-base-300 bg-base-200/40 px-2 py-1.5">
      <div className="flex flex-wrap items-baseline gap-2">
        {f.tier ? (
          <Chip label={f.tier} cls={TIER_STYLE[f.tier]} />
        ) : (
          <Chip
            label="not in disposition"
            cls="border-warning/40 bg-warning/10 text-warning"
            title="The path + title join (never line — the boundary re-anchors lines) found no disposition row. Where this finding went is unknown."
          />
        )}
        {f.joined && f.reason && (
          <span className="font-mono text-2xs text-base-content/60" title="The boundary's own machine token.">
            {f.reason}
          </span>
        )}
        {f.joined && f.reason === null && (
          <span className="font-mono text-2xs text-base-content/30" title="No demotion reason — an inline row the boundary never demoted.">
            no reason
          </span>
        )}
        {f.severity && <span className="font-mono text-2xs text-base-content/40">{f.severity}</span>}
        {f.confidence !== undefined && (
          <span className="font-mono text-2xs text-base-content/40">conf {f.confidence}</span>
        )}
        {f.unresolved.length > 0 && (
          <span
            className="font-mono text-2xs text-base-content/30"
            title="Citations this family's file does not contain — another family's rows, or an id naming nothing."
          >
            also cites {f.unresolved.join(", ")}
          </span>
        )}
      </div>
      <p className="mt-0.5 text-2xs leading-5 text-base-content/80">{f.title}</p>
      {f.path && (
        <p className="font-mono text-2xs text-base-content/40">
          {f.path}
          {f.line !== undefined ? `:${f.line}` : ""}
        </p>
      )}
    </div>
  );
}

/** The two conservation alarms: hypotheses that reached nothing, and findings
 * that came from nothing. */
function Unreached({ d }: { d: FamilyDrilldown }) {
  // With no `findings.json` every row is trivially unreached; that is a run that
  // died before adjudication, not a conservation failure.
  if (!d.findingsPresent) return null;
  if (!d.orphanHypotheses.length && !d.unprovenanced) return null;
  return (
    <div className="rounded border border-warning/30 bg-warning/5 px-2.5 py-2 text-2xs leading-5 text-base-content/70">
      {d.orphanHypotheses.length > 0 && (
        <p>
          <b className="font-semibold text-warning">
            {d.orphanHypotheses.length} hypothes{d.orphanHypotheses.length === 1 ? "is" : "es"} reached no finding
          </b>{" "}
          — <span className="font-mono text-base-content/60">{d.orphanHypotheses.join(", ")}</span>. The conservation
          floor (<code className="font-mono">findings --repair</code>) is supposed to restore every dropped hypothesis
          at <code className="font-mono">internal</code>, so a non-empty set here is itself a finding.
        </p>
      )}
      {d.unprovenanced > 0 && (
        <p className={d.orphanHypotheses.length ? "mt-1" : ""}>
          <b className="font-semibold text-warning">{d.unprovenanced} finding(s) cite no hypothesis</b> — generated
          without provenance, so nothing here can say what evidence produced them.
        </p>
      )}
    </div>
  );
}

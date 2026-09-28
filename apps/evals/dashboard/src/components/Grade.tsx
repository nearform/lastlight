import clsx from "clsx";
import { useEffect, useMemo, useRef, useState } from "react";

import {
  agreementMetrics,
  gradedMetrics,
  IMPORTANCE_VALUES,
  labelsOf,
  proposalAgrees,
  REAL_VALUES,
  type GradedMetrics as Metrics,
} from "../../../src/labels.js";
import type { GradeFinding, GraderAgreement, Importance, LabelInput, Proposal, RealGrade } from "../types";
import { useFindings, useSaveLabel } from "../lib/api";
import { GRADE_TIER_KEY, useNavigate } from "../lib/router";
import { SessionModal, type SessionSource } from "./SessionModal";

/**
 * Human grading (`#/grade`). Every finding the pipeline flagged — site-review
 * reports for now — deduplicated by label key (`src/labels.ts` documents the
 * rule), graded on REAL? × IMPORTANCE with an optional gold link and note.
 * Labels are appended to `eval-results/labels/findings.jsonl` by the server;
 * the per-arm numbers are `gradedMetrics`, the same function the phase-replay
 * page's "human grades" box reads.
 *
 * Keys: j/k next/prev · y/n/u real · 1/2/3 importance (implies real = yes) ·
 * x clear · a accept the (first) machine suggestion. n, u, 1–3 and a complete a
 * grade and advance.
 *
 * Machine proposals (`proposals-<grader>.jsonl`) are shown in a muted box per
 * card and compared with the human labels in the header (`agreementMetrics`).
 * They are never a label: every human number above reads `f.label` only, and
 * accepting a suggestion POSTs it as the human's own label.
 */

type StatusFilter = "ungraded" | "graded" | "all" | "disagrees" | "suggested";
const STATUS_TEXT: Record<StatusFilter, string> = {
  ungraded: "ungraded",
  graded: "graded",
  all: "all",
  disagrees: "disagrees with suggestion",
  suggested: "has suggestion, ungraded",
};
const matchesStatus = (f: GradeFinding, s: StatusFilter): boolean =>
  s === "all"
    ? true
    : s === "graded"
      ? !!f.label
      : s === "ungraded"
        ? !f.label
        : s === "suggested"
          ? !f.label && f.proposals.length > 0
          : !!f.label && f.proposals.some((p) => !proposalAgrees(f.label!, p));
const NA = "n/a";
const REAL_KEYS: Record<string, RealGrade> = { y: "yes", n: "no", u: "unsure" };
const IMP_SHORT: Record<Importance, string> = { "must-fix": "must-fix", "worth-mentioning": "worth mentioning", nit: "nit" };
const shortInst = (id: string) => id.replace(/^prreview__/, "");

export function GradePage({ reportLabel }: { reportLabel?: string }) {
  const { data, error, isLoading } = useFindings();
  const save = useSaveLabel();
  const navigate = useNavigate();
  const [status, setStatus] = useState<StatusFilter>("ungraded");
  const [focus, setFocus] = useState<string | null>(null);
  // Graded during this visit: kept visible under "ungraded" so importance can
  // follow real, and the list does not jump under the cursor.
  const [sticky, setSticky] = useState<Set<string>>(new Set());
  useEffect(() => setSticky(new Set()), [status, reportLabel]);

  const all = data?.findings ?? [];
  const labels = useMemo(() => labelsOf(all), [all]);
  const reportLabels = useMemo(() => [...new Set(all.flatMap((f) => f.appearances.map((a) => a.reportLabel)))].sort(), [all]);
  const visible = useMemo(
    () =>
      all.filter(
        (f) =>
          (!reportLabel || f.appearances.some((a) => a.reportLabel === reportLabel)) &&
          (sticky.has(f.key) || matchesStatus(f, status)),
      ),
    [all, reportLabel, status, sticky],
  );
  const scoped = reportLabel ? all.filter((f) => f.appearances.some((a) => a.reportLabel === reportLabel)) : all;
  const metrics = useMemo(() => gradedMetrics(all, labels), [all, labels]);
  // Recomputed here (not read off the response) so an in-place label patch updates it.
  const agreement = useMemo(() => agreementMetrics(all), [all]);

  const commit = (f: GradeFinding, patch: Partial<Omit<LabelInput, "key">>) => {
    const cur = f.label;
    const input: LabelInput = {
      key: f.key,
      real: cur?.real ?? null,
      importance: cur?.importance ?? null,
      gold: cur?.gold ?? null,
      note: cur?.note ?? null,
      ...patch,
    };
    if (input.real !== "yes") input.importance = null;
    setSticky((s) => new Set(s).add(f.key));
    save.mutate(input);
  };
  // The human accepting a machine suggestion: it becomes THEIR label. A gold
  // link naming an instance this finding has no gold for is dropped (the server
  // would refuse it); the human's own note is kept.
  const accept = (f: GradeFinding, p: Proposal) => {
    const gold = p.gold && f.gold.some((g) => g.instanceId === p.gold!.instanceId && p.gold!.index < g.items.length) ? p.gold : null;
    commit(f, { real: p.real, importance: p.importance, gold });
  };

  // Keyboard: act on the focused card.
  const state = useRef({ visible, focus, commit, accept });
  state.current = { visible, focus, commit, accept };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || (t && /^(INPUT|TEXTAREA|SELECT)$/.test(t.tagName))) return;
      const { visible: vs, focus: fk, commit: c, accept: acc } = state.current;
      if (!vs.length) return;
      const i = Math.max(0, vs.findIndex((f) => f.key === fk));
      const move = (to: number) => {
        const next = vs[Math.min(vs.length - 1, Math.max(0, to))];
        setFocus(next.key);
        document.getElementById(`finding-${next.key}`)?.scrollIntoView({ block: "center", behavior: "smooth" });
      };
      const f = vs[i];
      if (e.key === "j") move(fk ? i + 1 : 0);
      else if (e.key === "k") move(i - 1);
      else if (REAL_KEYS[e.key]) {
        c(f, { real: REAL_KEYS[e.key] });
        if (e.key !== "y") move(i + 1);
      } else if (["1", "2", "3"].includes(e.key)) {
        c(f, { real: "yes", importance: IMPORTANCE_VALUES[Number(e.key) - 1] });
        move(i + 1);
      } else if (e.key === "a") {
        if (!f.proposals.length) return;
        acc(f, f.proposals[0]);
        move(i + 1);
      } else if (e.key === "x") c(f, { real: null, importance: null, gold: null, note: null });
      else return;
      e.preventDefault();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const byPr = useMemo(() => {
    const m = new Map<string, GradeFinding[]>();
    for (const f of visible) m.set(f.pr, [...(m.get(f.pr) ?? []), f]);
    return [...m.entries()];
  }, [visible]);

  if (error) return <div className="font-mono text-xs text-error">could not load /api/findings: {(error as Error).message}</div>;
  if (isLoading && !data) return <div className="py-20 text-center font-mono text-xs text-base-content/40">scanning findings…</div>;

  const graded = scoped.filter((f) => f.label).length;
  return (
    <div>
      <h1 className="mb-1 text-2xl font-semibold text-base-content">Grade findings</h1>
      <p className="mb-4 font-mono text-xs text-base-content/50">
        {graded} / {scoped.length} graded{reportLabel ? ` in ${reportLabel}` : ""} · {all.length} distinct findings from site-review reports
        {data && data.unreadable > 0 && <span className="text-warning"> · {data.unreadable} not listed (full text unreadable)</span>}
        {" · "}keys: j/k move · y/n/u real · 1/2/3 importance · a accept suggestion · x clear
      </p>
      <progress className="progress progress-success mb-4 w-full" value={graded} max={Math.max(1, scoped.length)} />
      <MetricsTable rows={metrics} highlight={reportLabel} />
      <AgreementSummary rows={agreement} />

      <div className="my-4 flex flex-wrap items-center gap-2 font-mono text-xs">
        {(Object.keys(STATUS_TEXT) as StatusFilter[]).map((s) => (
          <button
            key={s}
            onClick={() => setStatus(s)}
            className={clsx("rounded border px-2 py-1", status === s ? "border-info bg-info/15 text-info" : "border-base-300 text-base-content/60 hover:border-info")}
          >
            {STATUS_TEXT[s]}
          </button>
        ))}
        <select
          className="select select-bordered select-xs ml-2 font-mono"
          value={reportLabel ?? ""}
          onChange={(e) => navigate(GRADE_TIER_KEY, e.target.value || undefined)}
        >
          <option value="">every report</option>
          {reportLabels.map((l) => (
            <option key={l} value={l}>
              {l}
            </option>
          ))}
        </select>
        <span className="text-base-content/40">{visible.length} shown</span>
        {save.error && <span className="text-error">save failed: {(save.error as Error).message}</span>}
      </div>

      {byPr.length === 0 && <div className="rounded-xl border border-base-300 bg-base-200 px-5 py-10 text-center font-mono text-xs text-base-content/50">Nothing to grade here.</div>}
      {byPr.map(([pr, fs]) => (
        <section key={pr} className="mb-6">
          <h2 className="mb-2 font-mono text-sm font-semibold text-base-content/80">
            {shortInst(pr)} <span className="text-base-content/40">· {fs.length}</span>
          </h2>
          <div className="space-y-3">
            {fs.map((f) => (
              <FindingCard
                key={f.key}
                f={f}
                focused={f.key === focus}
                onFocus={() => setFocus(f.key)}
                commit={(p) => commit(f, p)}
                accept={(p) => accept(f, p)}
              />
            ))}
          </div>
        </section>
      ))}
    </div>
  );
}

function MetricsTable({ rows, highlight }: { rows: Metrics[]; highlight?: string }) {
  if (!rows.length) return null;
  return (
    <div className="overflow-x-auto rounded-xl border border-base-300">
      <table className="w-full font-mono text-xs">
        <thead className="bg-base-200 text-left text-2xs uppercase tracking-wide text-base-content/50">
          <tr>
            <th className="px-3 py-1.5">arm (report label)</th>
            <th className="px-3 py-1.5 text-right">findings</th>
            <th className="px-3 py-1.5 text-right">graded</th>
            <th className="px-3 py-1.5 text-right">real</th>
            <th className="px-3 py-1.5 text-right">not real</th>
            <th className="px-3 py-1.5 text-right">unsure</th>
            <th className="px-3 py-1.5 text-right" title="real AND must-fix or worth-mentioning">real-important</th>
            <th className="px-3 py-1.5 text-right" title="real ÷ graded (unsure counts in the denominator)">human P</th>
            <th className="px-3 py-1.5 text-right">gold-linked</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.group} className={clsx("border-t border-base-300", r.group === highlight && "bg-info/10")}>
              <td className="px-3 py-1.5">{r.group}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.findings}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.graded}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-success">{r.real}</td>
              <td className="px-3 py-1.5 text-right tabular-nums text-error">{r.notReal}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.unsure}</td>
              <td className="px-3 py-1.5 text-right tabular-nums font-semibold">{r.realImportant}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.precision === null ? NA : r.precision.toFixed(2)}</td>
              <td className="px-3 py-1.5 text-right tabular-nums">{r.goldLinked}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const pct = (v: number | null) => (v === null ? NA : `${Math.round(v * 100)}%`);

/** Per grader: how its proposals agree with the human labels (the human is the reference). */
function AgreementSummary({ rows }: { rows: GraderAgreement[] }) {
  if (!rows.length) return null;
  return (
    <div className="mt-3 flex flex-wrap gap-3 font-mono text-xs">
      {rows.map((r) => (
        <div key={r.grader} className="rounded-xl border border-dashed border-base-300 bg-base-200/50 px-3 py-2 text-base-content/70">
          <div>
            <span className="text-2xs uppercase tracking-wide text-base-content/40">suggestions · </span>
            <b>{r.grader}</b> · {r.proposals} proposed · n {r.n} both graded · real agree {pct(r.realAgreeRate)} · κ{" "}
            {r.kappa === null ? NA : r.kappa.toFixed(2)}
            <span title="of the findings both called real"> · importance {pct(r.importanceAgreeRate)} · gold {pct(r.goldAgreeRate)}</span>
            <span className="text-base-content/40"> (of {r.bothReal} both-real)</span>
          </div>
          {r.n > 0 && (
            <table className="mt-1 text-2xs" title="rows = human, columns = grader">
              <thead>
                <tr className="text-base-content/40">
                  <th className="pr-2 text-left font-normal">human ↓ / {r.grader} →</th>
                  {REAL_VALUES.map((v) => (
                    <th key={v} className="px-2 text-right font-normal">
                      {v}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {REAL_VALUES.map((h, i) => (
                  <tr key={h}>
                    <td className="pr-2 text-base-content/40">{h}</td>
                    {r.confusion[i].map((c, j) => (
                      <td key={j} className={clsx("px-2 text-right tabular-nums", i === j ? "text-success" : c ? "text-warning" : "text-base-content/30")}>
                        {c}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ))}
    </div>
  );
}

/** A machine suggestion: muted and dashed so it never reads as the human grade. */
function ProposalBox({ f, p, accept }: { f: GradeFinding; p: Proposal; accept: () => void }) {
  const l = f.label;
  const agrees = l ? proposalAgrees(l, p) : null;
  return (
    <div className="mt-2 rounded-lg border border-dashed border-base-300 bg-base-300/30 px-3 py-2 font-mono text-2xs text-base-content/60" onClick={(e) => e.stopPropagation()}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="uppercase tracking-wide text-base-content/40">suggested by {p.grader}</span>
        <span
          className={clsx(
            "rounded border px-1.5",
            p.real === "yes" ? "border-success/40 text-success/80" : p.real === "no" ? "border-error/40 text-error/80" : "border-warning/40 text-warning/80",
          )}
        >
          real: {p.real}
          {p.importance ? ` · ${IMP_SHORT[p.importance]}` : ""}
        </span>
        {p.gold && (
          <span className="rounded border border-base-300 px-1.5">
            same as {f.gold.length > 1 ? `${shortInst(p.gold.instanceId)} ` : ""}gold {p.gold.index + 1}
          </span>
        )}
        {agrees === true && <span className="text-success/70">agrees with your grade</span>}
        {agrees === false && <span className="text-warning">disagrees with your grade</span>}
        {agrees !== true && (
          <button className="ml-auto rounded border border-info/50 px-2 py-0.5 text-info hover:bg-info/10" title="save this as YOUR grade (a)" onClick={accept}>
            accept suggestion
          </button>
        )}
      </div>
      {p.reason && <p className="mt-1 whitespace-pre-wrap font-sans text-xs text-base-content/60">{p.reason}</p>}
    </div>
  );
}

function FindingCard({
  f,
  focused,
  onFocus,
  commit,
  accept,
}: {
  f: GradeFinding;
  focused: boolean;
  onFocus: () => void;
  commit: (p: Partial<Omit<LabelInput, "key">>) => void;
  accept: (p: Proposal) => void;
}) {
  const l = f.label;
  const [note, setNote] = useState(l?.note ?? "");
  useEffect(() => setNote(l?.note ?? ""), [l?.note]);
  const [log, setLog] = useState<SessionSource | null>(null);
  const judged = new Set(f.appearances.map((a) => (typeof a.judgeGold === "number" ? `${a.instanceId}#${a.judgeGold}` : "")));
  const goldValue = l?.gold ? `${l.gold.instanceId}#${l.gold.index}` : "";
  const saveNote = () => {
    if ((l?.note ?? "") !== note.trim() && l?.real) commit({ note: note.trim() || null });
  };
  return (
    <article
      id={`finding-${f.key}`}
      onClick={onFocus}
      className={clsx(
        "rounded-xl border bg-base-200 px-4 py-3",
        focused ? "border-info ring-1 ring-info" : l ? "border-base-300 opacity-80" : "border-base-300",
      )}
    >
      <div className="flex flex-wrap items-baseline gap-2">
        <span className="font-semibold text-base-content">{f.title}</span>
        <span className="font-mono text-2xs text-base-content/50">
          {f.path}:{f.line} · [{f.strength}]
        </span>
      </div>
      <div className="mt-1 flex flex-wrap gap-1.5 font-mono text-2xs text-base-content/50">
        {f.appearances.map((a, i) => (
          <span key={i} className="rounded border border-base-300 px-1.5 py-0.5">
            {a.reportLabel} · {shortInst(a.instanceId)} {a.arm} r{a.repeat} · {a.site}
            {typeof a.judgeGold === "number" ? <span className="text-success"> · judge→gold {a.judgeGold + 1}</span> : a.judgeGold === null ? " · judge: none" : ""}
            {a.session && (
              <button
                className="ml-1 text-info hover:underline"
                onClick={(e) => {
                  e.stopPropagation();
                  setLog({ kind: "live", title: `site-review · ${a.instanceId} · ${a.site}`, url: a.session! });
                }}
              >
                log
              </button>
            )}
          </span>
        ))}
      </div>
      {log && <SessionModal source={log} onClose={() => setLog(null)} />}

      <div className="mt-2 grid gap-3 lg:grid-cols-2">
        <div className="space-y-2 text-sm">
          <p>
            <span className="font-mono text-2xs uppercase text-base-content/40">mechanism </span>
            {f.mechanism}
          </p>
          {f.consequence && (
            <p>
              <span className="font-mono text-2xs uppercase text-base-content/40">consequence </span>
              {f.consequence}
            </p>
          )}
          {f.excerpt && (
            <pre className="overflow-x-auto rounded-lg bg-base-300/60 p-2 font-mono text-2xs leading-snug">
              {f.excerpt.lines.map((line, i) => {
                const n = f.excerpt!.startLine + i;
                return (
                  <div key={n} className={clsx(n === f.line && "bg-warning/20")}>
                    <span className="mr-2 inline-block w-8 select-none text-right text-base-content/30">{n}</span>
                    {line}
                  </div>
                );
              })}
            </pre>
          )}
        </div>
        <div className="space-y-1 font-mono text-2xs">
          {f.gold.map((g) => (
            <div key={g.instanceId}>
              <div className="text-base-content/40">gold · {shortInst(g.instanceId)}</div>
              {g.items.length === 0 && <div className="text-base-content/40">none</div>}
              <ol className="space-y-1">
                {g.items.map((it) => (
                  <li
                    key={it.index}
                    className={clsx(
                      "rounded px-1.5 py-0.5",
                      goldValue === `${g.instanceId}#${it.index}` ? "bg-success/20" : judged.has(`${g.instanceId}#${it.index}`) ? "bg-info/10" : "",
                    )}
                    title={it.description ?? it.summary}
                  >
                    <b>{it.index + 1}</b> [{it.severity}] {it.file ? `${it.file.split("/").pop()}:${it.line ?? "?"}` : "no file"} —{" "}
                    <span className="text-base-content/70">{(it.description ?? it.summary).slice(0, 280)}</span>
                  </li>
                ))}
              </ol>
            </div>
          ))}
        </div>
      </div>

      {f.proposals.map((p) => (
        <ProposalBox key={p.grader} f={f} p={p} accept={() => accept(p)} />
      ))}

      {f.similar.length > 0 && !l && (
        <div className="mt-2 font-mono text-2xs text-base-content/50">
          similar, graded:{" "}
          {f.similar.map((s) => (
            <span key={s.key} className="mr-3">
              L{s.line} "{s.title.slice(0, 60)}" → {s.label.real}
              {s.label.importance ? `/${s.label.importance}` : ""}{" "}
              <button
                className="text-info hover:underline"
                onClick={(e) => {
                  e.stopPropagation();
                  const gold = s.label.gold && f.gold.some((g) => g.instanceId === s.label.gold!.instanceId) ? s.label.gold : null;
                  commit({ real: s.label.real, importance: s.label.importance, gold, note: s.label.note });
                }}
              >
                copy
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-2 font-mono text-xs" onClick={(e) => e.stopPropagation()}>
        <span className="text-base-content/40">real?</span>
        {(["yes", "no", "unsure"] as RealGrade[]).map((r) => (
          <button
            key={r}
            onClick={() => commit({ real: r })}
            className={clsx(
              "rounded border px-2 py-0.5",
              l?.real === r
                ? r === "yes"
                  ? "border-success bg-success/20 text-success"
                  : r === "no"
                    ? "border-error bg-error/20 text-error"
                    : "border-warning bg-warning/20 text-warning"
                : "border-base-300 text-base-content/60 hover:border-info",
            )}
          >
            {r}
          </button>
        ))}
        {l?.real === "yes" && (
          <>
            <span className="ml-2 text-base-content/40">importance</span>
            {IMPORTANCE_VALUES.map((imp, i) => (
              <button
                key={imp}
                onClick={() => commit({ importance: imp })}
                className={clsx(
                  "rounded border px-2 py-0.5",
                  l.importance === imp ? "border-info bg-info/20 text-info" : "border-base-300 text-base-content/60 hover:border-info",
                )}
              >
                {i + 1} {IMP_SHORT[imp]}
              </button>
            ))}
          </>
        )}
        <select
          className="select select-bordered select-xs ml-2 max-w-72 font-mono"
          disabled={!l?.real}
          value={goldValue}
          onChange={(e) => {
            const [instanceId, idx] = e.target.value.split("#");
            commit({ gold: e.target.value ? { instanceId, index: Number(idx) } : null });
          }}
        >
          <option value="">no gold link</option>
          {f.gold.flatMap((g) =>
            g.items.map((it) => (
              <option key={`${g.instanceId}#${it.index}`} value={`${g.instanceId}#${it.index}`}>
                same as {f.gold.length > 1 ? `${shortInst(g.instanceId)} ` : ""}gold {it.index + 1}
              </option>
            )),
          )}
        </select>
        <input
          className="input input-bordered input-xs w-64 font-mono"
          placeholder={l?.real ? "note (enter to save)" : "grade first"}
          disabled={!l?.real}
          value={note}
          maxLength={500}
          onChange={(e) => setNote(e.target.value)}
          onBlur={saveNote}
          onKeyDown={(e) => {
            if (e.key === "Enter") (e.target as HTMLInputElement).blur();
          }}
        />
        {l && (
          <button className="text-base-content/40 hover:text-error" title="clear the grade (x)" onClick={() => commit({ real: null, importance: null, gold: null, note: null })}>
            clear
          </button>
        )}
        {l && <span className="text-2xs text-base-content/30">graded {new Date(l.gradedAt).toLocaleString()}</span>}
      </div>
    </article>
  );
}

/** The phase-replay detail page's box: this report's findings, graded by hand. */
export function HumanGradesBox({ reportId, reportLabel }: { reportId: string; reportLabel: string }) {
  const { data } = useFindings();
  const navigate = useNavigate();
  if (!data) return null;
  const mine = data.findings
    .map((f) => ({ ...f, appearances: f.appearances.filter((a) => a.reportId === reportId) }))
    .filter((f) => f.appearances.length);
  if (!mine.length) return null;
  const [m] = gradedMetrics(mine, labelsOf(mine));
  return (
    <div className="mb-4 flex flex-wrap items-center gap-x-5 gap-y-1 rounded-xl border border-base-300 bg-base-200 px-4 py-3 font-mono text-xs">
      <span className="text-2xs font-semibold uppercase tracking-wide text-base-content/50">human grades</span>
      <span>
        {m.graded}/{m.findings} graded
      </span>
      <span className="text-success">{m.real} real</span>
      <span className="text-error">{m.notReal} not real</span>
      <span>{m.unsure} unsure</span>
      <span className="font-semibold">{m.realImportant} real-important</span>
      <span title="real ÷ graded">human P {m.precision === null ? NA : m.precision.toFixed(2)}</span>
      <span>{m.goldLinked} gold-linked</span>
      <button className="ml-auto text-info hover:underline" onClick={() => navigate(GRADE_TIER_KEY, reportLabel)}>
        grade these →
      </button>
    </div>
  );
}

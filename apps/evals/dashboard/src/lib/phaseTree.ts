import type { PhaseMetric, PhaseSession } from "../types";

/** One row in the phase panel: a workflow phase, with its transcript when it
 * archived one.
 *
 * Two lists have to be reconciled to build these, and they do NOT agree:
 *
 *  - `scorecard.json` → `results[].phases[]` is the LEDGER — one row per phase
 *    the runner dispatched, including skipped ones, and for a `fanout` phase one
 *    row PER BRANCH (`survey_branch_contract`, …).
 *  - `sessions[].phases[]` is the ARCHIVE — one `NN-<phase>.jsonl` per phase
 *    WINDOW. A fan-out is one window, so its six branches share a single file.
 *
 * So on the same run the ledger says `survey_branch_{contract,…,spec}` (six
 * rows, no file) while the archive says `survey` (one file, no ledger row). The
 * panel needs the ledger's order and vocabulary with the archive's transcripts,
 * which is what {@link buildPhaseRows} joins. */
export interface PhaseRow {
  /** The phase window's name — what the archive calls it (`survey`), or the
   * ledger name when there is no archived transcript (`prepare`). */
  phase: string;
  /** Run-relative path of the archived transcript, when there is one. */
  log?: string;
  success?: boolean;
  /** The phase's own ledger row. Absent for a fan-out, whose ledger rows are
   * per-branch — see {@link branches}. */
  metric?: PhaseMetric;
  /** Ledger rows folded under this phase (a fan-out's branches). Their `phase`
   * values are the authoritative branch labels the sidebar names lanes with. */
  branches: PhaseMetric[];
  /** Why this row has no transcript to open:
   *  - `log` — it has one.
   *  - `skipped` — the phase never started. Claimed ONLY when the run is
   *    instrumented (see {@link buildPhaseRows}); `prepare` and `falsify` take
   *    this path on every probes-off run and must not read as failures.
   *  - `no-transcript` — it archived no session of its own. Either a
   *    deterministic `bash` phase like `facts` / `reconcile`, or a phase whose
   *    timing simply cannot be recovered. */
  state: "log" | "skipped" | "no-transcript";
}

/** `<phase>_branch_<family>`, with the loop/gate suffixes the ledger appends. */
const BRANCH_RE = /^(.+)_branch_(.+?)(?:_retry|_check)?$/;

/**
 * Join the ledger and the archive into one ordered phase list.
 *
 * Order comes from the LEDGER, because that is workflow declaration order — what
 * a reader expects to scan top-to-bottom. Ordering by the archive instead would
 * drop every skipped phase off the list entirely, since a phase that never ran
 * wrote no file.
 *
 * Anything the ledger does not mention is appended in archive order afterwards,
 * so a run measured before per-phase metrics existed still renders its
 * transcripts rather than nothing.
 */
export function buildPhaseRows(metrics: PhaseMetric[], phases: PhaseSession[]): PhaseRow[] {
  // Is this run's timing measured, or back-filled?
  //
  // `durationMs` is written live by the phase callbacks. `scripts/rescore.ts` can
  // only recover `agentMs` — it sums the `result` envelopes an old run already
  // wrote — so on a back-filled run EVERY phase lacks `durationMs`, and a `bash`
  // phase that really ran (`facts`) is then indistinguishable from one that was
  // skipped (`prepare`). Measured: on `2026-08-22_123348` not one of fifteen
  // rows carries a `durationMs`.
  //
  // So "absent duration means skipped" is only sound where SOMETHING was
  // measured. Where nothing was, the weaker claim is the true one — a confident
  // wrong label is worse than an honest blank.
  const instrumented = metrics.some((m) => m.durationMs !== undefined);
  const byName = new Map(phases.map((p) => [p.phase, p]));
  const claimed = new Set<string>();
  const rows: PhaseRow[] = [];
  const rowFor = new Map<string, PhaseRow>();

  /** The archived phase a ledger name belongs to: exact, else longest declared
   * prefix — the same grouping the server dashboard's pipeline uses to nest
   * `reviewer_fix_1` under `reviewer`. */
  const archiveFor = (name: string): PhaseSession | undefined =>
    byName.get(name) ??
    phases.filter((p) => name.startsWith(p.phase)).sort((a, b) => b.phase.length - a.phase.length)[0];

  for (const m of metrics) {
    const branch = BRANCH_RE.exec(m.phase);
    if (branch && byName.has(branch[1])) {
      // A fan-out branch: fold it under its window, creating that row at the
      // position of the FIRST branch so the phase lands where it ran.
      const parent = branch[1];
      let row = rowFor.get(parent);
      if (!row) {
        const archived = byName.get(parent) as PhaseSession;
        row = { phase: parent, log: archived.log, success: archived.success, branches: [], state: "log" };
        rowFor.set(parent, row);
        rows.push(row);
        claimed.add(parent);
      }
      row.branches.push(m);
      continue;
    }

    const archived = archiveFor(m.phase);
    if (archived && !claimed.has(archived.phase)) {
      const row: PhaseRow = {
        phase: m.phase,
        log: archived.log,
        success: archived.success ?? m.success,
        metric: m,
        branches: [],
        state: "log",
      };
      rowFor.set(archived.phase, row);
      rows.push(row);
      claimed.add(archived.phase);
      continue;
    }

    // No transcript of its own — either it never ran, or it ran without
    // archiving one. A skipped phase is a correct outcome, not an error, so it
    // is worth naming as such — but only where the run's timing is real.
    const noTiming = m.durationMs === undefined && m.agentMs === undefined;
    rows.push({
      phase: m.phase,
      metric: m,
      branches: [],
      state: noTiming && instrumented ? "skipped" : "no-transcript",
    });
  }

  for (const p of phases) {
    if (claimed.has(p.phase)) continue;
    rows.push({ phase: p.phase, log: p.log, success: p.success, branches: [], state: "log" });
  }

  return rows;
}

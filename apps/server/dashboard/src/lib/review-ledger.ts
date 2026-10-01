/**
 * Pure readers for pr-review's coverage report and review ledger (issue #429),
 * as `post-review` records them on the run row:
 *
 * - `scratch.reviewCoverage` — which units this review surveyed / investigated;
 * - `scratch.reviewLedger` — the PR's cumulative memory of findings after this
 *   round's fold;
 * - `context.prState.reviewLedger` — the ledger the run was DISPATCHED with
 *   (the previous round's), which is all there is when the run never reached
 *   `post-review`.
 *
 * Both keys exist only when `review.analysis` is on, and only on runs from the
 * release that added them — so every reader returns null on anything it does
 * not recognise (missing, wrong `version`, wrong shape) and the panel renders
 * nothing. Nothing here re-derives a verdict: status, risk and delta are shown
 * as the server recorded them.
 */
import type {
  LedgerFinding,
  LedgerStatus,
  ReviewCoverage,
  ReviewCoverageUnit,
  ReviewLedger,
  ReviewRisk,
  WorkflowRun,
} from "../api";

type Dict = Record<string, unknown>;
const asDict = (v: unknown): Dict | null =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Dict) : null;

/** `scratch.reviewCoverage`, or null when absent / not a version-1 report. */
export function reviewCoverageOf(run: Pick<WorkflowRun, "scratch">): ReviewCoverage | null {
  const c = asDict(run.scratch?.reviewCoverage);
  if (!c || c.version !== 1 || !asDict(c.inScope) || !Array.isArray(c.units)) return null;
  return {
    ...(c as unknown as ReviewCoverage),
    carried: (asDict(c.carried) as ReviewCoverage["carried"] | null) ?? { units: 0, touched: 0 },
    notInvestigated: Array.isArray(c.notInvestigated)
      ? c.notInvestigated.filter((k): k is string => typeof k === "string")
      : [],
    units: (c.units as unknown[]).filter((u): u is ReviewCoverageUnit => !!asDict(u)),
  };
}

function ledgerFrom(v: unknown): ReviewLedger | null {
  const l = asDict(v);
  if (!l || l.version !== 1 || !Array.isArray(l.findings)) return null;
  return {
    ...(l as unknown as ReviewLedger),
    units: Array.isArray(l.units) ? (l.units as ReviewLedger["units"]) : [],
    findings: (l.findings as unknown[]).filter((f): f is LedgerFinding => !!asDict(f)),
  };
}

/** `scratch.reviewLedger` — the ledger after this run's fold. */
export function reviewLedgerOf(run: Pick<WorkflowRun, "scratch">): ReviewLedger | null {
  return ledgerFrom(run.scratch?.reviewLedger);
}

/** `context.prState.reviewLedger` — the ledger this run was dispatched with. */
export function dispatchedLedgerOf(run: Pick<WorkflowRun, "context">): ReviewLedger | null {
  return ledgerFrom(asDict(run.context?.prState)?.reviewLedger);
}

/** Does the run carry anything the review panel can show? Gates the tab. */
export function hasReviewLedger(run: Pick<WorkflowRun, "scratch" | "context">): boolean {
  return !!(reviewCoverageOf(run) || reviewLedgerOf(run) || dispatchedLedgerOf(run));
}

export const RISK_ORDER: Record<ReviewRisk, number> = { critical: 3, high: 2, medium: 1, low: 0 };

/** Risk desc, then touched lines desc, then key — a stable reading order. */
export function sortCoverageUnits(units: readonly ReviewCoverageUnit[]): ReviewCoverageUnit[] {
  return [...units].sort(
    (a, b) =>
      (RISK_ORDER[b.risk] ?? -1) - (RISK_ORDER[a.risk] ?? -1) ||
      (b.touched ?? 0) - (a.touched ?? 0) ||
      String(a.key).localeCompare(String(b.key)),
  );
}

/** `n / of` as a whole percentage, or "—" when there is nothing to divide by. */
export function pct(n: number | null | undefined, of: number | null | undefined): string {
  if (typeof n !== "number" || typeof of !== "number" || of <= 0) return "—";
  return `${Math.round((n / of) * 100)}%`;
}

/** A recorded 0–100 percentage (the risk-weighted ones), or "—" for null. */
export function weighted(v: number | null | undefined): string {
  return typeof v === "number" ? `${Math.round(v)}%` : "—";
}

/** `file:start-end`, `file:line`, or just the file for a span-less unit (the key when there is no file). */
export function unitLocation(u: Pick<ReviewCoverageUnit, "key" | "file" | "lines">): string {
  const file = u.file ?? u.key;
  if (!u.lines) return file;
  const [s, e] = u.lines;
  return s === e ? `${file}:${s}` : `${file}:${s}-${e}`;
}

export const LEDGER_STATUSES: readonly LedgerStatus[] = ["open", "withheld", "addressed", "resolved"];

/**
 * Findings grouped by status in {@link LEDGER_STATUSES} order, empty groups
 * dropped. An unrecognised status keeps its own group at the end rather than
 * vanishing — a status added in core should be visible before it is styled.
 */
export function groupLedgerFindings(
  findings: readonly LedgerFinding[],
): { status: string; findings: LedgerFinding[] }[] {
  const groups = new Map<string, LedgerFinding[]>();
  for (const s of LEDGER_STATUSES) groups.set(s, []);
  for (const f of findings) {
    const key = typeof f.status === "string" ? f.status : "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key)!.push(f);
  }
  return [...groups].filter(([, fs]) => fs.length > 0).map(([status, fs]) => ({ status, findings: fs }));
}

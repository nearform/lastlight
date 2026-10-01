/**
 * Who looked at which part of the change, and the re-review convergence gate
 * (issue #429). Pure: `site-review.ts` reads the artifacts and writes the
 * results.
 *
 * **Coverage.** The diff is bounded, so the review can say how much of it was
 * actually looked at and how. Two levels, because they are not the same claim:
 *
 * - `surveyed` — a unit-survey call answered for the unit (`units/ingest.json`
 *   status `ok` or `partial`). Every changed unit, up to the unit cap.
 * - `investigated` — one of the unit's hypothesis rows sat in a site an
 *   investigator worked and closed with findings or a checked `none`. Only the
 *   top sites get one, so this is the number that moves.
 *
 * Both are also weighed by risk (`RISK_WEIGHT` × touched lines), so "70% of
 * the changed lines" cannot hide that the migration was the 30% nobody read.
 * On a re-review, `unchanged` units are reported as `carried` — the last
 * review had them — and the percentages are over the in-scope units.
 *
 * **The convergence gate.** On a re-review, a finding whose anchored lines
 * were all already there at the last review (`anchorDelta`, per line, not per
 * unit) is a LATE discovery: it could have been raised last time, and raising
 * it now restarts the author's loop. It is withheld (`tier: internal`,
 * `withheld: "converged"`, kept in the ledger) unless it is `must-fix` above
 * `low` risk — then it posts, labelled as missed earlier. That includes a
 * finding a fix CAUSED on lines it did not touch: measured on lastlight#424,
 * those were Minor too, and a must-fix one still posts. A finding on any new
 * or changed line is never gated.
 */
import type { HypothesisSet } from "./hypotheses.js";
import { inScope, type AnchorDelta, type UnitDelta } from "./review-delta.js";
import { RISK_WEIGHT, type RiskTier } from "./risk.js";

export const REVIEW_COVERAGE_FILE = "review-coverage.json";
export const REVIEW_COVERAGE_VERSION = 1;

/** The `units.json` fields this module reads. */
export interface CoverageUnitInput {
  id: string;
  kind: string;
  file: string | null;
  symbol: string | null;
  lines: [number, number] | null;
  splitOf?: string;
  key?: string;
  touched?: number;
  risk?: RiskTier;
  delta?: UnitDelta;
}

// ── the gate ──────────────────────────────────────────────────────────────

/**
 * The unit a finding at `path:line` sits in: the narrowest unit of that file
 * whose extent holds the line. `null` when no unit does — the finding is on
 * code the diff did not touch, reached from an in-scope site.
 */
export function locateUnit<U extends CoverageUnitInput>(units: readonly U[], path: string, line: number): U | null {
  let best: U | null = null;
  for (const u of units) {
    if (u.file !== path || !u.lines || line < u.lines[0] || line > u.lines[1]) continue;
    if (!best || u.lines[1] - u.lines[0] < best.lines![1] - best.lines![0]) best = u;
  }
  return best;
}

export type ConvergenceVerdict =
  /** First review, or the anchored code is new since the last review. */
  | "post"
  /** Unchanged code, but must-fix above `low` risk: post, labelled as missed earlier. */
  | "late"
  /** Unchanged code: withheld, recorded in the ledger. */
  | "withhold";

/**
 * `anchor` is {@link anchorDelta}'s answer (`null` on a first review); `risk`
 * is the containing unit's tier (`medium` outside every unit).
 */
export function convergenceVerdict(anchor: AnchorDelta | null, risk: RiskTier | undefined, importance: string | null | undefined): ConvergenceVerdict {
  if (anchor !== "unchanged") return "post";
  if (importance === "must-fix" && risk !== "low") return "late";
  return "withhold";
}

/** What a late, posted finding's body opens with. */
export const LATE_FINDING_LABEL =
  "**Missed in an earlier review.** This code has not changed since the last review, but this one is must-fix.";

// ── coverage ──────────────────────────────────────────────────────────────

export interface CoverageUnit {
  /** The unsplit unit's id (`splitOf`, else `id`). */
  id: string;
  key: string | null;
  file: string | null;
  symbol: string | null;
  lines: [number, number] | null;
  touched: number;
  risk: RiskTier;
  delta: UnitDelta | null;
  surveyed: boolean;
  /** The best outcome among the sites holding its rows: `findings` beats `none`. */
  investigated: "findings" | "none" | null;
  /** Site ids (primaries and pairs) that held its rows. */
  sites: string[];
}

export interface CoverageTotals {
  units: number;
  touched: number;
  surveyedUnits: number;
  surveyedTouched: number;
  investigatedUnits: number;
  investigatedTouched: number;
  /** Percentages over touched lines × risk weight, 0–100, one decimal; `null` with nothing to weigh. */
  surveyedWeighted: number | null;
  investigatedWeighted: number | null;
}

export interface ReviewCoverage {
  version: typeof REVIEW_COVERAGE_VERSION;
  generatedAt: string;
  /** Units carried a `delta`: the totals are over the in-scope units only. */
  rereview: boolean;
  /** Over every unit that is not `carried` (all of them on a first review). */
  inScope: CoverageTotals;
  /** `unchanged` units on a re-review — the last review had them. */
  carried: { units: number; touched: number };
  /** In-scope units nobody investigated, highest risk and most touched first (keys, at most 20). */
  notInvestigated: string[];
  units: CoverageUnit[];
}

export interface CoverageInput {
  units: readonly CoverageUnitInput[];
  /** `units/ingest.json` per-unit statuses; absent ⇒ nothing counts as surveyed. */
  ingest: readonly { unitId: string; status: string }[] | null;
  /** `sites/plan.json` slots: site id → the hypothesis rows of its site. */
  slots: readonly { siteId: string; site: { rows: string[] } }[];
  /** `sites/merged.json` slots: what each investigator closed with. */
  outcomes: readonly { siteId: string; outcome: string }[];
  set: Pick<HypothesisSet, "byId">;
}

const SURVEYED = new Set(["ok", "partial"]);
const pct = (num: number, den: number): number | null => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

export function buildReviewCoverage(input: CoverageInput): ReviewCoverage {
  const parentOf = (u: CoverageUnitInput): string => u.splitOf ?? u.id;
  const statusOf = new Map((input.ingest ?? []).map((r) => [r.unitId, r.status]));
  const outcomeOf = new Map(input.outcomes.map((o) => [o.siteId, o.outcome]));

  // Unit (by parent id) → sites holding its rows, with their outcomes.
  const sitesOf = new Map<string, Set<string>>();
  const bestOf = new Map<string, "findings" | "none">();
  const unitById = new Map(input.units.map((u) => [u.id, u]));
  for (const slot of input.slots) {
    const outcome = outcomeOf.get(slot.siteId);
    for (const rowId of slot.site.rows) {
      const unitId = (input.set.byId.get(rowId)?.row as { unitId?: unknown } | undefined)?.unitId;
      const unit = typeof unitId === "string" ? unitById.get(unitId) : undefined;
      if (!unit) continue;
      const parent = parentOf(unit);
      (sitesOf.get(parent) ?? sitesOf.set(parent, new Set()).get(parent)!).add(slot.siteId);
      if (outcome === "findings") bestOf.set(parent, "findings");
      else if (outcome === "none" && !bestOf.has(parent)) bestOf.set(parent, "none");
    }
  }

  // One entry per unsplit unit.
  const grouped = new Map<string, CoverageUnitInput[]>();
  for (const u of input.units) grouped.set(parentOf(u), [...(grouped.get(parentOf(u)) ?? []), u]);
  const units: CoverageUnit[] = [...grouped].map(([id, members]) => {
    const head = members[0]!;
    return {
      id,
      key: head.key ?? null,
      file: head.file,
      symbol: head.symbol,
      lines: head.lines,
      touched: head.touched ?? 0,
      risk: head.risk ?? "medium",
      delta: head.delta ?? null,
      surveyed: members.some((m) => SURVEYED.has(statusOf.get(m.id) ?? "")),
      investigated: bestOf.get(id) ?? null,
      sites: [...(sitesOf.get(id) ?? [])].sort(),
    };
  });

  const rereview = input.units.some((u) => u.delta !== undefined);
  const scoped = units.filter((u) => inScope(u.delta ?? undefined));
  const carried = units.filter((u) => !inScope(u.delta ?? undefined));
  const weigh = (us: CoverageUnit[]): number => us.reduce((n, u) => n + u.touched * RISK_WEIGHT[u.risk], 0);
  const sum = (us: CoverageUnit[]): number => us.reduce((n, u) => n + u.touched, 0);
  const surveyed = scoped.filter((u) => u.surveyed);
  const investigated = scoped.filter((u) => u.investigated !== null);
  const rank = (u: CoverageUnit): number => RISK_WEIGHT[u.risk] * 1e6 + u.touched;

  return {
    version: REVIEW_COVERAGE_VERSION,
    generatedAt: new Date().toISOString(),
    rereview,
    inScope: {
      units: scoped.length,
      touched: sum(scoped),
      surveyedUnits: surveyed.length,
      surveyedTouched: sum(surveyed),
      investigatedUnits: investigated.length,
      investigatedTouched: sum(investigated),
      surveyedWeighted: pct(weigh(surveyed), weigh(scoped)),
      investigatedWeighted: pct(weigh(investigated), weigh(scoped)),
    },
    carried: { units: carried.length, touched: sum(carried) },
    notInvestigated: scoped
      .filter((u) => u.investigated === null && u.touched > 0)
      .sort((a, b) => rank(b) - rank(a))
      .slice(0, 20)
      .map((u) => u.key ?? u.id),
    units,
  };
}

export function renderReviewCoverage(c: ReviewCoverage): string {
  const t = c.inScope;
  const lines = [
    `coverage: ${t.units} unit(s), ${t.touched} touched line(s)${c.rereview ? ` in scope (${c.carried.units} unit(s) / ${c.carried.touched} line(s) carried from the last review)` : ""}`,
    `  surveyed ${t.surveyedUnits}/${t.units} unit(s), ${t.surveyedTouched}/${t.touched} line(s), ${t.surveyedWeighted ?? "–"}% risk-weighted`,
    `  investigated ${t.investigatedUnits}/${t.units} unit(s), ${t.investigatedTouched}/${t.touched} line(s), ${t.investigatedWeighted ?? "–"}% risk-weighted`,
  ];
  if (c.notInvestigated.length) lines.push(`  not investigated: ${c.notInvestigated.slice(0, 8).join(", ")}${c.notInvestigated.length > 8 ? ", …" : ""}`);
  return `${lines.join("\n")}\n`;
}

import {
  agentCost,
  agentWall,
  assertedOf,
  fmtGoldFraction,
  isPartialStatus,
  okModel,
  unitSurveyElapsedMs,
  unitSurveyStatus,
  type UnitSurveyStatus,
} from "../../../src/unit-survey-index.js";
import type { ReplayCase, UnitSurveyEntry } from "../types";
import { fmtDuration } from "./format";

/**
 * The unit-survey page's view model — every cell the list and the per-case
 * table print, as strings, derived here so the "n/a, never 0" rule is testable
 * without rendering (`unitSurvey.test.ts`).
 *
 * `n/a` means the side has NO data: a stage-1 report has no model side; a
 * judge that did not run leaves credited gold unknown; a fixture whose
 * transcripts carried no `survey_branch_*` result lines has no agent wall or $.
 * A measured zero (the judge ran and credited nothing) still prints `0/4`.
 */
export const NA = "n/a";

export const fmtUsd = (x: number | null | undefined): string =>
  x === null || x === undefined || !Number.isFinite(x) ? NA : `$${x.toFixed(x < 1 ? 3 : 2)}`;

export const fmtWallMs = (x: number | null | undefined): string =>
  x === null || x === undefined || !Number.isFinite(x) ? NA : fmtDuration(x);

/** `1234567` → `1.23M`, `101752` → `102k` — request sizes are only read by magnitude. */
export function fmtChars(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return NA;
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Stage-1 coverage as `shown/locatable`, with the unlocatable count beside it. */
export function coverageText(t: { covered: number; locatable: number; unlocatable: number } | undefined): string {
  if (!t) return NA;
  return `${t.covered}/${t.locatable}${t.unlocatable ? ` (+${t.unlocatable} no file)` : ""}`;
}

/** The index row's stage-2 cells. Every one is `n/a` on a stage-1 report. */
export function entryModelCells(e: UnitSurveyEntry): {
  unitsRecall: string;
  agentRecall: string;
  unitsCost: string;
  agentCost: string;
  unitsWall: string;
  agentWall: string;
} {
  const m = e.model;
  if (!m) return { unitsRecall: NA, agentRecall: NA, unitsCost: NA, agentCost: NA, unitsWall: NA, agentWall: NA };
  return {
    unitsRecall: fmtGoldFraction(m.unitsAsserted, m.gold),
    agentRecall: fmtGoldFraction(m.agentAsserted, m.gold),
    unitsCost: fmtUsd(m.unitsCostUsd),
    agentCost: fmtUsd(m.agentCostUsd),
    unitsWall: fmtWallMs(m.unitsWallMs),
    agentWall: fmtWallMs(m.agentWallMs),
  };
}

export interface CaseRow {
  key: string;
  instanceId: string;
  arm: string;
  fixture: string;
  error: string | null;
  units: string;
  requestChars: string;
  truncated: string;
  coverage: string;
  gold: number;
  /** Stage 2 — `n/a` when the case ran no model (or the model errored). */
  modelError: string | null;
  unitsCredited: string;
  agentCredited: string;
  unitsRows: string;
  agentRows: string;
  calls: string;
  unitsWall: string;
  agentWall: string;
  unitsCost: string;
  agentCost: string;
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

export function caseRow(c: ReplayCase): CaseRow {
  const gold = Array.isArray(c.gold) ? c.gold.length : 0;
  const m = okModel(c);
  const base = {
    key: `${c.arm}/${c.instanceId}`,
    instanceId: c.instanceId,
    arm: c.arm,
    fixture: c.fixture,
    error: c.error ?? null,
    gold,
    modelError: c.model?.error ?? null,
  };
  if (c.error) {
    return {
      ...base,
      units: NA,
      requestChars: NA,
      truncated: NA,
      coverage: NA,
      unitsCredited: NA,
      agentCredited: NA,
      unitsRows: NA,
      agentRows: NA,
      calls: NA,
      unitsWall: NA,
      agentWall: NA,
      unitsCost: NA,
      agentCost: NA,
    };
  }
  return {
    ...base,
    units: String(c.shape.units),
    requestChars: fmtChars(c.shape.requestChars),
    truncated: String(c.shape.truncated),
    coverage: coverageText(c.coverageTally),
    unitsCredited: m ? fmtGoldFraction(assertedOf(m.unitsScore), gold) : NA,
    agentCredited: m ? fmtGoldFraction(assertedOf(m.agentScore), gold) : NA,
    unitsRows: m ? String(sum(Object.values(m.rowsByFamily ?? {}))) : NA,
    agentRows: m ? String(m.agentRows) : NA,
    calls: m ? `${m.unitsOk} ok / ${m.unitsFailed} failed · ${m.calls} call${m.calls === 1 ? "" : "s"}` : NA,
    unitsWall: m ? fmtWallMs(m.wallMs) : NA,
    agentWall: m ? fmtWallMs(agentWall(m)) : NA,
    unitsCost: m ? fmtUsd(m.costUsd) : NA,
    agentCost: m ? fmtUsd(agentCost(m)) : NA,
  };
}

// ── progress / status ───────────────────────────────────────────────────────

export interface UnitSurveyProgress {
  status: UnitSurveyStatus;
  /** Totals are over the cases done so far — label every aggregate partial. */
  partial: boolean;
  /** `3/8 cases` (or `3 cases` on a report with no recorded plan). */
  cases: string;
  /** `12m 4s` — to now while running, to the last heartbeat when it died. */
  elapsed: string;
  /** The chip text: `running · 3/8`, `stale (killed) · 3/8`, `failed · 3/8`, `done · 8 cases`. */
  chip: string;
}

/** The status + progress a list row, the detail header and the home page show —
 * derived once here from {@link unitSurveyStatus}. */
export function unitSurveyProgress(e: UnitSurveyEntry, nowMs: number): UnitSurveyProgress {
  const status = unitSurveyStatus(e, nowMs);
  const planned = typeof e.planned === "number" ? e.planned : null;
  const cases = planned === null ? `${e.cases} case${e.cases === 1 ? "" : "s"}` : `${e.cases}/${planned} cases`;
  const elapsedMs = unitSurveyElapsedMs(e, nowMs);
  const counts = planned === null ? String(e.cases) : `${e.cases}/${planned}`;
  const chip =
    status === "running"
      ? `running · ${counts}`
      : status === "stale"
        ? `stale (killed) · ${counts}`
        : status === "failed"
          ? `failed · ${counts}`
          : `done · ${cases}`;
  return { status, partial: isPartialStatus(status), cases, elapsed: fmtWallMs(elapsedMs), chip };
}

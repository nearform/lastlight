/**
 * `probe-plan` — the deterministic decision of WHICH hypotheses `falsify` probes.
 *
 * Before this existed the decision lived in the falsify prompt: *"read every
 * `hypotheses/*.jsonl` line; probe every row with `"needsProbe": true` and every
 * row with `"severity": "Critical"`"*. Two things broke it, both measured on the
 * first unit-survey arm (2026-09-27, 8 skillspro cases):
 *
 * - **The model could not see what it owed.** `severity` is DERIVED from the
 *   evidence record (`survey-verdict.ts`) and never written on a row, so a
 *   prompt keyed on the literal field found nothing. `requiresProbe` — the gate
 *   — derives it, so the gate owed 21 rows on `1587-r1` and the agent probed
 *   one. With one round (`probeRounds: 1`) the gate's gap list never reached the
 *   agent at all, and `then: complete` folded the gaps away.
 * - **Nothing bounded the ask.** The unit survey writes 3.3× the agent survey's
 *   rows, and 20–33 of them per case derive Critical, against 0–2 under the
 *   agent survey. One agent in one round cannot probe thirty claims.
 *
 * So the owed set is computed HERE, once, from the same `requiresProbe` the gate
 * uses, ranked, and cut at `maxProbes`. `falsify` reads `probes/plan.md` — the
 * selected records verbatim — instead of every hypothesis file, and the gate
 * reads `probes/plan.json`, so the prompt, the gate and the dossier agree on
 * one list. A row past the cap is not dropped: it reaches `adjudicate` exactly
 * as an unprobed row always has, and the dossier says why.
 *
 * The rank reads only the evidence record, never a claim's prose: Critical
 * first, then a row the survey could not answer at all, then by how much of the
 * mechanism is left open (`ABSENT` before `PARTIAL` before `QUOTE`), then
 * declaration order. It is a deterministic tiebreak, not a quality model —
 * which rows are worth an oracle's time is what the micro-falsify eval is for.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { readHypothesisSet, type HypothesisRecord, type HypothesisSet } from "./hypotheses.js";
import { requiresProbe, type HypothesisLine } from "./probes.js";
import { deriveVerdict, hasEvidence, severityOf, type SurveyEvidence } from "./survey-verdict.js";

export const PROBE_PLAN_VERSION = 1;

/**
 * Why a row is owed a probe. The gate's two clauses, named — plus `site`: a
 * row `requiresProbe` does not owe, selected because it shares a site several
 * rows point at (`site-cluster.ts`, `planProbeSites`).
 */
export type OwedReason = "critical" | "asked" | "site";

export interface PlannedProbe {
  /** Canonical `<family>-NNN`, as every other reader resolves it. */
  id: string;
  family: string;
  /** 1-based position in the ranked owed list (selected and deferred share one sequence). */
  rank: number;
  reason: OwedReason;
  /** `deriveVerdict(evidence).discharge`, or `null` for a row with no evidence record. */
  discharge: string | null;
}

export interface ProbePlan {
  version: typeof PROBE_PLAN_VERSION;
  /** The cap applied; `null` = unlimited. */
  maxProbes: number | null;
  /** Every hypothesis row read. */
  rows: number;
  /** Rows `requiresProbe` owes a verdict on, before the cap. */
  owed: number;
  /** What `falsify` is asked to probe, in rank order. */
  selected: PlannedProbe[];
  /** Owed, but past the cap. They reach `adjudicate` unprobed. */
  deferred: PlannedProbe[];
}

const DISCHARGE_ORDER: Record<string, number> = { ABSENT: 0, PARTIAL: 1, QUOTE: 2 };

function reasonOf(row: HypothesisLine): OwedReason {
  return (severityOf(row) ?? "").toLowerCase() === "critical" ? "critical" : "asked";
}

function dischargeOf(row: HypothesisLine): string | null {
  const e = (row as { evidence?: unknown }).evidence as SurveyEvidence | undefined;
  return hasEvidence(e) ? deriveVerdict(e as SurveyEvidence).discharge : null;
}

/**
 * One row as a plan entry, for a plan built by something other than
 * {@link planProbes} (a per-site plan). A row the gate would owe anyway keeps
 * its own reason; any other row is there because of its site.
 */
export function plannedProbe(record: HypothesisRecord, rank: number): PlannedProbe {
  const row = record.row as HypothesisLine;
  return {
    id: record.id,
    family: record.family,
    rank,
    reason: requiresProbe(row) ? reasonOf(row) : "site",
    discharge: dischargeOf(row),
  };
}

/**
 * Rank and cut. Pure: the same hypothesis set and cap always produce the same
 * plan, so a replay of a preserved workspace reproduces the live run's list.
 */
export function planProbes(set: HypothesisSet, options: { maxProbes: number | null }): ProbePlan {
  const owed = set.records
    .map((record, position) => ({ record, position, row: record.row as HypothesisLine }))
    .filter(({ row }) => requiresProbe(row))
    .map(({ record, position, row }) => ({
      record,
      position,
      reason: reasonOf(row),
      discharge: dischargeOf(row),
    }));

  owed.sort(
    (a, b) =>
      Number(a.reason !== "critical") - Number(b.reason !== "critical") ||
      (DISCHARGE_ORDER[a.discharge ?? ""] ?? 3) - (DISCHARGE_ORDER[b.discharge ?? ""] ?? 3) ||
      a.position - b.position,
  );

  const planned = owed.map(
    (o, i): PlannedProbe => ({
      id: o.record.id,
      family: o.record.family,
      rank: i + 1,
      reason: o.reason,
      discharge: o.discharge,
    }),
  );
  const cap = options.maxProbes === null ? planned.length : Math.max(0, Math.floor(options.maxProbes));
  return {
    version: PROBE_PLAN_VERSION,
    maxProbes: options.maxProbes,
    rows: set.records.length,
    owed: planned.length,
    selected: planned.slice(0, cap),
    deferred: planned.slice(cap),
  };
}

export function probePlanPath(dir: string): string {
  return join(dir, "probes", "plan.json");
}

/**
 * The plan a previous `probe-plan` wrote, or `null` when there is none (an
 * older workflow, a replay of a workspace from before this phase existed, or a
 * run where the phase died). Every reader falls back to `requiresProbe` over
 * the whole set on `null`, which is exactly the behaviour before the plan.
 * An unreadable file is also `null` — the fallback is the conservative answer.
 */
export function readProbePlan(dir: string): ProbePlan | null {
  const path = probePlanPath(dir);
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as ProbePlan;
    if (parsed?.version !== PROBE_PLAN_VERSION || !Array.isArray(parsed.selected) || !Array.isArray(parsed.deferred)) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * The site a per-site plan covers — enough for the header `renderProbePlan`
 * writes above its rows. Structural, so this module does not import the
 * clusterer that produces it.
 */
export interface PlanSite {
  id: string;
  path: string | null;
  startLine: number | null;
  endLine: number | null;
  support: number;
}

function renderSiteHeader(site: PlanSite): string[] {
  const where =
    site.path === null
      ? "a hypothesis with no anchor"
      : `\`${site.path}\`${site.startLine !== null ? ` lines ${site.startLine}–${site.endLine}` : ""}`;
  return [
    `## Site \`${site.id}\` — ${where}`,
    "",
    site.support > 1
      ? `This session covers ONE stretch of code, which ${site.support} hypotheses from independent survey passes point at. Several of them are likely the SAME defect described differently.`
      : "This session covers ONE hypothesis.",
    "",
    "Before probing, group the rows below into distinct **claims** — rows that assert the same defect mechanism at the same place are one claim — and name them `C1`, `C2`, … Probe each claim once. Then write one verdict line per ROW, as the Output section says, with one extra field:",
    "",
    '```\n"claim": "C1"\n```',
    "",
    "Rows in one claim share one verdict and may cite one transcript. A row that asserts something different from every other row is its own claim.",
    "",
  ];
}

/**
 * What `falsify` reads: the selected records, verbatim, in rank order. The
 * record is the whole row — the oracle is a deliberately fresh reader and gets
 * the claim, its evidence and its quotes, never an earlier pass's reasoning.
 * With `site`, the plan is one site's (a per-site session) and opens with the
 * site and the ask to group its rows into claims.
 */
export function renderProbePlan(plan: ProbePlan, set: HypothesisSet, site?: PlanSite): string {
  const out: string[] = site ? renderSiteHeader(site) : [];
  const capNote =
    plan.deferred.length > 0
      ? ` ${plan.deferred.length} more were owed and are past this deployment's cap of ${plan.maxProbes}; they go to adjudication unprobed and are not yours to probe.`
      : "";
  if (plan.selected.length === 0) {
    out.push(
      plan.rows === 0
        ? "No hypotheses were written, so there is nothing to probe. Write no verdicts and stop."
        : `None of the ${plan.rows} hypotheses is owed a probe.${capNote} Write no verdicts and stop.`,
    );
    return `${out.join("\n")}\n`;
  }
  out.push(
    `${plan.selected.length} of ${plan.rows} hypotheses are yours to probe, most important first.${capNote}`,
    "",
  );
  for (const p of plan.selected) {
    const record: HypothesisRecord | undefined = set.byId.get(p.id);
    const why =
      p.reason === "critical"
        ? "derived severity Critical"
        : p.reason === "asked"
          ? "the survey asked for a probe"
          : "shares this site with other hypotheses";
    out.push(`### ${p.rank}. \`${p.id}\` — ${why}`, "");
    out.push("```json", JSON.stringify({ ...(record?.row ?? {}), id: p.id }, null, 2), "```", "");
  }
  return `${out.join("\n")}\n`;
}

export interface WriteProbePlanResult {
  plan: ProbePlan;
  /** `probes/plan.json`. */
  jsonPath: string;
  /** `probes/plan.md`. */
  markdownPath: string;
}

/** Read `hypotheses/`, plan, and write `probes/plan.json` + `probes/plan.md`. */
export function writeProbePlan(dir: string, options: { maxProbes: number | null }): WriteProbePlanResult {
  const set = readHypothesisSet(dir);
  return writeProbePlanFiles(dir, planProbes(set, options), set);
}

/** Write an already-computed plan — a per-site session's, or the union the gate checks. */
export function writeProbePlanFiles(dir: string, plan: ProbePlan, set: HypothesisSet, site?: PlanSite): WriteProbePlanResult {
  mkdirSync(join(dir, "probes"), { recursive: true });
  const jsonPath = probePlanPath(dir);
  const markdownPath = join(dir, "probes", "plan.md");
  writeFileSync(jsonPath, `${JSON.stringify(plan, null, 2)}\n`, "utf8");
  writeFileSync(markdownPath, renderProbePlan(plan, set, site), "utf8");
  return { plan, jsonPath, markdownPath };
}

/** One line for the phase log. */
export function renderProbePlanSummary(plan: ProbePlan): string {
  const critical = plan.selected.filter((p) => p.reason === "critical").length;
  return (
    `probe-plan: ${plan.selected.length} selected of ${plan.owed} owed (${critical} Critical) over ${plan.rows} row(s)` +
    (plan.maxProbes === null ? ", no cap" : `, cap ${plan.maxProbes}`) +
    (plan.deferred.length ? `; ${plan.deferred.length} deferred to adjudication unprobed` : "")
  );
}

/**
 * A posted finding's SEVERITY, derived from evidence rather than written by the
 * adjudicator (issue #405).
 *
 * ── Why ────────────────────────────────────────────────────────────────────
 *
 * The poster ranks by severity and spends two budgets in that order
 * (`review-poster.ts`: the inline cap, then the body cap). On the all-open
 * Martian arm almost every surviving claim carried `Important`, so ranking was
 * a tie broken by document order and any cap cut at random. The survey verdict
 * (`survey-verdict.ts`) already derives a row's severity from its evidence
 * record, but its middle band is wide on purpose — every row with a stated
 * consequence that is not a trust-boundary crossing lands on `Important`,
 * because at SURVEY time that band decides only what gets probed.
 *
 * At POSTING time two more facts exist and neither was being read: whether the
 * consequence reaches beyond the code that holds it (`crosses_boundary` — data
 * lost or silently dropped, an existing caller broken, a trust boundary
 * crossed), and whether falsify EXECUTED the scenario or only read the code.
 * This module folds both into the band, so the same evidence and the same probe
 * record always produce the same rank, and the adjudicator — whose own severity
 * was a judgement, measured flat — cannot restamp it: `lastlight-facts findings
 * --repair` (the `reconcile` phase, after `adjudicate`) overwrites whatever the
 * document says with this, and keeps the adjudicator's value as
 * `declaredSeverity` so a disagreement stays visible.
 *
 * ── The rules, per hypothesis ──────────────────────────────────────────────
 *
 *   refuted by an executed transcript            → Minor
 *   no consequence stated (a discharge)          → Minor
 *   consequence only after a source edit         → Minor
 *   survey-derived Critical (a trust boundary,
 *     a capability the supplier lacks, live)     → Critical
 *   stated live consequence that crosses a
 *     boundary, OR whose scenario falsify
 *     EXECUTED (`probeStrength` = executed)      → Important
 *   any other stated consequence — local, and
 *     only read (`corroborated`), unprobed, or
 *     never asked                                → Minor
 *
 * A row with no evidence record keeps what it declared (the pre-evidence
 * contract), exactly as `severityOf` does. A finding takes the HIGHEST of its
 * constituent hypotheses — a merge can only strengthen, the rule the
 * adjudicator already follows — and a finding that cites none (the review
 * pass's own) is not derived at all: there is nothing to derive from.
 *
 * `corroborated` never raises a band. A search that confirms the code reads the
 * way a claim says is what the survey already did; it is recorded as weaker
 * evidence precisely so it stops counting as a reproduction here.
 *
 * Pure except for {@link stampDerivedSeverity}, which is the one writer.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { type HypothesisRecord, type HypothesisSet, readHypothesisSet, resolveHypothesis } from "./hypotheses.js";
import { noopLogger, type LoggerPort } from "./log.js";
import { type ProbeAnswer, type ProbeStrength, probeStrength, readProbeAnswers } from "./probes.js";
import { FindingsDocumentSchema } from "./schema.js";
import { type Severity, type SurveyEvidence, deriveVerdict, effectiveTrigger, hasEvidence } from "./survey-verdict.js";

const RANK: Record<Severity, number> = { Critical: 3, Important: 2, Minor: 1 };

/** A declared severity in this vocabulary, or `null` for anything else. */
function normaliseSeverity(value: unknown): Severity | null {
  if (typeof value !== "string") return null;
  const v = value.trim().toLowerCase();
  if (v === "critical") return "Critical";
  if (v === "important") return "Important";
  if (v === "minor") return "Minor";
  return null;
}

/**
 * One hypothesis's posting severity, from its evidence record and the strength
 * of its probe. See the module header for the table. `null` only when the row
 * has neither evidence nor a recognisable declared severity.
 */
export function hypothesisSeverity(row: { evidence?: unknown; severity?: unknown }, strength: ProbeStrength): Severity | null {
  if (strength === "refuted") return "Minor";
  const e = row.evidence as SurveyEvidence | undefined;
  if (!hasEvidence(e)) return normaliseSeverity(row.severity);
  const ev = e as SurveyEvidence;
  const survey = deriveVerdict(ev).severity;
  if (survey === "Minor") return "Minor";
  if (effectiveTrigger(ev) === "code_change") return "Minor";
  if (survey === "Critical") return "Critical";
  return ev.crosses_boundary === true || strength === "executed" ? "Important" : "Minor";
}

/** The strongest of several severities; `null` when none is known. */
export function strongestSeverity(values: Iterable<Severity | null>): Severity | null {
  let best: Severity | null = null;
  for (const v of values) if (v && (!best || RANK[v] > RANK[best])) best = v;
  return best;
}

/**
 * Everything a finding's severity is derived from, read once per directory:
 * the hypothesis set and the probe answers, through the same readers the
 * `probes` and `findings` gates use, so the three can never disagree about
 * which claim a citation names or what its probe counted for.
 */
export interface SeverityIndex {
  set: HypothesisSet;
  answers: Map<string, ProbeAnswer>;
  /** One hypothesis's derived severity, by canonical id. */
  ofHypothesis(id: string): Severity | null;
  /**
   * A finding's derived severity: the strongest across the hypotheses it
   * cites that resolve. `null` when it cites none, or none resolve — the
   * caller then keeps whatever the document says.
   */
  ofFinding(finding: { hypotheses?: unknown }): Severity | null;
  /**
   * The facts the poster breaks a severity tie on — see {@link RankEvidence}.
   * `null` exactly when {@link ofFinding} is: nothing cited resolves.
   */
  rankEvidenceOf(finding: { hypotheses?: unknown }): RankEvidence | null;
}

/**
 * What the poster ranks WITHIN a severity band (issue #405). The band has only
 * three values, and the sort is stable, so without these a tie fell to the
 * order the adjudicator happened to write findings in — the one judgement the
 * derivation exists to take away from it. All three are read from the same
 * evidence and probe record the band is, over the cited hypotheses that were
 * not refuted (a refuted constituent is evidence against, not for):
 *
 * - `crossesBoundary` — any constituent's consequence reaches beyond the code
 *   holding it (data lost, a caller broken, a trust boundary crossed).
 * - `probe` — the strongest probe among them: `executed` ran the scenario,
 *   `corroborated` only read code that agrees.
 * - `hypotheses` — how many distinct constituents it merges: independent
 *   survey branches that landed on the same defect.
 *
 * The weighting lives with the poster (`review-poster.ts` `tieBreakOf`); this
 * module only records the facts.
 */
export interface RankEvidence {
  crossesBoundary: boolean;
  probe: "executed" | "corroborated" | "none";
  hypotheses: number;
}

export function buildSeverityIndex(options: { dir: string; repo?: string }): SeverityIndex {
  const set = readHypothesisSet(options.dir);
  const { answers } = readProbeAnswers({ dir: options.dir, repo: options.repo }, set);
  const cache = new Map<string, Severity | null>();
  const ofHypothesis = (id: string): Severity | null => {
    if (cache.has(id)) return cache.get(id)!;
    const record: HypothesisRecord | undefined = set.byId.get(id);
    const value = record ? hypothesisSeverity(record.row, probeStrength(answers.get(id), record.row)) : null;
    cache.set(id, value);
    return value;
  };
  const resolvedIds = (finding: { hypotheses?: unknown }): string[] => {
    const ids = Array.isArray(finding.hypotheses) ? finding.hypotheses : [];
    const resolved = new Set<string>();
    for (const cited of ids) {
      if (typeof cited !== "string") continue;
      const r = resolveHypothesis(set, cited);
      if (r.kind === "resolved") resolved.add(r.id);
    }
    return [...resolved];
  };
  const ofFinding = (finding: { hypotheses?: unknown }): Severity | null =>
    strongestSeverity(resolvedIds(finding).map(ofHypothesis));
  const rankEvidenceOf = (finding: { hypotheses?: unknown }): RankEvidence | null => {
    const ids = resolvedIds(finding);
    if (!ids.length) return null;
    const evidence: RankEvidence = { crossesBoundary: false, probe: "none", hypotheses: 0 };
    for (const id of ids) {
      const record = set.byId.get(id);
      if (!record) continue;
      const strength = probeStrength(answers.get(id), record.row);
      if (strength === "refuted") continue;
      evidence.hypotheses += 1;
      const ev = record.row.evidence as SurveyEvidence | undefined;
      if (hasEvidence(ev) && (ev as SurveyEvidence).crosses_boundary === true) evidence.crossesBoundary = true;
      if (strength === "executed") evidence.probe = "executed";
      else if (strength === "corroborated" && evidence.probe === "none") evidence.probe = "corroborated";
    }
    return evidence;
  };
  return { set, answers, ofHypothesis, ofFinding, rankEvidenceOf };
}

export interface StampSeverityResult {
  /** Findings in the document. */
  findings: number;
  /** Of those, how many carried a derivable severity. */
  derived: number;
  /** Of those, how many had a different severity written on them. */
  changed: number;
  /** The derived severities, counted. */
  bySeverity: Record<Severity, number>;
  /** Why nothing was stamped, when nothing could be. `null` = it ran. */
  skipped: string | null;
}

/**
 * Overwrite every hypothesis-derived finding's `severity` in `findings.json`
 * with the derived one, recording the adjudicator's own value as
 * `declaredSeverity` where it differed, and stamp its {@link RankEvidence}
 * beside it for the poster's tie-break. Idempotent, and it never touches a
 * finding that cites no hypothesis.
 *
 * Runs in the `reconcile` phase (`findings --repair`), AFTER `adjudicate` —
 * which is what "the adjudicator must not restamp it" means mechanically.
 */
export function stampDerivedSeverity(options: { dir: string; repo?: string; log?: LoggerPort }): StampSeverityResult {
  const log = options.log ?? noopLogger;
  const empty: StampSeverityResult = {
    findings: 0,
    derived: 0,
    changed: 0,
    bySeverity: { Critical: 0, Important: 0, Minor: 0 },
    skipped: null,
  };
  const path = join(options.dir, "findings.json");
  if (!existsSync(path)) return { ...empty, skipped: "no findings.json" };
  let document: Record<string, unknown>;
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    FindingsDocumentSchema.parse(raw);
    document = raw as Record<string, unknown>;
  } catch (err) {
    return { ...empty, skipped: `findings.json is not a readable findings document (${err instanceof Error ? err.message : String(err)})` };
  }
  const findings = Array.isArray(document.findings) ? (document.findings as Record<string, unknown>[]) : [];
  const result: StampSeverityResult = { ...empty, bySeverity: { ...empty.bySeverity }, findings: findings.length };
  if (!findings.length) return result;
  const index = buildSeverityIndex({ dir: options.dir, repo: options.repo });
  let dirty = false;
  for (const finding of findings) {
    const derived = index.ofFinding(finding);
    if (!derived) {
      // Only reconcile writes rankEvidence; one on a finding with nothing to
      // derive from was written by the model, and the poster must not rank on it.
      if (finding.rankEvidence !== undefined) {
        delete finding.rankEvidence;
        dirty = true;
      }
      continue;
    }
    result.derived += 1;
    result.bySeverity[derived] += 1;
    const rankEvidence = index.rankEvidenceOf(finding);
    if (JSON.stringify(finding.rankEvidence ?? null) !== JSON.stringify(rankEvidence)) {
      finding.rankEvidence = rankEvidence;
      dirty = true;
    }
    if (finding.severity === derived) continue;
    // Keep what the adjudicator wrote, once: a second run finds the derived
    // value already in place and changes nothing, so the first declared value
    // is never overwritten by our own.
    if (typeof finding.severity === "string" && finding.severity.trim() && finding.declaredSeverity === undefined) {
      finding.declaredSeverity = finding.severity;
    }
    finding.severity = derived;
    result.changed += 1;
    dirty = true;
  }
  if (dirty) {
    FindingsDocumentSchema.parse(document);
    writeFileSync(path, `${JSON.stringify(document, null, 2)}\n`, "utf8");
    log.info("derived finding severity stamped into findings.json", {
      dir: options.dir,
      derived: result.derived,
      changed: result.changed,
    });
  }
  return result;
}

/** One line for the reconcile phase's log. */
export function renderStampSeverity(result: StampSeverityResult): string {
  if (result.skipped) return `severity: not derived — ${result.skipped}`;
  const { Critical, Important, Minor } = result.bySeverity;
  return (
    `severity: derived on ${result.derived}/${result.findings} finding(s) ` +
    `(Critical=${Critical} Important=${Important} Minor=${Minor}); ${result.changed} restamped`
  );
}

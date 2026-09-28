/**
 * The Node half of the survey-row judging shared by the unit-survey replay and
 * the site-review replay: what a row claims and says, projected once so two
 * arms scored by different scripts are scored by the same words. (Its
 * micro-survey report writers were removed with the agent survey.)
 */
import { type SurveyEvidence, hasEvidence, isReassurance, severityOf } from "lastlight-code-facts";

export interface SurveyRow {
  id?: string;
  obligation?: string;
  claim?: string;
  severity?: string;
  needsProbe?: boolean;
  evidence?: SurveyEvidence;
  quotes?: { path?: string; line?: number }[];
  bothEnds?: Record<string, unknown>;
}

/**
 * Does the row CLAIM a defect? Derived severity Important or Critical — the
 * derivation sets those only when a consequence is recorded — AND not a clean
 * discharge. A reassurance with a consequence attached ("if the constant ever
 * changed…") is the pass saying the control holds; counting it as a claim put
 * it in the precision denominator (measured: GLM 5.3 Flash wrote a
 * consequence on 10 of 10 clean discharges).
 */
export function claimOf(r: SurveyRow): boolean {
  const important = ["important", "critical"].includes((severityOf(r) ?? "").toLowerCase());
  return important && !(hasEvidence(r.evidence) && isReassurance(r.evidence as SurveyEvidence));
}

/**
 * What a row SAYS, for the gold judge: the claim, plus the consequence it
 * recorded. Both are the row's own words — the consequence is where a pass that
 * writes a mild claim spells out what actually breaks, and leaving it out would
 * grade the headline and ignore the finding.
 */
export function rowStatement(r: Pick<SurveyRow, "claim" | "evidence">): string {
  const consequence = typeof r.evidence?.consequence === "string" ? r.evidence.consequence.trim() : "";
  return [r.claim ?? "", consequence && `Consequence: ${consequence}`].filter(Boolean).join(" ");
}

/**
 * Survey rows projected into `gradeInternalRecall`'s finding shape — ONE
 * projection, shared by every eval that judges hypothesis rows against gold
 * (`unit-survey-replay.ts`, the phase replays), so two arms scored by
 * different scripts are still scored by the same words. Order is preserved:
 * the judge's indices come back as offsets into the rows.
 */
export function rowsAsJudgeFindings(rows: Pick<SurveyRow, "claim" | "evidence" | "quotes">[]): { description: string; file: string | null }[] {
  return rows.map((r) => ({ description: rowStatement(r), file: r.quotes?.[0]?.path ?? null }));
}

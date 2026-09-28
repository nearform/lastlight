/**
 * The site-review investigator's output contract and its deterministic gate,
 * as the evals replay (`scripts/micro-site-review.ts`) uses them.
 *
 * The gate itself moved to code-facts (`site-review.ts`, `lastlight-facts
 * sites --check`) when the `sites` review engine became a pipeline phase, so
 * the replay and the pipeline run the same code. What stays here is
 * replay-only: the round-2 gap feedback the replay appends by hand, and the
 * judge projection.
 */
export {
  checkSiteFindings,
  isExecutionCommand,
  MAX_SITE_FINDINGS,
  noneChecksRequired,
  readSiteFindingLines,
  SITE_STRENGTHS,
  siteBriefRel,
  siteFindingsRel,
  sitesRelDir,
} from "lastlight-code-facts";
export type { NoneCheck, SiteFinding, SiteFindingLine, SiteFindingsCheck, SiteGap, SiteGapKind, SiteStrength } from "lastlight-code-facts";
import type { SiteFinding, SiteGap } from "lastlight-code-facts";

/**
 * The section round 2's prompt ends with: what the gate rejected. A deliberate
 * departure from core's `generic_loop`, which re-renders the same prompt and
 * leaves the agent to guess (the falsify pilot's round 2 could not know what
 * to fix).
 */
export function renderGateFeedback(gaps: SiteGap[], findingsRel: string): string {
  const lines = gaps.slice(0, 12).map((g) => `- \`${g.kind}\` — ${g.detail}`);
  if (gaps.length > 12) lines.push(`- … and ${gaps.length - 12} more`);
  return [
    "",
    "## The gate rejected your previous output",
    "",
    `\`${findingsRel}\` is still on disk from your previous attempt. Fix exactly these and rewrite the file:`,
    "",
    ...lines,
    "",
  ].join("\n");
}

/**
 * Findings projected into `gradeInternalRecall`'s finding shape — the claim is
 * title + mechanism + consequence, the way `rowsAsJudgeFindings` projects a
 * row's claim + consequence, with the location in the file field and text.
 */
export function findingsAsJudgeFindings(findings: Pick<SiteFinding, "path" | "line" | "title" | "mechanism" | "consequence">[]): { description: string; file: string | null }[] {
  return findings.map((f) => ({
    description: [`${f.title} (${f.path}:${f.line}).`, f.mechanism, f.consequence && `Consequence: ${f.consequence}`].filter(Boolean).join(" "),
    file: f.path,
  }));
}

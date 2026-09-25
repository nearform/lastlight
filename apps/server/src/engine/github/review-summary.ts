/**
 * The posted review's SUMMARY, written AFTER the attention boundary has decided
 * what posts.
 *
 * The adjudicator used to write `summary` in `findings.json`, before the poster
 * applied the inline and body caps — so it could not know what would be cut,
 * and routinely enumerated findings the boundary then withheld. That summary is
 * the review body GitHub shows, so the withheld claims reached the PR anyway
 * and were graded as posted: on the Martian cal.com arm (2026-09-25) a review
 * the poster capped at 5 inline + 5 body read as 12 findings, the summary
 * listing four numbered defects plus an "Also flagged below:" line naming five
 * more, one of them a finding the boundary had recorded `internal`.
 *
 * So under a boundary the adjudicator's prose is never posted. This module
 * writes the summary from the POSTED set only — the model is handed nothing
 * the boundary withheld, so it cannot mention it — and falls back to a
 * summary rendered in code whenever the model call cannot be trusted to
 * answer (no posted findings, no model, an error, an empty or oversized
 * reply). The fallback is deterministic on purpose: an APPROVE with nothing
 * posted is exactly the shape the duplicate-review guard compares byte for
 * byte, and a model-written body would never repeat.
 *
 * The one piece of the adjudicator's summary that survives is the re-review
 * LEDGER (Fixed / Still open / Pinned by a test / Withdrawn): it reports on
 * findings a previous review already posted, so it cannot leak a withheld one,
 * and the model here has no way to reconstruct it.
 */
import type { ChatFunction } from "../llm.js";
import type { ReviewEvent, ReviewFinding, TieredFindings } from "./review-poster.js";

/** A ledger line: an optional bullet/bold, then one of the four bucket names. */
const LEDGER_LINE = /^\s*(?:[-*]\s*)?(?:\*\*)?(?:Fixed|Still open|Pinned by a test|Withdrawn)\b/i;

/**
 * The leading re-review ledger of an adjudicator summary, verbatim, or `""`.
 * Only a CONTIGUOUS run of ledger lines at the top counts (blank lines inside
 * it allowed) — a "Fixed" further down is prose, and prose is not carried over.
 */
export function extractPriorLedger(summary: string | undefined | null): string {
  if (!summary) return "";
  const lines = summary.split("\n");
  const kept: string[] = [];
  for (const line of lines) {
    if (LEDGER_LINE.test(line)) kept.push(line.trimEnd());
    else if (line.trim() === "" && kept.length > 0) continue;
    else break;
  }
  return kept.join("\n");
}

/** The findings the review will actually carry, inline first. */
export function postedFindings(tiered: TieredFindings): ReviewFinding[] {
  return [...tiered.inline, ...tiered.body.map((d) => d.finding)];
}

function plural(n: number, one: string, many: string): string {
  return `${n} ${n === 1 ? one : many}`;
}

/**
 * The summary rendered in code — used when there is nothing to summarise and
 * whenever the model's answer cannot be used. Names no finding: the findings
 * render themselves below it.
 */
export function renderFallbackSummary(event: ReviewEvent, posted: ReviewFinding[]): string {
  const n = posted.length;
  if (event === "APPROVE") {
    return n === 0 ? "Looks good to merge." : `Looks good to merge; ${plural(n, "note", "notes")} below.`;
  }
  if (event === "REQUEST_CHANGES") {
    return n === 0
      ? "Requesting changes."
      : `Requesting changes: ${plural(n, "issue", "issues")} below should be addressed before this merges.`;
  }
  return n === 0 ? "No issues to raise." : `${plural(n, "issue", "issues")} below worth a look.`;
}

const SYSTEM = [
  "You write the opening summary of a pull-request code review.",
  "The findings listed are EXACTLY the comments this review posts; they render below your summary, so do not restate them one by one.",
  "Write 1 to 3 sentences of plain prose: the overall assessment of the change and why the review's event (approve / request changes / comment) follows.",
  "You may refer to the single most serious finding by what it is about. Never mention, hint at or count any issue that is not in the list.",
  "No lists, no headings, no severity labels, no file paths. Do not mention reviews, pipelines, models or tools.",
  "Output only the summary text.",
].join(" ");

/** The reply budget: a summary longer than this is not a summary. */
const MAX_SUMMARY_CHARS = 900;
const BODY_EXCERPT_CHARS = 400;

function describe(f: ReviewFinding, i: number): string {
  const where = f.path ? ` (${f.path}${f.line ? `:${f.line}` : ""})` : "";
  const body = (f.body ?? "").replace(/\s+/g, " ").trim();
  const excerpt = body.length > BODY_EXCERPT_CHARS ? `${body.slice(0, BODY_EXCERPT_CHARS)}…` : body;
  return `${i + 1}. [${f.severity || "Important"}] ${f.title ?? ""}${where}${excerpt ? ` — ${excerpt}` : ""}`;
}

export interface PostedSummary {
  text: string;
  source: "model" | "fallback";
  /** Why the fallback was used; absent when the model answered. */
  reason?: string;
}

export interface PostedSummaryInput {
  event: ReviewEvent;
  tiered: TieredFindings;
  /** The adjudicator's summary — read ONLY for its leading re-review ledger. */
  adjudicatorSummary?: string | null;
  prTitle?: string;
  model?: string;
  chat?: ChatFunction;
  timeoutMs?: number;
}

/** Write the review summary from the posted findings only. Never throws. */
export async function writePostedSummary(input: PostedSummaryInput): Promise<PostedSummary> {
  const posted = postedFindings(input.tiered);
  const ledger = extractPriorLedger(input.adjudicatorSummary);
  const withLedger = (text: string) => (ledger ? `${ledger}\n\n${text}` : text);
  const fallback = (reason: string): PostedSummary => ({
    text: withLedger(renderFallbackSummary(input.event, posted)),
    source: "fallback",
    reason,
  });

  if (posted.length === 0) return fallback("nothing posted");
  if (!input.model || !input.chat) return fallback("no summary model");

  const user = [
    input.prTitle ? `Pull request: ${input.prTitle}` : "",
    `Review event: ${input.event}`,
    `Posted findings (${posted.length}):`,
    ...posted.map(describe),
  ]
    .filter(Boolean)
    .join("\n");
  try {
    const reply = (
      await input.chat(
        input.model,
        [
          { role: "system", content: SYSTEM },
          { role: "user", content: user },
        ],
        { maxTokens: 2048, timeoutMs: input.timeoutMs ?? 60_000 },
      )
    ).trim();
    if (!reply) return fallback("empty reply");
    if (reply.length > MAX_SUMMARY_CHARS) return fallback(`reply over ${MAX_SUMMARY_CHARS} chars`);
    return { text: withLedger(reply), source: "model" };
  } catch (err) {
    return fallback(`model call failed: ${err instanceof Error ? err.message : String(err)}`);
  }
}

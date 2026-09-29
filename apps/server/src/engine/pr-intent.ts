/**
 * What the author says the PR does — the title, the body and the issues it
 * closes — as the bounded block a site investigator reads (`{{prIntent}}` in
 * `workflows/prompts/review-site.md`).
 *
 * Why the investigator gets it at all: it was context-blind (a path, a line
 * range and a vote count), and a defect is often "the code does not do what the
 * description promises". Of the false positives SWR-Bench classified, 48% came
 * from missing context (arXiv 2509.01494), and grafana-94942's gold is contested
 * precisely because the investigator never saw the PR description
 * (docs/plans/site-review-recall.md). The prompt frames it as a CLAIM to check,
 * never a reason to close a suspicion — H2's "not intent" rule stands.
 *
 * Pure, and shared with the evals replay (`micro-site-review --pr-context`) via
 * the `lastlight/evals` barrel, so both render the same bytes.
 */

export interface PrIntentInput {
  title?: string | null;
  body?: string | null;
  closes?: readonly { number: number; title?: string | null; body?: string | null }[] | null;
}

/** The body's budget. Most PR bodies are far under it (Martian: median ~330 chars). */
export const MAX_PR_INTENT_BODY_CHARS = 3000;
/** Each linked issue's budget, and how many are shown. */
export const MAX_PR_INTENT_ISSUE_CHARS = 1500;
export const MAX_PR_INTENT_ISSUES = 2;

/**
 * PR templates are mostly HTML comments ("Please read the contributing
 * guide…"): noise the author never wrote. Stripped, then blank runs collapsed.
 * `{{` is broken up so no template guard downstream can read the text as a
 * placeholder.
 */
function clean(text: string | null | undefined, max: number): string {
  const stripped = (text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/<!--[\s\S]*?(-->|$)/g, "")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/\{\{/g, "{ {")
    .trim();
  return stripped.length > max ? `${stripped.slice(0, max).trimEnd()}\n… truncated at ${max} characters` : stripped;
}

/** `""` when there is nothing to say, so a `{{#if prIntent}}` guard reads false. */
export function renderPrIntent(input: PrIntentInput): string {
  const title = clean(input.title, 300);
  const body = clean(input.body, MAX_PR_INTENT_BODY_CHARS);
  const issues = (input.closes ?? []).slice(0, MAX_PR_INTENT_ISSUES).flatMap((i) => {
    const text = clean(i.body, MAX_PR_INTENT_ISSUE_CHARS);
    const head = `#${i.number}${i.title ? ` — ${clean(i.title, 300)}` : ""}`;
    return [`**Closes ${head}**`, "", text || "(no description)", ""];
  });
  if (!title && !body && !issues.length) return "";
  const out: string[] = [];
  if (title) out.push(`**Title:** ${title}`, "");
  out.push("**Description:**", "", body || "(the author wrote no description)", "");
  out.push(...issues);
  return out.join("\n").trimEnd();
}

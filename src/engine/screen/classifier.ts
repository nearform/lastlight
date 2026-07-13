/**
 * LLM-based comment intent classifier.
 *
 * Uses a fast/cheap model (haiku) with no tools to classify whether a
 * GitHub/Slack comment is requesting a code change (build/fix), an idea
 * exploration, a lightweight action (approve/status/…), etc.
 *
 * The main classifier prompt is **composed at runtime**, not hardcoded: a
 * forkable base template (`workflows/prompts/classifier.md`) supplies the
 * framing + disambiguation rules + control categories, and each workflow YAML
 * contributes its own category via a `classification:` block. This lets a
 * deployment fork the base prompt AND add a new routable intent just by adding
 * a workflow (see issue #164). The token→intent vocabulary is derived from the
 * same blocks, so the prompt, the parser, and the router's
 * `getWorkflowByIntent` fallback all read one source of truth.
 */

import { chat as realChat, defaultFastModel as realDefaultFastModel, type ChatFunction } from "../llm.js";
import { getAssetVersion, listAgentWorkflows, loadPromptTemplate } from "../../workflows/loader.js";
import { intentToken, RESERVED_CONTROL_INTENTS } from "../../workflows/schema.js";

/**
 * A classifier intent. The well-known intents the router has bespoke handling
 * for are listed in {@link KNOWN_WORKFLOW_INTENT_ORDER} + {@link RESERVED_CONTROL_INTENTS},
 * but the runtime type is open: a workflow can introduce a new intent (e.g.
 * `incident`) via its `classification` block, and the router routes it via the
 * `getWorkflowByIntent` fallback.
 */
export type CommentIntent = string;

export interface ClassificationResult {
  intent: CommentIntent;
  /** Repository mentioned in the message, if any (e.g. "cliftonc/lastlight"). */
  repo?: string;
  /** Issue or PR number mentioned, if any. */
  issueNumber?: number;
  /** Reason given for a reject intent. */
  reason?: string;
}

/** Optional surrounding context for a comment classification. */
export interface ClassifierContext {
  /** Title of the issue/PR the comment is on (when applicable). */
  issueTitle?: string;
  /** True when the comment is on a PR rather than an issue. */
  isPullRequest?: boolean;
}

export interface ClassifierOptions {
  model?: string;
  chat?: ChatFunction;
  defaultFastModel?: (taskType?: string) => string;
}

// ── prompt composition ───────────────────────────────────────────────────────

/**
 * Canonical order the well-known workflow categories appear in — matches the
 * historical hardcoded prompt so composition is a no-op diff for the shipped
 * workflows. Unknown/overlay intents sort after these, alphabetically.
 */
const KNOWN_WORKFLOW_INTENT_ORDER = [
  "build",
  "explore",
  "question",
  "triage",
  "review",
  "security",
  "verify",
  "qa-test",
  "demo",
];

function intentOrderIndex(intent: string): number {
  const i = KNOWN_WORKFLOW_INTENT_ORDER.indexOf(intent);
  return i === -1 ? KNOWN_WORKFLOW_INTENT_ORDER.length : i;
}

/**
 * The intents the router has bespoke, context-dependent handling for (a workflow
 * intent handled by an explicit router branch, or a harness control intent).
 * The router's `getWorkflowByIntent` fallback fires ONLY for intents *outside*
 * this set — i.e. a genuinely new intent an overlay workflow introduced — so the
 * established routing of the well-known intents (e.g. `explore` is a no-op on a
 * PR → `pr-comment`) is never disturbed.
 */
export const WELL_KNOWN_INTENTS: ReadonlySet<string> = new Set<string>([
  ...KNOWN_WORKFLOW_INTENT_ORDER,
  ...RESERVED_CONTROL_INTENTS,
]);

interface ClassifierState {
  /** Loader asset version this was assembled at, for cheap staleness checks. */
  version: number;
  /** The fully-composed classifier system prompt. */
  prompt: string;
  /** UPPER prompt token → intent string (control intents + workflow intents). */
  tokenToIntent: Map<string, string>;
}

let cachedState: ClassifierState | undefined;

/** Force a rebuild of the composed prompt (used by tests). */
export function resetClassifierPromptCache(): void {
  cachedState = undefined;
}

function assembleClassifier(): ClassifierState {
  const base = loadPromptTemplate("prompts/classifier.md");

  const blocks = listAgentWorkflows()
    .map((w) => w.classification)
    .filter((c): c is NonNullable<typeof c> => !!c)
    .sort(
      (a, b) => intentOrderIndex(a.intent) - intentOrderIndex(b.intent) || a.intent.localeCompare(b.intent),
    );

  const categories = blocks.map((b) => b.description.replace(/\s+$/, "")).join("\n");
  const examples = blocks.flatMap((b) => b.examples ?? []).join("\n");
  const intentTokens = [
    ...blocks.map((b) => intentToken(b.intent)),
    ...RESERVED_CONTROL_INTENTS.map((i) => intentToken(i)),
  ].join("|");

  // Function replacers so a `$` in category/example text isn't treated as a
  // String.replace special pattern.
  const prompt = base
    .replace("{{categories}}", () => categories)
    .replace("{{examples}}", () => examples)
    .replace("{{intentTokens}}", () => intentTokens);

  const tokenToIntent = new Map<string, string>();
  for (const i of RESERVED_CONTROL_INTENTS) tokenToIntent.set(intentToken(i), i);
  for (const b of blocks) tokenToIntent.set(intentToken(b.intent), b.intent);

  return { version: getAssetVersion(), prompt, tokenToIntent };
}

function classifierState(): ClassifierState {
  if (!cachedState || cachedState.version !== getAssetVersion()) {
    cachedState = assembleClassifier();
  }
  return cachedState;
}

/** The composed classifier system prompt (framing + all categories + format). */
export function buildClassifierPrompt(): string {
  return classifierState().prompt;
}

// ── repo/issue extraction ────────────────────────────────────────────────────

/**
 * Extract owner/repo and optional issue/PR number from any github.com URL
 * in the text. Belt-and-suspenders for the LLM — if the classifier forgets
 * to normalize a URL to owner/name, this fallback still recovers the repo.
 * Returns undefined when no github.com URL is present.
 */
export function extractGithubRefFromText(
  text: string,
): { repo: string; issueNumber?: number } | undefined {
  // URL with /issues/N or /pull/N — capture the number too
  const withNumber = text.match(
    /github\.com\/([\w-]+)\/([\w.-]+?)\/(?:issues|pull)\/(\d+)\b/i,
  );
  if (withNumber) {
    return {
      repo: `${withNumber[1]}/${cleanRepoName(withNumber[2])}`,
      issueNumber: parseInt(withNumber[3], 10),
    };
  }
  // Bare repo URL — stop at next slash / whitespace / query / fragment, then
  // strip trailing sentence punctuation and any .git suffix.
  const bare = text.match(/github\.com\/([\w-]+)\/([\w.-]+?)(?=[\s/?#,]|$)/i);
  if (bare) {
    return { repo: `${bare[1]}/${cleanRepoName(bare[2])}` };
  }
  return undefined;
}

function cleanRepoName(name: string): string {
  // Repo names don't end in punctuation; a trailing `.` or `,` is sentence
  // punctuation that leaked into the match.
  return name.replace(/[.,]+$/, "").replace(/\.git$/i, "");
}

/**
 * Classify whether a newly-opened issue is a pure question (wants an answer)
 * versus a work item (wants a code change). Delegates to the main composed
 * classifier — `answer.yaml` owns the QUESTION category — and maps the result:
 * `question` intent → true (route to the answer workflow), anything else →
 * false (route to triage, the safe default). `classifyComment` swallows its own
 * errors and returns `chat`, so a transient failure lands on WORK/triage.
 */
export async function classifyIssueIntent(
  title: string,
  body: string,
  options: ClassifierOptions = {},
): Promise<boolean> {
  const combined = `${title}\n\n${body}`.trim();
  const { intent } = await classifyComment(combined, { issueTitle: title }, options);
  return intent === "question";
}

const ADDS_INFO_PROMPT_PATH = "prompts/classify-adds-info.md";

/**
 * Decide whether a reporter's comment adds substantive information that should
 * re-open triage of the issue (vs. social noise like "thanks"). Used by the
 * router to gate reporter-driven re-triage on issues that haven't entered a
 * build yet.
 *
 * Falls back to `false` (NOISE → no re-triage) on any error — leaving the
 * comment ignored, which matches the pre-existing behaviour for plain replies.
 */
export async function classifyCommentAddsInfo(
  commentBody: string,
  context: ClassifierContext = {},
  options: ClassifierOptions = {},
): Promise<boolean> {
  try {
    const chat = options.chat ?? realChat;
    const defaultFastModel = options.defaultFastModel ?? realDefaultFastModel;
    const userPrompt = context.issueTitle
      ? `ISSUE TITLE: ${context.issueTitle}\n\nCOMMENT: ${commentBody}`
      : `COMMENT: ${commentBody}`;
    const output = await chat(
      options.model ?? defaultFastModel("classifier"),
      [
        { role: "system", content: loadPromptTemplate(ADDS_INFO_PROMPT_PATH) },
        { role: "user", content: userPrompt },
      ],
      { maxTokens: 16 },
    );
    return /\bADDS_INFO\b/i.test(output);
  } catch (err: any) {
    console.error(`[classifier] Error classifying comment info: ${err.message}`);
    return false;
  }
}

/**
 * Classify a GitHub/Slack comment's intent and extract a repo reference.
 * Falls back to intent=chat on any error (safe default).
 */
export async function classifyComment(
  commentBody: string,
  context?: ClassifierContext,
  options: string | ClassifierOptions = {},
): Promise<ClassificationResult> {
  try {
    const userPrompt = context?.issueTitle
      ? `Classify this comment (replying on an existing ${context.isPullRequest ? "PR" : "issue"}):\n\nISSUE TITLE: ${context.issueTitle}\n\nCOMMENT: ${commentBody}`
      : `Classify this comment:\n\n${commentBody}`;

    const resolvedOptions = typeof options === "string" ? { model: options } : options;
    const chat = resolvedOptions.chat ?? realChat;
    const defaultFastModel = resolvedOptions.defaultFastModel ?? realDefaultFastModel;
    const { prompt, tokenToIntent } = classifierState();
    const output = await chat(
      resolvedOptions.model ?? defaultFastModel("classifier"),
      [
        { role: "system", content: prompt },
        { role: "user", content: userPrompt },
      ],
      { maxTokens: 128 },
    );

    const upper = output.trim().toUpperCase();

    // Match INTENT line, mapping the emitted token back to an intent via the
    // dynamically-composed vocabulary. Unknown token → chat (safe default).
    const intentMatch = upper.match(/INTENT:\s*(\w+)/);
    const intent: CommentIntent = intentMatch
      ? (tokenToIntent.get(intentMatch[1]) ?? "chat")
      : "chat";

    // Extract repo from "REPO: owner/name" line. If the classifier didn't
    // emit one (e.g. the user pasted a full github.com URL and the model
    // left REPO as NONE), recover it from the raw message.
    const repoMatch = output.match(/REPO:\s*([\w-]+\/[\w.-]+)/i);
    const issueMatch = output.match(/ISSUE:\s*(\d+)/i);
    let repo = repoMatch?.[1];
    let issueNumber = issueMatch ? parseInt(issueMatch[1], 10) : undefined;
    if (!repo) {
      const fallback = extractGithubRefFromText(commentBody);
      if (fallback) {
        repo = fallback.repo;
        if (issueNumber === undefined && fallback.issueNumber !== undefined) {
          issueNumber = fallback.issueNumber;
        }
      }
    }

    // Extract reject reason
    const reasonMatch = output.match(/REASON:\s*(.+)/i);
    const reason = reasonMatch && reasonMatch[1].trim().toUpperCase() !== "NONE"
      ? reasonMatch[1].trim()
      : undefined;

    return { intent, repo, issueNumber, reason };
  } catch (err: any) {
    console.error(`[classifier] Error classifying comment: ${err.message}`);
    return { intent: "chat" };
  }
}

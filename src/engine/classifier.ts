/**
 * LLM-based comment intent classifier.
 *
 * Uses a fast/cheap model (haiku) with no tools to classify whether
 * a GitHub comment is requesting a code change (build/fix), an idea
 * exploration, or a lightweight action (close, label, question, etc.).
 */

export type CommentIntent =
  | "build"
  | "explore"
  | "triage"
  | "review"
  | "security"
  | "approve"
  | "reject"
  | "status"
  | "reset"
  | "chat";

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

const CLASSIFIER_PROMPT = `You are a router for messages directed at a GitHub/Slack bot.
Classify the user's message into exactly one category, and extract any repository or issue references.

Categories:
BUILD — The user wants code changes NOW in a GitHub repo: implement a feature, fix a bug, create/send a PR, resolve an issue with code. BUILD requires a GitHub target — either an explicit repo reference (owner/name or github.com URL) in the message, OR an ISSUE TITLE context line indicating the comment is a reply on an existing issue/PR. If neither is present, classify as CHAT — local filesystem operations ("delete files in ~/foo", "clean up my downloads"), shell-style commands, or vague "build something" with no target are NOT BUILD.
EXPLORE — The user has a half-formed idea and wants help thinking it through BEFORE code: "help me think through X", "brainstorm Y", "spec this out", "explore an idea for Z".
TRIAGE — The user wants to scan/triage issues on a repo: "triage cliftonc/repo", "scan for new issues", "can you triage <repo>?".
REVIEW — The user wants to review PRs on a repo: "review cliftonc/repo", "check PRs", "can you review PRs on <repo>?".
SECURITY — The user wants a security scan/review of a repo: "security review cliftonc/repo", "scan for vulnerabilities", "check security", "can you do a security review of <repo>?".
APPROVE — The user is approving a pending gate: "approve", "go ahead", "looks good, continue", "yes proceed".
REJECT — The user is rejecting a pending gate: "reject", "abort", "cancel this", "no don't proceed". Extract any reason given.
STATUS — The user wants to know what's running: "status", "what's running", "any tasks active?".
RESET — The user wants to start a fresh session: "new", "reset", "start over", "fresh session".
CHAT — Anything else: questions, conversation, thanks, general discussion.

Polite or question phrasings are still clear intent. "Can you do a security review of X?",
"could you triage <repo>?", "please review PRs on <repo>" are SECURITY, TRIAGE, REVIEW
respectively — not CHAT. The "prefer CHAT when ambiguous" rule only applies when the
message has no clear action verb. Presence of "security review", "triage", "review PRs",
"scan for vulnerabilities", etc. makes the intent unambiguous regardless of politeness.

When ambiguous between EXPLORE and CHAT, prefer CHAT. Only pick EXPLORE when the user is explicitly asking for brainstorming / spec-shaping / design exploration.
When ambiguous between BUILD and CHAT, prefer CHAT.
When ambiguous between APPROVE/REJECT and CHAT, prefer CHAT — only classify as APPROVE/REJECT when the intent is clearly about a pending workflow gate.

Repo extraction: always emit REPO as "owner/name" (never a URL). If the message contains
a github.com URL, convert it: https://github.com/cliftonc/lastlight → cliftonc/lastlight.
URL paths like /issues/42 or /pull/5 should populate ISSUE as well.

When the message is a reply on an existing issue/PR, the issue title is provided
as ISSUE TITLE. Short imperative replies like "lets build this", "build it",
"go ahead", "ship it", "do it", "implement this", "make it so" classify as
BUILD when an issue title is present — the implicit object is the issue itself.
The "prefer CHAT when ambiguous" rule does NOT apply when the comment is a
clear imperative directed at the issue's subject.

Respond in exactly this format (each on its own line, no extra text):
INTENT: BUILD|EXPLORE|TRIAGE|REVIEW|SECURITY|APPROVE|REJECT|STATUS|RESET|CHAT
REPO: owner/name or NONE
ISSUE: number or NONE
REASON: text or NONE

Examples:
"explore adding webhooks to cliftonc/drizby" → INTENT: EXPLORE, REPO: cliftonc/drizby, ISSUE: NONE, REASON: NONE
"build cliftonc/drizzle-cube#42" → INTENT: BUILD, REPO: cliftonc/drizzle-cube, ISSUE: 42, REASON: NONE
"lets build this!" with ISSUE TITLE "Security Review" → INTENT: BUILD, REPO: NONE, ISSUE: NONE, REASON: NONE
"go ahead" with ISSUE TITLE "Add CSV export" → INTENT: BUILD, REPO: NONE, ISSUE: NONE, REASON: NONE
"approve" → INTENT: APPROVE, REPO: NONE, ISSUE: NONE, REASON: NONE
"reject, the plan is too complex" → INTENT: REJECT, REPO: NONE, ISSUE: NONE, REASON: the plan is too complex
"what's running?" → INTENT: STATUS, REPO: NONE, ISSUE: NONE, REASON: NONE
"run a security review on cliftonc/lastlight" → INTENT: SECURITY, REPO: cliftonc/lastlight, ISSUE: NONE, REASON: NONE
"can you do a security review of https://github.com/cliftonc/lastlight" → INTENT: SECURITY, REPO: cliftonc/lastlight, ISSUE: NONE, REASON: NONE
"could you triage https://github.com/foo/bar?" → INTENT: TRIAGE, REPO: foo/bar, ISSUE: NONE, REASON: NONE
"please review https://github.com/foo/bar/pull/42" → INTENT: REVIEW, REPO: foo/bar, ISSUE: 42, REASON: NONE
"scan https://github.com/cliftonc/lastlight for vulnerabilities" → INTENT: SECURITY, REPO: cliftonc/lastlight, ISSUE: NONE, REASON: NONE
"delete any files in ~/work/lastlight/docs" → INTENT: CHAT, REPO: NONE, ISSUE: NONE, REASON: NONE
"can you remove the old docs folder for me" (no ISSUE TITLE, no repo) → INTENT: CHAT, REPO: NONE, ISSUE: NONE, REASON: NONE
"build something cool" (no repo, no ISSUE TITLE) → INTENT: CHAT, REPO: NONE, ISSUE: NONE, REASON: NONE`;

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
 * Classify a GitHub/Slack comment's intent and extract a repo reference.
 * Falls back to intent=action on any error (safe default).
 */
export async function classifyComment(
  commentBody: string,
  context?: ClassifierContext,
  model?: string,
): Promise<ClassificationResult> {
  try {
    const userPrompt = context?.issueTitle
      ? `Classify this comment (replying on an existing ${context.isPullRequest ? "PR" : "issue"}):\n\nISSUE TITLE: ${context.issueTitle}\n\nCOMMENT: ${commentBody}`
      : `Classify this comment:\n\n${commentBody}`;

    const { callLlm, defaultFastModel } = await import("./llm.js");
    const output = await callLlm(
      model || defaultFastModel("classifier"),
      CLASSIFIER_PROMPT,
      userPrompt,
      { maxTokens: 128 },
    );

    const upper = output.trim().toUpperCase();

    const intentMap: Record<string, CommentIntent> = {
      BUILD: "build",
      EXPLORE: "explore",
      TRIAGE: "triage",
      REVIEW: "review",
      SECURITY: "security",
      APPROVE: "approve",
      REJECT: "reject",
      STATUS: "status",
      RESET: "reset",
      CHAT: "chat",
    };

    // Match INTENT line
    const intentMatch = upper.match(/INTENT:\s*(\w+)/);
    const intent: CommentIntent = intentMatch
      ? (intentMap[intentMatch[1]] ?? "chat")
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

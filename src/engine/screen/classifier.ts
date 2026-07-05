/**
 * LLM-based comment intent classifier.
 *
 * Uses a fast/cheap model (haiku) with no tools to classify whether
 * a GitHub comment is requesting a code change (build/fix), an idea
 * exploration, or a lightweight action (close, label, question, etc.).
 */

import { chat as realChat, defaultFastModel as realDefaultFastModel, type ChatFunction } from "../llm.js";

export type CommentIntent =
  | "build"
  | "explore"
  | "question"
  | "triage"
  | "review"
  | "security"
  | "verify"
  | "qa-test"
  | "demo"
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

export interface ClassifierOptions {
  model?: string;
  chat?: ChatFunction;
  defaultFastModel?: (taskType?: string) => string;
}

const CLASSIFIER_PROMPT = `You are a router for messages directed at a GitHub/Slack bot.
Classify the user's message into exactly one category, and extract any repository or issue references.

Categories:
BUILD — The user is ASKING YOU (the bot) to make code changes NOW in a GitHub repo: implement a feature, fix a bug, create/send a PR, resolve an issue with code. BUILD requires a GitHub target — either an explicit repo reference (owner/name or github.com URL) in the message, OR an ISSUE TITLE context line indicating the comment is a reply on an existing issue/PR. If neither is present, classify as CHAT — local filesystem operations ("delete files in ~/foo", "clean up my downloads"), shell-style commands, or vague "build something" with no target are NOT BUILD.
  BUILD is a REQUEST for NEW work directed at you. A comment that merely REPORTS work the human has ALREADY done is NOT BUILD — it is CHAT. Tells: past-tense ("fixed", "done", "implemented", "added a test", "pushed a fix", "handled it"), a reference to a commit the human made ("addressed in <sha>", "see commit abc123"), thanking you, or explaining/justifying a change they made in response to your review. These are status reports, not requests — classify them CHAT even when the comment is on a PR and even when it @-mentions you. Only classify BUILD when the human asks you to do NEW work (imperative request: "fix X", "now also handle Y", "can you update Z").
EXPLORE — The user wants help shaping an idea BEFORE writing code: "help me think through X", "brainstorm Y", "spec this out", "explore an idea for Z". A bare "explore" / "explore this" / "let's explore" is also EXPLORE — especially as a reply on an existing issue (ISSUE TITLE present), where the implicit object is the issue's idea. EXPLORE = shape the idea / write a spec; BUILD = write the code now.
QUESTION — The user is asking a substantive INFORMATIONAL question that warrants research to answer well: "how does X work?", "what's the difference between X and Y?", "how does <repo> compare to <other tool>?", "is it possible to do Z?", "why does X happen?". The deliverable is an ANSWER, not code and not a spec. QUESTION is for real questions that benefit from reading docs/code or searching the web — NOT casual chat, thanks, or one-word replies (those stay CHAT). EXPLORE shapes a NEW idea into a spec; QUESTION answers an EXISTING question about how something works or compares.
TRIAGE — The user wants to scan/triage issues on a repo: "triage cliftonc/repo", "scan for new issues", "can you triage <repo>?".
REVIEW — The user wants a code review. Either repo-wide ("review cliftonc/repo", "check PRs", "can you review PRs on <repo>?") OR, when the comment is a reply on a PR (ISSUE TITLE present), a request to review THIS PR: "review this", "can you review this?", "please review", "take a look at this PR", "give this a review". The deliverable is a formal PR review (inline comments on the diff). Prefer REVIEW over CHAT whenever there's a clear "review"/"take a look" request on a PR.
SECURITY — The user wants a security scan/review of a repo: "security review cliftonc/repo", "scan for vulnerabilities", "check security", "can you do a security review of <repo>?".
VERIFY — The user wants you to TEST whether a specific claim or behaviour is actually true and report the evidence: "verify that the rate limiter blocks", "does this PR really fix the crash?", "confirm X actually works", "check that Y no longer happens", "prove the --fork flag creates a new session". The deliverable is a CONFIRMED/REFUTED verdict backed by RUNNING the code — not a code change and not a code-quality review. Prefer VERIFY over REVIEW when the user wants proof a behaviour works/is fixed, rather than an assessment of the diff.
QATEST — The user wants you to drive an app or CLI through a flow and report step-level pass/fail: "qa test the signup flow", "run through login and tell me what breaks", "smoke-test the CLI commands", "exercise the checkout flow". The deliverable is a step-by-step QA report. Prefer QATEST over VERIFY when it's a multi-step flow to exercise rather than a single claim to confirm.
DEMO — The user wants you to record a DEMO VIDEO of a feature/PR: "demo this", "record a demo of the new dashboard", "make a video showing the dark-mode toggle", "show me a before/after of the fix". The deliverable is a short screen-recorded mp4 of the running web UI, not a pass/fail report and not a verdict. Prefer DEMO over QATEST/VERIFY when the user explicitly asks for a recording, a video, or "show"/"demo" rather than to test or confirm a behaviour.
APPROVE — The user is approving a pending gate: "approve", "go ahead", "looks good, continue", "yes proceed".
REJECT — The user is rejecting a pending gate: "reject", "abort", "cancel this", "no don't proceed". Extract any reason given.
STATUS — The user wants to know what's running: "status", "what's running", "any tasks active?".
RESET — The user wants to start a fresh session: "new", "reset", "start over", "fresh session".
CHAT — Anything else: questions, conversation, thanks, general discussion, and status reports of work the human already did ("thanks, fixed in <sha>", "addressed your comments", "done — added tests").

Polite or question phrasings are still clear intent. "Can you do a security review of X?",
"could you triage <repo>?", "please review PRs on <repo>" are SECURITY, TRIAGE, REVIEW
respectively — not CHAT. The "prefer CHAT when ambiguous" rule only applies when the
message has no clear action verb. Presence of "security review", "triage", "review PRs",
"scan for vulnerabilities", etc. makes the intent unambiguous regardless of politeness.

When ambiguous between EXPLORE and CHAT, prefer CHAT. Only pick EXPLORE when the user is explicitly asking for brainstorming / spec-shaping / design exploration — OR gives a bare "explore"/"explore this" command (see the issue-reply rule below), which is unambiguous, not chat.
When ambiguous between QUESTION and CHAT, prefer CHAT — only pick QUESTION for a substantive informational question that genuinely benefits from research (reading docs/code or a web search). Casual conversation, greetings, thanks, and trivial one-liners stay CHAT.
When ambiguous between BUILD and CHAT, prefer CHAT.
When ambiguous between VERIFY/QATEST and REVIEW/CHAT, prefer the existing category — only pick VERIFY or QATEST when the user explicitly asks you to test, run, confirm, or exercise a behaviour/flow.
When ambiguous between DEMO and VERIFY/QATEST, prefer the existing category — only pick DEMO when the user explicitly asks for a video, a recording, or to "demo"/"show" the feature.
When ambiguous between APPROVE/REJECT and CHAT, prefer CHAT — only classify as APPROVE/REJECT when the intent is clearly about a pending workflow gate.

Repo extraction: always emit REPO as "owner/name" (never a URL). If the message contains
a github.com URL, convert it: https://github.com/cliftonc/lastlight → cliftonc/lastlight.
URL paths like /issues/42 or /pull/5 should populate ISSUE as well.

When the message is a reply on an existing issue/PR, the issue title is provided
as ISSUE TITLE. Short imperative replies classify by their verb, with the issue
as the implicit object — the "prefer CHAT when ambiguous" rule does NOT apply to
a clear command directed at the issue's subject:
- "lets build this", "build it", "go ahead", "ship it", "do it", "implement
  this", "make it so" → BUILD (write the code now).
- "explore", "explore this", "let's explore", "think this through", "spec this
  out", "brainstorm this" → EXPLORE (shape the idea / write a spec first).
- "review this", "can you review this", "please review", "take a look",
  "give this a review" → REVIEW (do a real code review now; on a PR this means
  review the current PR's diff).
A bare command word ("explore", "build", "review") on an existing issue/PR is a
clear command, NOT ambiguous chat.
This verb rule is for IMPERATIVE requests only. A PR/issue reply that REPORTS
already-completed work or responds to your review — "thanks, fixed in <sha>",
"addressed in commit abc123", "done, added a regression test", "this is
intentional, confirmed with the maintainer" — is a status report, NOT a
command. Classify it CHAT regardless of the ISSUE TITLE or an @mention. Do not
let words like "fix"/"build"/"add" inside a past-tense report flip it to BUILD.

Respond in exactly this format (each on its own line, no extra text):
INTENT: BUILD|EXPLORE|QUESTION|TRIAGE|REVIEW|SECURITY|VERIFY|QATEST|DEMO|APPROVE|REJECT|STATUS|RESET|CHAT
REPO: owner/name or NONE
ISSUE: number or NONE
REASON: text or NONE

Examples:
"explore adding webhooks to cliftonc/drizby" → INTENT: EXPLORE, REPO: cliftonc/drizby, ISSUE: NONE, REASON: NONE
"how does cliftonc/lastlight compare to Vercel's Eve framework?" → INTENT: QUESTION, REPO: cliftonc/lastlight, ISSUE: NONE, REASON: NONE
"what's the difference between a sandbox phase and a chat session in cliftonc/lastlight?" → INTENT: QUESTION, REPO: cliftonc/lastlight, ISSUE: NONE, REASON: NONE
"thanks, that makes sense!" → INTENT: CHAT, REPO: NONE, ISSUE: NONE, REASON: NONE
"build cliftonc/drizzle-cube#42" → INTENT: BUILD, REPO: cliftonc/drizzle-cube, ISSUE: 42, REASON: NONE
"lets build this!" with ISSUE TITLE "Security Review" → INTENT: BUILD, REPO: NONE, ISSUE: NONE, REASON: NONE
"go ahead" with ISSUE TITLE "Add CSV export" → INTENT: BUILD, REPO: NONE, ISSUE: NONE, REASON: NONE
"Thanks @last-light — addressed in 49ccadf. Fixed the nested body in the core and added a regression test; point 3 is intentional, confirmed with the maintainer." with ISSUE TITLE "Port fastify/hono/nextjs adapters" → INTENT: CHAT, REPO: NONE, ISSUE: NONE, REASON: NONE
"done, pushed a fix for the type error in 1a2b3c4" with ISSUE TITLE "Fix build" → INTENT: CHAT, REPO: NONE, ISSUE: NONE, REASON: NONE
"now also handle the GET /sql case please" with ISSUE TITLE "Port adapters" → INTENT: BUILD, REPO: NONE, ISSUE: NONE, REASON: NONE
"verify that the --fork flag creates a new session in cliftonc/foo#12" → INTENT: VERIFY, REPO: cliftonc/foo, ISSUE: 12, REASON: NONE
"does this actually fix the crash?" with ISSUE TITLE "Fix null deref on resize" → INTENT: VERIFY, REPO: NONE, ISSUE: NONE, REASON: NONE
"can you confirm the rate limiter actually blocks at 100 req/s?" with ISSUE TITLE "Add rate limiter" → INTENT: VERIFY, REPO: NONE, ISSUE: NONE, REASON: NONE
"qa test the login flow on this PR" with ISSUE TITLE "Add login" → INTENT: QATEST, REPO: NONE, ISSUE: NONE, REASON: NONE
"run through the signup flow and tell me what breaks" with ISSUE TITLE "Signup v2" → INTENT: QATEST, REPO: NONE, ISSUE: NONE, REASON: NONE
"record a demo of this" with ISSUE TITLE "Add dark-mode toggle" → INTENT: DEMO, REPO: NONE, ISSUE: NONE, REASON: NONE
"make a short before/after video of the fix on cliftonc/foo#12" → INTENT: DEMO, REPO: cliftonc/foo, ISSUE: 12, REASON: NONE
"explore" with ISSUE TITLE "Feature: Allow configuration of otel endpoints" → INTENT: EXPLORE, REPO: NONE, ISSUE: NONE, REASON: NONE
"explore this" with ISSUE TITLE "Add webhook support" → INTENT: EXPLORE, REPO: NONE, ISSUE: NONE, REASON: NONE
"approve" → INTENT: APPROVE, REPO: NONE, ISSUE: NONE, REASON: NONE
"reject, the plan is too complex" → INTENT: REJECT, REPO: NONE, ISSUE: NONE, REASON: the plan is too complex
"what's running?" → INTENT: STATUS, REPO: NONE, ISSUE: NONE, REASON: NONE
"run a security review on cliftonc/lastlight" → INTENT: SECURITY, REPO: cliftonc/lastlight, ISSUE: NONE, REASON: NONE
"can you do a security review of https://github.com/cliftonc/lastlight" → INTENT: SECURITY, REPO: cliftonc/lastlight, ISSUE: NONE, REASON: NONE
"could you triage https://github.com/foo/bar?" → INTENT: TRIAGE, REPO: foo/bar, ISSUE: NONE, REASON: NONE
"please review https://github.com/foo/bar/pull/42" → INTENT: REVIEW, REPO: foo/bar, ISSUE: 42, REASON: NONE
"can you review this?" with ISSUE TITLE "Add HTML sanitizer for messages" → INTENT: REVIEW, REPO: NONE, ISSUE: NONE, REASON: NONE
"take a look at this PR when you get a chance" with ISSUE TITLE "Port fastify adapter" → INTENT: REVIEW, REPO: NONE, ISSUE: NONE, REASON: NONE
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

const ISSUE_QUESTION_PROMPT = `You are a router for newly-opened GitHub issues.
Decide whether the issue is a QUESTION or a WORK item.

QUESTION — the issue asks for information, explanation, comparison, or guidance.
The reporter wants an ANSWER, not code: "How does X work?", "What's the difference
between X and Y?", "Is it possible to...?", "Which approach should I use?", "Why
does X happen?". The deliverable is a written reply.

WORK — the issue requests a code change: a bug report (something is broken and
should be fixed) or a feature/enhancement request (build or change something).
The deliverable is a commit or PR.

Decide by the DOMINANT intent. If the issue asks a question AND also requests a
change ("How do I do X — and could you add it?"), it is WORK: the change is the
deliverable and triage should handle it. Only pure information requests are QUESTION.
When genuinely unsure, answer WORK — triage is the safe default.

Respond with exactly one word on its own line: QUESTION or WORK`;

/**
 * Classify whether a newly-opened issue is a pure question (wants an answer)
 * versus a work item (wants a code change). Used by the router to send
 * question issues down the dedicated answer path instead of triage.
 *
 * Falls back to `false` (WORK → triage) on any error — triage is the safe
 * default, and a question that slips through still hits the issue-triage
 * skill's question safety net.
 */
export async function classifyIssueIsQuestion(
  title: string,
  body: string,
  options: ClassifierOptions = {},
): Promise<boolean> {
  try {
    const chat = options.chat ?? realChat;
    const defaultFastModel = options.defaultFastModel ?? realDefaultFastModel;
    const output = await chat(
      options.model ?? defaultFastModel("classifier"),
      [
        { role: "system", content: ISSUE_QUESTION_PROMPT },
        { role: "user", content: `TITLE: ${title}\n\nBODY: ${body}` },
      ],
      { maxTokens: 16 },
    );
    return /\bQUESTION\b/i.test(output);
  } catch (err: any) {
    console.error(`[classifier] Error classifying issue: ${err.message}`);
    return false;
  }
}

const ADDS_INFO_PROMPT = `You are deciding whether a new comment on a GitHub issue,
written by the issue's reporter, should re-open triage of that issue.

ADDS_INFO — the comment adds NEW substantive information that changes the problem
statement: extra details, reproduction steps, environment specifics, a concrete
example, clarification of the request, a scope change, or an answer to a question
triage previously asked. The kind of comment that would make a maintainer re-read
and re-classify the issue.

NOISE — the comment adds nothing that changes triage: thanks, acknowledgement,
agreement ("sounds good", "yes please"), a "+1"/me-too, a status update with no
new specifics, a question directed back at the maintainer, or general chatter.

When genuinely unsure, answer NOISE — re-triage should only fire on a clear
addition of information.

Respond with exactly one word on its own line: ADDS_INFO or NOISE`;

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
        { role: "system", content: ADDS_INFO_PROMPT },
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
 * Falls back to intent=action on any error (safe default).
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
    const output = await chat(
      resolvedOptions.model ?? defaultFastModel("classifier"),
      [
        { role: "system", content: CLASSIFIER_PROMPT },
        { role: "user", content: userPrompt },
      ],
      { maxTokens: 128 },
    );

    const upper = output.trim().toUpperCase();

    const intentMap: Record<string, CommentIntent> = {
      BUILD: "build",
      EXPLORE: "explore",
      QUESTION: "question",
      TRIAGE: "triage",
      REVIEW: "review",
      SECURITY: "security",
      VERIFY: "verify",
      QATEST: "qa-test",
      DEMO: "demo",
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

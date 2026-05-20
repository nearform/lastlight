import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import type { SessionManager } from "../connectors/messaging/session-manager.js";
import type { ExecutorConfig } from "./profiles.js";
import { wrapUntrusted } from "./screen.js";
import {
  type OpencodeChatServer,
  type OpencodeChatTurnResult,
} from "./opencode-chat-server.js";
import { ClaudeJsonlShim } from "./opencode-shim.js";

const AGENT_CONTEXT_DIR = resolve("agent-context");

/**
 * Chat-specific system prompt appended to the agent context. Loaded
 * once at supervisor start and written to `AGENTS.md` in the
 * chat-server working dir — same persona for every chat session.
 */
export const CHAT_SYSTEM_SUFFIX = `
You are Last Light, a GitHub repository maintenance assistant available via messaging (Slack, Discord, etc.).

WHAT YOU CAN DO — use these tools confidently when the user asks:
- Read repos, issues, PRs, code, commits, comments, labels, branches.
- **Create GitHub issues** via github_create_issue. You have full write
  permission for issues across every repo your installation can see — never
  refuse a create-issue request on the assumption you lack permission. If a
  call genuinely fails, retry once and then surface the literal error.
- Comment on issues / add labels (github_add_issue_comment, github_add_labels).
- Search across repos.

WHAT YOU CANNOT DO:
- No code changes. No commits, pushes, merges, branches, file edits.
- Do not use bash/edit/write/patch tools — they are not authorized for the
  chat persona. If the user asks you to build / fix / implement something,
  create a GitHub issue capturing the request, then tell them to run
  \`/build owner/repo#N\` to start the full build cycle (Architect →
  Executor → Reviewer → PR).

DO NOT ATTEMPT DEEP WORK IN-PROCESS.
Each of the following is a dedicated workflow — NOT something you can do
by chaining tool calls. If the user asks for one, reply with ONE message
naming the right command and stop. Do not start fetching files, reading
code, listing issues, or running any investigative tool calls in service
of these requests — you will hit the turn limit before producing useful
output, exactly as happened in prior incidents.

- "security review" / "scan for vulnerabilities" / "check security of <repo>"
  → reply: "run \`/security owner/repo\` (or tell me 'security review owner/repo')"
- "triage" / "scan issues" / "go through open issues on <repo>"
  → reply: "run \`/triage owner/repo\`"
- "review PRs on <repo>" / "check open PRs"
  → reply: "run \`/review owner/repo\`"
- "weekly health report" / "repo health"
  → reply: "run \`/health owner/repo\`"
- "build this" / "implement this" / "fix this bug" on a specific issue
  → create the GitHub issue if needed, then reply: "run \`/build owner/repo#N\`"

Only exception: if the user is asking a narrow *question* that you can
answer with one or two reads (e.g. "what does this file do?", "what labels
does this issue have?"), just do it. The rule is about full-repo scans and
multi-phase workflows, not about one-off lookups.

STYLE:
- Reach for tools immediately. Don't pre-explain what you're about to do.
- Keep replies concise — this is chat, not a document.
- The conversation history is maintained server-side per session — don't
  re-summarize it; just respond to the latest message.

Useful commands you can suggest:
\`/build owner/repo#N\`, \`/triage owner/repo\`, \`/review owner/repo\`,
\`/security owner/repo\`, \`/health owner/repo\`, \`/status\`
`;

/**
 * Result of a single chat turn — mirrors the metric shape the sandbox
 * executor returns so the chat dispatch path can persist a DB execution
 * row with full token / cost / duration accounting.
 */
export interface ChatResult {
  text: string;
  /**
   * OpenCode session id captured from the result. On the first turn of
   * a messaging thread this is a brand new id; on subsequent turns it
   * is the SAME id we passed in via `resume`. Persist this back onto
   * the messaging session so the next turn can resume into the same
   * server-side session (and same jsonl on disk).
   */
  agentSessionId?: string;
  success: boolean;
  durationMs: number;
  apiDurationMs?: number;
  turns?: number;
  costUsd?: number;
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens?: number;
  /** Mapped stop reason — "success", "error", etc. */
  stopReason?: string;
  /** Error message if the call threw or returned a non-success result. */
  error?: string;
}

export interface HandleChatMessageDeps {
  chatServer: OpencodeChatServer;
  /** Where to write the dashboard-shim jsonl. */
  claudeHomeDir: string;
  /**
   * MCP server names — passed to the shim so `<server>_<tool>` tool
   * names get the `mcp_` prefix the dashboard classifier expects.
   * Same source-of-truth as the sandbox executor.
   */
  mcpServerNames?: string[];
}

/**
 * Handle a conversational chat message via the long-lived `opencode
 * serve` HTTP server. Strictly read-only except for issue creation /
 * commenting / labelling, enforced by the system prompt + chat-server
 * MCP allowlist.
 *
 * Conversation continuity: the caller passes the OpenCode session id
 * from the previous turn (stored on the messaging-session row). On
 * the first turn we create one and return it; subsequent turns
 * resume the same id and accumulate context server-side.
 */
export async function handleChatMessage(
  message: string,
  _messagingSessionId: string,
  sender: string,
  _sessionManager: SessionManager,
  deps: HandleChatMessageDeps,
  config: ExecutorConfig,
  resumeAgentSessionId?: string,
): Promise<ChatResult> {
  const startTime = Date.now();

  try {
    // Wrap the user-supplied message in untrusted-content markers so the
    // agent treats it as data per agent-context/security.md. The router
    // has already prefixed any flagged messages with
    // `[lastlight-flag: ...]`, which stays inside the wrapper.
    const wrappedMessage = wrapUntrusted(message, {
      source: "messaging-user",
      author: sender,
    });

    // First-turn: ask the server to mint a session id.
    let sessionId = resumeAgentSessionId;
    if (!sessionId) {
      sessionId = await deps.chatServer.createSession({
        title: `chat:${sender}`,
      });
    }

    const turn = await deps.chatServer.postMessage(sessionId, wrappedMessage, {
      model: config.model,
    });

    // Translate the turn → ChatResult and write the dashboard envelope shim.
    const result = chatResultFromTurn(turn, message, startTime);

    // Dashboard live-tail shim. ChatSessionReader reads from
    // `claude-home/projects/-app/<sessionId>.jsonl` directly — match that
    // hardcoded slug rather than deriving from cwd.
    try {
      await writeChatShim({
        claudeHomeDir: deps.claudeHomeDir,
        mcpServerNames: deps.mcpServerNames ?? [],
        model: result.modelId,
        prompt: message,
        turn,
        result,
        durationMs: Date.now() - startTime,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[chat] failed to write dashboard shim: ${msg}`);
    }

    const costStr = result.costUsd !== undefined ? `, $${result.costUsd.toFixed(4)}` : "";
    console.log(
      `[chat] ${sender} → ${result.stopReason ?? "?"} (${result.turns ?? "?"} parts, ${Math.round(result.durationMs / 1000)}s${costStr})${
        result.agentSessionId ? ` [session ${result.agentSessionId.slice(0, 8)}…]${resumeAgentSessionId ? " resumed" : " new"}` : ""
      }`,
    );
    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[chat] Error handling message from ${sender}:`, errMsg);
    return {
      text: "Sorry, I encountered an error processing your message. Please try again.",
      success: false,
      durationMs: Date.now() - startTime,
      error: errMsg,
    };
  }
}

interface ChatResultExt extends ChatResult {
  modelId: string;
}

function chatResultFromTurn(
  turn: OpencodeChatTurnResult,
  _userMessage: string,
  startTime: number,
): ChatResultExt {
  const success = turn.finish === "stop";
  const stopReason = success ? "success" : `error_${turn.finish.replace(/-/g, "_")}`;
  const turns = countSteps(turn.parts);
  return {
    text: turn.text || (success
      ? "I wasn't able to generate a response. Please try again."
      : `Sorry — chat failed (${stopReason}).`),
    agentSessionId: turn.sessionId,
    success,
    durationMs: Date.now() - startTime,
    apiDurationMs: turn.apiDurationMs,
    turns,
    costUsd: turn.cost > 0 ? turn.cost : undefined,
    inputTokens: turn.tokens.input || undefined,
    cacheCreationInputTokens: turn.tokens.cacheWrite || undefined,
    cacheReadInputTokens: turn.tokens.cacheRead || undefined,
    outputTokens: turn.tokens.output || undefined,
    stopReason,
    error: success ? undefined : (turn.text || stopReason),
    modelId: turn.modelId,
  };
}

function countSteps(parts: Array<Record<string, unknown>>): number {
  return parts.filter((p) => p?.type === "step-finish").length;
}

/**
 * Build a Phase 2-style envelope jsonl from a chat turn and append it
 * under `claude-home/projects/-app/<sessionId>.jsonl`. Re-uses
 * `ClaudeJsonlShim` but feeds OpenCode-shaped events derived from the
 * blocking turn response (rather than from a live `run --format json`
 * stream).
 */
async function writeChatShim(opts: {
  claudeHomeDir: string;
  mcpServerNames: string[];
  model: string;
  prompt: string;
  turn: OpencodeChatTurnResult;
  result: ChatResult;
  durationMs: number;
}): Promise<void> {
  const shim = new ClaudeJsonlShim({
    claudeHomeDir: opts.claudeHomeDir,
    projectSlug: "-app", // ChatSessionReader hardcodes this slug
    mcpServerNames: opts.mcpServerNames,
    model: opts.model,
    initialPrompt: opts.prompt,
  });
  // Synthesize OpenCode-shaped events from the blocking response so the
  // same shim translator handles them. Each part becomes one event of
  // the matching type.
  const sessionID = opts.turn.sessionId;
  const baseTs = Date.now();
  for (const part of opts.turn.parts) {
    const type = part?.type;
    if (type === "text") {
      shim.feed({ type: "text", sessionID, timestamp: baseTs, part });
    } else if (type === "tool") {
      shim.feed({ type: "tool_use", sessionID, timestamp: baseTs, part });
    }
    // step-start, step-finish, reasoning: no-ops in the shim — same as Phase 2.
  }
  shim.finalize({
    finalText: opts.turn.text,
    turns: countSteps(opts.turn.parts),
    costUsd: opts.turn.cost,
    inputTokens: opts.turn.tokens.input,
    outputTokens: opts.turn.tokens.output,
    cacheReadInputTokens: opts.turn.tokens.cacheRead,
    cacheCreationInputTokens: opts.turn.tokens.cacheWrite,
    stopReason: opts.result.stopReason ?? "unknown",
    durationMs: opts.durationMs,
  });
  await shim.flush();
}

/**
 * Concatenate all `.md` files under `agent-context/` — used by the
 * supervisor to compose `AGENTS.md` for the chat-server working dir.
 */
export function loadAgentContext(dir?: string): string {
  const target = dir || AGENT_CONTEXT_DIR;
  try {
    const files = readdirSync(target)
      .filter((f) => f.endsWith(".md"))
      .sort();
    return files
      .map((f) => readFileSync(join(target, f), "utf-8"))
      .join("\n\n---\n\n");
  } catch {
    return "";
  }
}

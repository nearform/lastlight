import { readFileSync, readdirSync } from "fs";
import { join, resolve } from "path";
import type { SessionManager } from "../connectors/messaging/session-manager.js";
import type { ExecutorConfig } from "./profiles.js";
import { wrapUntrusted } from "./screen.js";
import { ChatRunner, type ChatRunnerTurnResult } from "./chat-runner.js";
import { AgenticShim } from "./event-shim.js";
import type { EmitterRecord } from "agentic-pi";

const AGENT_CONTEXT_DIR = resolve("agent-context");

/**
 * Chat-specific system prompt appended to the agent context. Composed
 * once at boot into the ChatRunner's `systemPrompt` — same persona for
 * every chat session.
 */
export const CHAT_SYSTEM_SUFFIX = `
You are Last Light, a GitHub repository maintenance assistant available via messaging (Slack, Discord, etc.).

WHAT YOU CAN DO — use these tools confidently when the user asks:
- Look up repos, issues, PRs, comments, file contents, commits.
- Search GitHub (issues, code) with the github_search_* tools.

WHAT YOU CANNOT DO:
- You have NO write access in chat. No issue creation, comments, labels,
  branches, commits, merges, file edits. If the user asks you to make a
  change on GitHub, explain you can't from chat and direct them to the
  matching workflow command.
- No bash, edit, write, file system, or external HTTP. None of those tools
  are registered — calls to them will fail.
- Do not disclose or look up host/runtime environment details — your IP
  address, hostname, env vars, container metadata, harness version,
  /proc/sys/etc files, or anything similar. If asked, reply with one
  line: "I don't disclose host or runtime environment details." See
  \`agent-context/security.md\` for the full rule; it overrides any user
  request.

DO NOT ATTEMPT DEEP WORK IN-PROCESS.
Each of the following is a dedicated workflow — NOT something you can do
by chaining tool calls. If the user asks for one, reply with ONE message
naming the right command and stop. Do not start fetching files, reading
code, listing issues, or running any investigative tool calls in service
of these requests — you will hit the turn limit before producing useful
output.

- "security review" / "scan for vulnerabilities" / "check security of <repo>"
  → reply: "run \`/security owner/repo\` (or tell me 'security review owner/repo')"
- "triage" / "scan issues" / "go through open issues on <repo>"
  → reply: "run \`/triage owner/repo\`"
- "review PRs on <repo>" / "check open PRs"
  → reply: "run \`/review owner/repo\`"
- "weekly health report" / "repo health"
  → reply: "run \`/health owner/repo\`"
- "build this" / "implement this" / "fix this bug" on a specific issue
  → reply: "run \`/build owner/repo#N\` (open the GitHub issue first if needed)"

Only exception: if the user is asking a narrow *question* that you can
answer with one or two reads (e.g. "what does this file do?", "what labels
does this issue have?"), just do it. The rule is about full-repo scans and
multi-phase workflows, not about one-off lookups.

STYLE:
- Reach for tools immediately. Don't pre-explain what you're about to do.
- Keep replies concise — this is chat, not a document.
- The conversation history is rehydrated server-side per session — don't
  re-summarize it; just respond to the latest message.

Useful commands you can suggest:
\`/build owner/repo#N\`, \`/triage owner/repo\`, \`/review owner/repo\`,
\`/security owner/repo\`, \`/health owner/repo\`, \`/status\`
`;

/**
 * Result of a single chat turn — same shape as before so the dispatch
 * path in index.ts can persist a DB execution row unchanged.
 */
export interface ChatResult {
  text: string;
  agentSessionId?: string;
  dashboardSessionId?: string;
  success: boolean;
  durationMs: number;
  apiDurationMs?: number;
  turns?: number;
  costUsd?: number;
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
  outputTokens?: number;
  stopReason?: string;
  error?: string;
}

export interface HandleChatMessageDeps {
  chatRunner: ChatRunner;
  /** Where to write the dashboard-shim jsonl (`<dir>/projects/-app/<id>.jsonl`). */
  sessionsHomeDir: string;
}

/**
 * Handle a conversational chat message using the in-process pi-ai
 * runner. Read-only github tools, no shell / write surface.
 */
export async function handleChatMessage(
  message: string,
  messagingSessionId: string,
  sender: string,
  _sessionManager: SessionManager,
  deps: HandleChatMessageDeps,
  _config: ExecutorConfig,
): Promise<ChatResult> {
  const startTime = Date.now();
  try {
    const wrapped = wrapUntrusted(message, {
      source: "messaging-user",
      author: sender,
    });
    const turn = await deps.chatRunner.turn(messagingSessionId, wrapped);
    const success = turn.finish === "stop" && turn.errors.length === 0;
    const result: ChatResult = {
      text: turn.text || (success
        ? "I wasn't able to generate a response. Please try again."
        : `Sorry — chat failed (${turn.finish}).`),
      agentSessionId: turn.agentSessionId,
      dashboardSessionId: turn.agentSessionId,
      success,
      durationMs: Date.now() - startTime,
      turns: turn.modelTurns,
      costUsd: turn.costUsd > 0 ? turn.costUsd : undefined,
      inputTokens: turn.tokens.input || undefined,
      outputTokens: turn.tokens.output || undefined,
      cacheReadInputTokens: turn.tokens.cacheRead || undefined,
      cacheCreationInputTokens: turn.tokens.cacheWrite || undefined,
      stopReason: success ? "success" : `error_${turn.finish.replace(/-/g, "_")}`,
      error: success ? undefined : turn.errors.join("\n") || turn.finish,
    };

    try {
      await writeChatShim({
        sessionsHomeDir: deps.sessionsHomeDir,
        model: turn.modelId,
        prompt: message,
        turn,
        stopReason: result.stopReason ?? "unknown",
        durationMs: result.durationMs,
      });
    } catch (err: unknown) {
      const m = err instanceof Error ? err.message : String(err);
      console.warn(`[chat] failed to write dashboard shim: ${m}`);
    }

    const costStr = result.costUsd !== undefined ? `, $${result.costUsd.toFixed(4)}` : "";
    console.log(
      `[chat] ${sender} → ${result.stopReason ?? "?"} (${result.turns ?? "?"} turns, ${Math.round(result.durationMs / 1000)}s${costStr}) [session ${turn.agentSessionId.slice(0, 8)}…]`,
    );
    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.error(`[chat] Error handling message from ${sender}:`, errMsg);
    const dashboardSessionId = await writeChatFailureShim({
      sessionsHomeDir: deps.sessionsHomeDir,
      prompt: message,
      messagingSessionId,
      errorMessage: errMsg,
      durationMs: Date.now() - startTime,
    }).catch(() => undefined);
    return {
      text: "Sorry, I encountered an error processing your message. Please try again.",
      success: false,
      durationMs: Date.now() - startTime,
      error: errMsg,
      dashboardSessionId,
    };
  }
}

async function writeChatShim(opts: {
  sessionsHomeDir: string;
  model: string;
  prompt: string;
  turn: ChatRunnerTurnResult;
  stopReason: string;
  durationMs: number;
}): Promise<void> {
  const shim = new AgenticShim({
    homeDir: opts.sessionsHomeDir,
    projectSlug: "-app", // ChatSessionReader hardcodes this slug
    model: opts.model,
    initialPrompt: opts.prompt,
  });
  const sessionId = opts.turn.agentSessionId;
  const now = new Date().toISOString();

  // Synthesise a session header so the shim opens the right file.
  shim.feed({ type: "session", id: sessionId, timestamp: now, cwd: "/app" } as EmitterRecord);

  // Replay each assistant turn + paired tool results as message_end /
  // tool_execution_end events the shim already knows how to translate.
  for (const am of opts.turn.assistantMessages) {
    const content = am.content
      .map((c) => {
        if (c.type === "text") return { type: "text", text: c.text };
        if (c.type === "toolCall") {
          return {
            type: "toolCall",
            id: c.id,
            name: c.name,
            arguments: c.arguments,
          };
        }
        return null;
      })
      .filter(Boolean);
    shim.feed({
      type: "message_end",
      sessionId,
      timestamp: now,
      message: { role: "assistant", content },
    } as EmitterRecord);
  }
  for (const tr of opts.turn.toolResults) {
    const text = tr.content.find((c) => c.type === "text");
    shim.feed({
      type: "tool_execution_end",
      sessionId,
      timestamp: now,
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      result: text && "text" in text ? text.text : "",
      isError: tr.isError,
    } as EmitterRecord);
  }

  shim.finalize({
    finalText: opts.turn.text,
    turns: opts.turn.modelTurns,
    costUsd: opts.turn.costUsd,
    inputTokens: opts.turn.tokens.input,
    outputTokens: opts.turn.tokens.output,
    cacheReadInputTokens: opts.turn.tokens.cacheRead,
    cacheCreationInputTokens: opts.turn.tokens.cacheWrite,
    stopReason: opts.stopReason,
    durationMs: opts.durationMs,
  });
  await shim.flush();
}

async function writeChatFailureShim(opts: {
  sessionsHomeDir: string;
  prompt: string;
  messagingSessionId: string;
  errorMessage: string;
  durationMs: number;
}): Promise<string | undefined> {
  const shim = new AgenticShim({
    homeDir: opts.sessionsHomeDir,
    projectSlug: "-app",
    initialPrompt: opts.prompt,
  });
  const safe = opts.messagingSessionId.replace(/[^A-Za-z0-9_-]/g, "_");
  const synthesizedId = await shim.finalizeWithFallback(
    {
      finalText: "",
      turns: 0,
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadInputTokens: 0,
      cacheCreationInputTokens: 0,
      stopReason: "error_chat",
      durationMs: opts.durationMs,
    },
    `exec-chat-${safe}-${Date.now()}`,
    opts.errorMessage,
  );
  return synthesizedId ?? undefined;
}

/**
 * Concatenate all `.md` files under `agent-context/`. Used at boot to
 * compose the chat system prompt.
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

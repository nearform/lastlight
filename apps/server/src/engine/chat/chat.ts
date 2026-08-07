import { loadAgentContext as loadResolvedAgentContext } from "../../workflows/loader.js";
import type { SessionManager } from "../../connectors/messaging/session-manager.js";
import type { ExecutorConfig } from "../github/profiles.js";
import { wrapUntrusted } from "../screen/screen.js";
import { ChatRunner, type ChatRunnerTurnResult } from "./chat-runner.js";
import { AgenticShim } from "../event-shim.js";
import { CHAT_PROJECT_SLUG } from "../../session-log.js";
import type { EmitterRecord } from "agentic-pi";
import { getRuntimeConfig } from "../../config/config.js";
import { recordError, recordExecutionMetrics, telemetryIncludesContent, withSpan } from "../../telemetry/index.js";
import { recordPiEvent } from "../../telemetry/pi-events.js";
import { logger } from "../../logging/logger.js";

const log = logger("chat");

/**
 * The chat-specific system prompt appended to the agent context is COMPOSED at
 * runtime from the enabled workflow set — see `chat-prompt.ts` for why it can no
 * longer be a constant concatenated once at boot. Re-exported here so the many
 * `#src/engine/chat/chat.js` importers (and `index.ts`) are unchanged.
 */
export { chatSystemSuffix, chatTriggers, resetChatPromptCache } from "./chat-prompt.js";


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
  /** Where to write dashboard-shim jsonl; SessionLog resolves the chat project slug. */
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
  return withSpan("lastlight.chat.turn", { "messaging.session_id": messagingSessionId, "messaging.sender": sender, model: _config.model }, async () => {
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
        : formatChatFailure(turn.finish, turn.errors)),
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
        includeContent: getRuntimeConfig()?.otel.includeContent ?? telemetryIncludesContent(),
      });
    } catch (err: unknown) {
      log.warn("Failed to write dashboard shim", { err });
    }

    log.info("Chat turn completed", {
      sender,
      stopReason: result.stopReason ?? "?",
      turns: result.turns ?? "?",
      durationSec: Math.round(result.durationMs / 1000),
      costUsd: result.costUsd,
      sessionId: turn.agentSessionId.slice(0, 8),
    });
    recordExecutionMetrics("chat", { model: turn.modelId, success: result.success, stop_reason: result.stopReason, durationMs: result.durationMs, costUsd: result.costUsd, inputTokens: result.inputTokens, outputTokens: result.outputTokens });
    return result;
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    log.error("Error handling message", { sender, err });
    const dashboardSessionId = await writeChatFailureShim({
      sessionsHomeDir: deps.sessionsHomeDir,
      prompt: message,
      messagingSessionId,
      errorMessage: errMsg,
      durationMs: Date.now() - startTime,
    }).catch(() => undefined);
    const durationMs = Date.now() - startTime;
    recordError("chat", err, { success: false, stop_reason: "error_exception", model: _config.model });
    recordExecutionMetrics("chat", { model: _config.model, success: false, stop_reason: "error_exception", durationMs });
    return {
      text: "Sorry, I encountered an error processing your message. Please try again.",
      success: false,
      durationMs,
      error: errMsg,
      dashboardSessionId,
    };
  }
  });
}

/**
 * Pick a useful Slack message for a failed chat turn. Provider errors
 * (insufficient_quota, rate limit, auth) get a dedicated line — the
 * raw error string was previously dropped, leaving users with just
 * "(error)".
 */
function formatChatFailure(finish: string, errors: string[]): string {
  const first = errors.find((e) => e && e.trim().length > 0)?.trim();
  if (first) {
    const lower = first.toLowerCase();
    if (
      lower.includes("credit balance") ||
      lower.includes("insufficient_quota") ||
      lower.includes("insufficient quota")
    ) {
      return `Sorry — the model provider rejected the request: out of credits / quota.\n> ${truncate(first, 300)}`;
    }
    if (lower.includes("rate limit") || lower.includes("rate_limit")) {
      return `Sorry — the model provider is rate-limiting us right now. Try again in a moment.\n> ${truncate(first, 300)}`;
    }
    if (lower.includes("unauthorized") || lower.includes("invalid_api_key") || lower.includes("api key")) {
      return `Sorry — the model provider rejected our API key.\n> ${truncate(first, 300)}`;
    }
    return `Sorry — chat failed (${finish}): ${truncate(first, 400)}`;
  }
  return `Sorry — chat failed (${finish}).`;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + "…";
}

async function writeChatShim(opts: {
  sessionsHomeDir: string;
  model: string;
  prompt: string;
  turn: ChatRunnerTurnResult;
  stopReason: string;
  durationMs: number;
  includeContent?: boolean;
}): Promise<void> {
  const shim = new AgenticShim({
    homeDir: opts.sessionsHomeDir,
    projectSlug: CHAT_PROJECT_SLUG, // Chat project slug is centralized in SessionLog
    model: opts.model,
    initialPrompt: opts.prompt,
  });
  const sessionId = opts.turn.agentSessionId;
  const now = new Date().toISOString();

  // Synthesise a session header so the shim opens the right file.
  const sessionRecord = { type: "session", id: sessionId, timestamp: now, cwd: "/app" } as EmitterRecord;
  shim.feed(sessionRecord);
  recordPiEvent(sessionRecord as unknown as Record<string, unknown>, { surface: "chat", includeContent: opts.includeContent === true, model: opts.model });

  // Replay each assistant turn + paired tool results as message_end /
  // tool_execution_end events the shim already knows how to translate.
  for (const am of opts.turn.assistantMessages) {
    const content = am.content
      .map((c) => {
        if (c.type === "text") return { type: "text", text: c.text };
        if (c.type === "thinking") return { type: "thinking", thinking: c.thinking };
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
    const record = {
      type: "message_end",
      sessionId,
      timestamp: now,
      message: { role: "assistant", content },
    } as EmitterRecord;
    shim.feed(record);
    recordPiEvent(record as unknown as Record<string, unknown>, { surface: "chat", includeContent: opts.includeContent === true, model: opts.model });
  }
  for (const tr of opts.turn.toolResults) {
    const text = tr.content.find((c) => c.type === "text");
    const record = {
      type: "tool_execution_end",
      sessionId,
      timestamp: now,
      toolCallId: tr.toolCallId,
      toolName: tr.toolName,
      result: text && "text" in text ? text.text : "",
      isError: tr.isError,
    } as EmitterRecord;
    shim.feed(record);
    recordPiEvent(record as unknown as Record<string, unknown>, { surface: "chat", includeContent: opts.includeContent === true, model: opts.model });
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
    projectSlug: CHAT_PROJECT_SLUG,
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

export function loadAgentContext(_dir?: string): string {
  return loadResolvedAgentContext();
}

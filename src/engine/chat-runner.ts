/**
 * In-process chat agent for Slack/Discord threads. Replaces the
 * `opencode serve` HTTP supervisor with a direct pi-ai conversation:
 *
 *  - One pi-ai conversation per messaging thread.
 *  - Conversation state lives in our existing `messaging_messages` DB
 *    table — rehydrated on every turn so harness restarts are transparent.
 *  - Tools are limited to read-only GitHub (see github-tools.ts). No bash,
 *    no edit, no file system, no MCP.
 *  - Per-thread in-flight chain so two messages in the same thread
 *    serialize cleanly while different threads stay parallel.
 */
import { randomUUID } from "node:crypto";
import { Octokit } from "octokit";
import {
  completeSimple,
  getModel,
  type AssistantMessage,
  type Context,
  type Message,
  type Model,
  type Api,
  type SimpleStreamOptions,
  type ThinkingLevel,
  type Tool,
  type ToolCall,
  type ToolResultMessage,
  type UserMessage,
} from "@earendil-works/pi-ai";
import type { SessionManager } from "../connectors/messaging/session-manager.js";
import { buildChatGitHubTools, type ChatGitHubAuth, type ChatGitHubToolset } from "./github-tools.js";

const MAX_TOOL_ROUNDS = 8;

export interface ChatRunnerConfig {
  /** Default model (pi-ai provider/id). */
  model: string;
  /** Pi thinking level (off..xhigh). Forwarded as `reasoning` option. */
  thinking?: string;
  /** Agent persona / system prompt — composed by index.ts from agent-context + CHAT_SYSTEM_SUFFIX. */
  systemPrompt: string;
  /** Optional GitHub App credentials. When set, read-only github tools are registered. */
  github?: ChatGitHubAuth;
  /** Per-turn timeout (ms). Default: 120s. */
  timeoutMs?: number;
}

export interface ChatRunnerTurnResult {
  /** Final assistant text. */
  text: string;
  /** UUID that pins this Slack thread to its on-disk JSONL. Same across all turns in one thread. */
  agentSessionId: string;
  /** Token + cost stats from the final assistant message. */
  tokens: {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
  };
  costUsd: number;
  /** Number of round-trips to the model in this turn (1 + tool rounds). */
  modelTurns: number;
  /** "stop" on a clean finish, "tool-error" / "error" / "max-rounds" otherwise. */
  finish: string;
  /** Errors that occurred during the turn. Empty when finish === "stop". */
  errors: string[];
  /** Concatenated assistant content from every model turn — for the dashboard shim. */
  assistantMessages: AssistantMessage[];
  /** Tool results emitted during the turn — for the dashboard shim. */
  toolResults: ToolResultMessage[];
  /** Resolved model id (pi-ai format). */
  modelId: string;
}

export class ChatRunner {
  private cfg: ChatRunnerConfig;
  private sessionManager: SessionManager;
  private tools: ChatGitHubToolset | undefined;
  private model: Model<Api>;
  private chains = new Map<string, Promise<unknown>>();

  constructor(cfg: ChatRunnerConfig, sessionManager: SessionManager) {
    this.cfg = cfg;
    this.sessionManager = sessionManager;
    if (cfg.github) {
      this.tools = buildChatGitHubTools(cfg.github);
    }
    this.model = resolveModel(cfg.model);
  }

  /**
   * Run one chat turn. Each messagingSessionId maps to a stable pi-ai
   * `agentSessionId` (a UUID we mint on first turn) which the dashboard
   * uses to look up the JSONL on disk.
   */
  async turn(messagingSessionId: string, prompt: string): Promise<ChatRunnerTurnResult> {
    const prev = this.chains.get(messagingSessionId) ?? Promise.resolve();
    const next = prev
      .catch(() => undefined)
      .then(() => this.doTurn(messagingSessionId, prompt));
    this.chains.set(messagingSessionId, next);
    const cleanup = () => {
      if (this.chains.get(messagingSessionId) === next) {
        this.chains.delete(messagingSessionId);
      }
    };
    next.then(cleanup, cleanup);
    return next;
  }

  private async doTurn(
    messagingSessionId: string,
    prompt: string,
  ): Promise<ChatRunnerTurnResult> {
    // Resolve (or mint) the stable agentSessionId pinned to this thread.
    const session = this.sessionManager.getSession(messagingSessionId);
    let agentSessionId = session?.agentSessionId || null;
    if (!agentSessionId) {
      agentSessionId = randomUUID();
      this.sessionManager.setAgentSessionId(messagingSessionId, agentSessionId);
    }

    // Rehydrate conversation context from the DB. Messages were stored
    // text-only on prior turns; we replay them as alternating user /
    // assistant text messages. Tool calls/results inside a single turn
    // never persist (they only live for that turn's loop) — that's a
    // deliberate simplification: the agent gets a clean conversation
    // history and can re-tool if asked again.
    const history = this.sessionManager.getHistory(messagingSessionId, 50);
    const messages: Message[] = history.map((h) => textMessage(h.role, h.content, h.timestamp));
    messages.push(textMessage("user", prompt, new Date().toISOString()));

    const context: Context = {
      systemPrompt: this.cfg.systemPrompt,
      messages,
      tools: this.tools?.tools as Tool[] | undefined,
    };

    const errors: string[] = [];
    const assistantMessages: AssistantMessage[] = [];
    const toolResults: ToolResultMessage[] = [];
    const opts: SimpleStreamOptions = {
      reasoning: pickReasoning(this.cfg.thinking),
      timeoutMs: this.cfg.timeoutMs ?? 120_000,
    };

    let finish = "stop";
    let tokensIn = 0;
    let tokensOut = 0;
    let cacheRead = 0;
    let cacheWrite = 0;
    let costUsd = 0;
    let modelTurns = 0;
    let finalText = "";

    for (let round = 0; round < MAX_TOOL_ROUNDS + 1; round++) {
      modelTurns++;
      let assistant: AssistantMessage;
      try {
        assistant = await completeSimple(this.model, context, opts);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        errors.push(msg);
        finish = "error";
        break;
      }
      assistantMessages.push(assistant);
      context.messages.push(assistant);

      tokensIn += assistant.usage.input;
      tokensOut += assistant.usage.output;
      cacheRead += assistant.usage.cacheRead;
      cacheWrite += assistant.usage.cacheWrite;
      costUsd += assistant.usage.cost.total;

      if (assistant.stopReason === "error" || assistant.stopReason === "aborted") {
        errors.push(assistant.errorMessage ?? assistant.stopReason);
        finish = "error";
        break;
      }

      // Pull text out (last text block wins — same convention as pi-ai's run() helper).
      const text = assistant.content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => (c as { text: string }).text)
        .join("");
      if (text) finalText = text;

      // Tool calls? Execute and loop.
      const toolCalls = assistant.content.filter((c) => c.type === "toolCall") as ToolCall[];
      if (toolCalls.length === 0) {
        finish = "stop";
        break;
      }

      if (!this.tools) {
        // Model emitted a tool call without any tools registered — shouldn't
        // happen, but bail out rather than loop forever.
        errors.push("Model called a tool, but no tools are registered for chat.");
        finish = "error";
        break;
      }

      for (const call of toolCalls) {
        const { content, isError } = await this.tools.execute(call);
        const tr: ToolResultMessage = {
          role: "toolResult",
          toolCallId: call.id,
          toolName: call.name,
          content: [{ type: "text", text: content }],
          isError,
          timestamp: Date.now(),
        };
        toolResults.push(tr);
        context.messages.push(tr);
        if (isError) errors.push(`${call.name}: ${content}`);
      }

      if (round === MAX_TOOL_ROUNDS) {
        finish = "max-rounds";
        errors.push(`Hit MAX_TOOL_ROUNDS (${MAX_TOOL_ROUNDS}); giving up on this turn.`);
        break;
      }
    }

    // Persist this turn's user + final assistant text. We do NOT persist
    // tool calls or intermediate model responses — only the human-visible
    // turn boundaries — to keep the rehydrated context compact.
    this.sessionManager.addMessage(messagingSessionId, "user", prompt);
    if (finalText) {
      this.sessionManager.addMessage(messagingSessionId, "assistant", finalText);
    }
    this.sessionManager.touchSession(messagingSessionId);

    return {
      text: finalText,
      agentSessionId,
      tokens: {
        input: tokensIn,
        output: tokensOut,
        cacheRead,
        cacheWrite,
      },
      costUsd,
      modelTurns,
      finish,
      errors,
      assistantMessages,
      toolResults,
      modelId: this.cfg.model,
    };
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

function resolveModel(spec: string): Model<Api> {
  const idx = spec.indexOf("/");
  if (idx < 0) throw new Error(`model spec must be 'provider/id', got '${spec}'`);
  const provider = spec.slice(0, idx);
  const modelId = spec.slice(idx + 1);
  // pi-ai's getModel is typed against its static registry; at runtime it
  // accepts arbitrary strings. Cast to bypass the narrowed types.
  return (getModel as unknown as (p: string, m: string) => Model<Api>)(provider, modelId);
}

function textMessage(role: string, content: string, timestamp: string): Message {
  const ts = parseTimestamp(timestamp);
  if (role === "user") {
    const m: UserMessage = { role: "user", content, timestamp: ts };
    return m;
  }
  // Treat any non-user historical role as assistant text.
  const m: AssistantMessage = {
    role: "assistant",
    content: [{ type: "text", text: content }],
    api: "openai-completions" as Api,
    provider: "history",
    model: "history",
    usage: zeroUsage(),
    stopReason: "stop",
    timestamp: ts,
  };
  return m;
}

function parseTimestamp(raw: string): number {
  const ms = Date.parse(raw);
  return Number.isFinite(ms) ? ms : Date.now();
}

function zeroUsage() {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
}

function pickReasoning(level: string | undefined): ThinkingLevel | undefined {
  // pi-ai's SimpleStreamOptions.reasoning excludes "off" — pi-ai default
  // is no reasoning, so we pass undefined for "off".
  if (!level || level === "off") return undefined;
  return level as ThinkingLevel;
}

/**
 * Octokit is bundled here only because github-tools.ts imports it at module
 * load. Re-export so callers can probe whether the integration is wired
 * without round-tripping through that file. Typed as `unknown` to avoid
 * dragging the Octokit type chain into the published .d.ts.
 */
export const __octokitForTest: unknown = Octokit;

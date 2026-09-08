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
import { completeSimple, getModel } from "@earendil-works/pi-ai/compat";
import type {
  AssistantMessage,
  Context,
  Message,
  Model,
  Api,
  SimpleStreamOptions,
  ThinkingLevel,
  Tool,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { SessionManager } from "../../connectors/messaging/session-manager.js";
import { buildChatGitHubTools, type ChatGitHubAuth, type ChatGitHubToolset } from "../github/github-tools.js";
import {
  OAUTH_ONLY_PROVIDERS,
  oauthProviderIdForModel,
  resolveOAuthApiKey,
} from "../oauth.js";
import { providerRegistry } from "../../config/provider-registry.js";
import { logger } from "../../logging/logger.js";

const log = logger("chat");

const MAX_TOOL_ROUNDS = 8;

/**
 * Exponential backoff schedule (ms) for transient chat-model failures —
 * rate limits (429) and provider hiccups (5xx / overloaded / transient
 * network). pi-ai disables the provider SDK's own retries (`maxRetries: 0`),
 * so without this a single 429 from the model would kill the whole turn.
 * The sandbox path already retries via pi-coding-agent's auto-retry; the
 * chat path drives pi-ai directly, so it needs its own.
 */
const CHAT_RETRY_BACKOFF_MS = [10_000, 30_000, 60_000];

/**
 * Match transient, retryable model errors. Deliberately conservative: auth /
 * validation / context-overflow / other 4xx (anything but 429) are NOT
 * retried — only rate limits, server errors, and transient network faults.
 */
export function isRetryableModelError(message: string): boolean {
  const m = message.toLowerCase();
  return (
    /\b429\b/.test(m) ||
    m.includes("rate limit") ||
    m.includes("rate_limit") ||
    m.includes("too many requests") ||
    m.includes("overloaded") ||
    /\b50[0234]\b/.test(m) || // 500 / 502 / 503 / 504
    m.includes("service unavailable") ||
    m.includes("timeout") ||
    m.includes("etimedout") ||
    m.includes("econnreset") ||
    m.includes("fetch failed")
  );
}

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Call `complete`, retrying transient failures with exponential backoff.
 * Handles both shapes pi-ai surfaces a failure as: a thrown error, and a
 * returned AssistantMessage with `stopReason === "error"`. Non-retryable
 * outcomes (and the final attempt) are returned/thrown unchanged so the
 * caller's existing error handling still applies. Dependency-injected for
 * testing (`delaysMs` / `sleepFn` / `onRetry`).
 */
export async function completeWithRetry(
  complete: (m: Model<Api>, c: Context, o: SimpleStreamOptions) => Promise<AssistantMessage>,
  model: Model<Api>,
  context: Context,
  opts: SimpleStreamOptions,
  deps: {
    delaysMs?: number[];
    sleepFn?: (ms: number) => Promise<void>;
    onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void;
  } = {},
): Promise<AssistantMessage> {
  const delays = deps.delaysMs ?? CHAT_RETRY_BACKOFF_MS;
  const doSleep = deps.sleepFn ?? sleepMs;
  let attempt = 0;
  for (;;) {
    let assistant: AssistantMessage | undefined;
    let errMsg: string;
    let thrown: unknown;
    try {
      assistant = await complete(model, context, opts);
      if (assistant.stopReason !== "error") return assistant;
      errMsg = assistant.errorMessage ?? "error";
    } catch (err) {
      thrown = err;
      errMsg = err instanceof Error ? err.message : String(err);
    }
    if (attempt >= delays.length || !isRetryableModelError(errMsg)) {
      if (thrown !== undefined) throw thrown; // preserve the original error
      return assistant as AssistantMessage; // non-retryable / exhausted errored assistant
    }
    const delayMs = delays[attempt];
    deps.onRetry?.({ attempt: attempt + 1, delayMs, reason: errMsg });
    await doSleep(delayMs);
    attempt++;
  }
}

/**
 * Optional extra toolset merged into the chat agent's tool list
 * alongside the github tools. Used to register the `read_skill` tool
 * that exposes the curated chat skill catalogue.
 */
export interface ChatExtraToolset {
  tools: Tool[];
  execute(call: ToolCall): { content: string; isError: boolean } | Promise<{ content: string; isError: boolean }>;
}

export interface ChatRunnerConfig {
  /** Default model (pi-ai provider/id). */
  model: string;
  /** Pi thinking level (off..xhigh). Forwarded as `reasoning` option. */
  thinking?: string;
  /**
   * Agent persona / system prompt — composed by index.ts from agent-context +
   * `chatSystemSuffix()` + the skill catalogue.
   *
   * A THUNK is resolved per turn. The workflow triggers the suffix advertises are
   * composed from the enabled workflow set, and an admin can disable a workflow
   * from the dashboard mid-process (the `workflow_overrides` table, enforced at
   * dispatch in `simple.ts`) — a boot-time string would keep naming a trigger
   * that had since become a no-op. The thunk may be async — resolving the
   * enabled set is a database read. A plain string stays supported for callers
   * with nothing dynamic to say.
   */
  systemPrompt: string | (() => string | Promise<string>);
  /** Optional GitHub App credentials. When set, read-only github tools are registered. */
  github?: ChatGitHubAuth;
  /**
   * Optional extra tools (e.g. `read_skill`) registered in addition to
   * the github toolset. Both tool lists are concatenated; per-call
   * dispatch tries github first, then this set.
   */
  extraTools?: ChatExtraToolset;
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
  private extraTools: ChatExtraToolset | undefined;
  /** Concatenated tool list passed to pi-ai (github + extra). */
  private mergedTools: Tool[] | undefined;
  /**
   * Resolved lazily on the first chat turn. A bad chat model spec
   * (unknown id) MUST NOT crash the whole harness — webhooks, crons and
   * workflows don't depend on it.
   */
  private model: Model<Api> | undefined;
  private modelError: string | undefined;
  private chains = new Map<string, Promise<unknown>>();
  /**
   * OAuth provider id backing the chat model (e.g. `openai-codex` for a
   * `openai-codex/gpt-5.4` spec), or undefined for API-key providers. When
   * set, each turn resolves a fresh subscription token instead of relying on
   * a provider env var. Derived once from `cfg.model`.
   */
  private oauthProviderId: string | undefined;

  constructor(cfg: ChatRunnerConfig, sessionManager: SessionManager) {
    this.cfg = cfg;
    this.sessionManager = sessionManager;
    this.oauthProviderId = oauthProviderIdForModel(cfg.model);
    if (cfg.github) {
      this.tools = buildChatGitHubTools(cfg.github);
    }
    this.extraTools = cfg.extraTools;
    const merged: Tool[] = [
      ...(this.tools?.tools ?? []),
      ...(this.extraTools?.tools ?? []),
    ];
    this.mergedTools = merged.length > 0 ? merged : undefined;
  }

  /**
   * Dispatch a tool call to whichever toolset registered it. Github
   * tools take precedence (they're registered first); fall back to the
   * extra toolset for anything not in the github name set.
   */
  private async dispatchTool(call: ToolCall): Promise<{ content: string; isError: boolean }> {
    if (this.tools?.tools.some((t) => t.name === call.name)) {
      return this.tools.execute(call);
    }
    if (this.extraTools?.tools.some((t) => t.name === call.name)) {
      return this.extraTools.execute(call);
    }
    return {
      content: JSON.stringify({ error: `unknown tool: ${call.name}` }),
      isError: true,
    };
  }

  /** Build a failed-turn result carrying a single actionable error message. */
  private errorTurn(agentSessionId: string, message: string): ChatRunnerTurnResult {
    return {
      text: "",
      agentSessionId,
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      costUsd: 0,
      modelTurns: 0,
      finish: "error",
      errors: [message],
      assistantMessages: [],
      toolResults: [],
      modelId: this.cfg.model,
    };
  }

  private resolveModelLazy(): Model<Api> | undefined {
    if (this.model) return this.model;
    if (this.modelError) return undefined;
    try {
      this.model = resolveModel(this.cfg.model);
      return this.model;
    } catch (err) {
      this.modelError = err instanceof Error ? err.message : String(err);
      log.error("Could not resolve model", { err });
      return undefined;
    }
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
    const session = await this.sessionManager.getSession(messagingSessionId);
    let agentSessionId = session?.agentSessionId || null;
    if (!agentSessionId) {
      agentSessionId = randomUUID();
      await this.sessionManager.setAgentSessionId(messagingSessionId, agentSessionId);
    }

    // Bail with a clear error if the chat model spec is unknown to pi-ai.
    // Done here rather than in the constructor so a misconfigured chat
    // model only fails chat turns, not the whole server.
    const model = this.resolveModelLazy();
    if (!model) {
      return this.errorTurn(agentSessionId, this.modelError ?? "chat model not configured");
    }

    // Resolve the effective model + credentials. For OAuth-backed chat models
    // (Codex / Claude Pro / Copilot) we mint a fresh subscription token per
    // turn (pi-ai refreshes it if expired) and pass it as the per-call apiKey
    // — the in-process chat path can carry an explicit key, unlike the sandbox.
    let effectiveModel = model;
    let apiKey: string | undefined;
    if (this.oauthProviderId) {
      try {
        const res = await resolveOAuthApiKey(this.oauthProviderId);
        if (res) {
          apiKey = res.apiKey;
          // (Model base-URL adjustment from credentials is handled inside
          // pi-ai's OAuthAuth.toAuth() in the new API; no per-call override needed.)
        } else if (OAUTH_ONLY_PROVIDERS.has(this.oauthProviderId)) {
          // OAuth-only provider with no stored credentials — cannot fall back
          // to an API key, so fail this turn with an actionable message.
          return this.errorTurn(
            agentSessionId,
            `Chat model '${this.cfg.model}' requires an OAuth login. Run: ` +
              `lastlight oauth login ${this.oauthProviderId}`,
          );
        }
        // Non-OAuth-only (anthropic) with no creds: fall through to env-key auth.
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return this.errorTurn(
          agentSessionId,
          `OAuth token refresh failed for '${this.oauthProviderId}': ${msg}. ` +
            `Re-run: lastlight oauth login ${this.oauthProviderId}`,
        );
      }
    }

    // Rehydrate conversation context from the DB. Messages were stored
    // text-only on prior turns; we replay them as alternating user /
    // assistant text messages. Tool calls/results inside a single turn
    // never persist (they only live for that turn's loop) — that's a
    // deliberate simplification: the agent gets a clean conversation
    // history and can re-tool if asked again.
    const history = await this.sessionManager.getHistory(messagingSessionId, 50);
    const messages: Message[] = history.map((h) => textMessage(h.role, h.content, h.timestamp));
    messages.push(textMessage("user", prompt, new Date().toISOString()));

    const context: Context = {
      systemPrompt:
        typeof this.cfg.systemPrompt === "function"
          ? await this.cfg.systemPrompt()
          : this.cfg.systemPrompt,
      messages,
      tools: this.mergedTools,
    };

    const errors: string[] = [];
    const assistantMessages: AssistantMessage[] = [];
    const toolResults: ToolResultMessage[] = [];
    // A provider whose key env var this deployment named — a custom provider
    // (pi-ai knows no convention for it) or a gateway holding its own credential
    // — has to be handed the key explicitly, over the same per-call channel the
    // OAuth branch above uses. An OAuth token, when there is one, still wins.
    const customKey = apiKey ?? endpointApiKey(effectiveModel.provider);
    const opts: SimpleStreamOptions = {
      reasoning: pickReasoning(this.cfg.thinking),
      timeoutMs: this.cfg.timeoutMs ?? 120_000,
      ...(customKey ? { apiKey: customKey } : {}),
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
        assistant = await completeWithRetry(completeSimple, effectiveModel, context, opts, {
          onRetry: ({ attempt, delayMs, reason }) =>
            log.warn("Transient model error, retrying", {
              attempt,
              maxAttempts: CHAT_RETRY_BACKOFF_MS.length,
              delayMs,
              reason,
            }),
        });
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

      if (!this.mergedTools) {
        // Model emitted a tool call without any tools registered — shouldn't
        // happen, but bail out rather than loop forever.
        errors.push("Model called a tool, but no tools are registered for chat.");
        finish = "error";
        break;
      }

      for (const call of toolCalls) {
        const { content, isError } = await this.dispatchTool(call);
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
    await this.sessionManager.addMessage(messagingSessionId, "user", prompt);
    if (finalText) {
      await this.sessionManager.addMessage(messagingSessionId, "assistant", finalText);
    }
    await this.sessionManager.touchSession(messagingSessionId);

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

/** Exported for unit tests — the endpoint-override branches below. */
export function resolveModel(spec: string): Model<Api> {
  const idx = spec.indexOf("/");
  if (idx < 0) throw new Error(`model spec must be 'provider/id', got '${spec}'`);
  const provider = spec.slice(0, idx);
  const modelId = spec.slice(idx + 1);
  // Where this deployment says that provider lives (issue #373). Chat is a
  // model call like any other: if the operator moved the endpoint to a gateway,
  // this path has to follow it, or chat alone keeps talking to the vendor.
  const endpoint = providerRegistry().endpoints.find((e) => e.prefix === provider);
  // pi-ai's getModel is typed against its static registry; at runtime it
  // accepts arbitrary strings AND returns undefined for unknown ids rather
  // than throwing. Without this guard the first chat turn crashes deep in
  // the provider stack with "Cannot read properties of undefined (reading
  // 'api')" — surface a clear, actionable error instead.
  const model = (getModel as unknown as (p: string, m: string) => Model<Api> | undefined)(
    provider,
    modelId,
  );
  // Only `baseUrl` moves. `endpoint.api` is provably equal to the catalog
  // model's for a built-in provider — `resolveProviderRegistry` REFUSES an `api`
  // override there, precisely so this path and `llm.ts` cannot disagree about
  // the request shape (a gateway with a different dialect declares its own
  // prefix, and takes the synthesized branch below).
  if (model) return endpoint ? { ...model, baseUrl: endpoint.baseUrl } : model;
  if (endpoint) {
    // A deployment-declared provider pi-ai has never heard of. Nothing to
    // inherit, so the model is synthesized from the override: its api family
    // decides the request shape and the gateway decides everything else. Cost
    // is zero because a gateway publishes no price list — a chat turn against a
    // custom provider reports no spend rather than a wrong one.
    return {
      id: modelId,
      name: modelId,
      api: endpoint.api as Api,
      provider,
      baseUrl: endpoint.baseUrl,
      reasoning: false,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: endpoint.contextWindow ?? 128_000,
      maxTokens: endpoint.maxTokens ?? 16_384,
    };
  }
  throw new Error(
    `Unknown chat model '${spec}'. pi-ai's registry has no '${modelId}' for provider '${provider}'. ` +
    `Set LASTLIGHT_MODELS (or LASTLIGHT_MODEL) to a registered model id.`,
  );
}

/**
 * The API key for a provider whose `providers:` entry NAMED its key env var —
 * a deployment-declared custom provider, or a built-in whose gateway keeps
 * custody of its own credential (`GATEWAY_API_KEY`, not `ANTHROPIC_API_KEY`).
 *
 * Undefined otherwise, including for a provider whose endpoint merely moved:
 * pi-ai resolves those itself, and handing it a key here would bypass the OAuth
 * subscription path.
 *
 * Exported for unit tests.
 */
export function endpointApiKey(provider: string): string | undefined {
  const endpoint = providerRegistry().endpoints.find(
    (e) => e.prefix === provider && e.envKeyOverridden,
  );
  return endpoint ? process.env[endpoint.envKey] : undefined;
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

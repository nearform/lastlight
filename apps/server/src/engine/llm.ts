/**
 * Thin one-shot LLM chat helper used by the prompt-injection screener and the
 * intent classifier. Powered by `src/providers.ts` — that registry is the
 * single source of truth for which providers this helper can call.
 *
 * The screener + classifier are deliberately small and explicit. They need a
 * cheap/fast model on the SAME provider the user picked (or any registered
 * provider whose key is present) so the agent's primary model and the cheap
 * helper share one footprint. We support two request families:
 *
 *   `openai-completions`   — body `{ model, messages, <maxTokensField> }`,
 *                            response `choices[0].message.content`. Covers
 *                            OpenAI, OpenRouter, Groq, Cerebras, xAI,
 *                            Hugging Face, Moonshot, NVIDIA, Fireworks,
 *                            Together, DeepSeek, Z.AI, and Google/Mistral
 *                            via their OpenAI-compatible endpoints.
 *   `anthropic-messages`   — `system` field + content-block response.
 *                            Covers Anthropic, Kimi for Coding, MiniMax.
 *
 * Scope: this helper supports the providers listed in `src/providers.ts`.
 * Workflow phases themselves are provider-agnostic (whatever pi-ai
 * supports); only the screener/classifier path is constrained here.
 */

import { PROVIDERS, providerByPrefix, type ApiType, type ProviderSpec } from "@lastlight/shared/providers";
import { getRuntimeConfig } from "../config/config.js";

export type ChatRole = "system" | "user" | "assistant";

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface ChatOptions {
  /** Hard cap on output tokens (default: 256 — these calls are tiny). */
  maxTokens?: number;
  /** Per-call timeout (default: 30s). */
  timeoutMs?: number;
}

export type CallLlmOptions = ChatOptions;
export type ChatFunction = (model: string, messages: ChatMessage[], opts?: ChatOptions) => Promise<string>;

/** Resolved routing for a `provider/model` spec. */
export interface ResolvedProvider {
  /** Pi-ai-style provider prefix (`anthropic`, `openai`, `openrouter`, …). */
  provider: string;
  /** Model id the upstream API expects (prefix stripped, nested tail preserved if applicable). */
  modelId: string;
  /** Which request family to use. */
  api: ApiType;
}

// ── Resolvers (exported for unit tests) ──────────────────────────────────────

/**
 * Resolve a `provider/model` spec (or a bare model id) into a routing
 * decision. Prefers an explicit `<prefix>/<model>` over name-inference.
 *
 * @throws if the prefix is present but not registered — silently
 * mis-routing a `xai/grok-4` to OpenAI would bill the wrong account and
 * fail at request time with a confusing error, so we surface it early.
 */
export function resolveProvider(model: string): ResolvedProvider {
  const slash = model.indexOf("/");
  if (slash > 0) {
    const prefix = model.slice(0, slash).toLowerCase();
    const tail = model.slice(slash + 1);
    const spec = providerByPrefix(prefix);
    if (spec) {
      return {
        provider: spec.prefix,
        modelId: tail,
        api: spec.api,
      };
    }
    throw new Error(
      `llm helper: unsupported provider prefix "${prefix}" ` +
        `(registered: ${PROVIDERS.map((p) => p.prefix).join(", ")})`,
    );
  }

  // Bare model id — fall back to inference by name. OpenRouter's nested
  // `vendor/model` ids are handled above (its prefix is "openrouter").
  if (/^claude/i.test(model)) {
    return { provider: "anthropic", modelId: model, api: "anthropic-messages" };
  }
  if (/^gpt/i.test(model) || /^o\d/.test(model)) {
    return { provider: "openai", modelId: model, api: "openai-completions" };
  }

  // Anything else: assume OpenAI-completions shape against an OpenAI endpoint.
  return { provider: "openai", modelId: model, api: "openai-completions" };
}

/**
 * Resolve the model id for a tiny one-shot helper call (classifier / screener).
 * Precedence for a given `taskType`:
 *   1. an explicit per-task entry in the config `models:` map (`models.classifier`,
 *      `models.screener`) — which already has env `OPENCODE_MODELS` /
 *      `LASTLIGHT_MODELS` layered on top at config-load, so this covers both
 *      config.yaml and the env override in one lookup;
 *   2. the env `OPENCODE_MODELS` map read directly — a fallback for contexts
 *      where runtime config isn't loaded (some CLI / test paths);
 *   3. the first configured provider in `PROVIDERS` order (registry order:
 *      Anthropic first, then OpenAI, OpenRouter, then the rest — `src/providers.ts`).
 *
 * Note: only an EXPLICIT per-task entry counts — never `models.default` — so the
 * cheap helpers stay cheap unless a deployment deliberately pins them.
 */
export function defaultFastModel(taskType?: string): string {
  if (taskType) {
    const configured = getRuntimeConfig()?.models?.[taskType];
    if (configured) return configured;
    const override = readOpencodeModelOverride(taskType);
    if (override) return override;
  }
  for (const spec of PROVIDERS) {
    if (process.env[spec.envKey]) return `${spec.prefix}/${spec.fastModel}`;
  }
  // No keys set — fall back to the OpenAI default; chat() will then throw a
  // clear "OPENAI_API_KEY not set" error at call time.
  const openaiSpec = providerByPrefix("openai")!;
  return `${openaiSpec.prefix}/${openaiSpec.fastModel}`;
}

function readOpencodeModelOverride(taskType: string): string | undefined {
  const raw = process.env.OPENCODE_MODELS;
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const v = parsed?.[taskType];
    return typeof v === "string" ? v : undefined;
  } catch {
    return undefined;
  }
}

// ── Request builders ────────────────────────────────────────────────────────

function apiKeyFor(spec: ProviderSpec): string {
  const apiKey = process.env[spec.envKey];
  if (!apiKey) throw new Error(`${spec.envKey} not set`);
  return apiKey;
}

/** Append `/messages` (Anthropic-style) taking baseUrl shape into account. */
function anthropicUrl(spec: ProviderSpec): string {
  return spec.baseUrl.endsWith("/v1")
    ? `${spec.baseUrl}/messages`
    : `${spec.baseUrl}/v1/messages`;
}

/** Append `/chat/completions` (OpenAI-style). */
function openaiUrl(spec: ProviderSpec): string {
  return `${spec.baseUrl}/chat/completions`;
}

function buildRequest(
  spec: ProviderSpec,
  modelId: string,
  messages: ChatMessage[],
  opts: ChatOptions,
  apiKey: string,
  signal: AbortSignal,
): { url: string; init: RequestInit } {
  if (spec.api === "anthropic-messages") {
    return buildAnthropicMessages({ spec, modelId, messages, opts, apiKey, signal });
  }
  return buildOpenaiCompletions({ spec, modelId, messages, opts, apiKey, signal });
}

function buildAnthropicMessages(args: {
  spec: ProviderSpec;
  modelId: string;
  messages: ChatMessage[];
  opts: ChatOptions;
  apiKey: string;
  signal: AbortSignal;
}): { url: string; init: RequestInit } {
  const { spec, modelId, messages, opts, apiKey, signal } = args;
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n");
  return {
    url: anthropicUrl(spec),
    init: {
      method: "POST",
      signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
      },
      body: JSON.stringify({
        model: modelId,
        max_tokens: opts.maxTokens ?? 256,
        ...(system ? { system } : {}),
        messages: messages
          .filter((m) => m.role !== "system")
          .map((m) => ({ role: m.role, content: m.content })),
      }),
    },
  };
}

function buildOpenaiCompletions(args: {
  spec: ProviderSpec;
  modelId: string;
  messages: ChatMessage[];
  opts: ChatOptions;
  apiKey: string;
  signal: AbortSignal;
}): { url: string; init: RequestInit } {
  const { spec, modelId, messages, opts, apiKey, signal } = args;
  // OpenAI's `max_completion_tokens` (newer family) vs. the cross-provider
  // `max_tokens`. Almost every OpenAI-completions provider accepts `max_tokens`;
  // OpenAI itself prefers `max_completion_tokens` so we surface that as a
  // per-provider override in the registry.
  const maxField = spec.maxTokensField ?? "max_tokens";
  const headers: Record<string, string> = {
    "content-type": "application/json",
    authorization: `Bearer ${apiKey}`,
  };
  if (spec.extraHeaders) {
    for (const [k, v] of Object.entries(spec.extraHeaders)) headers[k] = v;
  }
  return {
    url: openaiUrl(spec),
    init: {
      method: "POST",
      signal,
      headers,
      body: JSON.stringify({
        model: modelId,
        [maxField]: opts.maxTokens ?? 256,
        messages,
      }),
    },
  };
}

// ── Response extractors ─────────────────────────────────────────────────────

function extractAnthropicText(data: unknown): string {
  const content = (data as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
  return content
    .filter((block) => block.type === "text" && typeof block.text === "string")
    .map((block) => block.text as string)
    .join("");
}

function extractOpenaiText(data: unknown): string {
  return (
    (data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ??
    ""
  );
}

function extractText(spec: ProviderSpec, data: unknown): string {
  return spec.api === "anthropic-messages" ? extractAnthropicText(data) : extractOpenaiText(data);
}

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Make a provider-agnostic chat call and return the final assistant text.
 *
 * @throws if the relevant API key isn't set or the upstream returns non-2xx
 */
export async function chat(
  model: string,
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  const { provider, modelId, api } = resolveProvider(model);
  const spec = providerByPrefix(provider);
  // For bare-id inference where the prefix isn't in the registry (the
  // generic "assume OpenAI" fallback), synthesize a pseudo-spec so the
  // OpenAI-completions builder still runs.
  const resolvedSpec: ProviderSpec =
    spec ?? {
      prefix: provider,
      displayName: provider,
      envKey: "OPENAI_API_KEY",
      baseUrl: "https://api.openai.com/v1",
      api,
      host: "openai.com",
      fastModel: modelId,
      sampleModel: modelId,
    };
  return withRetry(async (signal) => {
    const apiKey = apiKeyFor(resolvedSpec);
    const { url, init } = buildRequest(resolvedSpec, modelId, messages, opts, apiKey, signal);
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${resolvedSpec.prefix} api ${res.status}: ${text}`);
    }
    const data = await res.json();
    return extractText(resolvedSpec, data);
  }, opts.timeoutMs ?? 30_000);
}

/** Compatibility wrapper for older single-turn call sites. */
export async function callLlm(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  opts: CallLlmOptions = {},
): Promise<string> {
  return chat(
    model,
    [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
    opts,
  );
}

/**
 * Single retry on transient upstream failures. The screener and classifier
 * call this inline on every incoming event, so a single 429/503 from the
 * provider would otherwise silently drop the event and break routing.
 */
async function withRetry(
  call: (signal: AbortSignal) => Promise<string>,
  timeoutMs: number,
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      return await call(ctrl.signal);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const transient = /\b(429|5\d\d)\b/.test(msg);
      if (attempt === 1 || !transient) throw err;
      await new Promise((r) => setTimeout(r, 750));
    } finally {
      clearTimeout(timer);
    }
  }
  // Unreachable — loop either returns or throws.
  throw new Error("chat: retry loop fell through");
}
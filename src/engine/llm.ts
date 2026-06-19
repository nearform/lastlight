/**
 * Thin one-shot LLM chat helper used by the prompt-injection screener and the
 * intent classifier. Provider is selected by the model id prefix so callers
 * don't need to wire provider-specific code paths:
 *
 *   "anthropic/claude-…" or unprefixed "claude-…"  →  Anthropic Messages API
 *   "openai/gpt-…"      or unprefixed "gpt-…"     →  OpenAI Chat Completions API
 *   "openrouter/vendor/model"                     →  OpenRouter Chat Completions
 *
 * Scope: this helper supports Anthropic, OpenAI, and OpenRouter. OpenCode
 * workflow phases are provider-agnostic (whatever OpenCode supports), but the
 * screener/classifier path is deliberately small and explicit.
 */

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
type ProviderName = "anthropic" | "openai" | "openrouter";

type ProviderAdapter = {
  name: ProviderName;
  prefix: string;
  envKey: string;
  defaultModel: string;
  resolveModelId: (model: string) => string | undefined;
  buildRequest: (args: {
    modelId: string;
    messages: ChatMessage[];
    opts: ChatOptions;
    apiKey: string;
    signal: AbortSignal;
  }) => { url: string; init: RequestInit };
  extractText: (data: unknown) => string;
};

const PROVIDERS: ProviderAdapter[] = [
  {
    name: "anthropic",
    prefix: "anthropic",
    envKey: "ANTHROPIC_API_KEY",
    defaultModel: "anthropic/claude-haiku-4-5-20251001",
    resolveModelId: (model) => (model.toLowerCase().startsWith("claude") ? model : undefined),
    buildRequest: ({ modelId, messages, opts, apiKey, signal }) => {
      const system = messages
        .filter((message) => message.role === "system")
        .map((message) => message.content)
        .join("\n");
      return {
        url: "https://api.anthropic.com/v1/messages",
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
              .filter((message) => message.role !== "system")
              .map((message) => ({ role: message.role, content: message.content })),
          }),
        },
      };
    },
    extractText: (data) => {
      const content = (data as { content?: Array<{ type?: string; text?: string }> }).content ?? [];
      return content
        .filter((block) => block.type === "text" && typeof block.text === "string")
        .map((block) => block.text as string)
        .join("");
    },
  },
  {
    name: "openai",
    prefix: "openai",
    envKey: "OPENAI_API_KEY",
    defaultModel: "openai/gpt-5.4-mini",
    resolveModelId: (model) => model,
    buildRequest: ({ modelId, messages, opts, apiKey, signal }) => ({
      url: "https://api.openai.com/v1/chat/completions",
      init: {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify({
          model: modelId,
          max_completion_tokens: opts.maxTokens ?? 256,
          messages,
        }),
      },
    }),
    extractText: (data) => (data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "",
  },
  {
    name: "openrouter",
    prefix: "openrouter",
    envKey: "OPENROUTER_API_KEY",
    defaultModel: "openrouter/google/gemini-2.5-flash",
    resolveModelId: () => undefined,
    buildRequest: ({ modelId, messages, opts, apiKey, signal }) => ({
      url: "https://openrouter.ai/api/v1/chat/completions",
      init: {
        method: "POST",
        signal,
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${apiKey}`,
          "HTTP-Referer": "https://github.com/cliftonc/lastlight",
          "X-Title": "Last Light",
        },
        body: JSON.stringify({
          model: modelId,
          max_tokens: opts.maxTokens ?? 256,
          messages,
        }),
      },
    }),
    extractText: (data) => (data as { choices?: Array<{ message?: { content?: string } }> }).choices?.[0]?.message?.content ?? "",
  },
];

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
  const { provider, modelId } = resolveProvider(model);
  const adapter = adapterFor(provider);
  return withRetry(async (signal) => {
    const apiKey = apiKeyFor(adapter);
    const { url, init } = adapter.buildRequest({ modelId, messages, opts, apiKey, signal });
    const res = await fetch(url, init);
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`${adapter.name} api ${res.status}: ${text}`);
    }
    const data = await res.json();
    return adapter.extractText(data);
  }, opts.timeoutMs ?? 30_000);
}

/** Compatibility wrapper for older single-turn call sites. */
export async function callLlm(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  opts: CallLlmOptions = {},
): Promise<string> {
  return chat(model, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt },
  ], opts);
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

/**
 * Resolve the model id for a tiny one-shot helper call (classifier / screener).
 * Prefers explicit per-task overrides from OPENCODE_MODELS, then the first
 * configured provider in PROVIDERS order. That registry is the single source
 * of precedence (currently anthropic > openai > openrouter).
 */
export function defaultFastModel(taskType?: string): string {
  if (taskType) {
    const override = readOpencodeModelOverride(taskType);
    if (override) return override;
  }
  for (const adapter of PROVIDERS) {
    if (process.env[adapter.envKey]) return adapter.defaultModel;
  }
  // No keys set — fall back to the OpenAI default; chat() will then throw a
  // clear "OPENAI_API_KEY not set" error at call time.
  return adapterFor("openai").defaultModel;
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

export function resolveProvider(model: string): { provider: ProviderName; modelId: string } {
  const slash = model.indexOf("/");
  if (slash > 0) {
    const head = model.slice(0, slash).toLowerCase();
    const tail = model.slice(slash + 1);
    const adapter = PROVIDERS.find((candidate) => candidate.prefix === head);
    if (adapter) return { provider: adapter.name, modelId: tail };
    throw new Error(`llm helper: unsupported provider prefix "${head}" (only "anthropic", "openai", and "openrouter" are supported)`);
  }

  for (const adapter of PROVIDERS) {
    const modelId = adapter.resolveModelId(model);
    if (modelId) return { provider: adapter.name, modelId };
  }

  return { provider: "openai", modelId: model };
}

function adapterFor(provider: ProviderName): ProviderAdapter {
  const adapter = PROVIDERS.find((candidate) => candidate.name === provider);
  if (!adapter) throw new Error(`llm helper: unsupported provider "${provider}"`);
  return adapter;
}

function apiKeyFor(adapter: ProviderAdapter): string {
  const apiKey = process.env[adapter.envKey];
  if (!apiKey) throw new Error(`${adapter.envKey} not set`);
  return apiKey;
}

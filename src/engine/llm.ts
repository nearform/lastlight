/**
 * Thin one-shot LLM call used by the prompt-injection screener and the
 * intent classifier. Provider is selected by the model id prefix so
 * callers don't need to wire two different code paths:
 *
 *   "anthropic/claude-…" or unprefixed "claude-…"  →  Anthropic Messages API
 *   "openai/gpt-…"      or unprefixed "gpt-…"     →  OpenAI Chat Completions API
 *
 * Replaces the `@anthropic-ai/claude-agent-sdk` query() this codebase
 * used pre-Phase 7 for these small calls. The whole SDK was overkill for
 * one HTTP round-trip with no tools and no streaming.
 */

export interface CallLlmOptions {
  /** Hard cap on output tokens (default: 256 — these calls are tiny). */
  maxTokens?: number;
  /** Per-call timeout (default: 30s). */
  timeoutMs?: number;
}

/**
 * Make a single-turn LLM call and return the final assistant text.
 *
 * @throws if the relevant API key isn't set or the upstream returns non-2xx
 */
export async function callLlm(
  model: string,
  systemPrompt: string,
  userPrompt: string,
  opts: CallLlmOptions = {},
): Promise<string> {
  const { provider, modelId } = resolveProvider(model);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), opts.timeoutMs ?? 30_000);
  try {
    if (provider === "anthropic") {
      return await callAnthropic(modelId, systemPrompt, userPrompt, opts, ctrl.signal);
    }
    return await callOpenai(modelId, systemPrompt, userPrompt, opts, ctrl.signal);
  } finally {
    clearTimeout(timer);
  }
}

export function resolveProvider(model: string): { provider: "anthropic" | "openai"; modelId: string } {
  const slash = model.indexOf("/");
  if (slash > 0) {
    const head = model.slice(0, slash).toLowerCase();
    const tail = model.slice(slash + 1);
    if (head === "anthropic") return { provider: "anthropic", modelId: tail };
    if (head === "openai") return { provider: "openai", modelId: tail };
  }
  // Unprefixed — guess from common model name shapes.
  const lower = model.toLowerCase();
  if (lower.startsWith("claude")) return { provider: "anthropic", modelId: model };
  return { provider: "openai", modelId: model };
}

async function callAnthropic(
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  opts: CallLlmOptions,
  signal: AbortSignal,
): Promise<string> {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) throw new Error("ANTHROPIC_API_KEY not set");
  const res = await fetch("https://api.anthropic.com/v1/messages", {
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
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`anthropic api ${res.status}: ${text}`);
  }
  const data = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  return (data.content ?? [])
    .filter((c) => c.type === "text" && typeof c.text === "string")
    .map((c) => c.text as string)
    .join("");
}

async function callOpenai(
  modelId: string,
  systemPrompt: string,
  userPrompt: string,
  opts: CallLlmOptions,
  signal: AbortSignal,
): Promise<string> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY not set");
  const res = await fetch("https://api.openai.com/v1/chat/completions", {
    method: "POST",
    signal,
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: opts.maxTokens ?? 256,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`openai api ${res.status}: ${text}`);
  }
  const data = (await res.json()) as {
    choices?: Array<{ message?: { content?: string } }>;
  };
  return data.choices?.[0]?.message?.content ?? "";
}

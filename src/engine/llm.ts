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
  const call = (signal: AbortSignal) =>
    provider === "anthropic"
      ? callAnthropic(modelId, systemPrompt, userPrompt, opts, signal)
      : callOpenai(modelId, systemPrompt, userPrompt, opts, signal);
  return withRetry(call, opts.timeoutMs ?? 30_000);
}

/**
 * Single retry on transient upstream failures. The screener and classifier
 * call this inline on every incoming event, so a single 429/503 from the
 * provider would otherwise silently drop the event and break routing.
 * One retry with a fixed 750ms delay covers the common transient cases at
 * negligible latency. We don't retry 4xx other than 429 — those are real
 * errors (bad model id, malformed request) where retry just hides the bug.
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
  throw new Error("callLlm: retry loop fell through");
}

/**
 * Resolve the model id for a tiny one-shot helper call (classifier / screener).
 * Prefers explicit per-task overrides from OPENCODE_MODELS, then a small model
 * matching whichever provider API key is set — so the helpers work on an
 * OPENAI-only deployment without crashing on a hardcoded Anthropic id.
 */
export function defaultFastModel(taskType?: string): string {
  if (taskType) {
    const override = readOpencodeModelOverride(taskType);
    if (override) return override;
  }
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  const hasOpenai = !!process.env.OPENAI_API_KEY;
  if (hasAnthropic && !hasOpenai) return "anthropic/claude-haiku-4-5-20251001";
  if (hasOpenai && !hasAnthropic) return "openai/gpt-5.4-mini";
  return hasAnthropic ? "anthropic/claude-haiku-4-5-20251001" : "openai/gpt-5.4-mini";
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
      max_completion_tokens: opts.maxTokens ?? 256,
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

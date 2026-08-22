/**
 * One-shot LLM client for the pr-review grader's judge.
 *
 * The rest of the harness grades deterministically; matching a posted review's
 * findings to a semantic gold set (precision/recall) is the ONE place that needs
 * a model. This is a thin, dependency-free client — a direct `fetch` to the
 * provider's chat endpoint, chosen from the model id's `provider/` prefix — so it
 * never pulls the OpenCode/pi runtime into the grade path. Temperature 0 (with a
 * no-temperature retry for reasoning models that reject it) keeps the judge as
 * repeatable as the provider allows.
 *
 * The judge model is scoped to grading only and is independent of the models
 * under test: `EVAL_JUDGE_MODEL` overrides {@link defaultJudgeModel}, which
 * prefers Anthropic > OpenAI > OpenRouter based on which key is present.
 */

interface Provider {
  /** Endpoint URL. */
  url: string;
  /** Auth + version headers. */
  headers: Record<string, string>;
  /** Build the request body for a single system+user turn. */
  body: (model: string, system: string, user: string, temperature?: number) => unknown;
  /** Pull the assistant text out of the response JSON. */
  extract: (json: unknown) => string;
}

/** Strip the `provider/` prefix, leaving the wire model id (keeps any further
 * `/` for openrouter's `vendor/model`). */
function wireModel(id: string): string {
  const i = id.indexOf("/");
  return i >= 0 ? id.slice(i + 1) : id;
}

function openAiCompatible(url: string, apiKey: string): Provider {
  return {
    url,
    headers: { authorization: `Bearer ${apiKey}`, "content-type": "application/json" },
    body: (model, system, user, temperature) => ({
      model,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
      ...(temperature !== undefined ? { temperature } : {}),
      // Reasoning models on OpenAI-compatible endpoints burn their budget on
      // hidden tokens before emitting any content — GLM-5.2 spends ~119 of them
      // answering "reply with exactly: OK". For a judge that must return a small
      // fixed JSON shape that is pure cost, so `EVAL_JUDGE_REASONING_EFFORT=none`
      // turns it off. Unset means "provider default", which is the safe default:
      // a model that does not know the field ignores it, but silently forcing
      // `none` everywhere would change what an existing arm measures.
      ...(process.env.EVAL_JUDGE_REASONING_EFFORT
        ? { reasoning_effort: process.env.EVAL_JUDGE_REASONING_EFFORT }
        : {}),
    }),
    extract: (json) => {
      const j = json as { choices?: { message?: { content?: string } }[] };
      return j.choices?.[0]?.message?.content ?? "";
    },
  };
}

function providerFor(modelId: string): Provider {
  const family = modelId.split("/")[0]?.toLowerCase() ?? "";
  const model = wireModel(modelId);
  if (family === "anthropic") {
    const key = process.env.ANTHROPIC_API_KEY;
    if (!key) throw new Error("judge: ANTHROPIC_API_KEY not set for an anthropic judge model");
    return {
      url: "https://api.anthropic.com/v1/messages",
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json" },
      body: (m, system, user, temperature) => ({
        model,
        max_tokens: 2048,
        system,
        messages: [{ role: "user", content: user }],
        ...(temperature !== undefined ? { temperature } : {}),
      }),
      extract: (json) => {
        const j = json as { content?: { type: string; text?: string }[] };
        return (j.content ?? []).filter((b) => b.type === "text").map((b) => b.text ?? "").join("");
      },
    };
  }
  if (family === "openrouter") {
    const key = process.env.OPENROUTER_API_KEY;
    if (!key) throw new Error("judge: OPENROUTER_API_KEY not set for an openrouter judge model");
    // openrouter keeps the vendor prefix (e.g. `anthropic/claude-...`).
    const or = openAiCompatible("https://openrouter.ai/api/v1/chat/completions", key);
    return { ...or, body: (_m, s, u, t) => or.body(model, s, u, t) };
  }
  if (family === "fireworks") {
    const key = process.env.FIREWORKS_API_KEY;
    if (!key) throw new Error("judge: FIREWORKS_API_KEY not set for a fireworks judge model");
    // Fireworks ids are themselves slash-paths (`accounts/fireworks/models/…`),
    // and `wireModel` only strips up to the FIRST slash — so the remainder is
    // already the wire id. Routers (`…/routers/glm-5p2-fast`) work the same way.
    return openAiCompatible("https://api.fireworks.ai/inference/v1/chat/completions", key);
  }
  if (family === "deepseek") {
    const key = process.env.DEEPSEEK_API_KEY;
    if (!key) throw new Error("judge: DEEPSEEK_API_KEY not set for a deepseek judge model");
    return openAiCompatible("https://api.deepseek.com/chat/completions", key);
  }
  // Default: OpenAI (and openai-compatible ids).
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new Error(`judge: OPENAI_API_KEY not set for judge model "${modelId}"`);
  return openAiCompatible("https://api.openai.com/v1/chat/completions", key);
}

/** Pick a judge model from whichever provider key is present (Anthropic first —
 * Martian's offline judges include Claude). Overridable with EVAL_JUDGE_MODEL. */
export function defaultJudgeModel(): string {
  const override = process.env.EVAL_JUDGE_MODEL?.trim();
  if (override) return override;
  if (process.env.ANTHROPIC_API_KEY) return "anthropic/claude-sonnet-4-6";
  if (process.env.OPENAI_API_KEY) return "openai/gpt-5.5";
  if (process.env.OPENROUTER_API_KEY) return "openrouter/anthropic/claude-sonnet-4.6";
  throw new Error("judge: no provider key set (ANTHROPIC_API_KEY / OPENAI_API_KEY / OPENROUTER_API_KEY)");
}

async function post(provider: Provider, model: string, system: string, user: string, temperature?: number): Promise<string> {
  const res = await fetch(provider.url, {
    method: "POST",
    headers: provider.headers,
    body: JSON.stringify(provider.body(model, system, user, temperature)),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`judge HTTP ${res.status}: ${text.slice(0, 300)}`) as Error & { status?: number };
    err.status = res.status;
    throw err;
  }
  return provider.extract(await res.json());
}

/**
 * One judge turn (system + user) returning the assistant text. Temperature 0,
 * with a single no-temperature retry for reasoning models that 400 on it.
 */
export async function judge(model: string, system: string, user: string): Promise<string> {
  const provider = providerFor(model);
  const wm = wireModel(model);
  try {
    return await post(provider, wm, system, user, 0);
  } catch (err) {
    if ((err as { status?: number }).status === 400) {
      return post(provider, wm, system, user, undefined);
    }
    throw err;
  }
}

/** Parse a JSON object out of a judge reply, tolerating ```json fences and
 * leading/trailing prose. Returns null if nothing parseable is found. */
export function parseJudgeJson<T>(text: string): T | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1] : text;
  // Grab the outermost {...} span.
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  try {
    return JSON.parse(candidate.slice(start, end + 1)) as T;
  } catch {
    return null;
  }
}

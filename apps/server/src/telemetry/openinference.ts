/**
 * OpenInference semantic-convention constants + small mapping helpers.
 *
 * OpenInference (https://github.com/Arize-ai/openinference) is the span vocabulary
 * Arize Phoenix and other LLM-observability backends read to render a run as a
 * proper AGENT → LLM → TOOL tree with per-span tokens and cost. We emit these
 * attributes alongside our own `lastlight.*` labels so a Phoenix trace is useful
 * instead of a flat two-span shape (see issue #224).
 *
 * These keys are deliberately NOT routed through `safeSpanAttributes` — the
 * content scrubber there strips anything matching `token`/`prompt`/`content`,
 * which would silently drop `llm.token_count.*` and the gated `input.value` /
 * `output.value`. Set them via {@link import("./index.js").setSpanAttributes}
 * (a direct `span.setAttribute` path) instead. The numeric/enum attributes are
 * non-sensitive and always safe to set; the free-text ones (`input.value`,
 * `output.value`, `tool_call.function.arguments`, tool results) are content and
 * MUST be gated behind `LASTLIGHT_OTEL_INCLUDE_CONTENT`.
 */

/** `openinference.span.kind` values we emit. */
export const SpanKind = {
  CHAIN: "CHAIN",
  AGENT: "AGENT",
  LLM: "LLM",
  TOOL: "TOOL",
} as const;
export type SpanKindValue = (typeof SpanKind)[keyof typeof SpanKind];

/** OpenInference attribute keys (a subset — the ones we set). */
export const OI = {
  SPAN_KIND: "openinference.span.kind",
  LLM_MODEL_NAME: "llm.model_name",
  LLM_SYSTEM: "llm.system",
  LLM_TOKEN_PROMPT: "llm.token_count.prompt",
  LLM_TOKEN_COMPLETION: "llm.token_count.completion",
  LLM_TOKEN_TOTAL: "llm.token_count.total",
  LLM_COST_TOTAL: "llm.cost.total",
  TOOL_NAME: "tool.name",
  TOOL_CALL_FUNCTION_NAME: "tool_call.function.name",
  TOOL_CALL_FUNCTION_ARGUMENTS: "tool_call.function.arguments",
  TOOL_IS_ERROR: "tool.is_error",
  INPUT_VALUE: "input.value",
  INPUT_MIME_TYPE: "input.mime_type",
  OUTPUT_VALUE: "output.value",
  OUTPUT_MIME_TYPE: "output.mime_type",
} as const;

/**
 * Split a `provider/model` id into its OpenInference `llm.system` (the provider)
 * and `llm.model_name` (the model, provider prefix stripped). Handles the plain
 * `provider/model` form and OpenRouter's `openrouter/<vendor>/<model>` (only the
 * first segment is the system; the rest is the model name).
 */
export function splitProviderModel(model: string | undefined): {
  system?: string;
  modelName?: string;
} {
  if (!model) return {};
  const idx = model.indexOf("/");
  if (idx === -1) return { modelName: model };
  return { system: model.slice(0, idx), modelName: model.slice(idx + 1) };
}

/** Per-message / per-run token usage in agentic-pi's shape. */
export interface TokenUsage {
  input?: number;
  output?: number;
  cacheRead?: number;
  cacheWrite?: number;
  cost?: number;
}

/**
 * Map a {@link TokenUsage} onto OpenInference `llm.token_count.*` + `llm.cost.total`
 * attributes. Prompt tokens fold in cache read/write (they are input the model
 * was billed for); completion is output; total is the sum. Zero/undefined fields
 * are omitted so an unmeasured run doesn't stamp a misleading `0`. Cost is the
 * authoritative per-span figure Phoenix shows (it doesn't have to reprice).
 */
export function llmTokenAttributes(usage: TokenUsage): Record<string, number> {
  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const prompt = num(usage.input) + num(usage.cacheRead) + num(usage.cacheWrite);
  const completion = num(usage.output);
  const total = prompt + completion;
  const out: Record<string, number> = {};
  if (prompt > 0) out[OI.LLM_TOKEN_PROMPT] = prompt;
  if (completion > 0) out[OI.LLM_TOKEN_COMPLETION] = completion;
  if (total > 0) out[OI.LLM_TOKEN_TOTAL] = total;
  if (num(usage.cost) > 0) out[OI.LLM_COST_TOTAL] = num(usage.cost);
  return out;
}

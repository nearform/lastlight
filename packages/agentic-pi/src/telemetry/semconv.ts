/**
 * Centralized OpenTelemetry attribute keys, span names, and metric names.
 *
 * Single source of truth so the still-evolving GenAI semantic conventions
 * (`gen_ai.*`) are pinned in exactly one place. We hand-define the `gen_ai.*`
 * keys as literals rather than importing them from
 * `@opentelemetry/semantic-conventions/incubating`, because that incubating
 * export path is unstable across minor releases — depending on the runtime
 * values, not the package's export surface, keeps us insulated from churn.
 */

/** Stable GenAI semantic-convention attribute keys. */
export const GenAI = {
  SYSTEM: "gen_ai.system",
  OPERATION_NAME: "gen_ai.operation.name",
  CONVERSATION_ID: "gen_ai.conversation.id",
  REQUEST_MODEL: "gen_ai.request.model",
  RESPONSE_MODEL: "gen_ai.response.model",
  RESPONSE_ID: "gen_ai.response.id",
  RESPONSE_FINISH_REASONS: "gen_ai.response.finish_reasons",
  USAGE_INPUT_TOKENS: "gen_ai.usage.input_tokens",
  USAGE_OUTPUT_TOKENS: "gen_ai.usage.output_tokens",
  TOOL_NAME: "gen_ai.tool.name",
  TOOL_CALL_ID: "gen_ai.tool.call.id",
  /** Metric-only dimension: which token bucket a measurement belongs to. */
  TOKEN_TYPE: "gen_ai.token.type",
  /** Content-gated span attributes (only set when includeContent is on). */
  PROMPT: "gen_ai.prompt",
  COMPLETION: "gen_ai.completion",
} as const;

/**
 * agentic-pi-specific attribute keys, namespaced under `agentic_pi.*` to
 * avoid colliding with any future standard key. Used where no stable GenAI
 * equivalent exists yet (cache tokens, cost, tool error/args/result).
 */
export const AgenticPi = {
  CACHE_READ_TOKENS: "agentic_pi.usage.cache_read_tokens",
  CACHE_WRITE_TOKENS: "agentic_pi.usage.cache_write_tokens",
  COST_USD: "agentic_pi.usage.cost_usd",
  TOTAL_TOKENS: "agentic_pi.usage.total_tokens",
  TOOL_IS_ERROR: "agentic_pi.tool.is_error",
  TURN_INDEX: "agentic_pi.turn.index",
  SANDBOX_BACKEND: "agentic_pi.sandbox.backend",
  /** The provider's own stop reason behind the normalised finish reason. */
  RAW_STOP_REASON: "agentic_pi.response.raw_stop_reason",
  /** The provider-native effort level the response actually used. */
  PROVIDER_THINKING_LEVEL: "agentic_pi.response.provider_thinking_level",
  /** Content-gated tool span attributes. */
  TOOL_ARGUMENTS: "agentic_pi.tool.arguments",
  TOOL_RESULT: "agentic_pi.tool.result",
} as const;

/** Metric dimension value for {@link GenAI.TOKEN_TYPE}. */
export const TokenType = {
  INPUT: "input",
  OUTPUT: "output",
  CACHE_READ: "cache_read",
  CACHE_WRITE: "cache_write",
} as const;

/** Span names. Tool/LLM names embed the tool/model per GenAI span-naming guidance. */
export const SpanName = {
  SESSION: "agentic_pi.session",
  TURN: "agentic_pi.turn",
  tool: (toolName: string): string => `execute_tool ${toolName}`,
  llm: (model: string): string => `chat ${model}`,
} as const;

/** Metric instrument names. */
export const MetricName = {
  LLM_TOKENS: "gen_ai.client.token.usage",
  LLM_DURATION: "gen_ai.client.operation.duration",
  COST: "agentic_pi.cost.usd",
  TOOL_DURATION: "agentic_pi.tool.duration",
  TOOL_INVOCATIONS: "agentic_pi.tool.invocations",
  TOOL_FAILURES: "agentic_pi.tool.failures",
  TURNS: "agentic_pi.turns",
} as const;

/** Default OTEL resource service name when neither flag nor env overrides it. */
export const DEFAULT_SERVICE_NAME = "agentic-pi";

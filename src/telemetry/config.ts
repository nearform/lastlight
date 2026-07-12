/**
 * Telemetry enablement + content-gating resolution.
 *
 * Pure and SDK-free on purpose: no `@opentelemetry/*` imports here, so the
 * precedence rules are trivially unit-testable and importing this module
 * costs nothing on the common (telemetry-disabled) path.
 */

/** Inputs the resolver reads off `RunConfig` (kept structural to avoid a cycle). */
export interface TelemetryConfigInput {
  /** Tri-state: true = --otel, false = --no-otel, undefined = env decides. */
  otel?: boolean;
  /** Export raw prompt/message/tool content (bounded). Default false. */
  otelIncludeContent?: boolean;
  /** Override OTEL_SERVICE_NAME. */
  otelServiceName?: string;
  /** Override OTEL_EXPORTER_OTLP_ENDPOINT. */
  otelEndpoint?: string;
}

export type TelemetrySkipReason = "not-enabled" | "disabled-by-flag";

export interface TelemetryConfig {
  enabled: boolean;
  /** Why telemetry is off (only set when `enabled` is false). */
  reason?: TelemetrySkipReason;
  /** Whether raw content may be attached to spans. */
  includeContent: boolean;
  /** Resolved service name (flag > OTEL_SERVICE_NAME > default applied at init). */
  serviceName?: string;
  /** Explicit OTLP endpoint override (flag); env is honored by the SDK directly. */
  endpoint?: string;
}

type Env = Record<string, string | undefined>;

function isTruthy(v: string | undefined): boolean {
  if (v === undefined) return false;
  const s = v.trim().toLowerCase();
  return s === "1" || s === "true" || s === "yes" || s === "on";
}

/**
 * Resolve whether telemetry is enabled and how content is treated.
 *
 * Enablement precedence (highest first):
 *   1. `--no-otel` (otel === false)        → disabled, reason "disabled-by-flag".
 *   2. `--otel` (otel === true)            → enabled.
 *   3. env `AGENTIC_PI_OTEL_ENABLED` truthy → enabled.
 *   4. otherwise                           → disabled, reason "not-enabled".
 *
 * A bare `OTEL_EXPORTER_OTLP_ENDPOINT` does NOT enable telemetry: the spec is
 * "off unless explicitly enabled", and many environments export `OTEL_*`
 * globally. Enablement must be intentional.
 *
 * Content gating: on iff `--otel-include-content` OR env
 * `AGENTIC_PI_OTEL_INCLUDE_CONTENT` is truthy. Default is metadata-only.
 */
export function resolveTelemetryConfig(cfg: TelemetryConfigInput, env: Env): TelemetryConfig {
  const includeContent =
    cfg.otelIncludeContent === true || isTruthy(env.AGENTIC_PI_OTEL_INCLUDE_CONTENT);
  const serviceName = cfg.otelServiceName ?? env.OTEL_SERVICE_NAME;
  const endpoint = cfg.otelEndpoint;

  const base = { includeContent, serviceName, endpoint };

  if (cfg.otel === false) {
    return { ...base, enabled: false, reason: "disabled-by-flag" };
  }
  if (cfg.otel === true || isTruthy(env.AGENTIC_PI_OTEL_ENABLED)) {
    return { ...base, enabled: true };
  }
  return { ...base, enabled: false, reason: "not-enabled" };
}

/** Cap on a single content attribute's length when content export is enabled. */
export const MAX_CONTENT_CHARS = 4096;

/**
 * Render a value for a content-gated span attribute.
 *
 * Returns `undefined` when content export is off (the attribute is then simply
 * never set). When on, stringifies and truncates to {@link MAX_CONTENT_CHARS}
 * with a marker so oversized prompts/results don't bloat OTLP payloads.
 */
export function redact(value: unknown, includeContent: boolean): string | undefined {
  if (!includeContent) return undefined;
  if (value === undefined || value === null) return undefined;
  const str = typeof value === "string" ? value : safeStringify(value);
  if (str.length <= MAX_CONTENT_CHARS) return str;
  return `${str.slice(0, MAX_CONTENT_CHARS)}…[truncated ${str.length - MAX_CONTENT_CHARS} chars]`;
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

import { context, SpanStatusCode, trace, metrics, type Span, type SpanOptions } from "@opentelemetry/api";
import { NodeSDK } from "@opentelemetry/sdk-node";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { resourceFromAttributes } from "@opentelemetry/resources";
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from "@opentelemetry/semantic-conventions";
import type { OtelConfig } from "../config/config.js";
import { OTEL_COLLECTOR_SANDBOX_ENDPOINT } from "../sandbox/egress-firewall-config.js";

export type TelemetryPrimitive = string | number | boolean;
export type TelemetryAttributes = Record<string, unknown>;

export const OTEL_SANDBOX_ENV_ALLOWLIST = [
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
  "OTEL_EXPORTER_OTLP_ENDPOINT",
  "OTEL_EXPORTER_OTLP_TRACES_ENDPOINT",
  "OTEL_EXPORTER_OTLP_METRICS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_LOGS_ENDPOINT",
  "OTEL_EXPORTER_OTLP_PROTOCOL",
  "OTEL_EXPORTER_OTLP_TRACES_PROTOCOL",
  "OTEL_EXPORTER_OTLP_METRICS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_LOGS_PROTOCOL",
  "OTEL_EXPORTER_OTLP_HEADERS",
  "OTEL_EXPORTER_OTLP_TRACES_HEADERS",
  "OTEL_EXPORTER_OTLP_METRICS_HEADERS",
  "OTEL_EXPORTER_OTLP_LOGS_HEADERS",
  "OTEL_ATTRIBUTE_VALUE_LENGTH_LIMIT",
  "OTEL_ATTRIBUTE_COUNT_LIMIT",
  "OTEL_BSP_MAX_QUEUE_SIZE",
  "OTEL_BSP_SCHEDULE_DELAY",
  "OTEL_METRIC_EXPORT_INTERVAL",
] as const;

const METRIC_ATTR_ALLOWLIST = new Set([
  "workflow.name",
  "phase.name",
  "repo",
  "sandbox.backend",
  "model",
  "runtime",
  "surface",
  "success",
  "stop_reason",
  "github.profile",
]);

const EXPLICIT_CONTENT_ATTR_ALLOWLIST = new Set([
  "message.content",
  "tool.result",
  "tool.output",
  "error.stack",
]);

let sdk: NodeSDK | undefined;
let enabled = false;
let includeContent = false;
const tracer = () => trace.getTracer("lastlight");
const meter = () => metrics.getMeter("lastlight");

function primitive(value: unknown): TelemetryPrimitive | undefined {
  if (typeof value === "string") return value.length > 1024 ? value.slice(0, 1021) + "…" : value;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "boolean") return value;
  return undefined;
}

export function isTelemetryEnabled(): boolean {
  return enabled;
}

export function telemetryIncludesContent(): boolean {
  return includeContent;
}

export function safeSpanAttributes(attrs: TelemetryAttributes = {}): Record<string, TelemetryPrimitive> {
  const out: Record<string, TelemetryPrimitive> = {};
  for (const [key, value] of Object.entries(attrs)) {
    const explicitlyAllowedContent = EXPLICIT_CONTENT_ATTR_ALLOWLIST.has(key);
    if (!explicitlyAllowedContent && (/prompt|body|stack|secret|token|headers?/i.test(key) || /(^|\.)content$/i.test(key))) continue;
    const p = primitive(value);
    if (p !== undefined) out[key] = p;
  }
  return out;
}

export function safeMetricAttributes(attrs: TelemetryAttributes = {}): Record<string, TelemetryPrimitive> {
  const out: Record<string, TelemetryPrimitive> = {};
  for (const [key, value] of Object.entries(attrs)) {
    if (!METRIC_ATTR_ALLOWLIST.has(key)) continue;
    const p = primitive(value);
    if (p !== undefined) out[key] = p;
  }
  return out;
}

export async function initTelemetry(config: OtelConfig, opts: { packageVersion?: string } = {}): Promise<void> {
  enabled = false;
  includeContent = config.includeContent === true;
  if (!config.enabled) return;
  try {
    if (!process.env.OTEL_SERVICE_NAME) process.env.OTEL_SERVICE_NAME = config.serviceName;
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.serviceName,
      ...(opts.packageVersion ? { [ATTR_SERVICE_VERSION]: opts.packageVersion } : {}),
    });
    sdk = new NodeSDK({
      resource,
      traceExporter: new OTLPTraceExporter(),
      metricReader: new PeriodicExportingMetricReader({ exporter: new OTLPMetricExporter() }),
    });
    await sdk.start();
    enabled = true;
  } catch (err) {
    sdk = undefined;
    enabled = false;
    const msg = err instanceof Error ? err.message : String(err);
    if (config.strict) throw err;
    console.warn(`[otel] initialization failed; continuing without telemetry: ${msg}`);
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (!sdk) return;
  const active = sdk;
  sdk = undefined;
  enabled = false;
  await active.shutdown().catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[otel] shutdown failed: ${msg}`);
  });
}

export async function withSpan<T>(name: string, attrs: TelemetryAttributes, fn: (span: Span | undefined) => Promise<T> | T): Promise<T> {
  if (!enabled) return await fn(undefined);
  const spanOptions: SpanOptions = { attributes: safeSpanAttributes(attrs) };
  const span = tracer().startSpan(name, spanOptions);
  return await context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn(span);
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.recordException(err as Error);
      span.setStatus({ code: SpanStatusCode.ERROR, message: err instanceof Error ? err.message : String(err) });
      throw err;
    } finally {
      span.end();
    }
  });
}

export function recordExecutionMetrics(surface: "workflow" | "phase" | "agent" | "chat", attrs: TelemetryAttributes = {}): void {
  if (!enabled) return;
  const metricAttrs = safeMetricAttributes({ ...attrs, surface });
  const m = meter();
  const durationMs = typeof attrs.durationMs === "number" ? attrs.durationMs : undefined;
  const costUsd = typeof attrs.costUsd === "number" ? attrs.costUsd : undefined;
  const inputTokens = typeof attrs.inputTokens === "number" ? attrs.inputTokens : undefined;
  const outputTokens = typeof attrs.outputTokens === "number" ? attrs.outputTokens : undefined;
  if (durationMs !== undefined) m.createHistogram("lastlight.execution.duration_ms").record(durationMs, metricAttrs);
  if (costUsd !== undefined) m.createCounter("lastlight.execution.cost_usd").add(costUsd, metricAttrs);
  if (inputTokens !== undefined) m.createCounter("lastlight.execution.input_tokens").add(inputTokens, metricAttrs);
  if (outputTokens !== undefined) m.createCounter("lastlight.execution.output_tokens").add(outputTokens, metricAttrs);
  m.createCounter("lastlight.execution.count").add(1, metricAttrs);
}

export function recordWorkflowRunStart(attrs: TelemetryAttributes = {}): void {
  if (enabled) meter().createCounter("lastlight.workflow.run.started").add(1, safeMetricAttributes({ ...attrs, surface: "workflow" }));
}

export function recordWorkflowRunEnd(attrs: TelemetryAttributes = {}): void {
  recordExecutionMetrics("workflow", attrs);
}

export function recordError(surface: string, error: unknown, attrs: TelemetryAttributes = {}): void {
  if (!enabled) return;
  const span = trace.getActiveSpan();
  const errAttrs = safeSpanAttributes({ ...attrs, surface, "error.message": error instanceof Error ? error.message : String(error), "error.name": error instanceof Error ? error.name : "Error" });
  span?.addEvent("lastlight.error", errAttrs);
  span?.setStatus({ code: SpanStatusCode.ERROR, message: errAttrs["error.message"] as string | undefined });
  meter().createCounter("lastlight.errors").add(1, safeMetricAttributes({ ...attrs, surface }));
}

/**
 * Safe, non-secret OTEL descriptors passed through to a sandbox alongside
 * the collector endpoint — span/resource labels only, never headers or the
 * real backend endpoint.
 */
const OTEL_SANDBOX_LABEL_ENV = [
  "OTEL_SERVICE_NAME",
  "OTEL_RESOURCE_ATTRIBUTES",
  "OTEL_TRACES_EXPORTER",
  "OTEL_METRICS_EXPORTER",
  "OTEL_LOGS_EXPORTER",
] as const;

/**
 * OTEL env for the **docker** backend, where pi-coding-agent runs *inside*
 * the container. The sandbox is pointed at the in-network collector by its
 * static IP — it never learns the real backend endpoint or its auth
 * headers (those stay host-side on the collector). Reached directly by IP
 * on `sandbox-egress`, so it traverses neither the SNI firewall nor DNS,
 * and works identically in strict and unrestricted-egress phases.
 */
export function getDockerSandboxOtelEnv(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {
    OTEL_EXPORTER_OTLP_ENDPOINT: OTEL_COLLECTOR_SANDBOX_ENDPOINT,
    OTEL_EXPORTER_OTLP_PROTOCOL: "http/protobuf",
  };
  for (const key of OTEL_SANDBOX_LABEL_ENV) {
    const value = env[key];
    if (value && !/[\r\n']/.test(value)) out[key] = value;
  }
  return out;
}

/**
 * OTEL env for the **in-process** backends (gondolin / none), where
 * pi-coding-agent runs in the harness process rather than a container —
 * its own telemetry already inherits the harness SDK. This forwards the
 * host's OTEL_* config into the sandbox shell env for child processes the
 * agent spawns. There is no in-network collector reachable from a gondolin
 * VM, so the real endpoint/headers are forwarded directly; unsafe values
 * (newline / single-quote, which would break downstream shell quoting) are
 * dropped with a warning rather than forwarded.
 */
export function getOtelEnvForSandbox(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of OTEL_SANDBOX_ENV_ALLOWLIST) {
    const value = env[key];
    if (!value) continue;
    // The docker backend shell-quotes each value as `KEY='value'` when
    // building `--sandbox-env`, so a newline or single-quote in the value
    // would break the wrap and make docker.ts throw — aborting the whole
    // agent run. Drop the unsafe value here (with a warning) instead, so
    // telemetry forwarding degrades gracefully rather than taking the run
    // down with it. OTLP header values legitimately almost never contain a
    // single quote; when they do, the operator gets a clear log line.
    if (/[\r\n']/.test(value)) {
      console.warn(`[otel] not forwarding ${key}: value contains a newline or single quote`);
      continue;
    }
    out[key] = value;
  }
  return out;
}

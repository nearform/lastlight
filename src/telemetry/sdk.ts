/**
 * OpenTelemetry SDK construction. Imported dynamically (only on the enabled
 * path) so the heavy `@opentelemetry/sdk-*` packages stay off the default
 * code path.
 *
 * Diagnostics from the SDK and OTLP exporters are routed to `onWarn` via a
 * custom `DiagLogger` that NEVER touches the console — this, plus using the
 * granular SDK packages (not `@opentelemetry/sdk-node`, whose auto-config can
 * log to stdout), is what keeps the `run()` no-stdout contract intact even
 * when the collector is unreachable.
 */

import {
  DiagLogLevel,
  ROOT_CONTEXT,
  defaultTextMapGetter,
  diag,
  type Context,
  type DiagLogger,
} from "@opentelemetry/api";
import { W3CTraceContextPropagator } from "@opentelemetry/core";
import {
  defaultResource,
  detectResources,
  envDetector,
  resourceFromAttributes,
} from "@opentelemetry/resources";
import { BatchSpanProcessor } from "@opentelemetry/sdk-trace-base";
import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import { MeterProvider, PeriodicExportingMetricReader } from "@opentelemetry/sdk-metrics";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";

import type { CreateTelemetryDeps, TelemetryHandle } from "./index.js";
import { SpanMapper } from "./mapper.js";
import { DEFAULT_SERVICE_NAME, GenAI } from "./semconv.js";

const SHUTDOWN_TIMEOUT_MS = 5000;
const INSTRUMENTATION_SCOPE = "agentic-pi";

/** Route SDK/exporter diagnostics to onWarn — never to the console. */
class OnWarnDiagLogger implements DiagLogger {
  constructor(private readonly onWarn: (message: string) => void) {}
  error(message: string): void {
    this.onWarn(`otel: ${message}`);
  }
  warn(message: string): void {
    this.onWarn(`otel: ${message}`);
  }
  info(): void {}
  debug(): void {}
  verbose(): void {}
}

export function startTelemetrySdk(deps: CreateTelemetryDeps): TelemetryHandle {
  const env = deps.env ?? process.env;
  const onWarn = deps.onWarn;
  diag.setLogger(new OnWarnDiagLogger(onWarn), DiagLogLevel.WARN);

  const { provider, modelId } = splitModel(deps.model);
  const serviceName = deps.config.serviceName ?? DEFAULT_SERVICE_NAME;

  if (!hasOtlpTarget(env, deps.config.endpoint)) {
    onWarn(
      "telemetry: enabled but no OTLP endpoint configured (set OTEL_EXPORTER_OTLP_ENDPOINT or --otel-endpoint); spans/metrics will not be exported",
    );
  }

  const resource = defaultResource()
    .merge(detectResources({ detectors: [envDetector] }))
    .merge(
      resourceFromAttributes({
        "service.name": serviceName,
        [GenAI.SYSTEM]: provider,
      }),
    );

  const traceUrl = signalUrl(deps.config.endpoint, "v1/traces");
  const metricUrl = signalUrl(deps.config.endpoint, "v1/metrics");

  const tracerProvider = new NodeTracerProvider({
    resource,
    spanProcessors:
      env.OTEL_TRACES_EXPORTER === "none"
        ? []
        : [new BatchSpanProcessor(new OTLPTraceExporter(traceUrl ? { url: traceUrl } : {}))],
  });

  const meterProvider = new MeterProvider({
    resource,
    readers:
      env.OTEL_METRICS_EXPORTER === "none"
        ? []
        : [
            new PeriodicExportingMetricReader({
              exporter: new OTLPMetricExporter(metricUrl ? { url: metricUrl } : {}),
            }),
          ],
  });

  // We deliberately do NOT register these providers globally: agentic-pi may
  // run multiple sessions in-process (library mode), and a global install
  // would leak state across runs. Spans are created from this tracer with
  // explicit parent contexts instead.
  const tracer = tracerProvider.getTracer(INSTRUMENTATION_SCOPE);
  const meter = meterProvider.getMeter(INSTRUMENTATION_SCOPE);

  const rootParentContext = resolveInboundContext(env);

  const mapper = new SpanMapper({
    tracer,
    meter,
    rootParentContext,
    sessionId: deps.sessionId,
    genAiSystem: provider,
    requestModel: modelId,
    sandboxBackend: deps.sandboxBackend,
    includeContent: deps.config.includeContent,
    onWarn,
  });

  return {
    status: "configured",
    onEvent: (event) => mapper.onEvent(event),
    recordSessionStats: (stats) => mapper.recordSessionStats(stats),
    recordFatal: (err) => mapper.recordFatal(err),
    shutdown: async () => {
      mapper.end();
      await withTimeout(
        Promise.allSettled([tracerProvider.shutdown(), meterProvider.shutdown()]),
        SHUTDOWN_TIMEOUT_MS,
        onWarn,
      );
      diag.disable();
    },
  };
}

function resolveInboundContext(env: Record<string, string | undefined>): Context {
  const traceparent = env.TRACEPARENT;
  if (!traceparent) return ROOT_CONTEXT;
  const carrier: Record<string, string> = { traceparent };
  if (env.TRACESTATE) carrier.tracestate = env.TRACESTATE;
  return new W3CTraceContextPropagator().extract(ROOT_CONTEXT, carrier, defaultTextMapGetter);
}

function splitModel(spec: string): { provider: string; modelId: string } {
  const i = spec.indexOf("/");
  if (i < 0) return { provider: "unknown", modelId: spec };
  return { provider: spec.slice(0, i), modelId: spec.slice(i + 1) };
}

function hasOtlpTarget(env: Record<string, string | undefined>, endpoint?: string): boolean {
  return Boolean(
    endpoint ||
      env.OTEL_EXPORTER_OTLP_ENDPOINT ||
      env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT ||
      env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
  );
}

/** Build a per-signal URL from the --otel-endpoint base (env is handled by the exporter). */
function signalUrl(base: string | undefined, suffix: string): string | undefined {
  if (!base) return undefined;
  return `${base.replace(/\/+$/, "")}/${suffix}`;
}

async function withTimeout(
  promise: Promise<unknown>,
  ms: number,
  onWarn: (message: string) => void,
): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      onWarn(`telemetry: exporter flush timed out after ${ms}ms; proceeding`);
      resolve();
    }, ms);
    timer.unref?.();
  });
  try {
    await Promise.race([promise.then(() => undefined), timeout]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

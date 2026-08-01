import pino from "pino";
import { trace, isSpanContextValid } from "@opentelemetry/api";
import type { LoggerPort } from "lastlight-workflow-engine";

// Accepted LOG_LEVEL values mirror LoggerPort's methods exactly — no `trace`,
// since the port exposes no `.trace()` and nothing can emit at that level.
const LEVELS = ["debug", "info", "warn", "error", "fatal"] as const;

export function resolveLevel(): string {
  const raw = process.env.LOG_LEVEL?.toLowerCase();
  return raw && (LEVELS as readonly string[]).includes(raw) ? raw : "info";
}

export function resolvePretty(): boolean {
  const fmt = process.env.LOG_FORMAT?.toLowerCase();
  if (fmt === "pretty") return true;
  if (fmt === "json") return false;
  return process.stderr.isTTY === true;
}

export function wrap(p: pino.Logger): LoggerPort {
  return {
    debug: (msg, fields) => (fields ? p.debug(fields, msg) : p.debug(msg)),
    info: (msg, fields) => (fields ? p.info(fields, msg) : p.info(msg)),
    warn: (msg, fields) => (fields ? p.warn(fields, msg) : p.warn(msg)),
    error: (msg, fields) => (fields ? p.error(fields, msg) : p.error(msg)),
    fatal: (msg, fields) => (fields ? p.fatal(fields, msg) : p.fatal(msg)),
    child: (component) => wrap(p.child({ component })),
  };
}

export function traceFields(): Record<string, string> {
  const span = trace.getActiveSpan();
  if (!span) return {};
  const ctx = span.spanContext();
  if (!isSpanContextValid(ctx)) return {};
  return { trace_id: ctx.traceId, span_id: ctx.spanId };
}

function createRootPino(): pino.Logger {
  const options: pino.LoggerOptions = {
    level: resolveLevel(),
    base: undefined, // no pid/hostname — the pod is the identity
    timestamp: pino.stdTimeFunctions.isoTime,
    formatters: { level: (label) => ({ level: label }) },
    serializers: { err: pino.stdSerializers.err },
    mixin: traceFields, // stamp trace_id/span_id when a span is active
    messageKey: "msg",
  };
  return resolvePretty()
    ? pino({ ...options, transport: { target: "pino-pretty", options: { destination: 2 } } })
    : pino(options, pino.destination(2));
}

const rootLogger = wrap(createRootPino());

export function logger(component: string): LoggerPort {
  return rootLogger.child(component);
}

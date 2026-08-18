import { describe, it, expect, afterEach, beforeAll, afterAll } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";
import { context, trace, INVALID_SPANID, INVALID_TRACEID, TraceFlags } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { BasicTracerProvider } from "@opentelemetry/sdk-trace-base";
import { wrap, resolveLevel, resolvePretty, traceFields } from "#src/logging/logger.js";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

afterEach(() => {
  delete process.env.LOG_LEVEL;
  delete process.env.LOG_FORMAT;
});

describe("wrap → Vector contract", () => {
  it("emits a string level, component, and msg that JSON-parses", () => {
    const { lines, stream } = capture();
    const base = pino(
      {
        base: undefined,
        timestamp: pino.stdTimeFunctions.isoTime,
        formatters: { level: (label) => ({ level: label }) },
        messageKey: "msg",
      },
      stream,
    );
    wrap(base).child("cron").info("scheduled review discovery");
    const rec = JSON.parse(lines[0]!);
    expect(rec.level).toBe("info"); // string, not pino's integer 30
    expect(rec.component).toBe("cron");
    expect(rec.msg).toBe("scheduled review discovery");
    // the exact vocabulary flux-homelab vector.yaml pod_level matches:
    expect(["trace", "debug", "info", "warn", "error", "fatal", "critical"]).toContain(rec.level);
  });

  it("serialises err to {message, stack} on one line", () => {
    const { lines, stream } = capture();
    const base = pino({ serializers: { err: pino.stdSerializers.err }, messageKey: "msg" }, stream);
    wrap(base).error("pod failed to start", { err: new Error("ImagePullBackOff") });
    expect(lines).toHaveLength(1); // stack is inside the record, not extra lines
    const rec = JSON.parse(lines[0]!);
    expect(rec.err.message).toBe("ImagePullBackOff");
    expect(rec.err.stack).toContain("ImagePullBackOff");
  });
});

describe("env resolution", () => {
  it("defaults to info and rejects unknown levels", () => {
    expect(resolveLevel()).toBe("info");
    process.env.LOG_LEVEL = "nonsense";
    expect(resolveLevel()).toBe("info");
    process.env.LOG_LEVEL = "debug";
    expect(resolveLevel()).toBe("debug");
    // trace is not a supported level (LoggerPort has no .trace) → falls back to info
    process.env.LOG_LEVEL = "trace";
    expect(resolveLevel()).toBe("info");
  });

  it("LOG_FORMAT overrides TTY auto-detection", () => {
    process.env.LOG_FORMAT = "pretty";
    expect(resolvePretty()).toBe(true);
    process.env.LOG_FORMAT = "json";
    expect(resolvePretty()).toBe(false);
  });
});

describe("trace correlation (traceFields)", () => {
  let provider: BasicTracerProvider;

  beforeAll(() => {
    // enable async-context propagation so getActiveSpan() sees the active span.
    // setGlobalContextManager only takes on the first call in a process; if it
    // returns false because something already set one, propagation still works.
    context.setGlobalContextManager(new AsyncLocalStorageContextManager().enable());
    provider = new BasicTracerProvider();
  });

  afterAll(() => {
    context.disable();
  });

  it("returns {} when no span is active", () => {
    expect(traceFields()).toEqual({});
  });

  it("stamps trace_id/span_id from a valid active span", () => {
    provider.getTracer("test").startActiveSpan("s", (span) => {
      const f = traceFields();
      expect(f.trace_id).toBe(span.spanContext().traceId);
      expect(f.span_id).toBe(span.spanContext().spanId);
      expect(f.trace_id).toMatch(/^[0-9a-f]{32}$/);
      expect(f.span_id).toMatch(/^[0-9a-f]{16}$/);
      span.end();
    });
  });

  it("emits nothing for an active but invalid span context", () => {
    const invalid = trace.wrapSpanContext({
      traceId: INVALID_TRACEID,
      spanId: INVALID_SPANID,
      traceFlags: TraceFlags.NONE,
    });
    context.with(trace.setSpan(context.active(), invalid), () => {
      expect(traceFields()).toEqual({});
    });
  });
});

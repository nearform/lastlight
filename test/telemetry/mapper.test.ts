import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { ROOT_CONTEXT } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import {
  AggregationTemporality,
  InMemoryMetricExporter,
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { SpanMapper } from "../../src/telemetry/mapper.js";

/** Build a mapper backed by in-memory exporters + a deterministic clock. */
function makeHarness(includeContent = false) {
  const spanExporter = new InMemorySpanExporter();
  const tracerProvider = new BasicTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(spanExporter)],
  });
  const tracer = tracerProvider.getTracer("test");

  const metricExporter = new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE);
  const metricReader = new PeriodicExportingMetricReader({
    exporter: metricExporter,
    exportIntervalMillis: 2 ** 31 - 1,
  });
  const meterProvider = new MeterProvider({ readers: [metricReader] });
  const meter = meterProvider.getMeter("test");

  let clock = 1000;
  const mapper = new SpanMapper({
    tracer,
    meter,
    rootParentContext: ROOT_CONTEXT,
    sessionId: "sess-123",
    genAiSystem: "openai",
    requestModel: "gpt-5.4-nano",
    sandboxBackend: "none",
    includeContent,
    onWarn: () => undefined,
    now: () => (clock += 10),
  });

  return { mapper, spanExporter, metricExporter, meterProvider };
}

const SAMPLE: AgentSessionEvent[] = [
  { type: "agent_start" },
  { type: "turn_start" },
  {
    type: "message_start",
    message: { role: "assistant", model: "gpt-5.4-nano", provider: "openai" },
  },
  {
    type: "message_end",
    message: {
      role: "assistant",
      model: "gpt-5.4-nano",
      provider: "openai",
      responseModel: "gpt-5.4-nano-2026",
      responseId: "resp_42",
      stopReason: "toolUse",
      usage: {
        input: 100,
        output: 20,
        cacheRead: 5,
        cacheWrite: 0,
        totalTokens: 125,
        cost: { total: 0.0012 },
      },
      content: [{ type: "text", text: "thinking out loud" }],
    },
  },
  {
    type: "tool_execution_start",
    toolCallId: "tc1",
    toolName: "bash",
    args: { command: "ls -la" },
  },
  {
    type: "tool_execution_end",
    toolCallId: "tc1",
    toolName: "bash",
    result: { output: "file.txt" },
    isError: false,
  },
  { type: "turn_end" },
  { type: "agent_end", messages: [] },
  // deliberately cast — tests feed structural events through the public type.
] as unknown as AgentSessionEvent[];

function byName(spans: ReadableSpan[], name: string): ReadableSpan {
  const s = spans.find((sp) => sp.name === name);
  assert.ok(s, `expected a span named ${name}; got ${spans.map((x) => x.name).join(", ")}`);
  return s!;
}

/** Feed events then close out, mirroring the runner's shutdown → mapper.end(). */
function feed(mapper: SpanMapper, events: AgentSessionEvent[]): void {
  for (const e of events) mapper.onEvent(e);
  mapper.end();
}

describe("SpanMapper — span tree", () => {
  test("builds session → turn → {llm, tool} with correct parenting", () => {
    const { mapper, spanExporter } = makeHarness();
    feed(mapper, SAMPLE);

    const spans = spanExporter.getFinishedSpans();
    assert.equal(spans.length, 4);

    const session = byName(spans, "agentic_pi.session");
    const turn = byName(spans, "agentic_pi.turn");
    const llm = byName(spans, "chat gpt-5.4-nano");
    const tool = byName(spans, "execute_tool bash");

    assert.equal(session.parentSpanContext, undefined, "session is the root");
    assert.equal(turn.parentSpanContext?.spanId, session.spanContext().spanId);
    assert.equal(llm.parentSpanContext?.spanId, turn.spanContext().spanId);
    assert.equal(tool.parentSpanContext?.spanId, turn.spanContext().spanId);
    // Same trace throughout.
    assert.equal(turn.spanContext().traceId, session.spanContext().traceId);
    assert.equal(tool.spanContext().traceId, session.spanContext().traceId);
  });

  test("session + llm + tool carry the expected metadata attributes", () => {
    const { mapper, spanExporter } = makeHarness();
    feed(mapper, SAMPLE);
    const spans = spanExporter.getFinishedSpans();

    const session = byName(spans, "agentic_pi.session");
    assert.equal(session.attributes["gen_ai.conversation.id"], "sess-123");
    assert.equal(session.attributes["gen_ai.system"], "openai");
    assert.equal(session.attributes["gen_ai.request.model"], "gpt-5.4-nano");
    assert.equal(session.attributes["agentic_pi.sandbox.backend"], "none");

    const llm = byName(spans, "chat gpt-5.4-nano");
    assert.equal(llm.attributes["gen_ai.usage.input_tokens"], 100);
    assert.equal(llm.attributes["gen_ai.usage.output_tokens"], 20);
    assert.equal(llm.attributes["agentic_pi.usage.cache_read_tokens"], 5);
    assert.equal(llm.attributes["agentic_pi.usage.cost_usd"], 0.0012);
    assert.equal(llm.attributes["gen_ai.response.id"], "resp_42");
    assert.equal(llm.attributes["gen_ai.response.model"], "gpt-5.4-nano-2026");
    assert.deepEqual(llm.attributes["gen_ai.response.finish_reasons"], ["toolUse"]);

    const tool = byName(spans, "execute_tool bash");
    assert.equal(tool.attributes["gen_ai.tool.name"], "bash");
    assert.equal(tool.attributes["gen_ai.tool.call.id"], "tc1");
    assert.equal(tool.attributes["agentic_pi.tool.is_error"], false);
  });

  test("content attributes are absent when includeContent is off", () => {
    const { mapper, spanExporter } = makeHarness(false);
    feed(mapper, SAMPLE);
    const spans = spanExporter.getFinishedSpans();

    const llm = byName(spans, "chat gpt-5.4-nano");
    const tool = byName(spans, "execute_tool bash");
    assert.equal(llm.attributes["gen_ai.completion"], undefined);
    assert.equal(tool.attributes["agentic_pi.tool.arguments"], undefined);
    assert.equal(tool.attributes["agentic_pi.tool.result"], undefined);
  });

  test("content attributes are present (and bounded) when includeContent is on", () => {
    const { mapper, spanExporter } = makeHarness(true);
    feed(mapper, SAMPLE);
    const spans = spanExporter.getFinishedSpans();

    const llm = byName(spans, "chat gpt-5.4-nano");
    const tool = byName(spans, "execute_tool bash");
    assert.equal(llm.attributes["gen_ai.completion"], "thinking out loud");
    assert.match(String(tool.attributes["agentic_pi.tool.arguments"]), /ls -la/);
    assert.match(String(tool.attributes["agentic_pi.tool.result"]), /file\.txt/);
  });

  test("recordSessionStats decorates the still-open root after agent_end", () => {
    // Mirrors the runner: agent_end fires during prompt(); getSessionStats()
    // (→ recordSessionStats) runs after, before shutdown. The root must still
    // be open to receive the aggregate totals.
    const { mapper, spanExporter } = makeHarness();
    for (const e of SAMPLE) mapper.onEvent(e);
    mapper.recordSessionStats({ tokens: { input: 100, output: 20, total: 125 }, cost: 0.0012 });
    mapper.end();

    const session = byName(spanExporter.getFinishedSpans(), "agentic_pi.session");
    assert.equal(session.attributes["agentic_pi.usage.cost_usd"], 0.0012);
    assert.equal(session.attributes["agentic_pi.usage.total_tokens"], 125);
    assert.equal(session.status.code, 1 /* SpanStatusCode.OK from agent_end */);
  });

  test("tool error sets ERROR status and records a failure", () => {
    const { mapper, spanExporter } = makeHarness();
    const events: AgentSessionEvent[] = [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "tool_execution_start", toolCallId: "x", toolName: "bash", args: {} },
      { type: "tool_execution_end", toolCallId: "x", toolName: "bash", result: {}, isError: true },
      { type: "turn_end" },
      { type: "agent_end", messages: [] },
    ] as unknown as AgentSessionEvent[];
    for (const e of events) mapper.onEvent(e);

    const tool = byName(spanExporter.getFinishedSpans(), "execute_tool bash");
    assert.equal(tool.attributes["agentic_pi.tool.is_error"], true);
    assert.equal(tool.status.code, 2 /* SpanStatusCode.ERROR */);
  });

  test("end() defensively closes dangling spans without agent_end", () => {
    const { mapper, spanExporter } = makeHarness();
    const events: AgentSessionEvent[] = [
      { type: "agent_start" },
      { type: "turn_start" },
      { type: "tool_execution_start", toolCallId: "y", toolName: "read", args: {} },
    ] as unknown as AgentSessionEvent[];
    for (const e of events) mapper.onEvent(e);
    mapper.end();

    const names = spanExporter.getFinishedSpans().map((s) => s.name);
    assert.ok(names.includes("agentic_pi.session"));
    assert.ok(names.includes("agentic_pi.turn"));
    assert.ok(names.includes("execute_tool read"));
  });
});

describe("SpanMapper — metrics", () => {
  test("records token, tool, and turn instruments from per-event data", async () => {
    const { mapper, metricExporter, meterProvider } = makeHarness();
    feed(mapper, SAMPLE);
    await meterProvider.forceFlush();

    const names = new Set<string>();
    for (const rm of metricExporter.getMetrics()) {
      for (const sm of rm.scopeMetrics) {
        for (const m of sm.metrics) names.add(m.descriptor.name);
      }
    }
    assert.ok(names.has("gen_ai.client.token.usage"), "token usage histogram recorded");
    assert.ok(names.has("agentic_pi.tool.invocations"), "tool invocations counter recorded");
    assert.ok(names.has("agentic_pi.turns"), "turns counter recorded");
  });
});

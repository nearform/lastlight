import { afterEach, describe, expect, it, vi } from "vitest";
import { trace, type Span } from "@opentelemetry/api";
import { AgentSpanTree } from "#src/telemetry/pi-events.js";
import {
  OI,
  SpanKind,
  llmTokenAttributes,
  splitProviderModel,
} from "#src/telemetry/openinference.js";

// ── Pure helpers ──────────────────────────────────────────────────────────

describe("splitProviderModel", () => {
  it("splits provider/model into system + model name", () => {
    expect(splitProviderModel("anthropic/claude-sonnet-4-6")).toEqual({
      system: "anthropic",
      modelName: "claude-sonnet-4-6",
    });
  });
  it("keeps the OpenRouter vendor in the model name (only first segment is system)", () => {
    expect(splitProviderModel("openrouter/anthropic/claude-3.5")).toEqual({
      system: "openrouter",
      modelName: "anthropic/claude-3.5",
    });
  });
  it("handles a bare model and undefined", () => {
    expect(splitProviderModel("gpt-5")).toEqual({ modelName: "gpt-5" });
    expect(splitProviderModel(undefined)).toEqual({});
  });
});

describe("llmTokenAttributes", () => {
  it("folds cache tokens into prompt and sums total, omitting zeros", () => {
    expect(
      llmTokenAttributes({ input: 100, output: 20, cacheRead: 5, cacheWrite: 3, cost: 0.01 }),
    ).toEqual({
      [OI.LLM_TOKEN_PROMPT]: 108,
      [OI.LLM_TOKEN_COMPLETION]: 20,
      [OI.LLM_TOKEN_TOTAL]: 128,
      [OI.LLM_COST_TOTAL]: 0.01,
    });
  });
  it("emits nothing for an empty/unmeasured usage", () => {
    expect(llmTokenAttributes({})).toEqual({});
    expect(llmTokenAttributes({ input: 0, output: 0, cost: 0 })).toEqual({});
  });
});

// ── AgentSpanTree (fake tracer/span, no SDK boot) ─────────────────────────

class FakeSpan {
  attributes: Record<string, unknown> = {};
  status?: { code: number; message?: string };
  ended = false;
  constructor(
    public name: string,
    public parent?: FakeSpan,
  ) {}
  setAttribute(k: string, v: unknown): this {
    this.attributes[k] = v;
    return this;
  }
  setAttributes(a: Record<string, unknown>): this {
    Object.assign(this.attributes, a);
    return this;
  }
  setStatus(s: { code: number; message?: string }): this {
    this.status = s;
    return this;
  }
  end(): void {
    this.ended = true;
  }
  spanContext() {
    return { traceId: "t".repeat(32), spanId: "s".repeat(16), traceFlags: 1 };
  }
  isRecording(): boolean {
    return true;
  }
  recordException(): void {}
  updateName(): this {
    return this;
  }
  addEvent(): this {
    return this;
  }
  addLink(): this {
    return this;
  }
  addLinks(): this {
    return this;
  }
}

function installFakeTracer(): { spans: FakeSpan[]; root: FakeSpan } {
  const spans: FakeSpan[] = [];
  const tracer = {
    startSpan(name: string, opts?: { attributes?: Record<string, unknown> }, ctx?: unknown) {
      const parent = ctx ? (trace.getSpan(ctx as never) as unknown as FakeSpan | undefined) : undefined;
      const span = new FakeSpan(name, parent);
      if (opts?.attributes) Object.assign(span.attributes, opts.attributes);
      spans.push(span);
      return span as unknown as Span;
    },
  };
  vi.spyOn(trace, "getTracer").mockReturnValue(tracer as never);
  return { spans, root: new FakeSpan("lastlight.agent.execute") };
}

const usage = { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, cost: { total: 0.02 } };

function assistantMessageEnd(text: string) {
  return {
    type: "message_end",
    message: {
      role: "assistant",
      model: "claude-sonnet-4-6",
      provider: "anthropic",
      content: [{ type: "text", text }],
      usage,
    },
  };
}

describe("AgentSpanTree", () => {
  afterEach(() => vi.restoreAllMocks());

  it("brackets turns into LLM spans and tools into TOOL spans nested under the agent span", () => {
    const { spans, root } = installFakeTracer();
    const tree = new AgentSpanTree({
      parent: root as unknown as Span,
      includeContent: false,
      model: "anthropic/claude-sonnet-4-6",
    });

    tree.feed({ type: "turn_start" });
    tree.feed(assistantMessageEnd("thinking"));
    tree.feed({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "ls" } });
    tree.feed({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false, result: "file.txt" });
    tree.feed({ type: "turn_end" });
    tree.end();

    const llm = spans.find((s) => s.name === "turn 1")!;
    expect(llm).toBeDefined();
    expect(llm.parent).toBe(root);
    expect(llm.attributes[OI.SPAN_KIND]).toBe(SpanKind.LLM);
    expect(llm.attributes[OI.LLM_MODEL_NAME]).toBe("claude-sonnet-4-6");
    expect(llm.attributes[OI.LLM_SYSTEM]).toBe("anthropic");
    expect(llm.attributes[OI.LLM_TOKEN_PROMPT]).toBe(100);
    expect(llm.attributes[OI.LLM_TOKEN_COMPLETION]).toBe(20);
    expect(llm.attributes[OI.LLM_TOKEN_TOTAL]).toBe(120);
    expect(llm.attributes[OI.LLM_COST_TOTAL]).toBe(0.02);
    expect(llm.ended).toBe(true);

    const tool = spans.find((s) => s.name === "bash")!;
    expect(tool).toBeDefined();
    expect(tool.parent).toBe(llm); // nested inside the turn, not the agent span
    expect(tool.attributes[OI.SPAN_KIND]).toBe(SpanKind.TOOL);
    expect(tool.attributes[OI.TOOL_NAME]).toBe("bash");
    expect(tool.attributes[OI.TOOL_CALL_FUNCTION_NAME]).toBe("bash");
    expect(tool.attributes[OI.TOOL_IS_ERROR]).toBe(false);
    expect(tool.ended).toBe(true);
  });

  it("omits content by default and includes it (args + results + text) when opted in", () => {
    // default: no content
    let fake = installFakeTracer();
    let tree = new AgentSpanTree({ parent: fake.root as unknown as Span, includeContent: false, model: "anthropic/x" });
    tree.feed({ type: "turn_start" });
    tree.feed(assistantMessageEnd("hello answer"));
    tree.feed({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "secret" } });
    tree.feed({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false, result: "output" });
    tree.feed({ type: "turn_end" });
    tree.end();
    const serialized = JSON.stringify(fake.spans.map((s) => s.attributes));
    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("output");
    expect(serialized).not.toContain("hello answer");
    vi.restoreAllMocks();

    // opted in: content present
    fake = installFakeTracer();
    tree = new AgentSpanTree({ parent: fake.root as unknown as Span, includeContent: true, model: "anthropic/x" });
    tree.feed({ type: "turn_start" });
    tree.feed(assistantMessageEnd("hello answer"));
    tree.feed({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash", args: { command: "secret" } });
    tree.feed({ type: "tool_execution_end", toolCallId: "c1", toolName: "bash", isError: false, result: "output" });
    tree.feed({ type: "turn_end" });
    tree.end();
    const tool = fake.spans.find((s) => s.name === "bash")!;
    expect(String(tool.attributes[OI.TOOL_CALL_FUNCTION_ARGUMENTS])).toContain("secret");
    expect(String(tool.attributes[OI.OUTPUT_VALUE])).toContain("output");
    const llm = fake.spans.find((s) => s.name === "turn 1")!;
    expect(String(llm.attributes[OI.OUTPUT_VALUE])).toContain("hello answer");
  });

  it("closes a tool span opened when a turn is already ended, and errors mark the span", () => {
    const { spans, root } = installFakeTracer();
    const tree = new AgentSpanTree({ parent: root as unknown as Span, includeContent: false, model: "anthropic/x" });
    // tool with no enclosing turn nests directly under the agent span
    tree.feed({ type: "tool_execution_start", toolCallId: "t1", toolName: "read" });
    tree.feed({ type: "tool_execution_end", toolCallId: "t1", toolName: "read", isError: true });
    tree.end();
    const tool = spans.find((s) => s.name === "read")!;
    expect(tool.parent).toBe(root);
    expect(tool.attributes[OI.TOOL_IS_ERROR]).toBe(true);
    expect(tool.status?.code).toBe(2); // SpanStatusCode.ERROR
  });

  it("is a no-op when there is no parent span (telemetry disabled)", () => {
    const { spans } = installFakeTracer();
    const tree = new AgentSpanTree({ parent: undefined, includeContent: true, model: "anthropic/x" });
    tree.feed({ type: "turn_start" });
    tree.feed({ type: "tool_execution_start", toolCallId: "c1", toolName: "bash" });
    tree.feed({ type: "turn_end" });
    tree.end();
    expect(spans).toHaveLength(0);
  });
});

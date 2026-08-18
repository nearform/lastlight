import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { trace, type Span } from "@opentelemetry/api";

vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

// The enabled/include-content flags are module state set by `initTelemetry`,
// which boots the real NodeSDK. Override just the two predicates so the export
// path can be exercised without an exporter trying to reach a collector.
const flags = vi.hoisted(() => ({ enabled: true, includeContent: false }));
vi.mock("#src/telemetry/index.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/telemetry/index.js")>();
  return {
    ...actual,
    isTelemetryEnabled: () => flags.enabled,
    telemetryIncludesContent: () => flags.includeContent,
  };
});

import { recordFeedbackSignal } from "#src/telemetry/feedback.js";
import { OI, SpanKind } from "#src/telemetry/openinference.js";
import type { FeedbackAnchor, FeedbackSignal } from "#src/state/feedback-store.js";

// Same fake-span harness as tests/telemetry/openinference.test.ts.
class FakeSpan {
  attributes: Record<string, unknown> = {};
  status?: { code: number; message?: string };
  ended = false;
  endTime?: unknown;
  constructor(
    public name: string,
    public parentContext?: { traceId: string; spanId: string; isRemote?: boolean },
    public startTime?: unknown,
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
  end(endTime?: unknown): void {
    this.ended = true;
    this.endTime = endTime;
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

function installFakeTracer(): FakeSpan[] {
  const spans: FakeSpan[] = [];
  const tracer = {
    startSpan(name: string, opts?: { startTime?: unknown }, ctx?: unknown) {
      // The parent arrives as a context built by `trace.setSpanContext`, so the
      // only way to see it is through the API's own getter — exactly how the
      // SDK reads it.
      const parent = ctx ? trace.getSpan(ctx as never)?.spanContext() : undefined;
      const span = new FakeSpan(name, parent as never, opts?.startTime);
      spans.push(span);
      return span as unknown as Span;
    },
  };
  vi.spyOn(trace, "getTracer").mockReturnValue(tracer as never);
  return spans;
}

const RUN_TRACE = "a".repeat(32);
const RUN_SPAN = "b".repeat(16);

const anchor: Pick<FeedbackAnchor, "kind" | "createdAt"> = {
  kind: "issue_comment",
  createdAt: "2026-08-01T10:00:00.000Z",
};

function signal(over: Partial<FeedbackSignal> = {}): FeedbackSignal {
  return {
    id: "sig-1",
    anchorId: "anch-1",
    source: "github",
    workflowRunId: "run-1",
    workflowName: "pr-review",
    messagingSessionId: null,
    owner: "nearform",
    repo: "lastlight",
    issueNumber: 255,
    emoji: "+1",
    score: 1,
    sentiment: "good",
    reactor: "cliftonc",
    reactedAt: "2026-08-02T09:30:00.000Z",
    observedAt: "2026-08-02T09:31:00.000Z",
    removedAt: null,
    exportedAt: null,
    ...over,
  };
}

beforeEach(() => {
  flags.enabled = true;
  flags.includeContent = false;
});
afterEach(() => vi.restoreAllMocks());

describe("recordFeedbackSignal", () => {
  it("joins the run's ORIGINAL trace as a late child of its run span", () => {
    // The whole point: a 👍 arriving days later must land on the trace it
    // grades, not open a second disconnected one.
    const spans = installFakeTracer();
    recordFeedbackSignal({
      signal: signal(),
      anchor,
      parent: { traceId: RUN_TRACE, spanId: RUN_SPAN },
    });

    expect(spans).toHaveLength(1);
    expect(spans[0]!.name).toBe("lastlight.feedback.signal");
    expect(spans[0]!.parentContext).toMatchObject({
      traceId: RUN_TRACE,
      spanId: RUN_SPAN,
      isRemote: true,
    });
  });

  it("still exports as a root span when the run recorded no trace", () => {
    const spans = installFakeTracer();
    recordFeedbackSignal({ signal: signal({ workflowRunId: null }), anchor });
    expect(spans).toHaveLength(1);
    expect(spans[0]!.parentContext).toBeUndefined();
  });

  it("carries the OpenInference + Langfuse score vocabulary", () => {
    const spans = installFakeTracer();
    recordFeedbackSignal({
      signal: signal({ emoji: "-1", score: -1, sentiment: "bad" }),
      anchor,
      anchorUrl: "https://github.com/nearform/lastlight/issues/255#issuecomment-1",
    });

    const attrs = spans[0]!.attributes;
    expect(attrs[OI.SPAN_KIND]).toBe(SpanKind.EVALUATOR);
    expect(attrs["feedback.score"]).toBe(-1);
    expect(attrs["feedback.sentiment"]).toBe("bad");
    expect(attrs["feedback.emoji"]).toBe("-1");
    expect(attrs["feedback.source"]).toBe("github");
    expect(attrs["feedback.anchor.kind"]).toBe("issue_comment");
    expect(attrs["feedback.anchor.url"]).toContain("issuecomment-1");
    expect(attrs["workflow.name"]).toBe("pr-review");
    expect(attrs["workflow.run_id"]).toBe("run-1");
    expect(attrs.repo).toBe("nearform/lastlight");
    expect(attrs["langfuse.score.user_feedback"]).toBe(-1);
    expect(attrs["langfuse.score.user_feedback.data_type"]).toBe("NUMERIC");
  });

  it("survives the attribute scrubber that strips token/prompt/content keys", () => {
    // Regression guard: routing these through `safeSpanAttributes` would drop
    // the OpenInference keys silently, which is why the direct path exists.
    const spans = installFakeTracer();
    recordFeedbackSignal({ signal: signal(), anchor });
    expect(Object.keys(spans[0]!.attributes)).toContain(OI.SPAN_KIND);
  });

  it("gates the reactor's identity behind include-content", () => {
    const spans = installFakeTracer();
    recordFeedbackSignal({ signal: signal(), anchor });
    expect(spans[0]!.attributes["feedback.reactor"]).toBeUndefined();

    flags.includeContent = true;
    recordFeedbackSignal({ signal: signal(), anchor });
    expect(spans[1]!.attributes["feedback.reactor"]).toBe("cliftonc");
  });

  it("places the span at the moment of the reaction, with no duration", () => {
    const spans = installFakeTracer();
    recordFeedbackSignal({ signal: signal(), anchor });
    const reactedAt = new Date("2026-08-02T09:30:00.000Z");
    expect(spans[0]!.startTime).toEqual(reactedAt);
    expect(spans[0]!.endTime).toEqual(reactedAt);
    expect(spans[0]!.ended).toBe(true);
  });

  it("does nothing at all when telemetry is disabled", () => {
    flags.enabled = false;
    const spans = installFakeTracer();
    recordFeedbackSignal({ signal: signal(), anchor });
    expect(spans).toHaveLength(0);
  });

  it("never throws when the tracer misbehaves", () => {
    vi.spyOn(trace, "getTracer").mockImplementation(() => {
      throw new Error("exporter exploded");
    });
    expect(() => recordFeedbackSignal({ signal: signal(), anchor })).not.toThrow();
  });
});

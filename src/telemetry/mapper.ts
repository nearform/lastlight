/**
 * Translates Pi's raw session event stream into an OpenTelemetry span tree
 * plus metrics.
 *
 * Span tree (one-shot run → short-lived, so a real root span is correct):
 *
 *   agentic_pi.session                 (root)
 *   └── agentic_pi.turn                 (per turn_start/turn_end)
 *       ├── chat <model>                (per assistant message_start→message_end)
 *       └── execute_tool <name>         (per tool_execution_start→end, keyed by toolCallId)
 *
 * Spans and metrics are both sourced from the SAME per-message / per-tool
 * events (never from the aggregate session stats), so they agree and nothing
 * is double-counted. Aggregate stats only decorate the root span.
 *
 * Every public method is defensive: missing/out-of-order pairs warn once and
 * never throw — a telemetry glitch must never break the run.
 */

import {
  SpanKind,
  SpanStatusCode,
  ValueType,
  trace,
  type Context,
  type Counter,
  type Histogram,
  type Meter,
  type Span,
  type Tracer,
} from "@opentelemetry/api";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";

import { AgenticPi, GenAI, MetricName, SpanName, TokenType } from "./semconv.js";
import { redact } from "./config.js";

/** Structural view of the fields we read off a Pi `AgentMessage`. */
interface MessageLike {
  role?: string;
  content?: unknown;
  provider?: string;
  model?: string;
  responseModel?: string;
  responseId?: string;
  stopReason?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    totalTokens?: number;
    cost?: { total?: number };
  };
}

/** Terminal aggregate stats (subset of Pi's SessionStats) for root decoration. */
export interface SessionStatsLike {
  tokens?: { input?: number; output?: number; total?: number };
  cost?: number;
}

export interface SpanMapperDeps {
  tracer: Tracer;
  meter: Meter;
  /** Inbound parent context (extracted traceparent) or ROOT_CONTEXT. */
  rootParentContext: Context;
  sessionId: string;
  /** gen_ai.system (provider, e.g. "openai"). */
  genAiSystem: string;
  /** gen_ai.request.model (model id, e.g. "gpt-5.4-nano"). */
  requestModel: string;
  sandboxBackend: string;
  includeContent: boolean;
  onWarn: (message: string) => void;
  /** Milliseconds clock seam (tests inject a deterministic one). */
  now?: () => number;
}

interface Instruments {
  tokens: Histogram;
  llmDuration: Histogram;
  cost: Histogram;
  toolDuration: Histogram;
  toolInvocations: Counter;
  toolFailures: Counter;
  turns: Counter;
}

export class SpanMapper {
  private readonly d: SpanMapperDeps;
  private readonly now: () => number;
  private readonly inst: Instruments;

  private rootSpan?: Span;
  private rootCtx!: Context;
  private turnSpan?: Span;
  private turnCtx?: Context;
  private turnIndex = 0;
  private llm?: { span: Span; startMs: number };
  private readonly toolSpans = new Map<string, { span: Span; startMs: number }>();
  private ended = false;
  private warnedUnknownTool = false;

  constructor(deps: SpanMapperDeps) {
    this.d = deps;
    this.now = deps.now ?? (() => Date.now());
    this.inst = this.buildInstruments(deps.meter);
  }

  onEvent(event: AgentSessionEvent): void {
    if (this.ended) return;
    try {
      this.ensureRoot();
      switch (event.type) {
        case "turn_start":
          this.onTurnStart();
          break;
        case "turn_end":
          this.onTurnEnd();
          break;
        case "message_start":
          this.onMessageStart(event.message as MessageLike);
          break;
        case "message_end":
          this.onMessageEnd(event.message as MessageLike);
          break;
        case "tool_execution_start":
          this.onToolStart(event.toolCallId, event.toolName, event.args);
          break;
        case "tool_execution_end":
          this.onToolEnd(event.toolCallId, event.toolName, event.result, event.isError);
          break;
        case "agent_end":
          this.onAgentEnd();
          break;
        default:
          break;
      }
    } catch (err) {
      this.d.onWarn(`telemetry: failed to map ${event.type}: ${(err as Error).message}`);
    }
  }

  /** Decorate the root span with terminal aggregate stats (reconciliation only). */
  recordSessionStats(stats: SessionStatsLike): void {
    if (this.ended) return;
    const root = this.rootSpan;
    if (!root) return;
    if (typeof stats.cost === "number") root.setAttribute(AgenticPi.COST_USD, stats.cost);
    if (typeof stats.tokens?.total === "number") {
      root.setAttribute(AgenticPi.TOTAL_TOKENS, stats.tokens.total);
    }
  }

  /** Mark the root span as errored (called before shutdown on the fatal path). */
  recordFatal(err: Error): void {
    if (this.ended) return;
    this.ensureRoot();
    this.rootSpan?.recordException(err);
    this.rootSpan?.setStatus({ code: SpanStatusCode.ERROR, message: err.message });
  }

  /** Close any still-open spans (ERROR) and end the root. Idempotent. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    const abandon = (s: Span | undefined): void => {
      if (!s) return;
      s.setStatus({ code: SpanStatusCode.ERROR, message: "span not closed before shutdown" });
      s.end();
    };
    for (const { span } of this.toolSpans.values()) abandon(span);
    this.toolSpans.clear();
    abandon(this.llm?.span);
    this.llm = undefined;
    abandon(this.turnSpan);
    this.turnSpan = undefined;
    this.turnCtx = undefined;
    // Root may already carry an OK/ERROR status from agent_end / recordFatal;
    // end() without overriding so a clean run stays clean.
    this.rootSpan?.end();
    this.rootSpan = undefined;
  }

  // ── event handlers ────────────────────────────────────────────────

  private ensureRoot(): void {
    if (this.rootSpan) return;
    this.rootCtx = this.d.rootParentContext;
    this.rootSpan = this.d.tracer.startSpan(
      SpanName.SESSION,
      {
        kind: SpanKind.INTERNAL,
        attributes: {
          [GenAI.CONVERSATION_ID]: this.d.sessionId,
          [GenAI.SYSTEM]: this.d.genAiSystem,
          [GenAI.REQUEST_MODEL]: this.d.requestModel,
          [AgenticPi.SANDBOX_BACKEND]: this.d.sandboxBackend,
        },
      },
      this.rootCtx,
    );
  }

  private parentCtx(): Context {
    return this.turnCtx ?? trace.setSpan(this.rootCtx, this.rootSpan!);
  }

  private onTurnStart(): void {
    if (this.turnSpan) this.abandonTurn();
    const idx = this.turnIndex++;
    const parent = trace.setSpan(this.rootCtx, this.rootSpan!);
    this.turnSpan = this.d.tracer.startSpan(
      SpanName.TURN,
      { kind: SpanKind.INTERNAL, attributes: { [AgenticPi.TURN_INDEX]: idx } },
      parent,
    );
    this.turnCtx = trace.setSpan(parent, this.turnSpan);
    this.inst.turns.add(1);
  }

  private onTurnEnd(): void {
    // Close a dangling LLM span first so it nests inside the turn.
    if (this.llm) {
      this.llm.span.end();
      this.llm = undefined;
    }
    this.turnSpan?.end();
    this.turnSpan = undefined;
    this.turnCtx = undefined;
  }

  private onMessageStart(message: MessageLike): void {
    if (message.role !== "assistant") return;
    const model = message.model ?? this.d.requestModel;
    const span = this.d.tracer.startSpan(
      SpanName.llm(model),
      {
        kind: SpanKind.CLIENT,
        attributes: {
          [GenAI.OPERATION_NAME]: "chat",
          [GenAI.SYSTEM]: message.provider ?? this.d.genAiSystem,
          [GenAI.REQUEST_MODEL]: model,
        },
      },
      this.parentCtx(),
    );
    this.llm = { span, startMs: this.now() };
  }

  private onMessageEnd(message: MessageLike): void {
    if (message.role !== "assistant") return;
    // message_start may have been missed; open a zero-duration span now.
    if (!this.llm) {
      const model = message.model ?? this.d.requestModel;
      this.llm = {
        span: this.d.tracer.startSpan(
          SpanName.llm(model),
          { kind: SpanKind.CLIENT },
          this.parentCtx(),
        ),
        startMs: this.now(),
      };
    }
    const { span, startMs } = this.llm;
    const system = message.provider ?? this.d.genAiSystem;
    const model = message.model ?? this.d.requestModel;
    const usage = message.usage;

    span.setAttribute(GenAI.RESPONSE_MODEL, message.responseModel ?? model);
    if (message.responseId) span.setAttribute(GenAI.RESPONSE_ID, message.responseId);
    if (message.stopReason) span.setAttribute(GenAI.RESPONSE_FINISH_REASONS, [message.stopReason]);

    if (usage) {
      const dims = { [GenAI.SYSTEM]: system, [GenAI.REQUEST_MODEL]: model };
      this.setAndMeasureToken(span, GenAI.USAGE_INPUT_TOKENS, usage.input, TokenType.INPUT, dims);
      this.setAndMeasureToken(
        span,
        GenAI.USAGE_OUTPUT_TOKENS,
        usage.output,
        TokenType.OUTPUT,
        dims,
      );
      this.setAndMeasureToken(
        span,
        AgenticPi.CACHE_READ_TOKENS,
        usage.cacheRead,
        TokenType.CACHE_READ,
        dims,
      );
      this.setAndMeasureToken(
        span,
        AgenticPi.CACHE_WRITE_TOKENS,
        usage.cacheWrite,
        TokenType.CACHE_WRITE,
        dims,
      );
      const cost = usage.cost?.total;
      if (typeof cost === "number") {
        span.setAttribute(AgenticPi.COST_USD, cost);
        this.inst.cost.record(cost, dims);
      }
    }

    const content = redact(this.assistantText(message), this.d.includeContent);
    if (content !== undefined) span.setAttribute(GenAI.COMPLETION, content);

    const durationS = (this.now() - startMs) / 1000;
    this.inst.llmDuration.record(durationS, {
      [GenAI.SYSTEM]: system,
      [GenAI.REQUEST_MODEL]: model,
    });

    span.end();
    this.llm = undefined;
  }

  private onToolStart(toolCallId: string, toolName: string, args: unknown): void {
    const span = this.d.tracer.startSpan(
      SpanName.tool(toolName),
      {
        kind: SpanKind.INTERNAL,
        attributes: { [GenAI.TOOL_NAME]: toolName, [GenAI.TOOL_CALL_ID]: toolCallId },
      },
      this.parentCtx(),
    );
    const argStr = redact(args, this.d.includeContent);
    if (argStr !== undefined) span.setAttribute(AgenticPi.TOOL_ARGUMENTS, argStr);
    this.toolSpans.set(toolCallId, { span, startMs: this.now() });
    this.inst.toolInvocations.add(1, { [GenAI.TOOL_NAME]: toolName });
  }

  private onToolEnd(toolCallId: string, toolName: string, result: unknown, isError: boolean): void {
    let entry = this.toolSpans.get(toolCallId);
    if (!entry) {
      if (!this.warnedUnknownTool) {
        this.warnedUnknownTool = true;
        this.d.onWarn(`telemetry: tool_execution_end for unknown toolCallId ${toolCallId}`);
      }
      entry = {
        span: this.d.tracer.startSpan(
          SpanName.tool(toolName),
          {
            kind: SpanKind.INTERNAL,
            attributes: { [GenAI.TOOL_NAME]: toolName, [GenAI.TOOL_CALL_ID]: toolCallId },
          },
          this.parentCtx(),
        ),
        startMs: this.now(),
      };
    }
    const { span, startMs } = entry;
    span.setAttribute(AgenticPi.TOOL_IS_ERROR, isError);
    const resultStr = redact(result, this.d.includeContent);
    if (resultStr !== undefined) span.setAttribute(AgenticPi.TOOL_RESULT, resultStr);
    if (isError) {
      span.setStatus({ code: SpanStatusCode.ERROR });
      this.inst.toolFailures.add(1, { [GenAI.TOOL_NAME]: toolName });
    }
    this.inst.toolDuration.record((this.now() - startMs) / 1000, { [GenAI.TOOL_NAME]: toolName });
    span.end();
    this.toolSpans.delete(toolCallId);
  }

  private onAgentEnd(): void {
    if (this.llm) {
      this.llm.span.end();
      this.llm = undefined;
    }
    if (this.turnSpan) this.abandonTurn();
    // Mark success but DO NOT end the root span yet: getSessionStats() runs
    // after prompt() returns (i.e. after this event), and recordSessionStats()
    // needs the root span still open to attach aggregate totals. end() — called
    // from shutdown() — closes it, preserving this OK status.
    this.rootSpan?.setStatus({ code: SpanStatusCode.OK });
  }

  // ── helpers ───────────────────────────────────────────────────────

  private setAndMeasureToken(
    span: Span,
    attrKey: string,
    value: number | undefined,
    tokenType: string,
    dims: Record<string, string>,
  ): void {
    if (typeof value !== "number" || value === 0) return;
    span.setAttribute(attrKey, value);
    this.inst.tokens.record(value, { ...dims, [GenAI.TOKEN_TYPE]: tokenType });
  }

  private abandonTurn(): void {
    this.turnSpan?.setStatus({
      code: SpanStatusCode.ERROR,
      message: "turn not closed before next turn_start",
    });
    this.turnSpan?.end();
    this.turnSpan = undefined;
    this.turnCtx = undefined;
  }

  private assistantText(message: MessageLike): string | undefined {
    const content = message.content;
    if (typeof content === "string") return content;
    if (!Array.isArray(content)) return undefined;
    const text = content
      .filter(
        (c): c is { type?: string; text?: string } =>
          typeof c === "object" && c !== null && (c as { type?: string }).type === "text",
      )
      .map((c) => c.text ?? "")
      .join("");
    return text.length > 0 ? text : undefined;
  }

  private buildInstruments(meter: Meter): Instruments {
    return {
      tokens: meter.createHistogram(MetricName.LLM_TOKENS, {
        description: "Number of tokens used per LLM request, by token type.",
        unit: "{token}",
        valueType: ValueType.INT,
      }),
      llmDuration: meter.createHistogram(MetricName.LLM_DURATION, {
        description: "Duration of LLM requests.",
        unit: "s",
        valueType: ValueType.DOUBLE,
      }),
      cost: meter.createHistogram(MetricName.COST, {
        description: "Estimated cost per LLM request in USD.",
        unit: "{usd}",
        valueType: ValueType.DOUBLE,
      }),
      toolDuration: meter.createHistogram(MetricName.TOOL_DURATION, {
        description: "Duration of tool executions.",
        unit: "s",
        valueType: ValueType.DOUBLE,
      }),
      toolInvocations: meter.createCounter(MetricName.TOOL_INVOCATIONS, {
        description: "Count of tool invocations.",
        unit: "{call}",
        valueType: ValueType.INT,
      }),
      toolFailures: meter.createCounter(MetricName.TOOL_FAILURES, {
        description: "Count of tool invocations that returned an error.",
        unit: "{call}",
        valueType: ValueType.INT,
      }),
      turns: meter.createCounter(MetricName.TURNS, {
        description: "Count of agent turns.",
        unit: "{turn}",
        valueType: ValueType.INT,
      }),
    };
  }
}

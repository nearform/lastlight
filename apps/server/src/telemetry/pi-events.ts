import type { Context, Span } from "@opentelemetry/api";
import { context, SpanStatusCode, trace } from "@opentelemetry/api";
import { safeSpanAttributes, setSpanAttributes } from "./index.js";
import {
  OI,
  SpanKind,
  llmTokenAttributes,
  splitProviderModel,
  type TokenUsage,
} from "./openinference.js";

export interface PiEventRecordOptions {
  includeContent: boolean;
  span?: Span;
  surface: "agent" | "chat";
  sessionId?: string;
  workflowName?: string;
  phaseName?: string;
  model?: string;
}

const CONTENT_LIMIT = 4096;

function trunc(value: unknown): unknown {
  if (typeof value !== "string") return value;
  return value.length > CONTENT_LIMIT ? value.slice(0, CONTENT_LIMIT - 1) + "…" : value;
}

function contentTypes(content: unknown): string[] {
  if (!Array.isArray(content)) return [];
  return content.map((c) => typeof c === "object" && c !== null && "type" in c ? String((c as { type?: unknown }).type) : "unknown");
}

function sanitizeMessage(message: unknown, includeContent: boolean): Record<string, unknown> {
  if (typeof message !== "object" || message === null) return {};
  const m = message as Record<string, unknown>;
  const content = Array.isArray(m.content) ? m.content : [];
  const out: Record<string, unknown> = {
    "message.role": typeof m.role === "string" ? m.role : undefined,
    "message.content_block_count": content.length,
    "message.content_block_types": contentTypes(content).join(","),
  };
  const usage = typeof m.usage === "object" && m.usage !== null ? m.usage as Record<string, unknown> : undefined;
  if (usage) {
    for (const [key, value] of Object.entries(usage)) {
      if (typeof value === "number" || typeof value === "string" || typeof value === "boolean") out[`usage.${key}`] = value;
    }
  }
  if (includeContent) {
    out["message.content"] = JSON.stringify(content, (_k, v) => trunc(v));
  }
  return out;
}

export function sanitizePiEvent(record: Record<string, unknown>, includeContent = false): Record<string, unknown> {
  const type = typeof record.type === "string" ? record.type : "unknown";
  const out: Record<string, unknown> = { "pi.event_type": type };
  if (typeof record.sessionId === "string") out["agent.session_id"] = record.sessionId;
  switch (type) {
    case "session":
      if (typeof record.id === "string") out["agent.session_id"] = record.id;
      if (typeof record.cwd === "string") out["agent.cwd"] = record.cwd;
      if (typeof record.runtime === "string") out["agent.runtime"] = record.runtime;
      if (typeof record.version === "string") out["agent.version"] = record.version;
      break;
    case "message_end":
      Object.assign(out, sanitizeMessage(record.message, includeContent));
      break;
    case "tool_execution_end":
      if (typeof record.toolName === "string") out["tool.name"] = record.toolName;
      if (typeof record.tool === "string") out["tool.name"] = record.tool;
      if (typeof record.isError === "boolean") out["tool.is_error"] = record.isError;
      if (typeof record.durationMs === "number") out["tool.duration_ms"] = record.durationMs;
      if (typeof record.status === "string") out["tool.status"] = record.status;
      if (record.error instanceof Error) {
        out["error.name"] = record.error.name;
        out["error.message"] = record.error.message;
        if (includeContent) out["error.stack"] = trunc(record.error.stack);
      } else if (typeof record.error === "string") {
        out["error.message"] = record.error;
      }
      if (includeContent) {
        if (record.result !== undefined) out["tool.result"] = trunc(typeof record.result === "string" ? record.result : JSON.stringify(record.result));
        if (record.output !== undefined) out["tool.output"] = trunc(typeof record.output === "string" ? record.output : JSON.stringify(record.output));
      }
      break;
    case "extension_status":
      for (const key of ["extension", "status", "mode", "provider", "toolCount", "reason"]) {
        const value = record[key];
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[`extension.${key}`] = value;
      }
      break;
    case "skills_status":
      for (const key of ["status", "discovered", "noSkills"]) {
        const value = record[key];
        if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[`skills.${key}`] = value;
      }
      if (Array.isArray(record.skills)) {
        out["skills.names"] = record.skills
          .map((s) => (s && typeof s === "object" && "name" in s ? String((s as { name?: unknown }).name) : ""))
          .filter(Boolean)
          .join(",");
      }
      break;
    case "usage_snapshot":
      for (const key of ["turns", "costUsd", "inputTokens", "outputTokens", "cacheReadInputTokens", "cacheCreationInputTokens"]) {
        const value = record[key];
        if (typeof value === "number") out[`usage.${key}`] = value;
      }
      break;
    case "fatal_error":
      if (typeof record.name === "string") out["error.name"] = record.name;
      if (typeof record.message === "string") out["error.message"] = record.message;
      if (includeContent && typeof record.stack === "string") out["error.stack"] = trunc(record.stack);
      break;
  }
  return safeSpanAttributes(out);
}

// ── OpenInference span tree ──────────────────────────────────────────────
//
// The flat `pi.*` events above (recordPiEvent) stay for backward compatibility,
// but they render as a useless single-span "Events" list in Phoenix. AgentSpanTree
// turns the SAME agentic-pi event stream into a nested OpenInference span tree
// under the `lastlight.agent.execute` (AGENT) span:
//
//   lastlight.agent.execute   (AGENT)
//   ├─ turn 1                 (LLM)   per-turn prompt/completion tokens + cost
//   │  └─ <tool>              (TOOL)  tool.name, is_error, args/result (gated)
//   └─ turn 2                 (LLM)   …
//
// agentic-pi ALSO emits its own gen_ai.* span tree from inside the sandbox; this
// is the harness-side equivalent in OpenInference vocabulary, parented to our own
// workflow/phase/agent spans so a Phoenix trace shows the whole run as one tree.
// It is defensive: any missing/out-of-order pair warns nothing and never throws.

const tracer = () => trace.getTracer("lastlight");

interface MessageLike {
  role?: string;
  content?: unknown;
  provider?: string;
  model?: string;
  usage?: {
    input?: number;
    output?: number;
    cacheRead?: number;
    cacheWrite?: number;
    cost?: { total?: number };
  };
}

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? v : 0;
}

function toText(value: unknown): string {
  return typeof value === "string" ? value : safeStringify(value);
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value, (_k, v) => (typeof v === "string" ? trunc(v) : v)) ?? String(value);
  } catch {
    return String(value);
  }
}

function assistantText(message: MessageLike): string | undefined {
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

export interface AgentSpanTreeOpts {
  /** The active `lastlight.agent.execute` span (undefined when telemetry is off). */
  parent?: Span;
  /** Gate free-text content (assistant text, tool args + results) on spans. */
  includeContent: boolean;
  /** Full `provider/model` id for the run (fallback for per-turn model labels). */
  model?: string;
}

export class AgentSpanTree {
  private readonly parent?: Span;
  private readonly parentCtx?: Context;
  private readonly includeContent: boolean;
  private readonly system?: string;
  private readonly modelName?: string;
  private turn?: { span: Span; ctx: Context; usage: TokenUsage; text: string };
  private turnIndex = 0;
  private readonly tools = new Map<string, Span>();
  private ended = false;

  constructor(opts: AgentSpanTreeOpts) {
    this.parent = opts.parent;
    this.includeContent = opts.includeContent;
    const { system, modelName } = splitProviderModel(opts.model);
    this.system = system;
    this.modelName = modelName;
    // Parent every child at the agent span, regardless of what happens to be
    // active when a later event arrives (onEvent isn't wrapped per-event).
    if (this.parent) this.parentCtx = trace.setSpan(context.active(), this.parent);
  }

  feed(record: Record<string, unknown>): void {
    if (!this.parent || this.ended) return;
    try {
      switch (record.type) {
        case "turn_start":
          this.startTurn();
          break;
        case "turn_end":
          this.endTurn();
          break;
        case "message_end":
          this.onMessageEnd(record);
          break;
        case "tool_execution_start":
          this.startTool(record);
          break;
        case "tool_execution_end":
          this.endTool(record);
          break;
      }
    } catch {
      // A telemetry glitch must never break the run.
    }
  }

  /** Close any still-open turn/tool spans. Idempotent; call in a finally. */
  end(): void {
    if (this.ended) return;
    this.ended = true;
    for (const span of this.tools.values()) {
      span.setStatus({ code: SpanStatusCode.ERROR, message: "tool span not closed" });
      span.end();
    }
    this.tools.clear();
    if (this.turn) {
      this.turn.span.end();
      this.turn = undefined;
    }
  }

  private llmModelAttrs(model?: string, provider?: string): Record<string, string> {
    const out: Record<string, string> = { [OI.SPAN_KIND]: SpanKind.LLM };
    const name = model ?? this.modelName;
    const sys = provider ?? this.system;
    if (name) out[OI.LLM_MODEL_NAME] = name;
    if (sys) out[OI.LLM_SYSTEM] = sys;
    return out;
  }

  private startTurn(): void {
    if (this.turn) this.endTurn(); // defensive: a turn left open by a missing turn_end
    if (!this.parentCtx) return;
    const idx = ++this.turnIndex;
    const span = tracer().startSpan(`turn ${idx}`, { attributes: this.llmModelAttrs() }, this.parentCtx);
    this.turn = { span, ctx: trace.setSpan(this.parentCtx, span), usage: {}, text: "" };
  }

  private onMessageEnd(record: Record<string, unknown>): void {
    const m = record.message as MessageLike | undefined;
    if (!m || m.role !== "assistant") return;
    const t = this.turn;
    if (!t) return;
    // Refine the per-turn model/provider from the actual assistant message.
    if (m.model || m.provider) setSpanAttributes(t.span, this.llmModelAttrs(m.model, m.provider));
    const usage = m.usage;
    if (usage) {
      t.usage.input = (t.usage.input ?? 0) + num(usage.input);
      t.usage.output = (t.usage.output ?? 0) + num(usage.output);
      t.usage.cacheRead = (t.usage.cacheRead ?? 0) + num(usage.cacheRead);
      t.usage.cacheWrite = (t.usage.cacheWrite ?? 0) + num(usage.cacheWrite);
      t.usage.cost = (t.usage.cost ?? 0) + num(usage.cost?.total);
    }
    if (this.includeContent) {
      const text = assistantText(m);
      if (text) t.text += text;
    }
  }

  private endTurn(): void {
    const t = this.turn;
    if (!t) return;
    setSpanAttributes(t.span, llmTokenAttributes(t.usage));
    if (this.includeContent && t.text) {
      setSpanAttributes(t.span, { [OI.OUTPUT_VALUE]: t.text, [OI.OUTPUT_MIME_TYPE]: "text/plain" });
    }
    t.span.end();
    this.turn = undefined;
  }

  private toolName(record: Record<string, unknown>): string {
    if (typeof record.toolName === "string") return record.toolName;
    if (typeof record.tool === "string") return record.tool;
    return "tool";
  }

  private startTool(record: Record<string, unknown>): void {
    const parent = this.turn?.ctx ?? this.parentCtx;
    if (!parent) return;
    const name = this.toolName(record);
    const id = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
    const span = tracer().startSpan(
      name,
      { attributes: { [OI.SPAN_KIND]: SpanKind.TOOL, [OI.TOOL_NAME]: name, [OI.TOOL_CALL_FUNCTION_NAME]: name } },
      parent,
    );
    if (this.includeContent && record.args !== undefined) {
      const argStr = toText(record.args);
      setSpanAttributes(span, {
        [OI.TOOL_CALL_FUNCTION_ARGUMENTS]: argStr,
        [OI.INPUT_VALUE]: argStr,
        [OI.INPUT_MIME_TYPE]: "application/json",
      });
    }
    // With no id we can't pair a later tool_execution_end — end it now (start-only).
    if (id) this.tools.set(id, span);
    else span.end();
  }

  private endTool(record: Record<string, unknown>): void {
    const parent = this.turn?.ctx ?? this.parentCtx;
    if (!parent) return;
    const name = this.toolName(record);
    const id = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
    let span = id ? this.tools.get(id) : undefined;
    if (!span) {
      // start was missed — open a zero-duration span now so the call still shows.
      span = tracer().startSpan(
        name,
        { attributes: { [OI.SPAN_KIND]: SpanKind.TOOL, [OI.TOOL_NAME]: name, [OI.TOOL_CALL_FUNCTION_NAME]: name } },
        parent,
      );
    }
    const isError = record.isError === true;
    setSpanAttributes(span, { [OI.TOOL_IS_ERROR]: isError });
    if (this.includeContent) {
      const result = record.result ?? record.output;
      if (result !== undefined) {
        setSpanAttributes(span, { [OI.OUTPUT_VALUE]: toText(result), [OI.OUTPUT_MIME_TYPE]: "text/plain" });
      }
    }
    if (isError) span.setStatus({ code: SpanStatusCode.ERROR });
    span.end();
    if (id) this.tools.delete(id);
  }
}

export function recordPiEvent(record: Record<string, unknown>, opts: PiEventRecordOptions): void {
  const span = opts.span ?? trace.getActiveSpan();
  if (!span) return;
  const attrs = safeSpanAttributes({
    ...sanitizePiEvent(record, opts.includeContent),
    surface: opts.surface,
    "workflow.name": opts.workflowName,
    "phase.name": opts.phaseName,
    model: opts.model,
    "agent.session_id": opts.sessionId,
  });
  span.addEvent(`pi.${typeof record.type === "string" ? record.type : "event"}`, attrs);
}

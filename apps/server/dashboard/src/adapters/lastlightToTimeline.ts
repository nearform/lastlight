import type { Message } from "../api";
import type { BaseMessage, ToolUseContent } from "../timeline/types";

function tsString(ts: unknown): string {
  if (typeof ts === "number") return new Date(ts * 1000).toISOString();
  if (typeof ts === "string") return ts;
  return new Date().toISOString();
}

export function extractText(raw: unknown): string {
  if (raw == null) return "";
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw)) {
    return raw
      .map((c) => {
        if (typeof c === "string") return c;
        if (c && typeof c === "object") {
          const obj = c as Record<string, unknown>;
          if (typeof obj.text === "string") return obj.text;
          if (typeof obj.content === "string") return obj.content;
        }
        return "";
      })
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

function parseToolCalls(raw: unknown): ToolUseContent[] {
  if (!raw) return [];
  let arr: unknown = raw;
  if (typeof raw === "string") {
    try {
      arr = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  if (!Array.isArray(arr)) return [];
  return arr.map((tc, i) => {
    const obj = (tc as Record<string, unknown>) ?? {};
    const fn = (obj.function as Record<string, unknown>) ?? {};
    let input: Record<string, unknown> = {};
    const rawArgs = fn.arguments ?? obj.arguments;
    if (typeof rawArgs === "string") {
      try {
        input = JSON.parse(rawArgs) as Record<string, unknown>;
      } catch {
        input = { raw: rawArgs };
      }
    } else if (rawArgs && typeof rawArgs === "object") {
      input = rawArgs as Record<string, unknown>;
    }
    const id =
      typeof obj.id === "string"
        ? obj.id
        : typeof fn.id === "string"
          ? (fn.id as string)
          : `tc-${i}`;
    const name = String(fn.name ?? obj.name ?? "tool");
    return { id, name, input };
  });
}

const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Why the turn ended and what served it — only the keys the message carries. */
function assistantMetadata(msg: Message): BaseMessage["metadata"] {
  const meta = {
    model: str(msg.model),
    responseModel: str(msg.response_model),
    finishReason: str(msg.finish_reason),
    rawStopReason: str(msg.raw_stop_reason),
  };
  const present = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
  return Object.keys(present).length > 0 ? present : undefined;
}

/**
 * Convert raw lastlight session messages to BaseMessage[].
 * The JSONL format uses role-based lines identical to Hermes:
 * session_meta, user, assistant, tool.
 */
export function toBaseMessages(messages: Message[]): BaseMessage[] {
  const out: BaseMessage[] = [];

  for (const msg of messages) {
    const role = msg.role;
    const ts = tsString(msg.timestamp ?? Date.now() / 1000);
    const id = String(msg.id);
    const text = extractText(msg.content);
    const toolCalls = parseToolCalls(msg.tool_calls);
    const toolName = msg.tool_name ? String(msg.tool_name) : undefined;
    const toolCallId = msg.tool_call_id ? String(msg.tool_call_id) : undefined;

    if (role === "user") {
      out.push({ id, timestamp: ts, type: "user", content: { text } });
    } else if (role === "assistant") {
      if (text) {
        out.push({
          id: toolCalls.length ? `${id}-text` : id,
          timestamp: ts,
          type: "assistant",
          content: { text, reasoning: extractText(msg.reasoning) },
          metadata: assistantMetadata(msg),
        });
      }
      for (let i = 0; i < toolCalls.length; i++) {
        const tc = toolCalls[i]!;
        const tcId = tc.id.startsWith("tc-") ? `${id}-tc${i}` : tc.id;
        out.push({
          id: tcId,
          timestamp: ts,
          type: "tool_use",
          content: { id: tcId, name: tc.name, input: tc.input },
        });
      }
    } else if (role === "tool") {
      let parsed: unknown = text;
      try {
        parsed = JSON.parse(text);
      } catch {
        /* keep string */
      }
      out.push({
        id,
        timestamp: ts,
        type: "tool_result",
        content: { tool_use_id: toolCallId, content: parsed },
        linkedTo: toolCallId,
        metadata: toolName ? { toolName } : undefined,
      });
    } else if (role === "system") {
      out.push({ id, timestamp: ts, type: "system", content: { text } });
    } else if (role === "session_meta") {
      out.push({ id, timestamp: ts, type: "meta", content: msg });
    } else {
      out.push({ id, timestamp: ts, type: "user", content: { text, role } });
    }
  }

  return out;
}

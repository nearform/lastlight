/**
 * Live-session control channel (SPIKE — spike/live-sessions).
 *
 * The default run is one-shot: prompt on stdin, JSONL on stdout, no way in.
 * With a control channel the caller can talk to a RUNNING session:
 *
 *   steer      → session.steer()     delivered after the current turn's tools
 *   follow_up  → session.followUp()  delivered once the agent would stop
 *   abort      → session.abort()     the loop ends with a normal agent_end
 *   decide     → resolves a pending `approval_requested` (see approvalGate)
 *
 * Every command is acknowledged with a `control_ack` record so the caller (a
 * guardian, a maintainer in the dashboard) can see it landed. Approvals FAIL
 * CLOSED: a timeout or a closed channel denies the tool call.
 *
 * The channel is a transport-agnostic port. The CLI reads it from stdin
 * (`--control stdin`, the docker `exec -i` path); the library path takes any
 * AsyncIterable; a k8s pod would dial out over a WebSocket.
 */

import type { ExtensionFactory } from "@earendil-works/pi-coding-agent";
import type { EmitterRecord } from "./emitter.js";

export type ControlCommand =
  | { type: "steer"; message: string }
  | { type: "follow_up"; message: string }
  | { type: "abort"; reason?: string }
  | {
      type: "decide";
      /** The `id` of the `approval_requested` record being answered. */
      id: string;
      allow: boolean;
      reason?: string;
      /** Optional replacement tool input (e.g. a clamped bash command). */
      input?: Record<string, unknown>;
    };

/** The first line on a control-mode stdin. */
export interface PromptCommand {
  type: "prompt";
  message: string;
}

/** Parse one JSONL control line; returns an error string for a bad line. */
export function parseControlLine(line: string): ControlCommand | PromptCommand | { error: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch {
    return { error: "not JSON" };
  }
  if (!raw || typeof raw !== "object") return { error: "not an object" };
  const r = raw as Record<string, unknown>;
  switch (r.type) {
    case "prompt":
    case "steer":
    case "follow_up":
      if (typeof r.message !== "string" || !r.message.trim()) return { error: `${r.type}: message required` };
      return { type: r.type, message: r.message };
    case "abort":
      return { type: "abort", reason: typeof r.reason === "string" ? r.reason : undefined };
    case "decide":
      if (typeof r.id !== "string" || typeof r.allow !== "boolean") return { error: "decide: id + allow required" };
      return {
        type: "decide",
        id: r.id,
        allow: r.allow,
        reason: typeof r.reason === "string" ? r.reason : undefined,
        input: r.input && typeof r.input === "object" ? (r.input as Record<string, unknown>) : undefined,
      };
    default:
      return { error: `unknown control type ${JSON.stringify(r.type)}` };
  }
}

/** The subset of AgentSession the control loop drives (public Pi API). */
export interface ControllableSession {
  steer(text: string): Promise<void>;
  followUp(text: string): Promise<void>;
  abort(): Promise<void>;
}

interface Pending {
  resolve: (d: { allow: boolean; reason?: string; input?: Record<string, unknown> }) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Pending approvals, shared between the `approvalGate` extension (which
 * registers them) and the control loop (which resolves them). Built before
 * the session so the extension factory can close over it.
 */
export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>();
  private closed = false;
  private seq = 0;

  constructor(private readonly timeoutMs: number) {}

  request(): { id: string; decision: Promise<{ allow: boolean; reason?: string; input?: Record<string, unknown> }> } {
    const id = `appr_${++this.seq}`;
    if (this.closed) {
      return { id, decision: Promise.resolve({ allow: false, reason: "control channel closed" }) };
    }
    const decision = new Promise<{ allow: boolean; reason?: string; input?: Record<string, unknown> }>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve({ allow: false, reason: `no approval decision within ${Math.round(this.timeoutMs / 1000)}s` });
      }, this.timeoutMs);
      this.pending.set(id, { resolve, timer });
    });
    return { id, decision };
  }

  /** Returns false when `id` is unknown (already decided, timed out, or never asked). */
  decide(id: string, d: { allow: boolean; reason?: string; input?: Record<string, unknown> }): boolean {
    const p = this.pending.get(id);
    if (!p) return false;
    clearTimeout(p.timer);
    this.pending.delete(id);
    p.resolve(d);
    return true;
  }

  /** Deny everything outstanding and every future request — fail closed. */
  close(reason = "control channel closed"): void {
    this.closed = true;
    for (const [id, p] of this.pending) {
      clearTimeout(p.timer);
      p.resolve({ allow: false, reason });
      this.pending.delete(id);
    }
  }
}

/** Which tool calls need a decision before they run. */
export type ApprovalMatcher = (toolName: string, input: Record<string, unknown>) => boolean;

/** `--approve-tools bash,github_publish` / `*` → matcher. Undefined = no gate. */
export function approvalMatcher(tools: string[] | undefined): ApprovalMatcher | undefined {
  if (!tools || tools.length === 0) return undefined;
  if (tools.includes("*")) return () => true;
  const set = new Set(tools);
  return (name) => set.has(name);
}

/**
 * Pi extension: pause matching tool calls on an `approval_requested` record
 * until a `decide` arrives. Deny → `{ block, reason }` (the model sees the
 * reason as the tool result and carries on, same as command-policy). Allow
 * with `input` → the input is patched in place before execution (Pi's
 * documented `tool_call` mutation contract).
 */
export function approvalGate(
  match: ApprovalMatcher | undefined,
  broker: ApprovalBroker,
  emit: (e: EmitterRecord) => void,
): ExtensionFactory | undefined {
  if (!match) return undefined;
  return (pi) => {
    pi.on("tool_call", async (event) => {
      const input = event.input as Record<string, unknown>;
      if (!match(event.toolName, input)) return undefined;
      const { id, decision } = broker.request();
      emit({ type: "approval_requested", id, toolCallId: event.toolCallId, toolName: event.toolName, input });
      const d = await decision;
      emit({ type: "approval_resolved", id, allow: d.allow, reason: d.reason, patched: d.input !== undefined });
      if (!d.allow) return { block: true, reason: d.reason ?? "denied by reviewer" };
      if (d.input) {
        for (const k of Object.keys(input)) delete input[k];
        Object.assign(input, d.input);
      }
      return undefined;
    });
  };
}

/**
 * Pump control commands into the session until the source ends. Resolves when
 * the source is exhausted; the broker is closed then (fail closed).
 */
export async function pumpControl(
  source: AsyncIterable<ControlCommand | { error: string }>,
  session: ControllableSession,
  broker: ApprovalBroker,
  emit: (e: EmitterRecord) => void,
): Promise<void> {
  try {
    for await (const cmd of source) {
      if ("error" in cmd) {
        emit({ type: "control_ack", ok: false, error: cmd.error });
        continue;
      }
      try {
        switch (cmd.type) {
          case "steer":
            await session.steer(cmd.message);
            break;
          case "follow_up":
            await session.followUp(cmd.message);
            break;
          case "abort":
            emit({ type: "control_abort", reason: cmd.reason });
            // Fire-and-forget like the max-steps cap: abort() waits for idle,
            // and the loop may be awaiting a tool_call hook we'd deadlock on.
            broker.close("session aborted");
            void session.abort().catch(() => undefined);
            break;
          case "decide":
            if (!broker.decide(cmd.id, cmd)) {
              emit({ type: "control_ack", command: "decide", id: cmd.id, ok: false, error: "no pending approval" });
              continue;
            }
            break;
        }
        emit({ type: "control_ack", command: cmd.type, ok: true, ...(cmd.type === "decide" ? { id: cmd.id } : {}) });
      } catch (err) {
        emit({ type: "control_ack", command: cmd.type, ok: false, error: (err as Error).message });
      }
    }
  } finally {
    broker.close();
  }
}

/**
 * Line-split a byte stream into control commands. Used for stdin; the first
 * line (the prompt) is consumed by {@link readControlPrompt} before this.
 */
export async function* controlLines(
  stream: AsyncIterable<string | Buffer>,
): AsyncGenerator<ControlCommand | { error: string }> {
  let buf = "";
  for await (const chunk of stream) {
    buf += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    for (let nl = buf.indexOf("\n"); nl >= 0; nl = buf.indexOf("\n")) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line) continue;
      const cmd = parseControlLine(line);
      if ("type" in cmd && cmd.type === "prompt") {
        yield { error: "prompt already sent" };
        continue;
      }
      yield cmd as ControlCommand | { error: string };
    }
  }
}

/**
 * Control-mode stdin: line 1 is `{"type":"prompt","message":…}`, later lines
 * are control commands. Returns the prompt and an iterator over the rest.
 */
export async function readControlPrompt(
  stream: AsyncIterable<string | Buffer>,
): Promise<{ prompt: string; rest: AsyncIterable<ControlCommand | { error: string }> }> {
  const it = stream[Symbol.asyncIterator]();
  let buf = "";
  for (;;) {
    const nl = buf.indexOf("\n");
    if (nl >= 0) {
      const first = parseControlLine(buf.slice(0, nl).trim());
      const remainder = buf.slice(nl + 1);
      if ("error" in first || first.type !== "prompt") {
        throw new Error(`control mode: first stdin line must be {"type":"prompt","message":…}`);
      }
      async function* restStream(): AsyncGenerator<string> {
        if (remainder) yield remainder;
        for (;;) {
          const n = await it.next();
          if (n.done) return;
          yield typeof n.value === "string" ? n.value : n.value.toString("utf8");
        }
      }
      return { prompt: first.message, rest: controlLines(restStream()) };
    }
    const n = await it.next();
    if (n.done) throw new Error("control mode: stdin closed before the prompt line");
    buf += typeof n.value === "string" ? n.value : n.value.toString("utf8");
  }
}

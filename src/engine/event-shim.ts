import { promises as fs } from "node:fs";
import path from "node:path";
import type { EmitterRecord } from "agentic-pi";

/**
 * Translates agentic-pi's JSONL event stream into Claude-SDK-style envelope
 * jsonl on disk, so the dashboard's `SessionReader` /
 * `ChatSessionReader` (`src/admin/`) keeps working unchanged.
 *
 * agentic-pi event → envelope mapping (see agentic-pi/src/emitter.ts and
 * survey in ~/.claude/plans/ok-i-want-noble-sphinx.md):
 *
 *   session                  → header (no envelope line; pins the on-disk
 *                              path), followed by a `user` line carrying
 *                              the initial prompt.
 *   message_end (assistant)  → `assistant` envelope with content (text +
 *                              tool_use blocks).
 *   tool_execution_end       → `user` envelope with a `tool_result` block.
 *   usage_snapshot           → `result` envelope (cost / tokens / turns).
 *   fatal_error              → `assistant` envelope with isApiErrorMessage.
 *
 * Tool naming: agentic-pi names its github tools `github_*`. Earlier
 * (OpenCode + MCP), tool names were rewritten to `mcp_github_*` before
 * reaching the dashboard, and the dashboard's tool-family classifier
 * already accepts the bare `github_` prefix as a github tool. We pass
 * tool names through unchanged.
 */
export interface AgenticShimOptions {
  /** Root sessions dir — contains the `projects/<slug>/` tree. */
  homeDir: string;
  /** Project-dir slug, e.g. "-home-agent-workspace" or "-app". */
  projectSlug: string;
  /** Model id surfaced on assistant envelopes. */
  model?: string;
  /** Original user prompt — written as the first envelope. */
  initialPrompt: string;
}

export interface ShimResultEnvelope {
  finalText: string;
  turns: number;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  stopReason: string;
  durationMs: number;
}

export class AgenticShim {
  private opts: AgenticShimOptions;
  private filePath: string | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private initialWritten = false;
  /**
   * Tool calls we have already emitted a `tool_use` block for via
   * `message_end`. Keyed by tool-call id so the matching
   * `tool_execution_end` event can emit the paired `tool_result` block.
   */
  private seenToolCalls = new Set<string>();

  constructor(opts: AgenticShimOptions) {
    this.opts = opts;
  }

  get isInitialized(): boolean {
    return this.filePath !== null;
  }

  /** Feed one parsed agentic-pi event. */
  feed(record: EmitterRecord): void {
    if (!record || typeof record !== "object") return;
    const sessionId =
      typeof record.sessionId === "string"
        ? (record.sessionId as string)
        : record.type === "session" && typeof record.id === "string"
        ? (record.id as string)
        : null;

    // The `session` header is the first record and carries the id without
    // a `sessionId` field. Subsequent records all have `sessionId`.
    if (record.type === "session" && typeof record.id === "string") {
      this.openFile(record.id);
      return;
    }

    if (!sessionId) return;
    if (!this.filePath) this.openFile(sessionId);
    if (!this.filePath) return;

    const ts = isoTimestamp(record.timestamp);

    if (!this.initialWritten) {
      this.initialWritten = true;
      this.appendLines([
        {
          type: "user",
          message: { role: "user", content: this.opts.initialPrompt },
          timestamp: ts,
          sessionId,
        },
      ]);
    }

    const out = this.translate(record, ts, sessionId);
    if (out.length) this.appendLines(out);
  }

  /**
   * Append a `result` envelope mirroring the existing Claude-stream
   * `result` line. Same shape as the legacy opencode-shim.
   */
  finalize(result: ShimResultEnvelope): void {
    if (!this.filePath) return;
    const envelope = {
      type: "result",
      subtype: result.stopReason === "success" ? "success" : result.stopReason,
      result: result.finalText,
      num_turns: result.turns,
      total_cost_usd: result.costUsd,
      total_input_tokens: result.inputTokens,
      total_output_tokens: result.outputTokens,
      total_cache_read_input_tokens: result.cacheReadInputTokens,
      total_cache_creation_input_tokens: result.cacheCreationInputTokens,
      duration_ms: result.durationMs,
      timestamp: new Date().toISOString(),
    };
    this.appendLines([envelope]);
  }

  /**
   * Bootstrap a stub envelope when no `session` record was observed (the
   * run died before agentic-pi got far enough to emit one). Returns the
   * synthetic id actually used for the on-disk file so the caller can
   * record it on the executions row.
   */
  async finalizeWithFallback(
    result: ShimResultEnvelope,
    fallbackSessionId: string,
    errorMessage?: string,
  ): Promise<string | null> {
    if (!this.filePath) {
      const safeId = path.basename(fallbackSessionId);
      if (!/^[A-Za-z0-9_-]+$/.test(safeId)) {
        await this.flush();
        return null;
      }
      this.filePath = path.join(
        this.opts.homeDir,
        "projects",
        this.opts.projectSlug,
        `${safeId}.jsonl`,
      );

      const ts = new Date().toISOString();
      const bootstrap: object[] = [];
      if (!this.initialWritten) {
        this.initialWritten = true;
        bootstrap.push({
          type: "user",
          message: { role: "user", content: this.opts.initialPrompt },
          timestamp: ts,
          sessionId: safeId,
        });
      }
      if (errorMessage) {
        bootstrap.push({
          type: "assistant",
          isApiErrorMessage: true,
          error: errorMessage,
          timestamp: ts,
          sessionId: safeId,
        });
      }
      if (bootstrap.length > 0) this.appendLines(bootstrap);

      this.finalize(result);
      await this.flush();
      return safeId;
    }

    this.finalize(result);
    await this.flush();
    return path.basename(this.filePath, ".jsonl");
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private openFile(sessionId: string): void {
    const safeId = path.basename(sessionId);
    if (!/^[A-Za-z0-9_-]+$/.test(safeId)) return;
    this.filePath = path.join(
      this.opts.homeDir,
      "projects",
      this.opts.projectSlug,
      `${safeId}.jsonl`,
    );
  }

  private translate(
    r: EmitterRecord,
    ts: string,
    sessionId: string,
  ): object[] {
    switch (r.type) {
      case "message_end":
        return this.translateMessageEnd(r, ts, sessionId);
      case "tool_execution_end":
        return this.translateToolEnd(r, ts, sessionId);
      case "fatal_error":
        return this.translateFatal(r, ts, sessionId);
      default:
        return [];
    }
  }

  private translateMessageEnd(
    r: EmitterRecord,
    ts: string,
    sessionId: string,
  ): object[] {
    const message = (r.message ?? {}) as {
      role?: string;
      content?: Array<Record<string, unknown>>;
    };
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return [];
    }

    // Pi's content blocks are text / thinking / toolCall. The dashboard
    // envelope only renders text and tool_use; map toolCall → tool_use
    // and drop thinking blocks (they're internal reasoning, not chat).
    const out: Array<Record<string, unknown>> = [];
    for (const c of message.content) {
      if (c.type === "text" && typeof c.text === "string") {
        out.push({ type: "text", text: c.text });
      } else if (c.type === "toolCall") {
        const id = typeof c.id === "string" ? c.id : null;
        const name = typeof c.name === "string" ? c.name : null;
        if (!id || !name) continue;
        this.seenToolCalls.add(id);
        out.push({
          type: "tool_use",
          id,
          name,
          input: (c.arguments as Record<string, unknown>) ?? {},
        });
      }
    }
    if (out.length === 0) return [];
    return [
      {
        type: "assistant",
        message: {
          role: "assistant",
          model: this.opts.model,
          content: out,
        },
        timestamp: ts,
        sessionId,
      },
    ];
  }

  private translateToolEnd(
    r: EmitterRecord,
    ts: string,
    sessionId: string,
  ): object[] {
    const id =
      typeof r.toolCallId === "string"
        ? (r.toolCallId as string)
        : typeof r.id === "string"
        ? (r.id as string)
        : null;
    if (!id) return [];

    // If we never saw the matching tool_use in a message_end, skip — a
    // result without a use block confuses the dashboard renderer.
    if (!this.seenToolCalls.has(id)) return [];

    const raw = r.result ?? r.output ?? r.error ?? "";
    const content = typeof raw === "string" ? raw : safeStringify(raw);
    const block: Record<string, unknown> = {
      type: "tool_result",
      tool_use_id: id,
      content,
    };
    if (r.isError === true) block.is_error = true;

    return [
      {
        type: "user",
        message: { role: "user", content: [block] },
        timestamp: ts,
        sessionId,
      },
    ];
  }

  private translateFatal(
    r: EmitterRecord,
    ts: string,
    sessionId: string,
  ): object[] {
    const err = (r.error ?? {}) as { name?: string; message?: string };
    const msg = err.message ?? err.name ?? "fatal error";
    return [
      {
        type: "assistant",
        isApiErrorMessage: true,
        error: String(msg),
        timestamp: ts,
        sessionId,
      },
    ];
  }

  private appendLines(lines: object[]): void {
    const data = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    this.writeChain = this.writeChain
      .then(async () => {
        if (!this.filePath) return;
        await fs.mkdir(path.dirname(this.filePath), { recursive: true });
        await fs.appendFile(this.filePath, data);
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[shim] failed to append jsonl: ${msg}`);
      });
  }
}

function isoTimestamp(raw: unknown): string {
  if (typeof raw === "number" && Number.isFinite(raw)) {
    return new Date(raw).toISOString();
  }
  if (typeof raw === "string") {
    const d = new Date(raw);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/**
 * Filesystem cwd → project-dir slug (matches the SDK convention). The
 * absolute path with `/` replaced by `-`. `/app` → `-app`,
 * `/home/agent/workspace` → `-home-agent-workspace`.
 */
export function projectSlugForCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

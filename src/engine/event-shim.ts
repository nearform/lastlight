import type { EmitterRecord } from "agentic-pi";
import { SessionLog } from "../session-log.js";

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
  /**
   * Provider-level error (e.g. OpenAI insufficient_quota) extracted from
   * the last assistant message. When set, an `isApiErrorMessage` envelope
   * is appended before the `result` line so the dashboard renders the
   * cause inline instead of showing a silent "success".
   */
  apiErrorMessage?: string;
}

export class AgenticShim {
  private opts: AgenticShimOptions;
  private sessionLog: SessionLog;
  private sessionId: string | null = null;
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
    this.sessionLog = new SessionLog(opts.homeDir);
  }

  get isInitialized(): boolean {
    return this.sessionId !== null;
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
      this.openSession(record.id);
      return;
    }

    if (!sessionId) return;
    if (!this.sessionId) this.openSession(sessionId);
    if (!this.sessionId) return;

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
    if (!this.sessionId) return;
    const ts = new Date().toISOString();
    const lines: object[] = [];
    if (result.apiErrorMessage) {
      lines.push({
        type: "assistant",
        isApiErrorMessage: true,
        error: result.apiErrorMessage,
        timestamp: ts,
        sessionId: this.sessionId,
      });
    }
    lines.push({
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
      timestamp: ts,
    });
    this.appendLines(lines);
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
    if (!this.sessionId) {
      this.openSession(fallbackSessionId);
      const safeId = this.sessionId;
      if (!safeId) {
        await this.flush();
        return null;
      }

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
    return this.sessionId;
  }

  async flush(): Promise<void> {
    await this.writeChain;
  }

  private openSession(sessionId: string): void {
    const safeId = this.sessionLog.normalizeSessionId(sessionId);
    if (!safeId) return;
    this.sessionId = safeId;
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
      case "extension_status":
        return this.translateExtensionStatus(r, ts, sessionId);
      case "skills_status":
        return this.translateSkillsStatus(r, ts, sessionId);
      case "auto_retry_start":
        return this.translateAutoRetryStart(r, ts, sessionId);
      case "auto_retry_end":
        return this.translateAutoRetryEnd(r, ts, sessionId);
      case "fatal_error":
        return this.translateFatal(r, ts, sessionId);
      default:
        return [];
    }
  }

  /**
   * Mirror an agentic-pi `extension_status` event (file-search / github /
   * web-search) as a `system` envelope near the top of the session log, so
   * the raw JSONL shows which extensions were active. The dashboard's
   * SessionReader ignores unknown envelope types, so this is render-safe.
   */
  private translateExtensionStatus(
    r: EmitterRecord,
    ts: string,
    sessionId: string,
  ): object[] {
    if (typeof r.extension !== "string") return [];
    return [
      {
        type: "system",
        subtype: "extension_status",
        extension: r.extension,
        status: r.status,
        ...(r.mode !== undefined ? { mode: r.mode } : {}),
        ...(r.provider !== undefined ? { provider: r.provider } : {}),
        ...(r.toolCount !== undefined ? { toolCount: r.toolCount } : {}),
        ...(r.reason !== undefined ? { reason: r.reason } : {}),
        timestamp: ts,
        sessionId,
      },
    ];
  }

  /**
   * Mirror agentic-pi's gated `skills_status` event as a `system` envelope in
   * the session log — the skill-loading counterpart to
   * {@link translateExtensionStatus}. Records which skills the agent had
   * available. SessionReader ignores unknown envelope types, so render-safe.
   */
  private translateSkillsStatus(
    r: EmitterRecord,
    ts: string,
    sessionId: string,
  ): object[] {
    if (typeof r.status !== "string") return [];
    return [
      {
        type: "system",
        subtype: "skills_status",
        status: r.status,
        ...(r.discovered !== undefined ? { discovered: r.discovered } : {}),
        ...(Array.isArray(r.skills) ? { skills: r.skills } : {}),
        ...(Array.isArray(r.mappedPaths) ? { mappedPaths: r.mappedPaths } : {}),
        ...(r.noSkills !== undefined ? { noSkills: r.noSkills } : {}),
        timestamp: ts,
        sessionId,
      },
    ];
  }

  /**
   * Surface pi-coding-agent's auto-retry pause as a `system` breadcrumb so
   * rate-limit / transient-error backoffs are visible in the session timeline
   * (the dashboard renders role-based `system` lines via MetaMessage). Emitted
   * as a role-based line — unlike `extension_status`'s `type: "system"` shape,
   * which the reader drops — so it actually renders.
   */
  private translateAutoRetryStart(
    r: EmitterRecord,
    ts: string,
    sessionId: string,
  ): object[] {
    const attempt = typeof r.attempt === "number" ? r.attempt : undefined;
    const maxAttempts = typeof r.maxAttempts === "number" ? r.maxAttempts : undefined;
    const delayMs = typeof r.delayMs === "number" ? r.delayMs : undefined;
    const reason = typeof r.errorMessage === "string" ? r.errorMessage : "transient error";
    const attemptLabel =
      attempt !== undefined ? ` ${attempt}${maxAttempts !== undefined ? `/${maxAttempts}` : ""}` : "";
    const delayLabel = delayMs !== undefined ? ` in ${Math.round(delayMs / 1000)}s` : "";
    return [
      {
        role: "system",
        subtype: "auto_retry_start",
        content: `⏳ Auto-retry${attemptLabel}${delayLabel} after model error: ${shortReason(reason)}`,
        timestamp: ts,
        sessionId,
      },
    ];
  }

  /**
   * Pair to {@link translateAutoRetryStart}: a successful recovery, or a
   * give-up (when `finalError` is present).
   */
  private translateAutoRetryEnd(
    r: EmitterRecord,
    ts: string,
    sessionId: string,
  ): object[] {
    const attempt = typeof r.attempt === "number" ? r.attempt : undefined;
    const finalError = typeof r.finalError === "string" ? r.finalError : undefined;
    const attemptLabel = attempt !== undefined ? ` ${attempt}` : "";
    const content = finalError
      ? `❌ Auto-retry gave up after${attemptLabel} attempt(s): ${shortReason(finalError)}`
      : `✓ Auto-retry recovered after${attemptLabel} attempt(s).`;
    return [
      {
        role: "system",
        subtype: "auto_retry_end",
        content,
        timestamp: ts,
        sessionId,
      },
    ];
  }

  private translateMessageEnd(
    r: EmitterRecord,
    ts: string,
    sessionId: string,
  ): object[] {
    const message = (r.message ?? {}) as {
      role?: string;
      content?: Array<Record<string, unknown>>;
      usage?: Record<string, unknown>;
    };
    if (message.role !== "assistant" || !Array.isArray(message.content)) {
      return [];
    }

    // Pi's content blocks are text / thinking / toolCall. Map toolCall →
    // tool_use, and preserve thinking blocks as `thinking` blocks so the
    // dashboard's reasoning toggle (session-log.ts → AssistantMessage.tsx)
    // can surface the model's reasoning. Redacted/empty thinking is skipped.
    const out: Array<Record<string, unknown>> = [];
    for (const c of message.content) {
      if (c.type === "text" && typeof c.text === "string") {
        out.push({ type: "text", text: c.text });
      } else if (c.type === "thinking" && typeof c.thinking === "string" && c.thinking.length > 0) {
        out.push({ type: "thinking", thinking: c.thinking });
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

    // Carry pi's per-message usage onto the envelope in Claude-SDK shape
    // (input_tokens / output_tokens / cache_*). This is the only
    // compaction-proof source of usage — pi's terminal `usage_snapshot`
    // recomputes from the post-compaction message window and reports zero
    // once a phase auto-compacts. Per-message records are written at
    // finalization, before any compaction rebuild. Keeping them here also
    // lets Claude-style transcript analyzers cost the session directly.
    const assistantMessage: Record<string, unknown> = {
      role: "assistant",
      model: this.opts.model,
      content: out,
    };
    const usage = shimUsage(message.usage);
    if (usage) assistantMessage.usage = usage;

    return [
      {
        type: "assistant",
        message: assistantMessage,
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
    const rawString = typeof raw === "string" ? raw : safeStringify(raw);
    const content = truncateForLog(rawString);
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
    this.writeChain = this.writeChain
      .then(async () => {
        if (!this.sessionId) return;
        await this.sessionLog.appendEnvelopeLines(
          { projectSlug: this.opts.projectSlug, sessionId: this.sessionId },
          lines,
        );
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.warn(`[shim] failed to append jsonl: ${msg}`);
      });
  }
}

/**
 * Translate pi's per-message `usage` ({ input, output, cacheRead, cacheWrite,
 * … }) into the Claude-SDK assistant-message usage shape. Returns undefined
 * when the record carries no usage so we don't write an all-zero block.
 */
function shimUsage(
  raw: Record<string, unknown> | undefined,
): Record<string, number> | undefined {
  if (!raw || typeof raw !== "object") return undefined;
  const num = (v: unknown): number =>
    typeof v === "number" && Number.isFinite(v) ? v : 0;
  const usage = {
    input_tokens: num(raw.input),
    output_tokens: num(raw.output),
    cache_read_input_tokens: num(raw.cacheRead),
    cache_creation_input_tokens: num(raw.cacheWrite),
  };
  if (
    usage.input_tokens === 0 &&
    usage.output_tokens === 0 &&
    usage.cache_read_input_tokens === 0 &&
    usage.cache_creation_input_tokens === 0
  ) {
    return undefined;
  }
  return usage;
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

export function safeStringify(v: unknown): string {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

/** Collapse an error string to a single short line for a system breadcrumb. */
function shortReason(reason: string): string {
  const oneLine = reason.replace(/\s+/g, " ").trim();
  return oneLine.length > 200 ? `${oneLine.slice(0, 197)}…` : oneLine;
}

/**
 * Cap on the size of a single tool_result content string written to the
 * envelope jsonl. A `Read` on a multi-megabyte file or a `Bash` with huge
 * stdout would otherwise bloat both the in-memory write queue and the
 * on-disk session log. Anything past this is replaced with a marker. The
 * raw tool result still exists wherever the tool wrote it (workspace file,
 * sandbox stdout) — we just don't mirror it into the session jsonl.
 *
 * 64KB matches the rough rendering budget of the dashboard tool-result
 * panel; anything larger would have been truncated for display anyway.
 */
const TOOL_RESULT_MAX_BYTES = 64 * 1024;

export function truncateForLog(
  s: string,
  maxBytes: number = TOOL_RESULT_MAX_BYTES,
): string {
  if (s.length <= maxBytes) return s;
  const dropped = s.length - maxBytes;
  return `${s.slice(0, maxBytes)}\n…[truncated ${dropped} chars]`;
}

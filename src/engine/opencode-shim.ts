import { promises as fs } from "node:fs";
import path from "node:path";

/**
 * Translates OpenCode `--format json` event stream into Claude-SDK-style
 * envelope jsonl on disk, so the existing dashboard SessionReader
 * (`src/admin/sessions.ts`) keeps working without a code change.
 *
 * Phase 2 of the OpenCode fork plan. A native OpenCode reader is an
 * optional Phase 8 follow-up.
 *
 * Translation table (see plans/we-have-a-doc-pure-curry.md Phase 2):
 *
 *   OpenCode event          Emitted line(s)
 *   ───────────────────     ───────────────────────────────────────────
 *   first event with id     `user` envelope with the initial prompt
 *   `text` (assistant)      `assistant` with content [{type:"text"}]
 *   `tool_use`              `assistant` with content [{type:"tool_use"}],
 *                           followed by `user` with content
 *                           [{type:"tool_result"}] when state.status is
 *                           "completed" or "error".
 *   `error`                 `assistant` with isApiErrorMessage:true
 *   step_start/finish/      no-op (tally already lives in
 *   reasoning               OpencodeAccumulator)
 *
 * Tool-name shim: OpenCode names MCP tools `<server>_<tool>` (no `mcp_`
 * prefix). The dashboard classifier in
 * `dashboard/src/timeline/toolFamily.ts` matches both the lowercased
 * `mcp_` prefix and the bare `github_` prefix, but other MCP-prefixed
 * branches require the `mcp_` form. We prepend `mcp_` when `<server>`
 * matches one of the configured MCP server names.
 */
export interface ClaudeJsonlShimOptions {
  /** Root session-home directory (the dir that contains `projects/`). */
  homeDir: string;
  /** Project-dir slug, e.g. "-home-agent-workspace". */
  projectSlug: string;
  /** Names of MCP servers as configured in `opencode.json`. */
  mcpServerNames?: string[];
  /** Model id passed to the runtime — surfaced on assistant envelopes. */
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

export class ClaudeJsonlShim {
  private opts: ClaudeJsonlShimOptions;
  private mcpSet: Set<string>;
  private filePath: string | null = null;
  private writeChain: Promise<void> = Promise.resolve();
  private initialWritten = false;

  constructor(opts: ClaudeJsonlShimOptions) {
    this.opts = opts;
    this.mcpSet = new Set(opts.mcpServerNames ?? []);
  }

  /** True once a session id has been observed and the target file is set. */
  get isInitialized(): boolean {
    return this.filePath !== null;
  }

  /**
   * Feed one parsed OpenCode event object. Safe to call before the
   * sessionID has appeared — the first event with a `sessionID` finalises
   * the on-disk file path. Events before that are dropped (defensive;
   * OpenCode emits `sessionID` on every event empirically).
   */
  feed(evt: unknown): void {
    if (!evt || typeof evt !== "object") return;
    const e = evt as Record<string, unknown>;
    const sessionId = typeof e.sessionID === "string" ? (e.sessionID as string) : null;
    if (!sessionId) return;

    if (!this.filePath) {
      // sessionId comes from OpenCode's stdout. Strip any path separators
      // and require a conservative charset so a hostile/corrupted value
      // can't traverse out of projects/<slug>/.
      const safeId = path.basename(sessionId);
      if (!/^[A-Za-z0-9_-]+$/.test(safeId)) return;
      const dir = path.join(this.opts.homeDir, "projects", this.opts.projectSlug);
      this.filePath = path.join(dir, `${safeId}.jsonl`);
    }

    const ts = isoTimestamp(e.timestamp);
    const lines: object[] = [];

    if (!this.initialWritten) {
      this.initialWritten = true;
      lines.push({
        type: "user",
        message: { role: "user", content: this.opts.initialPrompt },
        timestamp: ts,
        sessionId,
      });
    }

    const out = this.translate(e, ts, sessionId);
    if (out.length) lines.push(...out);

    if (lines.length === 0) return;
    this.appendLines(lines);
  }

  /**
   * Append an optional `result` envelope mirroring the legacy
   * Claude-stream `result` line. Mirrors `executor.ts` semantics that the
   * dashboard already understands (though it ignores unknown types
   * gracefully — this is informational).
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

  /** Wait for all queued writes to flush to disk. */
  async flush(): Promise<void> {
    await this.writeChain;
  }

  /** Translate `<server>_<tool>` to `mcp_<server>_<tool>` when known. */
  private translateToolName(name: string): string {
    const idx = name.indexOf("_");
    if (idx <= 0) return name;
    const head = name.slice(0, idx);
    if (this.mcpSet.has(head)) return `mcp_${name}`;
    return name;
  }

  private translate(
    e: Record<string, unknown>,
    ts: string,
    sessionId: string,
  ): object[] {
    const type = e.type as string | undefined;
    const part = (e.part ?? {}) as Record<string, unknown>;

    if (type === "text") {
      const text = part.text;
      if (typeof text !== "string" || text.length === 0) return [];
      return [{
        type: "assistant",
        message: {
          role: "assistant",
          model: this.opts.model,
          content: [{ type: "text", text }],
        },
        timestamp: ts,
        sessionId,
      }];
    }

    if (type === "tool_use") {
      const tool = part.tool;
      const callID = part.callID;
      if (typeof tool !== "string" || typeof callID !== "string") return [];
      const state = (part.state ?? {}) as Record<string, unknown>;
      const translated = this.translateToolName(tool);

      const lines: object[] = [{
        type: "assistant",
        message: {
          role: "assistant",
          model: this.opts.model,
          content: [{
            type: "tool_use",
            id: callID,
            name: translated,
            input: state.input ?? {},
          }],
        },
        timestamp: ts,
        sessionId,
      }];

      const status = state.status as string | undefined;
      if (status === "completed" || status === "error") {
        const raw = state.output ?? state.error ?? "";
        const content = typeof raw === "string" ? raw : safeStringify(raw);
        const block: Record<string, unknown> = {
          type: "tool_result",
          tool_use_id: callID,
          content,
        };
        if (status === "error") block.is_error = true;
        lines.push({
          type: "user",
          message: { role: "user", content: [block] },
          timestamp: ts,
          sessionId,
        });
      }
      return lines;
    }

    if (type === "error") {
      const err = (e.error ?? {}) as Record<string, unknown>;
      const data = (err.data ?? {}) as Record<string, unknown>;
      const msg = (data.message as string | undefined)
        ?? (err.name as string | undefined)
        ?? "API error";
      return [{
        type: "assistant",
        isApiErrorMessage: true,
        error: String(msg),
        timestamp: ts,
        sessionId,
      }];
    }

    return [];
  }

  private appendLines(lines: object[]): void {
    const data = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
    this.writeChain = this.writeChain.then(async () => {
      if (!this.filePath) return;
      await fs.mkdir(path.dirname(this.filePath), { recursive: true });
      await fs.appendFile(this.filePath, data);
    }).catch((err: unknown) => {
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
 * Convert a filesystem cwd to the Claude-SDK-convention project-dir
 * slug used under `opencode-home/projects/`. The slug is the absolute
 * path with `/` replaced by `-`.
 *
 *   "/home/agent/workspace" → "-home-agent-workspace"
 *   "/app"                  → "-app"
 */
export function projectSlugForCwd(cwd: string): string {
  return cwd.replace(/\//g, "-");
}

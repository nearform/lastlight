/**
 * Programmatic entry point.
 *
 * Use this when calling agentic-pi in-process from a Node host (e.g.
 * lastlight). It returns a fully-resolved `RunResult` carrying the same
 * information lastlight's `opencode-executor` needs from the JSONL stream
 * (sessionId, finalText, tokens, cost, sandbox + GitHub status, etc.)
 * plus the raw event records so the caller can do anything else they want
 * with them.
 *
 * Never writes to `process.stdout` or `process.stderr`. Hand it an
 * `onEvent` and/or `onWarn` callback if you want to observe live.
 */

import type { RunConfig } from "./args.js";

/**
 * Pi thinking level. Matches Pi's `thinkingLevel` enum. Kept as a local
 * string-union rather than imported from `@earendil-works/pi-agent-core`
 * (which is a transitive dep we don't import directly — see AGENTS.md
 * hard rule #3).
 */
export type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
import {
  CollectorSink,
  TeeSink,
  type EmitterRecord,
  type EmitterSink,
} from "./emitter.js";
import { runOnce, type RunOnceExitCode } from "./runner.js";

export interface RunOptions {
  // ── Required ────────────────────────────────────────────────────
  /** "provider/model_id", e.g. "anthropic/claude-haiku-4-5". */
  model: string;
  /** The prompt to send to the agent. */
  prompt: string;

  // ── Optional, mirror the CLI flags ──────────────────────────────
  /** Pi thinking level. */
  thinking?: ThinkingLevel;
  /** GitHub profile: "read" | "issues-write" | "review-write" | "repo-write". */
  profile?: string;
  /** Sandbox backend. Default: "none". */
  sandbox?: "none" | "gondolin";
  /**
   * Image to boot when `sandbox: "gondolin"`. Values:
   *   - `"default"` (recommended) — bundled `agentic-pi-dev` image
   *     (auto-downloaded into `~/.cache/agentic-pi/images/`).
   *   - `"gondolin-builtin"` — stock `alpine-base:latest`, no toolchain.
   *   - absolute path — local `gondolin build` output directory.
   * Default: `"default"`.
   */
  sandboxImage?: string;
  /** Working directory. Default: process.cwd(). */
  cwd?: string;
  /** Skip session persistence. Default: false. */
  noSession?: boolean;
  /** Override session storage directory. */
  sessionDir?: string;
  /** Disable Pi's built-in tools (read/write/edit/bash/grep/find/ls). */
  noBuiltinTools?: boolean;
  /** Explicit tool allowlist. */
  tools?: string[];
  /**
   * Environment variables to inject into the sandbox VM (ignored when
   * `sandbox: "none"`). When `sandbox: "gondolin"` with a `profile`
   * configured, a short-lived GitHub installation token is auto-injected
   * as `GITHUB_TOKEN` + `GH_TOKEN` — values here override the auto ones.
   */
  sandboxEnv?: Record<string, string>;
  /**
   * HTTP egress allowlist for the sandbox VM. Without this, gondolin's
   * HTTP interceptor returns 502 to every outbound request.
   *
   *   - `undefined` (default): allow the standard GitHub hosts + common
   *      public package registries (npm, pypi, crates, go, rubygems,
   *      alpine/debian apt). See `DEFAULT_GUEST_ALLOWED_HOSTS` in
   *      `sandbox/gondolin.ts` for the exact list.
   *   - explicit `string[]`: caller-supplied allowlist (replaces default).
   *   - `null`: disable HTTP hooks entirely; gondolin blocks egress.
   *
   * Ignored when `sandbox: "none"`.
   */
  allowedHttpHosts?: string[] | null;

  /**
   * Web-search extension toggle. Default: `true` (auto-enables when a
   * provider API key env var is present). Set to `false` to suppress the
   * `web_search` / `web_fetch` tools entirely.
   */
  webSearch?: boolean;
  /**
   * Force a specific web-search provider: `"tavily" | "brave" | "exa"`.
   * Overrides env-var-based auto-detection. The matching API key env var
   * (`TAVILY_API_KEY`, `BRAVE_SEARCH_API_KEY`, `EXA_API_KEY`) must still
   * be present; otherwise the extension skips with a warning.
   */
  webSearchProvider?: "tavily" | "brave" | "exa";
  /**
   * Per-run cap on combined `web_search` + `web_fetch` calls. Default: 30.
   * Once exceeded, further calls return a structured rate-limit error
   * payload (the agent can recover).
   */
  webSearchMaxCalls?: number;

  /**
   * File-search extension (FFF) toggle. Default: `true` — bundled and
   * enabled for every run. Set to `false` to fall back to Pi's built-in
   * `find`/`grep`.
   */
  fileSearch?: boolean;
  /**
   * FFF mode. Default: `"override"` (FFF replaces built-in `find`/`grep`
   * under the same names). The `PI_FFF_MODE` env var, if set, wins.
   */
  fileSearchMode?: "override" | "tools-only" | "tools-and-ui";

  /**
   * Extra Agent Skill paths to load, beyond Pi's default discovery
   * (`~/.pi/agent/skills`, `~/.agents/skills`, `.pi/skills`, `.agents/skills`,
   * package `skills/`). Each entry is a directory of skills OR a single skill
   * dir/file. Additive even with `noSkills`. Maps e.g. `~/.claude/skills` into
   * the agent.
   */
  skillPaths?: string[];
  /**
   * Disable Pi's default skill discovery. Explicit `skillPaths` still load.
   * Default: discovery enabled (Pi's default).
   */
  noSkills?: boolean;

  // ── OpenTelemetry ───────────────────────────────────────────────
  /**
   * Enable OTEL traces + metrics export. Default: `false` (or env
   * `AGENTIC_PI_OTEL_ENABLED=1`). `false` here force-disables. Requires an
   * OTLP endpoint via `OTEL_EXPORTER_OTLP_ENDPOINT` or `otelEndpoint`.
   * Standard `OTEL_*` env vars are honored by the SDK. Sandbox/env-driven
   * callers can leave this unset and rely on `AGENTIC_PI_OTEL_ENABLED`.
   */
  otel?: boolean;
  /** Attach bounded raw content to spans. Default: `false` (metadata-only). */
  otelIncludeContent?: boolean;
  /** Override OTEL service name (default: "agentic-pi"). */
  otelServiceName?: string;
  /** Override the OTLP endpoint base URL (escape hatch; prefer the env var). */
  otelEndpoint?: string;

  // ── Observability hooks ─────────────────────────────────────────
  /**
   * Called for every emitted JSONL record in order. Same shape that the
   * CLI writes to stdout, with `sessionId` and `timestamp` already injected.
   * Use this to mirror events into your own jsonl file, push deltas to a
   * UI, or persist sessionId early.
   */
  onEvent?: (record: EmitterRecord) => void;

  /**
   * Called for human-readable warnings (e.g. partial GitHub creds). The
   * CLI writes these to stderr; in-process callers usually want to log
   * them somewhere structured.
   */
  onWarn?: (message: string) => void;

  /**
   * Extra sink to fan records out to (in addition to the internal
   * collector that powers `result.records`). Useful if you want to write
   * the shim jsonl directly without buffering through onEvent.
   */
  extraSink?: EmitterSink;
}

/** Outcome of one agentic-pi run. */
export interface RunResult {
  /** Exit code the CLI would have returned (0 = ok, 1 = runtime error, 2 = config error). */
  exitCode: RunOnceExitCode;
  /** True iff `exitCode === 0`. */
  ok: boolean;
  /** True iff Pi emitted an `agent_end` (clean termination). */
  agentEnded: boolean;
  /** True iff at least one tool returned an error. */
  toolErrors: boolean;
  /** If a fatal error short-circuited the run, this is set. */
  fatalError?: { name: string; message: string };

  /** Pi session id (from the session header line). May be undefined if preflight failed. */
  sessionId?: string;
  /** cwd the agent ran in. */
  cwd?: string;
  /** ISO timestamp of session start. */
  startedAt?: string;

  /** Concatenated final assistant text (the agent's "answer"). */
  finalText: string;
  /** Full message array from `agent_end` (user + assistant + toolResult messages). */
  messages: unknown[];

  /** Stats from the synthesized `usage_snapshot` event. */
  stats?: {
    userMessages: number;
    assistantMessages: number;
    toolCalls: number;
    toolResults: number;
    tokens: { input: number; output: number; cacheRead: number; cacheWrite: number; total: number };
    cost: number;
  };

  /** Mirrors of the `sandbox_status` and `extension_status` lines. */
  sandbox?: { backend: string; status: Record<string, unknown> };
  github?: {
    status: "configured" | "skipped";
    reason?: string;
    message?: string;
    profile?: string;
    toolCount: number;
  };
  webSearch?: {
    status: "configured" | "skipped";
    reason?: string;
    message?: string;
    provider?: string;
    toolCount: number;
    maxCalls?: number;
  };
  fileSearch?: {
    status: "configured" | "skipped";
    reason?: string;
    message?: string;
    mode?: string;
    toolCount: number;
  };
  /**
   * Mirror of the `skills_status` line. Present only when skills were
   * configured (`skillPaths`/`noSkills`) or at least one skill was discovered;
   * absent on a default run with no skills (matching the gated event).
   */
  skills?: {
    status: "default" | "configured" | "disabled";
    discovered: number;
    skills: Array<{ name: string; source: string; modelInvocable: boolean }>;
    mappedPaths: string[];
    noSkills: boolean;
  };
  /**
   * Mirror of the telemetry `extension_status` line. Present only when OTEL
   * was requested (enabled or explicitly disabled); absent on a default run.
   */
  telemetry?: {
    status: "configured" | "skipped";
    reason?: string;
    message?: string;
    includeContent?: boolean;
  };

  /** Every JSONL record the run emitted, in order. */
  records: EmitterRecord[];
  /** Warnings that would have gone to stderr in CLI mode. */
  warnings: string[];
}

/**
 * Run agentic-pi in-process and return a fully-derived result.
 *
 * @example
 * ```ts
 * import { run } from "agentic-pi";
 *
 * const result = await run({
 *   model: "anthropic/claude-haiku-4-5",
 *   prompt: "list the open PRs on owner/repo",
 *   profile: "read",
 *   noSession: true,
 * });
 *
 * console.log(result.finalText);
 * console.log(result.stats?.cost, "USD");
 * ```
 */
export async function run(options: RunOptions): Promise<RunResult> {
  const config: RunConfig = {
    model: options.model,
    thinking: options.thinking,
    profile: options.profile,
    cwd: options.cwd ?? process.cwd(),
    noSession: options.noSession ?? false,
    sessionDir: options.sessionDir,
    noBuiltinTools: options.noBuiltinTools ?? false,
    tools: options.tools,
    dangerouslySkipPermissions: false,
    sandbox: options.sandbox ?? "none",
    sandboxEnv: options.sandboxEnv,
    sandboxImage: options.sandboxImage,
    allowedHttpHosts: options.allowedHttpHosts,
    webSearch: options.webSearch ?? true,
    webSearchProvider: options.webSearchProvider,
    webSearchMaxCalls: options.webSearchMaxCalls,
    fileSearch: options.fileSearch ?? true,
    fileSearchMode: options.fileSearchMode,
    skillPaths: options.skillPaths,
    noSkills: options.noSkills,
    otel: options.otel,
    otelIncludeContent: options.otelIncludeContent,
    otelServiceName: options.otelServiceName,
    otelEndpoint: options.otelEndpoint,
  };

  const collector = new CollectorSink(options.onEvent);
  const sink: EmitterSink = options.extraSink
    ? new TeeSink([collector, options.extraSink])
    : collector;

  const warnings: string[] = [];
  const onWarn = (msg: string) => {
    warnings.push(msg);
    options.onWarn?.(msg);
  };

  const exitCode = await runOnce(config, options.prompt, { sink, onWarn });

  return buildResult(exitCode, collector.records, warnings);
}

function buildResult(
  exitCode: RunOnceExitCode,
  records: EmitterRecord[],
  warnings: string[],
): RunResult {
  const result: RunResult = {
    exitCode,
    ok: exitCode === 0,
    agentEnded: false,
    toolErrors: false,
    finalText: "",
    messages: [],
    records,
    warnings,
  };

  for (const r of records) {
    switch (r.type) {
      case "session":
        result.sessionId = r.id as string;
        result.cwd = r.cwd as string;
        result.startedAt = r.timestamp as string;
        break;

      case "sandbox_status":
        result.sandbox = {
          backend: r.backend as string,
          status: (r.status as Record<string, unknown>) ?? {},
        };
        break;

      case "extension_status":
        if (r.extension === "github") {
          result.github = {
            status: r.status as "configured" | "skipped",
            reason: r.reason as string | undefined,
            message: r.message as string | undefined,
            profile: r.profile as string | undefined,
            toolCount: (r.toolCount as number) ?? 0,
          };
        } else if (r.extension === "web-search") {
          result.webSearch = {
            status: r.status as "configured" | "skipped",
            reason: r.reason as string | undefined,
            message: r.message as string | undefined,
            provider: r.provider as string | undefined,
            toolCount: (r.toolCount as number) ?? 0,
            maxCalls: r.maxCalls as number | undefined,
          };
        } else if (r.extension === "file-search") {
          result.fileSearch = {
            status: r.status as "configured" | "skipped",
            reason: r.reason as string | undefined,
            message: r.message as string | undefined,
            mode: r.mode as string | undefined,
            toolCount: (r.toolCount as number) ?? 0,
          };
        } else if (r.extension === "telemetry") {
          result.telemetry = {
            status: r.status as "configured" | "skipped",
            reason: r.reason as string | undefined,
            message: r.message as string | undefined,
            includeContent: r.includeContent as boolean | undefined,
          };
        }
        break;

      case "skills_status":
        result.skills = {
          status: r.status as "default" | "configured" | "disabled",
          discovered: (r.discovered as number) ?? 0,
          skills: (r.skills as NonNullable<RunResult["skills"]>["skills"]) ?? [],
          mappedPaths: (r.mappedPaths as string[]) ?? [],
          noSkills: (r.noSkills as boolean) ?? false,
        };
        break;

      case "message_end": {
        // Accumulate assistant text. Pi's message structure:
        // r.message = { role: "assistant", content: [{type:"text", text:"…"}, ...] }
        const m = r.message as { role?: string; content?: Array<{ type?: string; text?: string }> } | undefined;
        if (m?.role === "assistant" && Array.isArray(m.content)) {
          // Keep only the LATEST assistant text (final answer overwrites
          // intermediate ones). Pi guarantees the last assistant message
          // before agent_end is the final answer.
          const text = m.content
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text as string)
            .join("");
          if (text) result.finalText = text;
        }
        break;
      }

      case "tool_execution_end":
        if (r.isError === true) result.toolErrors = true;
        break;

      case "agent_end":
        result.agentEnded = true;
        if (Array.isArray(r.messages)) {
          result.messages = r.messages as unknown[];
        }
        break;

      case "usage_snapshot":
        result.stats = r.stats as RunResult["stats"];
        break;

      case "fatal_error":
        result.fatalError = r.error as { name: string; message: string };
        break;
    }
  }

  return result;
}

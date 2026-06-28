import { resolve, basename, join } from "path";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, rmSync, symlinkSync } from "fs";
import type { RunResult, ThinkingLevel } from "agentic-pi";
import {
  type ExecutorConfig,
  type ExecutionResult,
  type ExtensionStatusMap,
  type SkillsStatus,
} from "../github/profiles.js";
import { AgenticShim, truncateForLog, safeStringify } from "../event-shim.js";
import { BuildAssetStore, type BuildAssetRef } from "../../state/build-assets.js";

/**
 * Shared building blocks for the per-backend executors
 * ({@link ../executors/backends.ts}). These have NO dependency on the
 * executors or the dispatcher, so the import DAG stays acyclic:
 * shared → backends → agent-executor.
 */

export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";
export const DOCKER_WORKSPACE_DIR = "/home/agent/workspace";
// Directory holding one skill bundle per phase. Deliberately NOT named
// `.agents/skills` (pi's auto-discovery path): we map each phase's bundle
// explicitly via --skill / skillPaths so two phases sharing a workspace —
// sequential today, parallel via worktrees tomorrow — can never clobber each
// other's catalogue. The agent keeps cwd = the repo (no `cd` preamble on
// every command); the bundle is staged at the workspace ROOT — a sibling of
// the repo, never in its git tree — and reached by an absolute path. On
// docker/none that root is genuinely outside the repo. gondolin mounts only
// cwd, so there the bundle is staged under the repo and added to the
// checkout's local `.git/info/exclude` (never committed; see `excludeFromGit`).
export const SKILL_BUNDLE_ROOT = ".lastlight-skills";
export const THINKING_LEVELS: ReadonlySet<string> = new Set([
  "off", "minimal", "low", "medium", "high", "xhigh",
]);

/**
 * Stage this phase's declared skills into a per-phase bundle directory at
 * `<workspaceRoot>/.lastlight-skills/<phaseKey>/<basename>/` and return the
 * staged skill dirs, so the caller can point pi at them explicitly (via
 * `--skill` for docker or `skillPaths` for the in-process backends). Each
 * skill is a directory containing SKILL.md plus any `scripts/` / `references/`
 * / `assets/` — the whole tree comes along.
 *
 * Keyed by phase so concurrent phases in one workspace never touch each
 * other's bundle: only the phase's own `<phaseKey>` subtree is cleared, so a
 * clean slate per phase doesn't disturb a sibling phase mid-run.
 *
 * `mode` controls how each skill lands:
 *   - "symlink": one symlink per skill → host source. gondolin/none, where pi
 *     reads skill files host-side / through the cwd mount. Zero-copy.
 *   - "copy": recursive copy. docker, where the agent's tools run inside the
 *     container and host symlink targets wouldn't resolve; the copy lands
 *     under the bind-mounted workspace.
 *
 * Returns `undefined` when the phase declares no skills (after clearing its
 * bundle), so a phase with no `skills:` gets no catalogue at all.
 */
export function stageSkillBundle(
  workspaceRoot: string,
  phaseKey: string,
  skillPaths: string[] | undefined,
  mode: "symlink" | "copy",
): string[] | undefined {
  const bundleDir = join(workspaceRoot, SKILL_BUNDLE_ROOT, phaseKey);
  if (existsSync(bundleDir)) {
    rmSync(bundleDir, { recursive: true, force: true });
  }
  if (!skillPaths?.length) return undefined;
  mkdirSync(bundleDir, { recursive: true });
  const staged: string[] = [];
  for (const hostPath of skillPaths) {
    const dest = join(bundleDir, basename(hostPath));
    if (mode === "symlink") {
      symlinkSync(hostPath, dest, "dir");
    } else {
      cpSync(hostPath, dest, { recursive: true, dereference: true });
    }
    staged.push(dest);
  }
  return staged;
}

/**
 * Sanitized per-phase key for the skill bundle directory. Phase name first
 * (unique even for loop iterations like `reviewer_fix_1`), then workflow name,
 * then a constant fallback — so the bundle is always isolated per phase.
 */
export function skillBundleKey(config: ExecutorConfig): string {
  const raw = config.telemetry?.phaseName || config.telemetry?.workflowName || "phase";
  return raw.replace(/[^A-Za-z0-9_-]/g, "_") || "phase";
}

/**
 * Add `entry` to a checkout's local `.git/info/exclude` (idempotent) so the
 * agent's own `git add`/`commit` can never pick it up. This file lives inside
 * `.git/` — it is never tracked, committed, or pushed, and it leaves the repo's
 * real `.gitignore` untouched; the exclusion applies only to this ephemeral
 * sandbox checkout. Used for the gondolin backend, where the skill bundle must
 * be staged under cwd (the only mounted dir) rather than as an out-of-repo
 * sibling. No-op when `repoDir` isn't a git checkout (e.g. the workspace root).
 */
export function excludeFromGit(repoDir: string, entry: string): void {
  const gitDir = join(repoDir, ".git");
  if (!existsSync(gitDir)) return; // not a checkout — nothing to exclude
  const infoDir = join(gitDir, "info");
  const excludeFile = join(infoDir, "exclude");
  const line = `/${entry}/`;
  let current = "";
  try { current = readFileSync(excludeFile, "utf8"); } catch { /* may not exist yet */ }
  if (current.split(/\r?\n/).includes(line)) return;
  mkdirSync(infoDir, { recursive: true });
  appendFileSync(excludeFile, `${current.length && !current.endsWith("\n") ? "\n" : ""}${line}\n`);
}

// ── Server-mode build assets ────────────────────────────────────────
//
// In "server" mode the per-phase handoff docs live in the Last Light store
// rather than being committed into the target repo. The seam is symmetric to
// the skill bundle but bidirectional: stage the run's stored docs into the
// repo's `.lastlight/<issueKey>/` before the agent runs (so a later phase /
// resumed run sees prior context), and harvest whatever the phase wrote back
// to the store afterwards. The directory is the SAME relative path as repo
// mode (`{{issueDir}}`), so prompts are unchanged except for gating their
// `git add .lastlight/ && commit` off — the dir is git-excluded here too as a
// backstop against the agent's `git add -A` feature commit sweeping it in.
const ARTIFACT_DIR_ROOT = ".lastlight";

export interface ServerArtifacts {
  store: BuildAssetStore;
  ref: BuildAssetRef;
  /** Host path to `<repo>/.lastlight/<issueKey>` (the staged doc dir). */
  dir: string;
  /** Host path to the repo checkout root. */
  repoDir: string;
}

/**
 * Resolve the server-mode artifact context for a run, or undefined when not in
 * server mode (the default — the whole seam is then skipped and behaviour is
 * byte-for-byte repo mode). `hostRepoDir` is the host-visible repo checkout
 * (for docker that's the bind-mounted workspace path, not the in-container one).
 */
export function serverArtifacts(config: ExecutorConfig, hostRepoDir: string): ServerArtifacts | undefined {
  if (config.buildAssets !== "server" || !config.buildAssetsDir || !config.buildAssetsKey) {
    return undefined;
  }
  const store = new BuildAssetStore(config.buildAssetsDir);
  const ref = config.buildAssetsKey;
  return { store, ref, dir: join(hostRepoDir, ARTIFACT_DIR_ROOT, ref.issueKey), repoDir: hostRepoDir };
}

/** Stage stored docs into the workspace + exclude the dir from git (server mode). */
export function stageArtifactsIn(art: ServerArtifacts | undefined): void {
  if (!art) return;
  try {
    // Stage the run's stored docs into `<repoDir>/.lastlight/<issueKey>/`. This
    // is safe for every workflow shape here: pre-cloned workflows (build, pr-*)
    // already have the checkout at `repoDir`, and non-pre-cloned ones (explore)
    // clone the repo into a *subdir* — so `repoDir` is the workspace root and a
    // `.lastlight/` there never collides with the agent's clone. (A future
    // workflow that `git clone … .` into cwd would be the one exception.)
    art.store.stageInto(art.ref, art.dir);
    // Backstop the prompt-level commit gate: when this is a real checkout, keep
    // the docs out of the agent's `git add -A` feature commit. No-op at the
    // workspace root (no `.git`), where the docs sit outside the repo subtree
    // and are never in the repo's git tree anyway.
    excludeFromGit(art.repoDir, ARTIFACT_DIR_ROOT);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[executor] Could not stage build assets: ${msg}`);
  }
}

/** Persist docs the phase wrote back to the store (server mode). */
export function harvestArtifactsOut(art: ServerArtifacts | undefined): void {
  if (!art) return;
  try {
    art.store.harvestFrom(art.ref, art.dir);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[executor] Could not harvest build assets: ${msg}`);
  }
}

export class RunResultAccumulator {
  private sessionId?: string;
  private finalText = "";
  private agentEnded = false;
  private toolErrors = false;
  private maxStepsReached = false;
  private lastToolError?: { tool?: string; message: string };
  // True iff the last assistant turn ended with a tool call — i.e. the agent
  // asked for a tool and the loop terminated before it could respond to the
  // result. That's a truncated run (pi hit its internal step cap mid-task),
  // not a finished one. See `finalizeFromRunResult`'s truncation guard.
  private lastAssistantHadToolCall = false;
  private fatalError?: { name: string; message: string };
  private snapshotStats?: RunResult["stats"];
  private messages: unknown[] = [];

  // Per-message usage accumulation (the compaction-proof source).
  private assistantMessages = 0;
  private userMessages = 0;
  private toolCalls = 0;
  private toolResults = 0;
  private msgInput = 0;
  private msgOutput = 0;
  private msgCacheRead = 0;
  private msgCacheWrite = 0;
  private msgCost = 0;

  // Extension status events (file-search / github / web-search), keyed by
  // extension name. Emitted once each at run start; we keep the raw payload
  // (minus type/extension) so build() can map them onto the RunResult.
  private ext: Record<string, Record<string, unknown>> = {};

  // Skill-loading status. agentic-pi emits a single (gated) `skills_status`
  // event at run start; we keep the raw payload (minus type) so skills()
  // can normalize it onto the RunResult, mirroring `ext` above for tools.
  private skillsRaw?: Record<string, unknown>;

  feed(r: Record<string, unknown>): void {
    switch (r.type) {
      case "session":
        if (typeof r.id === "string") this.sessionId = r.id;
        break;
      case "extension_status": {
        if (typeof r.extension === "string") {
          const { type: _t, extension: _e, ...rest } = r;
          this.ext[r.extension] = rest;
        }
        break;
      }
      case "skills_status": {
        const { type: _t, ...rest } = r;
        this.skillsRaw = rest;
        break;
      }
      case "message_end": {
        const m = r.message as
          | {
              role?: string;
              content?: Array<{ type?: string; text?: string }>;
              usage?: Record<string, unknown>;
            }
          | undefined;
        if (m?.role === "assistant" && Array.isArray(m.content)) {
          const text = m.content
            .filter((c) => c.type === "text" && typeof c.text === "string")
            .map((c) => c.text as string)
            .join("");
          if (text) this.finalText = text;
          this.assistantMessages += 1;
          const toolCallsInTurn = m.content.filter((c) => c.type === "toolCall").length;
          this.toolCalls += toolCallsInTurn;
          // Track whether the *latest* assistant turn requested a tool. If the
          // run ends here (no synthesis turn follows the tool result), the
          // agent was cut off mid-task.
          this.lastAssistantHadToolCall = toolCallsInTurn > 0;
          this.accumulateUsage(m.usage);
        } else if (m?.role === "user") {
          this.userMessages += 1;
        }
        break;
      }
      case "tool_execution_end":
        this.toolResults += 1;
        if (r.isError === true) {
          this.toolErrors = true;
          // Keep the actual failure text (not just a boolean) so a run that
          // ends in `error_tool` can report which tool failed and why —
          // e.g. a provider `insufficient_quota` surfaced through an MCP
          // call, or a bash command's stderr. Last error wins (it's the
          // one that ended the run). truncate: tool output can be huge.
          const raw = r.error ?? r.result ?? r.output;
          const message = truncateForLog(
            typeof raw === "string" ? raw : safeStringify(raw),
            4096,
          );
          const tool =
            typeof r.tool === "string"
              ? r.tool
              : typeof r.toolName === "string"
              ? r.toolName
              : undefined;
          if (message) this.lastToolError = { tool, message };
        }
        break;
      case "agent_end":
        this.agentEnded = true;
        if (Array.isArray(r.messages)) this.messages = r.messages;
        break;
      case "max_steps_reached":
        this.maxStepsReached = true;
        break;
      case "usage_snapshot":
        this.snapshotStats = r.stats as RunResult["stats"];
        break;
      case "fatal_error":
        this.fatalError = r.error as { name: string; message: string };
        break;
    }
  }

  private accumulateUsage(usage: Record<string, unknown> | undefined): void {
    if (!usage || typeof usage !== "object") return;
    const num = (v: unknown): number =>
      typeof v === "number" && Number.isFinite(v) ? v : 0;
    this.msgInput += num(usage.input);
    this.msgOutput += num(usage.output);
    this.msgCacheRead += num(usage.cacheRead);
    this.msgCacheWrite += num(usage.cacheWrite);
    const cost = usage.cost as { total?: unknown } | undefined;
    if (cost && typeof cost === "object") this.msgCost += num(cost.total);
  }

  /** Stats summed from per-message usage, or undefined if none was seen. */
  private accumulatedStats(): RunResult["stats"] | undefined {
    const total =
      this.msgInput + this.msgOutput + this.msgCacheRead + this.msgCacheWrite;
    if (this.assistantMessages === 0 && total === 0) return undefined;
    return {
      userMessages: this.userMessages,
      assistantMessages: this.assistantMessages,
      toolCalls: this.toolCalls,
      toolResults: this.toolResults,
      tokens: {
        input: this.msgInput,
        output: this.msgOutput,
        cacheRead: this.msgCacheRead,
        cacheWrite: this.msgCacheWrite,
        total,
      },
      cost: this.msgCost,
    };
  }

  /**
   * Prefer the per-message accumulation (compaction-proof) over pi's
   * terminal `usage_snapshot`. Fall back to the snapshot only when the
   * accumulation carries no token data — e.g. a provider that doesn't
   * report per-message usage — so a non-compacted snapshot still wins.
   */
  bestStats(): RunResult["stats"] | undefined {
    const acc = this.accumulatedStats();
    if (acc && acc.tokens.total > 0) return acc;
    return this.snapshotStats ?? acc;
  }

  build(exitCode: 0 | 1 | 2): RunResult {
    return {
      exitCode: exitCode as RunResult["exitCode"],
      ok: exitCode === 0 && !this.fatalError,
      agentEnded: this.agentEnded,
      toolErrors: this.toolErrors,
      maxStepsReached: this.maxStepsReached,
      fatalError: this.fatalError,
      sessionId: this.sessionId,
      finalText: this.finalText,
      messages: this.messages,
      stats: this.bestStats(),
      records: [],
      warnings: [],
    };
  }

  /**
   * Normalized extension status captured from `extension_status` events
   * (file-search / github / web-search), or undefined if none reported.
   * Decoupled from agentic-pi's `RunResult` type, which lags the runtime —
   * the docker sandbox's agentic-pi emits file-search even when the harness's
   * pinned `RunResult` type doesn't yet declare it.
   */
  extensions(): ExtensionStatusMap | undefined {
    const out: ExtensionStatusMap = {};
    for (const [name, v] of Object.entries(this.ext)) {
      if (v && typeof v.status === "string") {
        out[name] = {
          status: v.status,
          ...(typeof v.mode === "string" ? { mode: v.mode } : {}),
          ...(typeof v.provider === "string" ? { provider: v.provider } : {}),
          ...(typeof v.toolCount === "number" ? { toolCount: v.toolCount } : {}),
          ...(typeof v.reason === "string" ? { reason: v.reason } : {}),
        };
      }
    }
    return Object.keys(out).length > 0 ? out : undefined;
  }

  /**
   * Normalized skill-loading status from the gated `skills_status` event, or
   * undefined if none was reported (agentic-pi suppresses it on a run that
   * configured no skills and discovered none). The skill-loading counterpart
   * to {@link extensions}.
   */
  skills(): SkillsStatus | undefined {
    const s = this.skillsRaw;
    if (!s || typeof s.status !== "string") return undefined;
    const skills = Array.isArray(s.skills)
      ? s.skills
          .filter((x): x is Record<string, unknown> => !!x && typeof x === "object")
          .map((x) => ({
            name: typeof x.name === "string" ? x.name : "",
            source: typeof x.source === "string" ? x.source : "",
            modelInvocable: x.modelInvocable === true,
          }))
      : [];
    return {
      status: s.status,
      discovered: typeof s.discovered === "number" ? s.discovered : skills.length,
      skills,
      mappedPaths: Array.isArray(s.mappedPaths)
        ? s.mappedPaths.filter((p): p is string => typeof p === "string")
        : [],
      noSkills: s.noSkills === true,
    };
  }

  /**
   * The last tool result that came back with `isError: true`, including the
   * failure text — or undefined if no tool errored. This is what turns a
   * bare `error_tool` stop reason into a human-readable cause.
   */
  toolError(): { tool?: string; message: string } | undefined {
    return this.lastToolError;
  }

  /**
   * True iff the run's final assistant turn ended on a tool call — meaning
   * the agent intended to keep going but the loop stopped before it could
   * respond to the tool result and write its answer. The signal a run was
   * truncated (step-limit) rather than genuinely finished.
   */
  endedOnToolCall(): boolean {
    return this.lastAssistantHadToolCall;
  }
}

// ── Helpers ─────────────────────────────────────────────────────────

/** Provider account/billing/auth failures pi may surface as error text. */
const ACCOUNT_ERROR_MARKERS = [
  "credit balance",
  "insufficient_quota",
  "insufficient quota",
  "rate limit",
  "unauthorized",
  "invalid_api_key",
];

/**
 * Detect a provider account error (out of credit, quota, rate-limited, bad key)
 * that pi may have surfaced as plain text rather than a hard failure.
 *
 * Critically, on a **successful** run we scan ONLY the genuine provider-error
 * channel (`agentErrorMessage`, which `extractAgentError` already turns into a
 * non-success stopReason when set — so it's empty here). The agent's own output
 * (`finalText`) and tool results (`fatalError`, `toolError`) are NOT scanned on
 * success: a legitimate `verify`/`qa-test` report or a `curl` probing a 401
 * endpoint routinely contains "unauthorized" / "rate limit" as part of the task
 * itself, and folding that in would wrongly fail a genuinely successful run
 * (and drop its report). Only on a failed run do we fold those in to label why.
 */
export function detectAccountError(opts: {
  success: boolean;
  fatalErrorMessage?: string;
  agentErrorMessage?: string;
  finalText?: string;
  toolErrorText?: string;
}): boolean {
  const combined = [
    opts.success ? undefined : opts.fatalErrorMessage,
    opts.agentErrorMessage,
    opts.success ? undefined : opts.finalText,
    opts.success ? undefined : opts.toolErrorText,
  ]
    .filter((s): s is string => typeof s === "string" && s.length > 0)
    .join("\n")
    .toLowerCase();
  return ACCOUNT_ERROR_MARKERS.some((m) => combined.includes(m));
}

export function finalizeFromRunResult(
  result: RunResult,
  _prompt: string,
  shim: AgenticShim,
  startTime: number,
  extensions?: ExtensionStatusMap,
  skills?: SkillsStatus,
  toolError?: { tool?: string; message: string },
  endedOnToolCall = false,
): ExecutionResult {
  const durationMs = Date.now() - startTime;
  const stats = result.stats;
  // pi-agent-core swallows provider API errors (insufficient_quota, rate
  // limit, auth) inside `handleRunFailure`: it synthesizes an assistant
  // message with stopReason "error" + errorMessage and emits a clean
  // agent_end. Without this check the run would map to "success" and the
  // workflow would silently advance with no output. See message scan below.
  const agentError = extractAgentError(result);
  let stopReason = agentError?.stopReason ?? mapStopReason(result);

  // Truncation guard. A run that *would* map to "success" but whose final
  // assistant turn ended on a tool call was cut off mid-task: the agent
  // asked for a tool and the loop stopped before it could read the result
  // and synthesize an answer (pi hit its internal step cap — agentic-pi
  // v0.2.7 exposes no maxSteps knob to lift it). In that state `finalText`
  // is the agent's "let me just check X" preamble, NOT an answer. Reclassify
  // as a failure so the workflow fires `on_failure` instead of delivering
  // the fragment as if it were the result.
  const truncated = stopReason === "success" && !agentError && endedOnToolCall;
  if (truncated) stopReason = "error_truncated";
  const success = stopReason === "success";
  const truncationMessage =
    "Agent stopped mid-task before producing a final answer (hit the agent " +
    "step limit). No answer was delivered.";

  // A bare `error_tool` stop reason is useless on its own. Surface the
  // failing tool's actual error text so the executions row and dashboard
  // show *why* the run died (e.g. "Tool `bash` failed: insufficient_quota").
  const toolErrorText = toolError
    ? toolError.tool
      ? `Tool \`${toolError.tool}\` failed: ${toolError.message}`
      : toolError.message
    : undefined;

  const inputTokens = stats?.tokens.input ?? 0;
  const outputTokens = stats?.tokens.output ?? 0;
  const cacheRead = stats?.tokens.cacheRead ?? 0;
  const cacheWrite = stats?.tokens.cacheWrite ?? 0;
  const costUsd = stats?.cost ?? 0;
  const turns = stats?.assistantMessages ?? 0;

  const costStr = costUsd > 0 ? `, $${costUsd.toFixed(4)}` : "";
  console.log(
    `  [executor] Result: ${stopReason} (${turns} turns, ${Math.round(durationMs / 1000)}s${costStr})` +
    `${result.sessionId ? ` [session ${result.sessionId}]` : ""}`,
  );

  shim.finalize({
    finalText: result.finalText,
    turns,
    costUsd,
    inputTokens,
    outputTokens,
    cacheReadInputTokens: cacheRead,
    cacheCreationInputTokens: cacheWrite,
    stopReason,
    durationMs,
    apiErrorMessage:
      agentError?.errorMessage ??
      (success ? undefined : (toolErrorText ?? (truncated ? truncationMessage : undefined))),
  });
  void shim.flush();

  const accountError = detectAccountError({
    success,
    fatalErrorMessage: result.fatalError?.message,
    agentErrorMessage: agentError?.errorMessage,
    finalText: result.finalText,
    toolErrorText,
  });

  const errorText =
    result.fatalError?.message ||
    agentError?.errorMessage ||
    toolErrorText ||
    (truncated ? truncationMessage : result.finalText) ||
    stopReason;
  if (!success || accountError) {
    if (accountError) console.error(`  [executor] Account error: ${errorText}`);
    else console.error(`  [executor] Run failed (${stopReason}): ${errorText}`);
  }

  return {
    success: success && !accountError,
    output: result.finalText,
    turns,
    error: success && !accountError ? undefined : errorText,
    durationMs,
    sessionId: result.sessionId,
    costUsd: costUsd > 0 ? costUsd : undefined,
    inputTokens: inputTokens || undefined,
    outputTokens: outputTokens || undefined,
    cacheReadInputTokens: cacheRead || undefined,
    cacheCreationInputTokens: cacheWrite || undefined,
    stopReason,
    extensions,
    skills,
  };
}

export function mapStopReason(result: RunResult): string {
  if (result.fatalError) return "error_fatal";
  if (result.toolErrors && result.finalText.length === 0) return "error_tool";
  if (!result.ok) return `error_exit_${result.exitCode}`;
  if (result.agentEnded || result.finalText.length > 0) return "success";
  return "unknown";
}

/**
 * Scan agent_end's messages for a failed assistant turn. pi-agent-core's
 * `handleRunFailure` catches provider errors, synthesizes an assistant
 * message with stopReason "error"/"aborted" + errorMessage, and emits a
 * normal agent_end — so the only signal that the run actually failed
 * lives on the last assistant message.
 */
export function extractAgentError(
  result: RunResult,
): { stopReason: string; errorMessage: string } | undefined {
  if (!Array.isArray(result.messages)) return undefined;
  for (let i = result.messages.length - 1; i >= 0; i--) {
    const m = result.messages[i] as
      | { role?: string; stopReason?: string; errorMessage?: string }
      | undefined;
    if (m?.role !== "assistant") continue;
    if (m.stopReason === "error" || m.stopReason === "aborted") {
      return {
        stopReason: m.stopReason === "aborted" ? "error_aborted" : "error_agent",
        errorMessage: m.errorMessage || m.stopReason,
      };
    }
    return undefined;
  }
  return undefined;
}

export function coerceThinking(raw: string | undefined): ThinkingLevel | undefined {
  if (!raw) return undefined;
  const v = raw.trim().toLowerCase();
  if (!THINKING_LEVELS.has(v)) {
    console.warn(
      `[executor] Ignoring unknown thinking level "${raw}" — must be one of: ${[...THINKING_LEVELS].join(", ")}`,
    );
    return undefined;
  }
  return v as ThinkingLevel;
}

export function resolveSessionsDir(config: ExecutorConfig): string {
  if (config.sessionsDir) return resolve(config.sessionsDir);
  const stateDir = config.stateDir || resolve("data");
  return process.env.LASTLIGHT_SESSIONS_DIR
    ? resolve(process.env.LASTLIGHT_SESSIONS_DIR)
    : resolve(stateDir, "agent-sessions");
}

export function emptyResult(stopReason: string, durationMs: number) {
  return {
    finalText: "",
    turns: 0,
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    stopReason,
    durationMs,
  };
}

/** Splice values into process.env for the duration of a sync block. */
export function applyEnv(env: Record<string, string>): () => void {
  const saved: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k];
    process.env[k] = v;
  }
  return () => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  };
}

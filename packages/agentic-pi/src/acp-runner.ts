/**
 * Non-Pi runtimes behind the agentic-pi seam (SPIKE — spike/live-sessions).
 *
 * `agentic-pi run --runtime claude|codex|opencode` drives that agent over ACP
 * via embedded acpx, and emits the SAME record shapes the Pi path does —
 * `session`, `extension_status`, `message_end` (assistant content with
 * `toolCall` blocks + `usage.cost.total`), `tool_execution_start/end`,
 * `agent_end`, `usage_snapshot` — so lastlight's accumulator, transcript shim,
 * telemetry and dashboards consume it unchanged. One seam, no fork in core.
 *
 * Where ACP can't do what Pi does, the gap is declared once in a
 * `runtime_status` record (capabilities) instead of being branched on
 * downstream:
 *   - steer        → queued as a follow-up turn (ACP has no mid-turn inject)
 *   - deny reason  → not delivered; the agent only sees "refused"
 *   - input patch  → unsupported
 *   - approvals    → only for tool calls the agent asks permission for
 *                    (Claude: bash + MCP, not edits)
 *   - usage        → one cumulative figure at the end, not per message
 */

import { randomUUID } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  type AcpPermissionDecision,
  type AcpPermissionRequest,
  type AcpRuntimeEvent,
  type AcpRuntimeTurn,
  createAcpRuntime,
  createAgentRegistry,
  createFileSessionStore,
} from "acpx/runtime";

import type { RunConfig } from "./args.js";
import { decideCommand } from "./command-policy.js";
import { ApprovalBroker, approvalMatcher, pumpControl } from "./control.js";
import { Emitter, type EmitterRecord } from "./emitter.js";
import { loadGitHubExtension } from "./extensions/github/index.js";
import { MCP_SERVER_NAME } from "./mcp-github.js";
import type { RunOnceDeps, RunOnceExitCode } from "./runner.js";

export const ACP_RUNTIMES = ["claude", "codex", "opencode"] as const;
export type AcpRuntimeId = (typeof ACP_RUNTIMES)[number];

/** What this runtime can and can't do, relative to the Pi path. */
const CAPABILITIES: Record<AcpRuntimeId, Record<string, unknown>> = {
  claude: { steer: "queued", approvalReason: "follow-up", approvalPatch: false, approvalCoverage: ["bash", "mcp"], cost: "native", usage: "cumulative" },
  codex: { steer: "queued", approvalReason: false, approvalPatch: false, approvalCoverage: "unverified", cost: "unverified", usage: "cumulative" },
  opencode: { steer: "queued", approvalReason: false, approvalPatch: false, approvalCoverage: "unverified", cost: "unverified", usage: "cumulative" },
};

/** Per-runtime env that points the agent at an isolated config home. */
function isolatedHomeEnv(runtime: AcpRuntimeId, home: string): Record<string, string> {
  switch (runtime) {
    case "claude":
      return { CLAUDE_CONFIG_DIR: home };
    case "codex":
      return { CODEX_HOME: home };
    case "opencode":
      return { XDG_CONFIG_HOME: home, XDG_DATA_HOME: home };
  }
}

/** Canonical (Pi-style) tool name for an ACP tool call, so prompts/policy see one vocabulary. */
export function canonicalToolName(kind: string | undefined, title: string | undefined, input: Record<string, unknown>): string {
  const mcp = title?.match(/^mcp__[^_]+(?:_[^_]+)*?__(.+)$/);
  if (mcp) return mcp[1];
  switch (kind) {
    case "execute":
      return "bash";
    case "edit":
      return typeof input.content === "string" && input.old_string === undefined ? "write" : "edit";
    case "read":
      return "read";
    case "search":
      return "grep";
    case "fetch":
      return "fetch";
    default:
      return title || kind || "tool";
  }
}

/** Nearest AGENTS.md at or above cwd — Pi reads it natively; ACP agents get it as an appended system prompt. */
function findContextFile(cwd: string): string | undefined {
  let dir = cwd;
  for (let i = 0; i < 4; i++) {
    const p = join(dir, "AGENTS.md");
    if (existsSync(p)) return readFileSync(p, "utf8");
    const up = dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  return undefined;
}

type PiContent = { type: "text"; text: string } | { type: "toolCall"; id: string; name: string; arguments: Record<string, unknown> };

/**
 * ACP event stream → Pi-shaped records. Text deltas and tool calls are folded
 * into assistant "messages"; a message is flushed as `message_end` when its
 * first tool result arrives (so the shim sees tool_use before tool_result) or
 * when the turn ends.
 */
export class AcpToPiTranslator {
  private text = "";
  /** Every call seen this run, by id — never cleared (updates interleave with text). */
  private calls = new Map<string, { name: string; args: Record<string, unknown>; started: boolean; flushed: boolean }>();
  /** Calls not yet emitted inside a `message_end`. */
  private pending: string[] = [];
  readonly messages: Array<Record<string, unknown>> = [];

  constructor(private readonly emit: (r: EmitterRecord) => void) {}

  feed(e: AcpRuntimeEvent): void {
    if (e.type === "text_delta") {
      if (e.stream !== "thought") this.text += e.text;
      return;
    }
    if (e.type !== "tool_call" || !e.toolCallId) return;
    const id = e.toolCallId;
    const input = (e.rawInput && typeof e.rawInput === "object" ? e.rawInput : {}) as Record<string, unknown>;
    let c = this.calls.get(id);
    if (!c) {
      // Prose before a fresh tool batch belongs to the PREVIOUS message only if
      // that one already ran its tools; otherwise it leads this batch.
      c = { name: canonicalToolName(e.kind, e.title, input), args: input, started: false, flushed: false };
      this.calls.set(id, c);
      this.pending.push(id);
    }
    // rawInput streams in (MCP args arrive key by key): keep the latest, and
    // only rename on updates that still carry a kind (completion updates are
    // titled a generic "tool call").
    if (Object.keys(input).length > 0) c.args = input;
    if (e.kind || e.title?.startsWith("mcp__")) c.name = canonicalToolName(e.kind ?? undefined, e.title, c.args);
    if (e.status === "completed" || e.status === "failed") {
      this.start(id);
      this.flushMessage();
      this.emit({
        type: "tool_execution_end",
        toolCallId: id,
        toolName: c.name,
        result: { content: [{ type: "text", text: outputText(e.rawOutput) }] },
        isError: e.status === "failed",
      });
    }
  }

  /**
   * Emit `tool_execution_start` once, with the args as complete as they will
   * get — at the permission request (before execution) or at completion.
   */
  start(id: string, args?: Record<string, unknown>): void {
    const c = this.calls.get(id);
    if (!c || c.started) return;
    if (args && Object.keys(args).length > 0) c.args = args;
    c.started = true;
    this.emit({ type: "tool_execution_start", toolCallId: id, toolName: c.name, args: c.args });
  }

  /** Emit the pending assistant message (text + not-yet-flushed tool calls). */
  flushMessage(usage?: Record<string, unknown>, stopReason = "toolUse"): void {
    if (!this.text && this.pending.length === 0 && !usage) return;
    const content: PiContent[] = [];
    if (this.text) content.push({ type: "text", text: this.text });
    for (const id of this.pending) {
      const c = this.calls.get(id)!;
      c.flushed = true;
      content.push({ type: "toolCall", id, name: c.name, arguments: c.args });
    }
    const message = {
      role: "assistant",
      content,
      stopReason: this.pending.length ? "toolUse" : stopReason,
      ...(usage ? { usage } : {}),
    };
    this.pending = [];
    this.text = "";
    this.messages.push(message);
    this.emit({ type: "message_end", message });
  }
}

/** ACP rawOutput → text. MCP results arrive as a content-block array. */
function outputText(raw: unknown): string {
  if (typeof raw === "string") return raw;
  if (Array.isArray(raw) && raw.every((b) => b && typeof b === "object" && "text" in b)) {
    return raw.map((b) => String((b as { text: unknown }).text)).join("");
  }
  return JSON.stringify(raw ?? "");
}

const STOP_REASON: Record<string, string> = { end_turn: "stop", max_tokens: "length", cancelled: "aborted", refusal: "error" };

export async function runAcpOnce(config: RunConfig, prompt: string, deps: RunOnceDeps): Promise<RunOnceExitCode> {
  const runtimeId = config.runtime as AcpRuntimeId;
  const warn = deps.onWarn ?? (() => undefined);
  const emitter = new Emitter({ sessionId: randomUUID(), cwd: config.cwd, startedAt: new Date().toISOString() }, deps.sink);
  const emit = (e: EmitterRecord) => emitter.event(e);
  emitter.sessionHeader();
  emit({ type: "runtime_status", runtime: runtimeId, protocol: "acp", capabilities: CAPABILITIES[runtimeId] });

  // GitHub tools: same profile gate as the Pi path, served over MCP by our own
  // `mcp-github` subcommand (the tool code is shared, not forked).
  const github = loadGitHubExtension(config.profile, {
    baseUrl: config.githubApiBaseUrl ?? process.env.GITHUB_API_URL,
    env: config.githubAuthEnv,
  });
  emit({
    type: "extension_status",
    extension: "github",
    status: github.status,
    reason: github.reason,
    message: github.message,
    profile: github.profile,
    toolCount: github.toolNames.length,
    transport: "mcp",
  });
  const cliPath = fileURLToPath(new URL("./cli.js", import.meta.url));
  const ghEnv = { ...(config.githubAuthEnv ?? {}), ...pick(process.env, /^(GITHUB_|GH_TOKEN$)/) };
  const mcpServers =
    github.status === "configured" && config.profile
      ? [
          {
            name: MCP_SERVER_NAME,
            command: process.execPath,
            args: [
              cliPath,
              "mcp-github",
              "--profile",
              config.profile,
              ...(config.githubApiBaseUrl ? ["--github-api-url", config.githubApiBaseUrl] : []),
            ],
            env: Object.entries(ghEnv).map(([name, value]) => ({ name, value: String(value) })),
          },
        ]
      : [];

  // Isolated config home: never inherit the operator's own agent config,
  // skills, plugins or auth (measured: the spike's first Claude run loaded 45
  // of the operator's personal commands).
  const home = mkdtempSync(join(tmpdir(), `agentic-pi-${runtimeId}-`));
  const model = config.model.includes("/") ? config.model.slice(config.model.indexOf("/") + 1) : config.model;
  const agentEnv: Record<string, string> = {
    ...(pick(process.env, /.*/) as Record<string, string>),
    ...isolatedHomeEnv(runtimeId, home),
    ...(runtimeId === "claude" ? { ANTHROPIC_MODEL: model } : {}),
  };

  const translator = new AcpToPiTranslator(emit);
  /** Follow-up turns: queued steers, and deny reasons ACP can't carry. */
  const queue: string[] = [];
  // Approvals + command policy ride ACP permission requests.
  const broker = new ApprovalBroker((config.approvalTimeoutSeconds ?? 120) * 1000);
  const match = deps.control ? approvalMatcher(config.approveTools) : undefined;
  const onPermissionRequest = async (req: AcpPermissionRequest): Promise<AcpPermissionDecision> => {
    const tc = (req.raw.toolCall ?? {}) as { title?: string; kind?: string; rawInput?: unknown; toolCallId?: string };
    const input = (tc.rawInput && typeof tc.rawInput === "object" ? tc.rawInput : {}) as Record<string, unknown>;
    const name = canonicalToolName(tc.kind ?? req.inferredKind, tc.title, input);
    if (name === "bash" && config.commandPolicy && typeof input.command === "string") {
      const d = decideCommand(config.commandPolicy, input.command, config.cwd);
      if (d.action !== "allow") {
        for (const m of d.matches) {
          emit({ type: "command_policy", action: d.action, class: m.cls, pattern: m.pattern, command: input.command.slice(0, 2000) });
        }
        if (d.action === "block") {
          if (d.reason) queue.push(`Your bash command was blocked by policy: ${d.reason}\nCarry on without it.`);
          return { outcome: "reject_once" };
        }
      }
    }
    if (tc.toolCallId) translator.start(tc.toolCallId, input);
    if (match?.(name, input)) {
      const { id, decision } = broker.request();
      emit({ type: "approval_requested", id, toolCallId: tc.toolCallId, toolName: name, input });
      const d = await decision;
      // ACP rejections carry no reason (the agent sees "User refused
      // permission"), and Claude then stops to ask a human. Deliver the reason
      // ourselves as a follow-up turn so the run carries on, as it does on Pi.
      if (!d.allow && d.reason) {
        queue.push(`Your ${name} call was refused by the reviewer: ${d.reason}\nDo not retry it; carry on with the rest of the task without it.`);
      }
      emit({ type: "approval_resolved", id, allow: d.allow, reason: d.reason, patched: false, reasonDelivered: d.allow ? undefined : "follow-up" });
      return { outcome: d.allow ? "allow_once" : "reject_once" };
    }
    // Pi has no permission prompts; match that — allow unless policy/approval said no.
    return { outcome: "allow_once" };
  };

  const runtime = createAcpRuntime({
    cwd: config.cwd,
    agentProcessEnv: agentEnv,
    sessionStore: createFileSessionStore({ stateDir: join(home, ".acpx") }),
    agentRegistry: createAgentRegistry(),
    permissionMode: "approve-reads",
    nonInteractivePermissions: "deny",
    onPermissionRequest,
    mcpServers,
  });

  let current: AcpRuntimeTurn | undefined;
  let aborted = false;
  let exit: RunOnceExitCode = 0;
  let lastResult: Awaited<AcpRuntimeTurn["result"]> | undefined;

  try {
    const context = findContextFile(config.cwd);
    const handle = await runtime.ensureSession({
      sessionKey: `agentic-pi-${randomUUID()}`,
      agent: runtimeId,
      mode: "persistent",
      cwd: config.cwd,
      sessionOptions: { model, ...(context ? { systemPrompt: { append: context } } : {}), ...(config.maxSteps ? { maxTurns: config.maxSteps } : {}) },
    });

    // Control channel: steer/follow_up queue a turn (declared "queued"),
    // abort cancels the live turn, decide answers a permission request.
    const controlDone = deps.control
      ? pumpControl(
          deps.control,
          {
            steer: async (m) => void queue.push(m),
            followUp: async (m) => void queue.push(m),
            abort: async () => {
              aborted = true;
              queue.length = 0;
              await current?.cancel({ reason: "aborted by control channel" });
            },
          },
          broker,
          emit,
        ).catch((err) => warn(`control channel error: ${(err as Error).message}`))
      : undefined;

    let text: string | undefined = prompt;
    let n = 0;
    while (text !== undefined && !aborted) {
      current = runtime.startTurn({ handle, text, mode: "prompt", requestId: `t${++n}`, onPermissionRequest });
      for await (const e of current.events) translator.feed(e);
      lastResult = await current.result;
      if (lastResult.status === "failed") break;
      text = queue.length ? queue.splice(0).join("\n\n") : undefined;
    }
    broker.close("session ended");
    void controlDone;

    // ACP reports usage once, cumulatively — attach it to the final message
    // so lastlight's per-message accumulator sums to the right total.
    const status = await runtime.getStatus?.({ handle }).catch(() => undefined);
    const u = status?.usage?.cumulative ?? {};
    const costUsd = status?.usage?.cost?.currency === "USD" ? (status.usage.cost.amount ?? 0) : 0;
    const usage = {
      input: u.inputTokens ?? 0,
      output: u.outputTokens ?? 0,
      cacheRead: u.cachedReadTokens ?? 0,
      cacheWrite: u.cachedWriteTokens ?? 0,
      totalTokens: u.totalTokens ?? 0,
      cost: { total: costUsd },
    };
    const stopReason =
      lastResult?.status === "failed" ? "error" : aborted ? "aborted" : (STOP_REASON[lastResult?.stopReason ?? ""] ?? "stop");
    translator.flushMessage(usage, stopReason);
    if (lastResult?.status === "failed") {
      emit({ type: "fatal_error", error: { name: lastResult.error.code ?? "AcpError", message: lastResult.error.message } });
      exit = 1;
    }
    emit({ type: "agent_end", messages: translator.messages, willRetry: false });
    emit({
      type: "usage_snapshot",
      stats: {
        assistantMessages: translator.messages.length,
        tokens: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite, total: usage.totalTokens },
        cost: costUsd,
      },
    });
    await runtime.close({ handle, reason: "run complete", discardPersistentState: true }).catch(() => undefined);
  } catch (err) {
    emit({ type: "fatal_error", error: { name: (err as Error).name, message: (err as Error).message } });
    exit = 1;
  } finally {
    broker.close();
    await runtime.shutdown?.().catch(() => undefined);
    rmSync(home, { recursive: true, force: true });
  }
  return exit;
}

function pick(env: NodeJS.ProcessEnv, re: RegExp): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) if (v !== undefined && re.test(k)) out[k] = v;
  return out;
}

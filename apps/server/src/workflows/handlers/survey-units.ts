import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Context } from "@earendil-works/pi-ai";
import {
  OPENINFERENCE_CHAIN,
  OPENINFERENCE_SPAN_KIND,
  renderTemplate,
  resolveTemplatedNumber,
  runLedgeredPhase,
} from "lastlight-workflow-engine";
import type {
  AssetLoader,
  DagNode,
  ExecutionResult,
  ExecutorConfig,
  GitSandboxAccess,
  LedgerDeps,
  PhaseDefinition,
  PhaseOutcome,
  PhaseReporter,
  PhaseResolver,
  PhaseResult,
  PhaseTypeHandler,
  TemplateContext,
  WorkflowStateStore,
} from "lastlight-workflow-engine";
import { defaultReviewPolicy } from "lastlight-shared/config-types";
import type { SandboxBackend } from "../../config/config.js";
import { completeWithRetry, endpointApiKey, resolveModel } from "../../engine/chat/chat-runner.js";
import { AgenticShim } from "../../engine/event-shim.js";
import { resolveSessionsDir } from "../../engine/executors/shared.js";
import { OAUTH_ONLY_PROVIDERS, oauthProviderIdForModel, resolveOAuthApiKey } from "../../engine/oauth.js";
import { logger } from "../../logging/logger.js";
import { CHAT_PROJECT_SLUG, projectSlugForCwd } from "../../session-log.js";
import { resolveHostRepoDir } from "./host-repo-dir.js";

const log = logger("survey-units");

/**
 * The `type: survey-units` phase — the model half of the per-unit survey
 * (`docs/plans/unit-survey.md`).
 *
 * `lastlight-facts units` (a bash phase, in the sandbox) has already cut the PR
 * into units and rendered each one's COMPLETE request. This handler does only
 * model I/O: one bounded, non-agentic call per unit, the phase's prompt as the
 * system prompt and `unit.request` verbatim as the user message, then one
 * `units/responses/<unitId>.json` per unit for `lastlight-facts units-ingest`
 * to validate and turn into `hypotheses/<family>.jsonl`. Core does not depend
 * on `lastlight-code-facts` and must not start to — the package drags tsgo and
 * ast-grep natives into the agent image — so the FILE CONTRACT is the whole
 * interface.
 *
 * **Why in-process rather than an agent phase.** A unit is a single request
 * with no tools. An agent session would spend its turns re-deriving, with bash,
 * the context the request already carries — which is the cost this engine
 * exists to remove.
 *
 * **Only host-checkout backends.** The handler reads and writes the workspace
 * from the harness. `kubernetes` has no host checkout (its paths are in-pod;
 * see `HOST_READABLE_WORKSPACE` in `fanout.ts`), so it fails LOUD there rather
 * than reporting a survey that never saw the units.
 *
 * **Visible like any other phase.** One virtual session transcript through
 * {@link AgenticShim} (one `survey_unit` tool call per model call, so a retry
 * or a cache hit is its own pair), and one `executions` row through
 * {@link runLedgeredPhase} carrying that session id and the summed cost. The
 * dashboard finds a phase's transcript ONLY via `executions.session_id`, stats
 * cost only off that row, and the evals harness costs a phase off the
 * transcript's `result` line — so all three are load-bearing.
 */

/** Relative to the checkout — the same root every deterministic phase wrote in. */
const PR_REVIEW_DIR = join(".lastlight", "pr-review");
const UNITS_FILE = "units.json";
const RESPONSES_DIR = join("units", "responses");

/** The tool name the transcript records each unit call under. */
export const SURVEY_UNIT_TOOL = "survey_unit";

/** A unit id is also a filename, so it is held to the session-id alphabet. */
const SAFE_UNIT_ID = /^[A-Za-z0-9_-]+$/;

// ── The model call — injectable ──────────────────────────────────────────────

export interface UnitCallUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export interface UnitCallResult {
  /** Every text block of the reply, joined. */
  text: string;
  usage: UnitCallUsage;
  /** Set when the provider answered with an error or an abort rather than text. */
  error?: string;
}

/**
 * ONE model call. Injected so tests run with no network; production uses
 * {@link completeUnitCall}. A throw is treated exactly like `error`.
 */
export type UnitModelCall = (args: {
  model: string;
  systemPrompt: string;
  request: string;
  timeoutMs: number;
  /**
   * The same for every call of one phase — a provider-side cache ROUTING hint
   * (`sessionId` → OpenAI's `prompt_cache_key`), so concurrent calls that share
   * a prefix land where that prefix is already cached.
   */
  cacheKey: string;
}) => Promise<UnitCallResult>;

const ZERO_USAGE: UnitCallUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };

/**
 * The production {@link UnitModelCall}: pi-ai's `completeSimple`, resolved and
 * credentialed exactly as the in-process chat path does it (`chat-runner.ts`) —
 * a deployment's endpoint override, a named key env var, an OAuth subscription
 * token. Transient provider faults (429 / 5xx / network) are retried with
 * backoff by `completeWithRetry` INSIDE one attempt; the handler's own single
 * retry is for a reply that came back without the unit's JSON object.
 *
 * **Prompt caching.** Every call of a phase sends the byte-identical system
 * prompt, and every `unit.request` opens with code-facts' byte-identical
 * `sharedPrefix` (the unit-independent questions, evidence record and rules),
 * so the shared head is cacheable provider-side. `cacheRetention: "short"` is
 * pi-ai's default, spelled out so a `PI_CACHE_RETENTION=long` in the harness
 * env cannot silently double the write price of a phase that re-asks within
 * minutes, not hours. What each provider does with it differs:
 *  - OpenAI-family prefix caching is automatic over any identical prefix
 *    (≥1024 tokens), so system prompt + shared prefix both hit; `cacheKey`
 *    goes out as `prompt_cache_key` to keep concurrent calls on one cache.
 *  - Anthropic caches only at explicit breakpoints, and pi-ai places them on
 *    the system prompt and the END of the last user message. The system prompt
 *    therefore hits across units; the shared prefix inside the request does
 *    not get a breakpoint of its own through `completeSimple`.
 */
export const completeUnitCall: UnitModelCall = async ({ model, systemPrompt, request, timeoutMs, cacheKey }) => {
  const resolved = resolveModel(model);
  let apiKey: string | undefined;
  const oauthId = oauthProviderIdForModel(model);
  if (oauthId) {
    const res = await resolveOAuthApiKey(oauthId);
    if (res) apiKey = res.apiKey;
    else if (OAUTH_ONLY_PROVIDERS.has(oauthId)) {
      throw new Error(`model '${model}' requires an OAuth login — run: lastlight oauth login ${oauthId}`);
    }
  }
  const key = apiKey ?? endpointApiKey(resolved.provider);
  const context: Context = {
    systemPrompt,
    messages: [{ role: "user", content: request, timestamp: Date.now() }],
  };
  const assistant = await completeWithRetry(completeSimple, resolved, context, {
    timeoutMs,
    cacheRetention: "short",
    sessionId: cacheKey,
    ...(key ? { apiKey: key } : {}),
  });
  const text = assistant.content
    .filter((c) => c.type === "text" && typeof (c as { text?: unknown }).text === "string")
    .map((c) => (c as { text: string }).text)
    .join("");
  const failed = assistant.stopReason === "error" || assistant.stopReason === "aborted";
  return {
    text,
    usage: {
      input: assistant.usage.input,
      output: assistant.usage.output,
      cacheRead: assistant.usage.cacheRead,
      cacheWrite: assistant.usage.cacheWrite,
      costUsd: assistant.usage.cost.total,
    },
    ...(failed ? { error: assistant.errorMessage ?? assistant.stopReason } : {}),
  };
};

// ── The file contract ────────────────────────────────────────────────────────

/** One entry of `units.json` — only the fields this handler reads. */
export interface SurveyUnit {
  id: string;
  kind?: string;
  file: string | null;
  symbol: string | null;
  lines: [number, number] | null;
  families?: string[];
  obligationIds?: string[];
  request: string;
  requestSha256?: string;
  truncated?: boolean;
}

interface UnitsDocument {
  coverage?: string;
  promptVersion?: string;
  /**
   * The byte-identical head every `unit.request` opens with (optional: older
   * documents carry none). Never sent on its own — each request already
   * contains it — so it is read only to keep the transcript from repeating it
   * per unit, and to key the provider cache.
   */
  sharedPrefix?: string;
  sharedPrefixSha256?: string;
  units: SurveyUnit[];
}

/** `units/responses/<unitId>.json`, exactly per the plan's FILE CONTRACT. */
export interface UnitResponseRecord {
  unitId: string;
  model: string;
  systemPromptSha256: string;
  requestSha256: string;
  ok: boolean;
  cached: boolean;
  attempts: number;
  raw: string;
  error: string | null;
  usage: UnitCallUsage;
  durationMs: number;
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/**
 * Read and shape-check `units.json`. Throws with a message fit for the phase
 * error: the `units` phase ALWAYS writes a document (its shell fallback
 * included), so a missing or malformed one is a broken contract, never an
 * empty survey.
 */
function readUnitsDocument(path: string): UnitsDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new Error(
      `survey-units: could not read ${path} (${reason}) — the \`units\` phase always writes this document, ` +
        `so its absence means that phase did not run or did not survive; no unit was surveyed`,
    );
  }
  const doc = parsed as Partial<UnitsDocument> | null;
  if (!doc || typeof doc !== "object" || !Array.isArray(doc.units)) {
    throw new Error(`survey-units: ${path} has no \`units\` array — not a units document`);
  }
  const seen = new Set<string>();
  for (const [i, u] of doc.units.entries()) {
    if (!u || typeof u !== "object" || typeof u.id !== "string" || typeof u.request !== "string") {
      throw new Error(`survey-units: ${path} units[${i}] has no string \`id\` and \`request\``);
    }
    if (!SAFE_UNIT_ID.test(u.id)) {
      throw new Error(`survey-units: ${path} units[${i}] id ${JSON.stringify(u.id)} is not a safe filename`);
    }
    if (seen.has(u.id)) throw new Error(`survey-units: ${path} repeats unit id ${u.id}`);
    seen.add(u.id);
  }
  return doc as UnitsDocument;
}

/**
 * Does `raw` hold a JSON object whose `unitId` is `unitId`?
 *
 * The handler's ONLY validation — enough to decide the single retry. Every
 * brace-balanced span is tried (string-aware, so a `}` inside a claim does not
 * cut it short), which accepts a fenced block or a sentence of preamble the
 * model was told not to write. Schema validation is `units-ingest`'s job.
 */
export function holdsUnitObject(raw: string, unitId: string): boolean {
  for (let start = raw.indexOf("{"); start !== -1; start = raw.indexOf("{", start + 1)) {
    const end = closingBrace(raw, start);
    if (end === -1) continue;
    try {
      const v = JSON.parse(raw.slice(start, end)) as unknown;
      if (v && typeof v === "object" && !Array.isArray(v) && (v as { unitId?: unknown }).unitId === unitId) {
        return true;
      }
    } catch {
      /* balanced but not JSON — keep scanning */
    }
  }
  return false;
}

/** Index just past the value opening at `start`, or -1 if the text ends first. */
function closingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth += 1;
    else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

/** Write a file whole or not at all — a concurrent reader never sees half of it. */
function writeAtomic(path: string, body: string): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID().slice(0, 8)}.tmp`;
  writeFileSync(tmp, body);
  renameSync(tmp, path);
}

// ── The response cache ───────────────────────────────────────────────────────

/**
 * Readings cached by request hash, OUTSIDE the per-run workspace, so a
 * re-review of the same repo reuses every unit whose request did not change —
 * the other half of the perch shape. Keyed on everything that determines the
 * reply: the model, the system prompt, and the request (which already carries
 * the unit's code, its obligations and code-facts' `promptVersion`).
 *
 * Only `ok: true` readings are stored: a failure is never worth replaying.
 * Scoped by `<owner>/<repo>` so one repository's cache cannot answer for
 * another's, even on an identical request.
 */
export function unitCacheDir(stateDir: string, owner: string, repo: string): string {
  const safe = (s: string) => (s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "_");
  return join(stateDir, "unit-survey-cache", safe(owner), safe(repo));
}

function cacheKey(model: string, systemPromptSha256: string, requestSha256: string): string {
  return sha256(`${model}\n${systemPromptSha256}\n${requestSha256}`);
}

function readCached(dir: string, key: string): UnitResponseRecord | undefined {
  try {
    const rec = JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8")) as UnitResponseRecord;
    return rec && rec.ok === true && typeof rec.raw === "string" ? rec : undefined;
  } catch {
    return undefined;
  }
}

// ── The transcript ───────────────────────────────────────────────────────────

/**
 * ONE virtual session per phase, fed through {@link AgenticShim} the way
 * `writeChatShim` (`engine/chat/chat.ts`) replays a chat turn: the shim already
 * turns `message_end` / `tool_execution_end` into the envelope lines the
 * dashboard's SessionReader and `lastlight session log` render.
 *
 * Events are fed as calls COMPLETE, and each call's pair is fed in one
 * synchronous block — `feed` is synchronous and the shim serialises its own
 * appends on one promise chain — so concurrent units never interleave a
 * `tool_use` with another unit's `tool_result`. Every `tool_execution_end`
 * follows its own `message_end`: the shim DROPS a result whose call id it never
 * saw.
 */
class UnitSurveyTranscript {
  private readonly shim: AgenticShim;
  readonly sessionId = randomUUID();
  private opened = false;

  constructor(opts: { sessionsDir: string; projectSlug: string; model: string; phase: string; initialPrompt: string }) {
    this.shim = new AgenticShim({
      homeDir: opts.sessionsDir,
      projectSlug: opts.projectSlug,
      model: opts.model,
      initialPrompt: opts.initialPrompt,
      phase: opts.phase,
    });
  }

  open(): void {
    this.feed({ type: "session", id: this.sessionId, timestamp: Date.now() });
    this.opened = true;
  }

  /** One call (or cache hit): the assistant's tool call with its usage, then the result. */
  call(
    toolCallId: string,
    text: string,
    args: Record<string, unknown>,
    usage: UnitCallUsage,
    result: string,
    isError: boolean,
  ): void {
    const ts = Date.now();
    this.feed({
      type: "message_end",
      sessionId: this.sessionId,
      timestamp: ts,
      message: {
        role: "assistant",
        content: [
          { type: "text", text },
          { type: "toolCall", id: toolCallId, name: SURVEY_UNIT_TOOL, arguments: args },
        ],
        usage: { input: usage.input, output: usage.output, cacheRead: usage.cacheRead, cacheWrite: usage.cacheWrite },
      },
    });
    this.feed({
      type: "tool_execution_end",
      sessionId: this.sessionId,
      timestamp: ts,
      toolCallId,
      toolName: SURVEY_UNIT_TOOL,
      result,
      isError,
    });
  }

  say(text: string): void {
    this.feed({
      type: "message_end",
      sessionId: this.sessionId,
      timestamp: Date.now(),
      message: { role: "assistant", content: [{ type: "text", text }] },
    });
  }

  async close(totals: {
    text: string;
    turns: number;
    usage: UnitCallUsage;
    durationMs: number;
    stopReason: string;
  }): Promise<void> {
    this.shim.finalize({
      finalText: totals.text,
      turns: totals.turns,
      costUsd: totals.usage.costUsd,
      inputTokens: totals.usage.input,
      outputTokens: totals.usage.output,
      cacheReadInputTokens: totals.usage.cacheRead,
      cacheCreationInputTokens: totals.usage.cacheWrite,
      stopReason: totals.stopReason,
      durationMs: totals.durationMs,
    });
    await this.shim.flush();
  }

  /** Early death: close whatever was opened — or open a stub — with the error on it. */
  async fail(error: string, turns: number, usage: UnitCallUsage, durationMs: number): Promise<string | null> {
    if (this.opened) this.say(`Survey stopped: ${error}`);
    return this.shim.finalizeWithFallback(
      {
        finalText: "",
        turns,
        costUsd: usage.costUsd,
        inputTokens: usage.input,
        outputTokens: usage.output,
        cacheReadInputTokens: usage.cacheRead,
        cacheCreationInputTokens: usage.cacheWrite,
        stopReason: "error_survey_units",
        durationMs,
      },
      this.sessionId,
      this.opened ? undefined : error,
    );
  }

  private feed(record: Record<string, unknown>): void {
    this.shim.feed(record as unknown as Parameters<AgenticShim["feed"]>[0]);
  }
}

function addUsage(a: UnitCallUsage, b: UnitCallUsage): UnitCallUsage {
  return {
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    costUsd: a.costUsd + b.costUsd,
  };
}

function unitLabel(u: SurveyUnit): string {
  const where = u.file ? `${u.file}${u.lines ? `:${u.lines[0]}-${u.lines[1]}` : ""}` : "the whole PR";
  return `${u.id} · ${u.symbol ?? u.kind ?? "unit"} (${where})`;
}

/**
 * A unit's request as the TRANSCRIPT records it: verbatim, except that the
 * document's `sharedPrefix` — identical in every request, and shown once in the
 * opening prompt — is replaced by a one-line marker. The model always gets the
 * full request; this only keeps a hundred-unit transcript from carrying a
 * hundred copies of the same few thousand characters.
 */
function transcriptRequest(request: string, sharedPrefix: string | undefined): string {
  if (!sharedPrefix || !request.startsWith(sharedPrefix)) return request;
  return `[shared request prefix — ${sharedPrefix.length} chars, shown once in the opening prompt]\n${request.slice(sharedPrefix.length)}`;
}

/** The unit list the transcript opens with, after the system prompt. */
function manifest(units: SurveyUnit[], doc: UnitsDocument): string {
  const head = [
    "---",
    "",
    `## Units to survey (${units.length})`,
    "",
    `coverage: ${doc.coverage ?? "unknown"} · promptVersion: ${doc.promptVersion ?? "unknown"}`,
    "",
    "The prompt above is the SYSTEM prompt of every call below; each call's user message is its unit's `request`, verbatim.",
    "",
  ];
  if (units.length === 0) return [...head, "(none — `units.json` lists no units)"].join("\n");
  const rows = units.map((u) => {
    const families = u.families?.length ? ` · families ${u.families.join(", ")}` : "";
    const obligations = u.obligationIds?.length ? ` · obligations ${u.obligationIds.join(", ")}` : "";
    return `- ${unitLabel(u)}${families}${obligations}${u.truncated ? " · TRUNCATED" : ""}`;
  });
  const shared = doc.sharedPrefix
    ? ["", "## Shared request prefix", "", "Every request below opens with these bytes; the calls record it as a one-line marker.", "", doc.sharedPrefix]
    : [];
  return [...head, ...rows, ...shared].join("\n");
}

// ── The handler ──────────────────────────────────────────────────────────────

/** Run-scoped data the `survey-units` handler needs. */
export interface SurveyUnitsRunScope {
  workflowName: string;
  ctx: TemplateContext;
  config: ExecutorConfig;
  /** Single workspace shared by every phase of the run. */
  taskId: string;
  triggerId: string;
  githubAccess: GitSandboxAccess;
  backend: SandboxBackend;
  assets: AssetLoader;
  resolver: PhaseResolver;
  store?: WorkflowStateStore;
  workflowId?: string;
  ledger: Omit<LedgerDeps, "store">;
  /** Test seam — the model call. Defaults to {@link completeUnitCall}. */
  callUnit?: UnitModelCall;
}

/** What one unit came to — its response record, and the calls it spent. */
interface UnitOutcome {
  record: UnitResponseRecord;
  calls: number;
}

export class SurveyUnitsHandler implements PhaseTypeHandler {
  constructor(
    private readonly run: SurveyUnitsRunScope,
    private readonly reporter: PhaseReporter,
  ) {}

  async execute(
    phase: PhaseDefinition,
    _node: DagNode,
    _outputs: Readonly<Record<string, unknown>>,
  ): Promise<PhaseOutcome> {
    const phaseName = phase.name;
    await this.reporter.onStart(phaseName);
    await this.reporter.step(phaseName, "running", phase.messages?.on_start);

    const { workflowName, taskId, triggerId, githubAccess, workflowId, backend } = this.run;
    const model = this.resolveModel(phase);
    const attrs = {
      "workflow.name": workflowName,
      "phase.name": phaseName,
      "workflow.run_id": workflowId,
      "trigger.id": triggerId,
      "task.id": taskId,
      repo: githubAccess.owner ? `${githubAccess.owner}/${githubAccess.repo}` : githubAccess.repo,
      "sandbox.backend": backend,
      model,
      [OPENINFERENCE_SPAN_KIND]: OPENINFERENCE_CHAIN,
    };

    let pr;
    try {
      pr = await runLedgeredPhase(
        attrs,
        {
          dedupKey: `${workflowName}:${phaseName}`,
          phaseName,
          taskId,
          triggerId,
          repo: githubAccess.repo,
          owner: githubAccess.owner,
          workflowRunId: workflowId,
        },
        { ...this.run.ledger, store: this.run.store },
        (onSessionId) => this.survey(phase, model, onSessionId),
      );
    } catch (err) {
      return this.fail(phase, err instanceof Error ? err.message : String(err));
    }

    if (pr.skipped) {
      // The same two readings `runStandard` gives a dedup hit: another instance
      // owns the row (stop, not a failure), or resume found it done.
      if (pr.reason === "running") {
        await this.reporter.message(phase.messages?.on_skipped_done);
        return { results: [], status: "failed", aborted: true };
      }
      const result: PhaseResult = { phase: phaseName, success: true, output: "Already completed" };
      await this.reporter.persistPhase(phaseName, "Already completed (deduplicated)");
      await this.reporter.onEnd(phaseName, result);
      await this.reporter.step(phaseName, "done", phase.messages?.on_skipped_done);
      return { results: [result], status: "succeeded" };
    }

    if (!pr.result.success) return this.fail(phase, pr.result.error ?? "survey-units failed");

    const output = pr.result.output ?? "";
    const result: PhaseResult = { phase: phaseName, success: true, output };
    await this.reporter.persistPhase(phaseName, output.split("\n")[0]);
    await this.reporter.onEnd(phaseName, result);
    await this.reporter.step(phaseName, "done", phase.messages?.on_success);
    const outputVars: Record<string, unknown> = { [phaseName]: output };
    if (phase.output_var) outputVars[phase.output_var] = output;
    return { results: [result], status: "succeeded", outputVars };
  }

  /**
   * The ledgered body — everything that spends, and the transcript that shows
   * it. Returns an {@link ExecutionResult} whose cost and tokens are the sum of
   * every call, which `runLedgeredPhase` copies onto the `executions` row.
   */
  private async survey(
    phase: PhaseDefinition,
    model: string | undefined,
    onSessionId: (sessionId: string) => void,
  ): Promise<ExecutionResult> {
    const startedAt = Date.now();
    const repo = String(this.run.ctx.repo ?? this.run.githubAccess.repo);
    const owner = String(this.run.ctx.owner ?? this.run.githubAccess.owner ?? "");
    const hostRepoDir = resolveHostRepoDir(this.run.config, this.run.taskId, repo);
    const prDir = join(hostRepoDir, PR_REVIEW_DIR);

    let totals: UnitCallUsage = { ...ZERO_USAGE };
    let turns = 0;
    let transcript: UnitSurveyTranscript | undefined;

    const failed = async (error: string, systemPrompt = ""): Promise<ExecutionResult> => {
      log.error("unit survey failed", { phase: phase.name, error });
      transcript ??= this.transcript(phase, model ?? "", hostRepoDir, `${systemPrompt}\n\n${error}`.trim());
      const sessionId = await transcript.fail(error, turns, totals, Date.now() - startedAt);
      if (sessionId) onSessionId(sessionId);
      return this.executionResult(false, error, turns, totals, startedAt, sessionId ?? undefined, "error_survey_units");
    };

    // The backend check comes FIRST: on kubernetes a `units.json` may even be
    // readable (the artifact upload unpacks `.lastlight/` host-side), but the
    // responses written here would never reach the pod `units-ingest` runs in.
    if (this.run.backend === "kubernetes") {
      return failed(
        "survey-units: `review.analysis.surveyEngine: units` needs a backend whose workspace the harness can read " +
          "and write (none, docker, gondolin or smol); the kubernetes backend has no host checkout. " +
          "Set `surveyEngine: agent` for this deployment.",
      );
    }
    if (!model) {
      return failed(
        `survey-units: no model resolved for phase \`${phase.name}\` — set \`models.review-survey\` (or the phase's \`model:\`)`,
      );
    }
    if (!phase.prompt) return failed(`survey-units: phase \`${phase.name}\` has no \`prompt:\``);

    let systemPrompt: string;
    let doc: UnitsDocument;
    let timeoutMs: number;
    try {
      systemPrompt = renderTemplate(this.run.assets.loadPromptTemplate(phase.prompt), this.run.ctx);
      doc = readUnitsDocument(join(prDir, UNITS_FILE));
      timeoutMs = this.callTimeoutSeconds(phase) * 1000;
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }

    const systemPromptSha256 = sha256(systemPrompt);
    const units = doc.units;
    transcript = this.transcript(phase, model, hostRepoDir, `${systemPrompt.trimEnd()}\n\n${manifest(units, doc)}`);
    transcript.open();
    onSessionId(transcript.sessionId);

    try {
      // A reused per-target workspace still holds the LAST head's responses;
      // any unit id this document no longer lists would be ingested as if it
      // had been asked. Start from an empty directory.
      const responsesDir = join(prDir, RESPONSES_DIR);
      rmSync(responsesDir, { recursive: true, force: true });
      mkdirSync(responsesDir, { recursive: true });

      if (units.length === 0) {
        const text =
          `No units to survey — \`units.json\` lists none (coverage: ${doc.coverage ?? "unknown"}). ` +
          "No model call was made; `units-ingest` reports what that means for each family.";
        transcript.say(text);
        await transcript.close({ text, turns: 0, usage: totals, durationMs: Date.now() - startedAt, stopReason: "success" });
        log.info("unit survey: nothing to survey", { phase: phase.name, coverage: doc.coverage });
        return this.executionResult(true, text, 0, totals, startedAt, transcript.sessionId, "success");
      }

      const cacheDir = unitCacheDir(this.run.config.stateDir || resolve("data"), owner, repo);
      // Stable for everything the phase's calls share: the system prompt and
      // the requests' common head. Clamped well inside OpenAI's 64-char key.
      const promptCacheKey = `lastlight-units-${sha256(`${systemPromptSha256}\n${doc.sharedPrefixSha256 ?? ""}`).slice(0, 24)}`;
      const sharedPrefix = typeof doc.sharedPrefix === "string" && doc.sharedPrefix.length > 0 ? doc.sharedPrefix : undefined;
      const concurrency = this.concurrency();
      const call = this.run.callUnit ?? completeUnitCall;
      const t = transcript;

      const outcomes = await mapPool(units, concurrency, async (unit) => {
        const o = await this.surveyUnit(
          unit,
          { model, systemPrompt, systemPromptSha256, timeoutMs, cacheDir, call, promptCacheKey, sharedPrefix },
          t,
        );
        writeAtomic(join(responsesDir, `${unit.id}.json`), `${JSON.stringify(o.record, null, 2)}\n`);
        totals = addUsage(totals, o.record.usage);
        turns += o.calls;
        return o;
      });

      const ok = outcomes.filter((o) => o.record.ok).length;
      const cached = outcomes.filter((o) => o.record.cached).length;
      const failedUnits = outcomes.filter((o) => !o.record.ok).map((o) => o.record.unitId);
      const summary =
        `Surveyed ${units.length} unit(s): ${ok} ok, ${failedUnits.length} failed, ${cached} from cache — ` +
        `${turns} model call(s), $${totals.costUsd.toFixed(4)}.` +
        (failedUnits.length
          ? `\nFailed (no JSON object for the unit after the retry, or the call errored): ${failedUnits.join(", ")}. ` +
            "`units-ingest` records every obligation those units owned as unanswered — never dropped."
          : "");
      // Every unit failing is not a thin survey, it is a broken one (a bad key,
      // an unknown model): fail the phase so it is red where someone looks.
      // `units-ingest` still runs (`all_done`) and records the gap.
      const success = ok > 0;
      transcript.say(summary);
      await transcript.close({
        text: summary,
        turns,
        usage: totals,
        durationMs: Date.now() - startedAt,
        stopReason: success ? "success" : "error_survey_units",
      });
      log.info("unit survey finished", {
        phase: phase.name,
        units: units.length,
        ok,
        failed: failedUnits.length,
        cached,
        calls: turns,
        costUsd: totals.costUsd,
        concurrency,
        durationMs: Date.now() - startedAt,
      });
      return this.executionResult(
        success,
        summary,
        turns,
        totals,
        startedAt,
        transcript.sessionId,
        success ? "success" : "error_survey_units",
        success ? undefined : `survey-units: every one of ${units.length} unit call(s) failed — ${outcomes[0]?.record.error ?? "unknown error"}`,
      );
    } catch (err) {
      return failed(err instanceof Error ? err.message : String(err));
    }
  }

  /** One unit: a cache hit, or up to two calls. Never throws. */
  private async surveyUnit(
    unit: SurveyUnit,
    c: {
      model: string;
      systemPrompt: string;
      systemPromptSha256: string;
      timeoutMs: number;
      cacheDir: string;
      call: UnitModelCall;
      promptCacheKey: string;
      sharedPrefix?: string;
    },
    transcript: UnitSurveyTranscript,
  ): Promise<UnitOutcome> {
    const startedAt = Date.now();
    const requestSha256 = sha256(unit.request);
    if (unit.requestSha256 && unit.requestSha256 !== requestSha256) {
      log.warn("units.json requestSha256 does not match its request — caching on the request as sent", {
        unitId: unit.id,
      });
    }
    const contractSha = unit.requestSha256 ?? requestSha256;
    const key = cacheKey(c.model, c.systemPromptSha256, requestSha256);
    const args = {
      unitId: unit.id,
      symbol: unit.symbol,
      file: unit.file,
      lines: unit.lines,
      model: c.model,
      request: transcriptRequest(unit.request, c.sharedPrefix),
    };

    const hit = readCached(c.cacheDir, key);
    if (hit) {
      const record: UnitResponseRecord = {
        ...hit,
        unitId: unit.id,
        model: c.model,
        systemPromptSha256: c.systemPromptSha256,
        requestSha256: contractSha,
        cached: true,
        usage: { ...ZERO_USAGE },
        durationMs: Date.now() - startedAt,
      };
      transcript.call(
        `${unit.id}-cache`,
        `${unitLabel(unit)} — cache hit (an identical request was answered before); no model call.`,
        { ...args, cached: true },
        ZERO_USAGE,
        `[cached response]\n${hit.raw}`,
        false,
      );
      log.debug("unit survey cache hit", { unitId: unit.id });
      return { record, calls: 0 };
    }

    let usage: UnitCallUsage = { ...ZERO_USAGE };
    let raw = "";
    let error: string | null = null;
    let ok = false;
    let attempts = 0;
    // At most TWO calls: the retry is for a reply without the unit's JSON
    // object (or a call that failed outright). Transient provider faults are
    // already retried inside one call by `completeWithRetry`.
    while (attempts < 2 && !ok) {
      attempts += 1;
      const intro =
        attempts === 1
          ? `Surveying ${unitLabel(unit)}.`
          : `Retrying ${unit.id} once — the first attempt failed: ${error ?? "unknown"}`;
      const callStarted = Date.now();
      let callUsage: UnitCallUsage = { ...ZERO_USAGE };
      let callError: string | undefined;
      let text = "";
      try {
        const res = await c.call({
          model: c.model,
          systemPrompt: c.systemPrompt,
          request: unit.request,
          timeoutMs: c.timeoutMs,
          cacheKey: c.promptCacheKey,
        });
        text = res.text ?? "";
        callUsage = { ...ZERO_USAGE, ...res.usage };
        callError = res.error;
      } catch (err) {
        callError = err instanceof Error ? err.message : String(err);
      }
      usage = addUsage(usage, callUsage);
      raw = text;
      ok = callError === undefined && holdsUnitObject(text, unit.id);
      error = ok ? null : (callError ?? `the response holds no JSON object whose \`unitId\` is "${unit.id}"`);

      transcript.call(
        `${unit.id}-a${attempts}`,
        intro,
        attempts === 1 ? args : { ...args, attempt: attempts },
        callUsage,
        callError !== undefined ? callError : text || "(empty response)",
        !ok,
      );
      log.debug("unit survey call", {
        unitId: unit.id,
        attempt: attempts,
        ok,
        durationMs: Date.now() - callStarted,
        costUsd: callUsage.costUsd,
      });
    }

    const record: UnitResponseRecord = {
      unitId: unit.id,
      model: c.model,
      systemPromptSha256: c.systemPromptSha256,
      requestSha256: contractSha,
      ok,
      cached: false,
      attempts,
      raw,
      error,
      usage,
      durationMs: Date.now() - startedAt,
    };
    if (ok) {
      try {
        writeAtomic(join(c.cacheDir, `${key}.json`), `${JSON.stringify(record)}\n`);
      } catch (err) {
        // A cache that cannot be written costs the next re-review a call; it
        // must never cost this one its answer.
        log.warn("could not write the unit survey cache", { unitId: unit.id, err });
      }
    } else {
      log.warn("unit survey unit failed after the retry", { unitId: unit.id, error });
    }
    return { record, calls: attempts };
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  private transcript(phase: PhaseDefinition, model: string, hostRepoDir: string, initialPrompt: string): UnitSurveyTranscript {
    // The checkout's own slug, as the phase's bash siblings use on `none`.
    // Never the chat slug: SessionReader's sandbox scope excludes it outright.
    const slug = projectSlugForCwd(hostRepoDir);
    return new UnitSurveyTranscript({
      sessionsDir: resolveSessionsDir(this.run.config),
      projectSlug: slug === CHAT_PROJECT_SLUG ? `${slug}-survey-units` : slug,
      model,
      phase: phase.name,
      initialPrompt,
    });
  }

  private executionResult(
    success: boolean,
    output: string,
    turns: number,
    usage: UnitCallUsage,
    startedAt: number,
    sessionId: string | undefined,
    stopReason: string,
    error?: string,
  ): ExecutionResult {
    return {
      success,
      output,
      turns,
      durationMs: Date.now() - startedAt,
      sessionId,
      costUsd: usage.costUsd,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadInputTokens: usage.cacheRead,
      cacheCreationInputTokens: usage.cacheWrite,
      stopReason,
      ...(success ? {} : { error: error ?? output }),
    };
  }

  /** YAML template first, then the resolver — `fanout.ts`'s precedence. */
  private resolveModel(phase: PhaseDefinition): string | undefined {
    const rendered = phase.model ? renderTemplate(phase.model, this.run.ctx) : "";
    return rendered || this.run.resolver.modelFor(phase.name) || undefined;
  }

  /**
   * Per-CALL budget, in seconds: the phase's own `timeout_seconds`, else the
   * run's agent limit (`timeouts.agentSeconds`, seeded from `sandbox.*`) — a
   * config key, never a literal (issue #385). One unit call is far smaller
   * than an agent session, so the agent limit is a ceiling, not a target.
   */
  private callTimeoutSeconds(phase: PhaseDefinition): number {
    const seconds = resolveTemplatedNumber(
      phase.timeout_seconds ?? { from: "timeouts.agentSeconds" },
      this.run.ctx,
      `${phase.name}.timeout_seconds (per unit call)`,
      this.run.ledger.logger,
    );
    if (seconds === undefined) throw new Error(`${phase.name}: per-call timeout did not resolve`);
    return seconds;
  }

  /** `surveyUnitConcurrency` off the run context, else the shipped default. */
  private concurrency(): number {
    const raw = Number(this.run.ctx.surveyUnitConcurrency);
    const n = Number.isFinite(raw) && raw > 0 ? Math.floor(raw) : defaultReviewPolicy().analysis.surveyUnitConcurrency;
    return Math.max(1, n);
  }

  private async fail(phase: PhaseDefinition, error: string): Promise<PhaseOutcome> {
    const result: PhaseResult = { phase: phase.name, success: false, output: "", error };
    await this.reporter.onEnd(phase.name, result);
    await this.reporter.step(phase.name, "failed", phase.messages?.on_failure);
    // A failed entry so the dashboard pipeline renders this node red —
    // `persistPhase` only writes success entries (post-review's reasoning).
    if (this.run.store && this.run.workflowId) {
      await this.run.store.runs.appendPhase(this.run.workflowId, phase.name, {
        phase: phase.name,
        timestamp: new Date().toISOString(),
        success: false,
        summary: error,
      });
    }
    return { results: [result], status: "failed" };
  }
}

/**
 * Bounded, order-preserving concurrent map — results land at their input
 * index however the pool interleaves. (`fanout.ts` has the same helper; each
 * handler keeps its own so neither imports the other's module.)
 */
async function mapPool<T, R>(items: readonly T[], limit: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/** Build the app-registered `survey-units` phase-type handler for a run. */
export function makeSurveyUnitsHandler(run: SurveyUnitsRunScope, reporter: PhaseReporter): PhaseTypeHandler {
  return new SurveyUnitsHandler(run, reporter);
}

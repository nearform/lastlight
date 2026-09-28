import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { completeSimple } from "@earendil-works/pi-ai/compat";
import type { Context, ThinkingLevel } from "@earendil-works/pi-ai";
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
import { HOST_READABLE_WORKSPACE, resolveHostRepoDir } from "./host-repo-dir.js";

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
 * see {@link HOST_READABLE_WORKSPACE}), so `loadConfig` refuses
 * `review.analysis.enabled` there at startup; the run-time check below is a guard
 * that degrades, never the primary refusal.
 *
 * **Degrade, don't fail.** Every path INSIDE the phase — no `units.json`, an
 * empty or unreadable one, every call failing, the phase deadline, a cancel —
 * ends in a SUCCEEDED phase with a loud summary and a warn log. A red phase
 * here would post nothing and re-arm the review sweep, while `units-ingest`
 * (which runs either way) already records every obligation no unit answered.
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
const INGEST_FILE = join("units", "ingest.json");

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
  /**
   * Why generation stopped, as pi-ai reports it (`stop` | `length` | …).
   * `length` is the one the handler acts on: the reply was cut at the output
   * cap, and re-sending the identical request would be cut there again, so it
   * is never retried.
   */
  stopReason?: string;
}

/**
 * ONE model call. Injected so tests run with no network; production uses
 * {@link completeUnitCall}. A throw is treated exactly like `error`.
 */
export type UnitModelCall = (args: {
  model: string;
  /** The phase's thinking level (`variant:`), or undefined for the provider default. */
  variant?: string;
  /** The SYSTEM text actually sent: the phase prompt, plus the shared prefix when split off. */
  systemPrompt: string;
  /** The USER message actually sent: the unit's request, minus the prefix when split off. */
  request: string;
  timeoutMs: number;
  /**
   * The same for every call of one phase — a provider-side cache ROUTING hint
   * (`sessionId` → OpenAI's `prompt_cache_key`), so concurrent calls that share
   * a prefix land where that prefix is already cached.
   */
  cacheKey: string;
  /** Aborted at the phase deadline or on a run cancel; the call must stop. */
  signal?: AbortSignal;
}) => Promise<UnitCallResult>;

const ZERO_USAGE: UnitCallUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 };

/** pi-ai's `reasoning` excludes `off` — its default IS no reasoning (chat-runner's rule). */
function thinkingLevel(variant: string | undefined): ThinkingLevel | undefined {
  if (!variant || variant === "off") return undefined;
  return variant as ThinkingLevel;
}

/**
 * The production {@link UnitModelCall}: pi-ai's `completeSimple`, resolved and
 * credentialed exactly as the in-process chat path does it (`chat-runner.ts`) —
 * a deployment's endpoint override, a named key env var, an OAuth subscription
 * token. Transient provider faults (429 / 5xx / network) are retried with
 * backoff by `completeWithRetry` INSIDE one attempt; the handler's own single
 * retry is for a reply that came back without a usable object for the unit.
 *
 * No explicit `maxTokens`: pi-ai sends the model's own output cap
 * (`options.maxTokens ?? model.maxTokens`), the most generous value there is,
 * and a reply that still hits it comes back `stopReason: "length"`.
 *
 * **Prompt caching.** The handler moves code-facts' byte-identical
 * `sharedPrefix` (the unit-independent questions, evidence record and rules)
 * OUT of the user message and onto the end of the system prompt, so every call
 * of a phase opens with the same system text. `cacheRetention: "short"` is
 * pi-ai's default, spelled out so a `PI_CACHE_RETENTION=long` in the harness
 * env cannot silently double the write price of a phase that re-asks within
 * minutes, not hours. What each provider does with it differs:
 *  - Anthropic caches only at explicit breakpoints. pi-ai folds
 *    `Context.systemPrompt` into a leading system message and emits it as
 *    `system: [{ type: "text", text, cache_control: { type: "ephemeral" } }]`
 *    (plus a second breakpoint on the last user block), so the system text —
 *    prompt AND shared prefix — is the cross-unit cache hit. It is cached only
 *    above the model's minimum cacheable length.
 *  - OpenAI-family prefix caching is automatic over any identical prefix
 *    (≥1024 tokens); `cacheKey` goes out as `prompt_cache_key` to keep
 *    concurrent calls on one cache.
 */
export const completeUnitCall: UnitModelCall = async ({
  model,
  variant,
  systemPrompt,
  request,
  timeoutMs,
  cacheKey,
  signal,
}) => {
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
  const reasoning = thinkingLevel(variant);
  const assistant = await completeWithRetry(completeSimple, resolved, context, {
    timeoutMs,
    cacheRetention: "short",
    sessionId: cacheKey,
    ...(resolved.api === "anthropic-messages" ? { onPayload: systemOnlyCacheBreakpoint } : {}),
    ...(signal ? { signal } : {}),
    ...(reasoning ? { reasoning } : {}),
    ...(key ? { apiKey: key } : {}),
  });
  const text = assistant.content
    .filter((c) => c.type === "text" && typeof (c as { text?: unknown }).text === "string")
    .map((c) => (c as { text: string }).text)
    .join("");
  const failed = assistant.stopReason === "error" || assistant.stopReason === "aborted";
  return {
    text,
    stopReason: assistant.stopReason,
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

/**
 * Keep Anthropic's cache breakpoint on the SYSTEM prompt only.
 *
 * pi-ai also marks the last user block `cache_control`, which is right for a
 * conversation and wrong here: a unit's user message is that unit's own
 * request, never sent twice, so the breakpoint bought a 1.25x cache WRITE on
 * every unit's unique input and no read. Measured on 1587-r2 (Haiku 4.5, v7,
 * 74 calls): 358k tokens written, 26k read — about 55% of the case's $0.81.
 * The system prompt (role + the shared prefix) is identical on every call and
 * keeps its breakpoint, which is the part worth caching.
 */
export function systemOnlyCacheBreakpoint(payload: unknown): unknown {
  const p = payload as { messages?: { content?: unknown }[] } | null;
  if (!p || !Array.isArray(p.messages)) return undefined;
  for (const m of p.messages) {
    if (!Array.isArray(m.content)) continue;
    for (const block of m.content as Record<string, unknown>[]) {
      if (block && typeof block === "object") delete block.cache_control;
    }
  }
  return p;
}

/**
 * What identifies the ENDPOINT a model string resolves to — provider, request
 * family, model id and base URL, after this deployment's `providers:`
 * overrides. Part of the reply cache key: the same `{{models.review-survey}}`
 * spelling pointed at a different gateway is a different model as far as a
 * cached reading is concerned. An unresolvable spec keys on itself (its call
 * fails anyway, and a failure is never cached).
 */
export function unitEndpointIdentity(model: string): string {
  try {
    const m = resolveModel(model);
    return [m.provider, m.api, m.id, m.baseUrl].join("|");
  } catch {
    return `unresolved|${model}`;
  }
}

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

export interface UnitsDocument {
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
  /** Why coverage is not `full` — the `units` CLI's own reasons, or the shell fallback's. */
  degraded?: { extractor?: string; reason?: string }[];
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
 * Read and shape-check `units.json`. Throws with a message fit for the loud
 * summary: the `units` phase ALWAYS writes a document (its shell fallback
 * included), so a missing or malformed one is a broken contract, never an
 * empty survey — the caller degrades on it rather than failing the phase.
 */
export function readUnitsDocument(path: string): UnitsDocument {
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

// ── The ONE reply rule ───────────────────────────────────────────────────────
//
// A COPY of the canonical `findUnitObject` / `isUsableUnitReply` in
// `packages/code-facts/src/unit-response.ts`, which `units-ingest` judges every
// reply by. Core may not import code-facts (see the module header), and the
// handler's retry and cache decisions must be the SAME decision ingest makes —
// a reply this accepts and ingest rejects was cached forever as an answer
// ingest would never use. Change the two together:
// `tests/workflows/survey-units.test.ts` carries a VERBATIM copy of the case
// tables in `packages/code-facts/tests/unit-reply.test.ts`.

/** Index just past the `{…}` opening at `start` (string-aware), or -1 if the text ends first. */
function objectEnd(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "\\") i += 1;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * `JSON.parse` plus one repair — a `"line"` number with leading zeros, copied
 * from the request's `L0142` tag. Mirrors code-facts' `parseReplyJson`.
 */
function parseReplyJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (err) {
    const repaired = text.replace(/("line"\s*:\s*)0+(\d)/g, "$1$2");
    if (repaired === text) throw err;
    return JSON.parse(repaired) as unknown;
  }
}

/**
 * Every balanced top-level `{…}` span in `text` that parses as a JSON object,
 * in order. An UNCLOSED `{` (a stray brace in prose, a truncated reply) is
 * skipped and the scan CONTINUES from the next character — never abandoned —
 * and so is a balanced span that is not JSON.
 */
function objectSpans(text: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  let pos = 0;
  while (pos < text.length) {
    const start = text.indexOf("{", pos);
    if (start === -1) break;
    const end = objectEnd(text, start);
    if (end !== -1) {
      try {
        const value = parseReplyJson(text.slice(start, end));
        if (isPlainObject(value)) {
          out.push(value);
          pos = end;
          continue;
        }
      } catch {
        /* balanced but not JSON — try the next brace */
      }
    }
    pos = start + 1;
  }
  return out;
}

/** The bodies of the ``` fences in `text`, in order — scanned on their own too, so a quote in prose cannot hide one. */
function fencedBodies(text: string): string[] {
  const out: string[] = [];
  for (const m of text.matchAll(/```[^\n`]*\n([\s\S]*?)```/g)) out.push(m[1]);
  return out;
}

/**
 * The reply object for `unitId` in a model's raw text, or `null` — the
 * canonical rule, step for step:
 *
 *   1. Candidates are every balanced top-level `{…}` span that parses as a JSON
 *      object — first across the whole of `raw`, then inside each ``` fence
 *      body — in that order (see `objectSpans`).
 *   2. The FIRST candidate whose `unitId` is exactly `unitId` is the reply.
 *   3. Otherwise ONE level of nesting: per candidate, a property value that is
 *      an object with that `unitId`, or such an object element of a property
 *      value that is an array (`{"result": {…}}`, `{"units": [{…}]}`).
 *   4. Otherwise `null`. An object naming ANOTHER unit is never this unit's.
 */
export function findUnitObject(raw: string, unitId: string): Record<string, unknown> | null {
  const candidates = [raw, ...fencedBodies(raw)].flatMap(objectSpans);
  const direct = candidates.find((c) => c.unitId === unitId);
  if (direct) return direct;
  for (const c of candidates) {
    for (const v of Object.values(c)) {
      const inner = Array.isArray(v) ? v : [v];
      const hit = inner.find((e): e is Record<string, unknown> => isPlainObject(e) && e.unitId === unitId);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * Whether a found object is a reply `units-ingest` can use: an object naming
 * this unit, with `answers` and `defects` both arrays (possibly empty). The
 * entries are not inspected — a malformed entry is ingest's to record, never a
 * reason to re-ask.
 */
export function isUsableUnitReply(obj: unknown, unitId: string): boolean {
  return isPlainObject(obj) && obj.unitId === unitId && Array.isArray(obj.answers) && Array.isArray(obj.defects);
}

/** The handler's one decision about a reply: {@link findUnitObject} then {@link isUsableUnitReply}. */
export function usableUnitReply(raw: string, unitId: string): boolean {
  return isUsableUnitReply(findUnitObject(raw, unitId), unitId);
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
 * Readings cached OUTSIDE the per-run workspace, so a re-review of the same
 * repo reuses every unit whose request did not change — the other half of the
 * perch shape. Keyed on everything that determines the reply: the RESOLVED
 * endpoint ({@link unitEndpointIdentity} — provider, api, model id, base URL),
 * the thinking level, and the hashes of the system text and the user message
 * actually sent (which together carry the prompt, the shared prefix, the
 * unit's code, its obligations and code-facts' `promptVersion`).
 *
 * Only replies that pass the ONE reply rule ({@link usableUnitReply}) are
 * stored, and a hit is re-checked against it — so an entry written under a
 * looser rule is ignored rather than replayed. An entry `units-ingest` later
 * judged `invalid` / `partial` is EVICTED at the start of the next run (see
 * `previousBadRequests`). Scoped by `<owner>/<repo>` so one repository's cache
 * cannot answer for another's, even on an identical request.
 */
export function unitCacheDir(stateDir: string, owner: string, repo: string): string {
  const safe = (s: string) => (s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/, "_") || "_");
  return join(stateDir, "unit-survey-cache", safe(owner), safe(repo));
}

/** Version-tagged, so a change to what the key covers never replays an old entry. */
function cacheKey(k: { endpoint: string; variant: string | undefined; systemSha256: string; userSha256: string }): string {
  return sha256(["unit-cache-v2", k.endpoint, k.variant ?? "", k.systemSha256, k.userSha256].join("\n"));
}

function readCached(dir: string, key: string, unitId: string): UnitResponseRecord | undefined {
  try {
    const rec = JSON.parse(readFileSync(join(dir, `${key}.json`), "utf8")) as UnitResponseRecord;
    return rec && rec.ok === true && typeof rec.raw === "string" && usableUnitReply(rec.raw, unitId) ? rec : undefined;
  } catch {
    return undefined;
  }
}

/** Remove one cache entry; true when there was one. Never throws. */
function evictCached(dir: string, key: string): boolean {
  try {
    unlinkSync(join(dir, `${key}.json`));
    return true;
  } catch {
    return false;
  }
}

/** `units-ingest` statuses that mean a reply the handler accepted was not an answer. */
const EVICT_STATUSES = new Set(["invalid", "partial"]);

/**
 * The requests whose cached reply the LAST run's `units-ingest` rejected, read
 * from the previous `units/ingest.json` + `units/responses/<id>.json` BEFORE
 * this run clears them. Ingest's report carries the unit id and status but not
 * the request, so the response record left beside it supplies the
 * `requestSha256`; the caller evicts the cache entry that request would hit.
 *
 * Best-effort and logged: any unreadable piece means nothing to evict, which
 * costs at worst one replay of a reply ingest will record as unanswered again.
 */
function previousBadRequests(prDir: string, phase: string): Set<string> {
  const out = new Set<string>();
  let report: unknown;
  try {
    report = JSON.parse(readFileSync(join(prDir, INGEST_FILE), "utf8"));
  } catch {
    return out; // no previous ingest — the normal first run
  }
  const units = isPlainObject(report) && Array.isArray(report.units) ? report.units : [];
  for (const u of units) {
    if (!isPlainObject(u) || typeof u.unitId !== "string" || !EVICT_STATUSES.has(String(u.status))) continue;
    if (!SAFE_UNIT_ID.test(u.unitId)) continue;
    try {
      const rec = JSON.parse(readFileSync(join(prDir, RESPONSES_DIR, `${u.unitId}.json`), "utf8")) as unknown;
      if (isPlainObject(rec) && typeof rec.requestSha256 === "string") out.add(rec.requestSha256);
    } catch (err) {
      log.warn("unit survey: ingest rejected a reply whose response record is unreadable — cannot evict it", {
        phase,
        unitId: u.unitId,
        status: u.status,
        err,
      });
    }
  }
  if (out.size) log.info("unit survey: evicting replies the last ingest rejected", { phase, requests: out.size });
  return out;
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
function manifest(units: SurveyUnit[], doc: UnitsDocument, prefixInSystem: boolean): string {
  const head = [
    "---",
    "",
    `## Units to survey (${units.length})`,
    "",
    `coverage: ${doc.coverage ?? "unknown"} · promptVersion: ${doc.promptVersion ?? "unknown"}`,
    "",
    prefixInSystem
      ? "The prompt above, followed by the shared request prefix below, is the SYSTEM prompt of every call; each call's user message is the rest of its unit's `request`."
      : "The prompt above is the SYSTEM prompt of every call below; each call's user message is its unit's `request`, verbatim.",
    "",
  ];
  if (units.length === 0) return [...head, "(none — `units.json` lists no units)"].join("\n");
  const rows = units.map((u) => {
    const families = u.families?.length ? ` · families ${u.families.join(", ")}` : "";
    const obligations = u.obligationIds?.length ? ` · obligations ${u.obligationIds.join(", ")}` : "";
    return `- ${unitLabel(u)}${families}${obligations}${u.truncated ? " · TRUNCATED" : ""}`;
  });
  const shared = doc.sharedPrefix
    ? [
        "",
        "## Shared request prefix",
        "",
        prefixInSystem
          ? "Every request opens with these bytes. They were sent ONCE per call as the end of the system prompt (the cache breakpoint), not in the user message; the calls record them as a one-line marker."
          : "Every request below opens with these bytes; the calls record it as a one-line marker.",
        "",
        doc.sharedPrefix,
      ]
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
  /** Test seam — how often the run row is polled for a cancel. Default 5 s. */
  cancelPollMs?: number;
}

/** What one unit came to — its response record, and the calls it spent. */
export interface UnitOutcome {
  record: UnitResponseRecord;
  calls: number;
}

/**
 * Where each call is reported as it completes — the phase transcript
 * ({@link UnitSurveyTranscript}) in production; nothing in the evals replay.
 */
export interface UnitSurveySink {
  call(toolCallId: string, text: string, args: Record<string, unknown>, usage: UnitCallUsage, result: string, isError: boolean): void;
}

/** Everything one unit's survey shares with its siblings in a phase. */
interface UnitCallPlan {
  model: string;
  variant: string | undefined;
  endpoint: string;
  /** The SYSTEM text sent (prompt, plus the shared prefix when split off) and its hash. */
  systemText: string;
  systemSha256: string;
  /** Present when the shared prefix moved into the system text — sliced off each request. */
  splitPrefix: string | undefined;
  /** The document's shared prefix, for the transcript's one-line marker. */
  sharedPrefix: string | undefined;
  deadlineAt: number;
  signal: AbortSignal;
  /** The reply cache; `undefined` = no cache at all (nothing read, evicted or written). */
  cacheDir: string | undefined;
  call: UnitModelCall;
  promptCacheKey: string;
  /** Requests whose cached reply the last `units-ingest` rejected — evicted, then asked again. */
  evict: Set<string>;
  transcript?: UnitSurveySink;
}

/**
 * The SYSTEM text every call of a survey sends, and how it was decided.
 *
 * The shared prefix goes to the SYSTEM prompt — where pi-ai puts Anthropic's
 * cache breakpoint — only when every request really opens with it and keeps
 * something after it. Otherwise every request is sent verbatim.
 */
export function unitSurveySystemText(
  systemPrompt: string,
  doc: Pick<UnitsDocument, "units" | "sharedPrefix">,
): { systemText: string; systemSha256: string; sharedPrefix: string | undefined; splitPrefix: string | undefined } {
  const units = doc.units;
  const sharedPrefix = typeof doc.sharedPrefix === "string" && doc.sharedPrefix.length > 0 ? doc.sharedPrefix : undefined;
  const splitPrefix =
    sharedPrefix && units.length > 0 && units.every((u) => u.request.startsWith(sharedPrefix) && u.request.length > sharedPrefix.length)
      ? sharedPrefix
      : undefined;
  const systemText = splitPrefix ? `${systemPrompt}\n\n${splitPrefix}` : systemPrompt;
  return { systemText, systemSha256: sha256(systemText), sharedPrefix, splitPrefix };
}

/** Inputs of {@link runUnitSurvey} — everything the phase resolved, nothing it reads from a run. */
export interface RunUnitSurveyOptions {
  /** The units document (`units.json`), already read. */
  doc: Pick<UnitsDocument, "units" | "sharedPrefix">;
  /** The RENDERED phase prompt (`prompts/survey-unit.md`). */
  systemPrompt: string;
  /** The resolved `provider/model` spec. */
  model: string;
  /** Thinking level (`variant:`); undefined = the provider default. */
  variant?: string;
  concurrency: number;
  /** Epoch ms the whole survey must finish by — each call's timeout is what is left. */
  deadlineAt: number;
  /** Aborted at the deadline or on a cancel; every call in flight stops. */
  signal: AbortSignal;
  /** Where `<unitId>.json` response records are written (created if absent; NOT cleared). */
  responsesDir: string;
  /** The reply cache directory. Omit for NO cache — nothing read, evicted or written. */
  cacheDir?: string;
  /** Requests whose cached reply must be evicted and asked again. */
  evict?: Set<string>;
  /** The model call. Defaults to {@link completeUnitCall}. */
  call?: UnitModelCall;
  transcript?: UnitSurveySink;
  /** Called as each unit settles (its response file written or failed), in completion order. */
  onSettled?: (outcome: UnitOutcome) => void;
}

/** What {@link runUnitSurvey} came to. `outcomes` is in document order. */
export interface UnitSurveyRun {
  outcomes: UnitOutcome[];
  usage: UnitCallUsage;
  /** Model calls made (a cache hit is none). */
  calls: number;
  systemSha256: string;
  /** Whether the shared prefix went out as system text. */
  prefixInSystem: boolean;
}

/**
 * The model half of the unit survey, with no run, ledger or transcript of its
 * own: one bounded call per unit (a cache hit, or up to two calls — see
 * `surveyUnit`), `concurrency` at a time, one `<unitId>.json` per unit under
 * `responsesDir`. Every unit settles — a throw anywhere in one unit (a
 * response file that cannot be written, a bug) becomes THAT unit's failure, so
 * the pool always drains. The phase handler wraps this; the evals replay calls
 * it directly, with no cache, so every replay pays and measures.
 */
export async function runUnitSurvey(opts: RunUnitSurveyOptions): Promise<UnitSurveyRun> {
  const { systemText, systemSha256, sharedPrefix, splitPrefix } = unitSurveySystemText(opts.systemPrompt, opts.doc);
  const plan: UnitCallPlan = {
    model: opts.model,
    variant: opts.variant,
    endpoint: unitEndpointIdentity(opts.model),
    systemText,
    systemSha256,
    splitPrefix,
    sharedPrefix,
    deadlineAt: opts.deadlineAt,
    signal: opts.signal,
    cacheDir: opts.cacheDir,
    call: opts.call ?? completeUnitCall,
    // Stable for everything the phase's calls share — the system text.
    // Clamped well inside OpenAI's 64-char key.
    promptCacheKey: `lastlight-units-${systemSha256.slice(0, 24)}`,
    evict: opts.evict ?? new Set(),
    ...(opts.transcript ? { transcript: opts.transcript } : {}),
  };
  let usage: UnitCallUsage = { ...ZERO_USAGE };
  let calls = 0;
  const surveyOne = async (unit: SurveyUnit): Promise<UnitOutcome> => {
    let o: UnitOutcome;
    try {
      o = await surveyUnit(unit, plan);
    } catch (err) {
      const error = `the unit's survey threw: ${err instanceof Error ? err.message : String(err)}`;
      log.error("unit survey threw", { unitId: unit.id, err });
      o = { record: failedRecord(unit, plan, error, 0), calls: 0 };
    }
    try {
      writeAtomic(join(opts.responsesDir, `${unit.id}.json`), `${JSON.stringify(o.record, null, 2)}\n`);
    } catch (err) {
      const error = `could not write the response file: ${err instanceof Error ? err.message : String(err)}`;
      log.error("unit survey: response file not written", { unitId: unit.id, err });
      o = { ...o, record: { ...o.record, ok: false, error } };
    }
    usage = addUsage(usage, o.record.usage);
    calls += o.calls;
    opts.onSettled?.(o);
    return o;
  };
  // WARM the prompt cache: one unit alone first, then the rest in parallel.
  // Fired together, every call starts before any cache entry exists, so all of
  // them WRITE the shared system prompt and none reads it (Haiku 4.5, v7:
  // 358k written / 26k read on a 74-call case). One call's latency buys every
  // other call a cache read of the ~11k-char system text.
  const units = opts.doc.units;
  const limit = Math.max(1, Math.floor(opts.concurrency));
  const outcomes: UnitOutcome[] =
    units.length > 1 && limit > 1
      ? [await surveyOne(units[0]), ...(await mapPool(units.slice(1), limit, surveyOne))]
      : await mapPool(units, limit, surveyOne);
  return { outcomes, usage, calls, systemSha256, prefixInSystem: !!splitPrefix };
}

/** One unit: a cache hit, or up to two calls. Never throws on a model failure. */
async function surveyUnit(unit: SurveyUnit, c: UnitCallPlan): Promise<UnitOutcome> {
  const startedAt = Date.now();
  const requestSha256 = sha256(unit.request);
  if (unit.requestSha256 && unit.requestSha256 !== requestSha256) {
    log.warn("units.json requestSha256 does not match its request — caching on the request as sent", {
      unitId: unit.id,
    });
  }
  const contractSha = unit.requestSha256 ?? requestSha256;
  const userText = c.splitPrefix ? unit.request.slice(c.splitPrefix.length) : unit.request;
  const key = cacheKey({ endpoint: c.endpoint, variant: c.variant, systemSha256: c.systemSha256, userSha256: sha256(userText) });
  const args = {
    unitId: unit.id,
    symbol: unit.symbol,
    file: unit.file,
    lines: unit.lines,
    model: c.model,
    request: transcriptRequest(unit.request, c.sharedPrefix),
  };

  // No cache dir ⇒ no cache at all: nothing read, evicted or written (the
  // evals replay runs this way, so every run pays and measures).
  if (c.cacheDir === undefined) {
    /* uncached */
  } else if (c.evict.has(contractSha) || c.evict.has(requestSha256)) {
    if (evictCached(c.cacheDir, key)) {
      log.info("unit survey: evicted a cached reply the last ingest rejected", { unitId: unit.id });
    }
  } else {
    const hit = readCached(c.cacheDir, key, unit.id);
    if (hit) {
      const record: UnitResponseRecord = {
        ...hit,
        unitId: unit.id,
        model: c.model,
        systemPromptSha256: c.systemSha256,
        requestSha256: contractSha,
        cached: true,
        usage: { ...ZERO_USAGE },
        durationMs: Date.now() - startedAt,
      };
      c.transcript?.call(
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
  }

  let usage: UnitCallUsage = { ...ZERO_USAGE };
  let raw = "";
  let error: string | null = null;
  let ok = false;
  let attempts = 0;
  // At most TWO calls: the retry is for a reply without a usable object for
  // the unit (or a call that failed outright). Never after the phase was
  // aborted, and never after a reply cut at the output cap — the identical
  // request would stop there again. Transient provider faults are already
  // retried inside one call by `completeWithRetry`.
  while (attempts < 2 && !ok) {
    if (c.signal.aborted) break;
    attempts += 1;
    const intro =
      attempts === 1
        ? `Surveying ${unitLabel(unit)}.`
        : `Retrying ${unit.id} once — the first attempt failed: ${error ?? "unknown"}`;
    const callStarted = Date.now();
    let callUsage: UnitCallUsage = { ...ZERO_USAGE };
    let callError: string | undefined;
    let stopReason: string | undefined;
    let text = "";
    try {
      const res = await c.call({
        model: c.model,
        ...(c.variant ? { variant: c.variant } : {}),
        systemPrompt: c.systemText,
        request: userText,
        timeoutMs: Math.max(1000, c.deadlineAt - Date.now()),
        cacheKey: c.promptCacheKey,
        signal: c.signal,
      });
      text = res.text ?? "";
      callUsage = { ...ZERO_USAGE, ...res.usage };
      callError = res.error;
      stopReason = res.stopReason;
    } catch (err) {
      callError = err instanceof Error ? err.message : String(err);
    }
    // An abort during the call is recorded as the phase's reason, whatever
    // shape the provider gave it.
    if (c.signal.aborted) callError = String(c.signal.reason);
    usage = addUsage(usage, callUsage);
    raw = text;
    ok = callError === undefined && usableUnitReply(text, unit.id);
    const truncated = !ok && callError === undefined && stopReason === "length";
    error = ok
      ? null
      : (callError ??
        (truncated
          ? "the reply stopped at the output-token cap (stopReason: length) before holding a usable object — not retried, the identical request would stop there again"
          : `the response holds no usable JSON object for unitId "${unit.id}" (it must name the unit and carry \`answers\` and \`defects\` arrays)`));

    c.transcript?.call(
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
      stopReason,
      durationMs: Date.now() - callStarted,
      costUsd: callUsage.costUsd,
    });
    if (truncated || c.signal.aborted) break;
  }

  if (attempts === 0) {
    // Aborted before this unit's first call: it is still RECORDED — in the
    // transcript and as a response — never silently missing.
    const reason = String(c.signal.reason ?? PHASE_DEADLINE);
    c.transcript?.call(`${unit.id}-stopped`, `${unitLabel(unit)} — not surveyed: ${reason}.`, args, ZERO_USAGE, reason, true);
    log.warn("unit survey unit not started", { unitId: unit.id, reason });
    return { record: failedRecord(unit, c, reason, 0, Date.now() - startedAt), calls: 0 };
  }

  const record: UnitResponseRecord = {
    unitId: unit.id,
    model: c.model,
    systemPromptSha256: c.systemSha256,
    requestSha256: contractSha,
    ok,
    cached: false,
    attempts,
    raw,
    error,
    usage,
    durationMs: Date.now() - startedAt,
  };
  if (ok && c.cacheDir !== undefined) {
    try {
      writeAtomic(join(c.cacheDir, `${key}.json`), `${JSON.stringify(record)}\n`);
    } catch (err) {
      // A cache that cannot be written costs the next re-review a call; it
      // must never cost this one its answer.
      log.warn("could not write the unit survey cache", { unitId: unit.id, err });
    }
  } else if (!ok) {
    log.warn("unit survey unit failed", { unitId: unit.id, attempts, error });
  }
  return { record, calls: attempts };
}


function failedRecord(
  unit: SurveyUnit,
  c: Pick<UnitCallPlan, "model" | "systemSha256">,
  error: string,
  attempts: number,
  durationMs = 0,
): UnitResponseRecord {
  return {
    unitId: unit.id,
    model: c.model,
    systemPromptSha256: c.systemSha256,
    requestSha256: unit.requestSha256 ?? sha256(unit.request),
    ok: false,
    cached: false,
    attempts,
    raw: "",
    error,
    usage: { ...ZERO_USAGE },
    durationMs,
  };
}


/** The reasons a phase's AbortController fires with — also each unfinished unit's recorded error. */
const PHASE_DEADLINE = "phase deadline";
const RUN_CANCELLED = "run cancelled";

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
      // Only the LEDGER itself can land here — `survey` degrades every failure
      // of its own. A store that cannot record the phase is not a survey
      // outcome, so it stays red.
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
   *
   * SUCCEEDS on every path (see the module header): a degraded survey is a
   * loud summary on a green phase, never a red one.
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

    /** Nothing (more) was surveyed: say why, loudly, and SUCCEED. */
    const degrade = async (reason: string, opening = ""): Promise<ExecutionResult> => {
      const text =
        `SURVEY DEGRADED — ${reason}\n` +
        "No survey reading exists for any unit not answered above. `units-ingest` records every obligation " +
        "those units owned as unanswered (routed to a probe), so nothing here may be read as \"no findings\".";
      log.warn("unit survey degraded", { phase: phase.name, reason });
      if (!transcript) {
        transcript = this.transcript(phase, model ?? "", hostRepoDir, (opening || reason).trim());
        transcript.open();
        onSessionId(transcript.sessionId);
      }
      transcript.say(text);
      await transcript.close({ text, turns, usage: totals, durationMs: Date.now() - startedAt, stopReason: "success" });
      return this.executionResult(text, turns, totals, startedAt, transcript.sessionId);
    };

    // A backend with no host checkout is refused at config load
    // (`assertReviewAnalysisSupported`); this is the belt to that. It comes
    // FIRST and touches nothing on disk: on kubernetes a `units.json` may even
    // be readable (the artifact upload unpacks `.lastlight/` host-side), but a
    // response written here would never reach the pod `units-ingest` runs in.
    if (!HOST_READABLE_WORKSPACE[this.run.backend]) {
      return degrade(
        `the ${this.run.backend} backend has no host checkout, so the harness cannot read units.json or write ` +
          "the responses. `review.analysis.enabled` should have been refused at startup on this backend.",
      );
    }

    let evict = new Set<string>();
    try {
      // Read what the LAST run's ingest rejected before its evidence is
      // cleared, then clear: a reused per-target workspace still holds the
      // last head's responses, and any unit id this document no longer lists
      // would be ingested as if it had been asked. Cleared on EVERY path below,
      // degraded ones included — a stale response is worse than none.
      evict = previousBadRequests(prDir, phase.name);
      const responsesDir = join(prDir, RESPONSES_DIR);
      rmSync(responsesDir, { recursive: true, force: true });
      mkdirSync(responsesDir, { recursive: true });
    } catch (err) {
      return degrade(`could not prepare ${join(prDir, RESPONSES_DIR)}: ${err instanceof Error ? err.message : String(err)}`);
    }

    if (!model) {
      return degrade(
        `no model resolved for phase \`${phase.name}\` — set \`models.review-survey\` (or the phase's \`model:\`)`,
      );
    }
    if (!phase.prompt) return degrade(`phase \`${phase.name}\` has no \`prompt:\``);

    let systemPrompt: string;
    let doc: UnitsDocument;
    let deadlineSeconds: number;
    try {
      systemPrompt = renderTemplate(this.run.assets.loadPromptTemplate(phase.prompt), this.run.ctx);
      deadlineSeconds = this.deadlineSeconds(phase);
    } catch (err) {
      return degrade(err instanceof Error ? err.message : String(err));
    }
    try {
      doc = readUnitsDocument(join(prDir, UNITS_FILE));
    } catch (err) {
      return degrade(err instanceof Error ? err.message : String(err), systemPrompt);
    }

    const units = doc.units;
    const { sharedPrefix, splitPrefix } = unitSurveySystemText(systemPrompt, doc);
    if (sharedPrefix && units.length > 0 && !splitPrefix) {
      log.warn("units.json sharedPrefix is not the head of every request — sending each request verbatim", {
        phase: phase.name,
      });
    }

    transcript = this.transcript(phase, model, hostRepoDir, `${systemPrompt.trimEnd()}\n\n${manifest(units, doc, !!splitPrefix)}`);
    transcript.open();
    onSessionId(transcript.sessionId);

    if (units.length === 0) {
      const reasons = (doc.degraded ?? []).map((d) => d.reason).filter((r): r is string => typeof r === "string" && r.length > 0);
      if (doc.coverage === "none" || reasons.length > 0) {
        // The shell fallback's shape: `units` could not cut the PR at all. NOT
        // "there was nothing to survey".
        return degrade(
          `No units to survey — \`units.json\` lists none and its coverage is "${doc.coverage ?? "unknown"}"` +
            (reasons.length ? `: ${reasons.join("; ")}` : "") +
            ". No model call was made.",
        );
      }
      const text =
        `No units to survey — \`units.json\` lists none (coverage: ${doc.coverage ?? "unknown"}). ` +
        "No model call was made; `units-ingest` reports what that means for each family.";
      transcript.say(text);
      await transcript.close({ text, turns: 0, usage: totals, durationMs: Date.now() - startedAt, stopReason: "success" });
      log.info("unit survey: nothing to survey", { phase: phase.name, coverage: doc.coverage });
      return this.executionResult(text, 0, totals, startedAt, transcript.sessionId);
    }

    // One controller over every call of the phase: the deadline, and a run
    // cancel noticed by polling the run row (the handler scope carries no
    // signal of its own; the scheduler checks the same row between phases).
    const controller = new AbortController();
    const deadlineAt = Date.now() + deadlineSeconds * 1000;
    const deadline = setTimeout(() => controller.abort(PHASE_DEADLINE), deadlineSeconds * 1000);
    deadline.unref?.();
    const stopCancelPoll = this.pollForCancel(controller);

    const t = transcript;
    try {
      const concurrency = this.concurrency();
      // Every unit settles inside the runner, so the pool always drains before
      // the transcript is finalized and nothing writes a line after the
      // `result`. Totals accumulate as units settle, so a degrade below still
      // reports what was spent.
      const { outcomes } = await runUnitSurvey({
        doc,
        systemPrompt,
        model,
        variant: this.resolveVariant(phase),
        concurrency,
        deadlineAt,
        signal: controller.signal,
        responsesDir: join(prDir, RESPONSES_DIR),
        cacheDir: unitCacheDir(this.run.config.stateDir || resolve("data"), owner, repo),
        evict,
        call: this.run.callUnit ?? completeUnitCall,
        transcript: t,
        onSettled: (o) => {
          totals = addUsage(totals, o.record.usage);
          turns += o.calls;
        },
      });

      const ok = outcomes.filter((o) => o.record.ok).length;
      const cached = outcomes.filter((o) => o.record.cached).length;
      const failedUnits = outcomes.filter((o) => !o.record.ok);
      const stopped = controller.signal.aborted ? String(controller.signal.reason) : undefined;
      const head =
        `Surveyed ${units.length} unit(s): ${ok} ok, ${failedUnits.length} failed, ${cached} from cache — ` +
        `${turns} model call(s), $${totals.costUsd.toFixed(4)}.`;
      const failures = failedUnits.length
        ? `\nFailed: ${failedUnits.map((o) => `${o.record.unitId} (${o.record.error ?? "unknown"})`).join(", ")}. ` +
          "`units-ingest` records every obligation those units owned as unanswered — never dropped."
        : "";
      const summary =
        ok === 0
          ? `SURVEY DEGRADED — EVERY one of ${units.length} unit(s) failed (first error: ${failedUnits[0]?.record.error ?? "unknown"}). ` +
            "This looks like a bad key, an unknown model or a provider outage, not a thin survey.\n" +
            head +
            failures
          : `${stopped ? `SURVEY STOPPED EARLY (${stopped}). ` : ""}${head}${failures}`;
      transcript.say(summary);
      await transcript.close({ text: summary, turns, usage: totals, durationMs: Date.now() - startedAt, stopReason: "success" });
      const fields = {
        phase: phase.name,
        units: units.length,
        ok,
        failed: failedUnits.length,
        cached,
        calls: turns,
        costUsd: totals.costUsd,
        concurrency,
        stopped,
        durationMs: Date.now() - startedAt,
      };
      if (ok === 0 || stopped) log.warn("unit survey finished degraded", fields);
      else log.info("unit survey finished", fields);
      return this.executionResult(summary, turns, totals, startedAt, transcript.sessionId);
    } catch (err) {
      return degrade(err instanceof Error ? err.message : String(err));
    } finally {
      clearTimeout(deadline);
      stopCancelPoll();
    }
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Abort `controller` when the run row turns `cancelled`. The admin cancel
   * only flips the row (and kills sandbox containers — this phase has none),
   * so polling it is the only way an in-process phase hears of it. Returns
   * the stopper. Best-effort: a store error stops nothing.
   */
  private pollForCancel(controller: AbortController): () => void {
    const { store, workflowId } = this.run;
    if (!store || !workflowId) return () => {};
    const timer = setInterval(() => {
      void store.runs
        .getRun(workflowId)
        .then((run) => {
          if (run?.status === "cancelled" && !controller.signal.aborted) controller.abort(RUN_CANCELLED);
        })
        .catch((err: unknown) => log.debug("unit survey: cancel poll failed", { err }));
    }, this.run.cancelPollMs ?? 5000);
    timer.unref?.();
    return () => clearInterval(timer);
  }

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

  /** Always a SUCCESS — every outcome of the survey itself degrades, never fails. */
  private executionResult(
    output: string,
    turns: number,
    usage: UnitCallUsage,
    startedAt: number,
    sessionId: string | undefined,
  ): ExecutionResult {
    return {
      success: true,
      output,
      turns,
      durationMs: Date.now() - startedAt,
      sessionId,
      costUsd: usage.costUsd,
      inputTokens: usage.input,
      outputTokens: usage.output,
      cacheReadInputTokens: usage.cacheRead,
      cacheCreationInputTokens: usage.cacheWrite,
      stopReason: "success",
    };
  }

  /** YAML template first, then the resolver — `fanout.ts`'s precedence. */
  private resolveModel(phase: PhaseDefinition): string | undefined {
    const rendered = phase.model ? renderTemplate(phase.model, this.run.ctx) : "";
    return rendered || this.run.resolver.modelFor(phase.name) || undefined;
  }

  /** The thinking level, resolved exactly as an agent phase's `variant:` is. */
  private resolveVariant(phase: PhaseDefinition): string | undefined {
    const rendered = phase.variant ? renderTemplate(phase.variant, this.run.ctx).trim() : "";
    return rendered || this.run.resolver.variantFor(phase.name) || undefined;
  }

  /**
   * The WHOLE-PHASE deadline, in seconds: the phase's `timeout_seconds`
   * (`{ from: surveyUnitsTimeoutSeconds }` in the packaged YAML), else the
   * run's agent limit (`timeouts.agentSeconds`) — a config key, never a
   * literal (issue #385).
   */
  private deadlineSeconds(phase: PhaseDefinition): number {
    const seconds = resolveTemplatedNumber(
      phase.timeout_seconds ?? { from: "timeouts.agentSeconds" },
      this.run.ctx,
      `${phase.name}.timeout_seconds (the whole-phase deadline)`,
      this.run.ledger.logger,
    );
    if (seconds === undefined) throw new Error(`${phase.name}: the phase deadline did not resolve`);
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
 * index however the pool interleaves. `fn` must not throw (the caller settles
 * each unit itself), so every worker runs to the end of the list and the pool
 * resolves only once every item has. (`fanout.ts` has the same helper; each
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

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { AgentWorkflowSchema } from "lastlight-workflow-engine";
import type {
  AssetLoader,
  DagNode,
  ExecutorConfig,
  GitSandboxAccess,
  PhaseDefinition,
  PhaseResolver,
  TemplateContext,
} from "lastlight-workflow-engine";
import {
  InMemoryStateStore,
  RecordingReporter,
  noopLiveness,
  noopObservability,
} from "lastlight-workflow-engine/test-support";
import {
  SURVEY_UNIT_TOOL,
  findUnitObject,
  isUsableUnitReply,
  makeSurveyUnitsHandler,
  runUnitSurvey,
  systemOnlyCacheBreakpoint,
  unitCacheDir,
  usableUnitReply,
  type UnitCallResult,
  type UnitModelCall,
  type UnitResponseRecord,
} from "#src/workflows/handlers/survey-units.js";
import { SessionReader } from "#src/admin/sessions.js";
import type { SandboxBackend } from "#src/config/config.js";
import { installProviderOverrides } from "#src/config/provider-registry.js";

/**
 * The `survey-units` phase (docs/plans/pr-review-units-sites.md): one model call per
 * unit, from the harness, against the host checkout. Everything here runs with
 * a FAKE model call — the handler takes it by injection — so the properties
 * pinned are the mechanism's: the bound on calls in flight, the single retry,
 * the file contract, the cache, the loud failures, and the transcript + ledger
 * row that make the phase visible to the dashboard, stats and evals.
 */

const RUN_ID = "run-units";
const MODEL = "anthropic/claude-haiku-4-5-20251001";
const SYSTEM = "You review one unit.<!-- maintainer note: stripped before sending -->";

let root: string;
let prDir: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "survey-units-"));
  // `resolveHostRepoDir`'s layout: <sandboxDir>/<taskId>/<repo>.
  prDir = join(root, "sandboxes", "task-1", "widgets", ".lastlight", "pr-review");
  mkdirSync(prDir, { recursive: true });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

const sha = (s: string) => createHash("sha256").update(s).digest("hex");

function unit(id: string, over: Record<string, unknown> = {}) {
  const request = `UNIT SURVEY ${id}\nsource…`;
  return {
    id,
    kind: "symbol",
    file: "src/a.ts",
    symbol: `fn_${id}`,
    lines: [10, 20],
    language: "typescript",
    families: ["contract"],
    obligationIds: [`contract-o-${id}`],
    request,
    requestSha256: sha(request),
    truncated: false,
    ...over,
  };
}

function writeUnits(units: unknown[], extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(prDir, "units.json"),
    JSON.stringify({ version: 1, promptVersion: "units-v1", coverage: "full", degraded: [], units, ...extra }),
  );
}

/** A reply that passes the handler's one check. */
const answer = (id: string) => `{"unitId":"${id}","answers":[],"defects":[]}`;

const usage = (costUsd: number) => ({ input: 100, output: 20, cacheRead: 50, cacheWrite: 10, costUsd });

/** A scriptable fake call: records every request and hands back per-unit replies. */
class FakeCall {
  readonly requests: Parameters<UnitModelCall>[0][] = [];
  inFlight = 0;
  peak = 0;
  constructor(
    private readonly reply: (id: string, attempt: number) => UnitCallResult | Error | "hang" = (id) => ({
      text: answer(id),
      usage: usage(0.01),
    }),
    private readonly delayMs = 0,
  ) {}
  readonly fn: UnitModelCall = async (args) => {
    this.requests.push(args);
    this.inFlight += 1;
    this.peak = Math.max(this.peak, this.inFlight);
    try {
      if (this.delayMs) await new Promise((r) => setTimeout(r, this.delayMs));
      const id = /UNIT SURVEY (\S+)/.exec(args.request)?.[1] ?? "?";
      const attempt = this.requests.filter((r) => r.request === args.request).length;
      const out = this.reply(id, attempt);
      if (out === "hang") {
        // A call that never answers: it ends only when the phase aborts it,
        // the way pi-ai hands back `stopReason: "aborted"`.
        await new Promise<void>((resolve) => {
          if (args.signal?.aborted) return resolve();
          args.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return { text: "", usage: usage(0.001), error: "Request was aborted", stopReason: "aborted" };
      }
      if (out instanceof Error) throw out;
      return out;
    } finally {
      this.inFlight -= 1;
    }
  };
}

function surveyPhase(over: Record<string, unknown> = {}): PhaseDefinition {
  return AgentWorkflowSchema.parse({
    name: "pr-review",
    phases: [{ name: "survey-units", type: "survey-units", prompt: "prompts/survey-unit.md", model: MODEL, ...over }],
  }).phases[0];
}

const assets: AssetLoader = {
  loadPromptTemplate: () => SYSTEM,
  resolveSkillPaths: (names) => names.map((n) => `/skills/${n}`),
};

const resolver: PhaseResolver = {
  modelFor: () => undefined,
  variantFor: () => undefined,
  renderPrompt: (p) => p,
  gateEnabled: () => false,
};

async function runSurvey(
  call: FakeCall,
  opts: {
    backend?: SandboxBackend;
    concurrency?: string;
    store?: InMemoryStateStore;
    phase?: PhaseDefinition;
    ctx?: Record<string, unknown>;
    resolver?: PhaseResolver;
    cancelPollMs?: number;
  } = {},
) {
  const store = opts.store ?? new InMemoryStateStore(RUN_ID);
  const reporter = new RecordingReporter();
  const config = {
    sandbox: opts.backend ?? "none",
    stateDir: join(root, "state"),
    sandboxDir: join(root, "sandboxes"),
    sessionsDir: join(root, "sessions"),
  } as unknown as ExecutorConfig;
  const handler = makeSurveyUnitsHandler(
    {
      workflowName: "pr-review",
      ctx: {
        owner: "acme",
        repo: "widgets",
        surveyUnitConcurrency: opts.concurrency ?? "16",
        timeouts: { agentSeconds: 600, commandSeconds: 300, untilBashSeconds: 30 },
        ...opts.ctx,
      } as unknown as TemplateContext,
      config,
      taskId: "task-1",
      triggerId: "acme/widgets#7",
      githubAccess: { owner: "acme", repo: "widgets", profile: "review-write" } as GitSandboxAccess,
      backend: opts.backend ?? "none",
      assets,
      resolver: opts.resolver ?? resolver,
      store,
      workflowId: RUN_ID,
      ledger: { liveness: noopLiveness, observability: noopObservability },
      callUnit: call.fn,
      ...(opts.cancelPollMs ? { cancelPollMs: opts.cancelPollMs } : {}),
    },
    reporter,
  );
  const phase = opts.phase ?? surveyPhase();
  const node = { name: phase.name, depends_on: [], status: "running" } as unknown as DagNode;
  const outcome = await handler.execute(phase, node, {});
  const row = store.executionRows("survey-units").at(-1);
  return { outcome, reporter, store, row };
}

function response(id: string): UnitResponseRecord {
  return JSON.parse(readFileSync(join(prDir, "units", "responses", `${id}.json`), "utf8")) as UnitResponseRecord;
}

/** The session jsonl's raw lines — for the `result` line and the stamps. */
function rawLines(sessionId: string): Record<string, unknown>[] {
  const projects = join(root, "sessions", "projects");
  for (const slug of readdirSync(projects)) {
    const file = join(projects, slug, `${sessionId}.jsonl`);
    if (existsSync(file)) {
      return readFileSync(file, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>);
    }
  }
  throw new Error(`no session file for ${sessionId}`);
}

/** The transcript as the dashboard reads it: survey_unit calls and their results. */
async function transcript(sessionId: string) {
  const msgs = (await new SessionReader(join(root, "sessions")).read(sessionId)).map((m) => m.msg);
  const calls = msgs.flatMap((m) =>
    ((m.tool_calls as { id: string; function: { name: string; arguments: Record<string, unknown> } }[] | undefined) ?? []),
  );
  const results = msgs.filter((m) => m.role === "tool") as { tool_call_id: string; content: string }[];
  return { msgs, calls, results };
}

describe("survey-units — the file contract", () => {
  it("writes one response per unit, exactly per the contract", async () => {
    writeUnits([unit("u-001"), unit("u-002")]);
    const call = new FakeCall();
    const { outcome } = await runSurvey(call);

    expect(outcome.status).toBe("succeeded");
    expect(call.requests).toHaveLength(2);
    const r = response("u-001");
    expect(Object.keys(r).sort()).toEqual(
      ["attempts", "cached", "durationMs", "error", "model", "ok", "raw", "requestSha256", "systemPromptSha256", "unitId", "usage"].sort(),
    );
    expect(r).toMatchObject({
      unitId: "u-001",
      model: MODEL,
      ok: true,
      cached: false,
      attempts: 1,
      raw: answer("u-001"),
      error: null,
      requestSha256: unit("u-001").requestSha256,
      usage: usage(0.01),
    });
    expect(Object.keys(r.usage).sort()).toEqual(["cacheRead", "cacheWrite", "costUsd", "input", "output"]);
    expect(typeof r.durationMs).toBe("number");
  });

  it("sends the rendered system prompt and the unit's request VERBATIM", async () => {
    writeUnits([unit("u-001")]);
    const call = new FakeCall();
    await runSurvey(call);
    // Maintainer notes are stripped by the template renderer, as for every prompt.
    expect(call.requests[0].systemPrompt).toBe("You review one unit.");
    expect(call.requests[0].request).toBe(unit("u-001").request);
    expect(response("u-001").systemPromptSha256).toBe(sha("You review one unit."));
  });

  it("gives every call of the phase the same provider cache key", async () => {
    writeUnits([unit("u-001"), unit("u-002"), unit("u-003")]);
    const call = new FakeCall();
    await runSurvey(call);
    const keys = new Set(call.requests.map((r) => r.cacheKey));
    expect(keys.size).toBe(1);
    expect([...keys][0].length).toBeLessThanOrEqual(64);
  });

  it("clears a previous head's responses before writing this one's", async () => {
    // The per-PR workspace is REUSED: a unit id the new document no longer
    // lists must not be ingested as if it had been asked.
    mkdirSync(join(prDir, "units", "responses"), { recursive: true });
    writeFileSync(join(prDir, "units", "responses", "u-099.json"), "{}");
    writeUnits([unit("u-001")]);
    await runSurvey(new FakeCall());
    expect(readdirSync(join(prDir, "units", "responses"))).toEqual(["u-001.json"]);
  });
});

describe("survey-units — concurrency", () => {
  it("never has more calls in flight than surveyUnitConcurrency, and does run them concurrently", async () => {
    writeUnits(["u-001", "u-002", "u-003", "u-004", "u-005", "u-006"].map((id) => unit(id)));
    const call = new FakeCall(undefined, 20);
    await runSurvey(call, { concurrency: "2" });
    expect(call.requests).toHaveLength(6);
    expect(call.peak).toBe(2);
  });

  it("takes the shipped default when the context carries no usable value", async () => {
    writeUnits(["u-001", "u-002", "u-003", "u-004"].map((id) => unit(id)));
    const call = new FakeCall(undefined, 20);
    await runSurvey(call, { concurrency: "garbage" });
    // Default 16 > the 3 units left after the cache warm-up: all three at once.
    expect(call.peak).toBe(3);
  });
});

describe("survey-units — the single retry", () => {
  it("retries ONCE on a reply without the unit's JSON object, then records ok:false", async () => {
    writeUnits([unit("u-001"), unit("u-002")]);
    const call = new FakeCall((id) =>
      id === "u-001" ? { text: "Sure! Here is my review in prose.", usage: usage(0.02) } : { text: answer(id), usage: usage(0.01) },
    );
    const { outcome } = await runSurvey(call);

    expect(call.requests.filter((r) => r.request.includes("u-001"))).toHaveLength(2);
    const r = response("u-001");
    expect(r).toMatchObject({ ok: false, attempts: 2, cached: false, raw: "Sure! Here is my review in prose." });
    expect(r.error).toContain("u-001");
    // Both attempts are paid for, so both are on the unit's usage.
    expect(r.usage.costUsd).toBeCloseTo(0.04);
    // One unit failing is a thin survey, not a broken one.
    expect(outcome.status).toBe("succeeded");
  });

  it("a reply naming ANOTHER unit id does not count", async () => {
    writeUnits([unit("u-001")]);
    const call = new FakeCall(() => ({ text: answer("u-002"), usage: usage(0.01) }));
    await runSurvey(call);
    expect(response("u-001")).toMatchObject({ ok: false, attempts: 2 });
  });

  it("a second attempt that answers is ok, with attempts: 2", async () => {
    writeUnits([unit("u-001")]);
    const call = new FakeCall((id, attempt) =>
      attempt === 1 ? { text: "{not json", usage: usage(0.01) } : { text: answer(id), usage: usage(0.01) },
    );
    await runSurvey(call);
    expect(response("u-001")).toMatchObject({ ok: true, attempts: 2, error: null, raw: answer("u-001") });
  });

  it("a call that THROWS is retried, and its message is the recorded error", async () => {
    writeUnits([unit("u-001"), unit("u-002")]);
    const call = new FakeCall((id) => (id === "u-001" ? new Error("429 rate limited") : { text: answer(id), usage: usage(0.01) }));
    await runSurvey(call);
    expect(response("u-001")).toMatchObject({ ok: false, attempts: 2, raw: "", error: "429 rate limited" });
  });

  it("a provider error is not an answer even with text alongside it", async () => {
    writeUnits([unit("u-001")]);
    const call = new FakeCall((id) => ({ text: answer(id), usage: usage(0), error: "overloaded" }));
    await runSurvey(call);
    expect(response("u-001")).toMatchObject({ ok: false, attempts: 2, error: "overloaded" });
  });

  it("every unit failing DEGRADES the phase — green, with a loud summary naming the first error", async () => {
    // A red phase here posts nothing and re-arms the review sweep, while
    // `units-ingest` records every unanswered obligation either way.
    writeUnits([unit("u-001"), unit("u-002")]);
    const { outcome, row } = await runSurvey(new FakeCall(() => new Error("401 invalid api key")));
    expect(outcome.status).toBe("succeeded");
    expect(outcome.results[0]?.output).toMatch(/^SURVEY DEGRADED — EVERY one of 2 unit/);
    expect(outcome.results[0]?.output).toContain("401 invalid api key");
    // …and the responses are still on disk for `units-ingest` to record.
    expect(response("u-001").ok).toBe(false);
    expect(row?.success).toBe(true);
  });
});

describe("survey-units — the response cache", () => {
  it("a re-review answers an unchanged unit from the cache, with no call and zero usage", async () => {
    writeUnits([unit("u-001"), unit("u-002")]);
    await runSurvey(new FakeCall());

    const second = new FakeCall();
    // A fresh run of the same workflow (resume dedup would otherwise skip it).
    const { outcome, row } = await runSurvey(second, { store: new InMemoryStateStore(RUN_ID) });
    expect(outcome.status).toBe("succeeded");
    expect(second.requests).toHaveLength(0);
    expect(response("u-001")).toMatchObject({
      ok: true,
      cached: true,
      raw: answer("u-001"),
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, costUsd: 0 },
    });
    expect(row?.costUsd).toBe(0);
  });

  it("lives outside the workspace, under the state dir, scoped to the repository", async () => {
    writeUnits([unit("u-001")]);
    await runSurvey(new FakeCall());
    const dir = unitCacheDir(join(root, "state"), "acme", "widgets");
    expect(readdirSync(dir)).toHaveLength(1);
    expect(dir.startsWith(join(root, "sandboxes"))).toBe(false);
  });

  it("never caches a failure — the next run asks again", async () => {
    writeUnits([unit("u-001")]);
    await runSurvey(new FakeCall(() => ({ text: "prose", usage: usage(0) })));
    const again = new FakeCall();
    await runSurvey(again, { store: new InMemoryStateStore(RUN_ID) });
    expect(again.requests).toHaveLength(1);
    expect(response("u-001")).toMatchObject({ ok: true, cached: false });
  });

  it("misses when the request changed, or the system prompt did", async () => {
    writeUnits([unit("u-001")]);
    await runSurvey(new FakeCall());

    writeUnits([unit("u-001", { request: "UNIT SURVEY u-001\nsource changed" })]);
    const changed = new FakeCall();
    await runSurvey(changed, { store: new InMemoryStateStore(RUN_ID) });
    expect(changed.requests).toHaveLength(1);
  });
});

describe("survey-units — degrade, don't fail", () => {
  it("a missing units.json SUCCEEDS loudly, naming the phase that should have written it", async () => {
    const call = new FakeCall();
    const { outcome, row, reporter } = await runSurvey(call);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.results[0]?.output).toMatch(/^SURVEY DEGRADED/);
    expect(outcome.results[0]?.output).toMatch(/units\.json/);
    expect(outcome.results[0]?.output).toMatch(/`units` phase/);
    expect(call.requests).toHaveLength(0);
    // Still on the ledger and still visible: a green row with a transcript
    // whose closing message says what happened.
    expect(row).toMatchObject({ finished: true, success: true });
    expect(row?.sessionId).toBeTruthy();
    const { msgs } = await transcript(row!.sessionId!);
    expect(msgs.some((m) => m.role === "assistant" && String(m.content).includes("SURVEY DEGRADED"))).toBe(true);
    expect(reporter.persisted.map((p) => p.phase)).toEqual(["survey-units"]);
    expect(reporter.steps.map((st) => st.status)).toEqual(["running", "done"]);
  });

  it("a malformed units.json (no `units` array) degrades, and still clears stale responses", async () => {
    mkdirSync(join(prDir, "units", "responses"), { recursive: true });
    writeFileSync(join(prDir, "units", "responses", "u-099.json"), "{}");
    writeFileSync(join(prDir, "units.json"), JSON.stringify({ version: 1 }));
    const { outcome } = await runSurvey(new FakeCall());
    expect(outcome.status).toBe("succeeded");
    expect(outcome.results[0]?.output).toMatch(/no `units` array/);
    expect(readdirSync(join(prDir, "units", "responses"))).toEqual([]);
  });

  it("the kubernetes guard degrades before any call and never touches the workspace", async () => {
    // Refused at config load (policy-blocks-boot.test.ts); this is the belt.
    writeUnits([unit("u-001")]);
    mkdirSync(join(prDir, "units", "responses"), { recursive: true });
    writeFileSync(join(prDir, "units", "responses", "u-001.json"), "{}");
    const call = new FakeCall();
    const { outcome } = await runSurvey(call, { backend: "kubernetes" });
    expect(outcome.status).toBe("succeeded");
    expect(outcome.results[0]?.output).toContain("review.analysis.enabled");
    expect(outcome.results[0]?.output).toContain("kubernetes");
    expect(call.requests).toHaveLength(0);
    expect(readFileSync(join(prDir, "units", "responses", "u-001.json"), "utf8")).toBe("{}");
  });

  it("an EMPTY units list with coverage none is NOT a clean survey — the reasons are in the summary", async () => {
    // The `units` node's shell fallback: nulls, no sharedPrefix, no skipped.
    writeUnits([], {
      coverage: "none",
      promptVersion: null,
      baseSha: null,
      responseSchema: null,
      degraded: [{ extractor: "units", reason: "the units process exited 137 without writing units.json" }],
    });
    const call = new FakeCall();
    const { outcome, row } = await runSurvey(call);
    expect(outcome.status).toBe("succeeded");
    expect(call.requests).toHaveLength(0);
    expect(readdirSync(join(prDir, "units", "responses"))).toEqual([]);
    expect(outcome.results[0]?.output).toMatch(/^SURVEY DEGRADED — No units to survey/);
    expect(outcome.results[0]?.output).toContain("exited 137");
    expect(rawLines(row!.sessionId!).find((l) => l.type === "result")).toMatchObject({ subtype: "success", num_turns: 0 });
  });

  it("an EMPTY units list with full coverage is simply nothing to survey", async () => {
    writeUnits([], { coverage: "full" });
    const call = new FakeCall();
    const { outcome, row } = await runSurvey(call);
    expect(outcome.status).toBe("succeeded");
    expect(call.requests).toHaveLength(0);
    expect(outcome.results[0]?.output).toMatch(/^No units to survey/);
    const { msgs } = await transcript(row!.sessionId!);
    expect(msgs.some((m) => m.role === "assistant" && String(m.content).includes("No units to survey"))).toBe(true);
  });

  it("the schema refuses a survey-units phase with no prompt", () => {
    expect(() =>
      AgentWorkflowSchema.parse({ name: "wf", phases: [{ name: "survey-units", type: "survey-units" }] }),
    ).toThrow(/requires `prompt:`/);
  });
});

describe("survey-units — transcript and ledger", () => {
  it("one survey_unit call/result pair per model call, cache hits included", async () => {
    writeUnits([unit("u-001"), unit("u-002")]);
    await runSurvey(new FakeCall());
    // A re-review with one new unit: two answered from the cache, one called.
    writeUnits([unit("u-001"), unit("u-002"), unit("u-003")]);
    const { row } = await runSurvey(new FakeCall(), { store: new InMemoryStateStore(RUN_ID) });
    const { calls, results } = await transcript(row!.sessionId!);
    expect(calls.every((c) => c.function.name === SURVEY_UNIT_TOOL)).toBe(true);
    expect(calls.map((c) => c.id).sort()).toEqual(["u-001-cache", "u-002-cache", "u-003-a1"]);
    expect(results.map((r) => r.tool_call_id).sort()).toEqual(calls.map((c) => c.id).sort());
    const cacheCall = calls.find((c) => c.id === "u-001-cache")!;
    expect(cacheCall.function.arguments).toMatchObject({ unitId: "u-001", cached: true, model: MODEL });
  });

  it("records a retry as its own pair, the failed attempt marked is_error", async () => {
    writeUnits([unit("u-001")]);
    const { row } = await runSurvey(
      new FakeCall((id, attempt) => (attempt === 1 ? { text: "prose", usage: usage(0.02) } : { text: answer(id), usage: usage(0.01) })),
    );
    const { calls, results } = await transcript(row!.sessionId!);
    expect(calls.map((c) => c.id)).toEqual(["u-001-a1", "u-001-a2"]);
    expect(results.map((r) => r.content)).toEqual(["prose", answer("u-001")]);
    const raw = rawLines(row!.sessionId!);
    const errored = raw
      .filter((l) => l.type === "user")
      .flatMap((l) => ((l.message as { content: unknown }).content as Record<string, unknown>[]) ?? [])
      .filter((b) => typeof b === "object" && b.type === "tool_result");
    expect(errored.map((b) => b.is_error === true)).toEqual([true, false]);
  });

  it("carries unitId/symbol/file/lines/model/request on each call, and that call's usage", async () => {
    writeUnits([unit("u-001")]);
    const { row } = await runSurvey(new FakeCall());
    const { calls } = await transcript(row!.sessionId!);
    expect(calls[0].function.arguments).toEqual({
      unitId: "u-001",
      symbol: "fn_u-001",
      file: "src/a.ts",
      lines: [10, 20],
      model: MODEL,
      request: unit("u-001").request,
    });
    const assistant = rawLines(row!.sessionId!).find(
      (l) => l.type === "assistant" && JSON.stringify(l.message).includes("u-001-a1"),
    );
    expect((assistant?.message as { usage: unknown }).usage).toEqual({
      input_tokens: 100,
      output_tokens: 20,
      cache_read_input_tokens: 50,
      cache_creation_input_tokens: 10,
    });
  });

  it("closes with a summed `result` line, stamped with the phase, and the ledger row agrees", async () => {
    writeUnits([unit("u-001"), unit("u-002"), unit("u-003")]);
    const { row } = await runSurvey(new FakeCall());
    expect(row).toMatchObject({ finished: true, success: true, dedupKey: "pr-review:survey-units" });
    expect(row?.sessionId).toBeTruthy();
    // The dashboard finds a phase's transcript ONLY via executions.session_id,
    // and stats cost only off this row.
    expect(row?.costUsd).toBeCloseTo(0.03);
    expect(row?.inputTokens).toBe(300);
    expect(row?.outputTokens).toBe(60);

    const raw = rawLines(row!.sessionId!);
    const result = raw.find((l) => l.type === "result");
    expect(result).toMatchObject({
      subtype: "success",
      num_turns: 3,
      total_input_tokens: 300,
      total_output_tokens: 60,
      total_cache_read_input_tokens: 150,
      total_cache_creation_input_tokens: 30,
      phase: "survey-units",
    });
    expect(result?.total_cost_usd as number).toBeCloseTo(0.03);
    // The opening prompt is stamped too — the evals' authoritative session→phase map.
    expect(raw[0]).toMatchObject({ type: "user", phase: "survey-units" });
    expect(String((raw[0].message as { content: string }).content)).toContain("You review one unit.");
    expect(String((raw[0].message as { content: string }).content)).toContain("u-003");
    // …and a closing summary the reader can see.
    const { msgs } = await transcript(row!.sessionId!);
    const last = msgs.filter((m) => m.role === "assistant").at(-1);
    expect(String(last?.content)).toMatch(/3 ok, 0 failed, 0 from cache/);
  });

  it("opens and closes the phase window and reports the phase done", async () => {
    writeUnits([unit("u-001")]);
    const { reporter, outcome } = await runSurvey(new FakeCall());
    expect(outcome.results[0]).toMatchObject({ phase: "survey-units", success: true });
    expect(reporter.ends.map((e) => e.phase)).toEqual(["survey-units"]);
    expect(reporter.persisted.map((p) => p.phase)).toEqual(["survey-units"]);
    expect(reporter.steps.map((s) => s.status)).toEqual(["running", "done"]);
  });

  it("a resumed run whose ledger row is done makes no call at all", async () => {
    writeUnits([unit("u-001")]);
    const store = new InMemoryStateStore(RUN_ID);
    await runSurvey(new FakeCall(), { store });
    const again = new FakeCall();
    const { outcome } = await runSurvey(again, { store });
    expect(outcome.status).toBe("succeeded");
    expect(outcome.results[0]?.output).toBe("Already completed");
    expect(again.requests).toHaveLength(0);
  });

  it("moves a document's sharedPrefix into the SYSTEM prompt, and shows it once", async () => {
    const prefix = "SHARED HEAD — questions, evidence record, rules\n";
    const withPrefix = (id: string) => {
      const request = `${prefix}UNIT SURVEY ${id}\nsource…`;
      return unit(id, { request, requestSha256: sha(request) });
    };
    writeUnits([withPrefix("u-001"), withPrefix("u-002")], { sharedPrefix: prefix, sharedPrefixSha256: sha(prefix) });
    const call = new FakeCall();
    const { row } = await runSurvey(call);

    // Anthropic caches at the system-prompt breakpoint, so the shared head
    // rides there on every call and the user message is the unit's own part.
    const system = `You review one unit.\n\n${prefix}`;
    expect(call.requests.every((r) => r.systemPrompt === system)).toBe(true);
    expect(call.requests.map((r) => r.request).sort()).toEqual(["UNIT SURVEY u-001\nsource…", "UNIT SURVEY u-002\nsource…"]);
    // The record's hash is of the system text actually sent; the request hash
    // is still the contract's (the whole request).
    expect(response("u-001").systemPromptSha256).toBe(sha(system));
    expect(response("u-001").requestSha256).toBe(sha(`${prefix}UNIT SURVEY u-001\nsource…`));
    const { calls } = await transcript(row!.sessionId!);
    for (const c of calls) {
      expect(String(c.function.arguments.request)).not.toContain(prefix);
      expect(String(c.function.arguments.request)).toContain("shared request prefix");
    }
    const opening = String((rawLines(row!.sessionId!)[0].message as { content: string }).content);
    expect(opening.split(prefix).length - 1).toBe(1);
  });
});


describe("survey-units — the shared prefix split", () => {
  it("sends every request verbatim when one of them does not open with the prefix", async () => {
    const prefix = "SHARED HEAD\n";
    const ok = `${prefix}UNIT SURVEY u-001\nsource…`;
    writeUnits([unit("u-001", { request: ok, requestSha256: sha(ok) }), unit("u-002")], { sharedPrefix: prefix });
    const call = new FakeCall();
    await runSurvey(call);
    expect(call.requests.every((r) => r.systemPrompt === "You review one unit.")).toBe(true);
    expect(call.requests.map((r) => r.request).sort()).toEqual([ok, unit("u-002").request].sort());
  });

  it("a cached reply is keyed on the system text: a prefix that changes misses", async () => {
    const run = async (prefix: string) => {
      const request = `${prefix}UNIT SURVEY u-001\nsource…`;
      writeUnits([unit("u-001", { request, requestSha256: sha(request) })], { sharedPrefix: prefix });
      const call = new FakeCall();
      await runSurvey(call, { store: new InMemoryStateStore(RUN_ID) });
      return call.requests.length;
    };
    expect(await run("HEAD A\n")).toBe(1);
    expect(await run("HEAD A\n")).toBe(0);
    expect(await run("HEAD B\n")).toBe(1);
  });
});

/**
 * THE reply rule. `CASES` and `USABLE` are a VERBATIM copy of the canonical
 * tables in `packages/code-facts/tests/unit-reply.test.ts`, which pin
 * `findUnitObject` / `isUsableUnitReply` in `src/unit-response.ts`. The handler
 * keeps its own copy of the rule (core may not import code-facts); if a case
 * changes there, change it here — a reply the handler caches and ingest calls
 * `invalid` is a reading that is never re-asked.
 */
const OBJ = '{"unitId":"u-001","answers":[],"defects":[]}';

/** [name, raw, unitId, the expected `unitId` of the object found — or null for none]. */
const CASES: [string, string, string, string | null][] = [
  ["plain", OBJ, "u-001", "u-001"],
  ["plain, surrounding whitespace", `\n  ${OBJ}\n`, "u-001", "u-001"],
  ["fenced", "```json\n" + OBJ + "\n```", "u-001", "u-001"],
  ["fenced, no language tag", "```\n" + OBJ + "\n```", "u-001", "u-001"],
  ["prose around", `Here is my answer:\n${OBJ}\nHope that helps.`, "u-001", "u-001"],
  ["stray unclosed brace in prose before", `The config uses { braces. ${OBJ}`, "u-001", "u-001"],
  ["stray brace and quote in prose before", `Note: {"unfinished ${OBJ}`, "u-001", "u-001"],
  ["balanced non-JSON braces in prose before", `A set {a, b} then ${OBJ}`, "u-001", "u-001"],
  ["brace inside a JSON string", '{"unitId":"u-001","answers":[],"defects":[],"note":"a } and a {"}', "u-001", "u-001"],
  ["nested under a key", `{"result":${OBJ}}`, "u-001", "u-001"],
  ["nested in an array under a key", `{"units":[{"unitId":"u-000"},${OBJ}]}`, "u-001", "u-001"],
  ["two objects, the second matches", `{"unitId":"u-999","answers":[],"defects":[]}\n${OBJ}`, "u-001", "u-001"],
  ["a quoted snippet before the fenced answer", 'Example: {"unitId":"u-999"}\n```json\n' + OBJ + "\n```", "u-001", "u-001"],
  ["top-level match wins over a nested one", `{"unitId":"u-001","answers":[],"defects":[],"echo":{"unitId":"u-001","answers":[1],"defects":[]}}`, "u-001", "u-001"],
  ["truncated / unclosed", '{"unitId":"u-001","answers":[{"obligation":"O-1"', "u-001", null],
  ["only another unit's object", '{"unitId":"u-002","answers":[],"defects":[]}', "u-001", null],
  ["nested two levels deep is not found", `{"a":{"b":${OBJ}}}`, "u-001", null],
  ["unitId is a number, not the string", '{"unitId":1,"answers":[],"defects":[]}', "1", null],
  ["none", "I could not produce an answer.", "u-001", null],
  ["empty", "", "u-001", null],
  ["line copied with the tag's zero padding", '{"unitId":"u-001","answers":[],"defects":[{"family":"state","claim":"c","line": 0142,"evidence":{}}]}', "u-001", "u-001"],
];

/** [name, value, unitId, usable]. */
const USABLE: [string, unknown, string, boolean][] = [
  ["answers and defects arrays", { unitId: "u-001", answers: [], defects: [] }, "u-001", true],
  ["entries are not inspected", { unitId: "u-001", answers: [{ nonsense: true }], defects: [42] }, "u-001", true],
  ["another unit's id", { unitId: "u-002", answers: [], defects: [] }, "u-001", false],
  ["no defects", { unitId: "u-001", answers: [] }, "u-001", false],
  ["no answers", { unitId: "u-001", defects: [] }, "u-001", false],
  ["answers is an object", { unitId: "u-001", answers: {}, defects: [] }, "u-001", false],
  ["null", null, "u-001", false],
  ["an array", [{ unitId: "u-001", answers: [], defects: [] }], "u-001", false],
];

describe("findUnitObject — the canonical case table (verbatim from code-facts)", () => {
  it.each(CASES)("%s", (_name, raw, unitId, expected) => {
    const found = findUnitObject(raw, unitId);
    if (expected === null) expect(found).toBeNull();
    else expect(found?.unitId).toBe(expected);
  });

  it("returns the top-level object when a nested copy also matches", () => {
    const raw = `{"unitId":"u-001","answers":[],"defects":[],"echo":{"unitId":"u-001","answers":[1],"defects":[]}}`;
    expect(findUnitObject(raw, "u-001")?.answers).toEqual([]);
  });
});

describe("isUsableUnitReply — the structural rule (verbatim from code-facts)", () => {
  it.each(USABLE)("%s", (_name, value, unitId, usable) => {
    expect(isUsableUnitReply(value, unitId)).toBe(usable);
  });
});

describe("usableUnitReply — the handler's one decision, over the briefed cases", () => {
  const cases: [string, string, boolean][] = [
    ["plain object", OBJ, true],
    ["fenced ```json", "```json\n" + OBJ + "\n```", true],
    ["prose before/after", `Sure:\n${OBJ}\nDone.`, true],
    ["stray { in leading prose, then the real object", `I checked {the guard, then: ${OBJ}`, true],
    ["nested under a key", `{"result":${OBJ}}`, true],
    ["two top-level objects, the second matches", `{"unitId":"u-002","answers":[],"defects":[]} ${OBJ}`, true],
    ["unclosed / truncated", '{"unitId":"u-001","answers":[', false],
    ["no object", "Looks fine.", false],
    ["matching unitId but `answers` not an array", '{"unitId":"u-001","answers":"none","defects":[]}', false],
  ];
  it.each(cases)("%s", (_name, raw, usable) => {
    expect(usableUnitReply(raw, "u-001")).toBe(usable);
  });
});

describe("survey-units — the reply rule drives retry and cache", () => {
  it("a reply ingest would reject (answers not an array) is retried and never cached", async () => {
    writeUnits([unit("u-001")]);
    const bad = JSON.stringify({ unitId: "u-001", answers: "none", defects: [] });
    const call = new FakeCall(() => ({ text: bad, usage: usage(0.01) }));
    await runSurvey(call);
    expect(call.requests).toHaveLength(2);
    expect(response("u-001")).toMatchObject({ ok: false, attempts: 2, raw: bad });
    expect(existsSync(unitCacheDir(join(root, "state"), "acme", "widgets"))).toBe(false);
  });

  it("a cache entry that fails the rule (written under a looser one) is ignored, not replayed", async () => {
    writeUnits([unit("u-001")]);
    await runSurvey(new FakeCall());
    const dir = unitCacheDir(join(root, "state"), "acme", "widgets");
    const [file] = readdirSync(dir);
    const rec = JSON.parse(readFileSync(join(dir, file), "utf8")) as UnitResponseRecord;
    writeFileSync(join(dir, file), JSON.stringify({ ...rec, raw: `{"unitId":"u-001"}` }));
    const again = new FakeCall();
    await runSurvey(again, { store: new InMemoryStateStore(RUN_ID) });
    expect(again.requests).toHaveLength(1);
    expect(response("u-001")).toMatchObject({ ok: true, cached: false });
  });

  it("evicts a cached reply the LAST run's ingest marked invalid or partial, and asks again", async () => {
    writeUnits([unit("u-001"), unit("u-002"), unit("u-003")]);
    await runSurvey(new FakeCall());
    // What `units-ingest` wrote after that run: u-001 partial, u-002 invalid,
    // u-003 ok. Its report names units, not requests — the handler reads the
    // request hash off the response record beside it.
    writeFileSync(
      join(prDir, "units", "ingest.json"),
      JSON.stringify({
        version: 1,
        units: [
          { unitId: "u-001", status: "partial" },
          { unitId: "u-002", status: "invalid" },
          { unitId: "u-003", status: "ok" },
        ],
      }),
    );
    const again = new FakeCall();
    await runSurvey(again, { store: new InMemoryStateStore(RUN_ID) });
    expect(again.requests.map((r) => /UNIT SURVEY (\S+)/.exec(r.request)?.[1]).sort()).toEqual(["u-001", "u-002"]);
    expect(response("u-003")).toMatchObject({ cached: true });
    expect(response("u-001")).toMatchObject({ cached: false, ok: true });
  });

  it("an unreadable previous ingest report evicts nothing and costs nothing", async () => {
    writeUnits([unit("u-001")]);
    await runSurvey(new FakeCall());
    writeFileSync(join(prDir, "units", "ingest.json"), "{not json");
    const again = new FakeCall();
    const { outcome } = await runSurvey(again, { store: new InMemoryStateStore(RUN_ID) });
    expect(outcome.status).toBe("succeeded");
    expect(again.requests).toHaveLength(0);
  });
});

describe("survey-units — the phase deadline and cancellation", () => {
  it("a unit not finished by the deadline is recorded `phase deadline`, in the file and the transcript", async () => {
    writeUnits([unit("u-001"), unit("u-002"), unit("u-003")]);
    // Concurrency 1: u-001 answers, u-002 hangs until the deadline aborts it,
    // u-003 never starts.
    const call = new FakeCall((id) => (id === "u-002" ? "hang" : { text: answer(id), usage: usage(0.01) }));
    const { outcome, row } = await runSurvey(call, { concurrency: "1", phase: surveyPhase({ timeout_seconds: 1 }) });

    expect(outcome.status).toBe("succeeded");
    expect(response("u-001")).toMatchObject({ ok: true });
    expect(response("u-002")).toMatchObject({ ok: false, attempts: 1, error: "phase deadline" });
    expect(response("u-003")).toMatchObject({ ok: false, attempts: 0, error: "phase deadline" });
    // Aborted calls are never retried, and u-003 was never called.
    expect(call.requests.map((r) => /UNIT SURVEY (\S+)/.exec(r.request)?.[1])).toEqual(["u-001", "u-002"]);
    expect(call.requests.every((r) => r.signal instanceof AbortSignal)).toBe(true);
    expect(outcome.results[0]?.output).toMatch(/SURVEY STOPPED EARLY \(phase deadline\)/);

    const { calls, results } = await transcript(row!.sessionId!);
    expect(calls.map((c) => c.id)).toEqual(["u-001-a1", "u-002-a1", "u-003-stopped"]);
    expect(results.find((r) => r.tool_call_id === "u-003-stopped")?.content).toBe("phase deadline");
  });

  it("a run cancelled mid-phase aborts the calls in flight and records the rest", async () => {
    writeUnits([unit("u-001"), unit("u-002")]);
    const store = new InMemoryStateStore(RUN_ID);
    const call = new FakeCall((id) => {
      if (id === "u-001") void store.runs.finishRun(RUN_ID, "cancelled");
      return "hang";
    });
    const { outcome } = await runSurvey(call, { store, concurrency: "1", cancelPollMs: 20 });
    expect(outcome.status).toBe("succeeded");
    expect(response("u-001")).toMatchObject({ ok: false, error: "run cancelled" });
    expect(response("u-002")).toMatchObject({ ok: false, attempts: 0, error: "run cancelled" });
    expect(call.requests).toHaveLength(1);
  });
});

describe("survey-units — no stray work after the result", () => {
  it("a response file that cannot be written fails THAT unit; the pool drains before the transcript closes", async () => {
    writeUnits([unit("u-001"), unit("u-002"), unit("u-003")]);
    // Make u-001's response path a non-empty DIRECTORY, so the atomic rename
    // onto it throws — the shape of a disk that fills mid-phase.
    const call = new FakeCall(
      (id) => {
        if (id === "u-001") mkdirSync(join(prDir, "units", "responses", "u-001.json", "blocker"), { recursive: true });
        return { text: answer(id), usage: usage(0.01) };
      },
      15,
    );
    const { outcome, row } = await runSurvey(call, { concurrency: "3" });
    expect(outcome.status).toBe("succeeded");
    expect(response("u-002").ok).toBe(true);
    expect(response("u-003").ok).toBe(true);
    expect(outcome.results[0]?.output).toMatch(/u-001 \(could not write the response file/);
    const raw = rawLines(row!.sessionId!);
    // The `result` line is the LAST line: nothing was appended after it.
    expect(raw.at(-1)?.type).toBe("result");
    expect(raw.filter((l) => l.type === "result")).toHaveLength(1);
  });
});

describe("survey-units — the call: variant, length, cache identity", () => {
  it("passes the phase's rendered `variant:` as the thinking level", async () => {
    writeUnits([unit("u-001")]);
    const call = new FakeCall();
    await runSurvey(call, {
      phase: surveyPhase({ variant: "{{variants.review-survey}}" }),
      ctx: { variants: { "review-survey": "high" } },
    });
    expect(call.requests[0].variant).toBe("high");
  });

  it("falls back to the resolver's variant when the template renders empty", async () => {
    writeUnits([unit("u-001")]);
    const call = new FakeCall();
    await runSurvey(call, {
      phase: surveyPhase({ variant: "{{variants.review-survey}}" }),
      resolver: { ...resolver, variantFor: (t) => (t === "survey-units" ? "minimal" : undefined) },
    });
    expect(call.requests[0].variant).toBe("minimal");
  });

  it("a different thinking level misses the cache", async () => {
    writeUnits([unit("u-001")]);
    const phase = surveyPhase({ variant: "{{variants.review-survey}}" });
    await runSurvey(new FakeCall(), { phase, ctx: { variants: { "review-survey": "low" } } });
    const same = new FakeCall();
    await runSurvey(same, { phase, ctx: { variants: { "review-survey": "low" } }, store: new InMemoryStateStore(RUN_ID) });
    expect(same.requests).toHaveLength(0);
    const other = new FakeCall();
    await runSurvey(other, { phase, ctx: { variants: { "review-survey": "high" } }, store: new InMemoryStateStore(RUN_ID) });
    expect(other.requests).toHaveLength(1);
  });

  it("the same model string pointed at another endpoint misses the cache", async () => {
    writeUnits([unit("u-001")]);
    await runSurvey(new FakeCall());
    try {
      installProviderOverrides({ anthropic: { baseUrl: "https://llm-gateway.example.com" } });
      const moved = new FakeCall();
      await runSurvey(moved, { store: new InMemoryStateStore(RUN_ID) });
      expect(moved.requests).toHaveLength(1);
    } finally {
      installProviderOverrides({});
    }
  });

  it("a reply cut at the output cap is NOT retried — the identical request would stop there again", async () => {
    writeUnits([unit("u-001")]);
    const call = new FakeCall(() => ({ text: `{"unitId":"u-001","answers":[{"claim":"long`, usage: usage(0.05), stopReason: "length" }));
    await runSurvey(call);
    expect(call.requests).toHaveLength(1);
    const r = response("u-001");
    expect(r).toMatchObject({ ok: false, attempts: 1 });
    expect(r.error).toContain("stopReason: length");
  });
});

describe("runUnitSurvey — prompt-cache economics", () => {
  it("runs the first unit ALONE, then fans the rest out, so they read a warm cache", async () => {
    const units = ["u-001", "u-002", "u-003", "u-004"].map((id) => unit(id));
    const events: string[] = [];
    const fake = new FakeCall(undefined, 20);
    const call: typeof fake.fn = async (args) => {
      const id = /u-\d+/.exec(args.request)?.[0] ?? "?";
      events.push(`start ${id}`);
      const r = await fake.fn(args);
      events.push(`end ${id}`);
      return r;
    };
    await runUnitSurvey({
      doc: { units },
      systemPrompt: "SYSTEM",
      model: MODEL,
      concurrency: 4,
      deadlineAt: Date.now() + 60_000,
      signal: new AbortController().signal,
      responsesDir: join(root, "warm-responses"),
      call,
    });
    // The warm-up unit finishes before any other starts…
    expect(events.slice(0, 2)).toEqual(["start u-001", "end u-001"]);
    // …and the rest still run concurrently.
    expect(events.slice(2, 5).every((e) => e.startsWith("start"))).toBe(true);
  });

  it("strips Anthropic cache_control from the per-unit messages and keeps the system breakpoint", () => {
    const payload = {
      system: [{ type: "text", text: "SYSTEM", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: [{ type: "text", text: "unit request", cache_control: { type: "ephemeral" } }] }],
    };
    const out = systemOnlyCacheBreakpoint(payload) as typeof payload;
    expect(out.system[0].cache_control).toEqual({ type: "ephemeral" });
    expect(out.messages[0].content[0]).not.toHaveProperty("cache_control");
  });
});

describe("runUnitSurvey — the runner the handler wraps, callable on its own", () => {
  it("with no cache dir it neither reads nor writes a cache: a second run pays again", async () => {
    const units = [unit("u-001"), unit("u-002")];
    const responsesDir = join(root, "replay-responses");
    const fake = new FakeCall();
    const run = () =>
      runUnitSurvey({
        doc: { units },
        systemPrompt: "SYSTEM",
        model: MODEL,
        concurrency: 2,
        deadlineAt: Date.now() + 60_000,
        signal: new AbortController().signal,
        responsesDir,
        call: fake.fn,
      });
    const first = await run();
    const second = await run();
    expect(fake.requests).toHaveLength(4);
    expect(second.outcomes.map((o) => o.record.cached)).toEqual([false, false]);
    expect(first.calls).toBe(2);
    expect(first.usage.costUsd).toBeCloseTo(0.02);
    expect(first.outcomes.map((o) => o.record.unitId)).toEqual(["u-001", "u-002"]);
    expect(readdirSync(responsesDir).sort()).toEqual(["u-001.json", "u-002.json"]);
    expect(existsSync(join(root, "unit-survey-cache"))).toBe(false);
  });
});

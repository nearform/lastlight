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
  holdsUnitObject,
  makeSurveyUnitsHandler,
  unitCacheDir,
  type UnitCallResult,
  type UnitModelCall,
  type UnitResponseRecord,
} from "#src/workflows/handlers/survey-units.js";
import { SessionReader } from "#src/admin/sessions.js";
import type { SandboxBackend } from "#src/config/config.js";

/**
 * The `survey-units` phase (docs/plans/unit-survey.md): one model call per
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
  readonly requests: { request: string; systemPrompt: string; model: string; cacheKey: string }[] = [];
  inFlight = 0;
  peak = 0;
  constructor(
    private readonly reply: (id: string, attempt: number) => UnitCallResult | Error = (id) => ({
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
  opts: { backend?: SandboxBackend; concurrency?: string; store?: InMemoryStateStore; phase?: PhaseDefinition } = {},
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
      } as unknown as TemplateContext,
      config,
      taskId: "task-1",
      triggerId: "acme/widgets#7",
      githubAccess: { owner: "acme", repo: "widgets", profile: "review-write" } as GitSandboxAccess,
      backend: opts.backend ?? "none",
      assets,
      resolver,
      store,
      workflowId: RUN_ID,
      ledger: { liveness: noopLiveness, observability: noopObservability },
      callUnit: call.fn,
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
    writeUnits(["u-001", "u-002", "u-003"].map((id) => unit(id)));
    const call = new FakeCall(undefined, 20);
    await runSurvey(call, { concurrency: "garbage" });
    // Default 16 > 3 units: all three at once.
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

  it("fails the PHASE only when every unit failed — a bad key, an unknown model", async () => {
    writeUnits([unit("u-001"), unit("u-002")]);
    const { outcome, row } = await runSurvey(new FakeCall(() => new Error("401 invalid api key")));
    expect(outcome.status).toBe("failed");
    expect(outcome.results[0]?.error).toContain("401 invalid api key");
    // …and the responses are still on disk for `units-ingest` to record.
    expect(response("u-001").ok).toBe(false);
    expect(row?.success).toBe(false);
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

describe("survey-units — loud failures", () => {
  it("a missing units.json FAILS the phase, naming the phase that should have written it", async () => {
    const call = new FakeCall();
    const { outcome, row, store } = await runSurvey(call);
    expect(outcome.status).toBe("failed");
    expect(outcome.results[0]?.error).toMatch(/units\.json/);
    expect(outcome.results[0]?.error).toMatch(/`units` phase/);
    expect(call.requests).toHaveLength(0);
    // Still on the ledger and still visible: a failed row with a transcript.
    expect(row).toMatchObject({ finished: true, success: false });
    expect(row?.sessionId).toBeTruthy();
    const errorLine = rawLines(row!.sessionId!).find((l) => l.type === "assistant" && l.isApiErrorMessage);
    expect(String(errorLine?.error)).toMatch(/units\.json/);
    // The dashboard pipeline paints the node red.
    expect(store.phaseHistory(RUN_ID).at(-1)).toMatchObject({ phase: "survey-units", success: false });
  });

  it("a malformed units.json (no `units` array) fails the phase", async () => {
    writeFileSync(join(prDir, "units.json"), JSON.stringify({ version: 1 }));
    const { outcome } = await runSurvey(new FakeCall());
    expect(outcome.status).toBe("failed");
    expect(outcome.results[0]?.error).toMatch(/no `units` array/);
  });

  it("the kubernetes backend fails loud before any call, naming the setting", async () => {
    writeUnits([unit("u-001")]);
    const call = new FakeCall();
    const { outcome } = await runSurvey(call, { backend: "kubernetes" });
    expect(outcome.status).toBe("failed");
    expect(outcome.results[0]?.error).toContain("surveyEngine: units");
    expect(outcome.results[0]?.error).toContain("kubernetes");
    expect(call.requests).toHaveLength(0);
  });

  it("an EMPTY units list succeeds, spends nothing, and says so", async () => {
    writeUnits([], { coverage: "none" });
    const call = new FakeCall();
    const { outcome, row } = await runSurvey(call);
    expect(outcome.status).toBe("succeeded");
    expect(call.requests).toHaveLength(0);
    expect(readdirSync(join(prDir, "units", "responses"))).toEqual([]);
    const { msgs } = await transcript(row!.sessionId!);
    expect(msgs.some((m) => m.role === "assistant" && String(m.content).includes("No units to survey"))).toBe(true);
    expect(rawLines(row!.sessionId!).find((l) => l.type === "result")).toMatchObject({ subtype: "success", num_turns: 0 });
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

  it("shows a document's sharedPrefix once, but still sends it on every call", async () => {
    const prefix = "SHARED HEAD — questions, evidence record, rules\n";
    const withPrefix = (id: string) => {
      const request = `${prefix}UNIT SURVEY ${id}\nsource…`;
      return unit(id, { request, requestSha256: sha(request) });
    };
    writeUnits([withPrefix("u-001"), withPrefix("u-002")], { sharedPrefix: prefix, sharedPrefixSha256: sha(prefix) });
    const call = new FakeCall();
    const { row } = await runSurvey(call);

    expect(call.requests.every((r) => r.request.startsWith(prefix))).toBe(true);
    const { calls } = await transcript(row!.sessionId!);
    for (const c of calls) {
      expect(String(c.function.arguments.request)).not.toContain(prefix);
      expect(String(c.function.arguments.request)).toContain("shared request prefix");
    }
    const opening = String((rawLines(row!.sessionId!)[0].message as { content: string }).content);
    expect(opening.split(prefix).length - 1).toBe(1);
  });
});

describe("holdsUnitObject — the handler's only validation", () => {
  it("finds the unit's object bare, fenced, or after a preamble", () => {
    expect(holdsUnitObject(answer("u-001"), "u-001")).toBe(true);
    expect(holdsUnitObject("```json\n" + answer("u-001") + "\n```", "u-001")).toBe(true);
    expect(holdsUnitObject("Here you go: " + answer("u-001"), "u-001")).toBe(true);
  });

  it("is not fooled by braces inside strings", () => {
    const text = `{"unitId":"u-001","answers":[{"claim":"a } closes { here"}],"defects":[]}`;
    expect(holdsUnitObject(text, "u-001")).toBe(true);
  });

  it("rejects prose, truncated JSON, and another unit's object", () => {
    expect(holdsUnitObject("no json here", "u-001")).toBe(false);
    expect(holdsUnitObject(`{"unitId":"u-001","answers":[`, "u-001")).toBe(false);
    expect(holdsUnitObject(answer("u-002"), "u-001")).toBe(false);
  });
});

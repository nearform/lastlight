import { describe, it, expect } from "vitest";
import { runWorkflowCore, AgentWorkflowSchema } from "lastlight-workflow-engine";
import type {
  AgentWorkflowDefinition,
  ExecutorConfig,
  GitSandboxAccess,
  PhaseResolver,
  PhaseResult,
  PhaseRunContext,
  SchedulerDeps,
  TemplateContext,
} from "lastlight-workflow-engine";
import {
  FakeAgentPort,
  InMemoryStateStore,
  RecordingReporter,
  StubAssetLoader,
  noopLiveness,
  noopObservability,
} from "lastlight-workflow-engine/test-support";

/**
 * Phase-level `skip_if` — the engine capability behind the `fixing` loop's
 * "stop, correctly" outcome (Phase 2 of the dependency-PR resilience plan).
 *
 * The load-bearing property is NOT that the phase is skipped — it's that the
 * RUN still records `succeeded`. `failed` is reserved for malfunction; a
 * diagnosis that correctly determines the PR can't be fixed here did its job.
 * Painting that red would post `messages.on_failure` to the PR, offer a
 * dashboard Retry that cannot succeed, pollute the cost/failure stats, and
 * defeat the already-handled-this-SHA dedup (which ignores failed runs), so the
 * dead end re-diagnoses on every webhook re-fire.
 */

const RUN_ID = "run-1";

function defineWorkflow(skipIf: string | string[]): AgentWorkflowDefinition {
  return AgentWorkflowSchema.parse({
    name: "fix-flow",
    phases: [
      { name: "diagnose", prompt: "prompts/diagnose.md", output_var: "diagnosis" },
      {
        name: "fix",
        prompt: "prompts/fix.md",
        skip_if: skipIf,
        messages: { on_skipped_done: "Nothing to fix here." },
      },
    ],
  });
}

/**
 * A reporter that writes to the run row's `scratch` when a phase ends —
 * `lastlight-core`'s marker harvest, in miniature.
 *
 * The whole point of moving the packaged guards onto `scratch` is that the
 * value is written by the HOST, mid-run, through `mergeScratch` — a channel the
 * engine's own in-memory `runScope.scratch` does not see unless it is refreshed
 * from the row. So the tests below drive that channel rather than pre-seeding
 * `scratch`, which would prove nothing about the path production takes.
 */
class HarvestingReporter extends RecordingReporter {
  constructor(
    private readonly store: InMemoryStateStore,
    private readonly harvest: (output: string) => Record<string, unknown> | null,
  ) {
    super();
  }
  override async onEnd(phase: string, result: PhaseResult): Promise<void> {
    await super.onEnd(phase, result);
    const patch = this.harvest(result.output ?? "");
    if (patch) this.store.runs.mergeScratch(RUN_ID, patch);
  }
}

/** The `fixMarkers` namespace `harvestFixMarkers` writes, for the class only. */
const fixMarkers = (cls: string | null) => ({
  fixMarkers: { diagnosis: cls === null ? null : { class: cls }, fix: null, phases: ["diagnose"] },
});

const resolver: PhaseResolver = {
  modelFor: () => undefined,
  variantFor: () => undefined,
  renderPrompt: (p) => `PROMPT:${p}`,
  gateEnabled: () => false,
};

interface RunOpts {
  /** Simulate the host's `onPhaseEnd` scratch write (the marker harvest). */
  harvest?: (output: string) => Record<string, unknown> | null;
  /** Mark `diagnose` already-succeeded in the ledger — i.e. a RESUME. */
  resumed?: boolean;
  /** What the run row's `scratch` already holds when the run starts. */
  scratch?: Record<string, unknown>;
}

/** Drive one run with a scripted diagnose output. Returns the result + probes. */
async function runWith(
  definition: AgentWorkflowDefinition,
  diagnoseOutput: string,
  opts: RunOpts = {},
) {
  const store = new InMemoryStateStore(RUN_ID);
  if (opts.scratch) store.runs.mergeScratch(RUN_ID, opts.scratch);
  if (opts.resumed) {
    // A completed phase's ledger row is what makes the engine skip it — and a
    // dedup skip returns NO `outputVars`, so `{{phaseOutputs}}` is empty for the
    // rest of the run. That is the resume boundary the packaged guards have to
    // survive.
    store.executions.recordStart({
      id: "exec-diagnose",
      skill: `${definition.name}:diagnose`,
      triggerId: "acme/widgets#7",
      workflowRunId: RUN_ID,
    } as never);
    store.executions.recordFinish("exec-diagnose", { success: true } as never);
  }
  const reporter = opts.harvest
    ? new HarvestingReporter(store, opts.harvest)
    : new RecordingReporter();
  const agent = new FakeAgentPort()
    .script({ success: true, output: diagnoseOutput, turns: 1, durationMs: 0 })
    .script({ success: true, output: "FIXED", turns: 1, durationMs: 0 });

  const runScope: PhaseRunContext = {
    definition,
    ctx: { prNumber: 7 } as unknown as TemplateContext,
    config: { sandbox: "none" } as unknown as ExecutorConfig,
    taskId: "task-1",
    triggerId: "acme/widgets#7",
    githubAccess: { owner: "acme", repo: "widgets", profile: "repo-write" } as GitSandboxAccess,
    // Seeded from the row exactly as `runner.ts` seeds it at run start — which
    // is the ONLY read on the resume path, and is stale for everything the host
    // writes afterwards.
    scratch: { ...(store.runs.getRun(RUN_ID)?.scratch ?? {}) },
    store,
    workflowId: RUN_ID,
    botName: "last-light",
  };

  const deps: SchedulerDeps = {
    reporter,
    resolver,
    ports: { agent, assets: new StubAssetLoader(), liveness: noopLiveness, observability: noopObservability },
    store,
    reporterActive: false,
    capabilities: { qaImageAvailable: () => false, qaImageName: "lastlight-sandbox-qa:latest" },
  };

  const result = await runWorkflowCore(runScope, deps);
  return { result, reporter, agent, store };
}

const DIAGNOSIS = (cls: string) =>
  `DIAGNOSIS_COMPLETE: pr=7 attempt=1 class=${cls} cause=x ci_vs_local=none unreproducible=`;

const NON_FIXABLE = [
  "phaseOutputs.diagnosis.contains('class=flaky')",
  "phaseOutputs.diagnosis.contains('class=infra-dependent')",
  "phaseOutputs.diagnosis.contains('class=upstream-broken')",
];

describe("skip_if — a matched guard skips the phase without failing the run", () => {
  it("records the run `succeeded` and never invokes the agent for the guarded phase", async () => {
    const { result, reporter, agent, store } = await runWith(defineWorkflow(NON_FIXABLE), DIAGNOSIS("flaky"));

    expect(result.success).toBe(true);
    expect(store.runs.getRun(RUN_ID)?.status).toBe("succeeded");
    // The expensive phase never ran — that is the spend the guard exists to save.
    expect(agent.calls).toHaveLength(1);
    expect(result.phases.map((p) => p.phase)).toEqual(["diagnose", "fix"]);
    expect(result.phases.every((p) => p.success)).toBe(true);
    // No failure was reported to the surface (no `messages.on_failure` post).
    expect(reporter.failures).toEqual([]);
  });

  it("reports the step as skipped with the phase's on_skipped_done message", async () => {
    const { reporter } = await runWith(defineWorkflow(NON_FIXABLE), DIAGNOSIS("upstream-broken"));

    const step = reporter.steps.find((s) => s.key === "fix");
    expect(step?.status).toBe("skipped");
    expect(step?.template).toBe("Nothing to fix here.");
  });

  it("names the matching expression in the phase result", async () => {
    const { result } = await runWith(defineWorkflow(NON_FIXABLE), DIAGNOSIS("infra-dependent"));

    const fix = result.phases.find((p) => p.phase === "fix");
    expect(fix?.output).toContain("phaseOutputs.diagnosis.contains('class=infra-dependent')");
  });
});

describe("skip_if — an unmatched guard runs the phase normally", () => {
  it.each(["reproducible", "env-mismatch"])("runs fix for class=%s", async (cls) => {
    const { result, agent, store } = await runWith(defineWorkflow(NON_FIXABLE), DIAGNOSIS(cls));

    expect(agent.calls).toHaveLength(2);
    expect(store.runs.getRun(RUN_ID)?.status).toBe("succeeded");
    expect(result.phases.find((p) => p.phase === "fix")?.output).toBe("FIXED");
  });

  it("fails open when the upstream output is absent", async () => {
    // `{{phaseOutputs}}` is empty across a resume boundary, so the guard must
    // run the phase rather than silently swallow it.
    const { agent } = await runWith(defineWorkflow(NON_FIXABLE), "no marker here");
    expect(agent.calls).toHaveLength(2);
  });

  it("accepts the single-string form", async () => {
    const one = defineWorkflow("phaseOutputs.diagnosis.contains('class=flaky')");
    expect((await runWith(one, DIAGNOSIS("flaky"))).agent.calls).toHaveLength(1);
    expect((await runWith(one, DIAGNOSIS("reproducible"))).agent.calls).toHaveLength(2);
  });
});

/**
 * The form the packaged fix workflows actually declare, and why it is not the
 * `phaseOutputs` one above.
 *
 * `phaseOutputs.diagnosis` is the agent's ENTIRE output and the match is a plain
 * substring, which fails four ways: prose ("this is not `class=flaky`, it is
 * reproducible") skips the fix; a `{{priorAttempts}}` line replayed from an
 * earlier attempt matches; `class=flaky-timeout` matches while
 * `class=probably-flaky` does not; and across a resume boundary `phaseOutputs`
 * is EMPTY, so the guard fails open and spends a full sandbox + 900s gate on a
 * verdict that had just said not to.
 *
 * `scratch.fixMarkers.diagnosis.class` is the PARSED enum, written by the host's
 * marker harvest and persisted on the run row — so it cannot be forged by prose,
 * it is an exact comparison, and it survives resume.
 */
const HARVESTED = [
  "scratch.fixMarkers.diagnosis.class == 'flaky'",
  "scratch.fixMarkers.diagnosis.class == 'infra-dependent'",
  "scratch.fixMarkers.diagnosis.class == 'upstream-broken'",
];

/** Parse the class out of a marker line the way the real harvest does. */
const harvestClass = (output: string) => {
  const m = /DIAGNOSIS_COMPLETE:.*?\bclass=([\w-]+)/.exec(output);
  return fixMarkers(m ? m[1] : null);
};

describe("skip_if — reading the harvested class instead of the phase output", () => {
  it("skips the fix phase on a harvested stopping class", async () => {
    const { result, agent, store } = await runWith(
      defineWorkflow(HARVESTED),
      DIAGNOSIS("flaky"),
      { harvest: harvestClass },
    );
    expect(agent.calls).toHaveLength(1);
    expect(result.success).toBe(true);
    expect(store.runs.getRun(RUN_ID)?.status).toBe("succeeded");
  });

  it("sees a class the HOST wrote mid-run, not the pre-run snapshot", async () => {
    // The engine loads `runScope.scratch` once, before the first phase; the
    // harvest writes through `mergeScratch` afterwards. Without the scheduler
    // re-reading the row, this guard would evaluate the empty pre-run snapshot
    // and the whole move to `scratch` would be a silent no-op on the fresh path.
    const { store } = await runWith(defineWorkflow(HARVESTED), DIAGNOSIS("flaky"), {
      harvest: harvestClass,
    });
    expect((store.runs.getRun(RUN_ID)?.scratch as any).fixMarkers.diagnosis.class).toBe("flaky");
  });

  it("RUNS the fix phase when prose mentions a stopping class the marker did not", async () => {
    // The defect the `phaseOutputs` form shipped with: "this is not class=flaky,
    // it is reproducible" skipped the fix while the harvest recorded
    // `reproducible` and the dispatch charged an attempt.
    const prose = `This is not class=flaky, it is reproducible.\n${DIAGNOSIS("reproducible")}`;
    const { agent } = await runWith(defineWorkflow(HARVESTED), prose, { harvest: harvestClass });
    expect(agent.calls).toHaveLength(2);

    // …and the old form still gets it wrong, which is why the row moved.
    const old = await runWith(defineWorkflow(NON_FIXABLE), prose);
    expect(old.agent.calls).toHaveLength(1);
  });

  it("does not match a class that merely STARTS with a stopping one", async () => {
    // `==` on the parsed enum, not a prefix: `class=flaky-timeout` used to match
    // `class=flaky` while `class=probably-flaky` did not.
    for (const cls of ["flaky-timeout", "probably-flaky"]) {
      const { agent } = await runWith(defineWorkflow(HARVESTED), DIAGNOSIS(cls), {
        harvest: harvestClass,
      });
      expect(agent.calls).toHaveLength(2);
    }
  });

  it("survives a RESUME boundary, where phaseOutputs is empty", async () => {
    // `diagnose` is already `success=1` in the ledger, so it is deduplicated and
    // contributes nothing to `phaseOutputs` — the boundary at which the old
    // guard failed open and ran a full sandbox + 900s gate on a `flaky` verdict.
    // `scratch` is reloaded from the run row, so the harvested class is still
    // there.
    const resumed = await runWith(defineWorkflow(HARVESTED), "unused", {
      resumed: true,
      scratch: fixMarkers("flaky"),
    });
    expect(resumed.agent.calls).toHaveLength(0);
    expect(resumed.result.success).toBe(true);
    expect(resumed.reporter.steps.find((s) => s.key === "fix")?.status).toBe("skipped");

    // The old form, same boundary: the guard fails open and the phase runs.
    const old = await runWith(defineWorkflow(NON_FIXABLE), "unused", {
      resumed: true,
      scratch: fixMarkers("flaky"),
    });
    expect(old.agent.calls).toHaveLength(1);
  });

  it("fails open when the run harvested no class at all", async () => {
    // A crashed or malformed diagnose leaves `diagnosis: null`. An unrecognised
    // token must not be coerced to `flaky` either — both run the phase.
    const { agent } = await runWith(defineWorkflow(HARVESTED), "no marker here", {
      harvest: harvestClass,
    });
    expect(agent.calls).toHaveLength(2);
  });
});

describe("skip_if — schema", () => {
  it("rejects an empty list and an empty expression", () => {
    const build = (skip_if: unknown) =>
      AgentWorkflowSchema.safeParse({ name: "w", phases: [{ name: "a", prompt: "p.md", skip_if }] });
    expect(build([]).success).toBe(false);
    expect(build("").success).toBe(false);
    expect(build([""]).success).toBe(false);
    expect(build(["x == 'y'"]).success).toBe(true);
  });
});

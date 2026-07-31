import { describe, it, expect } from "vitest";
import { runWorkflowCore, AgentWorkflowSchema } from "lastlight-workflow-engine";
import type {
  AgentWorkflowDefinition,
  ExecutorConfig,
  GitSandboxAccess,
  PhaseResolver,
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

const resolver: PhaseResolver = {
  modelFor: () => undefined,
  variantFor: () => undefined,
  renderPrompt: (p) => `PROMPT:${p}`,
  gateEnabled: () => false,
};

/** Drive one run with a scripted diagnose output. Returns the result + probes. */
async function runWith(definition: AgentWorkflowDefinition, diagnoseOutput: string) {
  const store = new InMemoryStateStore(RUN_ID);
  const reporter = new RecordingReporter();
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
    scratch: {},
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

import { describe, it, expect } from "vitest";
import { getWorkflow, loadPromptTemplate } from "#src/workflows/loader.js";
import { defaultReviewConfig, defaultSandboxTimeouts } from "#src/config/config.js";
import { reviewTriageSeed } from "#src/engine/review-triage.js";
import {
  buildDag,
  getReadyNodes,
  getNodesToSkip,
  isComplete,
  evalSkipIf,
  buildPhasePrompt,
  phaseSkipIfExpressions,
  runWorkflowCore,
  PhaseRef,
  resolveDynamicBranches,
  type BranchManifest,
} from "lastlight-workflow-engine";
import type {
  CommandSpec,
  DagNode,
  ExecutorConfig,
  GitSandboxAccess,
  PhaseDefinition,
  PhaseOutcome,
  PhaseResolver,
  PhaseRunContext,
  PhaseTypeHandler,
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
 * Golden test: WP3's evidence pipeline must be INERT.
 *
 * Acceptance criterion 1 of `docs/plans/deterministic-pr-levers.md` §WP3:
 * with `review.analysis.enabled: false`, `pr-review` behaves exactly as it did
 * before the eight new phases existed. That is locked decision 8, and the
 * mechanism it rests on is a single context key — `analysisEnabled`, set ONLY by
 * `specContext()` in `pr-decisions.ts`, which returns `{}` unless the config
 * flag is on. Every new phase carries `skip_if: "analysisEnabled != true"`, and
 * `evalUntilExpression` coerces an ABSENT variable to `false`, so `!= true`
 * matches and the phase skips.
 *
 * This is modelled on `golden-build.test.ts` but has to go further than pinning
 * declaration order, because WP3 also converted `pr-review` from an implicit
 * linear chain into an EXPLICIT one. `buildDag`'s `anyDeclared` flag disables
 * chain synthesis for the WHOLE workflow the moment any phase declares an edge —
 * so the eight new `depends_on` keys silently turned `review` and `post-review`
 * into ROOT nodes, and only the two hand-written edges at the bottom of the YAML
 * put them back on the chain. Nothing about that is visible in the YAML text, so
 * the tests below resolve the DAG rather than reading it.
 */

const DECLARED = [
  // The depth-triage root (issue #378). Declared first, and `prepare` depends
  // on it — so the chain the rest of this file resolves starts here.
  "triage",
  "prepare",
  "facts",
  "seed",
  // The unit survey (docs/plans/pr-review-units-sites.md).
  "units",
  "survey-units",
  "units-ingest",
  // The `sites` review engine. Declared BEFORE `reconcile` and `post-review`,
  // which is what makes the sequential scheduler run them first.
  "site-plan",
  "site-review",
  "merge",
  "select",
  "site-finalize",
  // Kept but NOT attached (docs/plans/pr-review-units-sites.md, D2 c).
  "probe-plan",
  "falsify",
  "review",
  "reconcile",
  "post-review",
];

/** Every phase the evidence pipeline added — all of them vanish when it is off. */
const ANALYSIS_PHASES = DECLARED.filter(
  (n) => n !== "review" && n !== "post-review" && n !== "triage",
);

/**
 * The context that makes the `triage` phase RUN (issue #378).
 *
 * Two keys, both required: the deployment has to have triage on, and this has
 * to be a re-review. Every test below that does not spread this gets a skipped
 * triage phase, which is the shape of a first review and of a deployment that
 * turned it off.
 */
const TRIAGE_ON = { triageEnabled: "true", reviewIsRereview: "true" };

/** The tier guard every analysis phase carries beside its own switch. */
const TIER_GUARD = "scratch.reviewTriage.depth == 'light'";

/**
 * The three probe phases, kept but NOT attached: each skips on a key no code
 * projects, whatever `probesEnabled` says — nothing in the sites engine reads
 * their output yet.
 */
const FALSIFY_PHASES = ["prepare", "probe-plan", "falsify"];
const FALSIFY_GUARD = "falsifyAttached != true";

const UNIT_PHASES = ["units", "survey-units", "units-ingest"];
const SITE_PHASES = ["site-plan", "site-review", "merge", "select", "site-finalize"];

/** The one analysis path, in the order the sequential scheduler runs it. */
const PIPELINE = ["facts", "seed", ...UNIT_PHASES, ...SITE_PHASES, "reconcile"];

/** The two phases that existed before the pipeline and still run when it is off. */
const LEGACY_PHASES = ["review", "post-review"];

/** The pipeline-on context, and the scratch `runner.ts` seeds for it. */
const ON = { analysisEnabled: "true" };
const seeded = (ctx: Record<string, unknown>) => ({ reviewTriage: reviewTriageSeed(ctx) });

/**
 * Replay the scheduler's node-selection loop over a DAG, applying the same
 * `skip_if` gate `runWorkflowCore` applies to ready nodes. Returns what actually
 * ran, in order, and what was skipped and why.
 *
 * This mirrors `scheduler.ts` rather than importing it because the point is to
 * observe the DAG resolving — the real run below then proves the mirror is
 * faithful.
 */
function simulate(
  phases: PhaseDefinition[],
  ctx: Record<string, unknown>,
  // The run's scratch — `runner.ts` seeds `scratch.reviewTriage` before the
  // first phase, and `review`'s guard reads it. `{}` is an unseeded run.
  scratch: Record<string, unknown> = {},
  // Phases that end `failed` instead of `succeeded` when they run.
  failing: ReadonlySet<string> = new Set(),
) {
  const dag = buildDag(phases, { chainIfNoDeps: true });
  const byName = new Map(phases.map((p) => [p.name, p]));
  const ran: string[] = [];
  const skipped: { name: string; reason: string }[] = [];
  let guard = 0;

  while (!isComplete(dag) && guard++ < 200) {
    const toSkip = getNodesToSkip(dag);
    for (const n of toSkip) {
      n.status = "skipped";
      skipped.push({ name: n.name, reason: "trigger rule not satisfied" });
    }
    const ready = getReadyNodes(dag);
    const gated: { node: DagNode; reason: string }[] = [];
    for (const node of ready) {
      const def = byName.get(node.name)!;
      const exprs = phaseSkipIfExpressions(def);
      const matched = exprs.length
        ? evalSkipIf(exprs, { ...ctx, phaseOutputs: {}, scratch, output: "" })
        : undefined;
      if (matched) gated.push({ node, reason: `skip_if matched: ${matched}` });
    }
    if (gated.length > 0) {
      for (const { node, reason } of gated) {
        node.status = "skipped";
        skipped.push({ name: node.name, reason });
      }
      continue;
    }
    if (ready.length === 0) {
      if (toSkip.length === 0) break;
      continue;
    }
    const node = ready[0];
    ran.push(node.name);
    node.status = failing.has(node.name) ? "failed" : "succeeded";
  }

  return { ran, skipped, dag };
}

describe("golden — pr-review.yaml is an explicit chain, and the chain is unbroken", () => {
  const def = getWorkflow("pr-review");

  it("declares the phases in the pinned order", () => {
    expect(def.phases.map((p) => p.name)).toEqual(DECLARED);
  });

  it("declares EVERY edge by hand — chain synthesis is off for this workflow", () => {
    // The trap: `buildDag` synthesizes a linear chain only when NO phase
    // declares `depends_on`. One declared edge anywhere turns synthesis off for
    // every node, so any phase that forgot its own edge silently becomes a root
    // and runs first, in parallel with everything else.
    //
    // `post-review` hangs off `review` alone, never off the pipeline: a failed
    // `select`, `site-finalize` or `reconcile` must not stop a review posting,
    // and `trigger_rule` is per NODE, so folding them into its deps would force
    // it to `all_done` and lose "a FAILED review must not post".
    const expected: Record<string, string[]> = {
      triage: [],
      prepare: ["triage"],
      facts: ["prepare"],
      seed: ["facts"],
      units: ["seed"],
      "survey-units": ["units"],
      "units-ingest": ["survey-units"],
      "site-plan": ["units-ingest"],
      "site-review": ["site-plan"],
      merge: ["site-review"],
      select: ["merge"],
      "site-finalize": ["select"],
      "probe-plan": ["units-ingest"],
      falsify: ["probe-plan"],
      review: ["site-finalize", "falsify"],
      reconcile: ["site-finalize"],
      "post-review": ["review"],
    };
    const declaredEdges = def.phases.filter((p) => p.depends_on?.length);
    // Every phase but the root declares an edge…
    expect(declaredEdges).toHaveLength(DECLARED.length - 1);
    // …and `review` alone declares two.
    expect(declaredEdges.flatMap((p) => p.depends_on ?? [])).toHaveLength(DECLARED.length);

    const dag = buildDag(def.phases, { chainIfNoDeps: true });
    // Exactly one root, and it is the first declared phase.
    expect(dag.filter((n) => n.depends_on.length === 0).map((n) => n.name)).toEqual(["triage"]);
    expect(Object.fromEntries(dag.map((n) => [n.name, n.depends_on]))).toEqual(expected);
  });

  it("gives every phase downstream of a skippable one `all_done`, and post-review `none_failed`", () => {
    // A skipped node is not `succeeded`, so the default `all_success` would
    // cascade the analysis skips straight through `review` — i.e. the inert
    // configuration would post no review at all.
    const byName = new Map(def.phases.map((p) => [p.name, p]));
    for (const name of DECLARED.filter((n) => n !== "triage" && n !== "post-review")) {
      expect(byName.get(name)?.trigger_rule, `${name}.trigger_rule`).toBe("all_done");
    }
    // post-review is deliberately the other way: a FAILED review must not post
    // — but a review SKIPPED by its own guard (pipeline on) must, which the
    // default `all_success` would not allow.
    expect(byName.get("post-review")?.trigger_rule).toBe("none_failed");
  });

  it("guards the pipeline on `analysisEnabled` and the tier, the probes on their own keys, and neither legacy phase", () => {
    const byName = new Map(def.phases.map((p) => [p.name, p]));
    // Triage's own two guards, in the BARE-BOOLEAN form: an absent key is run
    // through `coerceBool`, matches `!= true`, and skips the phase — leaving a
    // full review. The tier guard is the quoted form, which an absent value
    // never matches, so the phase RUNS. Both failure directions are "review
    // everything".
    expect(phaseSkipIfExpressions(byName.get("triage")!), "triage.skip_if").toEqual([
      "triageEnabled != true",
      "reviewIsRereview != true",
    ]);
    for (const name of PIPELINE) {
      expect(phaseSkipIfExpressions(byName.get(name)!), `${name}.skip_if`).toEqual([
        "analysisEnabled != true",
        TIER_GUARD,
        // `select` alone also skips an empty pool — its answer is fixed.
        ...(name === "select" ? ["phaseOutputs.siteMerge.startsWith('SITE_MERGE_EMPTY')"] : []),
      ]);
    }
    for (const name of FALSIFY_PHASES) {
      expect(phaseSkipIfExpressions(byName.get(name)!), `${name}.skip_if`).toEqual([
        "analysisEnabled != true",
        "probesEnabled != true",
        FALSIFY_GUARD,
        TIER_GUARD,
      ]);
    }
    // `post-review` has no guard; `review` has one, the seeded scratch flag —
    // never a context key, which the light harvest could not clear.
    expect(phaseSkipIfExpressions(byName.get("post-review")!)).toEqual([]);
    expect(phaseSkipIfExpressions(byName.get("review")!)).toEqual(["scratch.reviewTriage.skipReview == true"]);
  });
});

describe("golden — which phases a context resolves to", () => {
  const def = getWorkflow("pr-review");

  it("analysis OFF: skips every analysis phase and still runs BOTH legacy phases", () => {
    // The inert context: `specContext()` returned `{}`, so `analysisEnabled` is
    // absent — not `false`, ABSENT. That is the real production shape.
    const { ran, skipped } = simulate(def.phases, { owner: "acme", repo: "widgets" }, seeded({}));
    expect(ran).toEqual(LEGACY_PHASES);
    expect(skipped.map((s) => s.name).sort()).toEqual(["triage", ...ANALYSIS_PHASES].sort());
    // Every skip is the CONDITIONAL one (which keeps the run green), never a
    // trigger-rule cascade (which would drag `review` down with it).
    for (const s of skipped) {
      expect(s.reason, s.name).toBe(
        s.name === "triage"
          ? "skip_if matched: triageEnabled != true"
          : "skip_if matched: analysisEnabled != true",
      );
    }
  });

  it("analysis ON: the one path, then the post — `review` skips, finalize wrote findings.json", () => {
    const { ran, skipped } = simulate(def.phases, ON, seeded(ON));
    expect(ran).toEqual([...PIPELINE, "post-review"]);
    const why = (n: string) => skipped.find((s) => s.name === n)?.reason;
    expect(why("review")).toBe("skip_if matched: scratch.reviewTriage.skipReview == true");
    // No trigger-rule cascade anywhere — every skip is a conditional one.
    expect(skipped.filter((s) => s.reason === "trigger rule not satisfied")).toEqual([]);
  });

  it("probes ON do not run the probe phases — they are not attached", () => {
    const ctx = { ...ON, probesEnabled: "true", ...TRIAGE_ON };
    const { ran, skipped } = simulate(def.phases, ctx, seeded(ctx));
    expect(ran).toEqual(["triage", ...PIPELINE, "post-review"]);
    for (const name of FALSIFY_PHASES) {
      expect(skipped.find((s) => s.name === name)?.reason, name).toBe(`skip_if matched: ${FALSIFY_GUARD}`);
    }
  });

  it("never runs anything on probes alone", () => {
    const { ran } = simulate(def.phases, { probesEnabled: "true" }, seeded({}));
    expect(ran).toEqual(LEGACY_PHASES);
  });

  it("still skips when the key is present but not the literal string `true`", () => {
    // `analysisEnabled` is projected as a STRING, so the gate reads through
    // `coerceBool`. Anything that is not truthy must leave the pipeline inert —
    // the failure direction of a typo is "no analysis", never "an unmeasured
    // pipeline on a deployment that did not ask for it".
    for (const value of ["false", "", "0", "no", "TRUE-ish"]) {
      const ctx = { analysisEnabled: value };
      const { ran } = simulate(def.phases, ctx, seeded(ctx));
      expect(ran, `analysisEnabled=${JSON.stringify(value)}`).toEqual(LEGACY_PHASES);
    }
    // The truthy spellings open the DAG's gates; the seed is the one
    // `specContext` really projects (`"true"`).
    for (const value of ["true", "TRUE", "1", true]) {
      const { ran } = simulate(def.phases, { analysisEnabled: value }, seeded(ON));
      expect(ran, `analysisEnabled=${JSON.stringify(value)}`).toEqual([...PIPELINE, "post-review"]);
    }
  });

  it("LIGHT depth: `review` runs and posts, pipeline on or off", () => {
    // What `harvestReviewTriage` writes on `REVIEW_DEPTH: light` — the whole
    // namespace replaced, so `skipReview` is gone with the rest. Every analysis
    // phase skips on the tier guard, so a `review` that skipped too would leave
    // `post-review` with nothing to read.
    for (const ctx of [{ ...ON, ...TRIAGE_ON }, TRIAGE_ON]) {
      const { ran } = simulate(def.phases, ctx, { reviewTriage: { depth: "light", light: true } });
      expect(ran, JSON.stringify(ctx)).toEqual(["triage", ...LEGACY_PHASES]);
    }
  });

  it("an UNSEEDED run (no scratch flag) runs the review — the failure direction", () => {
    const { ran } = simulate(def.phases, ON);
    expect(ran).toContain("review");
    expect(ran).toContain("post-review");
  });

  it("a FAILED review never posts", () => {
    const { ran, skipped } = simulate(def.phases, {}, seeded({}), new Set(["review"]));
    expect(ran).toEqual(["review"]);
    expect(skipped.find((s) => s.name === "post-review")?.reason).toBe("trigger rule not satisfied");
  });

  it("a failed select, finalize or floor still posts — the money property", () => {
    // A red run that posts nothing leaves both per-head dedups blank, and the
    // thirty-minute sweep re-buys the whole pipeline on the same SHA forever.
    for (const fail of ["select", "site-finalize", "reconcile"]) {
      const { ran } = simulate(def.phases, ON, seeded(ON), new Set([fail]));
      expect(ran, fail).toContain("post-review");
      // …and the floor still runs after a failed step above it.
      expect(ran, fail).toContain("reconcile");
    }
  });
});

// ── The same thing, through the real scheduler ───────────────────────────────

const RUN_ID = "run-pr-review";

const resolver: PhaseResolver = {
  modelFor: () => undefined,
  variantFor: () => undefined,
  renderPrompt: (p) => `PROMPT:${p}`,
  gateEnabled: () => false,
};

/** Stands in for `PhaseExecutor.runPostReview` — the app-registered handler. */
class RecordingPostReview implements PhaseTypeHandler {
  readonly calls: string[] = [];
  async execute(phase: PhaseDefinition): Promise<PhaseOutcome> {
    this.calls.push(phase.name);
    return {
      results: [{ phase: phase.name, success: true, output: "posted" }],
      status: "succeeded",
    };
  }
}

/**
 * Stands in for the app-registered `fanout` handler.
 *
 * The real one (`src/workflows/handlers/fanout.ts`) needs a provisioned
 * sandbox, which this layer deliberately does not have — `fanout.test.ts`
 * exercises it against a `FakeSandbox` and pins the one-provision / N-turns /
 * one-dispose property. What this double has to be faithful about is only what
 * the SCHEDULER sees: one agent call and one gate command per branch, reported
 * under `<phase>_branch_<name>` labels. That is what keeps the call-count
 * assertions below meaningful across the WP11c change instead of quietly
 * dropping six model calls off the tally.
 *
 * A `branches_from:` fan-out has no workspace here to read its manifest from,
 * so the double takes the manifest `site-plan` would have written and resolves
 * it through the engine's own `resolveDynamicBranches` — the same call the real
 * handler makes.
 */
const SITE_MANIFEST: BranchManifest = {
  items: [{ id: "site-001" }, { id: "site-002" }, { id: "site-001-b", pair: true }, { id: "site-002-b", pair: true }],
};

class RecordingFanout implements PhaseTypeHandler {
  constructor(
    private readonly agent: FakeAgentPort,
    private readonly manifest: BranchManifest = SITE_MANIFEST,
  ) {}
  async execute(phase: PhaseDefinition): Promise<PhaseOutcome> {
    const branches = phase.branches_from
      ? resolveDynamicBranches(phase, this.manifest, {} as TemplateContext).branches
      : (phase.branches ?? []);
    const results = [];
    for (const branch of branches) {
      const label = PhaseRef.branch(phase.name, branch.name).format();
      const r = await this.agent.runAgent(
        `PROMPT:${branch.prompt}`,
        {} as never,
        { taskId: "task-1" } as never,
      );
      if (branch.until_bash) {
        await this.agent.runCommand({ kind: "bash", command: branch.until_bash }, {} as never, {
          taskId: "task-1",
        } as never);
      }
      results.push({ phase: label, success: r.success, output: r.output ?? "", error: r.error });
    }
    const anySucceeded = results.some((r) => r.success);
    return { results, status: anySucceeded ? "succeeded" : "failed" };
  }
}

/**
 * Stands in for the app-registered `survey-units` handler, which makes model
 * calls from the harness and needs a host checkout — `survey-units.test.ts`
 * drives the real one. What the scheduler sees is one node that succeeds (or,
 * when told to, fails) under its own name.
 */
class RecordingSurveyUnits implements PhaseTypeHandler {
  readonly calls: string[] = [];
  constructor(private readonly fail = false) {}
  async execute(phase: PhaseDefinition): Promise<PhaseOutcome> {
    this.calls.push(phase.name);
    return this.fail
      ? { results: [{ phase: phase.name, success: false, output: "", error: "every unit call failed" }], status: "failed" }
      : { results: [{ phase: phase.name, success: true, output: "surveyed" }], status: "succeeded" };
  }
}

/**
 * An agent port that hard-fails exactly one phase's prompt and succeeds at
 * everything else. `FakeAgentPort.script()` is a single FIFO queue shared by
 * agent AND command calls, so it cannot target one phase in a run with eight
 * `until_bash` gates interleaved through it.
 */
class FailOnePromptAgent extends FakeAgentPort {
  constructor(private readonly needle: string) {
    super({ success: true, output: "reviewed", turns: 1, durationMs: 0 });
  }
  override async runAgent(prompt: string, config: never, opts: never) {
    const res = await super.runAgent(prompt, config, opts);
    if (prompt.includes(this.needle)) {
      // `error_fatal` is a HARD outcome — `on_soft_failure` does not catch it,
      // which is the case worth pinning.
      return { success: false, output: "", turns: 1, durationMs: 0, stopReason: "error_fatal", error: "boom" };
    }
    return res;
  }
}

/**
 * `sites --merge` pooled nothing: it prints the marker `select` skips on
 * (`SITE_MERGE_EMPTY_MARKER` in lastlight-code-facts, which core does not
 * depend on — hence the literal).
 */
class EmptyMergeAgent extends FakeAgentPort {
  constructor() {
    super({ success: true, output: "reviewed", turns: 1, durationMs: 0 });
  }
  override async runCommand(spec: CommandSpec, config: never, opts: never) {
    const res = await super.runCommand(spec, config, opts);
    if (spec.kind === "bash" && spec.command.includes("sites --merge")) {
      return { ...res, output: `SITE_MERGE_EMPTY\n\n# Site findings to select from\n` };
    }
    return res;
  }
}

/**
 * The config-derived budgets `dispatchWorkflow` + `renderContext` seed on every
 * real pr-review run (issue #385). This harness drives the scheduler directly,
 * so it seeds them itself — from the same resolved defaults, never a literal.
 */
function timeoutContext(): Record<string, unknown> {
  const review = defaultReviewConfig();
  const sandbox = defaultSandboxTimeouts();
  return {
    timeouts: {
      agentSeconds: sandbox.agentTimeoutSeconds,
      commandSeconds: sandbox.commandTimeoutSeconds,
      untilBashSeconds: sandbox.untilBashTimeoutSeconds,
    },
    triageTimeoutSeconds: String(review.triage.timeoutSeconds),
    probePhaseTimeoutSeconds: String(review.analysis.prepareTimeoutSeconds),
    factsTimeoutSeconds: String(review.analysis.factsTimeoutSeconds),
    seedTimeoutSeconds: String(review.analysis.seedTimeoutSeconds),
    reconcileTimeoutSeconds: String(review.analysis.reconcileTimeoutSeconds),
    falsifyTimeoutSeconds: String(review.analysis.falsifyTimeoutSeconds),
    surveyUnitsTimeoutSeconds: String(review.analysis.surveyUnitsTimeoutSeconds),
  };
}

async function runPrReview(
  ctx: Record<string, unknown>,
  agentPort?: FakeAgentPort,
  // What `runner.ts`'s `seedReviewTriage` would have put on the run's scratch.
  // This harness drives the scheduler directly, below the seed.
  scratch: Record<string, unknown> = {},
  surveyUnits: RecordingSurveyUnits = new RecordingSurveyUnits(),
) {
  const def = getWorkflow("pr-review");
  const store = new InMemoryStateStore(RUN_ID);
  const reporter = new RecordingReporter();
  const agent =
    agentPort ?? new FakeAgentPort({ success: true, output: "reviewed", turns: 1, durationMs: 0 });
  const postReview = new RecordingPostReview();
  const fanout = new RecordingFanout(agent);

  const runScope: PhaseRunContext = {
    definition: def,
    ctx: { ...timeoutContext(), ...ctx } as unknown as TemplateContext,
    config: { sandbox: "none" } as unknown as ExecutorConfig,
    taskId: "task-1",
    triggerId: "acme/widgets#7",
    githubAccess: { owner: "acme", repo: "widgets", profile: "review-write" } as GitSandboxAccess,
    scratch: { ...scratch },
    store,
    workflowId: RUN_ID,
    botName: "last-light",
  };

  const deps: SchedulerDeps = {
    reporter,
    resolver,
    ports: {
      agent,
      assets: new StubAssetLoader(),
      liveness: noopLiveness,
      observability: noopObservability,
      handlers: new Map<string, PhaseTypeHandler>([
        ["post-review", postReview],
        ["fanout", fanout],
        ["survey-units", surveyUnits],
      ]),
    },
    store,
    reporterActive: false,
    capabilities: { qaImageAvailable: () => false, qaImageName: "lastlight-sandbox-qa:latest" },
  };

  const result = await runWorkflowCore(runScope, deps);
  return { result, reporter, agent, store, postReview, fanout, surveyUnits };
}

describe("golden — the real scheduler", () => {
  it("analysis OFF: spends exactly one agent call, posts once, and finishes green", async () => {
    const { result, agent, postReview, store } = await runPrReview(
      { owner: "acme", repo: "widgets", prNumber: 7 },
      undefined,
      seeded({}),
    );

    expect(result.success).toBe(true);
    expect((await store.runs.getRun(RUN_ID))?.status).toBe("succeeded");
    // ONE model call — the `review` phase. The bash phases never ran either,
    // so `runCommand` was never reached.
    expect(agent.calls.filter((c) => c.kind === "agent")).toHaveLength(1);
    expect(agent.calls.filter((c) => c.kind === "command")).toHaveLength(0);
    expect(postReview.calls).toEqual(["post-review"]);
  });

  it("analysis OFF: records every phase — skipped or done — so the dashboard is not silent", async () => {
    const { result, reporter } = await runPrReview(
      { owner: "acme", repo: "widgets", prNumber: 7 },
      undefined,
      seeded({}),
    );

    expect(result.phases.map((p) => p.phase).sort()).toEqual([...DECLARED].sort());
    // A conditional skip is a SUCCESS: painting the run red would post
    // `messages.on_failure`, offer a Retry that cannot succeed and defeat the
    // per-head-SHA dedup.
    expect(result.phases.every((p) => p.success)).toBe(true);
    for (const name of ANALYSIS_PHASES) {
      expect(result.phases.find((p) => p.phase === name)?.output, name).toContain(
        "skip_if matched: analysisEnabled != true",
      );
    }
    expect(reporter.failures).toEqual([]);
    const skippedSteps = reporter.steps.filter((s) => s.status === "skipped").map((s) => s.key);
    expect(skippedSteps.sort()).toEqual(["triage", ...ANALYSIS_PHASES].sort());
  });

  const PIPELINE_CTX = {
    owner: "acme",
    repo: "widgets",
    prNumber: 7,
    ...ON,
    // `site-review`'s and review's `command_policy` read these (issue #403);
    // `renderContext` seeds them alongside the flag above.
    probeScratchInstallPolicy: "block",
    reviewInstallPolicy: "block",
  };

  it("analysis ON: the unit survey once, one investigator per manifest slot, one select loop, the floor, then the post", async () => {
    const { result, agent, postReview, surveyUnits } = await runPrReview(PIPELINE_CTX, undefined, seeded(PIPELINE_CTX));
    const seen = result.phases.map((p) => p.phase);
    expect(surveyUnits.calls).toEqual(["survey-units"]);
    // A node with sub-units reports under the sub-unit's label, never its own
    // name — fan-out branches under `<phase>_branch_<name>`, generic loops
    // under `<phase>_iter_N`.
    // The branch labels come from the manifest `site-plan` writes — two sites,
    // each paired — not from a static list in the YAML.
    const sites = seen.filter((p) => p.startsWith("site-review_branch_"));
    expect(sites).toEqual(SITE_MANIFEST.items.map((i) => `site-review_branch_${i.id}`));
    expect(seen).toContain("select_iter_1");
    expect(seen).not.toContain("falsify_iter_1");
    // The floor runs after finalize, and before the post.
    expect(seen.indexOf("site-finalize")).toBeLessThan(seen.indexOf("reconcile"));
    expect(seen.indexOf("reconcile")).toBeLessThan(seen.indexOf("post-review"));
    expect(postReview.calls).toEqual(["post-review"]);
    expect(result.phases.every((p) => p.success)).toBe(true);
    // Four investigators + the select call — `review` skipped, nothing else.
    expect(agent.calls.filter((c) => c.kind === "agent")).toHaveLength(SITE_MANIFEST.items.length + 1);
  });

  it("posts the review even when SELECT hard-fails — the money property", async () => {
    // `assessedHeadShaByWorkflow` is populated from SUCCEEDED runs only, so a
    // red run leaves no trace — and if a failing step could stop `post-review`,
    // nothing would be posted either, so `botReviewAtHead` would stay null too.
    // With BOTH per-head dedups blank, `cron-review.yaml`'s thirty-minute sweep
    // re-dispatches the same SHA and pays for the whole pipeline every half
    // hour, forever. `site-finalize` falls back to one item per finding, and
    // the floor runs over it.
    const { result, postReview } = await runPrReview(
      PIPELINE_CTX,
      new FailOnePromptAgent("review-select.md"),
      seeded(PIPELINE_CTX),
    );
    expect(postReview.calls).toEqual(["post-review"]);
    const seen = result.phases.map((p) => p.phase);
    expect(seen).toContain("site-finalize");
    expect(seen).toContain("reconcile");
    // …and it is honestly reported as a failed RUN, not quietly swallowed.
    expect(result.success).toBe(false);
    expect(result.phases.filter((p) => p.phase.startsWith("select")).some((p) => !p.success)).toBe(true);
  });

  it("skips select when merge pooled nothing — no model call for a fixed answer", async () => {
    const { result, postReview } = await runPrReview(PIPELINE_CTX, new EmptyMergeAgent(), seeded(PIPELINE_CTX));
    const seen = result.phases.map((p) => p.phase);
    expect(seen).not.toContain("select_iter_1");
    expect(result.phases.find((p) => p.phase === "select")?.output).toContain("SITE_MERGE_EMPTY");
    expect(seen).toContain("site-finalize");
    expect(postReview.calls).toEqual(["post-review"]);
    expect(result.success).toBe(true);
  });

  it("the unit calls FAILING still reach the sites and the post — ingest records the gap", async () => {
    const { result, postReview } = await runPrReview(
      PIPELINE_CTX,
      undefined,
      seeded(PIPELINE_CTX),
      new RecordingSurveyUnits(true),
    );
    const seen = result.phases.map((p) => p.phase);
    expect(seen).toContain("units-ingest");
    expect(seen).toContain("site-plan");
    expect(postReview.calls).toEqual(["post-review"]);
  });
});

// ── The review phase's two-mode brief (§3b lever f4) ─────────────────────────

/**
 * The `review` phase as it stands after f4: the pre-WP3 shape PLUS a
 * `prompt:`. Until f4 it had no prompt at all and rode `buildPhasePrompt`'s
 * skills fallback, which serialises the ENTIRE render context as `key: value`
 * lines — that byte-for-byte dump guarantee is deliberately retired (an
 * analysis-mode review needs a different brief, and a template cannot
 * reproduce a dynamic dump). What replaces it is pinned below: the OFF
 * rendering keeps the skill nudge + a curated Context section and leaks
 * nothing pipeline-shaped; the LIGHT rendering is a light re-review's single
 * pass.
 */
const F4_REVIEW_PHASE = {
  name: "review",
  label: "Review",
  // `type` is the schema's default, not YAML text — it is here because the
  // comparison below is against the PARSED definition.
  type: "agent",
  prompt: "prompts/review.md",
  skills: ["pr-review", "code-review"],
  model: "{{models.review}}",
  variant: "{{variants.review}}",
};

const PRE_WP3_POST_REVIEW_PHASE = {
  name: "post-review",
  label: "Post inline review",
  type: "post-review",
};

describe("golden — the `review` phase's two-mode brief", () => {
  const def = getWorkflow("pr-review");
  const review = def.phases.find((p) => p.name === "review")!;
  const postReview = def.phases.find((p) => p.name === "post-review")!;

  // The real template, rendered through the same `buildPhasePrompt` path the
  // engine uses — via a stub loader that serves the packaged file, so a
  // template edit fails HERE rather than in production.
  const assets = new StubAssetLoader({
    "prompts/review.md": loadPromptTemplate("prompts/review.md"),
  });
  const baseCtx = {
    owner: "acme",
    repo: "widgets",
    prNumber: 7,
    branch: "feature/x",
    baseBranch: "main",
    headSha: "deadbeef",
    prTitle: "Fix the widget",
    checksState: "passing",
  } as unknown as TemplateContext;

  it("adds only the scheduling keys and the f4 prompt to the review phase", () => {
    const { depends_on, trigger_rule, command_policy, skip_if, ...rest } = review as Record<string, unknown>;
    expect(depends_on).toEqual(["site-finalize", "falsify"]);
    expect(trigger_rule).toBe("all_done");
    // One guard, the seeded scratch flag — never a context key, which the light
    // harvest could not clear. The phase runs whenever the seed did not ask it
    // to skip: pipeline off, light, or an unseeded run.
    expect(skip_if).toEqual(["scratch.reviewTriage.skipReview == true"]);
    // The suite is blocked in both modes; an install only when the pipeline is
    // on (issue #403) — pinned in pr-review-command-policy.test.ts.
    expect(command_policy).toMatchObject({ install: { from: "reviewInstallPolicy", default: "allow" }, test: "block" });
    // The mode switch between the two arms is inside the prompt, never in
    // the DAG.
    expect(rest).toEqual(F4_REVIEW_PHASE);

    const { depends_on: pDeps, trigger_rule: pRule, ...pRest } = postReview as Record<string, unknown>;
    expect(pDeps).toEqual(["review"]);
    expect(pRule).toBe("none_failed");
    expect(pRest).toEqual(PRE_WP3_POST_REVIEW_PHASE);
  });

  /**
   * The two arms are chosen by `scratch.reviewTriage`, not by
   * `analysisEnabled` (issue #378).
   *
   * The template engine has no `else` and no nesting, so a choice is mutually
   * exclusive keys. `runner.ts` seeds `baseline` at run start and the triage
   * harvest replaces the namespace with `light`, which is what makes "exactly
   * one arm renders" true by construction rather than by the triage phase
   * having run.
   */
  const withTriage = (slot: Record<string, unknown>) =>
    ({ ...baseCtx, scratch: { reviewTriage: slot } }) as unknown as TemplateContext;

  it("analysis OFF: the skill nudge and the curated context, nothing pipeline-shaped", () => {
    const off = buildPhasePrompt(
      review,
      withTriage({ depth: "full", baseline: true }),
      assets,
      { phaseOutputs: {} },
    );

    expect(off).toContain("Use the **pr-review** skill to handle this request.");
    expect(off).toContain("Other skills available if you need them: code-review.");
    // The curated Context section carries the keys the skill's procedure
    // names (§1 target, §3 diff range, §4 CI evidence).
    expect(off).toContain("repository: acme/widgets");
    expect(off).toContain("prNumber: 7");
    expect(off).toContain("baseBranch: main");
    expect(off).toContain("headSha: deadbeef");
    expect(off).toContain("checksState: passing");
    // Nothing from the analysis brief leaks into the off-mode prompt.
    expect(off).not.toContain("analysisEnabled");
    expect(off).not.toContain("obligations");
    expect(off).not.toContain("hypotheses");
    expect(off).not.toContain("abbreviated");
    // Every marker consumed.
    expect(off).not.toContain("{{");
  });

  it("LIGHT: one focused pass over the delta, naming the review it follows", () => {
    // The tier the triage phase writes. It must not claim the pipeline ran —
    // on a light run it did not.
    const light = buildPhasePrompt(
      review,
      {
        ...baseCtx,
        scratch: { reviewTriage: { depth: "light", light: true } },
        priorReviewSha: "1e8bea8",
        priorReviewState: "APPROVED",
        priorReviewBody: "Looks good, one nit about the retry bound.",
      } as unknown as TemplateContext,
      assets,
      { phaseOutputs: {} },
    );

    // The other arm does not render.
    expect(light).not.toContain("Use the **pr-review** skill to handle this request.");
    expect(light).not.toContain("hypotheses");
    // It names what it is following, which is the whole of its extra context.
    expect(light).toContain("1e8bea8");
    expect(light).toContain("APPROVED");
    expect(light).toContain("Looks good, one nit about the retry bound.");
    // And it still owes the same artifact — post-review fails loudly without it.
    expect(light).toContain(".lastlight/pr-review/findings.json");
    expect(light).not.toContain("{{");
  });

  it("renders EXACTLY ONE arm for each seeded tier", () => {
    // The property the keys exist for. A prompt with two arms tells the model
    // two different jobs; a prompt with none hands it a bare Context block and
    // no brief at all.
    const marker = {
      baseline: "Use the **pr-review** skill to handle this request.",
      light: "single focused pass",
    };
    for (const [tier, needle] of Object.entries(marker)) {
      const slot =
        tier === "light" ? { depth: "light", light: true } : { depth: "full", [tier]: true };
      const rendered = buildPhasePrompt(review, withTriage(slot), assets, { phaseOutputs: {} });
      for (const [other, otherNeedle] of Object.entries(marker)) {
        if (other === tier) expect(rendered, `${tier} renders`).toContain(needle);
        else expect(rendered, `${tier} does not render ${other}`).not.toContain(otherNeedle);
      }
    }
  });
});

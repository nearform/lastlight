import { describe, it, expect } from "vitest";
import { getWorkflow } from "#src/workflows/loader.js";
import {
  buildDag,
  getReadyNodes,
  getNodesToSkip,
  isComplete,
  evalSkipIf,
  buildPhasePrompt,
  phaseSkipIfExpressions,
  runWorkflowCore,
  AgentWorkflowSchema,
} from "lastlight-workflow-engine";
import type {
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
 * Acceptance criterion 1 of `docs/plans/review-evidence-pipeline/03-seed-and-survey.md`:
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
  "facts",
  "seed",
  "survey_contract",
  "survey_enforcement",
  "survey_security",
  "survey_state",
  "survey_tests",
  "survey_spec",
  "review",
  "post-review",
];

/** The eight phases WP3 added — every one of them must vanish when the flag is off. */
const ANALYSIS_PHASES = DECLARED.slice(0, 8);

/** The two phases that existed before WP3 and must still EXECUTE when it is off. */
const LEGACY_PHASES = ["review", "post-review"];

/** The six obligation families, in the order their survey phases are chained. */
const FAMILIES = ["contract", "enforcement", "security", "state", "tests", "spec"] as const;

/**
 * Replay the scheduler's node-selection loop over a DAG, applying the same
 * `skip_if` gate `runWorkflowCore` applies to ready nodes. Returns what actually
 * ran, in order, and what was skipped and why.
 *
 * This mirrors `scheduler.ts` rather than importing it because the point is to
 * observe the DAG resolving — the real run below then proves the mirror is
 * faithful.
 */
function simulate(phases: PhaseDefinition[], ctx: Record<string, unknown>) {
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
        ? evalSkipIf(exprs, { ...ctx, phaseOutputs: {}, scratch: {}, output: "" })
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
    node.status = "succeeded";
  }

  return { ran, skipped, dag };
}

describe("golden — pr-review.yaml is an explicit chain, and the chain is unbroken", () => {
  const def = getWorkflow("pr-review");

  it("declares the ten phases in the pinned order", () => {
    expect(def.phases.map((p) => p.name)).toEqual(DECLARED);
  });

  it("declares EVERY edge by hand — chain synthesis is off for this workflow", () => {
    // The trap: `buildDag` synthesizes a linear chain only when NO phase
    // declares `depends_on`. One declared edge anywhere turns synthesis off for
    // all ten nodes, so any phase that forgot its own edge silently becomes a
    // root and runs first, in parallel with everything else.
    const declaredEdges = def.phases.filter((p) => p.depends_on?.length);
    expect(declaredEdges).toHaveLength(DECLARED.length - 1);

    const dag = buildDag(def.phases, { chainIfNoDeps: true });
    // Exactly one root, and it is the first declared phase.
    expect(dag.filter((n) => n.depends_on.length === 0).map((n) => n.name)).toEqual(["facts"]);
    // …and every other node depends on precisely its predecessor.
    for (let i = 1; i < dag.length; i++) {
      expect(dag[i].depends_on).toEqual([DECLARED[i - 1]]);
    }
  });

  it("gives every phase downstream of a skippable one `all_done`, and post-review `all_success`", () => {
    // A skipped node is not `succeeded`, so the default `all_success` would
    // cascade the eight analysis skips straight through `review` — i.e. the
    // inert configuration would post no review at all. `all_done` is the rule
    // the schema names for exactly this.
    const byName = new Map(def.phases.map((p) => [p.name, p]));
    for (const name of DECLARED.slice(1, 9)) {
      expect(byName.get(name)?.trigger_rule, `${name}.trigger_rule`).toBe("all_done");
    }
    // post-review is deliberately the other way: a FAILED review must not post.
    expect(byName.get("post-review")?.trigger_rule).toBeUndefined();
    expect(byName.get("post-review")?.depends_on).toEqual(["review"]);
  });

  it("guards all eight new phases on `analysisEnabled != true`, and neither legacy phase", () => {
    const byName = new Map(def.phases.map((p) => [p.name, p]));
    for (const name of ANALYSIS_PHASES) {
      expect(phaseSkipIfExpressions(byName.get(name)!), `${name}.skip_if`).toEqual([
        "analysisEnabled != true",
      ]);
    }
    for (const name of LEGACY_PHASES) {
      expect(phaseSkipIfExpressions(byName.get(name)!), `${name}.skip_if`).toEqual([]);
    }
  });
});

describe("golden — with review.analysis off, pr-review resolves to review → post-review", () => {
  const def = getWorkflow("pr-review");

  it("skips all eight analysis phases and still runs BOTH legacy phases", () => {
    // The inert context: `specContext()` returned `{}`, so `analysisEnabled` is
    // absent — not `false`, ABSENT. That is the real production shape and it is
    // the one the gate has to handle.
    const { ran, skipped } = simulate(def.phases, { owner: "acme", repo: "widgets" });

    expect(ran).toEqual(LEGACY_PHASES);
    expect(skipped.map((s) => s.name)).toEqual(ANALYSIS_PHASES);
    // Every skip is the CONDITIONAL one (which keeps the run green), never a
    // trigger-rule cascade (which would drag `review` down with it).
    for (const s of skipped) {
      expect(s.reason, s.name).toBe("skip_if matched: analysisEnabled != true");
    }
  });

  it("runs all ten in declaration order once the flag is on", () => {
    const { ran, skipped } = simulate(def.phases, { analysisEnabled: "true" });
    expect(ran).toEqual(DECLARED);
    expect(skipped).toEqual([]);
  });

  it("still skips when the key is present but not the literal string `true`", () => {
    // `analysisEnabled` is projected as a STRING (`"true"`), so the gate reads
    // through `coerceBool`. Anything that is not truthy must leave the pipeline
    // inert — the failure direction of a typo is "no analysis", never "an
    // unmeasured pipeline on a deployment that did not ask for it".
    for (const value of ["false", "", "0", "no", "TRUE-ish"]) {
      const { ran } = simulate(def.phases, { analysisEnabled: value });
      expect(ran, `analysisEnabled=${JSON.stringify(value)}`).toEqual(LEGACY_PHASES);
    }
    // …and the two spellings that legitimately mean yes do enable it.
    for (const value of ["true", "TRUE", "1", true]) {
      const { ran } = simulate(def.phases, { analysisEnabled: value });
      expect(ran, `analysisEnabled=${JSON.stringify(value)}`).toEqual(DECLARED);
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

async function runPrReview(ctx: Record<string, unknown>) {
  const def = getWorkflow("pr-review");
  const store = new InMemoryStateStore(RUN_ID);
  const reporter = new RecordingReporter();
  const agent = new FakeAgentPort({ success: true, output: "reviewed", turns: 1, durationMs: 0 });
  const postReview = new RecordingPostReview();

  const runScope: PhaseRunContext = {
    definition: def,
    ctx: ctx as unknown as TemplateContext,
    config: { sandbox: "none" } as unknown as ExecutorConfig,
    taskId: "task-1",
    triggerId: "acme/widgets#7",
    githubAccess: { owner: "acme", repo: "widgets", profile: "review-write" } as GitSandboxAccess,
    scratch: {},
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
      handlers: new Map([["post-review", postReview]]),
    },
    store,
    reporterActive: false,
    capabilities: { qaImageAvailable: () => false, qaImageName: "lastlight-sandbox-qa:latest" },
  };

  const result = await runWorkflowCore(runScope, deps);
  return { result, reporter, agent, store, postReview };
}

describe("golden — the real scheduler, driven with review.analysis off", () => {
  it("spends exactly one agent call, posts once, and finishes green", async () => {
    const { result, agent, postReview, store } = await runPrReview({
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
    });

    expect(result.success).toBe(true);
    expect((await store.runs.getRun(RUN_ID))?.status).toBe("succeeded");

    // ONE model call — the `review` phase. Not nine. The two bash phases never
    // ran either, so `runCommand` was never reached.
    expect(agent.calls.filter((c) => c.kind === "agent")).toHaveLength(1);
    expect(agent.calls.filter((c) => c.kind === "command")).toHaveLength(0);
    // …and the review really was posted.
    expect(postReview.calls).toEqual(["post-review"]);
  });

  it("records all ten phases — eight skipped, two done — so the dashboard is not silent", async () => {
    const { result, reporter } = await runPrReview({ owner: "acme", repo: "widgets", prNumber: 7 });

    expect(result.phases.map((p) => p.phase)).toEqual(DECLARED);
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
    expect(skippedSteps).toEqual(ANALYSIS_PHASES);
  });

  it("runs every phase once the flag is on — the pipeline is wired, not decorative", async () => {
    const { result, agent, postReview } = await runPrReview({
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
      analysisEnabled: "true",
    });

    // A generic-loop node reports under its ITERATION label
    // (`survey_contract_iter_1`), never its own name — so the six surveys are
    // present as iterations, and the four non-loop phases under their own names.
    const seen = result.phases.map((p) => p.phase);
    expect(seen.filter((n) => DECLARED.includes(n))).toEqual([
      "facts",
      "seed",
      "review",
      "post-review",
    ]);
    for (const family of FAMILIES) {
      expect(seen, family).toContain(`survey_${family}_iter_1`);
    }
    expect(result.phases.every((p) => p.success)).toBe(true);

    // Two deterministic bash phases + six generic-loop `until_bash` gates.
    expect(agent.calls.filter((c) => c.kind === "command").length).toBeGreaterThanOrEqual(2);
    // Six survey passes + the review itself.
    expect(agent.calls.filter((c) => c.kind === "agent")).toHaveLength(7);
    expect(postReview.calls).toEqual(["post-review"]);
  });
});

// ── The review phase itself is byte-for-byte what it was ─────────────────────

/**
 * `pr-review`'s `review` phase exactly as it stood at `caa9d58e`, immediately
 * before WP3. Pinned as a literal rather than read from git so the guarantee is
 * a fact in this file rather than a property of the working tree.
 */
const PRE_WP3_REVIEW_PHASE = {
  name: "review",
  label: "Review",
  // `type` is the schema's default, not YAML text — it is here because the
  // comparison below is against the PARSED definition.
  type: "agent",
  skills: ["pr-review", "code-review"],
  model: "{{models.review}}",
  variant: "{{variants.review}}",
};

const PRE_WP3_POST_REVIEW_PHASE = {
  name: "post-review",
  label: "Post inline review",
  type: "post-review",
};

describe("golden — the `review` phase's rendered prompt is unchanged", () => {
  const def = getWorkflow("pr-review");
  const review = def.phases.find((p) => p.name === "review")!;
  const postReview = def.phases.find((p) => p.name === "post-review")!;

  it("adds only the two scheduling keys to the review phase, and nothing else", () => {
    const { depends_on, trigger_rule, ...rest } = review as Record<string, unknown>;
    expect(depends_on).toEqual(["survey_spec"]);
    expect(trigger_rule).toBe("all_done");
    // Everything a prompt is built from is untouched: no `prompt:`, no
    // `skip_if:`, the same two skills, the same model/variant templates.
    expect(rest).toEqual(PRE_WP3_REVIEW_PHASE);

    const { depends_on: pDeps, ...pRest } = postReview as Record<string, unknown>;
    expect(pDeps).toEqual(["review"]);
    expect(pRest).toEqual(PRE_WP3_POST_REVIEW_PHASE);
  });

  it("renders the identical prompt the pre-WP3 phase definition would have", () => {
    // `review` has no prompt template, so `buildPhasePrompt` takes the SKILLS
    // branch — which serialises the entire render context as `key: value` lines.
    // That is why a context key present-but-empty is a prompt change and why
    // `specContext()` has to OMIT rather than blank (see `pr-decisions.test.ts`).
    const assets = new StubAssetLoader();
    const ctx = {
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
      branch: "main",
      baseBranch: "main",
      headSha: "deadbeef",
    } as unknown as TemplateContext;

    const before = buildPhasePrompt(
      AgentWorkflowSchema.parse({ name: "x", phases: [PRE_WP3_REVIEW_PHASE] }).phases[0],
      ctx,
      assets,
      { phaseOutputs: {} },
    );
    const after = buildPhasePrompt(review, ctx, assets, { phaseOutputs: {} });

    expect(after).toBe(before);
    // And it is the shape we think it is — a skills nudge plus the context dump.
    expect(after).toContain("Use the **pr-review** skill to handle this request.");
    expect(after).not.toContain("analysisEnabled");
    expect(after).not.toContain("obligations");
  });
});

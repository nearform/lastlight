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
  PhaseRef,
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
  "prepare",
  "facts",
  "seed",
  // WP11c — the six chained `survey_<family>` phases are ONE `type: fanout`
  // node now. The families did not change; the node count did.
  "survey",
  "falsify",
  "review",
  "adjudicate",
  "reconcile",
  "post-review",
];

/**
 * Every phase the evidence pipeline added — all seven vanish when it is off.
 *
 * Not a `slice` any more: WP6's two phases sit AFTER `review` rather than before
 * it, because `adjudicate` consumes what the review pass wrote. So the pipeline
 * phases are no longer a contiguous prefix and spelling them as one would be a
 * quietly wrong assertion.
 */
const ANALYSIS_PHASES = DECLARED.filter((n) => n !== "review" && n !== "post-review");

/**
 * WP4's two phases are gated SEPARATELY, on `probesEnabled`, so they skip even
 * on a deployment that turned the pipeline on. Their own key because the
 * decision they encode — install a pull request author's dependencies into the
 * workspace, then execute things in it — is not the same decision as "run the
 * surveys".
 */
const WP4_PHASES = ["prepare", "falsify"];
// WP3's three. `falsify` is WP4's and carries BOTH gates, so it is asserted
// under WP4_PHASES rather than here.
const WP3_PHASES = ["facts", "seed", "survey"];

/**
 * WP6's two. `adjudicate` is the model pass; `reconcile` is its deterministic
 * §D12 FLOOR — reaching `max_iterations` without the conservation condition is
 * not a phase failure in this engine, so without `reconcile` an adjudicator that
 * never satisfied the gate would silently drop hypotheses, which is the one
 * outcome the gate exists to prevent.
 */
const WP6_PHASES = ["adjudicate", "reconcile"];

/** The two phases that existed before WP3 and must still EXECUTE when it is off. */
const LEGACY_PHASES = ["review", "post-review"];

/**
 * The five survey-branch families. `tests` is deliberately absent: its branch
 * was removed from the fan-out (no seeder exists for the family and its
 * `coverage` source needs the probes-gated `prepare` artifact) — the seeder
 * still writes its block and `measured: false` row, but nothing dispatches it.
 */
const FAMILIES = ["contract", "enforcement", "security", "state", "spec"] as const;

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

  it("declares the nine phases in the pinned order", () => {
    expect(def.phases.map((p) => p.name)).toEqual(DECLARED);
  });

  it("declares EVERY edge by hand — chain synthesis is off for this workflow", () => {
    // The trap: `buildDag` synthesizes a linear chain only when NO phase
    // declares `depends_on`. One declared edge anywhere turns synthesis off for
    // every node, so any phase that forgot its own edge silently becomes a root
    // and runs first, in parallel with everything else.
    //
    // The graph stopped being a straight line at WP6: `adjudicate` and
    // `post-review` BOTH hang off `review`. That fan-out is deliberate and is
    // the whole reason a failing adjudicator cannot stop a review posting —
    // `trigger_rule` is per NODE, not per edge, so putting `adjudicate` in
    // `post-review`'s dep set would have forced it to `all_done` and lost the
    // invariant that a failed review must not post. Pinning the edges by name
    // rather than by index is what keeps that readable.
    const expected: Record<string, string[]> = {
      prepare: [],
      facts: ["prepare"],
      seed: ["facts"],
      survey: ["seed"],
      falsify: ["survey"],
      review: ["falsify"],
      adjudicate: ["review"],
      reconcile: ["adjudicate"],
      "post-review": ["review"],
    };
    const declaredEdges = def.phases.filter((p) => p.depends_on?.length);
    expect(declaredEdges).toHaveLength(DECLARED.length - 1);

    const dag = buildDag(def.phases, { chainIfNoDeps: true });
    // Exactly one root, and it is the first declared phase.
    expect(dag.filter((n) => n.depends_on.length === 0).map((n) => n.name)).toEqual(["prepare"]);
    expect(Object.fromEntries(dag.map((n) => [n.name, n.depends_on]))).toEqual(expected);
  });

  it("gives every phase downstream of a skippable one `all_done`, and post-review `all_success`", () => {
    // A skipped node is not `succeeded`, so the default `all_success` would
    // cascade the seven analysis skips straight through `review` — i.e. the
    // inert configuration would post no review at all. `all_done` is the rule
    // the schema names for exactly this.
    const byName = new Map(def.phases.map((p) => [p.name, p]));
    const allDone = ["facts", "seed", "survey", "falsify", "review", "reconcile"];
    for (const name of allDone) {
      expect(byName.get(name)?.trigger_rule, `${name}.trigger_rule`).toBe("all_done");
    }
    // post-review is deliberately the other way: a FAILED review must not post.
    expect(byName.get("post-review")?.trigger_rule).toBeUndefined();
    expect(byName.get("post-review")?.depends_on).toEqual(["review"]);
    // `adjudicate` too, and for the mirror-image reason: there is nothing worth
    // adjudicating about a review that failed.
    expect(byName.get("adjudicate")?.trigger_rule).toBeUndefined();
    // …but `reconcile` is `all_done`, because a cut-short adjudicator is
    // exactly when the conservation floor has work to do.
    expect(byName.get("reconcile")?.trigger_rule).toBe("all_done");
  });

  it("guards WP3's phases on `analysisEnabled`, WP4's on `probesEnabled`, and neither legacy phase", () => {
    const byName = new Map(def.phases.map((p) => [p.name, p]));
    for (const name of WP3_PHASES) {
      expect(phaseSkipIfExpressions(byName.get(name)!), `${name}.skip_if`).toEqual([
        "analysisEnabled != true",
      ]);
    }
    // Two switches, not one. `prepare` is the phase that puts a `node_modules`
    // in the review workspace — it costs the operator disk and memory in a
    // LATER phase, and it runs a pull request author's dependency tree — so a
    // deployment that opted into the surveys has not thereby opted into it.
    // `falsify` then EXECUTES things in that tree. Both carry BOTH expressions,
    // so probes cannot run without the pipeline even if the projection that
    // pairs them is ever changed.
    for (const name of WP4_PHASES) {
      expect(phaseSkipIfExpressions(byName.get(name)!), `${name}.skip_if`).toEqual([
        "analysisEnabled != true",
        "probesEnabled != true",
      ]);
    }
    // WP6's two ride the pipeline switch alone: they neither install anything
    // nor execute anything from the PR, so `probesEnabled` is not their gate.
    for (const name of WP6_PHASES) {
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

  it("skips every analysis phase and still runs BOTH legacy phases", () => {
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

  it("runs WP3's phases with probes still off — the two switches are independent", () => {
    // The shipping shape of WP4: the pipeline on, probes off. `prepare` skips
    // and everything downstream still runs, because `facts` takes `all_done`.
    const { ran, skipped } = simulate(def.phases, { analysisEnabled: "true" });
    expect(ran).toEqual(DECLARED.filter((n) => !WP4_PHASES.includes(n)));
    expect(skipped.map((s) => s.name)).toEqual(WP4_PHASES);
  });

  it("runs all nine in declaration order once both flags are on", () => {
    const { ran, skipped } = simulate(def.phases, { analysisEnabled: "true", probesEnabled: "true" });
    expect(ran).toEqual(DECLARED);
    expect(skipped).toEqual([]);
  });

  it("never runs WP4 on probes alone — an install with nothing to feed is pure cost", () => {
    const { ran } = simulate(def.phases, { probesEnabled: "true" });
    expect(ran).toEqual([...LEGACY_PHASES]);
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
    // …and the two spellings that legitimately mean yes do enable it. Both keys
    // together, because `prepare` requires both and the sweep below pins that
    // `probesEnabled` reads through the same coercion.
    for (const value of ["true", "TRUE", "1", true]) {
      const { ran } = simulate(def.phases, { analysisEnabled: value, probesEnabled: value });
      expect(ran, `both=${JSON.stringify(value)}`).toEqual(DECLARED);
    }
  });

  it("applies the same coercion to `probesEnabled`, with the pipeline already on", () => {
    for (const value of ["false", "", "0", "no", "TRUE-ish"]) {
      const { ran } = simulate(def.phases, { analysisEnabled: "true", probesEnabled: value });
      expect(ran, `probesEnabled=${JSON.stringify(value)}`).toEqual(
        DECLARED.filter((n) => !WP4_PHASES.includes(n)),
      );
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
 */
class RecordingFanout implements PhaseTypeHandler {
  constructor(private readonly agent: FakeAgentPort) {}
  async execute(phase: PhaseDefinition): Promise<PhaseOutcome> {
    const results = [];
    for (const branch of phase.branches ?? []) {
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

async function runPrReview(ctx: Record<string, unknown>, agentPort?: FakeAgentPort) {
  const def = getWorkflow("pr-review");
  const store = new InMemoryStateStore(RUN_ID);
  const reporter = new RecordingReporter();
  const agent =
    agentPort ?? new FakeAgentPort({ success: true, output: "reviewed", turns: 1, durationMs: 0 });
  const postReview = new RecordingPostReview();
  const fanout = new RecordingFanout(agent);

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
      handlers: new Map<string, PhaseTypeHandler>([
        ["post-review", postReview],
        ["fanout", fanout],
      ]),
    },
    store,
    reporterActive: false,
    capabilities: { qaImageAvailable: () => false, qaImageName: "lastlight-sandbox-qa:latest" },
  };

  const result = await runWorkflowCore(runScope, deps);
  return { result, reporter, agent, store, postReview, fanout };
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

    // ONE model call — the `review` phase. Not thirteen. The four bash phases
    // never ran either, so `runCommand` was never reached.
    expect(agent.calls.filter((c) => c.kind === "agent")).toHaveLength(1);
    expect(agent.calls.filter((c) => c.kind === "command")).toHaveLength(0);
    // …and the review really was posted.
    expect(postReview.calls).toEqual(["post-review"]);
  });

  it("records all nine phases — seven skipped, two done — so the dashboard is not silent", async () => {
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

  it("runs every phase once both flags are on — the pipeline is wired, not decorative", async () => {
    const { result, agent, postReview } = await runPrReview({
      owner: "acme",
      repo: "widgets",
      prNumber: 7,
      analysisEnabled: "true",
      probesEnabled: "true",
    });

    // A node with sub-units reports under the sub-unit's label, never its own
    // name — generic loops under `<phase>_iter_N`, fan-out branches under
    // `<phase>_branch_<name>` — so the six phases with no sub-units report
    // under their own names and everything else appears as its sub-units.
    const seen = result.phases.map((p) => p.phase);
    expect(seen.filter((n) => DECLARED.includes(n))).toEqual([
      "prepare",
      "facts",
      "seed",
      "review",
      "reconcile",
      "post-review",
    ]);
    // `adjudicate` is a generic_loop, so it reports under its iteration label
    // rather than its own name.
    expect(seen).toContain("adjudicate_iter_1");
    // The five families are BRANCHES of one node (WP11c), so they report
    // under `<phase>_branch_<name>` — the same "a node with sub-units reports
    // under the sub-unit's label" rule the loops follow, which is what keeps the
    // dashboard's longest-prefix grouping nesting them under `survey`. No
    // `survey_branch_tests`: the branch was removed along with the family's
    // sixth of the fan-out spend.
    for (const family of FAMILIES) {
      expect(seen, family).toContain(`survey_branch_${family}`);
    }
    expect(seen).not.toContain("survey");
    expect(seen).not.toContain("survey_branch_tests");
    // `falsify` is a generic_loop too, so it reports under its iteration label.
    expect(seen).toContain("falsify_iter_1");
    expect(result.phases.every((p) => p.success)).toBe(true);

    // Four deterministic bash phases + seven `until_bash` gates (five branch
    // gates + the falsify and adjudicate loops).
    expect(agent.calls.filter((c) => c.kind === "command").length).toBeGreaterThanOrEqual(4);
    // Five survey passes + the oracle + the review + the adjudicator.
    expect(agent.calls.filter((c) => c.kind === "agent")).toHaveLength(8);
  });

  it("posts the review even when the ADJUDICATOR hard-fails — the money property", async () => {
    // The failure mode this placement exists to prevent, and it is a spend
    // loop rather than a cosmetic one. `assessedHeadShaByWorkflow` is populated
    // from SUCCEEDED runs only, so a red run leaves no trace — and if a failing
    // `adjudicate` could stop `post-review`, nothing would be posted either, so
    // `botReviewAtHead` would stay null too. With BOTH per-head dedups blank,
    // `cron-review.yaml`'s thirty-minute sweep re-dispatches the same SHA and
    // pays for the whole pipeline — including the strong-model review — every
    // half hour, forever. That exact shape cost real money once already.
    //
    // Because `post-review` hangs off `review` and not off `adjudicate`, and
    // because the scheduler CONTINUES past a failed node rather than aborting,
    // the review is still posted. The run goes red; the PR is still reviewed;
    // the next dispatch skips on `already-reviewed`.
    const { result, postReview } = await runPrReview(
      { owner: "acme", repo: "widgets", prNumber: 7, analysisEnabled: "true", probesEnabled: "true" },
      new FailOnePromptAgent("review-adjudicate.md"),
    );

    expect(postReview.calls).toEqual(["post-review"]);
    // …and it is honestly reported as a failed RUN, not quietly swallowed.
    expect(result.success).toBe(false);
    const adjudicateResults = result.phases.filter((p) => p.phase.startsWith("adjudicate"));
    expect(adjudicateResults.some((p) => !p.success)).toBe(true);
  });

  it("still runs the conservation floor after a failed adjudicator", async () => {
    // `reconcile` is `all_done` precisely so that a cut-short adjudicator is
    // repaired rather than left with hypotheses unaccounted for.
    const { result, postReview } = await runPrReview(
      { owner: "acme", repo: "widgets", prNumber: 7, analysisEnabled: "true", probesEnabled: "true" },
      new FailOnePromptAgent("review-adjudicate.md"),
    );
    expect(result.phases.map((p) => p.phase)).toContain("reconcile");
    // …and the floor runs BEFORE the post, so what gets posted is the repaired
    // document rather than whatever the failed adjudicator left behind.
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
    expect(depends_on).toEqual(["falsify"]);
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

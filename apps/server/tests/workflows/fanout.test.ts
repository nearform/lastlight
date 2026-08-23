import { describe, it, expect } from "vitest";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AgentWorkflowSchema, PhaseRef } from "lastlight-workflow-engine";
import type {
  AssetLoader,
  DagNode,
  ExecutorConfig,
  GitSandboxAccess,
  PhaseDefinition,
  PhaseResolver,
  PhaseResult,
  TemplateContext,
} from "lastlight-workflow-engine";
import {
  InMemoryStateStore,
  RecordingReporter,
  noopLiveness,
  noopObservability,
} from "lastlight-workflow-engine/test-support";
import { FakeSandbox } from "#src/sandbox/sandbox.js";
import type {
  PrePopulateSpec,
  ProvisionResult,
  RunAgentOpts,
  RunResult,
  SandboxEvent,
} from "#src/sandbox/sandbox.js";
import {
  BRANCH_CONTEXT_HEADING,
  makeFanoutHandler,
  type FanoutRunScope,
} from "#src/workflows/handlers/fanout.js";
import type { SandboxBackend } from "#src/config/config.js";

/**
 * WP11c — the `type: fanout` phase.
 *
 * The property under test is the one that makes the fan-out safe at all, and it
 * is a COUNTING property: N agent turns, ONE provision, ONE dispose. Every hard
 * blocker in `docs/plans/review-evidence-pipeline/05-parallel-phases.md` — B1
 * (one workspace), D1/D2 (concurrent `git fetch` into one `.git`), D3 (two
 * artifact harvests racing) — is a consequence of provisioning per unit of work.
 * So `provisionCalls === 1` is not a detail of this implementation; it is the
 * whole argument for shipping a fan-out while WP5 stays parked.
 */

const RUN_ID = "run-fanout";

/**
 * A `FakeSandbox` that records EVERY call rather than only the last, and can be
 * told to fail or stall individual branches.
 *
 * `FakeSandbox` keeps one `receivedAgentOpts`; a fan-out needs the tally and the
 * interleaving, which is exactly what it cannot show.
 */
class CountingSandbox extends FakeSandbox {
  readonly agentPrompts: string[] = [];
  readonly agentSkillKeys: string[] = [];
  readonly commands: string[] = [];
  /** Peak simultaneous `runAgent` calls — the concurrency actually achieved. */
  peakInFlight = 0;
  private inFlight = 0;

  constructor(
    private readonly opts: {
      /** Prompt substring → the failure to throw for that branch. */
      failOn?: Record<string, string>;
      /** Prompt substring → ms to stall, so overlap is observable. */
      delayOn?: Record<string, number>;
      commandExit?: number;
    } = {},
  ) {
    // A real terminal RunResult: without one the accumulator sees no events,
    // `reclassifySuccess` demotes the empty completion to the soft `unknown`,
    // and every branch would look like a degenerate turn — which is a different
    // test from this one.
    // A real terminal RunResult (`ok` + `agentEnded` + non-empty `finalText`)
    // is what `mapStopReason` reads as "success". Without one the accumulator
    // sees no events, `reclassifySuccess` demotes the empty completion to the
    // soft `unknown`, and every branch looks like a degenerate turn — a
    // different test from this one.
    super({
      returnRunResult: {
        ok: true,
        exitCode: 0,
        agentEnded: true,
        finalText: "surveyed",
        toolErrors: false,
      } as unknown as RunResult,
    });
  }

  override async runAgent(
    taskId: string,
    prompt: string,
    opts: RunAgentOpts,
    onEvent: (record: SandboxEvent) => void,
  ): Promise<RunResult | undefined> {
    this.inFlight += 1;
    this.peakInFlight = Math.max(this.peakInFlight, this.inFlight);
    this.agentPrompts.push(prompt);
    // The skill-bundle key is `telemetry.phaseName`, and its per-branch
    // distinctness is what stops two concurrent branches staging into the same
    // `.lastlight-skills/<key>/` directory.
    this.agentSkillKeys.push(opts.skillDirs?.join(",") ?? "");
    try {
      const delay = Object.entries(this.opts.delayOn ?? {}).find(([k]) => prompt.includes(k))?.[1];
      if (delay) await new Promise((r) => setTimeout(r, delay));
      const fail = Object.entries(this.opts.failOn ?? {}).find(([k]) => prompt.includes(k))?.[1];
      if (fail) throw new Error(fail);
      return await super.runAgent(taskId, prompt, opts, onEvent);
    } finally {
      this.inFlight -= 1;
    }
  }

  override async runCommand(taskId: string, command: string, opts: never) {
    this.commands.push(command);
    const res = await super.runCommand(taskId, command, opts);
    return this.opts.commandExit === undefined ? res : { ...res, exitCode: this.opts.commandExit };
  }
}

const assets: AssetLoader = {
  loadPromptTemplate: (p) => `TEMPLATE:${p}`,
  resolveSkillPaths: (names) => names.map((n) => `/skills/${n}`),
};

const resolver: PhaseResolver = {
  modelFor: () => undefined,
  variantFor: () => undefined,
  renderPrompt: (p) => `PROMPT:${p}`,
  gateEnabled: () => false,
};

function fanoutPhase(over: Record<string, unknown> = {}): PhaseDefinition {
  return AgentWorkflowSchema.parse({
    name: "wf",
    phases: [
      {
        name: "survey",
        type: "fanout",
        skills: ["pr-review"],
        model: "anthropic/claude-haiku-4-5-20251001",
        branches: [
          { name: "contract", prompt: "prompts/a.md", until_bash: "test -s a.jsonl" },
          { name: "enforcement", prompt: "prompts/b.md", until_bash: "test -s b.jsonl" },
          { name: "security", prompt: "prompts/c.md", skills: ["pr-review", "security-review"] },
        ],
        ...over,
      },
    ],
  }).phases[0];
}

/**
 * Records the phase WINDOWS — which labels opened and closed, and in what order.
 *
 * `RecordingReporter.onStart` takes no arguments and records nothing, which is
 * precisely why the regression below was invisible: the shared fake cannot see
 * the hook whose absence dropped 61% of a case's cost.
 */
class WindowReporter extends RecordingReporter {
  readonly opened: string[] = [];
  readonly closed: string[] = [];

  override async onStart(phase: string): Promise<void> {
    this.opened.push(phase);
  }
  override async onEnd(phase: string, result: PhaseResult): Promise<void> {
    this.closed.push(phase);
    await super.onEnd(phase, result);
  }
}

async function runFanout(
  phase: PhaseDefinition,
  sandbox: CountingSandbox,
  backend: SandboxBackend = "none",
  store?: InMemoryStateStore,
  reporter: RecordingReporter = new RecordingReporter(),
) {
  const config = {
    sandbox: backend,
    stateDir: "/tmp/fanout-test",
    model: "anthropic/claude-haiku-4-5-20251001",
    // The EVAL harness's layout, and the one every measured artifact-path bug
    // has lived in: the checkout is a SUBDIR of the workspace, so the agent's
    // cwd sits one level below the root the skill bundle is staged into.
    repoSubdir: "widgets",
  } as unknown as ExecutorConfig;

  const scope: FanoutRunScope = {
    workflowName: "pr-review",
    ctx: { owner: "acme", repo: "widgets" } as unknown as TemplateContext,
    config,
    taskId: "task-1",
    triggerId: "acme/widgets#7",
    githubAccess: { owner: "acme", repo: "widgets", profile: "review-write" } as GitSandboxAccess,
    backend,
    assets,
    resolver,
    store,
    workflowId: store ? RUN_ID : undefined,
    ledger: { liveness: noopLiveness, observability: noopObservability },
    observeResult: (r) => r,
    observeError: (err) => {
      throw err;
    },
    sandboxFactory: sandbox.asFactory(),
  };
  const handler = makeFanoutHandler(scope, reporter);
  const node = { name: phase.name, depends_on: [], status: "running" } as unknown as DagNode;
  const outcome = await handler.execute(phase, node, {});
  return { outcome, reporter };
}

describe("fanout — per-branch phase windows", () => {
  /**
   * The regression this exists to stop, WP11a × WP11c.
   *
   * `onStart`/`onEnd` are pass-throughs to the caller's `onPhaseStart` /
   * `onPhaseEnd` (`runner.ts`) and no-ops when nobody supplies them, so nothing
   * in production notices their absence. The evals harness DOES supply them, and
   * uses them as the only evidence a phase ran: it measures each window and
   * attributes session cost to it. A fan-out that opened one window for `survey`
   * while reporting six `survey_branch_*` ROWS produced six rows with no window
   * — and the consumer's rule is "no window means the phase never started", so
   * it rendered the biggest win in the work package as if it had been skipped.
   * 242 s and $1.23 of a $2.01 case vanished.
   *
   * Six branches means six OVERLAPPING windows; that is the point, and a
   * consumer that assumes windows nest or abut is wrong about this phase type.
   */
  it("opens and closes a window per branch, under the branch's own label", async () => {
    const sandbox = new CountingSandbox();
    const reporter = new WindowReporter();
    await runFanout(fanoutPhase(), sandbox, "none", undefined, reporter);

    for (const branch of ["contract", "enforcement", "security"]) {
      expect(reporter.opened).toContain(`survey_branch_${branch}`);
      expect(reporter.closed).toContain(`survey_branch_${branch}`);
    }
    // The parent still reports too — a consumer may prefer the aggregate.
    expect(reporter.opened).toContain("survey");
    expect(reporter.closed).toContain("survey");
    // Every window that opened, closed. An unclosed window is indistinguishable
    // from one that never opened.
    expect([...reporter.closed].sort()).toEqual([...reporter.opened].sort());
  });

  it("still opens and closes the window of a branch that FAILED", async () => {
    // A failed branch that reports no window is worse than one that reports a
    // failure: absent metrics read as "skipped", so a branch that burned four
    // minutes and crashed would look like it never ran.
    const sandbox = new CountingSandbox({ failOn: { "prompts/a.md": "boom" } });
    const reporter = new WindowReporter();
    await runFanout(fanoutPhase(), sandbox, "none", undefined, reporter);

    expect(reporter.opened).toContain("survey_branch_contract");
    expect(reporter.closed).toContain("survey_branch_contract");
    expect([...reporter.closed].sort()).toEqual([...reporter.opened].sort());
  });
});

describe("fanout — one workspace, N turns", () => {
  it("provisions ONCE, runs one agent turn per branch, and disposes ONCE", async () => {
    const sandbox = new CountingSandbox();
    const { outcome } = await runFanout(fanoutPhase(), sandbox);

    // The counting property. Three branches, one clone.
    expect(sandbox.provisionCalls).toBe(1);
    expect(sandbox.agentPrompts).toHaveLength(3);
    expect(sandbox.disposed).toBe(true);
    expect(outcome.status).toBe("succeeded");
  });

  it("reports branches in DECLARATION order however they interleave", async () => {
    // The first branch is slowest, so completion order is the reverse of
    // declaration order. A fan-out that reported in completion order would make
    // two runs of the same case diff against each other for no reason.
    const sandbox = new CountingSandbox({ delayOn: { "prompts/a.md": 30 } });
    const { outcome } = await runFanout(fanoutPhase(), sandbox);

    expect(outcome.results.map((r) => r.phase)).toEqual([
      "survey_branch_contract",
      "survey_branch_enforcement",
      "survey_branch_security",
    ]);
  });

  it("actually overlaps the turns on a backend that permits it", async () => {
    const sandbox = new CountingSandbox({ delayOn: { "prompts/": 25 } });
    await runFanout(fanoutPhase(), sandbox, "none");
    expect(sandbox.peakInFlight).toBeGreaterThan(1);
  });

  it("gives each branch its OWN skill bundle, and honours a branch skill override", async () => {
    const sandbox = new CountingSandbox();
    await runFanout(fanoutPhase(), sandbox);

    // Three distinct bundles: two concurrent branches staging into one directory
    // is the collision the per-phase key was invented for, and a fan-out is the
    // first thing that could actually hit it.
    expect(new Set(sandbox.agentSkillKeys).size).toBe(3);
    // …and `security`'s extra skill really reached it.
    expect(sandbox.agentSkillKeys.some((k) => k.includes("security-review"))).toBe(true);
    expect(sandbox.agentSkillKeys.filter((k) => k.includes("security-review"))).toHaveLength(1);
  });

  it("runs each branch's until_bash gate AFTER the join, once each", async () => {
    const sandbox = new CountingSandbox();
    await runFanout(fanoutPhase(), sandbox);

    // Two branches declare a gate; the third does not.
    expect(sandbox.commands).toEqual(["test -s a.jsonl", "test -s b.jsonl"]);
  });
});

describe("fanout — the backend ceiling", () => {
  it("clamps gondolin to one in-flight session", async () => {
    // Each session is a QEMU micro-VM in the harness process (WP5's D7), and the
    // nearform host has no swap. Sequential here is not a degradation — it is
    // byte-identical to the six chained phases this replaced.
    const sandbox = new CountingSandbox({ delayOn: { "prompts/": 15 } });
    const { outcome } = await runFanout(fanoutPhase(), sandbox, "gondolin");

    expect(sandbox.peakInFlight).toBe(1);
    expect(sandbox.agentPrompts).toHaveLength(3);
    expect(outcome.status).toBe("succeeded");
  });

  it("honours an explicit max_concurrent below the backend ceiling", async () => {
    const sandbox = new CountingSandbox({ delayOn: { "prompts/": 20 } });
    await runFanout(fanoutPhase({ max_concurrent: 2 }), sandbox, "none");
    expect(sandbox.peakInFlight).toBe(2);
  });
});

describe("fanout — failure is per branch, not per phase", () => {
  it("keeps the other branches' work when one branch hard-fails", async () => {
    const sandbox = new CountingSandbox({ failOn: { "prompts/b.md": "boom" } });
    const { outcome } = await runFanout(fanoutPhase(), sandbox);

    // This is what `all_done` + `on_soft_failure: complete` bought the six
    // chained phases, and the fan-out has to reproduce it: one degenerate
    // family must not discard the other five. A run that hard-failed here would
    // record no `assessedHeadShaByWorkflow` and hand cron-review.yaml something
    // to re-dispatch every thirty minutes, forever.
    expect(outcome.status).toBe("succeeded");
    const byPhase = new Map(outcome.results.map((r) => [r.phase, r]));
    expect(byPhase.get("survey_branch_enforcement")?.success).toBe(false);
    expect(byPhase.get("survey_branch_contract")?.success).toBe(true);
    expect(byPhase.get("survey_branch_security")?.success).toBe(true);
    // All three still ran — a failure does not cancel its siblings.
    expect(sandbox.agentPrompts).toHaveLength(3);
  });

  it("fails the phase only when EVERY branch failed", async () => {
    const sandbox = new CountingSandbox({
      failOn: { "prompts/a.md": "boom", "prompts/b.md": "boom", "prompts/c.md": "boom" },
    });
    const { outcome } = await runFanout(fanoutPhase(), sandbox);
    expect(outcome.status).toBe("failed");
  });
});

describe("fanout — the ledger", () => {
  it("writes one executions row per branch, keyed for resume", async () => {
    const store = new InMemoryStateStore(RUN_ID);
    const sandbox = new CountingSandbox();
    await runFanout(fanoutPhase(), sandbox, "none", store);

    // Per-branch rows are what `05-parallel-phases.md` warned an in-agent
    // fan-out would GIVE UP (resume, dedup, cost attribution). Going through the
    // same dedup ledger under a `<phase>_branch_<name>` key is how it doesn't.
    for (const family of ["contract", "enforcement", "security"]) {
      const key = `pr-review:${PhaseRef.branch("survey", family).format()}`;
      expect(await store.executions.shouldRunPhase(key, "acme/widgets#7", RUN_ID), key).toBe("done");
    }
  });

  it("skips a branch whose row is already done — a resumed fan-out re-pays for nothing", async () => {
    const store = new InMemoryStateStore(RUN_ID);
    const first = new CountingSandbox();
    await runFanout(fanoutPhase(), first, "none", store);

    const second = new CountingSandbox();
    const { outcome } = await runFanout(fanoutPhase(), second, "none", store);

    expect(second.agentPrompts).toEqual([]);
    expect(outcome.status).toBe("succeeded");
  });
});

describe("fanout — the schema refuses what the shape cannot support", () => {
  const parse = (phase: Record<string, unknown>) =>
    AgentWorkflowSchema.safeParse({ name: "wf", phases: [phase] });

  const base = {
    name: "survey",
    type: "fanout",
    skills: ["pr-review"],
    branches: [{ name: "a", prompt: "prompts/a.md" }],
  };

  it("refuses an approval gate — a fan-out cannot pause mid-flight", () => {
    // WP5's B2, the item its own doc calls the worst on the list: the scheduler
    // returns immediately on `paused`, and under N in-flight sessions a sibling
    // finishing afterwards flips the run to `succeeded` over the top of `paused`
    // and orphans the `workflow_approvals` row. Refusing the combination is how
    // a fan-out never meets it.
    const r = parse({ ...base, approval_gate: "post_survey" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain("cannot pause mid-flight");
  });

  it("refuses a loop on top of the branches", () => {
    expect(parse({ ...base, generic_loop: { max_iterations: 2, until_bash: "true" } }).success).toBe(false);
  });

  it("refuses duplicate branch names — they are ledger keys", () => {
    const r = parse({
      ...base,
      branches: [
        { name: "a", prompt: "p.md" },
        { name: "a", prompt: "q.md" },
      ],
    });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toContain("unique");
  });

  it("refuses an underscore in a branch name — PhaseRef could not split it back", () => {
    expect(parse({ ...base, branches: [{ name: "my_family", prompt: "p.md" }] }).success).toBe(false);
  });

  it("refuses `branches:` on a phase that is not a fanout", () => {
    expect(parse({ ...base, type: "agent" }).success).toBe(false);
  });

  it("refuses a branch that can build no prompt", () => {
    const r = parse({ name: "survey", type: "fanout", branches: [{ name: "a" }] });
    expect(r.success).toBe(false);
  });
});

// ── `context_file` — the obligations reach the pass, or its absence is loud ───

/**
 * The defect this whole section exists to close, measured rather than inferred.
 *
 * Across the three stored `pr-review` runs of 2026-08-22
 * (`2026-08-22_{184650,194234,201607}`), 120 non-spec survey branches made 133
 * attempts to open their family's obligations block. **Every one of the 98
 * relative reads succeeded and every one of the 27 workspace-root ABSOLUTE
 * reads failed with ENOENT** — 23 branches never recovered and free-styled off
 * the diff instead, because the prompt's own escape hatch told them to. Neither
 * base is wrong; having two is. The model's only absolute anchor by its first
 * turn is its skill bundle at `<workspaceRoot>/.lastlight-skills/…`, one level
 * ABOVE the checkout the deterministic phases write in.
 *
 * `context_file` removes the resolution from the model: the harness reads the
 * file at `hostAgentCwd` — the host end of the very `cwd` a `type: bash` phase
 * runs in — and appends the bytes. What is asserted below is exactly that, plus
 * the property that makes it safe to ship: an unreadable file appends a LOUD
 * notice, never silence.
 */
class SeedingSandbox extends CountingSandbox {
  hostAgentCwd = "";
  constructor(private readonly seeds: Record<string, string> = {}) {
    super();
  }
  override async provision(pre?: PrePopulateSpec): Promise<ProvisionResult> {
    const prov = await super.provision(pre);
    this.hostAgentCwd = prov.hostAgentCwd;
    for (const [rel, body] of Object.entries(this.seeds)) {
      const abs = join(prov.hostAgentCwd, rel);
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, body);
    }
    return prov;
  }
}

const seededPhase = (contextFile: string): PhaseDefinition =>
  AgentWorkflowSchema.parse({
    name: "wf",
    phases: [
      {
        name: "survey",
        type: "fanout",
        skills: ["pr-review"],
        branches: [{ name: "enforcement", prompt: "prompts/b.md", context_file: contextFile }],
      },
    ],
  }).phases[0];

const OBLIGATIONS = ".lastlight/pr-review/obligations/enforcement.md";
const BLOCK = "=== ENFORCEMENT ===\n\nO-002  [enforcement]  expects: quote\n";

describe("fanout — `context_file` puts the seed IN the prompt", () => {
  it("appends the file's bytes, so no path is left for the model to resolve", async () => {
    const sandbox = new SeedingSandbox({ [OBLIGATIONS]: BLOCK });
    await runFanout(seededPhase(OBLIGATIONS), sandbox);

    // The base is the CHECKOUT, not the workspace root, and that one level is
    // the entire defect: the skill bundle lives at the root, so a model joining
    // this relative path onto the directory its skills came from misses by
    // exactly this much. `hostAgentCwd` is computed beside `agentCwd` in each
    // adapter, so the file the harness reads is the file a `type: bash` phase's
    // shell wrote.
    expect(sandbox.hostAgentCwd).not.toBe(sandbox.hostWorkspaceDir);
    expect(existsSync(join(sandbox.hostWorkspaceDir, OBLIGATIONS))).toBe(false);

    expect(sandbox.agentPrompts).toHaveLength(1);
    const prompt = sandbox.agentPrompts[0];
    expect(prompt).toContain(BRANCH_CONTEXT_HEADING);
    expect(prompt).toContain("O-002  [enforcement]  expects: quote");
    expect(prompt).not.toContain("NOT AVAILABLE");
    // …and it says so, because a model that re-opens the file is a model that
    // can still resolve the path against the wrong base.
    expect(prompt).toContain("do not open it, and do not construct a path to it");
  });

  it("puts it LAST — §D4's prompt-cache ordering is what makes six branches cheap", () => {
    // The shared prefix (skills, AGENTS.md, the diff summary) must stay
    // byte-identical across the branches; everything family-specific comes
    // after it. The attached block is the most family-specific thing there is.
    const sandbox = new SeedingSandbox({ [OBLIGATIONS]: BLOCK });
    return runFanout(seededPhase(OBLIGATIONS), sandbox).then(() => {
      const prompt = sandbox.agentPrompts[0];
      expect(prompt.indexOf(BRANCH_CONTEXT_HEADING)).toBeGreaterThan(prompt.indexOf("PROMPT:"));
      expect(prompt.trimEnd().endsWith("O-002  [enforcement]  expects: quote")).toBe(true);
    });
  });

  it("appends a LOUD notice when the file is missing, and still runs the branch", async () => {
    // The silent version of this is the whole bug: a lost seed used to be
    // indistinguishable from a family with genuinely nothing to check, so a
    // seeded pass became an unseeded one with nothing recording that it had.
    const sandbox = new SeedingSandbox();
    const { outcome } = await runFanout(seededPhase(OBLIGATIONS), sandbox);

    const prompt = sandbox.agentPrompts[0];
    expect(prompt).toContain("NOT AVAILABLE");
    expect(prompt).toContain(OBLIGATIONS);
    expect(prompt).toContain("NOT_SEEDED");
    // `NOT_SEEDED` ≠ `NOT_MEASURED`: "its answer never reached you" and "it
    // looked and could not measure this axis" are different facts, and this
    // package's founding invariant is that they never collapse.
    expect(prompt).toContain("`NOT_SEEDED` and `NOT_MEASURED` are DIFFERENT facts");
    // Loud in the prompt, never fatal to the run: a hard-failing phase records
    // no `assessedHeadShaByWorkflow` and cron-review re-dispatches forever.
    expect(outcome.status).toBe("succeeded");
  });

  it("refuses a path that escapes the agent's cwd rather than resolving it", async () => {
    // A `..` or an absolute `context_file` would resolve against something the
    // workflow author did not name — which is the ambiguity this key removes,
    // not a second spelling of it.
    const sandbox = new SeedingSandbox({ [OBLIGATIONS]: BLOCK });
    await runFanout(seededPhase(`../${OBLIGATIONS}`), sandbox);
    const prompt = sandbox.agentPrompts[0];
    expect(prompt).toContain("NOT AVAILABLE");
    expect(prompt).toContain("is not a workspace-relative path");
    expect(prompt).not.toContain("O-002");
  });

  it("hands kubernetes the PATH instead — its workspace is not host-readable", async () => {
    // `hostAgentCwd` is an in-pod path there, the same caveat `hostWorkspaceDir`
    // already carries. Attempting the read would ENOENT every time and report
    // "the seeding step failed" for a backend whose workspace this process was
    // never able to see — a worse lie than the one this key removes. So the
    // path goes back in the prompt, with the trap it used to hide named.
    const sandbox = new SeedingSandbox({ [OBLIGATIONS]: BLOCK });
    await runFanout(seededPhase(OBLIGATIONS), sandbox, "kubernetes");
    const prompt = sandbox.agentPrompts[0];
    expect(prompt).toContain(OBLIGATIONS);
    expect(prompt).toContain("Read it RELATIVE, exactly as written");
    expect(prompt).not.toContain("NOT AVAILABLE");
    expect(prompt).not.toContain("O-002");
  });

  it("leaves a branch without `context_file` byte-identical to before", async () => {
    // Every other fan-out in the tree, and the `spec` branch of this one, whose
    // obligations are built harness-side and have no block on disk.
    const sandbox = new SeedingSandbox({ [OBLIGATIONS]: BLOCK });
    await runFanout(fanoutPhase(), sandbox);
    for (const prompt of sandbox.agentPrompts) {
      expect(prompt).not.toContain(BRANCH_CONTEXT_HEADING);
    }
  });
});

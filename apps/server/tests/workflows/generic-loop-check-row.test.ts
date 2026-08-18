import { describe, it, expect } from "vitest";
import { runWorkflowCore, AgentWorkflowSchema } from "lastlight-workflow-engine";
import type {
  AgentWorkflowDefinition,
  CommandSpec,
  ExecutionResult,
  ExecutorConfig,
  GitSandboxAccess,
  PhaseHistoryEntry,
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
  type FakeExecutionRow,
} from "lastlight-workflow-engine/test-support";

/**
 * The generic loop's `until_bash` exit check, as a first-class recorded step.
 *
 * Prod run `49c101aa` of `dependabot-ci-fix` spent 6m48s of a 20m31s run inside
 * this check — 11:03:58 → 11:10:48 — and NOTHING recorded it: no phase, no
 * `executions` row, no pipeline node, no timer. Worse, the run's own persisted
 * state lied for the whole window: `currentPhase` still said `diagnose` (a phase
 * that had ended 12 minutes earlier) and `fix_iter_1` was absent from
 * `phaseHistory` although it had finished at 11:03:58, because both the
 * iteration's history entry and its output were withheld until the condition
 * resolved.
 *
 * Two behaviours close that, and these tests pin both:
 *
 *  1. **The iteration is recorded when its WORK finishes**, not when the loop's
 *     exit condition resolves. Everything after the agent turn — the `until`
 *     expression and especially the `until_bash` sandbox command — is the LOOP
 *     asking "are we done?", not the iteration still working.
 *  2. **The check gets its own `executions` row**, opened (`recordStart`) before
 *     the command and finished after. An OPEN row with a start time is exactly
 *     how every renderer in the system draws "in flight, since N" — so the
 *     regression guarded here is specifically that the row exists and is
 *     UNFINISHED *while the command is running*, not merely that it exists
 *     afterwards.
 *
 * `success` on that row answers "did the check RUN", never "what did it say":
 * a red gate is the loop working as designed (it is what earns the agent another
 * iteration) and must not paint the phase red. The verdict lives in
 * `stopReason` — `condition_met` / `condition_not_met`.
 *
 * Everything here drives the real engine through the in-memory port fakes: no
 * sqlite, no docker, no git.
 */

const RUN_ID = "run-1";
const TRIGGER = "acme/widgets#7";
const WF = "fix-flow";

const GATE_CMD = "bash .git/lastlight-verify.sh";

/** The three `generic_loop` shapes that exist in the packaged workflows. */
type LoopShape = Record<string, unknown>;

/** `pr-fix` / `dependabot-ci-fix`: an `until:` short-circuit over a bash gate. */
const FIX_FAMILY_LOOP: LoopShape = {
  max_iterations: 2,
  until: "output.contains('outcome=pushed tried=')",
  until_bash: GATE_CMD,
  fresh_context: false,
};

function defineLoop(loop: LoopShape, phaseName = "fix"): AgentWorkflowDefinition {
  return AgentWorkflowSchema.parse({
    name: WF,
    phases: [{ name: phaseName, prompt: "prompts/fix.md", generic_loop: loop }],
  });
}

const agentOk = (output: string): ExecutionResult => ({
  success: true,
  output,
  turns: 3,
  durationMs: 10,
});
/** Gate green: exit 0. */
const gateGreen: ExecutionResult = { success: true, output: "all tests pass", turns: 0, durationMs: 5 };
/** Gate red: non-zero exit. The loop's normal, designed-for outcome. */
const gateRed: ExecutionResult = { success: false, output: "1 failing", turns: 0, durationMs: 5 };

/** What a probe saw at the instant the Nth `until_bash` command started. */
interface CheckProbe {
  /** `phase_history` phases, oldest first, as persisted at that instant. */
  history: string[];
  /** Every `executions` row for `<phase>_iter_N_check`, at that instant. */
  checkRows: FakeExecutionRow[];
}

/**
 * A {@link FakeAgentPort} with independent queues for the two surfaces the loop
 * uses: `runAgent` per iteration, `runCommand` for the `until_bash` gate. The
 * base fake's single FIFO can't express "iteration, gate, iteration, gate"
 * without the test having to interleave by hand, which hides which call is which.
 *
 * `onCheck` fires INSIDE `runCommand`, before it returns — i.e. while the gate is
 * genuinely in flight — which is the only moment the open row can be observed.
 */
class LoopAgentPort extends FakeAgentPort {
  readonly prompts: string[] = [];
  readonly commands: string[] = [];

  constructor(
    private readonly iterations: ExecutionResult[],
    private readonly gates: ExecutionResult[],
    private readonly onCheck?: (nth: number) => void,
  ) {
    super();
  }

  override async runAgent(prompt: string, config: ExecutorConfig, opts: never): Promise<ExecutionResult> {
    this.prompts.push(prompt);
    this.calls.push({ kind: "agent", prompt, config, opts });
    return this.iterations.shift() ?? agentOk("(unscripted iteration)");
  }

  override async runCommand(spec: CommandSpec, config: ExecutorConfig, opts: never): Promise<ExecutionResult> {
    this.commands.push(spec.kind === "bash" ? spec.command : spec.name);
    this.calls.push({ kind: "command", spec, config, opts });
    this.onCheck?.(this.commands.length);
    return this.gates.shift() ?? gateRed;
  }
}

/**
 * The reporter production actually runs with: `runner.ts`'s `persistPhase`
 * writes through to `db.runs.appendPhase`. `RecordingReporter` alone only
 * remembers the call, so a test using it could never see the ordering bug —
 * which lives in the persisted row, not in the reporter.
 */
class PersistingReporter extends RecordingReporter {
  constructor(private readonly store: InMemoryStateStore) {
    super();
  }
  override async persistPhase(phase: string, summary?: string): Promise<void> {
    await super.persistPhase(phase, summary);
    const entry: PhaseHistoryEntry = {
      phase,
      timestamp: new Date().toISOString(),
      success: true,
      summary,
    };
    await this.store.runs.appendPhase(RUN_ID, phase, entry);
  }
}

const resolver: PhaseResolver = {
  modelFor: () => undefined,
  variantFor: () => undefined,
  renderPrompt: (p) => `PROMPT:${p}`,
  gateEnabled: () => false,
};

interface RunOpts {
  iterations?: ExecutionResult[];
  gates?: ExecutionResult[];
  /** Called synchronously inside each `until_bash` command, before it returns. */
  onCheck?: (nth: number, store: InMemoryStateStore) => void;
}

async function runLoop(definition: AgentWorkflowDefinition, opts: RunOpts = {}) {
  const store = new InMemoryStateStore(RUN_ID);
  const reporter = new PersistingReporter(store);
  const agent = new LoopAgentPort(
    [...(opts.iterations ?? [])],
    [...(opts.gates ?? [])],
    opts.onCheck ? (nth) => opts.onCheck!(nth, store) : undefined,
  );

  const runScope: PhaseRunContext = {
    definition,
    ctx: { prNumber: 7 } as unknown as TemplateContext,
    config: { sandbox: "none" } as unknown as ExecutorConfig,
    taskId: "task-1",
    triggerId: TRIGGER,
    githubAccess: { owner: "acme", repo: "widgets", profile: "repo-write" } as GitSandboxAccess,
    scratch: { ...((await store.runs.getRun(RUN_ID))?.scratch ?? {}) },
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
  return { result, store, agent, reporter };
}

/** Phase labels in `phase_history`, oldest first. */
const historyPhases = (store: InMemoryStateStore) =>
  store.phaseHistory(RUN_ID).map((h) => h.phase);

/** `{phase, summary}` pairs, oldest first. */
const historyEntries = (store: InMemoryStateStore) =>
  store.phaseHistory(RUN_ID).map((h) => ({ phase: h.phase, summary: h.summary }));

/** Every ledger row's dedup key, in the order the rows were opened. */
const rowKeys = (store: InMemoryStateStore) => store.executionRows().map((r) => r.dedupKey);

// ── 1. The iteration is recorded when its WORK finishes ──────────────────────

describe("generic loop — the iteration lands in history when its work finishes", () => {
  it("has already persisted `fix_iter_1` by the time the until_bash gate starts", async () => {
    const probes: CheckProbe[] = [];
    await runLoop(defineLoop({ max_iterations: 2, until_bash: GATE_CMD }), {
      iterations: [agentOk("worked on it"), agentOk("worked on it again")],
      gates: [gateRed, gateGreen],
      onCheck: (_nth, store) => {
        probes.push({
          history: historyPhases(store),
          checkRows: [...store.executionRows("fix_iter_1_check")],
        });
      },
    });

    // THE regression: at 11:03:58 the work was done, so the run must say so —
    // rather than advertising a phase that ended 12 minutes earlier.
    expect(probes[0]!.history).toEqual(["fix_iter_1"]);
    // …and by the second gate, iteration 2's work is recorded too.
    expect(probes[1]!.history).toEqual(["fix_iter_1", "fix_iter_2"]);
  });

  it("labels that first entry as the WORK completing, not the loop completing", async () => {
    const { store } = await runLoop(defineLoop({ max_iterations: 2, until_bash: GATE_CMD }), {
      iterations: [agentOk("worked on it")],
      gates: [gateGreen],
    });

    expect(historyEntries(store)[0]).toEqual({
      phase: "fix_iter_1",
      summary: "iteration 1 — work complete",
    });
  });

  it("writes the iteration's output to its ledger row before the gate runs", async () => {
    let outputAtGate: string | undefined;
    await runLoop(defineLoop({ max_iterations: 2, until_bash: GATE_CMD }), {
      iterations: [agentOk("the fix, verbatim")],
      gates: [gateGreen],
      onCheck: (_nth, store) => {
        outputAtGate = store.executionRows("fix_iter_1")[0]?.output;
      },
    });

    expect(outputAtGate).toBe("the fix, verbatim");
  });
});

// ── 2. The check is visible WHILE IT RUNS ────────────────────────────────────

describe("generic loop — the until_bash check is an open execution row in flight", () => {
  it("has a started, unfinished `fix_iter_1_check` row while the command runs", async () => {
    const probes: CheckProbe[] = [];
    await runLoop(defineLoop({ max_iterations: 1, until_bash: GATE_CMD }), {
      iterations: [agentOk("worked on it")],
      gates: [gateRed],
      onCheck: (_nth, store) => {
        probes.push({
          history: historyPhases(store),
          checkRows: [...store.executionRows("fix_iter_1_check")],
        });
      },
    });

    const [row, ...extra] = probes[0]!.checkRows;
    expect(extra).toEqual([]);
    expect(row).toBeDefined();
    // Open + timed: the pair every renderer reads as "in progress, since N".
    // Before the fix there was no row at all, so 6m48s rendered as nothing.
    expect(row!.finished).toBe(false);
    expect(row!.success).toBeUndefined();
    expect(Number.isFinite(Date.parse(row!.startedAt))).toBe(true);
  });

  it("names the row `<workflow>:<phase>_iter_<n>_check` and runs the declared command", async () => {
    const { store, agent } = await runLoop(defineLoop({ max_iterations: 1, until_bash: GATE_CMD }), {
      iterations: [agentOk("worked on it")],
      gates: [gateRed],
    });

    expect(agent.commands).toEqual([GATE_CMD]);
    expect(store.executionRows("fix_iter_1_check")[0]!.dedupKey).toBe(`${WF}:fix_iter_1_check`);
  });

  it("stamps every ledger row with the (owner, BARE repo) pair", async () => {
    // The engine writes what `GitSandboxAccess` already carries — the pair,
    // never a qualified string (issue #279). It used to write only the bare
    // half, leaving the account recoverable solely by joining the owning run,
    // which a `build-cycle` or chat row does not have.
    //
    // The in-memory fake dropped both fields entirely until #279, so no
    // engine-side test could observe this at all.
    const { store } = await runLoop(defineLoop({ max_iterations: 1, until_bash: GATE_CMD }), {
      iterations: [agentOk("worked on it")],
      gates: [gateRed],
    });

    const rows = store.executionRows();
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect([row.owner, row.repo]).toEqual(["acme", "widgets"]);
    }
  });

  it("closes the row with a duration once the command returns", async () => {
    const { store } = await runLoop(defineLoop({ max_iterations: 1, until_bash: GATE_CMD }), {
      iterations: [agentOk("worked on it")],
      gates: [gateRed],
    });

    const row = store.executionRows("fix_iter_1_check")[0]!;
    expect(row.finished).toBe(true);
    expect(typeof row.durationMs).toBe("number");
    // The gate's stdout is the artifact you want when asking "why did this loop
    // keep going" — `writeSession: false` means it is nowhere else.
    expect(row.output).toContain(`$ ${GATE_CMD}`);
    expect(row.output).toContain("1 failing");
  });
});

// ── 3. A red gate is a verdict, not a failure ────────────────────────────────

describe("generic loop — a not-met condition records the verdict and iterates again", () => {
  it("records success=true (the check RAN) with stopReason=condition_not_met", async () => {
    const { store } = await runLoop(defineLoop({ max_iterations: 2, until_bash: GATE_CMD }), {
      iterations: [agentOk("attempt 1"), agentOk("attempt 2")],
      gates: [gateRed, gateGreen],
    });

    const first = store.executionRows("fix_iter_1_check")[0]!;
    // NOT `false`: a red gate is the loop working as designed. `success: false`
    // would paint the phase red in the pipeline and ✗ in the CLI.
    expect(first.success).toBe(true);
    expect(first.stopReason).toBe("condition_not_met");
    expect(first.error).toBeUndefined();
  });

  it("earns the agent another iteration", async () => {
    const { agent, result } = await runLoop(defineLoop({ max_iterations: 2, until_bash: GATE_CMD }), {
      iterations: [agentOk("attempt 1"), agentOk("attempt 2")],
      gates: [gateRed, gateGreen],
    });

    expect(agent.prompts).toHaveLength(2);
    expect(agent.commands).toEqual([GATE_CMD, GATE_CMD]);
    expect(result.success).toBe(true);
  });

  it("records error_fatal — not a verdict — when the gate command itself throws", async () => {
    const store = new InMemoryStateStore(RUN_ID);
    const reporter = new PersistingReporter(store);
    class ThrowingGate extends LoopAgentPort {
      override async runCommand(): Promise<never> {
        throw new Error("sandbox vanished");
      }
    }
    const agent = new ThrowingGate([agentOk("attempt 1")], []);
    const runScope: PhaseRunContext = {
      definition: defineLoop({ max_iterations: 1, until_bash: GATE_CMD }),
      ctx: {} as unknown as TemplateContext,
      config: { sandbox: "none" } as unknown as ExecutorConfig,
      taskId: "task-1",
      triggerId: TRIGGER,
      githubAccess: { owner: "acme", repo: "widgets", profile: "repo-write" } as GitSandboxAccess,
      scratch: {},
      store,
      workflowId: RUN_ID,
      botName: "last-light",
    };
    await runWorkflowCore(runScope, {
      reporter,
      resolver,
      ports: { agent, assets: new StubAssetLoader(), liveness: noopLiveness, observability: noopObservability },
      store,
      reporterActive: false,
      capabilities: { qaImageAvailable: () => false, qaImageName: "lastlight-sandbox-qa:latest" },
    } as SchedulerDeps);

    const row = store.executionRows("fix_iter_1_check")[0]!;
    expect(row.success).toBe(false);
    expect(row.stopReason).toBe("error_fatal");
    expect(row.error).toMatch(/sandbox vanished/);
  });
});

// ── 4. Every iteration and every check is its own row ────────────────────────

describe("generic loop — a multi-iteration loop records each iteration and each check", () => {
  it("opens four distinct rows, interleaved iteration → check → iteration → check", async () => {
    const { store, result } = await runLoop(defineLoop({ max_iterations: 2, until_bash: GATE_CMD }), {
      iterations: [agentOk("attempt 1"), agentOk("attempt 2")],
      gates: [gateRed, gateRed],
    });

    expect(rowKeys(store)).toEqual([
      `${WF}:fix_iter_1`,
      `${WF}:fix_iter_1_check`,
      `${WF}:fix_iter_2`,
      `${WF}:fix_iter_2_check`,
    ]);
    expect(new Set(store.executionRows().map((r) => r.id)).size).toBe(4);
    // Ran out of iterations with the gate still red. Not a crash — the fix
    // family reports `outcome=gave-up` and the run stands.
    expect(result.success).toBe(true);
  });

  it("keeps each iteration's history entry, one per iteration, in order", async () => {
    const { store } = await runLoop(defineLoop({ max_iterations: 3, until_bash: GATE_CMD }), {
      iterations: [agentOk("1"), agentOk("2"), agentOk("3")],
      gates: [gateRed, gateRed, gateRed],
    });

    expect(historyEntries(store)).toEqual([
      { phase: "fix_iter_1", summary: "iteration 1 — work complete" },
      { phase: "fix_iter_2", summary: "iteration 2 — work complete" },
      { phase: "fix_iter_3", summary: "iteration 3 — work complete" },
    ]);
  });

  it("gives the check its own dedup key — it can never satisfy the iteration's", async () => {
    const { store } = await runLoop(defineLoop({ max_iterations: 1, until_bash: GATE_CMD }), {
      iterations: [agentOk("attempt 1")],
      gates: [gateRed],
    });

    // The iteration succeeded, so a resume skips it. The check is a SEPARATE
    // key, so it can neither mark the iteration done nor be mistaken for it —
    // which is why `runUntilBash` may safely bypass `shouldRunPhase` and
    // re-evaluate the condition every time it is asked.
    expect(await store.executions.shouldRunPhase(`${WF}:fix_iter_1`, TRIGGER, RUN_ID)).toBe("done");
    expect(await store.executions.shouldRunPhase(`${WF}:fix`, TRIGGER, RUN_ID)).toBe("run");
    expect(rowKeys(store)).not.toContain(`${WF}:fix`);
  });
});

// ── 5. The terminal "condition met" summary still means what it says ─────────

describe("generic loop — the condition-met entry still marks the loop completing", () => {
  it("appends a second entry for the same label: work complete, then condition met", async () => {
    const { store, agent } = await runLoop(defineLoop({ max_iterations: 2, until_bash: GATE_CMD }), {
      iterations: [agentOk("fixed it")],
      gates: [gateGreen],
    });

    // Two events, deliberately kept apart — the work finished at T1, the loop
    // was declared complete at T2. The gap between them IS the thing that used
    // to be invisible. Every reader folds a repeated label last-wins (the
    // pipeline's history Map, both resume paths' `Set` of names, and
    // `PhaseDetailPanel`'s `.at(-1)`), so the terminal summary is what shows.
    expect(historyEntries(store)).toEqual([
      { phase: "fix_iter_1", summary: "iteration 1 — work complete" },
      { phase: "fix_iter_1", summary: "iteration 1 — condition met" },
    ]);
    expect(store.phaseHistory(RUN_ID).at(-1)!.summary).toBe("iteration 1 — condition met");
    // It really did stop — no second iteration.
    expect(agent.prompts).toHaveLength(1);
  });

  it("records the green gate as condition_met", async () => {
    const { store } = await runLoop(defineLoop({ max_iterations: 2, until_bash: GATE_CMD }), {
      iterations: [agentOk("fixed it")],
      gates: [gateGreen],
    });

    const row = store.executionRows("fix_iter_1_check")[0]!;
    expect(row.success).toBe(true);
    expect(row.stopReason).toBe("condition_met");
  });

  it("a repeated label never confuses the readers that fold it into a Set", async () => {
    const { store } = await runLoop(defineLoop({ max_iterations: 2, until_bash: GATE_CMD }), {
      iterations: [agentOk("fixed it")],
      gates: [gateGreen],
    });

    // `resume.ts` / `simple.ts` re-seed the progress checklist from exactly this.
    expect(new Set(historyPhases(store))).toEqual(new Set(["fix_iter_1"]));
  });
});

// ── 6. Loops with no `until_bash` are untouched ──────────────────────────────

describe("generic loop — an `until:`-only loop writes no check row", () => {
  it("runs no command and opens only the iteration's row", async () => {
    const { store, agent } = await runLoop(
      defineLoop({ max_iterations: 3, until: "output.contains('READY')" }, "socratic"),
      { iterations: [agentOk("still thinking"), agentOk("READY")] },
    );

    expect(agent.commands).toEqual([]);
    expect(rowKeys(store)).toEqual([`${WF}:socratic_iter_1`, `${WF}:socratic_iter_2`]);
    expect(rowKeys(store).some((k) => k.endsWith("_check"))).toBe(false);
  });

  it("still records work-complete then condition-met for the winning iteration", async () => {
    const { store } = await runLoop(
      defineLoop({ max_iterations: 3, until: "output.contains('READY')" }, "socratic"),
      { iterations: [agentOk("still thinking"), agentOk("READY")] },
    );

    expect(historyEntries(store)).toEqual([
      { phase: "socratic_iter_1", summary: "iteration 1 — work complete" },
      { phase: "socratic_iter_2", summary: "iteration 2 — work complete" },
      { phase: "socratic_iter_2", summary: "iteration 2 — condition met" },
    ]);
  });
});

// ── 7. The `until:` short-circuit — the fix family's live shape ──────────────

describe("generic loop — `until:` short-circuits `until_bash` entirely", () => {
  it("skips the gate (and its row) when the marker says the fix was pushed", async () => {
    const { store, agent, result } = await runLoop(defineLoop(FIX_FAMILY_LOOP), {
      iterations: [agentOk("CI_FIX_COMPLETE: outcome=pushed tried=npm test gate=green")],
      gates: [gateRed], // would fail the loop if it were ever consulted
    });

    // No container, no gate, no row: `until` matched first.
    expect(agent.commands).toEqual([]);
    expect(rowKeys(store)).toEqual([`${WF}:fix_iter_1`]);
    expect(result.success).toBe(true);
    expect(store.phaseHistory(RUN_ID).at(-1)!.summary).toBe("iteration 1 — condition met");
  });

  it("still pays for the gate when the marker says nothing was pushed", async () => {
    const { store, agent } = await runLoop(defineLoop(FIX_FAMILY_LOOP), {
      iterations: [
        agentOk("CI_FIX_COMPLETE: outcome=no-change tried=npm test gate=red"),
        agentOk("CI_FIX_COMPLETE: outcome=gave-up tried=npm test gate=red"),
      ],
      gates: [gateRed, gateRed],
    });

    // Nothing was pushed ⇒ no new commit, no new check run, no external
    // authority. The local gate is the only evidence there is, and its red
    // verdict is what earns the next iteration.
    expect(agent.commands).toEqual([GATE_CMD, GATE_CMD]);
    expect(rowKeys(store).filter((k) => k.endsWith("_check"))).toEqual([
      `${WF}:fix_iter_1_check`,
      `${WF}:fix_iter_2_check`,
    ]);
  });
});

// ── 8. The interactive reply-gate loop (`explore.yaml`'s socratic phase) ─────

describe("generic loop — an interactive loop records the round before it pauses", () => {
  it("persists `socratic_iter_1` BEFORE the waiting_approval marker", async () => {
    const definition = defineLoop(
      {
        max_iterations: 8,
        until: "output.contains('READY')",
        interactive: true,
        gate_kind: "reply",
        scratch_key: "socratic",
      },
      "socratic",
    );
    const { store, result } = await runLoop(definition, {
      iterations: [agentOk("here is my first question")],
    });

    expect(result.paused).toBe(true);
    expect((await store.runs.getRun(RUN_ID))!.status).toBe("paused");
    // Order is load-bearing: `pauseForApproval` moves `current_phase` to
    // `waiting_approval`, which is what `simple.ts` matches on to resume. The
    // round's own entry has to land first, and now does — a paused round used
    // to be recorded nowhere, so the notifier's re-seeded `completed` set
    // dropped it on resume.
    expect(historyPhases(store)).toEqual(["socratic_iter_1", "waiting_approval"]);
    expect(historyEntries(store)[0]!.summary).toBe("iteration 1 — work complete");
    // Nothing to gate here — `until` only, so no check row either way.
    expect(rowKeys(store)).toEqual([`${WF}:socratic_iter_1`]);
  });
});

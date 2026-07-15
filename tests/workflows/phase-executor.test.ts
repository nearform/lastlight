import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentWorkflowDefinition, PhaseDefinition } from "#src/workflows/schema.js";
import type { TemplateContext } from "#src/workflows/templates.js";
import type { StateDb } from "#src/state/db.js";
import type { DagNode } from "#src/workflows/dag.js";
import type { PhaseResult } from "#src/workflows/runner.js";

// Mock the executor so we don't make real agent calls.
vi.mock("#src/engine/agent-executor.js", () => ({
  executeAgent: vi.fn(),
  executeCommand: vi.fn(),
}));
vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
}));
vi.mock("#src/workflows/loader.js", () => ({
  loadPromptTemplate: vi.fn((path: string) => `TEMPLATE:${path}`),
  resolveSkillPaths: vi.fn(() => undefined),
}));
vi.mock("child_process", () => ({ execSync: vi.fn() }));

import { executeAgent, executeCommand } from "#src/engine/agent-executor.js";
import { listRunningContainers } from "#src/admin/docker.js";
import {
  PhaseExecutor,
  isSoftOutcome,
  type PhaseReporter,
  type PhaseResolver,
  type PhaseRunContext,
} from "#src/workflows/phase-executor.js";

const mockExecuteAgent = vi.mocked(executeAgent);
const mockExecuteCommand = vi.mocked(executeCommand);

const BASE_CTX: TemplateContext = {
  owner: "acme",
  repo: "widget",
  issueNumber: 42,
  issueTitle: "Add Rate Limiter",
  issueBody: "We need a rate limiter",
  issueLabels: [],
  commentBody: "",
  sender: "alice",
  branch: "lastlight/42-add-rate-limiter",
  taskId: "widget-42",
  issueDir: ".lastlight/issue-42",
  bootstrapLabel: "lastlight:bootstrap",
};

function makeSuccessResult(output = "success output") {
  return { success: true, output, error: undefined, turns: 5, durationMs: 1000 };
}
function makeFailResult(error = "boom") {
  return { success: false, output: "", error, turns: 2, durationMs: 500 };
}
// A "soft" outcome: the agent exited cleanly but produced no usable output —
// stop reason `unknown` (no final text, no agent_end), NOT a crash.
function makeSoftResult(output = "") {
  return { success: false, output, error: undefined, turns: 3, durationMs: 400, stopReason: "unknown" };
}

interface RecordedStep {
  key: string;
  status: string;
  template?: string;
  extraCtx?: Partial<import("#src/workflows/templates.js").TemplateContext>;
}

function makeReporter(): PhaseReporter & { steps: RecordedStep[]; notes: string[]; persisted: string[]; failed: string[] } {
  const steps: RecordedStep[] = [];
  const notes: string[] = [];
  const persisted: string[] = [];
  const failed: string[] = [];
  return {
    steps,
    notes,
    persisted,
    failed,
    onStart: vi.fn(async () => {}),
    onEnd: vi.fn(async () => {}),
    step: vi.fn(async (key, status, template, extraCtx) => {
      steps.push({ key, status, template, extraCtx });
    }),
    message: vi.fn(async (template) => {
      if (template) notes.push(template);
    }),
    approvalNote: vi.fn(async (template) => {
      if (template) notes.push(template);
    }),
    postNote: vi.fn(async (text) => {
      notes.push(text);
    }),
    persistPhase: vi.fn((phase) => {
      persisted.push(phase);
    }),
    failWorkflow: vi.fn((err) => {
      failed.push(err ?? "");
    }),
  };
}

function makeResolver(overrides: Partial<PhaseResolver> = {}): PhaseResolver {
  return {
    modelFor: () => undefined,
    variantFor: () => undefined,
    renderPrompt: (path: string) => `RENDERED:${path}`,
    gateEnabled: () => false,
    ...overrides,
  };
}

function makeRun(definition: AgentWorkflowDefinition, db?: StateDb, scratch: Record<string, unknown> = {}): PhaseRunContext {
  return {
    definition,
    ctx: { ...BASE_CTX },
    config: {} as never,
    taskId: "widget-42",
    triggerId: "acme/widget#42",
    githubAccess: { owner: "acme", repo: "widget", profile: "read", allowMcpAppAuth: false } as never,
    scratch,
    db,
    workflowId: db ? "wf-1" : undefined,
  };
}

function node(name: string, depends_on: string[] = []): DagNode {
  return { name, depends_on, status: "pending", trigger_rule: "all_success" };
}

function makeMockDb(): StateDb {
  return {
    runs: {
      getRun: vi.fn(() => ({ currentPhase: "phase_0", phaseHistory: [], status: "running", scratch: {} })),
      appendPhase: vi.fn(),
      pauseForApproval: vi.fn(),
      mergeScratch: vi.fn(),
      finishRun: vi.fn(),
      setPaused: vi.fn(),
      setRunning: vi.fn(),
    },
    approvals: {
      create: vi.fn(),
      getPendingForWorkflow: vi.fn(() => null),
    },
    executions: {
      shouldRunPhase: vi.fn(() => "run"),
      recordStart: vi.fn(),
      recordFinish: vi.fn(),
      recordOutputText: vi.fn(),
      recordSessionId: vi.fn(),
      getExecutionOutput: vi.fn(() => null),
      getPhaseOutput: vi.fn(() => null),
      markStaleAsFailed: vi.fn(),
      markLatestAsFailed: vi.fn(),
    },
  } as unknown as StateDb;
}

function makePhase(p: Partial<PhaseDefinition> & { name: string }): PhaseDefinition {
  return { type: "agent", ...p } as PhaseDefinition;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("PhaseExecutor — context phase", () => {
  it("returns succeeded without invoking the agent and persists phase history", async () => {
    const def: AgentWorkflowDefinition = {
      kind: "agent",
      name: "ctx-only",
      phases: [makePhase({ name: "phase_0", type: "context" })],
    };
    const reporter = makeReporter();
    const exec = new PhaseExecutor(makeRun(def), reporter, makeResolver());

    const outcome = await exec.execute(node("phase_0"), {});

    expect(mockExecuteAgent).not.toHaveBeenCalled();
    expect(outcome.status).toBe("succeeded");
    expect(outcome.results).toEqual([
      { phase: "phase_0", success: true, output: "Context assembled" },
    ]);
    expect(reporter.persisted).toContain("phase_0");
  });
});

describe("PhaseExecutor — standard agent phase", () => {
  const def: AgentWorkflowDefinition = {
    kind: "agent",
    name: "wf",
    phases: [makePhase({ name: "architect", prompt: "prompts/architect.md", output_var: "plan" })],
  };

  it("runs the agent and exposes output under phase name + output_var", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("the plan"));
    const exec = new PhaseExecutor(makeRun(def), makeReporter(), makeResolver());

    const outcome = await exec.execute(node("architect"), {});

    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.results).toEqual([{ phase: "architect", success: true, output: "the plan", error: undefined }]);
    expect(outcome.outputVars).toEqual({ architect: "the plan", plan: "the plan" });
  });

  it("exposes the phase's own output to its on_success render context", async () => {
    // Regression: the scheduler only merges outputVars into the shared outputs
    // map AFTER execute() returns, so a phase referencing its own output_var in
    // on_success (e.g. answer's `{{answerResult}}`) would render empty unless
    // execute() injects the just-produced output into the done-step context.
    const successDef: AgentWorkflowDefinition = {
      kind: "agent",
      name: "wf",
      phases: [
        makePhase({
          name: "answer",
          prompt: "prompts/answer.md",
          output_var: "answerResult",
          messages: { on_success: "{{answerResult}}" },
        }),
      ],
    };
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("the full answer text"));
    const reporter = makeReporter();
    const exec = new PhaseExecutor(makeRun(successDef), reporter, makeResolver());

    await exec.execute(node("answer"), {});

    const doneStep = reporter.steps.find((s) => s.key === "answer" && s.status === "done");
    expect(doneStep?.template).toBe("{{answerResult}}");
    // The merged render context carries this phase's own output, so on_success
    // resolves to the answer rather than an empty string.
    expect(doneStep?.extraCtx?.phaseOutputs).toMatchObject({ answerResult: "the full answer text" });
  });

  it("runs a skills-only phase (plural `skills:`, no prompt) instead of skipping it", async () => {
    // Regression: the type=agent guard checked only the singular `phase.skill`
    // sugar, so a phase declaring `skills: [...]` with no `prompt:` (exactly
    // pr-review.yaml) was skipped — the run completed with zero executions.
    const skillsDef: AgentWorkflowDefinition = {
      kind: "review",
      name: "pr-review",
      phases: [makePhase({ name: "review", skills: ["pr-review", "building", "code-review"] })],
    };
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("reviewed"));
    const exec = new PhaseExecutor(makeRun(skillsDef), makeReporter(), makeResolver());

    const outcome = await exec.execute(node("review"), {});

    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.results).toEqual([{ phase: "review", success: true, output: "reviewed", error: undefined }]);
  });

  it("returns status=failed and fails the workflow when the agent fails", async () => {
    mockExecuteAgent.mockResolvedValue(makeFailResult("kaboom"));
    const reporter = makeReporter();
    const exec = new PhaseExecutor(makeRun(def), reporter, makeResolver());

    const outcome = await exec.execute(node("architect"), {});

    expect(outcome.status).toBe("failed");
    expect(reporter.failed).toContain("kaboom");
    expect(reporter.steps.some((s: RecordedStep) => s.key === "architect" && s.status === "failed")).toBe(true);
  });

  it("does NOT report a failed step for terminated (OOM/cancel) errors", async () => {
    mockExecuteAgent.mockResolvedValue(makeFailResult("container is not running"));
    const reporter = makeReporter();
    const exec = new PhaseExecutor(makeRun(def), reporter, makeResolver());

    const outcome = await exec.execute(node("architect"), {});

    expect(outcome.status).toBe("failed");
    expect(reporter.steps.some((s: RecordedStep) => s.key === "architect" && s.status === "failed")).toBe(false);
  });

  it("aborts (running-skip) when the dedup ledger reports the phase running and the container is alive", async () => {
    const db = makeMockDb();
    vi.mocked(db.executions.shouldRunPhase).mockReturnValue("running");
    vi.mocked(listRunningContainers).mockResolvedValueOnce([{ taskId: "widget-42" }] as never);
    const exec = new PhaseExecutor(makeRun(def, db), makeReporter(), makeResolver());

    const outcome = await exec.execute(node("architect"), {});

    expect(outcome.aborted).toBe(true);
    expect(outcome.status).toBe("failed");
    expect(mockExecuteAgent).not.toHaveBeenCalled();
  });

  it("treats a done dedup row as already-completed (skips the agent)", async () => {
    const db = makeMockDb();
    vi.mocked(db.executions.shouldRunPhase).mockReturnValue("done");
    const reporter = makeReporter();
    const exec = new PhaseExecutor(makeRun(def, db), reporter, makeResolver());

    const outcome = await exec.execute(node("architect"), {});

    expect(mockExecuteAgent).not.toHaveBeenCalled();
    expect(outcome.status).toBe("succeeded");
    expect(outcome.results[0].output).toBe("Already completed");
    expect(reporter.persisted).toContain("architect");
  });
});

describe("PhaseExecutor — on_output BLOCKED", () => {
  const def: AgentWorkflowDefinition = {
    kind: "agent",
    name: "guarded",
    phases: [
      makePhase({
        name: "guardrails",
        prompt: "prompts/guardrails.md",
        on_output: {
          contains_BLOCKED: { action: "fail", message: "Guardrails: BLOCKED", unless_label: "lastlight:bootstrap" },
        },
      }),
    ],
  };

  it("fails the node when output contains BLOCKED", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("BLOCKED — no tests"));
    const reporter = makeReporter();
    const db = makeMockDb();
    const exec = new PhaseExecutor(makeRun(def, db), reporter, makeResolver());

    const outcome = await exec.execute(node("guardrails"), {});

    expect(outcome.status).toBe("failed");
    expect(outcome.results[0]).toMatchObject({ phase: "guardrails", success: false, error: "BLOCKED" });
    expect(db.executions.markLatestAsFailed).toHaveBeenCalled();
    expect(reporter.failed.length).toBeGreaterThan(0);
  });

  it("bypasses BLOCKED when the unless_label is present", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("BLOCKED — no tests"));
    const run = makeRun(def, makeMockDb());
    run.ctx.issueLabels = ["lastlight:bootstrap"];
    const exec = new PhaseExecutor(run, makeReporter(), makeResolver());

    const outcome = await exec.execute(node("guardrails"), {});

    expect(outcome.status).toBe("succeeded");
  });
});

describe("PhaseExecutor — approval gate", () => {
  const def: AgentWorkflowDefinition = {
    kind: "agent",
    name: "gated",
    phases: [makePhase({ name: "architect", prompt: "prompts/architect.md", approval_gate: "post_architect" })],
  };

  it("pauses when the gate is enabled", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("plan"));
    const db = makeMockDb();
    const exec = new PhaseExecutor(
      makeRun(def, db),
      makeReporter(),
      makeResolver({ gateEnabled: (g?: string) => g === "post_architect" }),
    );

    const outcome = await exec.execute(node("architect"), {});

    expect(outcome.paused).toBe(true);
    expect(outcome.status).toBe("succeeded");
    expect(db.runs.pauseForApproval).toHaveBeenCalled();
    expect(db.runs.pauseForApproval).toHaveBeenCalled();
  });

  it("does not pause when the gate is disabled", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("plan"));
    const db = makeMockDb();
    const exec = new PhaseExecutor(makeRun(def, db), makeReporter(), makeResolver());

    const outcome = await exec.execute(node("architect"), {});

    expect(outcome.paused).toBeFalsy();
    expect(db.runs.pauseForApproval).not.toHaveBeenCalled();
  });
});

describe("PhaseExecutor — reviewer loop", () => {
  const def: AgentWorkflowDefinition = {
    kind: "agent",
    name: "full",
    phases: [
      makePhase({
        name: "reviewer",
        prompt: "prompts/reviewer.md",
        output_var: "review",
        loop: {
          max_cycles: 2,
          on_request_changes: { fix_prompt: "prompts/fix.md", re_review_prompt: "prompts/re.md" },
        },
      }),
    ],
  };

  it("approves on first review — no fix cycle", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("VERDICT: APPROVED"));
    const exec = new PhaseExecutor(makeRun(def), makeReporter(), makeResolver());

    const outcome = await exec.execute(node("reviewer"), {});

    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.outputVars).toEqual({ review: { approved: true, cycles: 0 } });
  });

  it("runs one fix cycle on REQUEST_CHANGES then APPROVED", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("VERDICT: REQUEST_CHANGES"))
      .mockResolvedValueOnce(makeSuccessResult("fixed"))
      .mockResolvedValueOnce(makeSuccessResult("VERDICT: APPROVED"));
    const exec = new PhaseExecutor(makeRun(def), makeReporter(), makeResolver());

    const outcome = await exec.execute(node("reviewer"), {});

    expect(outcome.status).toBe("succeeded");
    expect(outcome.outputVars).toEqual({ review: { approved: true, cycles: 1 } });
    expect(outcome.results.map((r: PhaseResult) => r.phase)).toEqual(["reviewer", "reviewer_fix_1", "reviewer_recheck_1"]);
  });

  it("pauses at an enabled loop approval gate before the fix cycle", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("VERDICT: REQUEST_CHANGES"));
    const loopDef: AgentWorkflowDefinition = {
      kind: "agent",
      name: "full",
      phases: [
        makePhase({
          name: "reviewer",
          prompt: "prompts/reviewer.md",
          loop: {
            max_cycles: 2,
            approval_gate: "post_reviewer",
            on_request_changes: { fix_prompt: "prompts/fix.md", re_review_prompt: "prompts/re.md" },
          },
        }),
      ],
    };
    const db = makeMockDb();
    const exec = new PhaseExecutor(
      makeRun(loopDef, db),
      makeReporter(),
      makeResolver({ gateEnabled: (g?: string) => g === "post_reviewer" }),
    );

    const outcome = await exec.execute(node("reviewer"), {});

    expect(outcome.paused).toBe(true);
    expect(db.runs.pauseForApproval).toHaveBeenCalled();
    // Only the first review ran — no fix agent call yet.
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
  });

  it("on resume past an approved loop gate, runs the fix cycle instead of treating the deduped review as approved", async () => {
    const loopDef: AgentWorkflowDefinition = {
      kind: "agent",
      name: "full",
      phases: [
        makePhase({
          name: "reviewer",
          prompt: "prompts/reviewer.md",
          output_var: "review",
          loop: {
            max_cycles: 2,
            approval_gate: "post_reviewer",
            on_request_changes: { fix_prompt: "prompts/fix.md", re_review_prompt: "prompts/re.md" },
          },
        }),
      ],
    };
    const db = makeMockDb();
    // Resume state: the initial review already ran and requested changes; the
    // fix for cycle 1 has NOT run yet; we paused at cycle 1's gate.
    vi.mocked(db.executions.shouldRunPhase).mockImplementation((skill: string) =>
      skill === "full:reviewer" ? "done" : "run",
    );
    vi.mocked(db.executions.getPhaseOutput).mockImplementation((skill: string) =>
      skill === "full:reviewer" ? "VERDICT: REQUEST_CHANGES\nfix the bug" : null,
    );
    // fix succeeds, then the re-review approves.
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("fixed"))
      .mockResolvedValueOnce(makeSuccessResult("VERDICT: APPROVED"));

    const exec = new PhaseExecutor(
      makeRun(loopDef, db, { "rloop:reviewer": { pausedAtCycle: 1 } }),
      makeReporter(),
      makeResolver({ gateEnabled: (g?: string) => g === "post_reviewer" }),
    );

    const outcome = await exec.execute(node("reviewer"), {});

    // Must NOT pause again, and must NOT report approved=true with 0 cycles.
    expect(outcome.paused).toBeFalsy();
    expect(db.runs.pauseForApproval).not.toHaveBeenCalled();
    expect(outcome.outputVars).toEqual({ review: { approved: true, cycles: 1 } });
    // The fix + re-review ran (2 agent calls); the initial review was deduped.
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
    expect(outcome.results.map((r: PhaseResult) => r.phase)).toEqual([
      "reviewer",
      "reviewer_fix_1",
      "reviewer_recheck_1",
    ]);
  });
});

describe("PhaseExecutor — generic loop", () => {
  const def: AgentWorkflowDefinition = {
    kind: "agent",
    name: "gl",
    phases: [
      makePhase({
        name: "worker",
        prompt: "prompts/worker.md",
        output_var: "work",
        generic_loop: { max_iterations: 3, until: "output.contains('DONE')", interactive: false, fresh_context: false },
      }),
    ],
  };

  it("completes when the until expression matches", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("still going"))
      .mockResolvedValueOnce(makeSuccessResult("all DONE"));
    const exec = new PhaseExecutor(makeRun(def, makeMockDb()), makeReporter(), makeResolver());

    const outcome = await exec.execute(node("worker"), {});

    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
    expect(outcome.status).toBe("succeeded");
    expect(outcome.outputVars).toEqual({ work: { completed: true, iterations: 2 } });
  });

  it("fails the workflow when an iteration agent fails", async () => {
    mockExecuteAgent.mockResolvedValue(makeFailResult("iter boom"));
    const reporter = makeReporter();
    const exec = new PhaseExecutor(makeRun(def, makeMockDb()), reporter, makeResolver());

    const outcome = await exec.execute(node("worker"), {});

    expect(outcome.status).toBe("failed");
    expect(reporter.failed).toContain("iter boom");
  });

  // on_soft_failure: a clean-but-empty iteration ("unknown") is recoverable.
  const softDef = (then: "fail" | "complete", retries = 1): AgentWorkflowDefinition => ({
    kind: "agent",
    name: "gl",
    phases: [
      makePhase({
        name: "worker",
        prompt: "prompts/worker.md",
        output_var: "work",
        generic_loop: {
          max_iterations: 3,
          until: "output.contains('DONE')",
          interactive: false,
          fresh_context: false,
          on_soft_failure: { retries, then },
        },
      }),
    ],
  });

  it("retries a soft iteration and continues when the retry succeeds", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSoftResult())
      .mockResolvedValueOnce(makeSuccessResult("all DONE"));
    const reporter = makeReporter();
    const exec = new PhaseExecutor(makeRun(softDef("complete"), makeMockDb()), reporter, makeResolver());

    const outcome = await exec.execute(node("worker"), {});

    expect(mockExecuteAgent).toHaveBeenCalledTimes(2); // initial + 1 retry
    expect(outcome.status).toBe("succeeded");
    expect(reporter.failed).toHaveLength(0);
  });

  it("advances (then: complete) when a soft iteration persists after the retry", async () => {
    mockExecuteAgent.mockResolvedValue(makeSoftResult());
    const reporter = makeReporter();
    const exec = new PhaseExecutor(makeRun(softDef("complete"), makeMockDb()), reporter, makeResolver());

    const outcome = await exec.execute(node("worker"), {});

    expect(mockExecuteAgent).toHaveBeenCalledTimes(2); // initial + 1 retry, then advance
    expect(outcome.status).toBe("succeeded");
    expect(reporter.failed).toHaveLength(0);
    // The rollup guard: no failed PhaseResult may leak into the run's phases[],
    // or runner.ts `anyFailed` would fail the whole run despite "succeeded".
    expect(outcome.results.every((r) => r.success)).toBe(true);
  });

  it("still hard-fails a real crash even with on_soft_failure set", async () => {
    mockExecuteAgent.mockResolvedValue({ ...makeFailResult("fatal boom"), stopReason: "error_fatal" });
    const reporter = makeReporter();
    const exec = new PhaseExecutor(makeRun(softDef("complete"), makeMockDb()), reporter, makeResolver());

    const outcome = await exec.execute(node("worker"), {});

    expect(mockExecuteAgent).toHaveBeenCalledTimes(1); // hard = no retry
    expect(outcome.status).toBe("failed");
    expect(reporter.failed).toContain("fatal boom");
  });

  it("hard-fails a persistent soft iteration when then: fail (default policy)", async () => {
    mockExecuteAgent.mockResolvedValue(makeSoftResult("nothing to add"));
    const reporter = makeReporter();
    const exec = new PhaseExecutor(makeRun(softDef("fail"), makeMockDb()), reporter, makeResolver());

    const outcome = await exec.execute(node("worker"), {});

    expect(mockExecuteAgent).toHaveBeenCalledTimes(2); // initial + 1 retry, then fail
    expect(outcome.status).toBe("failed");
  });

  it("on soft-complete of a reply loop, persists the round without advancing scratch.iteration", async () => {
    const replyDef: AgentWorkflowDefinition = {
      kind: "agent",
      name: "gl",
      phases: [
        makePhase({
          name: "worker",
          prompt: "prompts/worker.md",
          generic_loop: {
            max_iterations: 3,
            until: "output.contains('DONE')",
            interactive: true,
            gate_kind: "reply",
            scratch_key: "sk",
            fresh_context: false,
            on_soft_failure: { retries: 1, then: "complete" },
          },
        }),
      ],
    };
    const db = makeMockDb();
    mockExecuteAgent.mockResolvedValue(makeSoftResult());
    const exec = new PhaseExecutor(makeRun(replyDef, db), makeReporter(), makeResolver());

    const outcome = await exec.execute(node("worker"), {});

    expect(outcome.status).toBe("succeeded");
    expect(outcome.paused).toBeFalsy(); // advanced, did NOT pause the reply gate
    expect(db.runs.mergeScratch).toHaveBeenCalledWith(
      "wf-1",
      { sk: expect.objectContaining({ iteration: 1, ready: true }) },
    );
  });
});

describe("isSoftOutcome — generic soft/hard classifier", () => {
  it("treats a clean-but-empty exit as soft and a crash as hard", () => {
    expect(isSoftOutcome({ success: true, error: undefined, stopReason: "success" })).toBe(true);
    expect(isSoftOutcome({ success: false, error: undefined, stopReason: "unknown" })).toBe(true);
    expect(isSoftOutcome({ success: false, error: undefined, stopReason: "error_truncated" })).toBe(true);
    expect(isSoftOutcome({ success: false, error: undefined, stopReason: "error_fatal" })).toBe(false);
    expect(isSoftOutcome({ success: false, error: undefined, stopReason: "error_tool" })).toBe(false);
    expect(isSoftOutcome({ success: false, error: undefined, stopReason: "error_exit_1" })).toBe(false);
    // A terminated run is hard even if the stop reason looks soft.
    expect(isSoftOutcome({ success: false, error: "container is not running", stopReason: "unknown" })).toBe(false);
  });
});

describe("PhaseExecutor — bash / script phase", () => {
  function cmdResult(over: Partial<ReturnType<typeof makeSuccessResult>> = {}) {
    return { success: true, output: "hello\n", error: undefined, turns: 0, durationMs: 12, ...over };
  }

  it("runs a bash command and exposes stdout under phase name + output_var", async () => {
    mockExecuteCommand.mockResolvedValue(cmdResult({ output: "hi there\n" }));
    const def: AgentWorkflowDefinition = {
      kind: "agent",
      name: "wf",
      phases: [makePhase({ name: "emit", type: "bash", command: "echo hi there", output_var: "greeting" })],
    };
    const exec = new PhaseExecutor(makeRun(def), makeReporter(), makeResolver());

    const outcome = await exec.execute(node("emit"), {});

    expect(mockExecuteAgent).not.toHaveBeenCalled();
    expect(mockExecuteCommand).toHaveBeenCalledTimes(1);
    const spec = mockExecuteCommand.mock.calls[0][0];
    expect(spec).toEqual({ kind: "bash", command: "echo hi there" });
    expect(outcome.status).toBe("succeeded");
    expect(outcome.outputVars).toEqual({ emit: "hi there\n", greeting: "hi there\n" });
  });

  it("renders templates + forwards upstream outputs as LL_OUT_ env to the command", async () => {
    mockExecuteCommand.mockResolvedValue(cmdResult());
    const def: AgentWorkflowDefinition = {
      kind: "agent",
      name: "wf",
      phases: [makePhase({ name: "consume", type: "bash", command: "echo {{phaseOutputs.emit}}" })],
    };
    const exec = new PhaseExecutor(makeRun(def), makeReporter(), makeResolver());

    await exec.execute(node("consume"), { emit: "from-upstream" });

    const spec = mockExecuteCommand.mock.calls[0][0];
    expect(spec).toEqual({ kind: "bash", command: "echo from-upstream" });
    // 4th positional arg to executeCommand is opts; sandboxEnv carries LL_OUT_*.
    const opts = mockExecuteCommand.mock.calls[0][2] as { sandboxEnv?: Record<string, string> };
    expect(opts.sandboxEnv).toEqual({ LL_OUT_EMIT: "from-upstream" });
  });

  it("fails the workflow when the command exits non-zero", async () => {
    mockExecuteCommand.mockResolvedValue({ success: false, output: "", error: "command exited 3", turns: 0, durationMs: 5 });
    const def: AgentWorkflowDefinition = {
      kind: "agent",
      name: "wf",
      phases: [makePhase({ name: "boom", type: "bash", command: "exit 3" })],
    };
    const reporter = makeReporter();
    const exec = new PhaseExecutor(makeRun(def), reporter, makeResolver());

    const outcome = await exec.execute(node("boom"), {});

    expect(outcome.status).toBe("failed");
    expect(reporter.failed).toContain("command exited 3");
  });

  it("builds a script spec with runtime + name", async () => {
    mockExecuteCommand.mockResolvedValue(cmdResult({ output: "42\n" }));
    const def: AgentWorkflowDefinition = {
      kind: "agent",
      name: "wf",
      phases: [makePhase({ name: "calc-it", type: "script", runtime: "python", script: "print(6*7)" })],
    };
    const exec = new PhaseExecutor(makeRun(def), makeReporter(), makeResolver());

    await exec.execute(node("calc-it"), {});

    const spec = mockExecuteCommand.mock.calls[0][0];
    expect(spec).toEqual({ kind: "script", script: "print(6*7)", runtime: "python", name: "calc-it" });
  });
});

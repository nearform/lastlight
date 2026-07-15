import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentWorkflowDefinition } from "#src/workflows/schema.js";
import type { TemplateContext } from "#src/workflows/templates.js";
import type { RunnerCallbacks, ApprovalGateConfig } from "#src/workflows/runner.js";
import type { StateDb } from "#src/state/db.js";
import type { ProgressReporter, ProgressModel, ProgressStep, StepStatus } from "#src/notify/types.js";

// Mock the executor so we don't make real agent calls. `executeCommand` backs
// both `type: bash`/`script` phases and the in-sandbox `until_bash` check.
vi.mock("#src/engine/agent-executor.js", () => ({
  executeAgent: vi.fn(),
  executeCommand: vi.fn(),
}));

// Mock the docker module
vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
}));

// Mock the loader so templates come from strings, not files
vi.mock("#src/workflows/loader.js", () => ({
  loadPromptTemplate: vi.fn((path: string) => `TEMPLATE:${path}`),
}));

// Keep child_process mocked so `qaImageAvailable()` (images.ts) sees no
// `execFileSync` and reports the QA image as unavailable in tests. until_bash no
// longer uses execSync (it runs via the mocked executeCommand), but this mock
// must stay for the sandbox_image:qa skip test.
vi.mock("child_process", () => ({ execSync: vi.fn() }));

import { executeAgent, executeCommand } from "#src/engine/agent-executor.js";
import { loadPromptTemplate } from "#src/workflows/loader.js";
import { runWorkflow, gitAccessProfileForWorkflow, gitSandboxAccessForWorkflow } from "#src/workflows/runner.js";

const mockExecuteAgent = vi.mocked(executeAgent);
const mockExecuteCommand = vi.mocked(executeCommand);
const mockLoadPromptTemplate = vi.mocked(loadPromptTemplate);

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
  return {
    success: true,
    output,
    error: undefined,
    turns: 5,
    durationMs: 1000,
  };
}

function makeFailResult(error = "something went wrong") {
  return {
    success: false,
    output: "",
    error,
    turns: 2,
    durationMs: 500,
  };
}

const SIMPLE_WORKFLOW: AgentWorkflowDefinition = {
  kind: "agent",
  name: "simple",
  phases: [
    { name: "phase_0", type: "context" },
    { name: "architect", type: "agent", prompt: "prompts/architect.md" },
    { name: "executor", type: "agent", prompt: "prompts/executor.md" },
  ],
};

const WORKFLOW_WITH_GUARDRAILS: AgentWorkflowDefinition = {
  kind: "agent",
  name: "guarded",
  phases: [
    { name: "phase_0", type: "context" },
    {
      name: "guardrails",
      type: "agent",
      prompt: "prompts/guardrails.md",
      on_output: {
        contains_BLOCKED: {
          action: "fail",
          message: "Guardrails check: BLOCKED",
          unless_label: "lastlight:bootstrap",
        },
        contains_READY: { action: "continue" },
      },
    },
    { name: "architect", type: "agent", prompt: "prompts/architect.md" },
  ],
};

const WORKFLOW_WITH_REVIEWER_LOOP: AgentWorkflowDefinition = {
  kind: "agent",
  name: "full",
  phases: [
    { name: "phase_0", type: "context" },
    { name: "executor", type: "agent", prompt: "prompts/executor.md" },
    {
      name: "reviewer",
      type: "agent",
      prompt: "prompts/reviewer.md",
      loop: {
        max_cycles: 2,
        on_request_changes: {
          fix_prompt: "prompts/fix.md",
          re_review_prompt: "prompts/re-reviewer.md",
        },
      },
    },
    { name: "pr", type: "agent", prompt: "prompts/pr.md", on_success: { set_phase: "complete" } },
  ],
};

describe("runWorkflow — basic phase execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("executes context phase without calling executeAgent", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult());

    const result = await runWorkflow(
      {
        kind: "agent",
        name: "ctx-only",
        phases: [{ name: "phase_0", type: "context" }],
      },
      BASE_CTX,
      {} as never,
      {},
    );

    expect(mockExecuteAgent).not.toHaveBeenCalled();
    expect(result.phases).toHaveLength(1);
    expect(result.phases[0].phase).toBe("phase_0");
    expect(result.phases[0].success).toBe(true);
  });

  // Regression: a fresh workflow row has currentPhase initialized to
  // phases[0].name. The runner's resume logic must not interpret that as
  // "phase_0 already completed" and skip it — phase_history is empty on
  // a fresh run. Symptom in prod: explore workflow's context phase was
  // silently skipped, so phase_history stayed [] and downstream failures
  // surfaced with current_phase=phase_0 even though phase_0 never ran.
  it("runs the first phase on a fresh run despite currentPhase=phase_0 in DB", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult());

    const db = makeMockDb("phase_0");
    const result = await runWorkflow(
      SIMPLE_WORKFLOW,
      BASE_CTX,
      {} as never,
      {},
      db,
      undefined,
      undefined,
      "wf-fresh-1",
    );

    expect(result.success).toBe(true);
    // Context phase ran (persistPhase fired) and both agent phases ran.
    expect(result.phases.map((p) => p.phase)).toEqual(["phase_0", "architect", "executor"]);
    expect(db.runs.appendPhase).toHaveBeenCalledWith(
      "wf-fresh-1",
      "phase_0",
      expect.objectContaining({ phase: "phase_0", success: true }),
    );
  });

  it("executes agent phases in order", async () => {
    const calls: string[] = [];
    mockExecuteAgent.mockImplementation(async (prompt: string) => {
      calls.push(prompt);
      return makeSuccessResult();
    });

    await runWorkflow(SIMPLE_WORKFLOW, BASE_CTX, {} as never, {});

    // Two agent phases: architect and executor
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
    // The prompts contain the template path (mocked as TEMPLATE:path)
    expect(calls[0]).toContain("prompts/architect.md");
    expect(calls[1]).toContain("prompts/executor.md");
  });

  it("returns success=true when all phases pass", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult());

    const result = await runWorkflow(SIMPLE_WORKFLOW, BASE_CTX, {} as never, {});
    expect(result.success).toBe(true);
  });

  it("posts a phase's own output to postComment via on_success", async () => {
    // Regression: a phase referencing its OWN output_var in on_success (e.g.
    // the answer workflow's `on_success: "{{answerResult}}"`, which delivers the
    // answer to a Slack thread / issue comment) must render to the real output,
    // not an empty string — outputVars are now injected into the done-step
    // render context rather than only after execute() returns.
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("the full answer text"));
    const comments: string[] = [];
    const def: AgentWorkflowDefinition = {
      kind: "agent",
      name: "answer",
      phases: [
        { name: "phase_0", type: "context" },
        {
          name: "answer",
          type: "agent",
          prompt: "prompts/answer.md",
          output_var: "answerResult",
          messages: { on_success: "{{answerResult}}" },
        },
      ],
    };

    await runWorkflow(def, BASE_CTX, {} as never, {
      postComment: async (msg) => { comments.push(msg); },
    });

    expect(comments).toContain("the full answer text");
  });

  it("returns success=false and stops on phase failure", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("architect done"))
      .mockResolvedValueOnce(makeFailResult("executor exploded"));

    const result = await runWorkflow(SIMPLE_WORKFLOW, BASE_CTX, {} as never, {});
    expect(result.success).toBe(false);
    // Only two phases executed (phase_0 + architect + executor)
    // phase_0 = context, architect = success, executor = fail → stops
    const names = result.phases.map((p) => p.phase);
    expect(names).toContain("architect");
    expect(names).toContain("executor");
    expect(names).not.toContain("pr");
  });
});

describe("runWorkflow — guardrails on_output rules", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fails workflow when guardrails output contains BLOCKED", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("BLOCKED — no test framework"));

    const comments: string[] = [];
    const result = await runWorkflow(
      WORKFLOW_WITH_GUARDRAILS,
      BASE_CTX,
      {} as never,
      { postComment: async (msg) => { comments.push(msg); } },
    );

    expect(result.success).toBe(false);
    expect(comments.some((c) => c.includes("BLOCKED"))).toBe(true);
    // architect's agent must not have run — only guardrails was dispatched.
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
    // Under the unified scheduler a failed phase cascades downstream as a skip,
    // recorded in phases[] rather than omitted.
    const architect = result.phases.find((p) => p.phase === "architect");
    expect(architect?.output).toContain("Skipped");
  });

  it("bypasses BLOCKED for bootstrap tasks (by label)", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("BLOCKED — no test framework"));
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("READY"));

    const ctx = { ...BASE_CTX, issueLabels: ["lastlight:bootstrap"] };

    // First call = guardrails returns BLOCKED, second = architect succeeds
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("BLOCKED"))
      .mockResolvedValueOnce(makeSuccessResult("architect plan"));

    const result = await runWorkflow(WORKFLOW_WITH_GUARDRAILS, ctx, {} as never, {});
    // Even though guardrails returned BLOCKED, we bypass it because of the label
    expect(result.phases.map((p) => p.phase)).toContain("architect");
  });

  it("bypasses BLOCKED when unless_title_matches regex hits", async () => {
    const workflow: AgentWorkflowDefinition = {
      kind: "agent",
      name: "title-bypass",
      phases: [
        { name: "phase_0", type: "context" },
        {
          name: "guardrails",
          type: "agent",
          prompt: "prompts/guardrails.md",
          on_output: {
            contains_BLOCKED: {
              action: "fail",
              message: "blocked",
              unless_title_matches: "^guardrails:",
            },
          },
        },
        { name: "architect", type: "agent", prompt: "prompts/architect.md" },
      ],
    };
    const ctx = { ...BASE_CTX, issueTitle: "guardrails: add test framework" };
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("BLOCKED"))
      .mockResolvedValueOnce(makeSuccessResult("architect plan"));

    const result = await runWorkflow(workflow, ctx, {} as never, {});
    expect(result.phases.map((p) => p.phase)).toContain("architect");
  });

  it("continues normally when guardrails returns READY", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("READY — all guardrails pass"))
      .mockResolvedValueOnce(makeSuccessResult("architect plan"));

    const result = await runWorkflow(WORKFLOW_WITH_GUARDRAILS, BASE_CTX, {} as never, {});
    expect(result.success).toBe(true);
    expect(result.phases.map((p) => p.phase)).toContain("architect");
  });
});

describe("runWorkflow — reviewer loop", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("approves on first review — no fix loop", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("executor done")) // executor
      .mockResolvedValueOnce(makeSuccessResult("VERDICT: APPROVED\nLooks great!")) // reviewer
      .mockResolvedValueOnce(makeSuccessResult("PR #7 created")); // pr

    const result = await runWorkflow(WORKFLOW_WITH_REVIEWER_LOOP, BASE_CTX, {} as never, {});
    expect(result.success).toBe(true);
    // executor + reviewer + pr = 3 agent calls
    expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
    expect(result.prNumber).toBe(7);
  });

  it("runs one fix cycle on REQUEST_CHANGES then APPROVED", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("executor done")) // executor
      .mockResolvedValueOnce(makeSuccessResult("VERDICT: REQUEST_CHANGES\nFix the bug")) // reviewer cycle 1
      .mockResolvedValueOnce(makeSuccessResult("fixed")) // fix_loop_1
      .mockResolvedValueOnce(makeSuccessResult("VERDICT: APPROVED\nAll fixed")) // re-review
      .mockResolvedValueOnce(makeSuccessResult("PR #8 created")); // pr

    const phases: string[] = [];
    const result = await runWorkflow(WORKFLOW_WITH_REVIEWER_LOOP, BASE_CTX, {} as never, {
      onPhaseStart: async (p) => { phases.push(p); },
    });

    expect(result.success).toBe(true);
    expect(phases).toContain("reviewer_fix_1");
    expect(result.prNumber).toBe(8);
  });

  it("stops after max_cycles when reviewer keeps requesting changes", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("executor done")) // executor
      .mockResolvedValueOnce(makeSuccessResult("VERDICT: REQUEST_CHANGES")) // reviewer cycle 1
      .mockResolvedValueOnce(makeSuccessResult("fixed 1")) // fix_loop_1
      .mockResolvedValueOnce(makeSuccessResult("VERDICT: REQUEST_CHANGES")) // re-review cycle 2
      .mockResolvedValueOnce(makeSuccessResult("fixed 2")) // fix_loop_2
      .mockResolvedValueOnce(makeSuccessResult("VERDICT: REQUEST_CHANGES")) // re-review cycle 3 (max hit)
      .mockResolvedValueOnce(makeSuccessResult("PR #9 created")); // pr

    const result = await runWorkflow(WORKFLOW_WITH_REVIEWER_LOOP, BASE_CTX, {} as never, {});
    // Should proceed to PR after max cycles
    expect(result.prNumber).toBe(9);
  });

  it("uses fallback verdict detection when VERDICT: marker is missing", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("executor done"))
      .mockResolvedValueOnce(makeSuccessResult("APPROVED — code looks fine")) // no marker
      .mockResolvedValueOnce(makeSuccessResult("PR #10 created"));

    const result = await runWorkflow(WORKFLOW_WITH_REVIEWER_LOOP, BASE_CTX, {} as never, {});
    expect(result.success).toBe(true);
    expect(result.prNumber).toBe(10);
  });
});

const WORKFLOW_WITH_APPROVAL_GATE: AgentWorkflowDefinition = {
  kind: "agent",
  name: "gated",
  phases: [
    { name: "phase_0", type: "context" },
    { name: "architect", type: "agent", prompt: "prompts/architect.md", approval_gate: "post_architect" },
    { name: "executor", type: "agent", prompt: "prompts/executor.md" },
    { name: "pr", type: "agent", prompt: "prompts/pr.md", on_success: { set_phase: "complete" } },
  ],
};

/**
 * Minimal StateDb mock providing the methods used by runWorkflow.
 * currentPhase controls what getWorkflowRun returns (simulating DB state after
 * the orchestrator updates it prior to calling runWorkflow).
 */
function makeMockDb(currentPhase = "phase_0"): StateDb {
  let phase = currentPhase;
  // Mirror prod: every `updateWorkflowPhase` call appends to phase_history.
  // Tests that pass a non-"phase_0" `currentPhase` are simulating a resumed
  // run, so seed history with one entry so the runner's resume detection
  // kicks in (it requires phaseHistory.length > 0).
  const phaseHistory: { phase: string; timestamp: string; success: boolean }[] =
    currentPhase !== "phase_0"
      ? [{ phase: currentPhase, timestamp: new Date().toISOString(), success: true }]
      : [];
  const appendPhase = vi.fn((_id: string, newPhase: string, entry?: { phase: string; timestamp: string; success: boolean }) => {
    phase = newPhase;
    if (entry) phaseHistory.push(entry);
  });
  return {
    runs: {
      getRun: vi.fn(() => ({ currentPhase: phase, phaseHistory, status: "running" })),
      appendPhase,
      pauseForApproval: vi.fn(),
      mergeScratch: vi.fn(),
      finishRun: vi.fn(),
      setRunning: vi.fn(),
      setPaused: vi.fn(),
    },
    approvals: {
      create: vi.fn(),
      getPendingForWorkflow: vi.fn(() => null),
    },
    executions: {
      shouldRunPhase: vi.fn(() => "run"),
      recordStart: vi.fn(),
      recordFinish: vi.fn(),
      recordSkippedPhase: vi.fn(),
      recordOutputText: vi.fn(),
      getExecutionOutput: vi.fn(() => null),
      getPhaseOutput: vi.fn(() => null),
      recordSessionId: vi.fn(),
      markStaleAsFailed: vi.fn(),
      markLatestAsFailed: vi.fn(),
    },
  } as unknown as StateDb;
}

describe("runWorkflow — requires_sandbox gate", () => {
  const GATED_WORKFLOW: AgentWorkflowDefinition = {
    kind: "agent",
    name: "gated",
    phases: [
      { name: "phase_0", type: "context" },
      {
        name: "demo",
        type: "agent",
        prompt: "prompts/demo.md",
        requires_sandbox: "docker",
        messages: { on_skipped_done: "Demo skipped — no docker sandbox here." },
      },
    ],
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("skips a docker-gated phase as a non-failing skip on a non-docker backend", async () => {
    const db = makeMockDb();
    // No `sandbox` on the config → active backend resolves to gondolin.
    const result = await runWorkflow(GATED_WORKFLOW, BASE_CTX, {} as never, {}, db);

    // The gated phase never ran...
    expect(mockExecuteAgent).not.toHaveBeenCalled();
    // ...the run did not fail...
    expect(result.success).toBe(true);
    // ...the phase was recorded as a non-failing skip...
    const demo = result.phases.find((p) => p.phase === "demo");
    expect(demo?.success).toBe(true);
    // ...and it landed in the executions ledger as a skip.
    expect(db.executions.recordSkippedPhase).toHaveBeenCalledWith(
      "gated:demo",
      expect.any(String),
      undefined,
      expect.any(String),
    );
  });

  it("runs a docker-gated phase when the active backend is docker", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult());
    const result = await runWorkflow(GATED_WORKFLOW, BASE_CTX, { sandbox: "docker" } as never, {});

    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
    expect(result.success).toBe(true);
  });

  // A `sandbox_image: qa` phase needs the browser-QA image built on the host.
  // The mocked child_process has no `execFileSync`, so `qaImageAvailable()`
  // throws → false: the phase must skip even on the docker backend rather than
  // try (and fail) to spawn a sandbox from a non-existent image.
  const QA_WORKFLOW: AgentWorkflowDefinition = {
    kind: "agent",
    name: "qa",
    phases: [
      { name: "phase_0", type: "context" },
      {
        name: "browser",
        type: "agent",
        prompt: "prompts/browser.md",
        requires_sandbox: "docker",
        sandbox_image: "qa",
        messages: { on_skipped_done: "Browser QA skipped — image not built." },
      },
    ],
  };

  it("skips a sandbox_image:qa phase on docker when the QA image isn't built", async () => {
    const db = makeMockDb();
    const result = await runWorkflow(QA_WORKFLOW, BASE_CTX, { sandbox: "docker" } as never, {}, db);

    expect(mockExecuteAgent).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    const browser = result.phases.find((p) => p.phase === "browser");
    expect(browser?.success).toBe(true);
    expect(browser?.output).toMatch(/lastlight-sandbox-qa:latest/);
    expect(db.executions.recordSkippedPhase).toHaveBeenCalledWith(
      "qa:browser",
      expect.any(String),
      undefined,
      expect.any(String),
    );
  });
});

describe("runWorkflow — final_message + synthesize (verify/qa-test shape)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // Mirrors verify.yaml: a gated browser phase that skips off-docker, and a
  // `synthesize` phase that depends ONLY on the text phase so it still runs
  // (after the gated phase, by declaration order) and folds the outputs into
  // `final_message` → the single comment's footer.
  const VERIFY_LIKE: AgentWorkflowDefinition = {
    kind: "verify",
    name: "verify",
    status_checklist: true,
    final_message: "{{synthesisResult}}",
    phases: [
      { name: "phase_0", type: "context", depends_on: [] },
      {
        name: "verify",
        type: "agent",
        prompt: "prompts/verify.md",
        depends_on: ["phase_0"],
        output_var: "verifyResult",
        messages: { on_success: "Text verification complete." },
      },
      {
        name: "verify_browser",
        type: "agent",
        prompt: "prompts/verify-browser.md",
        depends_on: ["verify"],
        requires_sandbox: "docker",
        sandbox_image: "qa",
        output_var: "verifyBrowserResult",
        messages: { on_skipped_done: "Browser QA unavailable on this host." },
      },
      {
        name: "synthesize",
        type: "agent",
        prompt: "prompts/verify-synth.md",
        depends_on: ["verify"],
        output_var: "synthesisResult",
        messages: { on_success: "Verdict posted below." },
      },
    ],
  };

  function fakeReporter(sink: { footer?: string; steps: Array<[string, StepStatus]> }): ProgressReporter {
    return {
      start: async (_m: ProgressModel) => {},
      step: async (k: string, s: StepStatus) => { sink.steps.push([k, s]); },
      insertStep: async (_st: ProgressStep) => {},
      note: async () => {},
      noteApproval: async () => {},
      footer: async (m: string) => { sink.footer = m; },
      noteTerminal: async () => {},
    };
  }

  it("synthesizes into the checklist footer (single comment) when the browser phase is gated out", async () => {
    // gondolin backend (no `sandbox`) → verify_browser skips. Only verify +
    // synthesize call the agent.
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("text verdict body"))      // verify
      .mockResolvedValueOnce(makeSuccessResult("## CONFIRMED\nfinal verdict")); // synthesize

    const sink: { footer?: string; steps: Array<[string, StepStatus]> } = { steps: [] };
    const comments: string[] = [];
    const result = await runWorkflow(VERIFY_LIKE, BASE_CTX, {} as never, {
      reporter: fakeReporter(sink),
      postComment: async (m) => { comments.push(m); },
    }, makeMockDb());

    expect(result.success).toBe(true);
    // verify + synthesize ran; verify_browser was skipped (no docker).
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
    expect(result.phases.map((p) => p.phase)).toContain("synthesize");
    // The synthesized verdict lands in the footer — NOT as a standalone comment.
    expect(sink.footer).toBe("## CONFIRMED\nfinal verdict");
    expect(comments).toHaveLength(0);
    // Per-phase progress went to checklist steps, not comments.
    expect(sink.steps).toContainEqual(["verify", "done"]);
    expect(sink.steps).toContainEqual(["synthesize", "done"]);
  });

  it("renders final_message to a single postComment in the legacy (no-reporter) path", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("the synthesized verdict"));
    const def: AgentWorkflowDefinition = {
      kind: "agent",
      name: "fin",
      final_message: "{{r}}",
      phases: [
        { name: "phase_0", type: "context" },
        { name: "a", type: "agent", prompt: "prompts/a.md", output_var: "r" },
      ],
    };
    const comments: string[] = [];
    const result = await runWorkflow(def, BASE_CTX, {} as never, {
      postComment: async (m) => { comments.push(m); },
    });
    expect(result.success).toBe(true);
    expect(comments).toContain("the synthesized verdict");
  });
});

describe("runWorkflow — approval gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("pauses at post_architect gate and does not run executor", async () => {
    mockExecuteAgent.mockResolvedValueOnce(makeSuccessResult("architect plan done"));

    const db = makeMockDb("phase_0");
    const approvalConfig: ApprovalGateConfig = { post_architect: true };

    const result = await runWorkflow(
      WORKFLOW_WITH_APPROVAL_GATE,
      BASE_CTX,
      {} as never,
      {},
      db,
      undefined,
      approvalConfig,
      "wf-gate-1",
    );

    expect(result.paused).toBe(true);
    expect(result.success).toBe(true);
    // Only architect ran — executor and pr were not reached
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
    expect(result.phases.map((p) => p.phase)).not.toContain("executor");
  });

  it("resumes past an approved gate via the executions ledger (architect already done)", async () => {
    // Ledger-driven resume: architect's execution row is success=1 ("done"),
    // so runPhase skips it and the gate isn't re-hit — executor + pr run.
    const db = makeMockDb("architect");
    vi.mocked(db.executions.shouldRunPhase).mockImplementation((skill: string) =>
      skill === "gated:architect" ? "done" : "run",
    );
    const approvalConfig: ApprovalGateConfig = { post_architect: true };

    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("executor done"))
      .mockResolvedValueOnce(makeSuccessResult("PR #5 created"));

    const result = await runWorkflow(
      WORKFLOW_WITH_APPROVAL_GATE,
      BASE_CTX,
      {} as never,
      {},
      db,
      undefined,
      approvalConfig,
      "wf-gate-1",
    );

    // Not paused — architect was deduped (done), executor and pr ran.
    expect(result.paused).toBeUndefined();
    expect(result.success).toBe(true);
    expect(result.prNumber).toBe(5);
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
  });

  it("pauses at a custom-named gate when that gate is enabled", async () => {
    const workflow: AgentWorkflowDefinition = {
      kind: "agent",
      name: "custom-gate",
      phases: [
        { name: "phase_0", type: "context" },
        { name: "plan", type: "agent", prompt: "prompts/plan.md", approval_gate: "post_plan" },
        { name: "build", type: "agent", prompt: "prompts/build.md" },
      ],
    };
    mockExecuteAgent.mockResolvedValueOnce(makeSuccessResult("plan done"));
    const db = makeMockDb("phase_0");
    const result = await runWorkflow(
      workflow,
      BASE_CTX,
      {} as never,
      {},
      db,
      undefined,
      { post_plan: true },
      "wf-custom-1",
    );
    expect(result.paused).toBe(true);
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
  });
});

describe("runWorkflow — callbacks", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls onPhaseStart and onPhaseEnd for each phase", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult());

    const started: string[] = [];
    const ended: string[] = [];
    const callbacks: RunnerCallbacks = {
      onPhaseStart: async (p) => { started.push(p); },
      onPhaseEnd: async (p) => { ended.push(p); },
    };

    await runWorkflow(SIMPLE_WORKFLOW, BASE_CTX, {} as never, callbacks);

    expect(started).toContain("phase_0");
    expect(started).toContain("architect");
    expect(started).toContain("executor");
    expect(ended).toContain("architect");
    expect(ended).toContain("executor");
  });

  it("renders phase.messages.on_failure through the template engine", async () => {
    const workflow: AgentWorkflowDefinition = {
      kind: "agent",
      name: "fail-msg",
      phases: [
        { name: "phase_0", type: "context" },
        { name: "architect", type: "agent", prompt: "prompts/architect.md" },
        {
          name: "executor",
          type: "agent",
          prompt: "prompts/executor.md",
          messages: { on_failure: "**{{issueTitle}}** failed — aborting" },
        },
      ],
    };
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult())
      .mockResolvedValueOnce(makeFailResult("connection timeout"));

    const comments: string[] = [];
    await runWorkflow(workflow, BASE_CTX, {} as never, {
      postComment: async (msg) => { comments.push(msg); },
    });

    expect(comments).toContain("**Add Rate Limiter** failed — aborting");
  });

  it("silently skips notification when no on_failure template is set", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult())
      .mockResolvedValueOnce(makeFailResult("connection timeout"));

    const comments: string[] = [];
    await runWorkflow(SIMPLE_WORKFLOW, BASE_CTX, {} as never, {
      postComment: async (msg) => { comments.push(msg); },
    });

    expect(comments).toEqual([]);
  });
});

// until_bash now runs in the sandbox via executeCommand; exit code maps to
// ExecutionResult.success (exit 0 → success: true).
const cmdOk = () => ({ success: true, output: "", turns: 0, durationMs: 1 });
const cmdFail = () => ({ success: false, output: "", error: "command exited 1", turns: 0, durationMs: 1 });

const WORKFLOW_WITH_GENERIC_LOOP: AgentWorkflowDefinition = {
  kind: "agent",
  name: "loop-test",
  phases: [
    { name: "phase_0", type: "context" },
    {
      name: "implement",
      type: "agent",
      prompt: "prompts/implement.md",
      generic_loop: {
        max_iterations: 5,
        until_bash: "npm test",
        interactive: false,
        fresh_context: false,
      },
    },
  ],
};

describe("runWorkflow — generic loop node", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("completes on first iteration when until_bash exits 0", async () => {
    mockExecuteAgent.mockResolvedValueOnce(makeSuccessResult("tests pass"));
    mockExecuteCommand.mockResolvedValueOnce(cmdOk()); // exit 0

    const started: string[] = [];
    const result = await runWorkflow(WORKFLOW_WITH_GENERIC_LOOP, BASE_CTX, {} as never, {
      onPhaseStart: async (p) => { started.push(p); },
    });

    expect(result.success).toBe(true);
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
    expect(started).toContain("implement_iter_1");
    expect(started).not.toContain("implement_iter_2");
  });

  it("iterates when until_bash exits non-zero then completes on exit 0", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("attempt 1"))
      .mockResolvedValueOnce(makeSuccessResult("attempt 2"));
    mockExecuteCommand
      .mockResolvedValueOnce(cmdFail()) // iteration 1 fails
      .mockResolvedValueOnce(cmdOk()); // iteration 2 passes

    const started: string[] = [];
    const result = await runWorkflow(WORKFLOW_WITH_GENERIC_LOOP, BASE_CTX, {} as never, {
      onPhaseStart: async (p) => { started.push(p); },
    });

    expect(result.success).toBe(true);
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
    expect(started).toContain("implement_iter_1");
    expect(started).toContain("implement_iter_2");
    expect(started).not.toContain("implement_iter_3");
  });

  it("stops at max_iterations when condition is never met", async () => {
    const workflow: AgentWorkflowDefinition = {
      kind: "agent",
      name: "max-iter-msg",
      phases: [
        { name: "phase_0", type: "context" },
        {
          name: "implement",
          type: "agent",
          prompt: "prompts/implement.md",
          messages: {
            on_failure: "{{phase}} stopped at {{maxIterations}} max iterations",
          },
          generic_loop: {
            max_iterations: 5,
            until_bash: "npm test",
            interactive: false,
            fresh_context: false,
          },
        },
      ],
    };
    mockExecuteCommand.mockResolvedValue(cmdFail());
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("still failing"));

    const comments: string[] = [];
    const result = await runWorkflow(workflow, BASE_CTX, {} as never, {
      postComment: async (msg) => { comments.push(msg); },
    });

    expect(result.success).toBe(true); // workflow itself doesn't fail — just loop exhausted
    expect(mockExecuteAgent).toHaveBeenCalledTimes(5); // max_iterations = 5
    expect(comments.some((c) => c.includes("max iterations"))).toBe(true);
  });

  it("completes immediately when until expression is true on first output", async () => {
    const workflow: AgentWorkflowDefinition = {
      kind: "agent",
      name: "expr-loop",
      phases: [
        { name: "phase_0", type: "context" },
        {
          name: "check",
          type: "agent",
          prompt: "prompts/check.md",
          generic_loop: {
            max_iterations: 3,
            until: "output.contains('PASS')",
            interactive: false,
            fresh_context: false,
          },
        },
      ],
    };

    mockExecuteAgent.mockResolvedValueOnce(makeSuccessResult("All tests PASS"));

    const result = await runWorkflow(workflow, BASE_CTX, {} as never, {});

    expect(result.success).toBe(true);
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
  });

  it("iterates when until expression is false then stops when true", async () => {
    const workflow: AgentWorkflowDefinition = {
      kind: "agent",
      name: "expr-loop-2",
      phases: [
        { name: "phase_0", type: "context" },
        {
          name: "refine",
          type: "agent",
          prompt: "prompts/refine.md",
          generic_loop: {
            max_iterations: 4,
            until: "output.contains('DONE')",
            interactive: false,
            fresh_context: false,
          },
        },
      ],
    };

    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("still working"))
      .mockResolvedValueOnce(makeSuccessResult("DONE"));

    const result = await runWorkflow(workflow, BASE_CTX, {} as never, {});

    expect(result.success).toBe(true);
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
  });

  it("fresh_context: true does not pass previousOutput on subsequent iterations", async () => {
    const workflow: AgentWorkflowDefinition = {
      kind: "agent",
      name: "fresh-ctx",
      phases: [
        { name: "phase_0", type: "context" },
        {
          name: "task",
          type: "agent",
          prompt: "prompts/task.md",
          generic_loop: {
            max_iterations: 3,
            until_bash: "npm test",
            interactive: false,
            fresh_context: true,
          },
        },
      ],
    };

    const capturedPrompts: string[] = [];
    mockExecuteAgent.mockImplementation(async (prompt: string) => {
      capturedPrompts.push(prompt);
      return makeSuccessResult("iteration output");
    });
    mockExecuteCommand
      .mockResolvedValueOnce(cmdFail())
      .mockResolvedValueOnce(cmdOk());

    await runWorkflow(workflow, BASE_CTX, {} as never, {});

    // Both prompts should NOT contain the first iteration's output
    // (fresh_context resets previousOutput each time)
    expect(capturedPrompts[1]).not.toContain("iteration output");
  });

  it("fresh_context: false passes previousOutput to subsequent iterations", async () => {
    const workflow: AgentWorkflowDefinition = {
      kind: "agent",
      name: "accum-ctx",
      phases: [
        { name: "phase_0", type: "context" },
        {
          name: "build",
          type: "agent",
          prompt: "prompts/build.md",
          generic_loop: {
            max_iterations: 3,
            until_bash: "npm test",
            interactive: false,
            fresh_context: false,
          },
        },
      ],
    };

    // Make the loader return a template that uses {{previousOutput}} so we can
    // verify the context variable is passed through to the rendered prompt
    mockLoadPromptTemplate.mockImplementation(() => "Previous: {{previousOutput}}");

    const capturedPrompts: string[] = [];
    mockExecuteAgent.mockImplementation(async (prompt: string) => {
      capturedPrompts.push(prompt);
      return makeSuccessResult("iteration output ABC");
    });
    mockExecuteCommand
      .mockResolvedValueOnce(cmdFail())
      .mockResolvedValueOnce(cmdOk());

    await runWorkflow(workflow, BASE_CTX, {} as never, {});

    // Second prompt should include the previous iteration's output
    expect(capturedPrompts[1]).toContain("iteration output ABC");
  });

  it("interactive mode pauses workflow after first iteration", async () => {
    const workflow: AgentWorkflowDefinition = {
      kind: "agent",
      name: "interactive-loop",
      phases: [
        { name: "phase_0", type: "context" },
        {
          name: "explore",
          type: "agent",
          prompt: "prompts/explore.md",
          generic_loop: {
            max_iterations: 3,
            until: "output.contains('FINAL')",
            interactive: true,
            gate_message: "Review iteration output before continuing",
            fresh_context: false,
          },
        },
      ],
    };

    // First iteration does not satisfy the until condition
    mockExecuteAgent.mockResolvedValueOnce(makeSuccessResult("progress so far"));

    const db = makeMockDb();
    const comments: string[] = [];

    const result = await runWorkflow(
      workflow,
      BASE_CTX,
      {} as never,
      { postComment: async (msg) => { comments.push(msg); } },
      db,
      undefined,
      undefined,
      "wf-loop-1",
    );

    expect(result.paused).toBe(true);
    expect(result.success).toBe(true);
    expect(db.runs.pauseForApproval).toHaveBeenCalled();
    expect(db.runs.pauseForApproval).toHaveBeenCalled();
    expect(comments.some((c) => c.includes("approval required"))).toBe(true);
  });

  it("fails workflow if an iteration agent call fails", async () => {
    mockExecuteCommand.mockResolvedValue(cmdFail());
    mockExecuteAgent.mockResolvedValueOnce(makeFailResult("oom killed"));

    const comments: string[] = [];
    const result = await runWorkflow(WORKFLOW_WITH_GENERIC_LOOP, BASE_CTX, {} as never, {
      postComment: async (msg) => { comments.push(msg); },
    });

    expect(result.success).toBe(false);
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
  });

  it("treats until_bash containing {{ as non-zero exit (template injection guard)", async () => {
    const workflow: AgentWorkflowDefinition = {
      kind: "agent",
      name: "injection-guard",
      phases: [
        { name: "phase_0", type: "context" },
        {
          name: "run",
          type: "agent",
          prompt: "prompts/run.md",
          generic_loop: {
            max_iterations: 1,
            until_bash: "echo {{secret}}",
            interactive: false,
            fresh_context: false,
          },
        },
      ],
    };
    mockExecuteAgent.mockResolvedValueOnce(makeSuccessResult("output"));
    // executeCommand should NOT be reached — validateShellCommand throws first.
    mockExecuteCommand.mockResolvedValue(cmdOk());

    const result = await runWorkflow(workflow, BASE_CTX, {} as never, {});

    // validateShellCommand throws, caught by runUntilBash, conditionMet stays false;
    // loop exhausts max_iterations=1 and the workflow completes (loop exhausted is not failure).
    expect(result.success).toBe(true);
    // executeCommand must NOT have been called with the mustache-containing command.
    expect(mockExecuteCommand).not.toHaveBeenCalled();
  });
});

// ── DAG workflow tests ────────────────────────────────────────────────────────

const PARALLEL_WORKFLOW: AgentWorkflowDefinition = {
  kind: "agent",
  name: "parallel-test",
  phases: [
    { name: "phase_0", type: "context" },
    { name: "architect", type: "agent", prompt: "prompts/architect.md", depends_on: ["phase_0"] },
    { name: "executor_a", type: "agent", prompt: "prompts/executor_a.md", depends_on: ["architect"] },
    { name: "executor_b", type: "agent", prompt: "prompts/executor_b.md", depends_on: ["architect"] },
    { name: "merge", type: "agent", prompt: "prompts/merge.md", depends_on: ["executor_a", "executor_b"] },
  ],
};

describe("runWorkflow — DAG parallel execution", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("routes to DAG execution when any phase has depends_on", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult());

    const result = await runWorkflow(PARALLEL_WORKFLOW, BASE_CTX, {} as never, {});

    expect(result.success).toBe(true);
    // architect + executor_a + executor_b + merge = 4 agent calls
    expect(mockExecuteAgent).toHaveBeenCalledTimes(4);
  });

  it("runs every ready node sequentially in declaration order", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult("done"));

    const started: string[] = [];
    const result = await runWorkflow(PARALLEL_WORKFLOW, BASE_CTX, {} as never, {
      onPhaseStart: async (p) => { started.push(p); },
    });

    expect(result.success).toBe(true);
    // Sequential, declaration order — the two independent executors no longer
    // run in parallel; the earliest-declared ready node goes first.
    expect(started).toEqual(["phase_0", "architect", "executor_a", "executor_b", "merge"]);
  });

  it("skips downstream nodes when upstream fails (all_success rule)", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("architect done")) // architect
      .mockResolvedValueOnce(makeFailResult("executor_a exploded")) // executor_a
      .mockResolvedValue(makeSuccessResult("done")); // executor_b (and any others)

    const result = await runWorkflow(PARALLEL_WORKFLOW, BASE_CTX, {} as never, {});

    // merge depends on both executor_a AND executor_b — executor_a failed, so merge is skipped
    const mergePhase = result.phases.find((p) => p.phase === "merge");
    // merge should be skipped (not executed by agent), indicated by success=true with skip output
    expect(mergePhase).toBeDefined();
    expect(mergePhase?.output).toContain("Skipped");
    // total agent calls: architect + executor_a + executor_b = 3 (merge agent not called)
    expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
  });

  it("returns overall success=false if any phase failed", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("architect done"))
      .mockResolvedValueOnce(makeFailResult("exploded"))
      .mockResolvedValue(makeSuccessResult("done"));

    const result = await runWorkflow(PARALLEL_WORKFLOW, BASE_CTX, {} as never, {});
    expect(result.success).toBe(false);
  });

  it("all_done trigger rule: downstream runs even when upstream failed", async () => {
    const workflow: AgentWorkflowDefinition = {
      kind: "agent",
      name: "all-done-test",
      phases: [
        { name: "step_a", type: "agent", prompt: "prompts/a.md", depends_on: [] },
        {
          name: "cleanup",
          type: "agent",
          prompt: "prompts/cleanup.md",
          depends_on: ["step_a"],
          trigger_rule: "all_done",
        },
      ],
    };

    mockExecuteAgent
      .mockResolvedValueOnce(makeFailResult("step_a failed"))
      .mockResolvedValueOnce(makeSuccessResult("cleanup done"));

    const result = await runWorkflow(workflow, BASE_CTX, {} as never, {});

    const phaseNames = result.phases.map((p) => p.phase);
    expect(phaseNames).toContain("cleanup");
  });

  it("sequential path is unchanged when no phase has depends_on", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult());

    const result = await runWorkflow(SIMPLE_WORKFLOW, BASE_CTX, {} as never, {});
    expect(result.success).toBe(true);
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2); // architect + executor
  });

  it("uses ONE shared workspace (taskId) for every phase of a DAG run", async () => {
    mockExecuteAgent.mockResolvedValue(makeSuccessResult());

    await runWorkflow(PARALLEL_WORKFLOW, BASE_CTX, {} as never, {});

    // Every executeAgent call carries the same taskId — the per-phase
    // `${taskId}-${phaseName}` clones of the old DAG runner are gone.
    const taskIds = mockExecuteAgent.mock.calls.map((c) => (c[2] as { taskId: string }).taskId);
    expect(taskIds.length).toBe(4);
    expect(new Set(taskIds)).toEqual(new Set([BASE_CTX.taskId]));
  });

  it("records skipped phases in the executions ledger", async () => {
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("architect done"))
      .mockResolvedValueOnce(makeFailResult("executor_a exploded"))
      .mockResolvedValue(makeSuccessResult("done"));

    const db = makeMockDb("phase_0");
    const recordSkipped = vi.fn();
    (db.executions as unknown as { recordSkippedPhase: typeof recordSkipped }).recordSkippedPhase = recordSkipped;

    await runWorkflow(PARALLEL_WORKFLOW, BASE_CTX, {} as never, {}, db, undefined, undefined, "wf-skip-1");

    // merge is skipped (executor_a failed) → one skip row in the ledger.
    const skippedSkills = recordSkipped.mock.calls.map((c) => c[0]);
    expect(skippedSkills).toContain("parallel-test:merge");
  });
});

describe("runWorkflow — definition-driven resume + YAML messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("resumes a workflow whose phases have nothing to do with the build cycle", async () => {
    const workflow: AgentWorkflowDefinition = {
      kind: "agent",
      name: "custom",
      phases: [
        { name: "phase_0", type: "context" },
        { name: "discover", type: "agent", prompt: "prompts/discover.md" },
        { name: "plan", type: "agent", prompt: "prompts/plan.md" },
        { name: "implement", type: "agent", prompt: "prompts/implement.md" },
        { name: "ship", type: "agent", prompt: "prompts/ship.md" },
      ],
    };
    // Ledger-driven resume: discover + plan are already done; implement + ship
    // still need to run. The runner re-runs from the top and dedups the
    // completed phases via shouldRunPhase.
    const db = makeMockDb("plan");
    const done = new Set(["custom:discover", "custom:plan"]);
    vi.mocked(db.executions.shouldRunPhase).mockImplementation((skill: string) =>
      done.has(skill) ? "done" : "run",
    );
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("implement done"))
      .mockResolvedValueOnce(makeSuccessResult("ship done"));

    const result = await runWorkflow(workflow, BASE_CTX, {} as never, {}, db, undefined, undefined, "wf-custom-resume");
    expect(result.success).toBe(true);
    // Only implement + ship actually dispatched an agent — discover + plan deduped.
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
    const startedSkills = vi.mocked(db.executions.recordStart).mock.calls.map((c) => c[0].skill);
    expect(startedSkills).toContain("custom:implement");
    expect(startedSkills).toContain("custom:ship");
    expect(startedSkills).not.toContain("custom:discover");
    expect(startedSkills).not.toContain("custom:plan");
  });

  it("renders phase.messages.on_start through the template engine", async () => {
    const workflow: AgentWorkflowDefinition = {
      kind: "agent",
      name: "msg-test",
      phases: [
        { name: "phase_0", type: "context" },
        {
          name: "step",
          type: "agent",
          prompt: "prompts/step.md",
          messages: {
            on_start: "starting {{step}} for #{{issueNumber}}",
            on_success: "finished",
          },
        },
      ],
    };
    mockExecuteAgent.mockResolvedValueOnce(makeSuccessResult("ok"));
    const comments: string[] = [];
    const ctx = { ...BASE_CTX, step: "step" };
    await runWorkflow(workflow, ctx, {} as never, {
      postComment: async (m) => { comments.push(m); },
    });
    expect(comments).toContain("starting step for #42");
    expect(comments).toContain("finished");
  });

  it("uses the definition name as the dedup key prefix", async () => {
    const workflow: AgentWorkflowDefinition = {
      kind: "agent",
      name: "my-custom-workflow",
      phases: [
        { name: "phase_0", type: "context" },
        { name: "solo", type: "agent", prompt: "prompts/solo.md" },
      ],
    };
    mockExecuteAgent.mockResolvedValueOnce(makeSuccessResult("done"));
    const db = makeMockDb("phase_0");
    const shouldRunPhase = vi.mocked(db.executions.shouldRunPhase);
    await runWorkflow(workflow, BASE_CTX, {} as never, {}, db, undefined, undefined, "wf-dedup-1");
    expect(shouldRunPhase).toHaveBeenCalledWith(
      "my-custom-workflow:solo",
      expect.any(String),
      "wf-dedup-1",
    );
  });

  it("exposes reviewer loop output via output_var for downstream templates", async () => {
    const workflow: AgentWorkflowDefinition = {
      kind: "agent",
      name: "review-then-summarize",
      phases: [
        { name: "phase_0", type: "context" },
        { name: "executor", type: "agent", prompt: "prompts/executor.md" },
        {
          name: "reviewer",
          type: "agent",
          prompt: "prompts/reviewer.md",
          output_var: "review",
          loop: {
            max_cycles: 1,
            on_request_changes: {
              fix_prompt: "prompts/fix.md",
              re_review_prompt: "prompts/re-reviewer.md",
            },
          },
        },
        { name: "summary", type: "agent", prompt: "prompts/summary.md" },
      ],
    };
    mockLoadPromptTemplate.mockImplementation((p: string) =>
      p === "prompts/summary.md" ? "approved={{review.approved}} cycles={{review.cycles}}" : `TEMPLATE:${p}`,
    );
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("executor"))
      .mockResolvedValueOnce(makeSuccessResult("VERDICT: APPROVED"))
      .mockResolvedValueOnce(makeSuccessResult("summary ok"));
    await runWorkflow(workflow, BASE_CTX, {} as never, {});
    const summaryCall = mockExecuteAgent.mock.calls[2][0];
    expect(summaryCall).toContain("approved=true");
    expect(summaryCall).toContain("cycles=0");
  });
});

describe("runWorkflow — DAG unexpected throws", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("unexpected throw in executeAgent marks phase failed and overall success=false", async () => {
    // architect succeeds, executor_a throws (unexpected exception, not a normal fail result)
    mockExecuteAgent
      .mockResolvedValueOnce(makeSuccessResult("architect done")) // architect
      .mockRejectedValueOnce(new Error("OOM: process killed"))   // executor_a throws
      .mockResolvedValue(makeSuccessResult("done"));              // executor_b and any others

    const result = await runWorkflow(PARALLEL_WORKFLOW, BASE_CTX, {} as never, {});

    // Overall workflow must report failure — not silently succeed
    expect(result.success).toBe(false);
    // The failed phase must appear in phases[] with success=false
    const failedPhase = result.phases.find((p) => p.phase === "executor_a");
    expect(failedPhase).toBeDefined();
    expect(failedPhase?.success).toBe(false);
    // merge depends on both executor_a and executor_b — executor_a failed, so merge is skipped
    const mergePhase = result.phases.find((p) => p.phase === "merge");
    expect(mergePhase?.output).toContain("Skipped");
  });
});

describe("gitAccessProfileForWorkflow — security workflows", () => {
  it("returns issues-write for security-review", () => {
    expect(gitAccessProfileForWorkflow("security-review")).toBe("issues-write");
  });

  it("returns repo-write for security-feedback", () => {
    expect(gitAccessProfileForWorkflow("security-feedback")).toBe("repo-write");
  });

  it("returns read for unknown workflow", () => {
    expect(gitAccessProfileForWorkflow("unknown-workflow")).toBe("read");
  });
});

describe("gitSandboxAccessForWorkflow — App PEM never enters the sandbox", () => {
  // The github extension skips (pem-unreadable) instead of falling back to
  // GITHUB_TOKEN when App creds are present but the PEM is unreadable in the
  // sandbox. The harness mints a scoped token, so we never forward App creds.
  it.each(["build", "pr-fix", "security-feedback", "pr-review", "issue-triage"])(
    "sets allowMcpAppAuth=false for %s (even repo-write)",
    (wf) => {
      const access = gitSandboxAccessForWorkflow(wf, "owner", "repo");
      expect(access.allowMcpAppAuth).toBe(false);
    },
  );
});

describe("gitSandboxAccessForWorkflow — recreate-from-base (issue #153)", () => {
  it("sets recreateFromBase for build", () => {
    expect(gitSandboxAccessForWorkflow("build", "owner", "repo").recreateFromBase).toBe(true);
  });

  it.each(["pr-review", "pr-fix", "issue-triage", "verify", "qa-test"])(
    "leaves recreateFromBase falsy for %s (reuse/refresh or in-session clone)",
    (wf) => {
      expect(gitSandboxAccessForWorkflow(wf, "owner", "repo").recreateFromBase).toBeFalsy();
    },
  );
});

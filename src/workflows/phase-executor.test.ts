import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentWorkflowDefinition, PhaseDefinition } from "./schema.js";
import type { TemplateContext } from "./templates.js";
import type { StateDb } from "../state/db.js";
import type { DagNode } from "./dag.js";
import type { PhaseResult } from "./runner.js";

// Mock the executor so we don't make real agent calls.
vi.mock("../engine/agent-executor.js", () => ({
  executeAgent: vi.fn(),
}));
vi.mock("../admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
}));
vi.mock("./loader.js", () => ({
  loadPromptTemplate: vi.fn((path: string) => `TEMPLATE:${path}`),
  resolveSkillPaths: vi.fn(() => undefined),
}));
vi.mock("child_process", () => ({ execSync: vi.fn() }));

import { executeAgent } from "../engine/agent-executor.js";
import { listRunningContainers } from "../admin/docker.js";
import {
  PhaseExecutor,
  type PhaseReporter,
  type PhaseResolver,
  type PhaseRunContext,
} from "./phase-executor.js";

const mockExecuteAgent = vi.mocked(executeAgent);

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

interface RecordedStep {
  key: string;
  status: string;
  template?: string;
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
    step: vi.fn(async (key, status, template) => {
      steps.push({ key, status, template });
    }),
    message: vi.fn(async (template) => {
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
});

import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentWorkflowDefinition } from "#src/workflows/schema.js";
import type { TemplateContext } from "#src/workflows/templates.js";

// Same mock surface as runner.test.ts: `executeCommand` backs the in-sandbox
// `until_bash` check, `executeAgent` backs each loop iteration.
vi.mock("#src/engine/agent-executor.js", () => ({
  executeAgent: vi.fn(),
  executeCommand: vi.fn(),
}));
vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
}));
vi.mock("#src/workflows/loader.js", () => ({
  loadPromptTemplate: vi.fn((path: string) => `TEMPLATE:${path}`),
}));
vi.mock("child_process", () => ({ execSync: vi.fn() }));

import { executeAgent, executeCommand } from "#src/engine/agent-executor.js";
import { runWorkflow } from "#src/workflows/runner.js";

const mockExecuteAgent = vi.mocked(executeAgent);
const mockExecuteCommand = vi.mocked(executeCommand);

const CTX: TemplateContext = {
  owner: "acme",
  repo: "widget",
  issueNumber: 7,
  issueTitle: "Bump lodash",
  issueBody: "",
  issueLabels: [],
  commentBody: "",
  sender: "dependabot[bot]",
  branch: "dependabot/npm_and_yarn/lodash-4.17.21",
  taskId: "widget-7-fix",
  issueDir: ".lastlight/issue-7",
  bootstrapLabel: "lastlight:bootstrap",
};

const ok = (output: string) => ({ success: true, output, error: undefined, turns: 3, durationMs: 10 });
const cmdOk = () => ({ success: true, output: "", turns: 0, durationMs: 1 });
const cmdFail = () => ({ success: false, output: "", error: "exit 1", turns: 0, durationMs: 1 });

const MARKER = "CI_FIX_COMPLETE";

function gatedLoopWorkflow(maxIterations = 2): AgentWorkflowDefinition {
  return {
    kind: "pr-fix",
    name: "gate-loop",
    phases: [
      { name: "phase_0", type: "context" },
      {
        name: "fix",
        type: "agent",
        prompt: "prompts/fix.md",
        timeout_seconds: 900,
        on_output: { requires_marker: MARKER },
        messages: {
          on_start: "On it — fixing PR #{{prNumber}}...",
          on_success: "**Fix pushed** to `{{branch}}`.",
          on_failure: "**Couldn't auto-fix** — gave up after {{maxIterations}} local iterations.",
        },
        generic_loop: {
          max_iterations: maxIterations,
          until_bash: "if [ -f .lastlight-verify.sh ]; then sh .lastlight-verify.sh; else exit 1; fi",
          interactive: false,
          fresh_context: false,
        },
      },
    ],
  };
}

/**
 * The `fix` phase of both fix workflows is a `generic_loop` AND carries the
 * `CI_FIX_COMPLETE` postcondition. A loop node used to evaluate neither
 * `on_output` nor `messages.on_success`/`on_start`, so bolting the gate loop
 * onto the phase would have silently dropped the postcondition the marker was
 * added to enforce (and the two notifications the phase declares).
 */
describe("generic_loop — postcondition + phase messages", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("passes when the last iteration signs off with the marker", async () => {
    mockExecuteAgent.mockResolvedValueOnce(ok(`fixed the lockfile\n${MARKER}: pr=7 attempt=1 outcome=pushed tried=regen gate=green`));
    mockExecuteCommand.mockResolvedValueOnce(cmdOk());

    const result = await runWorkflow(gatedLoopWorkflow(), CTX, {} as never, {});

    expect(result.success).toBe(true);
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
  });

  it("fails the phase when the loop ends with no marker at all", async () => {
    // The silent no-op: the agent talks about the PR, never reaches an outcome,
    // and without the postcondition the run would report green.
    mockExecuteAgent.mockResolvedValue(ok("I had a look and things seem complicated."));
    mockExecuteCommand.mockResolvedValue(cmdFail());

    const result = await runWorkflow(gatedLoopWorkflow(), CTX, {} as never, {});

    expect(result.success).toBe(false);
    const failed = result.phases.find((p) => p.success === false);
    expect(failed?.error).toContain(`missing completion marker "${MARKER}"`);
  });

  it("accepts a gave-up sign-off after the gate stayed red to the last iteration", async () => {
    // Running out of iterations is NOT a malfunction — `outcome=gave-up` is a
    // correct outcome, and dispatch-time escalation owns what happens next.
    mockExecuteAgent
      .mockResolvedValueOnce(ok("attempt 1: still red"))
      .mockResolvedValueOnce(ok(`still red\n${MARKER}: pr=7 attempt=1 outcome=gave-up tried=bump gate=red`));
    mockExecuteCommand.mockResolvedValue(cmdFail());

    const result = await runWorkflow(gatedLoopWorkflow(), CTX, {} as never, {});

    expect(result.success).toBe(true);
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
  });

  it("checks the LAST iteration, not an earlier one", async () => {
    // Iteration 1 signing off is meaningless if iteration 2 then wanders off.
    mockExecuteAgent
      .mockResolvedValueOnce(ok(`${MARKER}: pr=7 attempt=1 outcome=no-change tried=none gate=red`))
      .mockResolvedValueOnce(ok("...and then I got distracted"));
    mockExecuteCommand.mockResolvedValue(cmdFail());

    const result = await runWorkflow(gatedLoopWorkflow(), CTX, {} as never, {});

    expect(result.success).toBe(false);
  });

  it("posts the phase's on_start and on_success messages", async () => {
    mockExecuteAgent.mockResolvedValueOnce(ok(`done\n${MARKER}: pr=7 attempt=1 outcome=pushed tried=x gate=green`));
    mockExecuteCommand.mockResolvedValueOnce(cmdOk());

    const comments: string[] = [];
    await runWorkflow({ ...gatedLoopWorkflow(), name: "gate-loop-msgs" }, { ...CTX, prNumber: 7 }, {} as never, {
      postComment: async (msg) => { comments.push(msg); },
    });

    expect(comments.join("\n")).toContain("On it — fixing PR #7...");
    expect(comments.join("\n")).toContain("**Fix pushed** to `dependabot/npm_and_yarn/lodash-4.17.21`.");
  });

  it("posts on_failure when the gate never goes green", async () => {
    mockExecuteAgent.mockResolvedValue(ok(`${MARKER}: pr=7 attempt=1 outcome=gave-up tried=x gate=red`));
    mockExecuteCommand.mockResolvedValue(cmdFail());

    const comments: string[] = [];
    await runWorkflow({ ...gatedLoopWorkflow(), name: "gate-loop-red" }, CTX, {} as never, {
      postComment: async (msg) => { comments.push(msg); },
    });

    expect(comments.join("\n")).toContain("gave up after 2 local iterations");
  });

  it("threads the phase timeout_seconds into the until_bash check", async () => {
    mockExecuteAgent.mockResolvedValueOnce(ok(`${MARKER}: pr=7 attempt=1 outcome=pushed tried=x gate=green`));
    mockExecuteCommand.mockResolvedValueOnce(cmdOk());

    await runWorkflow(gatedLoopWorkflow(), CTX, {} as never, {});

    // The trap `runUntilBash` sets: without an explicit value it passes 30s and
    // kills a real test suite mid-run, reporting a false red.
    const opts = mockExecuteCommand.mock.calls[0]?.[2] as { timeoutSeconds?: number } | undefined;
    expect(opts?.timeoutSeconds).toBe(900);
  });
});

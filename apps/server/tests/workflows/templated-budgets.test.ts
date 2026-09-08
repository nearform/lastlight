import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentWorkflowDefinition } from "#src/workflows/schema.js";
import type { TemplateContext } from "#src/workflows/templates.js";

// Same mock surface as generic-loop-postcondition.test.ts: `executeCommand`
// backs the in-sandbox `until_bash` gate, `executeAgent` backs each iteration.
vi.mock("#src/engine/agent-executor.js", () => ({
  executeAgent: vi.fn(),
  executeCommand: vi.fn(),
}));
vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
}));
// PARTIAL — only the template load is faked. The runner now derives each
// workflow's runtime policy off the real loaded definitions (issue #368), so
// `listAgentWorkflows` / `getAssetVersion` must stay real.
vi.mock("#src/workflows/loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/workflows/loader.js")>()),
  loadPromptTemplate: vi.fn((path: string) => `TEMPLATE:${path}`),
}));
vi.mock("child_process", () => ({ execSync: vi.fn() }));

import { executeAgent, executeCommand } from "#src/engine/agent-executor.js";
import { runWorkflow } from "#src/workflows/runner.js";
import { defaultFixConfig } from "lastlight-shared/config-types";

const mockExecuteAgent = vi.mocked(executeAgent);
const mockExecuteCommand = vi.mocked(executeCommand);

const BASE_CTX: TemplateContext = {
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

const MARKER = "CI_FIX_COMPLETE";
const ok = (output: string) => ({ success: true, output, error: undefined, turns: 3, durationMs: 10 });
const cmdFail = () => ({ success: false, output: "", error: "exit 1", turns: 0, durationMs: 1 });

/** The shape both fix workflows ship: both budgets read off the `fix` block. */
function budgetedWorkflow(name = "budgeted-loop"): AgentWorkflowDefinition {
  return {
    kind: "pr-fix",
    name,
    phases: [
      {
        name: "fix",
        type: "agent",
        prompt: "prompts/fix.md",
        timeout_seconds: { from: "fix.gateTimeoutSeconds", default: 900 },
        generic_loop: {
          max_iterations: { from: "fix.localIterations", default: 2 },
          until_bash: "bash .git/lastlight-verify.sh",
          interactive: false,
          fresh_context: false,
        },
      },
    ],
  };
}

/** The `timeoutSeconds` the `until_bash` check was actually given. */
function gateTimeout(): number | undefined {
  const opts = mockExecuteCommand.mock.calls[0]?.[2] as { timeoutSeconds?: number } | undefined;
  return opts?.timeoutSeconds;
}

/**
 * `fix.localIterations` and `fix.gateTimeoutSeconds` were parsed, typed,
 * per-repo clamped, CLI-displayed and documented — and read by nothing
 * (#256). The operative numbers were literals in the workflow YAML, whose
 * comments asked a human to keep the two in step. These tests pin the wiring
 * that closed that: the literal is now the declared fallback and the run's
 * EFFECTIVE (already repo-clamped) config block is the value.
 */
describe("phase budgets resolved from the run's fix config", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The gate never goes green, so the loop always runs to its bound — which
    // is the number under test.
    mockExecuteAgent.mockResolvedValue(ok(`${MARKER}: pr=7 attempt=1 outcome=gave-up tried=x gate=red`));
    mockExecuteCommand.mockResolvedValue(cmdFail());
  });

  it("holds the loop to the repo-clamped localIterations, not the YAML literal", async () => {
    const ctx = { ...BASE_CTX, fix: { ...defaultFixConfig(), localIterations: 1 } };

    await runWorkflow(budgetedWorkflow("budget-lower"), ctx, {} as never, {});

    // 1, not the packaged 2: a repo that asked for a shorter loop gets one.
    expect(mockExecuteAgent).toHaveBeenCalledTimes(1);
  });

  it("bounds the gate with the config's gateTimeoutSeconds", async () => {
    const ctx = { ...BASE_CTX, fix: { ...defaultFixConfig(), gateTimeoutSeconds: 1800 } };

    await runWorkflow(budgetedWorkflow("budget-timeout"), ctx, {} as never, {});

    expect(gateTimeout()).toBe(1800);
  });

  it("falls back to the packaged value when the context carries no fix block", async () => {
    // A manual trigger, or a run resumed from a row written before the block
    // existed. The fallback must be the generous packaged one: `runUntilBash`
    // otherwise passes 30s, which kills a real test suite mid-run and reports
    // a false red.
    await runWorkflow(budgetedWorkflow("budget-absent"), BASE_CTX, {} as never, {});

    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
    expect(gateTimeout()).toBe(900);
  });

  it("refuses a nonsense value rather than running an unbounded or zero loop", async () => {
    // `0` iterations would skip the fix entirely and `-1` is meaningless; both
    // must land on the declared fallback, not on themselves.
    const ctx = {
      ...BASE_CTX,
      fix: { ...defaultFixConfig(), localIterations: 0, gateTimeoutSeconds: -5 },
    };

    await runWorkflow(budgetedWorkflow("budget-nonsense"), ctx, {} as never, {});

    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
    expect(gateTimeout()).toBe(900);
  });

  it("rounds a fractional duration UP", async () => {
    // `gateTimeoutSeconds` is documented as accepting any positive number (it
    // is a duration, not a count), but the phase field is an integer. Rounding
    // down is the one direction that can turn a passing gate red.
    const ctx = { ...BASE_CTX, fix: { ...defaultFixConfig(), gateTimeoutSeconds: 90.5 } };

    await runWorkflow(budgetedWorkflow("budget-fractional"), ctx, {} as never, {});

    expect(gateTimeout()).toBe(91);
  });

  it("still accepts a plain number — every other workflow's loops are untouched", async () => {
    const def = budgetedWorkflow("budget-literal");
    def.phases[0].timeout_seconds = 120;
    def.phases[0].generic_loop!.max_iterations = 3;

    await runWorkflow(def, BASE_CTX, {} as never, {});

    expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
    expect(gateTimeout()).toBe(120);
  });
});

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
import { defaultGateConfig, defaultSandboxTimeouts } from "#src/config/config.js";
import { resolveTemplatedNumber, AgentWorkflowSchema } from "lastlight-workflow-engine";

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

/**
 * The shape both fix workflows ship: the loop bound off the `fix` block, the
 * gate budget off the run's `gate` block with no YAML fallback (issue #385).
 */
function budgetedWorkflow(name = "budgeted-loop"): AgentWorkflowDefinition {
  return {
    kind: "pr-fix",
    name,
    phases: [
      {
        name: "fix",
        type: "agent",
        prompt: "prompts/fix.md",
        timeout_seconds: { from: "gate.timeoutSeconds" },
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

  it("bounds the gate with the run's gate.timeoutSeconds", async () => {
    const ctx = { ...BASE_CTX, gate: { ...defaultGateConfig(), timeoutSeconds: 1800 } };

    await runWorkflow(budgetedWorkflow("budget-timeout"), ctx, {} as never, {});

    expect(gateTimeout()).toBe(1800);
  });

  it("backfills the gate from RESOLVED config when the context carries no gate block", async () => {
    // A manual trigger, or a run resumed from a row written before the block
    // existed. `runWorkflow` seeds the operator's resolved gate block (issue
    // #385) — a config value, never a YAML or code literal — so the gate still
    // gets the generous budget rather than the short until_bash default.
    await runWorkflow(budgetedWorkflow("budget-absent"), BASE_CTX, {} as never, {});

    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
    expect(gateTimeout()).toBe(defaultGateConfig().timeoutSeconds);
  });

  it("refuses a nonsense iteration count rather than running an unbounded or zero loop", async () => {
    // `0` iterations would skip the fix entirely; it must land on the declared
    // fallback, not on itself.
    const ctx = { ...BASE_CTX, fix: { ...defaultFixConfig(), localIterations: 0 } };

    await runWorkflow(budgetedWorkflow("budget-nonsense"), ctx, {} as never, {});

    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
  });

  it("fails the phase on a nonsense gate budget — there is no fallback to land on (#385)", async () => {
    const ctx = { ...BASE_CTX, gate: { ...defaultGateConfig(), timeoutSeconds: -5 } };

    const result = await runWorkflow(budgetedWorkflow("budget-nonsense-gate"), ctx, {} as never, {});

    expect(result.success).toBe(false);
    expect(mockExecuteCommand).not.toHaveBeenCalled();
    expect(JSON.stringify(result.phases)).toContain("gate.timeoutSeconds");
  });

  it("rounds a fractional duration UP", async () => {
    // `gate.timeoutSeconds` accepts any positive number (it is a duration, not
    // a count), but the phase field is an integer. Rounding down is the one
    // direction that can turn a passing gate red.
    const ctx = { ...BASE_CTX, gate: { ...defaultGateConfig(), timeoutSeconds: 90.5 } };

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

/**
 * Issue #385 — every timeout comes from config. A `{ from }` with no `default`
 * must fail loudly when the key is missing; the `until_bash` check with no
 * `timeout_seconds` reads `timeouts.untilBashSeconds` instead of a literal 30.
 */
describe("config-only budgets (#385)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockExecuteAgent.mockResolvedValue(ok(`${MARKER}: pr=7 attempt=1 outcome=gave-up tried=x gate=red`));
    mockExecuteCommand.mockResolvedValue(cmdFail());
  });

  it("resolveTemplatedNumber throws, naming the key, when { from } has no default and the key is missing", () => {
    // A FRESH context: `runWorkflow` backfills `gate`/`timeouts` onto the context
    // it is handed (issue #385), so the shared BASE_CTX may already carry them.
    const bare = { owner: "acme", repo: "widget" } as unknown as TemplateContext;
    expect(() => resolveTemplatedNumber({ from: "gate.timeoutSeconds" }, bare, "guardrails_gate.timeout_seconds")).toThrow(
      /guardrails_gate\.timeout_seconds: `from: gate\.timeoutSeconds` did not resolve/,
    );
    expect(() =>
      resolveTemplatedNumber({ from: "gate.timeoutSeconds" }, { ...bare, gate: { timeoutSeconds: 0 } }, "x"),
    ).toThrow(/gate\.timeoutSeconds/);
  });

  it("resolveTemplatedNumber resolves { from } with no default when the key is present", () => {
    expect(resolveTemplatedNumber({ from: "gate.timeoutSeconds" }, { ...BASE_CTX, gate: { timeoutSeconds: 900 } }, "x")).toBe(900);
  });

  it("the workflow schema accepts { from } without default", () => {
    const parsed = AgentWorkflowSchema.safeParse({
      kind: "build",
      name: "from-only",
      phases: [{ name: "g", type: "bash", command: "true", timeout_seconds: { from: "gate.phaseTimeoutSeconds" } }],
    });
    expect(parsed.success).toBe(true);
  });

  function untimedLoop(name: string): AgentWorkflowDefinition {
    const def = budgetedWorkflow(name);
    delete def.phases[0].timeout_seconds;
    def.phases[0].generic_loop!.max_iterations = 1;
    return def;
  }

  it("an until_bash with no timeout_seconds takes timeouts.untilBashSeconds from the run context", async () => {
    const ctx = { ...BASE_CTX, timeouts: { agentSeconds: 1800, commandSeconds: 300, untilBashSeconds: 45 } };
    await runWorkflow(untimedLoop("until-ctx"), ctx, {} as never, {});
    expect(gateTimeout()).toBe(45);
  });

  it("an until_bash with no timeout_seconds and no context timeouts gets sandbox.untilBashTimeoutSeconds from resolved config", async () => {
    // `runWorkflow` backfills `timeouts` from the operator's resolved `sandbox:`
    // block for callers that build their own context (issue #385) — so this is
    // the CONFIG value, not a literal. The engine's own loud failure when a
    // context carries neither is pinned at the engine layer.
    await runWorkflow(untimedLoop("until-missing"), BASE_CTX, {} as never, {});
    expect(gateTimeout()).toBe(defaultSandboxTimeouts().untilBashTimeoutSeconds);
  });

  it("a timeout_seconds { from } with no default and a missing key fails the phase", async () => {
    const def = budgetedWorkflow("from-missing");
    // A key nothing seeds — `gate.*` / `timeouts.*` are backfilled by the runner.
    def.phases[0].timeout_seconds = { from: "fix.noSuchTimeoutSeconds" };
    const result = await runWorkflow(def, BASE_CTX, {} as never, {});
    expect(result.success).toBe(false);
    expect(JSON.stringify(result.phases)).toContain("fix.noSuchTimeoutSeconds");
  });
});

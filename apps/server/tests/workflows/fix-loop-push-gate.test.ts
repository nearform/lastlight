import { describe, it, expect, vi, beforeEach } from "vitest";
import type { AgentWorkflowDefinition } from "#src/workflows/schema.js";
import type { TemplateContext } from "#src/workflows/templates.js";

// Same mock surface as runner.test.ts: `executeCommand` backs the in-sandbox
// `until_bash` gate, `executeAgent` backs each loop iteration.
vi.mock("#src/engine/agent-executor.js", () => ({
  executeAgent: vi.fn(),
  executeCommand: vi.fn(),
}));
vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
}));
// Only `loadPromptTemplate` is stubbed — `getWorkflow` stays REAL, because the
// point of this suite is the behaviour of the shipped YAML, not of a fixture
// that happens to resemble it.
vi.mock("#src/workflows/loader.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("#src/workflows/loader.js")>()),
  loadPromptTemplate: vi.fn((path: string) => `TEMPLATE:${path}`),
}));
vi.mock("child_process", () => ({ execSync: vi.fn() }));

import { executeAgent, executeCommand } from "#src/engine/agent-executor.js";
import { getWorkflow } from "#src/workflows/loader.js";
import { runWorkflow } from "#src/workflows/runner.js";
import { PR_FIX_SHAPED_WORKFLOWS } from "#src/workflows/target-policy.js";
import { renderAttemptLine } from "#src/engine/fix-markers.js";
import { VERIFY_SCRIPT_NAME } from "#src/engine/fix-scratch.js";

const mockExecuteAgent = vi.mocked(executeAgent);
const mockExecuteCommand = vi.mocked(executeCommand);

const CTX: TemplateContext = {
  owner: "acme",
  repo: "widget",
  issueNumber: 1016,
  prNumber: 1016,
  issueTitle: "Bump lodash from 4.17.20 to 4.17.21",
  issueBody: "",
  issueLabels: [],
  commentBody: "",
  sender: "dependabot[bot]",
  branch: "dependabot/npm_and_yarn/lodash-4.17.21",
  taskId: "widget-1016-fix",
  issueDir: ".lastlight/issue-1016",
  bootstrapLabel: "lastlight:bootstrap",
} as TemplateContext;

const ok = (output: string) => ({ success: true, output, error: undefined, turns: 3, durationMs: 10 });
const cmdFail = () => ({ success: false, output: "", error: "exit 1", turns: 0, durationMs: 1 });

const DIAGNOSIS = "DIAGNOSIS_COMPLETE: pr=1016 attempt=1 class=reproducible cause=stale lockfile ci_vs_local=none unreproducible=none";

/** A real `CI_FIX_COMPLETE` line, exactly as `skills/fixing/SKILL.md` asks. */
const fixMarker = (outcome: string, gate: string) =>
  `CI_FIX_COMPLETE: pr=1016 attempt=1 outcome=${outcome} tried=regenerated the lockfile gate=${gate}`;

/**
 * How many times the harness ran the local build/test gate. Every other
 * `executeCommand` call in a fix run would be a `type: bash` phase, and neither
 * fix workflow has one — but keying on the gate script rather than on the call
 * count keeps this honest if one is ever added.
 */
function gateRuns(): number {
  return mockExecuteCommand.mock.calls.filter((c) => {
    const step = c[0] as { command?: string } | undefined;
    return typeof step?.command === "string" && step.command.includes(VERIFY_SCRIPT_NAME);
  }).length;
}

/**
 * The shipped fix workflow, with its `skip_if` rows dropped.
 *
 * Those rows read `scratch.fixMarkers.diagnosis.class`, which the marker
 * harvest writes through `onPhaseEnd` in `index.ts` — a wiring this bare
 * `runWorkflow` harness doesn't have. An absent variable fails OPEN, so the
 * phase would run anyway; removing them says so out loud rather than relying on
 * it.
 */
function fixWorkflow(name: string): AgentWorkflowDefinition {
  const def = structuredClone(getWorkflow(name)) as AgentWorkflowDefinition;
  for (const phase of def.phases) delete phase.skip_if;
  return { ...def, name: `${name}-under-test` };
}

/**
 * The within-run local gate loop, from the far side: what the harness actually
 * *does* with a `CI_FIX_COMPLETE` outcome.
 *
 * Asserted across the whole fix-shaped family, like the rest of this loop's
 * contract — the two workflows are one family and a short-circuit on only one
 * of them is a short-circuit an `@bot fix this` comment routes around.
 */
describe.each([...PR_FIX_SHAPED_WORKFLOWS])("%s — the gate loop's push short-circuit", (name) => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does NOT re-run the gate once the agent has pushed", async () => {
    // The production shape (run `49c101aa`): the agent ran the full suite
    // itself, pushed, and reported `gate=green`. GitHub's checks are already
    // running on that commit and are the better authority — a fresh container
    // re-running a slower copy of the same suite can't change anything, because
    // all the gate's exit code decides is whether to spend ANOTHER iteration,
    // and a pushed fix has nothing left to iterate on.
    mockExecuteAgent
      .mockResolvedValueOnce(ok(`diagnosed\n${DIAGNOSIS}`))
      .mockResolvedValueOnce(ok(`regenerated the lockfile and pushed\n${fixMarker("pushed", "green")}`));
    mockExecuteCommand.mockResolvedValue(cmdFail());

    const result = await runWorkflow(fixWorkflow(name), CTX, {} as never, {});

    expect(result.success).toBe(true);
    expect(gateRuns()).toBe(0);
    // …and one fix iteration, not two: the loop completed rather than falling
    // through to a red gate and spending the second.
    expect(mockExecuteAgent).toHaveBeenCalledTimes(2);
  });

  it.each(["no-change", "gave-up"])(
    "DOES run the gate when the agent pushed nothing (outcome=%s)",
    async (outcome) => {
      // Nothing was pushed, so there is no new commit, no new check run and no
      // external authority. The local gate is the only evidence that exists,
      // and its RED verdict is exactly what earns the agent the next iteration.
      mockExecuteAgent
        .mockResolvedValueOnce(ok(`diagnosed\n${DIAGNOSIS}`))
        .mockResolvedValue(ok(`still red\n${fixMarker(outcome, "red")}`));
      mockExecuteCommand.mockResolvedValue(cmdFail());

      const result = await runWorkflow(fixWorkflow(name), CTX, {} as never, {});

      // Running out of iterations is not a malfunction — the sign-off is there.
      expect(result.success).toBe(true);
      // Two iterations (the packaged `fix.localIterations` fallback), each
      // gated. If the short-circuit ever widened to every outcome this would
      // be 1 gate run and 1 iteration, and `fix.localIterations` would have
      // quietly become dead config.
      expect(gateRuns()).toBe(2);
      expect(mockExecuteAgent).toHaveBeenCalledTimes(3);
    },
  );

  it("is not tripped by a replayed {{priorAttempts}} line from an earlier attempt", async () => {
    // The journal line an earlier attempt left behind carries `outcome=pushed`
    // and is replayed into this prompt, so an agent quoting it back would match
    // a bare `output.contains('outcome=pushed')`. `renderAttemptLine` never
    // renders `tried=`, which is why the needle does.
    const replayed = renderAttemptLine(1, {
      diagnosis: {
        pr: 1016, attempt: 1, class: "env-mismatch", rawClass: "env-mismatch",
        cause: "node 22 vs 20", ciVsLocal: "node version", unreproducible: [],
      },
      fix: { pr: 1016, attempt: 1, outcome: "pushed", rawOutcome: "pushed", tried: "bump", gate: "green", rawGate: "green" },
    })!;
    expect(replayed).toContain("outcome=pushed");

    mockExecuteAgent
      .mockResolvedValueOnce(ok(`diagnosed\n${DIAGNOSIS}`))
      .mockResolvedValue(ok(`last time: "${replayed}" — this time I changed nothing.\n${fixMarker("no-change", "red")}`));
    mockExecuteCommand.mockResolvedValue(cmdFail());

    await runWorkflow(fixWorkflow(name), CTX, {} as never, {});

    expect(gateRuns()).toBe(2);
  });
});

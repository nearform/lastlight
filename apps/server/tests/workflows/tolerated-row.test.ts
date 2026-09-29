import { describe, it, expect } from "vitest";
import { runWorkflowCore, AgentWorkflowSchema } from "lastlight-workflow-engine";
import type {
  ExecutorConfig,
  GitSandboxAccess,
  PhaseResolver,
  PhaseResult,
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
 * The workflow verdict and a fan-out's TOLERATED rows.
 *
 * A fan-out reports every branch as its own row, and the scheduler used to fail
 * the workflow on any failed row — so one site investigator's provider 404 marked
 * a pr-review run `failed` after it had posted (eval band 2026-09-29,
 * sentry-greptile-1). In production a failed run leaves the head unassessed
 * (`assessedHeadShaByWorkflow` counts succeeded runs only), and the review sweep
 * re-dispatches a full review. A row the phase tolerated stays `success: false`
 * — visible — but is not a workflow failure.
 */

const RUN_ID = "run-1";

const resolver: PhaseResolver = {
  modelFor: () => undefined,
  variantFor: () => undefined,
  renderPrompt: (p) => `PROMPT:${p}`,
  gateEnabled: () => false,
};

/** A fan-out stand-in that returns the rows it is given, and succeeds. */
function stubFanout(rows: PhaseResult[]): PhaseTypeHandler {
  return {
    async execute() {
      return { results: rows, status: "succeeded", outputVars: {} };
    },
  };
}

async function run(rows: PhaseResult[]) {
  const definition = AgentWorkflowSchema.parse({
    name: "wf",
    phases: [
      {
        name: "survey",
        type: "fanout",
        branches: [
          { name: "a", prompt: "prompts/a.md" },
          { name: "b", prompt: "prompts/b.md" },
        ],
      },
    ],
  });
  const store = new InMemoryStateStore(RUN_ID);
  const reporter = new RecordingReporter();
  const runScope: PhaseRunContext = {
    definition,
    ctx: { prNumber: 7 } as unknown as TemplateContext,
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
      agent: new FakeAgentPort(),
      assets: new StubAssetLoader(),
      liveness: noopLiveness,
      observability: noopObservability,
      handlers: new Map([["fanout", stubFanout(rows)]]),
    },
    store,
    reporterActive: false,
    capabilities: { qaImageAvailable: () => false, qaImageName: "lastlight-sandbox-qa:latest" },
  };
  return runWorkflowCore(runScope, deps);
}

describe("the workflow verdict — tolerated rows", () => {
  it("succeeds when the only failed row is one its phase tolerated, and keeps the row visible", async () => {
    const result = await run([
      { phase: "survey_branch_a", success: true, output: "ok" },
      { phase: "survey_branch_b", success: false, output: "", error: "404 status code (no body)", tolerated: true },
    ]);
    expect(result.success).toBe(true);
    expect(result.phases.find((p) => p.phase === "survey_branch_b")).toMatchObject({ success: false, tolerated: true });
  });

  it("still fails on a failed row that is not tolerated", async () => {
    const result = await run([
      { phase: "survey_branch_a", success: true, output: "ok" },
      { phase: "survey_branch_b", success: false, output: "", error: "boom" },
    ]);
    expect(result.success).toBe(false);
  });
});

import { describe, it, expect } from "vitest";
import { runWorkflowCore, AgentWorkflowSchema } from "lastlight-workflow-engine";
import type {
  AgentRunOpts,
  ExecutorConfig,
  ExecutionResult,
  GitSandboxAccess,
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
} from "lastlight-workflow-engine/test-support";

/**
 * A run cancelled while a phase is in flight stops at the next phase boundary.
 *
 * The production shape (nearform, 2026-09-29): a newer head superseded an
 * in-flight review, `supersedeRun` cancelled the row and killed the sandbox, and
 * the killed phase came back `exit 137`. The phase failure reached the runner's
 * `failWorkflow`, which flipped the row `cancelled` → `failed` — so the
 * scheduler's cancel check at the next boundary read `failed` and the dead run
 * went on through site-finalize, reconcile and post-review.
 */

const RUN_ID = "run-1";

const resolver: PhaseResolver = {
  modelFor: () => undefined,
  variantFor: () => undefined,
  renderPrompt: (p) => `PROMPT:${p}`,
  gateEnabled: () => false,
};

/** `runner.ts`'s `failWorkflow`: a phase failure finishes the row `failed`. */
class FailingReporter extends RecordingReporter {
  constructor(private readonly store: InMemoryStateStore) {
    super();
  }
  override async failWorkflow(errorMsg?: string): Promise<void> {
    await super.failWorkflow(errorMsg);
    await this.store.runs.finishRun(RUN_ID, "failed", { error: errorMsg });
  }
}

/** The second agent call is cancelled out from under it, and killed. */
class SupersededAgent extends FakeAgentPort {
  constructor(private readonly store: InMemoryStateStore) {
    super();
  }
  override async runAgent(prompt: string, config: ExecutorConfig, opts: AgentRunOpts): Promise<ExecutionResult> {
    const result = await super.runAgent(prompt, config, opts);
    if (this.calls.length !== 2) return result;
    await this.store.runs.finishRun(RUN_ID, "cancelled");
    return { success: false, error: "Sandbox agent failed (exit 137): no output", turns: 0, durationMs: 0 };
  }
}

describe("a run cancelled mid-phase", () => {
  it("stays cancelled and runs no further phase", async () => {
    const store = new InMemoryStateStore(RUN_ID);
    const agent = new SupersededAgent(store);
    const definition = AgentWorkflowSchema.parse({
      name: "review-flow",
      phases: [
        { name: "survey", prompt: "prompts/survey.md" },
        { name: "select", prompt: "prompts/select.md" },
        // `all_done`, like pr-review's tail: it would run after a failed
        // upstream — only the cancel check can stop it.
        { name: "finalize", prompt: "prompts/finalize.md", depends_on: ["select"], trigger_rule: "all_done" },
      ],
    });
    const runScope: PhaseRunContext = {
      definition,
      ctx: { prNumber: 7 } as unknown as TemplateContext,
      config: { sandbox: "none" } as unknown as ExecutorConfig,
      taskId: "task-1",
      triggerId: "acme/widgets#7",
      githubAccess: { owner: "acme", repo: "widgets", profile: "repo-write" } as GitSandboxAccess,
      scratch: {},
      store,
      workflowId: RUN_ID,
      botName: "last-light",
    };
    const deps: SchedulerDeps = {
      reporter: new FailingReporter(store),
      resolver,
      ports: { agent, assets: new StubAssetLoader(), liveness: noopLiveness, observability: noopObservability },
      store,
      reporterActive: false,
      capabilities: { qaImageAvailable: () => false, qaImageName: "lastlight-sandbox-qa:latest" },
    };

    const result = await runWorkflowCore(runScope, deps);

    expect(result.success).toBe(false);
    expect(agent.calls).toHaveLength(2);
    expect(result.phases.map((p) => p.phase)).toEqual(["survey", "select"]);
    expect((await store.runs.getRun(RUN_ID))?.status).toBe("cancelled");
  });
});

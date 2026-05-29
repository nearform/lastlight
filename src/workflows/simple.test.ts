import { describe, it, expect, vi, beforeEach } from "vitest";
import type { ExecutorConfig } from "../engine/profiles.js";
import type { StateDb } from "../state/db.js";
import type { AgentWorkflowDefinition } from "./schema.js";
import { runSimpleWorkflow } from "./simple.js";
import { getWorkflow } from "./loader.js";
import { runWorkflow } from "./runner.js";

vi.mock("./loader.js", () => ({
  getWorkflow: vi.fn(),
}));

vi.mock("./runner.js", () => ({
  runWorkflow: vi.fn(),
  nextPhaseAfter: vi.fn(),
}));

const WORKFLOW_AUTHOR: AgentWorkflowDefinition = {
  kind: "workflow-author",
  name: "workflow-author",
  phases: [
    { name: "author", type: "agent", prompt: "prompts/workflow-author.md" },
  ],
};

function makeDb() {
  return {
    isWorkflowEnabled: vi.fn(() => true),
    getWorkflowRunByTrigger: vi.fn(() => undefined),
    createWorkflowRun: vi.fn(),
    finishWorkflowRun: vi.fn(),
  } as unknown as StateDb & {
    createWorkflowRun: ReturnType<typeof vi.fn>;
  };
}

describe("runSimpleWorkflow — workflow-author prepopulation", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(getWorkflow).mockReturnValue(WORKFLOW_AUTHOR);
    vi.mocked(runWorkflow).mockResolvedValue({ success: true, phases: [] });
  });

  it("pre-populates workflow-author runs on the synthesized authoring branch", async () => {
    const db = makeDb();

    await runSimpleWorkflow(
      "workflow-author",
      {
        owner: "cliftonc",
        repo: "lastlight",
        issueNumber: 26,
        issueTitle: "Feature: dynamic workflow authoring",
        sender: "maintainer",
      },
      {} as ExecutorConfig,
      {},
      db,
    );

    const createdRun = db.createWorkflowRun.mock.calls[0][0];
    const createdContext = createdRun.context as Record<string, unknown>;
    expect(createdContext.branch).toBe("lastlight/26-feature-dynamic-workflow-authoring");
    expect(createdContext.prePopulateBranch).toBe(createdContext.branch);

    const runnerCtx = vi.mocked(runWorkflow).mock.calls[0][1] as Record<string, unknown>;
    expect(runnerCtx.prePopulateBranch).toBe(createdContext.branch);
  });
});

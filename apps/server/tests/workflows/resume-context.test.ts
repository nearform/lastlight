/**
 * A resumed run keeps the template context its dispatch rendered.
 *
 * Resume is not only boot recovery: an ADMISSION promotion (a run created
 * `queued` at the concurrency cap) and the dashboard's Retry both re-enter a
 * run through `resumeSimpleRun`. It used to rebuild only the base fields, so a
 * pr-review lost `analysisEnabled` and the PR snapshot, every analysis phase
 * skipped as "trigger rule not satisfied", and the light single-pass review
 * posted instead (nearform/lastlight#424).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

vi.mock("#src/engine/agent-executor.js", () => ({
  executeAgent: vi.fn(),
  executeCommand: vi.fn(),
}));

vi.mock("#src/admin/docker.js", () => ({
  listRunningContainers: vi.fn(async () => []),
}));

import { executeAgent } from "#src/engine/agent-executor.js";
import type { StateDb } from "#src/state/db.js";
import { makeTestDb } from "../helpers/state-db.js";
import { configureWorkflowAssets, clearWorkflowCache } from "#src/workflows/loader.js";
import { restoredDispatchContext, resumeSimpleRun, type ResumeOptions } from "#src/workflows/resume.js";
import type { ExecutorConfig } from "#src/engine/github/profiles.js";

const mockExecuteAgent = vi.mocked(executeAgent);

// One phase gated exactly like pr-review's analysis phases, whose prompt
// renders dispatch-time keys.
const YAML = `
kind: agent
name: pr-review
phases:
  - name: analysis
    label: Analysis
    prompt: prompts/analysis.md
    skip_if:
      - "analysisEnabled != true"
`;

function config(): ExecutorConfig {
  return {
    model: "anthropic/operator-default",
    stateDir: "/tmp",
    sandboxDir: "/tmp/sandboxes",
    sessionsDir: "/tmp/sessions",
    sandbox: "none",
    buildAssets: "repo",
  };
}

describe("resumeSimpleRun — the dispatch's template context survives", () => {
  let db: StateDb;

  beforeEach(async () => {
    const builtIn = mkdtempSync(join(tmpdir(), "lastlight-resume-ctx-"));
    mkdirSync(join(builtIn, "workflows", "prompts"), { recursive: true });
    writeFileSync(join(builtIn, "workflows", "pr-review.yaml"), YAML);
    writeFileSync(join(builtIn, "workflows", "prompts", "analysis.md"), "HEAD {{headSha}} · COMMENT {{commentBody}} · REPO {{repo}}");
    configureWorkflowAssets({ builtInRoot: builtIn });
    clearWorkflowCache();
    db = await makeTestDb();
    mockExecuteAgent.mockResolvedValue({ success: true, output: "done", error: undefined, turns: 1, durationMs: 1 });
  });

  afterEach(() => {
    configureWorkflowAssets();
    clearWorkflowCache();
    vi.clearAllMocks();
  });

  const opts = (): ResumeOptions => ({
    db,
    github: null,
    config: config(),
    models: { default: "anthropic/operator-default" },
    variants: {},
    approvalConfig: {},
  });

  it("an admitted/resumed pr-review still runs its analysis, with the PR snapshot rendered", async () => {
    await db.runs.createRun({
      id: "run-1",
      workflowName: "pr-review",
      triggerId: "acme/widgets#7",
      owner: "acme",
      repo: "widgets",
      issueNumber: 7,
      currentPhase: "analysis",
      status: "running",
      context: {
        kind: "agent",
        taskId: "widgets-7-pr-review",
        branch: "feature",
        issueDir: ".lastlight/pr-7",
        // What `renderContext` + the dispatch context put on the row.
        analysisEnabled: "true",
        headSha: "abc1234",
        commentBody: "@bot review please",
        repo: "acme/widgets",
      },
      startedAt: new Date().toISOString(),
    });

    await resumeSimpleRun((await db.runs.getRun("run-1"))!, opts());

    expect(mockExecuteAgent).toHaveBeenCalledOnce();
    // `repo` stays the BARE name resume derives — the dispatch's full name
    // would break every path built from it.
    expect(mockExecuteAgent.mock.calls[0]![0]).toBe("HEAD abc1234 · COMMENT @bot review please · REPO widgets");
    expect((await db.runs.getRun("run-1"))?.status).toBe("succeeded");
  });

  it("restoredDispatchContext keeps the template keys and drops what resume owns", () => {
    expect(
      restoredDispatchContext({
        analysisEnabled: "true",
        headSha: "abc",
        repo: "acme/widgets",
        taskId: "t",
        models: {},
        error: "old failure",
      }),
    ).toEqual({ analysisEnabled: "true", headSha: "abc" });
  });
});

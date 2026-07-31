/**
 * Resuming a run that carried a per-repo config layer (issue #180).
 *
 * A resume CONTINUES a run — boot orphan recovery, the dashboard's Retry, an
 * admission promotion — so it must keep executing under the config that run's
 * first dispatch resolved, not whatever the operator's boot config (or the
 * repo's default branch) says by the time it re-enters. These tests pin that,
 * plus the one thing that genuinely can't be pinned: the unpacked asset root,
 * whose cache may have been evicted while the run was away.
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
import { StateDb } from "#src/state/db.js";
import { configureWorkflowAssets, clearWorkflowCache } from "#src/workflows/loader.js";
import { resumeSimpleRun, type ResumeOptions } from "#src/workflows/resume.js";
import { fetchRepoLayer, resetRepoConfigForTests } from "#src/config/repo-config.js";
import type { GitHubClient, RepoConfigTreeResult } from "#src/engine/github/github.js";
import type { RepoConfigRunRecord } from "#src/workflows/simple.js";
import type { ExecutorConfig } from "#src/engine/github/profiles.js";

const mockExecuteAgent = vi.mocked(executeAgent);

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lastlight-resume-repo-"));
}

const REVIEW_YAML = `
kind: agent
name: pr-review
phases:
  - name: pr-review
    label: Review
    prompt: prompts/review.md
    model: "{{models.pr-review}}"
`;

function operatorConfig(): ExecutorConfig {
  return {
    model: "anthropic/operator-default",
    stateDir: "/tmp",
    sandboxDir: "/tmp/sandboxes",
    sessionsDir: "/tmp/sessions",
    sandbox: "none",
    buildAssets: "repo",
  };
}

/** The repo-config record a first dispatch would have persisted on the row. */
function record(overrides: Partial<RepoConfigRunRecord> = {}): RepoConfigRunRecord {
  return {
    repo: "acme/widgets",
    defaultBranch: "main",
    treeSha: "sha-1",
    fetchedAt: "2026-07-31T00:00:00.000Z",
    applied: { models: { "pr-review": "openai/gpt-5-repo" } },
    assets: [],
    warnings: [],
    ...overrides,
  };
}

/** A GitHub client serving one canned `.lastlight/` tree. */
function fakeClient(files: Record<string, string>, treeSha = "sha-1"): GitHubClient {
  const result: RepoConfigTreeResult = {
    status: "ok",
    defaultBranch: "main",
    treeSha,
    files: Object.entries(files).map(([path, body]) => ({
      path,
      mode: "100644",
      size: Buffer.byteLength(body),
      content: Buffer.from(body),
    })),
    truncated: false,
  };
  return { fetchRepoConfigTree: vi.fn(async () => result) } as unknown as GitHubClient;
}

describe("resumeSimpleRun — the run's own config, not today's", () => {
  let builtIn: string;
  let db: StateDb;

  beforeEach(() => {
    builtIn = tmp();
    mkdirSync(join(builtIn, "workflows", "prompts"), { recursive: true });
    writeFileSync(join(builtIn, "workflows", "pr-review.yaml"), REVIEW_YAML);
    writeFileSync(join(builtIn, "workflows", "prompts", "review.md"), "BUILT-IN REVIEW PROMPT");
    configureWorkflowAssets({ builtInRoot: builtIn });
    clearWorkflowCache();
    resetRepoConfigForTests();
    db = new StateDb(":memory:");
    mockExecuteAgent.mockResolvedValue({
      success: true,
      output: "done",
      error: undefined,
      turns: 1,
      durationMs: 1,
    });
  });

  afterEach(() => {
    db.close();
    configureWorkflowAssets();
    clearWorkflowCache();
    resetRepoConfigForTests();
    vi.clearAllMocks();
  });

  /** Create the `workflow_runs` row a crashed/paused run would have left. */
  function orphan(context: Record<string, unknown>): void {
    db.runs.createRun({
      id: "run-1",
      workflowName: "pr-review",
      triggerId: "acme/widgets#7",
      owner: "acme",
      repo: "widgets",
      issueNumber: 7,
      currentPhase: "pr-review",
      status: "running",
      context: { taskId: "widgets-7-pr-review", branch: "main", issueDir: ".lastlight/pr-7", ...context },
      startedAt: new Date().toISOString(),
    });
  }

  function resumeOpts(): ResumeOptions {
    return {
      db,
      github: null,
      config: operatorConfig(),
      // The OPERATOR's maps as they stand today — deliberately without the
      // repo's override, so anything the resume runs on can only come from
      // what the original dispatch persisted.
      models: { default: "anthropic/operator-default" },
      variants: {},
      approvalConfig: {},
    };
  }

  it("re-runs on the run's persisted effective model, not the operator default", async () => {
    orphan({
      models: { default: "anthropic/operator-default", "pr-review": "openai/gpt-5-repo" },
      repoConfig: record(),
    });

    await resumeSimpleRun(db.runs.getRun("run-1")!, resumeOpts());

    expect(mockExecuteAgent).toHaveBeenCalledOnce();
    expect(mockExecuteAgent.mock.calls[0]![1].model).toBe("openai/gpt-5-repo");
    expect(db.runs.getRun("run-1")?.status).toBe("succeeded");
  });

  it("restores the repo's asset layer when its tree is still cached", async () => {
    const cacheRoot = tmp();
    // Prime the layer cache the way a live harness would have.
    const layer = await fetchRepoLayer("acme/widgets", {
      client: fakeClient({
        "lastlight.yml": "models:\n  pr-review: openai/gpt-5-repo\n",
        "workflows/prompts/review.md": "REPO REVIEW PROMPT",
        "agent-context/conventions.md": "REPO CONVENTIONS",
      }),
      cacheRoot,
    });
    expect(layer?.treeSha).toBe("sha-1");

    orphan({
      models: { default: "anthropic/operator-default", "pr-review": "openai/gpt-5-repo" },
      repoConfig: record({
        assets: ["workflows/prompts/review.md", "agent-context/conventions.md"],
      }),
    });

    await resumeSimpleRun(db.runs.getRun("run-1")!, resumeOpts());

    // The prompt AND the agent context come from the repo layer the run started
    // with — a resumed phase is the same phase, rendered the same way.
    expect(mockExecuteAgent.mock.calls[0]![0]).toBe("REPO REVIEW PROMPT");
    expect(mockExecuteAgent.mock.calls[0]![1].agentContext).toContain("REPO CONVENTIONS");
    expect(db.runs.getRun("run-1")?.scratch?.repoConfig).toBeUndefined();
  });

  it("degrades to the operator's assets — with a recorded warning — when the cached tree is gone", async () => {
    // Nothing primed: the unpacked tree the run used has been evicted (TTL
    // sweep, a fresh host, a restarted harness with no sidecar).
    orphan({
      models: { default: "anthropic/operator-default", "pr-review": "openai/gpt-5-repo" },
      repoConfig: record({ treeSha: "evicted-sha", assets: ["workflows/prompts/review.md"] }),
    });

    await resumeSimpleRun(db.runs.getRun("run-1")!, resumeOpts());

    // Degraded, not crashed: the run completed on the operator's prompt…
    const run = db.runs.getRun("run-1");
    expect(run?.status).toBe("succeeded");
    expect(mockExecuteAgent.mock.calls[0]![0]).toBe("BUILT-IN REVIEW PROMPT");
    // …the config leaves the repo DID win are still honoured…
    expect(mockExecuteAgent.mock.calls[0]![1].model).toBe("openai/gpt-5-repo");
    // …and the drop is explained on the run rather than silently swallowed.
    const scratch = run?.scratch?.repoConfig as
      | { restoreWarnings?: Array<{ code: string; message: string }> }
      | undefined;
    expect(scratch?.restoreWarnings).toHaveLength(1);
    expect(scratch?.restoreWarnings?.[0]?.code).toBe("fetch-failed");
    expect(scratch?.restoreWarnings?.[0]?.message).toMatch(/no longer available/i);
  });

  it("falls back to the operator's maps for a row that predates the persisted ones", async () => {
    orphan({});

    await resumeSimpleRun(db.runs.getRun("run-1")!, resumeOpts());

    expect(mockExecuteAgent.mock.calls[0]![1].model).toBe("anthropic/operator-default");
    expect(mockExecuteAgent.mock.calls[0]![1].agentContext).toBeUndefined();
  });
});

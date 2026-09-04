import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

// reapOnSuccess's underlying reapSandboxWorkspace (src/sandbox/reap.js) now
// logs via the pino LoggerPort instead of console — mock the logger module
// so the suite's stderr stays free of real pino JSON (no assertions here
// depend on the logged content).
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

import { workflowScopedTaskId, resolveRunBranch, artifactIssueDir, reapOnSuccess, prepopulatesSynthBranch, prepopulatesPrHeadRef } from "#src/workflows/simple.js";

// Policy is now derived from each workflow's own YAML keys (issue #368), so
// these are the built-in members spelled out rather than an imported Set. That
// the derivation still produces exactly them is pinned entry-for-entry by
// tests/workflows/target-policy.test.ts.
const PER_TARGET_REUSE = ["pr-review", "pr-fix", "dependabot-ci-fix", "dependabot-pr-merge"];
const PER_TARGET_RECREATE = ["build"];
import type { ExecutorConfig } from "#src/engine/github/profiles.js";

const RUN = "abcdef12-3456-7890-abcd-ef1234567890";

describe("workflowScopedTaskId", () => {
  it("keys per-target workflows by (repo, PR) with no run suffix so they reuse one workspace", () => {
    for (const wf of PER_TARGET_REUSE) {
      const a = workflowScopedTaskId("drizzle-cube", 918, wf, RUN);
      const b = workflowScopedTaskId("drizzle-cube", 918, wf, "different-run-id");
      // Two separate runs on the same PR resolve to the same dir → reuse.
      expect(a).toBe(b);
      expect(a).not.toContain(RUN.slice(0, 8));
    }
  });

  it("gives the whole fix FAMILY one shared workspace per PR", () => {
    // 09-state-machine.md → S4. The PR-scoped run lock means only one of these
    // can be in flight for a PR at a time, so two directories were pure waste —
    // and routing genuinely varies (an `@bot fix this` comment on a red
    // Dependabot PR is an LLM decision that can land on either workflow), so
    // attempt 2 would otherwise re-clone and re-install from cold just because
    // the event arrived differently.
    const prFix = workflowScopedTaskId("drizzle-cube", 918, "pr-fix", RUN);
    const ciFix = workflowScopedTaskId("drizzle-cube", 918, "dependabot-ci-fix", "different-run-id");
    expect(prFix).toBe("drizzle-cube-918-fix");
    expect(ciFix).toBe(prFix);
  });

  it("keeps dependabot-pr-merge on its own key — it has no checkout to share", () => {
    expect(workflowScopedTaskId("drizzle-cube", 918, "dependabot-pr-merge", RUN))
      .toBe("drizzle-cube-918-dependabot-pr-merge");
    // pr-review reads the tree a fix run may be rewriting, so it keeps its own too.
    expect(workflowScopedTaskId("drizzle-cube", 918, "pr-review", RUN))
      .toBe("drizzle-cube-918-pr-review");
  });

  it("keys build (recreate-from-base) by (repo, issue) with no run suffix so a re-run lands on the same dir", () => {
    for (const wf of PER_TARGET_RECREATE) {
      const a = workflowScopedTaskId("drizzle-cube", 918, wf, RUN);
      const b = workflowScopedTaskId("drizzle-cube", 918, wf, "different-run-id");
      expect(a).toBe(`drizzle-cube-918-${wf}`);
      // A re-triggered build resolves to the same dir → the stale checkout is
      // found and recreated from the default branch (issue #153).
      expect(a).toBe(b);
    }
  });

  it("keeps the run suffix for repo-scoped (no number) workflows", () => {
    const id = workflowScopedTaskId("drizzle-cube", undefined, "health", RUN);
    expect(id).toBe("drizzle-cube-health-abcdef12");
  });

  it("does not reuse when a per-PR workflow has no number", () => {
    const id = workflowScopedTaskId("drizzle-cube", undefined, "pr-review", RUN);
    expect(id).toBe("drizzle-cube-pr-review-abcdef12");
  });
});

describe("artifactIssueDir", () => {
  const KEY = "issue-172";

  it("keeps docs in-repo for repo mode regardless of backend / pre-clone", () => {
    for (const backend of ["docker", "gondolin", "none", "smol"] as const) {
      expect(artifactIssueDir({ buildAssets: "repo", sandbox: backend }, KEY, true))
        .toBe(`.lastlight/${KEY}`);
    }
  });

  it("relocates to the workspace-root sibling (../) for server mode + pre-clone on docker/none/smol", () => {
    for (const backend of ["docker", "none", "smol"] as const) {
      expect(artifactIssueDir({ buildAssets: "server", sandbox: backend }, KEY, true))
        .toBe(`../.lastlight/${KEY}`);
    }
  });

  it("keeps gondolin in-repo (it mounts only cwd, so a workspace sibling is unreachable)", () => {
    expect(artifactIssueDir({ buildAssets: "server", sandbox: "gondolin" }, KEY, true))
      .toBe(`.lastlight/${KEY}`);
    // Unset backend defaults to gondolin.
    expect(artifactIssueDir({ buildAssets: "server", sandbox: undefined }, KEY, true))
      .toBe(`.lastlight/${KEY}`);
  });

  it("does not relocate a non-pre-cloned server run (cwd is already the workspace root, outside the repo subdir)", () => {
    expect(artifactIssueDir({ buildAssets: "server", sandbox: "docker" }, KEY, false))
      .toBe(`.lastlight/${KEY}`);
  });
});

describe("resolveRunBranch", () => {
  it("derives lastlight/N-<title-slug> from the issue title on a fresh dispatch", () => {
    const { branch, prePopulateBranch } = resolveRunBranch({
      issueNumber: 3,
      issueTitle: "I want to make the todos header red",
      workflowName: "build",
    });
    expect(branch).toBe("lastlight/3-i-want-to-make-the-todos-header-red");
    // build pre-populates, so prePopulateBranch tracks the synthesized branch.
    expect(prePopulateBranch).toBe(branch);
  });

  it("pins to the stored branch on reuse even when the resume event has no title", () => {
    // Regression: a build that paused at an approval gate resumes via
    // runSimpleWorkflow with an empty issueTitle. Without recovering the stored
    // branch this collapsed to `lastlight/3-issue-3` — a ref that was never
    // pushed — so the PR phase's `head:` 422'd on github_create_pull_request.
    const stored = {
      branch: "lastlight/3-i-want-to-make-the-todos-header-red",
      prePopulateBranch: "lastlight/3-i-want-to-make-the-todos-header-red",
    };
    const { branch, prePopulateBranch } = resolveRunBranch({
      stored,
      issueNumber: 3,
      issueTitle: "", // resume events carry no issue title
      workflowName: "build",
    });
    expect(branch).toBe("lastlight/3-i-want-to-make-the-todos-header-red");
    expect(prePopulateBranch).toBe("lastlight/3-i-want-to-make-the-todos-header-red");
    // Specifically NOT the empty-title fallback that caused the production 422.
    expect(branch).not.toBe("lastlight/3-issue-3");
  });

  it("falls back to lastlight/N-issue-N only when there is no stored branch and no title", () => {
    const { branch } = resolveRunBranch({
      issueNumber: 3,
      issueTitle: "",
      workflowName: "build",
    });
    expect(branch).toBe("lastlight/3-issue-3");
  });

  it("prefers an explicit request prePopulateBranch (pr-review / pr-fix head ref)", () => {
    const { branch, prePopulateBranch } = resolveRunBranch({
      requestPrePopulateBranch: "feature/some-pr-head",
      issueNumber: 918,
      issueTitle: "unused when prePopulateBranch is set",
      workflowName: "pr-review",
    });
    expect(branch).toBe("feature/some-pr-head");
    expect(prePopulateBranch).toBe("feature/some-pr-head");
  });

  it("ignores an empty stored branch and recomputes from the title", () => {
    const { branch } = resolveRunBranch({
      stored: { branch: "" },
      issueNumber: 3,
      issueTitle: "Make it red",
      workflowName: "build",
    });
    expect(branch).toBe("lastlight/3-make-it-red");
  });

  it("does not set prePopulateBranch for non-prepopulating workflows", () => {
    const { prePopulateBranch } = resolveRunBranch({
      issueNumber: 5,
      issueTitle: "scan request",
      workflowName: "triage",
    });
    expect(prePopulateBranch).toBeUndefined();
  });
});

describe("prepopulate_synth_branch", () => {
  it("includes verify and qa-test so their browser-QA screenshots harvest correctly", () => {
    // The harvest fix hinges on these pre-populating like build (cwd = repo
    // root), so server-mode artifacts land where serverArtifacts() reads them.
    expect(prepopulatesSynthBranch("verify")).toBe(true);
    expect(prepopulatesSynthBranch("qa-test")).toBe(true);
    expect(prepopulatesSynthBranch("build")).toBe(true);
  });

  it("does not pre-populate read-only scan workflows that clone in-session", () => {
    expect(prepopulatesSynthBranch("triage")).toBe(false);
    expect(prepopulatesSynthBranch("answer")).toBe(false);
  });
});

describe("prepopulate_pr_head_ref", () => {
  it("pins qa-test and verify to the PR head ref so they QA the PR, not the base branch", () => {
    // Regression: when run against an existing PR these synthesize a
    // `lastlight/<prNumber>-<title-slug>` branch that doesn't match the PR's
    // real head ref (named after the originating issue). Without head-ref
    // pinning the sandbox cloned the *default* branch and reported the PR's
    // feature missing — a false-negative QA result.
    expect(prepopulatesPrHeadRef("qa-test")).toBe(true);
    expect(prepopulatesPrHeadRef("verify")).toBe(true);
  });

  it("also pins pr-review and demo (the original members)", () => {
    expect(prepopulatesPrHeadRef("pr-review")).toBe(true);
    expect(prepopulatesPrHeadRef("demo")).toBe(true);
  });

  it("does not pin build — it creates the synth branch off the default branch", () => {
    expect(prepopulatesPrHeadRef("build")).toBe(false);
  });
});

describe("reapOnSuccess (issue #106)", () => {
  const tmps: string[] = [];
  afterEach(() => {
    for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  // No live container in the unit env, so the reap probe resolves to "not live"
  // (docker absent → false, or `docker ps` matches nothing).
  function seed(taskId: string): { config: ExecutorConfig; workDir: string } {
    const stateDir = mkdtempSync(join(tmpdir(), "reap-onsuccess-"));
    tmps.push(stateDir);
    const workDir = join(stateDir, "sandboxes", taskId);
    mkdirSync(workDir, { recursive: true });
    return { config: { stateDir } as ExecutorConfig, workDir };
  }

  it("reaps an ephemeral workflow's workspace on success", () => {
    const taskId = "acme-1-triage-abcd1234";
    const { config, workDir } = seed(taskId);
    reapOnSuccess("triage", taskId, config);
    expect(existsSync(workDir)).toBe(false);
  });

  it("keeps reusable per-target workspaces (they are a warm cache)", () => {
    for (const wf of [...PER_TARGET_REUSE, ...PER_TARGET_RECREATE]) {
      const taskId = `acme-9-${wf}`;
      const { config, workDir } = seed(taskId);
      reapOnSuccess(wf, taskId, config);
      expect(existsSync(workDir)).toBe(true);
    }
  });
});

import { describe, expect, it } from "vitest";
import { workflowScopedTaskId, resolveRunBranch, PER_TARGET_REUSE_WORKFLOWS, PER_TARGET_RECREATE_WORKFLOWS, PREPOPULATE_SYNTH_WORKFLOWS, PR_HEADREF_PREPOPULATE_WORKFLOWS } from "#src/workflows/simple.js";

const RUN = "abcdef12-3456-7890-abcd-ef1234567890";

describe("workflowScopedTaskId", () => {
  it("keys pr-review / pr-fix by (repo, PR) with no run suffix so they reuse one workspace", () => {
    for (const wf of PER_TARGET_REUSE_WORKFLOWS) {
      const a = workflowScopedTaskId("drizzle-cube", 918, wf, RUN);
      const b = workflowScopedTaskId("drizzle-cube", 918, wf, "different-run-id");
      expect(a).toBe(`drizzle-cube-918-${wf}`);
      // Two separate runs on the same PR resolve to the same dir → reuse.
      expect(a).toBe(b);
    }
  });

  it("keys build (recreate-from-base) by (repo, issue) with no run suffix so a re-run lands on the same dir", () => {
    for (const wf of PER_TARGET_RECREATE_WORKFLOWS) {
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

describe("PREPOPULATE_SYNTH_WORKFLOWS", () => {
  it("includes verify and qa-test so their browser-QA screenshots harvest correctly", () => {
    // The harvest fix hinges on these pre-populating like build (cwd = repo
    // root), so server-mode artifacts land where serverArtifacts() reads them.
    expect(PREPOPULATE_SYNTH_WORKFLOWS.has("verify")).toBe(true);
    expect(PREPOPULATE_SYNTH_WORKFLOWS.has("qa-test")).toBe(true);
    expect(PREPOPULATE_SYNTH_WORKFLOWS.has("build")).toBe(true);
  });

  it("does not pre-populate read-only scan workflows that clone in-session", () => {
    expect(PREPOPULATE_SYNTH_WORKFLOWS.has("triage")).toBe(false);
    expect(PREPOPULATE_SYNTH_WORKFLOWS.has("answer")).toBe(false);
  });
});

describe("PR_HEADREF_PREPOPULATE_WORKFLOWS", () => {
  it("pins qa-test and verify to the PR head ref so they QA the PR, not the base branch", () => {
    // Regression: when run against an existing PR these synthesize a
    // `lastlight/<prNumber>-<title-slug>` branch that doesn't match the PR's
    // real head ref (named after the originating issue). Without head-ref
    // pinning the sandbox cloned the *default* branch and reported the PR's
    // feature missing — a false-negative QA result.
    expect(PR_HEADREF_PREPOPULATE_WORKFLOWS.has("qa-test")).toBe(true);
    expect(PR_HEADREF_PREPOPULATE_WORKFLOWS.has("verify")).toBe(true);
  });

  it("also pins pr-review and demo (the original members)", () => {
    expect(PR_HEADREF_PREPOPULATE_WORKFLOWS.has("pr-review")).toBe(true);
    expect(PR_HEADREF_PREPOPULATE_WORKFLOWS.has("demo")).toBe(true);
  });

  it("does not pin build — it creates the synth branch off the default branch", () => {
    expect(PR_HEADREF_PREPOPULATE_WORKFLOWS.has("build")).toBe(false);
  });
});

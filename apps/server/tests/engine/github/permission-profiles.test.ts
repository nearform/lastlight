import { describe, it, expect } from "vitest";
import { GITHUB_PERMISSION_PROFILES } from "#src/engine/github/profiles.js";
import { gitAccessProfileForWorkflow } from "#src/workflows/runner.js";

/**
 * Issue #239: a `pr-comment` run 403'd ("Resource not accessible by
 * integration") on every attempt to post its answer, while the identical
 * `issue-comment` call succeeded — because GitHub resolves
 * `POST /repos/:owner/:repo/issues/:n/comments` against the TARGET's type:
 * an issue is checked against `issues`, a pull request against
 * `pull_requests`. Any profile allowed to comment must therefore carry
 * `pull_requests: write`, however issue-shaped the endpoint looks.
 */
describe("GITHUB_PERMISSION_PROFILES", () => {
  it("keeps `read` read-only across every scope", () => {
    expect(GITHUB_PERMISSION_PROFILES.read).toEqual({
      contents: "read",
      issues: "read",
      pull_requests: "read",
      metadata: "read",
    });
  });

  it("grants issues-write pull_requests:write so it can comment on a PR (#239)", () => {
    expect(GITHUB_PERMISSION_PROFILES["issues-write"]).toEqual({
      contents: "read",
      issues: "write",
      pull_requests: "write",
      metadata: "read",
    });
  });

  it("never lets a comment profile write code", () => {
    for (const profile of ["read", "issues-write", "review-write"] as const) {
      expect(GITHUB_PERMISSION_PROFILES[profile].contents).toBe("read");
      expect(GITHUB_PERMISSION_PROFILES[profile]).not.toHaveProperty("workflows");
    }
  });

  it("keeps repo-write the only contents/workflows writer", () => {
    expect(GITHUB_PERMISSION_PROFILES["repo-write"]).toEqual({
      contents: "write",
      issues: "write",
      pull_requests: "write",
      workflows: "write",
      metadata: "read",
    });
  });
});

describe("PR-reachable workflows can write to a PR", () => {
  // Every handler the router can pick for a comment on a PR
  // (src/engine/router.ts — the `if (envelope.prNumber)` branch).
  const PR_REACHABLE = ["pr-comment", "pr-fix", "pr-review", "verify", "qa-test", "demo"];

  for (const workflow of PR_REACHABLE) {
    it(`${workflow} gets a profile with pull_requests:write`, () => {
      const profile = gitAccessProfileForWorkflow(workflow);
      expect(GITHUB_PERMISSION_PROFILES[profile].pull_requests).toBe("write");
    });
  }

  it("issue-comment can also write to a PR — the router sends it PR targets too", () => {
    const profile = gitAccessProfileForWorkflow("issue-comment");
    expect(GITHUB_PERMISSION_PROFILES[profile].pull_requests).toBe("write");
  });
});

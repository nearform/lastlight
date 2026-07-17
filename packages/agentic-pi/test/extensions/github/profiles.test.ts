import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { PROFILE_TOOLS, isGitAccessProfile } from "../../../src/extensions/github/profiles.js";

describe("PROFILE_TOOLS", () => {
  test("the four expected profiles exist", () => {
    assert.ok(PROFILE_TOOLS.read);
    assert.ok(PROFILE_TOOLS["issues-write"]);
    assert.ok(PROFILE_TOOLS["review-write"]);
    assert.ok(PROFILE_TOOLS["repo-write"]);
  });

  test("each profile is a strict superset of the more restrictive one", () => {
    const read = new Set(PROFILE_TOOLS.read);
    const issuesWrite = new Set(PROFILE_TOOLS["issues-write"]);
    const reviewWrite = new Set(PROFILE_TOOLS["review-write"]);
    const repoWrite = new Set(PROFILE_TOOLS["repo-write"]);

    for (const t of read) assert.ok(issuesWrite.has(t), `issues-write missing read tool ${t}`);
    for (const t of issuesWrite)
      assert.ok(reviewWrite.has(t), `review-write missing issues-write tool ${t}`);
    for (const t of reviewWrite)
      assert.ok(repoWrite.has(t), `repo-write missing review-write tool ${t}`);
  });

  test("write-only tools appear in the right tier", () => {
    // contents:write tools must live in repo-write, not below.
    const repoOnly = [
      "github_clone_repo",
      "github_create_or_update_file",
      "github_push_files",
      "github_create_branch",
      "github_merge_pull_request",
      "github_enable_auto_merge",
    ];
    for (const t of repoOnly) {
      assert.ok(PROFILE_TOOLS["repo-write"].includes(t), `${t} missing from repo-write`);
      assert.ok(!PROFILE_TOOLS["review-write"].includes(t), `${t} leaked into review-write`);
    }

    // pull_requests:write tools must live in review-write+, not below.
    const reviewOnly = ["github_create_pull_request", "github_create_pull_request_review"];
    for (const t of reviewOnly) {
      assert.ok(PROFILE_TOOLS["review-write"].includes(t), `${t} missing from review-write`);
      assert.ok(!PROFILE_TOOLS["issues-write"].includes(t), `${t} leaked into issues-write`);
    }

    // issues:write tools must live in issues-write+, not in read.
    const issuesOnly = [
      "github_create_issue",
      "github_update_issue",
      "github_add_issue_comment",
      "github_add_labels",
      "github_remove_label",
      "github_create_label",
      "github_ensure_labels",
    ];
    for (const t of issuesOnly) {
      assert.ok(PROFILE_TOOLS["issues-write"].includes(t), `${t} missing from issues-write`);
      assert.ok(!PROFILE_TOOLS.read.includes(t), `${t} leaked into read`);
    }
  });

  test("expected tool counts per profile", () => {
    assert.equal(PROFILE_TOOLS.read.length, 18);
    assert.equal(PROFILE_TOOLS["issues-write"].length, 25);
    assert.equal(PROFILE_TOOLS["review-write"].length, 27);
    assert.equal(PROFILE_TOOLS["repo-write"].length, 33);
  });
});

describe("isGitAccessProfile", () => {
  test("accepts the four valid names", () => {
    for (const p of ["read", "issues-write", "review-write", "repo-write"]) {
      assert.ok(isGitAccessProfile(p), `expected '${p}' to be a valid profile`);
    }
  });

  test("rejects anything else", () => {
    for (const p of ["", "READ", "admin", "write", "owner"]) {
      assert.ok(!isGitAccessProfile(p), `expected '${p}' to be invalid`);
    }
  });
});

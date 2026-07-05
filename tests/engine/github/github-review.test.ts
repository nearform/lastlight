import { describe, it, expect } from "vitest";
import { GitHubClient } from "#src/engine/github/github.js";

/**
 * Unit coverage for the harness-side review verbs added for the first-class
 * `post-review` action. We build a client via `withToken` (so no App-auth
 * minting round-trip) and swap in a fake Octokit to assert the exact payload
 * sent to GitHub's create-review / diff endpoints.
 */
function fakeOctokit() {
  const calls: { createReview: unknown[]; get: unknown[] } = { createReview: [], get: [] };
  const octokit = {
    rest: {
      pulls: {
        createReview: async (args: unknown) => {
          calls.createReview.push(args);
          return { data: { id: 1 } };
        },
        get: async (args: unknown) => {
          calls.get.push(args);
          return { data: "DIFF_BODY" };
        },
      },
    },
  };
  return { octokit, calls };
}

function clientWith(octokit: unknown): GitHubClient {
  const c = GitHubClient.withToken("t", "http://mock");
  // Swap the private octokit for the fake.
  (c as unknown as { octokit: unknown }).octokit = octokit;
  return c;
}

describe("GitHubClient.createPullRequestReview", () => {
  it("posts body + event + comments + commit_id", async () => {
    const { octokit, calls } = fakeOctokit();
    const c = clientWith(octokit);
    await c.createPullRequestReview("o", "r", 7, {
      body: "sum",
      event: "COMMENT",
      comments: [{ path: "a.ts", line: 3, side: "RIGHT", body: "x" }],
      commitId: "deadbeef",
    });
    expect(calls.createReview).toHaveLength(1);
    const arg = calls.createReview[0] as Record<string, unknown>;
    expect(arg.owner).toBe("o");
    expect(arg.repo).toBe("r");
    expect(arg.pull_number).toBe(7);
    expect(arg.body).toBe("sum");
    expect(arg.event).toBe("COMMENT");
    expect(arg.commit_id).toBe("deadbeef");
    expect((arg.comments as unknown[]).length).toBe(1);
  });

  it("omits comments and commit_id when empty/unset", async () => {
    const { octokit, calls } = fakeOctokit();
    const c = clientWith(octokit);
    await c.createPullRequestReview("o", "r", 7, { body: "b", event: "APPROVE" });
    const arg = calls.createReview[0] as Record<string, unknown>;
    expect("comments" in arg).toBe(false);
    expect("commit_id" in arg).toBe(false);
  });
});

describe("GitHubClient.getPullRequestDiff", () => {
  it("requests the diff media type and returns the raw diff", async () => {
    const { octokit, calls } = fakeOctokit();
    const c = clientWith(octokit);
    const diff = await c.getPullRequestDiff("o", "r", 7);
    expect(diff).toBe("DIFF_BODY");
    const arg = calls.get[0] as Record<string, unknown>;
    expect(arg.mediaType).toEqual({ format: "diff" });
  });
});

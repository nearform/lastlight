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
  (c as unknown as { staticOctokit: unknown }).staticOctokit = octokit;
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

/**
 * The three-dot diff FINGERPRINT (issue #378).
 *
 * Its one caller turns equality into a SKIPPED review, so the contract is
 * asymmetric: a hash is a claim that we read the PR's whole contribution, and
 * anything less than that must be `null`. Every case below is a degraded read
 * that has to answer `null` rather than a hash over a partial answer.
 */
describe("GitHubClient.getPrDiffFingerprint", () => {
  function compareOctokit(files: unknown) {
    const calls: unknown[] = [];
    return {
      calls,
      octokit: {
        rest: {
          repos: {
            compareCommitsWithBasehead: async (args: unknown) => {
              calls.push(args);
              return { data: { files } };
            },
          },
        },
      },
    };
  }

  const file = (filename: string, patch: string) => ({ filename, patch });

  it("compares `base...sha` — the three-dot diff, not the two-dot one", async () => {
    const { octokit, calls } = compareOctokit([file("a.ts", "@@ -1 +1 @@")]);
    await clientWith(octokit).getPrDiffFingerprint("o", "r", "main", "head1");
    expect((calls[0] as Record<string, unknown>).basehead).toBe("main...head1");
  });

  it("hashes the same content to the same value, at two different head SHAs", async () => {
    // The merge-from-main case: the PR's own patch is byte-identical at both
    // SHAs, so the two fingerprints must agree even though the commits differ.
    const files = [file("a.ts", "@@ -1 +1 @@\n-x\n+y"), file("b.ts", "@@ -2 +2 @@")];
    const a = await clientWith(compareOctokit(files).octokit).getPrDiffFingerprint("o", "r", "main", "old");
    const b = await clientWith(compareOctokit(files).octokit).getPrDiffFingerprint("o", "r", "main", "new");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });

  it("hashes a changed patch differently", async () => {
    const a = await clientWith(compareOctokit([file("a.ts", "-x")]).octokit)
      .getPrDiffFingerprint("o", "r", "main", "old");
    const b = await clientWith(compareOctokit([file("a.ts", "-z")]).octokit)
      .getPrDiffFingerprint("o", "r", "main", "new");
    expect(a).not.toBe(b);
  });

  it("distinguishes a rename from an identical patch under another name", async () => {
    // The filename is hashed with the patch, and the two fields are NUL-
    // separated, so no concatenation of one can imitate the other.
    const a = await clientWith(compareOctokit([file("a.ts", "p")]).octokit)
      .getPrDiffFingerprint("o", "r", "main", "old");
    const b = await clientWith(compareOctokit([file("b.ts", "p")]).octokit)
      .getPrDiffFingerprint("o", "r", "main", "new");
    expect(a).not.toBe(b);
  });

  it("returns null when GitHub truncated the file list at 300", async () => {
    const files = Array.from({ length: 300 }, (_, i) => file(`f${i}.ts`, "p"));
    expect(
      await clientWith(compareOctokit(files).octokit).getPrDiffFingerprint("o", "r", "main", "h"),
    ).toBeNull();
  });

  it("returns null when any entry carries no patch — a binary or over-large file", async () => {
    // Two different binaries would otherwise hash identically, and the claim
    // "the diff did not change" would be about the files we could read rather
    // than about the diff.
    const files = [file("a.ts", "p"), { filename: "logo.png" }];
    expect(
      await clientWith(compareOctokit(files).octokit).getPrDiffFingerprint("o", "r", "main", "h"),
    ).toBeNull();
  });

  it("returns null when `files` is absent altogether", async () => {
    expect(
      await clientWith(compareOctokit(undefined).octokit).getPrDiffFingerprint("o", "r", "main", "h"),
    ).toBeNull();
  });

  // An EMPTY diff is a real answer, not a degraded one — an empty PR really
  // does have the same (empty) contribution at two SHAs. The gate above still
  // needs a prior review before it can act on it.
  it("hashes an empty file list rather than refusing it", async () => {
    expect(
      await clientWith(compareOctokit([]).octokit).getPrDiffFingerprint("o", "r", "main", "h"),
    ).toMatch(/^[0-9a-f]{64}$/);
  });
});

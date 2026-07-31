import { describe, it, expect } from "vitest";
import { GitHubClient } from "#src/engine/github/github.js";

/**
 * Byte-cap admission in `fetchRepoConfigTree` (issue #180, PR #254 review).
 *
 * The tree API does not always report a blob's `size`. The pre-check defaults a
 * missing size to 0, which degrades the guard to `bytes + 0 > maxBytes` — true
 * for no blob at all while under the cap — so an arbitrarily large file would be
 * admitted on the strength of a missing field. `sanitizeRepoFiles` applies the
 * cap a second time downstream, but this one is meant to hold on its own, so the
 * real `content.length` is re-checked after the blob is fetched.
 *
 * We swap in a fake Octokit so the tree/blob payloads (and specifically the
 * absence of `size`) are exactly what we want to assert against.
 */

interface Entry {
  path: string;
  /** Omitted deliberately in the tests that matter — that is the bug. */
  size?: number;
  /** Byte length of the blob this entry resolves to. */
  bytes: number;
}

function fakeOctokit(entries: Entry[]) {
  const bySha = new Map(entries.map((e) => [`sha-${e.path}`, e]));
  const blobCalls: string[] = [];
  const octokit = {
    rest: {
      repos: {
        get: async () => ({ data: { default_branch: "main" } }),
      },
      git: {
        getTree: async ({ tree_sha }: { tree_sha: string }) => {
          // First call resolves the root tree, second the `.lastlight` subtree.
          if (tree_sha === "main") {
            return {
              headers: { etag: "etag-1" },
              data: { sha: "root-sha", truncated: false, tree: [{ path: ".lastlight", type: "tree", sha: "ll-sha" }] },
            };
          }
          return {
            headers: {},
            data: {
              sha: "ll-sha",
              truncated: false,
              tree: entries.map((e) => ({
                path: e.path,
                type: "blob",
                sha: `sha-${e.path}`,
                mode: "100644",
                ...(e.size === undefined ? {} : { size: e.size }),
              })),
            },
          };
        },
        getBlob: async ({ file_sha }: { file_sha: string }) => {
          blobCalls.push(file_sha);
          const entry = bySha.get(file_sha)!;
          return { data: { content: "a".repeat(entry.bytes), encoding: "utf-8" } };
        },
      },
    },
  };
  return { octokit, blobCalls };
}

function clientWith(octokit: unknown): GitHubClient {
  const c = GitHubClient.withToken("t", "http://mock");
  (c as unknown as { octokit: unknown }).octokit = octokit;
  return c;
}

async function fetchTree(entries: Entry[], maxBytes: number) {
  const { octokit, blobCalls } = fakeOctokit(entries);
  const result = await clientWith(octokit).fetchRepoConfigTree("acme", "widget", { maxBytes });
  return { result, blobCalls };
}

describe("fetchRepoConfigTree — byte cap", () => {
  it("rejects a blob whose tree size is absent but whose content exceeds the cap", async () => {
    const { result } = await fetchTree([{ path: ".lastlight/big.md", bytes: 5000 }], 1000);

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    // The pre-check could not catch this (no `size`), so the post-download
    // re-check is the only thing standing between us and a 5KB file under a 1KB cap.
    expect(result.files).toHaveLength(0);
    expect(result.truncated).toBe(true);
  });

  it("still admits a later small file after an over-cap one (continue, not break)", async () => {
    const { result } = await fetchTree(
      [
        { path: ".lastlight/big.md", bytes: 5000 },
        { path: ".lastlight/lastlight.yml", bytes: 40 },
      ],
      1000,
    );

    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.files.map((f) => f.path)).toEqual([".lastlight/lastlight.yml"]);
    expect(result.truncated).toBe(true);
  });

  it("records the actual content length as size, not the tree's claim", async () => {
    // A tree that under-reports: says 1 byte, delivers 40.
    const { result } = await fetchTree([{ path: ".lastlight/lastlight.yml", size: 1, bytes: 40 }], 1000);

    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.files[0].size).toBe(40);
    expect(result.files[0].content.length).toBe(40);
  });

  it("admits files normally while under the cap", async () => {
    const { result, blobCalls } = await fetchTree(
      [
        { path: ".lastlight/lastlight.yml", size: 40, bytes: 40 },
        { path: ".lastlight/agent-context/notes.md", size: 60, bytes: 60 },
      ],
      1000,
    );

    if (result.status !== "ok") throw new Error("expected ok");
    expect(result.files).toHaveLength(2);
    expect(result.truncated).toBe(false);
    expect(blobCalls).toHaveLength(2);
  });

  it("does not download a blob the pre-check already rejects on reported size", async () => {
    const { result, blobCalls } = await fetchTree([{ path: ".lastlight/big.md", size: 5000, bytes: 5000 }], 1000);

    if (result.status !== "ok") throw new Error("expected ok");
    // When the tree DOES report a size, the cheap pre-check still short-circuits
    // before the network round-trip — the post-check is a backstop, not a replacement.
    expect(blobCalls).toHaveLength(0);
    expect(result.truncated).toBe(true);
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { GitHubClient } from "../../../src/extensions/github/client.js";
import type { GitHubAuth } from "../../../src/extensions/github/auth.js";

const staticAuth: GitHubAuth = {
  getToken: async () => "test-token",
  expiresAt: null,
  canRefresh: false,
};

/** A fake GitHub that records the GraphQL bodies it was sent. */
function graphqlServer(
  reply: unknown,
  status = 200,
): Promise<{
  url: string;
  bodies: any[];
  close: () => Promise<void>;
}> {
  const bodies: any[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      bodies.push({ path: req.url, body: raw ? JSON.parse(raw) : null });
      res.statusCode = status;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify(reply));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        bodies,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const OK_COMMIT = {
  data: {
    createCommitOnBranch: {
      commit: {
        oid: "abc123",
        url: "https://github.com/o/r/commit/abc123",
        committer: { name: "bot", email: "bot@users.noreply.github.com" },
        signature: { isValid: true, state: "VALID", wasSignedByGitHub: true },
      },
    },
  },
};

describe("publishSignedCommit", () => {
  test("sends one createCommitOnBranch mutation with the change set and expected tip", async () => {
    const fake = await graphqlServer(OK_COMMIT);
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: fake.url });
      const commit = await client.publishSignedCommit({
        owner: "o",
        repo: "r",
        branch: "feat/x",
        expectedHeadOid: "deadbeef",
        headline: "fix: thing",
        body: "why",
        additions: [{ path: "a.txt", contents: "eA==", status: "M" }],
        deletions: [{ path: "b.txt" }],
      });

      assert.equal(commit.oid, "abc123");
      assert.equal(commit.signature?.wasSignedByGitHub, true);

      assert.equal(fake.bodies.length, 1);
      // Octokit's graphql() has no GHES rewrite for a plain baseUrl, so it falls
      // back to its built-in endpoint default of POST /graphql — verified empirically
      // against this fake server, not assumed.
      assert.equal(fake.bodies[0].path, "/graphql");
      const input = fake.bodies[0].body.variables.input;
      assert.deepEqual(input.branch, { repositoryNameWithOwner: "o/r", branchName: "feat/x" });
      assert.equal(input.expectedHeadOid, "deadbeef");
      assert.deepEqual(input.message, { headline: "fix: thing", body: "why" });
      assert.deepEqual(input.fileChanges.additions, [{ path: "a.txt", contents: "eA==" }]);
      assert.deepEqual(input.fileChanges.deletions, [{ path: "b.txt" }]);
      // The signature must be selected, or the tool cannot verify its own work.
      assert.match(fake.bodies[0].body.query, /wasSignedByGitHub/);
    } finally {
      await fake.close();
    }
  });

  test("surfaces a GraphQL error instead of returning a commit", async () => {
    const fake = await graphqlServer({
      data: { createCommitOnBranch: null },
      errors: [{ message: 'Expected branch to point to "old" but it did not.' }],
    });
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: fake.url });
      await assert.rejects(
        () =>
          client.publishSignedCommit({
            owner: "o",
            repo: "r",
            branch: "main",
            expectedHeadOid: "stale",
            headline: "x",
            additions: [],
            deletions: [],
          }),
        /Expected branch to point to/,
      );
      // A GraphQL-level rejection is terminal, not transient: resending the same
      // mutation cannot change GitHub's answer. This is the assertion that fails
      // if the terminal path regresses — the rejection above passes either way,
      // since withRetry still throws lastError once its budget is exhausted.
      assert.equal(fake.bodies.length, 1);
    } finally {
      await fake.close();
    }
  });
});

describe("getBranchTip", () => {
  test("returns the sha when the branch exists", async () => {
    const server = createServer((_req, res) => {
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ object: { sha: "tip123" } }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: `http://127.0.0.1:${port}` });
      assert.equal(await client.getBranchTip("o", "r", "main"), "tip123");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  test("returns null on 404 rather than throwing — a new branch is not an error", async () => {
    const server = createServer((_req, res) => {
      res.statusCode = 404;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: "Not Found" }));
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: `http://127.0.0.1:${port}` });
      assert.equal(await client.getBranchTip("o", "r", "nope"), null);
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});

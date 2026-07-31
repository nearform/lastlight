import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { GitHubClient, isActionsDenied } from "../../../src/extensions/github/client.js";
import type { GitHubAuth } from "../../../src/extensions/github/auth.js";

const staticAuth: GitHubAuth = {
  getToken: async () => "test-token",
  expiresAt: null,
  canRefresh: false,
};

/** A throwaway HTTP server that records the paths it was asked for. */
function recordingServer(): Promise<{
  url: string;
  paths: string[];
  close: () => Promise<void>;
  server: Server;
}> {
  const paths: string[] = [];
  const server = createServer((req, res) => {
    paths.push(req.url ?? "");
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ full_name: "octo/widget" }));
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        paths,
        server,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("GitHubClient baseUrl injection", () => {
  test("defaults to api.github.com when no baseUrl is given", async () => {
    const client = new GitHubClient(staticAuth);
    const ok = await client.octokit();
    assert.equal(ok.request.endpoint.DEFAULTS.baseUrl, "https://api.github.com");
  });

  test("honors an injected baseUrl on the Octokit instance", async () => {
    const client = new GitHubClient(staticAuth, { baseUrl: "http://127.0.0.1:9" });
    const ok = await client.octokit();
    assert.equal(ok.request.endpoint.DEFAULTS.baseUrl, "http://127.0.0.1:9");
  });

  test("routes a real request to the injected baseUrl, not GitHub", async () => {
    const fake = await recordingServer();
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: fake.url });
      const repo = (await client.getRepository("octo", "widget")) as { full_name?: string };
      assert.equal(repo.full_name, "octo/widget");
      assert.deepEqual(fake.paths, ["/repos/octo/widget"]);
    } finally {
      await fake.close();
    }
  });
});

/**
 * Fake GitHub that owns a mutable set of labels: GET list returns them, POST
 * create adds a new one but 422s `already_exists` (like the real API) when the
 * name is taken. Records the request log so we can assert check-first + bulk.
 */
function labelServer(initial: string[]): Promise<{
  url: string;
  log: string[];
  labels: Set<string>;
  close: () => Promise<void>;
}> {
  const labels = new Set(initial);
  const log: string[] = [];
  const server = createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "";
    log.push(`${method} ${url}`);
    res.setHeader("content-type", "application/json");
    if (method === "GET" && url.startsWith("/repos/octo/widget/labels")) {
      res.end(JSON.stringify([...labels].map((name) => ({ name, color: "ededed" }))));
      return;
    }
    if (method === "POST" && url === "/repos/octo/widget/labels") {
      let body = "";
      req.on("data", (c) => {
        body += c;
      });
      req.on("end", () => {
        const { name } = JSON.parse(body || "{}") as { name: string };
        if (labels.has(name)) {
          res.statusCode = 422;
          res.end(
            JSON.stringify({
              message: "Validation Failed",
              errors: [{ resource: "Label", code: "already_exists", field: "name" }],
            }),
          );
          return;
        }
        labels.add(name);
        res.statusCode = 201;
        res.end(JSON.stringify({ name, color: "ededed" }));
      });
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        log,
        labels,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("GitHubClient.ensureLabels", () => {
  test("lists once, creates only missing, partitions created vs existed", async () => {
    const fake = await labelServer(["bug", "question"]);
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: fake.url });
      const result = await client.ensureLabels("octo", "widget", [
        { name: "bug" }, // exists
        { name: "needs-triage", color: "ff0000" }, // missing → create
        { name: "question" }, // exists
        { name: "ready-for-agent" }, // missing → create (default color)
      ]);

      assert.deepEqual(result.created.sort(), ["needs-triage", "ready-for-agent"]);
      assert.deepEqual(result.existed.sort(), ["bug", "question"]);

      // check-first: exactly one list, and creates ONLY for the two missing.
      const gets = fake.log.filter((l) => l.startsWith("GET"));
      const posts = fake.log.filter((l) => l.startsWith("POST"));
      assert.equal(gets.length, 1, "should list labels exactly once");
      assert.equal(posts.length, 2, "should only create the two missing labels");
    } finally {
      await fake.close();
    }
  });

  test("is case-insensitive on existing names (no create for a case variant)", async () => {
    const fake = await labelServer(["Bug"]);
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: fake.url });
      const result = await client.ensureLabels("octo", "widget", [{ name: "bug" }]);
      assert.deepEqual(result.existed, ["bug"]);
      assert.deepEqual(result.created, []);
      assert.equal(fake.log.filter((l) => l.startsWith("POST")).length, 0);
    } finally {
      await fake.close();
    }
  });
});

describe("GitHubClient.createLabel", () => {
  test("treats a 422 already_exists as success (idempotent)", async () => {
    const fake = await labelServer(["bug"]);
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: fake.url });
      const result = (await client.createLabel("octo", "widget", "bug", "ededed")) as {
        existed?: boolean;
      };
      assert.equal(result.existed, true);
    } finally {
      await fake.close();
    }
  });
});

/**
 * Fake GitHub that answers the two calls `enablePullRequestAutoMerge` makes:
 * a REST `GET /repos/.../pulls/N` (to resolve the PR node id) and a
 * `POST /graphql` (the mutation). `graphqlErrors` lets a test simulate a repo
 * that doesn't allow auto-merge (GraphQL returns 200 with an `errors` array).
 */
function autoMergeServer(opts: { graphqlErrors?: string[] } = {}): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (method === "GET" && url.startsWith("/repos/octo/widget/pulls/")) {
      res.end(JSON.stringify({ number: 5, node_id: "PR_node_123" }));
      return;
    }
    if (method === "POST" && url === "/graphql") {
      if (opts.graphqlErrors) {
        res.end(
          JSON.stringify({ data: null, errors: opts.graphqlErrors.map((message) => ({ message })) }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          data: {
            enablePullRequestAutoMerge: {
              pullRequest: { number: 5, autoMergeRequest: { enabledAt: "2026-07-17T00:00:00Z" } },
            },
          },
        }),
      );
      return;
    }
    res.statusCode = 404;
    res.end("{}");
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * Fake GitHub for the three Actions reads. `forbidden: true` reproduces an
 * installation without the optional `Actions: read` permission — GitHub answers
 * 403 "Resource not accessible by integration" on every Actions endpoint.
 */
function actionsServer(opts: { forbidden?: boolean; log?: string } = {}): Promise<{
  url: string;
  requests: number;
  close: () => Promise<void>;
}> {
  const state = { requests: 0 };
  const server = createServer((req, res) => {
    state.requests++;
    const url = req.url ?? "";
    if (opts.forbidden) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: "Resource not accessible by integration" }));
      return;
    }
    if (url.includes("/jobs/") && url.endsWith("/logs")) {
      res.setHeader("content-type", "text/plain");
      res.end(opts.log ?? "");
      return;
    }
    res.setHeader("content-type", "application/json");
    if (url.includes("/actions/runs/") && url.includes("/jobs")) {
      res.end(
        JSON.stringify({
          total_count: 1,
          jobs: [
            {
              id: 456,
              run_id: 12345,
              name: "build",
              status: "completed",
              conclusion: "failure",
              started_at: "2026-07-24T06:00:00Z",
              completed_at: "2026-07-24T06:05:00Z",
              html_url: "https://github.com/octo/widget/actions/runs/12345/job/456",
              steps: [
                { number: 1, name: "Checkout", status: "completed", conclusion: "success" },
                { number: 2, name: "Run npm test", status: "completed", conclusion: "failure" },
              ],
              // A field we deliberately drop from the projection.
              runner_group_name: "GitHub Actions",
            },
          ],
        }),
      );
      return;
    }
    res.end(
      JSON.stringify({
        total_count: 1,
        workflow_runs: [
          {
            id: 12345,
            name: "CI",
            path: ".github/workflows/ci.yml",
            head_branch: "dependabot/npm_and_yarn/vite-7",
            head_sha: "abc123",
            event: "pull_request",
            status: "completed",
            conclusion: "failure",
            run_number: 42,
            run_attempt: 1,
            created_at: "2026-07-24T06:00:00Z",
            html_url: "https://github.com/octo/widget/actions/runs/12345",
            // Half the raw object is metadata the agent has no use for; the
            // projection must not pass it through.
            repository: { id: 1, name: "widget", description: "x".repeat(500) },
          },
        ],
      }),
    );
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        get requests() {
          return state.requests;
        },
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

describe("GitHubClient Actions reads", () => {
  test("listWorkflowRuns projects the run down to the useful fields", async () => {
    const fake = await actionsServer();
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: fake.url });
      const result = await client.listWorkflowRuns("octo", "widget", { branch: "main" });
      assert.ok(!isActionsDenied(result));
      const [run] = (result as { workflow_runs: Record<string, unknown>[] }).workflow_runs;
      assert.equal(run.path, ".github/workflows/ci.yml");
      assert.equal(run.head_sha, "abc123");
      assert.equal(run.conclusion, "failure");
      assert.equal(run.repository, undefined, "raw repository object must not leak through");
    } finally {
      await fake.close();
    }
  });

  test("listWorkflowRunJobs keeps the steps, which is the point of it", async () => {
    const fake = await actionsServer();
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: fake.url });
      const result = await client.listWorkflowRunJobs("octo", "widget", 12345);
      assert.ok(!isActionsDenied(result));
      const [job] = (
        result as { jobs: Array<{ steps: Array<{ name: string; conclusion: string }> }> }
      ).jobs;
      assert.deepEqual(
        job.steps.filter((s) => s.conclusion === "failure").map((s) => s.name),
        ["Run npm test"],
      );
    } finally {
      await fake.close();
    }
  });

  test("getJobLogs returns the raw text — capping is the tool's job", async () => {
    const fake = await actionsServer({ log: "2026-07-24T06:04:02.000Z error: boom\n" });
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: fake.url });
      const result = await client.getJobLogs("octo", "widget", 456);
      assert.equal(result, "2026-07-24T06:04:02.000Z error: boom\n");
    } finally {
      await fake.close();
    }
  });

  test("a 403 becomes a terminal { ok: false, reason }, not a throw or a retry", async () => {
    const fake = await actionsServer({ forbidden: true });
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: fake.url });
      for (const result of [
        await client.listWorkflowRuns("octo", "widget"),
        await client.listWorkflowRunJobs("octo", "widget", 12345),
        await client.getJobLogs("octo", "widget", 456),
      ]) {
        assert.ok(isActionsDenied(result), "expected a denial result");
        assert.match((result as { reason: string }).reason, /not permitted/);
        assert.match((result as { reason: string }).reason, /Actions: read/);
        assert.match((result as { reason: string }).reason, /[Dd]o not retry/);
      }
      // Three calls, three requests: a 403 is terminal, so withRetry must not
      // have burned its retry budget on it.
      assert.equal(fake.requests, 3);
    } finally {
      await fake.close();
    }
  });
});

describe("GitHubClient.enablePullRequestAutoMerge", () => {
  test("resolves the node id then enables auto-merge (ok: true)", async () => {
    const fake = await autoMergeServer();
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: fake.url });
      const result = (await client.enablePullRequestAutoMerge("octo", "widget", 5)) as {
        ok: boolean;
        merge_method: string;
        pull_number: number;
      };
      assert.equal(result.ok, true);
      assert.equal(result.merge_method, "squash");
      assert.equal(result.pull_number, 5);
    } finally {
      await fake.close();
    }
  });

  test("returns { ok: false, reason } when the repo disallows auto-merge (no throw)", async () => {
    const fake = await autoMergeServer({
      graphqlErrors: ["Auto merge is not allowed for this repository"],
    });
    try {
      const client = new GitHubClient(staticAuth, { baseUrl: fake.url });
      const result = (await client.enablePullRequestAutoMerge("octo", "widget", 5, "merge")) as {
        ok: boolean;
        reason: string;
      };
      assert.equal(result.ok, false);
      assert.match(result.reason, /not allowed/i);
    } finally {
      await fake.close();
    }
  });
});

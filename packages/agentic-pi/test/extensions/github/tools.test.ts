import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";

import { buildGitHubTools } from "../../../src/extensions/github/tools.js";
import { PROFILE_TOOLS } from "../../../src/extensions/github/profiles.js";
import type { GitHubAuth } from "../../../src/extensions/github/auth.js";
import { DEFAULT_LOG_EXCERPT_BYTES } from "../../../src/extensions/github/log-excerpt.js";

const staticAuth: GitHubAuth = {
  getToken: async () => "test-token",
  expiresAt: null,
  canRefresh: false,
};

/** Serves one job log, or 403s everything when `forbidden`. */
function logServer(opts: { log?: string; forbidden?: boolean } = {}): Promise<{
  url: string;
  close: () => Promise<void>;
}> {
  const server = createServer((_req, res) => {
    if (opts.forbidden) {
      res.statusCode = 403;
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ message: "Resource not accessible by integration" }));
      return;
    }
    res.setHeader("content-type", "text/plain");
    res.end(opts.log ?? "");
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

/** Run a tool by name and parse the JSON payload back out of its text block. */
async function callTool(baseUrl: string, name: string, params: unknown): Promise<any> {
  const tool = buildGitHubTools(staticAuth, { baseUrl }).find((t) => t.name === name);
  assert.ok(tool, `tool ${name} is not registered`);
  const result = (await (tool as any).execute("call-1", params)) as {
    content: Array<{ text: string }>;
  };
  return JSON.parse(result.content[0].text);
}

describe("GitHub tool registration", () => {
  test("every name in every profile resolves to a registered tool", () => {
    // The profile gate filters by name, so a typo there silently removes a tool
    // instead of failing — this is the only thing that catches it.
    const registered = new Set(buildGitHubTools(staticAuth).map((t) => t.name));
    for (const [profile, names] of Object.entries(PROFILE_TOOLS)) {
      for (const name of names) {
        assert.ok(registered.has(name), `${profile} allows unregistered tool ${name}`);
      }
    }
  });

  test("the three Actions read tools are registered", () => {
    const registered = new Set(buildGitHubTools(staticAuth).map((t) => t.name));
    for (const name of [
      "github_list_workflow_runs",
      "github_list_workflow_run_jobs",
      "github_get_job_logs",
    ]) {
      assert.ok(registered.has(name), `${name} is not registered`);
    }
  });
});

describe("github_get_job_logs", () => {
  test("truncates a huge log and reports the sizes", async () => {
    const log = Array.from(
      { length: 20_000 },
      (_, i) => `2026-07-24T06:04:00.000Z error: failure ${i}`,
    ).join("\n");
    const fake = await logServer({ log });
    try {
      const out = await callTool(fake.url, "github_get_job_logs", {
        owner: "octo",
        repo: "widget",
        job_id: 456,
      });
      assert.equal(out.truncated, true);
      assert.ok(out.bytes <= DEFAULT_LOG_EXCERPT_BYTES);
      assert.ok(out.original_bytes > out.bytes);
      assert.match(out.log, /^\[truncated — showing/);
      assert.doesNotMatch(out.log, /\d{4}-\d{2}-\d{2}T/, "timestamps should be stripped");
    } finally {
      await fake.close();
    }
  });

  test("returns the whole excerpt untruncated when the log is small", async () => {
    const fake = await logServer({ log: "2026-07-24T06:04:02.000Z error: boom\n" });
    try {
      const out = await callTool(fake.url, "github_get_job_logs", {
        owner: "octo",
        repo: "widget",
        job_id: 456,
      });
      assert.equal(out.truncated, false);
      assert.match(out.log, /error: boom/);
    } finally {
      await fake.close();
    }
  });

  test("explains a 403 instead of erroring, so the agent stops rather than loops", async () => {
    const fake = await logServer({ forbidden: true });
    try {
      const out = await callTool(fake.url, "github_get_job_logs", {
        owner: "octo",
        repo: "widget",
        job_id: 456,
      });
      assert.equal(out.ok, false);
      assert.match(out.reason, /not permitted — the App lacks Actions: read/);
      assert.match(out.reason, /Do not retry/);
      // Not the generic safeRun error envelope — that one an agent retries.
      assert.equal(out.error, undefined);
    } finally {
      await fake.close();
    }
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { GitHubClient } from "../../../src/extensions/github/client.js";
import type { GitHubAuth } from "../../../src/extensions/github/auth.js";

const staticAuth: GitHubAuth = {
  getToken: async () => "test-token",
  expiresAt: null,
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

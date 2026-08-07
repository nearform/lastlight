import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync, chmodSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildGitHubTools } from "../../../src/extensions/github/tools.js";
import { PROFILE_TOOLS } from "../../../src/extensions/github/profiles.js";
import type { GitHubAuth } from "../../../src/extensions/github/auth.js";

const staticAuth: GitHubAuth = { getToken: async () => "test-token", expiresAt: null, canRefresh: false };

/** Serves getRef for `main` and accepts the publish mutation. */
function fakeGitHub(tip: string): Promise<{ url: string; mutations: any[]; close: () => Promise<void> }> {
  const mutations: any[] = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      if (req.url?.endsWith("/graphql")) {
        mutations.push(JSON.parse(Buffer.concat(chunks).toString("utf8")));
        res.end(
          JSON.stringify({
            data: {
              createCommitOnBranch: {
                commit: {
                  oid: "newoid",
                  url: "https://github.com/o/r/commit/newoid",
                  committer: { name: "bot", email: "b@e" },
                  signature: { isValid: true, state: "VALID", wasSignedByGitHub: true },
                },
              },
            },
          }),
        );
        return;
      }
      res.end(JSON.stringify({ object: { sha: tip } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        mutations,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

function repo(): { dir: string; base: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "publish-tool-"));
  const g = (...a: string[]) =>
    execFileSync("git", a, {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
    });
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  return { dir, base: g("rev-parse", "HEAD").trim(), cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

async function callPublish(baseUrl: string, params: unknown): Promise<any> {
  const tool = buildGitHubTools(staticAuth, { baseUrl }).find((t) => t.name === "github_publish");
  assert.ok(tool, "github_publish is not registered");
  const r = (await (tool as any).execute("call-1", params)) as { content: Array<{ text: string }> };
  return JSON.parse(r.content[0]!.text);
}

describe("github_publish", () => {
  test("is registered only in the repo-write profile", () => {
    assert.ok(PROFILE_TOOLS["repo-write"].includes("github_publish"));
    for (const p of ["read", "issues-write", "review-write"] as const) {
      assert.ok(!PROFILE_TOOLS[p].includes("github_publish"), `${p} must not allow publishing`);
    }
  });

  test("publishes the working tree and reports the verified commit", async () => {
    const r = repo();
    const fake = await fakeGitHub(r.base);
    try {
      writeFileSync(join(r.dir, "a.txt"), "two\n");
      writeFileSync(join(r.dir, "b.txt"), "new\n");
      const out = await callPublish(fake.url, {
        owner: "o",
        repo: "r",
        message: "fix: thing\n\nbody line",
        path: r.dir,
      });
      assert.equal(out.published, true);
      assert.equal(out.commit, "newoid");
      assert.equal(out.verified, true);
      assert.deepEqual(out.added.concat(out.modified).sort(), ["a.txt", "b.txt"]);

      const input = fake.mutations[0].variables.input;
      assert.equal(input.expectedHeadOid, r.base);
      assert.deepEqual(input.message, { headline: "fix: thing", body: "body line" });
    } finally {
      await fake.close();
      r.cleanup();
    }
  });

  test("reports a no-op instead of failing when nothing changed", async () => {
    const r = repo();
    const fake = await fakeGitHub(r.base);
    try {
      const out = await callPublish(fake.url, { owner: "o", repo: "r", message: "m", path: r.dir });
      assert.equal(out.published, false);
      assert.match(out.reason, /nothing to publish/i);
      assert.equal(fake.mutations.length, 0);
    } finally {
      await fake.close();
      r.cleanup();
    }
  });

  test("refuses BEFORE publishing when a change needs an inexpressible mode", async () => {
    const r = repo();
    const fake = await fakeGitHub(r.base);
    try {
      writeFileSync(join(r.dir, "run.sh"), "#!/bin/sh\n");
      chmodSync(join(r.dir, "run.sh"), 0o755);
      const out = await callPublish(fake.url, { owner: "o", repo: "r", message: "m", path: r.dir });
      assert.ok(out.error, "expected a structured error");
      assert.match(out.error, /run\.sh/);
      assert.match(out.error, /100755/);
      // Nothing may reach GitHub — the refusal is atomic.
      assert.equal(fake.mutations.length, 0);
    } finally {
      await fake.close();
      r.cleanup();
    }
  });

  test("never falls back to git push", async () => {
    // The whole point: a failure must surface, not quietly publish unsigned.
    const r = repo();
    const fake = await fakeGitHub("some-other-tip");
    // GIT_TRACE writes to a plain file, independent of the child's stdio (which
    // the tool pipes and discards on failure) — the only way from outside to
    // prove `git fetch` was actually invoked rather than skipped. A real fake
    // git-over-HTTP remote can't do this job here: the tool shells out with
    // execFileSync, which blocks this SAME process's event loop, so a Node
    // http-server standing in for `origin` would never get scheduled to reply
    // (verified empirically — it hangs until the tool's own fetch timeout).
    const traceFile = join(tmpdir(), `publish-tool-trace-${process.pid}-${Date.now()}.log`);
    const prevTrace = process.env.GIT_TRACE;
    process.env.GIT_TRACE = traceFile;
    try {
      writeFileSync(join(r.dir, "a.txt"), "two\n");
      const out = await callPublish(fake.url, { owner: "o", repo: "r", message: "m", path: r.dir });
      // The tip we were told is not in the local object store, so the tool must
      // stop rather than guess a base.
      assert.ok(out.error);
      assert.match(out.error, /some-other-tip/);
      const trace = existsSync(traceFile) ? readFileSync(traceFile, "utf8") : "";
      assert.match(
        trace,
        /git fetch --depth=1 origin some-other-tip/,
        "expected the tool to actually invoke git fetch, not skip straight to refusing",
      );
    } finally {
      if (prevTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = prevTrace;
      rmSync(traceFile, { force: true });
      await fake.close();
      r.cleanup();
    }
  });
});

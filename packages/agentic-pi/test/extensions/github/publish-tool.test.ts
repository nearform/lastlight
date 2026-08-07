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

const staticAuth: GitHubAuth = {
  getToken: async () => "test-token",
  expiresAt: null,
  canRefresh: false,
};

/** One request the fake server saw, so a test can prove no remote write of any
 * kind happened — not just that no GraphQL mutation was sent. */
interface LoggedRequest {
  method: string;
  url: string;
}

/** Serves getRef for `main` and accepts the publish mutation. Logs every
 * request (not just the GraphQL ones) in `requests`. */
function fakeGitHub(tip: string): Promise<{
  url: string;
  mutations: any[];
  requests: LoggedRequest[];
  close: () => Promise<void>;
}> {
  const mutations: any[] = [];
  const requests: LoggedRequest[] = [];
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "GET", url: req.url ?? "" });
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
        requests,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

/**
 * A GitHub fake for the "branch does not exist yet" scenario: `opts.target`
 * 404s (as a fresh branch would), `opts.base` resolves to `opts.baseTip`, and
 * the repo's `default_branch` is `opts.base`. Every request is logged so a
 * test can assert no POST — no createBranch, no createCommitOnBranch — ever
 * reached the server.
 */
function fakeGitHubMissingBranch(opts: {
  target: string;
  base: string;
  baseTip: string;
}): Promise<{ url: string; requests: LoggedRequest[]; close: () => Promise<void> }> {
  const requests: LoggedRequest[] = [];
  const targetRefPath = `/git/ref/heads%2F${encodeURIComponent(opts.target)}`;
  const baseRefPath = `/git/ref/heads%2F${encodeURIComponent(opts.base)}`;
  const server = createServer((req, res) => {
    requests.push({ method: req.method ?? "GET", url: req.url ?? "" });
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      res.setHeader("content-type", "application/json");
      const url = req.url ?? "";
      if (url.includes(targetRefPath)) {
        res.statusCode = 404;
        res.end(JSON.stringify({ message: "Not Found" }));
        return;
      }
      if (url.includes(baseRefPath)) {
        res.end(JSON.stringify({ object: { sha: opts.baseTip } }));
        return;
      }
      if (url === "/repos/o/r") {
        res.end(JSON.stringify({ default_branch: opts.base }));
        return;
      }
      // Anything else — createBranch (POST git/refs) or createCommitOnBranch
      // (POST /graphql) — is a remote write this scenario must never reach.
      res.statusCode = 500;
      res.end(JSON.stringify({ message: `unexpected request in this test: ${req.method} ${url}` }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        requests,
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
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@e",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@e",
      },
    });
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a.txt"), "one\n");
  g("add", "-A");
  g("commit", "-qm", "base");
  return {
    dir,
    base: g("rev-parse", "HEAD").trim(),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
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
      // a.txt existed at the base (modified); b.txt did not (added). Checked
      // separately — concatenating both arrays before sorting would still pass
      // if the split were broken and everything landed in just one of them.
      assert.deepEqual(out.added, ["b.txt"]);
      assert.deepEqual(out.modified, ["a.txt"]);

      const input = fake.mutations[0].variables.input;
      assert.equal(input.expectedHeadOid, r.base);
      assert.deepEqual(input.message, { headline: "fix: thing", body: "body line" });
      // `status` must never reach GraphQL — FileAddition only accepts these two.
      assert.deepEqual(Object.keys(input.fileChanges.additions[0]).sort(), ["contents", "path"]);
    } finally {
      await fake.close();
      r.cleanup();
    }
  });

  test("include narrows what reaches GitHub to the listed pathspecs", async () => {
    // End-to-end proof that the schema parameter is wired through to the diff,
    // not just that diffWorktreeAgainst can narrow. The five artifact phases
    // pass `include: [".lastlight"]` so they publish exactly what their old
    // `git add .lastlight/` staged — a stray file the phase's test run left in
    // the checkout must not ride along into the user's branch.
    const r = repo();
    const fake = await fakeGitHub(r.base);
    try {
      execFileSync("mkdir", ["-p", join(r.dir, ".lastlight")]);
      writeFileSync(join(r.dir, ".lastlight", "verdict.md"), "APPROVED\n");
      writeFileSync(join(r.dir, "coverage.xml"), "stray\n");
      writeFileSync(join(r.dir, "a.txt"), "touched by the test run\n");

      const out = await callPublish(fake.url, {
        owner: "o",
        repo: "r",
        message: "review: verdict",
        path: r.dir,
        include: [".lastlight"],
      });
      assert.equal(out.published, true);
      assert.deepEqual(out.added, [".lastlight/verdict.md"]);
      assert.deepEqual(out.modified, []);

      const additions = fake.mutations[0].variables.input.fileChanges.additions;
      assert.deepEqual(
        additions.map((a: { path: string }) => a.path),
        [".lastlight/verdict.md"],
        "only the included pathspec may reach the signed-commit mutation",
      );
    } finally {
      await fake.close();
      r.cleanup();
    }
  });

  test("an empty include says so, rather than blaming an unchanged tree", async () => {
    // Callers are told to trust this string — pr-fix.md routes `published:
    // false` straight to `outcome=no-change`. Reporting "the working tree
    // matches the branch" for what is really a caller error would have the
    // agent record a real, unpublished change as nothing to do.
    const r = repo();
    const fake = await fakeGitHub(r.base);
    try {
      writeFileSync(join(r.dir, "a.txt"), "genuinely changed\n");
      const out = await callPublish(fake.url, {
        owner: "o",
        repo: "r",
        message: "m",
        path: r.dir,
        include: [],
      });
      assert.equal(out.published, false);
      assert.match(out.reason, /`include` was an empty list/);
      assert.doesNotMatch(out.reason, /working tree matches the branch/);
      assert.equal(fake.mutations.length, 0);
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
      // The name of this test: it must fetch, never push, and never reach GitHub.
      assert.doesNotMatch(trace, /git push/);
      assert.equal(fake.mutations.length, 0);
    } finally {
      if (prevTrace === undefined) delete process.env.GIT_TRACE;
      else process.env.GIT_TRACE = prevTrace;
      rmSync(traceFile, { force: true });
      await fake.close();
      r.cleanup();
    }
  });

  test("refuses before creating a branch that doesn't exist yet — no remote write happens", async () => {
    // This is the scenario Important 1 in review got wrong: when the target
    // branch is missing, createBranch used to run BEFORE the refusal checks,
    // so an unsupported-mode refusal still left a branch created on GitHub.
    const r = repo();
    const fake = await fakeGitHubMissingBranch({
      target: "feat/new",
      base: "main",
      baseTip: r.base,
    });
    try {
      writeFileSync(join(r.dir, "run.sh"), "#!/bin/sh\n");
      chmodSync(join(r.dir, "run.sh"), 0o755);
      const out = await callPublish(fake.url, {
        owner: "o",
        repo: "r",
        message: "m",
        branch: "feat/new",
        path: r.dir,
      });
      assert.ok(out.error, "expected a structured error");
      assert.match(out.error, /run\.sh/);
      assert.match(out.error, /100755/);
      // The tool had to read the target ref (404), the repo's default_branch,
      // and the base ref to resolve what to diff against — but must never POST
      // (no createBranch, no createCommitOnBranch).
      assert.ok(
        fake.requests.length > 0,
        "expected the tool to have read at least the branch tips",
      );
      assert.deepEqual(
        fake.requests.filter((req) => req.method !== "GET"),
        [],
        `expected only GET requests, got: ${JSON.stringify(fake.requests)}`,
      );
    } finally {
      await fake.close();
      r.cleanup();
    }
  });
});

describe("github_publish local sync", () => {
  test("reports the git failure reason instead of throwing, and never touches the files", async () => {
    const r = repo();
    const fake = await fakeGitHub(r.base);
    try {
      writeFileSync(join(r.dir, "a.txt"), "two\n");
      const out = await callPublish(fake.url, { owner: "o", repo: "r", message: "m", path: r.dir });
      assert.equal(out.published, true);
      // No `origin` remote in this temp repo, so the fetch cannot succeed — the
      // tool must report git's actual stderr reason (not the generic "Command
      // failed: …" wrapper, and not throw), and must leave the file alone.
      assert.equal(
        out.local_sync,
        "skipped: fatal: 'origin' does not appear to be a git repository",
      );
      assert.equal(readFileSync(join(r.dir, "a.txt"), "utf8"), "two\n");
    } finally {
      await fake.close();
      r.cleanup();
    }
  });

  test("resets local HEAD onto the published commit on success", async () => {
    // A real second repo stands in for the GitHub remote so `git fetch origin`
    // has something to fetch — the oid the fake GraphQL server hands back has
    // to exist as a real commit for `git reset --mixed` to succeed against it.
    const r = repo();
    const remoteDir = mkdtempSync(join(tmpdir(), "publish-tool-remote-"));
    try {
      execFileSync("git", ["clone", "-q", r.dir, remoteDir]);
      execFileSync(
        "git",
        [
          "-c",
          "user.name=t",
          "-c",
          "user.email=t@e",
          "commit",
          "-q",
          "--allow-empty",
          "-m",
          "published",
        ],
        { cwd: remoteDir },
      );
      const publishedOid = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: remoteDir,
        encoding: "utf8",
      }).trim();
      execFileSync("git", ["remote", "add", "origin", remoteDir], { cwd: r.dir });

      const server = createServer((req, res) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
          res.setHeader("content-type", "application/json");
          if (req.url?.endsWith("/graphql")) {
            res.end(
              JSON.stringify({
                data: {
                  createCommitOnBranch: {
                    commit: {
                      oid: publishedOid,
                      url: "u",
                      committer: { name: "bot", email: "b@e" },
                      signature: { isValid: true, state: "VALID", wasSignedByGitHub: true },
                    },
                  },
                },
              }),
            );
            return;
          }
          res.end(JSON.stringify({ object: { sha: r.base } }));
        });
      });
      await new Promise<void>((res2) => server.listen(0, "127.0.0.1", () => res2()));
      const { port } = server.address() as AddressInfo;
      try {
        writeFileSync(join(r.dir, "a.txt"), "two\n");
        const out = await callPublish(`http://127.0.0.1:${port}`, {
          owner: "o",
          repo: "r",
          message: "m",
          path: r.dir,
        });
        assert.equal(out.local_sync, "ok");
        assert.equal(
          execFileSync("git", ["rev-parse", "HEAD"], { cwd: r.dir, encoding: "utf8" }).trim(),
          publishedOid,
        );
      } finally {
        await new Promise<void>((res2) => server.close(() => res2()));
      }
    } finally {
      rmSync(remoteDir, { recursive: true, force: true });
      r.cleanup();
    }
  });

  test("skips the sync rather than repointing whichever branch is checked out", async () => {
    // Reviewer-caught bug: `reset --mixed` moves the CURRENT branch, not
    // necessarily `target` — `branch` can name a different branch than the one
    // checked out. Publishing to "feature" while sitting on "main" must never
    // silently move local "main" onto the "feature" commit.
    const r = repo();
    const fake = await fakeGitHub(r.base);
    try {
      writeFileSync(join(r.dir, "a.txt"), "two\n");
      const out = await callPublish(fake.url, {
        owner: "o",
        repo: "r",
        message: "m",
        branch: "feature",
        path: r.dir,
      });
      assert.equal(out.published, true);
      assert.equal(out.local_sync, "skipped: published to feature, checked out on main");
      const branchName = execFileSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
        cwd: r.dir,
        encoding: "utf8",
      }).trim();
      const head = execFileSync("git", ["rev-parse", "HEAD"], {
        cwd: r.dir,
        encoding: "utf8",
      }).trim();
      assert.equal(branchName, "main");
      assert.equal(head, r.base, "local main must not have moved");
    } finally {
      await fake.close();
      r.cleanup();
    }
  });

  test("fails loudly when GitHub did not sign the commit it created", async () => {
    const r = repo();
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url?.endsWith("/graphql")) {
          res.end(
            JSON.stringify({
              data: {
                createCommitOnBranch: {
                  commit: {
                    oid: "unsignedoid",
                    url: "u",
                    committer: null,
                    signature: { isValid: false, state: "UNSIGNED", wasSignedByGitHub: false },
                  },
                },
              },
            }),
          );
          return;
        }
        res.end(JSON.stringify({ object: { sha: r.base } }));
      });
    });
    await new Promise<void>((res2) => server.listen(0, "127.0.0.1", () => res2()));
    const { port } = server.address() as AddressInfo;
    try {
      writeFileSync(join(r.dir, "a.txt"), "two\n");
      const out = await callPublish(`http://127.0.0.1:${port}`, {
        owner: "o",
        repo: "r",
        message: "m",
        path: r.dir,
      });
      assert.ok(out.error);
      assert.match(out.error, /unsignedoid/);
      assert.match(out.error, /did not sign/i);
    } finally {
      await new Promise<void>((res2) => server.close(() => res2()));
      r.cleanup();
    }
  });
});

describe("github_publish signature assertion", () => {
  test("fails loudly when GitHub signed the commit but the signature is not valid", async () => {
    // wasSignedByGitHub can be true while isValid is false — e.g. a signature
    // GitHub attached but could not verify. Reporting `verified: true` here
    // would be exactly the misleading blob-nobody-reads outcome this task
    // exists to close off.
    const r = repo();
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url?.endsWith("/graphql")) {
          res.end(
            JSON.stringify({
              data: {
                createCommitOnBranch: {
                  commit: {
                    oid: "badoid",
                    url: "u",
                    committer: { name: "GitHub", email: "noreply@github.com" },
                    signature: { isValid: false, state: "BAD_CERT", wasSignedByGitHub: true },
                  },
                },
              },
            }),
          );
          return;
        }
        res.end(JSON.stringify({ object: { sha: r.base } }));
      });
    });
    await new Promise<void>((res2) => server.listen(0, "127.0.0.1", () => res2()));
    const { port } = server.address() as AddressInfo;
    try {
      writeFileSync(join(r.dir, "a.txt"), "two\n");
      const out = await callPublish(`http://127.0.0.1:${port}`, {
        owner: "o",
        repo: "r",
        message: "m",
        path: r.dir,
      });
      assert.ok(out.error);
      assert.match(out.error, /badoid/);
      assert.match(out.error, /not valid/i);
      assert.notEqual(out.verified, true);
    } finally {
      await new Promise<void>((res2) => server.close(() => res2()));
      r.cleanup();
    }
  });

  test("names STALE_DATA explicitly instead of surfacing the raw GraphQL error", async () => {
    // GitHub's REST getRef can lag its own GraphQL write path (see
    // docs/plans/signed-commit-publish/00-findings.md #4), so a mutation can be
    // rejected as stale even with nothing else pushing. A retry here is wrong —
    // the change set is worktree-vs-tip, so rebasing onto a moved tip would
    // render another party's additions as deletions — but the agent needs to
    // know a plain re-run is likely to work, not that the branch is broken.
    const r = repo();
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        res.setHeader("content-type", "application/json");
        if (req.url?.endsWith("/graphql")) {
          res.end(
            JSON.stringify({
              errors: [
                {
                  type: "STALE_DATA",
                  message: `Expected branch to point to "${r.base}" but it did not.  Pull and try again.`,
                },
              ],
            }),
          );
          return;
        }
        res.end(JSON.stringify({ object: { sha: r.base } }));
      });
    });
    await new Promise<void>((res2) => server.listen(0, "127.0.0.1", () => res2()));
    const { port } = server.address() as AddressInfo;
    try {
      writeFileSync(join(r.dir, "a.txt"), "two\n");
      const out = await callPublish(`http://127.0.0.1:${port}`, {
        owner: "o",
        repo: "r",
        message: "m",
        path: r.dir,
      });
      assert.ok(out.error);
      assert.match(out.error, /STALE_DATA/);
      assert.match(out.error, /re-run/i);
      assert.doesNotMatch(out.error, /Pull and try again/);
    } finally {
      await new Promise<void>((res2) => server.close(() => res2()));
      r.cleanup();
    }
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  GITHUB_EXTRAHEADER_KEY,
  gitAuthEnv,
  githubBasicAuthB64,
  githubExtraheaderValue,
} from "../../../src/extensions/github/credentials.js";

describe("githubBasicAuthB64 / githubExtraheaderValue", () => {
  test("base64-encodes x-access-token:<token>, tolerating weird charsets", () => {
    // A token GitHub might return that the old URL-embed guard would reject.
    const token = "ghs_weird.tok/en+v=";
    const b64 = githubBasicAuthB64(token);
    assert.equal(Buffer.from(b64, "base64").toString("utf8"), `x-access-token:${token}`);
    assert.equal(githubExtraheaderValue(token), `AUTHORIZATION: basic ${b64}`);
  });
});

describe("gitAuthEnv", () => {
  test("emits a github.com-scoped extraheader + safe.directory (COUNT=2)", () => {
    const env = gitAuthEnv("ghs_abc123");
    assert.equal(env.GIT_CONFIG_COUNT, "2");
    assert.equal(env.GIT_CONFIG_KEY_0, "safe.directory");
    assert.equal(env.GIT_CONFIG_VALUE_0, "*");
    assert.equal(env.GIT_CONFIG_KEY_1, GITHUB_EXTRAHEADER_KEY);
    assert.match(env.GIT_CONFIG_VALUE_1, /^AUTHORIZATION: basic /);
  });

  test("git resolves the extraheader for github.com and nothing else", () => {
    // Proves the mechanism end-to-end (matches lastlight's local git 2.50
    // verification): the URL-subsection key resolves via --get-urlmatch and is
    // scoped to github.com, so the token is never sent to other hosts.
    const token = "ghs_weird.tok/en+v=";
    const env = { ...process.env, ...gitAuthEnv(token) };
    const dir = mkdtempSync(join(tmpdir(), "agentic-pi-gitauth-"));
    try {
      execFileSync("git", ["-C", dir, "init", "-q"], { stdio: "pipe" });
      const gh = execFileSync(
        "git",
        ["-C", dir, "config", "--get-urlmatch", "http.extraheader", "https://github.com/o/r.git"],
        { env, encoding: "utf8" },
      ).trim();
      assert.equal(gh, githubExtraheaderValue(token));
      // The base64 round-trips (padding `=` and the `: ` space survive).
      const b64 = gh.replace(/^AUTHORIZATION: basic /, "");
      assert.equal(Buffer.from(b64, "base64").toString("utf8"), `x-access-token:${token}`);

      // A non-github host resolves to nothing → the token isn't sent there.
      // `git config --get-urlmatch` exits 1 (no output) when nothing matches.
      let other = "";
      try {
        other = execFileSync(
          "git",
          ["-C", dir, "config", "--get-urlmatch", "http.extraheader", "https://registry.npmjs.org/x"],
          { env, encoding: "utf8", stdio: "pipe" },
        ).trim();
      } catch (err) {
        assert.equal((err as { status?: number }).status, 1);
      }
      assert.equal(other, "");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

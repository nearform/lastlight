import { describe, test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { loadGitHubExtension } from "../../../src/extensions/github/index.js";

/**
 * `RunConfig.githubAuthEnv` REPLACES `process.env` as the credential source —
 * it is not merged with it. That's what lets a host (lastlight) run several
 * agents concurrently in one process: `process.env` is global, so per-run
 * credentials passed that way leak between runs (lastlight #215 — a run used a
 * sibling run's repo-scoped token and every `github_*` write 403'd). Replacement
 * rather than merge also means the host's App PEM can't reach an agent that was
 * handed a downscoped token.
 */
describe("loadGitHubExtension — explicit githubAuthEnv", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of ["GITHUB_APP_ID", "GITHUB_APP_PRIVATE_KEY_PATH", "GITHUB_APP_INSTALLATION_ID", "GITHUB_TOKEN"]) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });

  function writeAppEnv(): void {
    const dir = mkdtempSync(join(tmpdir(), "authenv-"));
    const pem = join(dir, "app.pem");
    writeFileSync(pem, "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n");
    process.env.GITHUB_APP_ID = "123";
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = pem;
    process.env.GITHUB_APP_INSTALLATION_ID = "456";
  }

  test("uses the passed token and ignores App creds in process.env", async () => {
    writeAppEnv();
    const ext = loadGitHubExtension("read", { env: { GITHUB_TOKEN: "ghs_scoped" } });
    assert.equal(ext.status, "configured");
    // Static-token auth, not App auth: it cannot re-mint (see auth-refresh.test.ts).
    assert.equal(ext.auth?.canRefresh, false);
    assert.equal(await ext.auth?.getToken(), "ghs_scoped");
  });

  test("ignores a process.env token too — the caller's env is authoritative", () => {
    process.env.GITHUB_TOKEN = "ghp_host_pat";
    const ext = loadGitHubExtension("read", { env: {} });
    assert.equal(ext.status, "skipped");
    assert.equal(ext.reason, "no-credentials");
  });

  test("falls back to process.env when no env is passed (the CLI path)", async () => {
    process.env.GITHUB_TOKEN = "ghp_host_pat";
    const ext = loadGitHubExtension("read");
    assert.equal(ext.status, "configured");
    assert.equal(await ext.auth?.getToken(), "ghp_host_pat");
  });
});

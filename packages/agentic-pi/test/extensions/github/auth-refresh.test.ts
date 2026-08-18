import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildAuthFromEnv } from "../../../src/extensions/github/auth.js";

/**
 * `canRefresh` is what `github_refresh_git_auth` and the 401 hint branch on: a
 * static injected token cannot be re-minted in-sandbox, so the tool must report
 * `refreshed:false` and the hint must not advise a refresh that can't help.
 * Regression guard for the "refreshed:true but the token never changes" loop.
 */
describe("GitHubAuth.canRefresh — honest refreshability", () => {
  test("a static GITHUB_TOKEN cannot refresh (no key to re-mint from)", () => {
    const { auth } = buildAuthFromEnv({ GITHUB_TOKEN: "ghs_static" });
    assert.equal(auth?.canRefresh, false);
  });

  test("App auth can refresh (re-mints from the installation key)", () => {
    const dir = mkdtempSync(join(tmpdir(), "canrefresh-"));
    const pem = join(dir, "app.pem");
    writeFileSync(pem, "-----BEGIN PRIVATE KEY-----\nfixture\n-----END PRIVATE KEY-----\n");
    const { auth } = buildAuthFromEnv({
      GITHUB_APP_ID: "123",
      GITHUB_APP_PRIVATE_KEY_PATH: pem,
      GITHUB_APP_INSTALLATION_ID: "456",
    });
    assert.equal(auth?.canRefresh, true);
  });
});

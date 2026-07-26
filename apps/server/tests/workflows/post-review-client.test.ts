import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// The fix reads the App PEM path from getRuntimeConfig() (boot-stable), NOT the
// live process.env a concurrent gondolin run transiently clears. Keep the rest
// of the config module real; only stub getRuntimeConfig.
vi.mock("#src/config/config.js", async (orig) => ({
  ...(await orig<typeof import("#src/config/config.js")>()),
  getRuntimeConfig: vi.fn(),
}));

import { getRuntimeConfig } from "#src/config/config.js";
import { resolveReviewGitHubClient } from "#src/workflows/handlers/post-review.js";

describe("resolveReviewGitHubClient — stable config, immune to the process.env race", () => {
  let saved: string | undefined;
  beforeEach(() => {
    saved = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
  });
  afterEach(() => {
    if (saved === undefined) delete process.env.GITHUB_APP_PRIVATE_KEY_PATH;
    else process.env.GITHUB_APP_PRIVATE_KEY_PATH = saved;
    vi.clearAllMocks();
  });

  it("reads the App PEM path from getRuntimeConfig even when process.env is cleared mid-run", () => {
    const dir = mkdtempSync(join(tmpdir(), "review-client-"));
    const pem = join(dir, "app.pem");
    writeFileSync(pem, "-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n");
    vi.mocked(getRuntimeConfig).mockReturnValue({
      githubApp: { appId: "1", privateKeyPath: pem, installationId: "2" },
    } as unknown as ReturnType<typeof getRuntimeConfig>);

    // Simulate a concurrent gondolin run having cleared the shared process.env
    // (agent-executor applyEnv sets GITHUB_APP_* to "" for in-process runs).
    process.env.GITHUB_APP_PRIVATE_KEY_PATH = "";

    // Must NOT throw EISDIR: reading process.env="" resolves to the cwd (a
    // directory) and readFileSync blows up — that was the bug.
    expect(() => resolveReviewGitHubClient({})).not.toThrow();
  });

  it("the eval path (githubApiBaseUrl) uses a bearer token, no App PEM read", () => {
    vi.mocked(getRuntimeConfig).mockReturnValue(undefined);
    expect(() =>
      resolveReviewGitHubClient({ githubApiBaseUrl: "http://127.0.0.1:1/api" }),
    ).not.toThrow();
  });
});

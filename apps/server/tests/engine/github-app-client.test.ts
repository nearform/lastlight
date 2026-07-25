import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";

const hookError = vi.fn();
const octokitInstance = { sentinel: "octokit", hook: { error: hookError }, auth: vi.fn() };
const createAppAuth = vi.fn();
const Octokit = vi.fn(function () {
  return octokitInstance;
});

vi.mock("octokit", () => ({
  Octokit,
}));

vi.mock("@octokit/auth-app", () => ({
  createAppAuth,
}));

const tempDirs: string[] = [];

afterEach(() => {
  vi.clearAllMocks();
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("githubAppClient", () => {
  it("constructs an Octokit GitHub App client from a private key file", async () => {
    const fixturePrivateKey = "-----BEGIN PRIVATE KEY-----\nfixture-key\n-----END PRIVATE KEY-----\n";
    const tempDir = mkdtempSync(join(tmpdir(), "github-app-client-"));
    tempDirs.push(tempDir);
    const privateKeyPath = join(tempDir, "app.pem");
    writeFileSync(privateKeyPath, fixturePrivateKey);

    const { githubAppClient } = await import("#src/engine/github/github-app-client.js");

    const client = githubAppClient({ appId: "123", installationId: "456", privateKeyPath });

    expect(client).toBe(octokitInstance);
    expect(Octokit).toHaveBeenCalledOnce();
    expect(Octokit).toHaveBeenCalledWith({
      authStrategy: createAppAuth,
      auth: {
        appId: "123",
        privateKey: fixturePrivateKey,
        installationId: "456",
      },
    });
    // The 403/404 scope diagnostic is wired onto the client's request-error hook.
    expect(hookError).toHaveBeenCalledWith("request", expect.any(Function));
  });
});

describe("githubAppClient — 403/404 scope diagnostic", () => {
  async function buildAndCaptureHandler() {
    const tempDir = mkdtempSync(join(tmpdir(), "github-app-client-"));
    tempDirs.push(tempDir);
    const privateKeyPath = join(tempDir, "app.pem");
    writeFileSync(privateKeyPath, "-----BEGIN PRIVATE KEY-----\nk\n-----END PRIVATE KEY-----\n");
    const { githubAppClient } = await import("#src/engine/github/github-app-client.js");
    githubAppClient({ appId: "123", installationId: "456", privateKeyPath });
    return hookError.mock.calls.at(-1)![1] as (err: unknown, opts: unknown) => Promise<void>;
  }

  it("logs the endpoint's required perms + the token's actual scope on a 404, then re-throws", async () => {
    octokitInstance.auth.mockResolvedValue({
      repositorySelection: "all",
      permissions: { issues: "write", pull_requests: "write" },
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = await buildAndCaptureHandler();

    const err = {
      status: 404,
      response: { headers: { "x-accepted-github-permissions": "pull_requests=read" } },
    };
    await expect(handler(err, { method: "GET", url: "/repos/o/private/pulls" })).rejects.toBe(err);

    const line = warn.mock.calls.map((c) => String(c[0])).find((s) => s.includes("[github-diag]"))!;
    expect(line).toContain("GET /repos/o/private/pulls -> 404");
    expect(line).toContain("x-accepted-github-permissions=pull_requests=read");
    expect(line).toContain("repository_selection=all");
    // Permission LEVELS are logged, not just names — so a read grant where write
    // is required is visible against x-accepted-github-permissions (#213/#215).
    expect(line).toContain("issues=write,pull_requests=write");
    warn.mockRestore();
  });

  it("does not log for non-403/404 errors but still re-throws", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const handler = await buildAndCaptureHandler();

    const err = { status: 500 };
    await expect(handler(err, { method: "GET", url: "/x" })).rejects.toBe(err);
    expect(warn.mock.calls.some((c) => String(c[0]).includes("[github-diag]"))).toBe(false);
    warn.mockRestore();
  });
});

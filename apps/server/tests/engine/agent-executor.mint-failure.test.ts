/**
 * Fail-fast on an expected-but-failed GitHub token mint.
 *
 * When the App is configured and a workflow requests a github access profile,
 * the executor mints a repo-scoped installation token. If that mint fails — the
 * classic case being a `managedRepos` entry whose repo was deleted / transferred
 * to another org / had App access revoked, so GitHub 422s the scoped-token
 * request — the executor MUST NOT run a toolless agent. Without a token
 * agentic-pi skips the entire github extension (no `github_*` tools) and any
 * pre-clone would fail too, so the run can only flail. Instead it returns a hard
 * failure with an actionable message, before a sandbox is ever provisioned.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPairSync } from "node:crypto";

const runSpy = vi.fn();

// If the fail-fast regressed, the run would reach here — the spy lets us assert
// it did NOT, i.e. no sandbox/agent was spun up.
vi.mock("agentic-pi", () => ({
  run: (opts: unknown) => {
    runSpy(opts);
    throw new Error("mint-failure-test: agent should never run");
  },
}));

// Make the token mint blow up exactly like GitHub's 422 for an inaccessible repo.
vi.mock("#src/engine/github/git-auth.js", async (importActual) => {
  const actual = await importActual<typeof import("#src/engine/github/git-auth.js")>();
  return {
    ...actual,
    refreshGitAuth: vi.fn(async () => {
      throw new Error(
        "GitHub App token request failed (422): There is at least one repository " +
          "that does not exist or is not accessible to the parent installation.",
      );
    }),
  };
});

const { executeAgent } = await import("#src/engine/agent-executor.js");
const { initInstallationDirectory, resetInstallationDirectoryForTests } = await import(
  "#src/engine/github/installations.js"
);

/**
 * A real RSA key: the "not installed" case below must reach the stubbed
 * `GET /app/installations` and come back EMPTY, not die signing the App JWT —
 * otherwise it would be testing a lookup failure, which is a different thing.
 */
function writePem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = mkdtempSync(join(tmpdir(), "ll-mint-failure-"));
  const path = join(dir, "app.pem");
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  return path;
}
const privateKeyPath = writePem();

/** Run a phase against `owner/repo` with a repo-write profile. */
function run(owner: string, repo: string) {
  return executeAgent(
    "assess PR",
    { sandbox: "none" },
    { githubAccess: { owner, repo, profile: "repo-write", allowMcpAppAuth: false } },
  );
}

describe("executeAgent — mint-failure fail-fast", () => {
  const savedAppId = process.env.GITHUB_APP_ID;
  beforeEach(() => {
    runSpy.mockClear();
    process.env.GITHUB_APP_ID = "12345"; // App configured → a mint is attempted
    // The App is installed on `cliftonc` only.
    initInstallationDirectory({ appId: "12345", privateKeyPath }).note("cliftonc", "121130978");
  });
  afterEach(() => {
    resetInstallationDirectoryForTests();
    if (savedAppId === undefined) delete process.env.GITHUB_APP_ID;
    else process.env.GITHUB_APP_ID = savedAppId;
  });

  it("returns a hard failure and never provisions a sandbox when the mint 422s", async () => {
    const result = await run("cliftonc", "lastlight-test-repo");

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("error_fatal");
    expect(result.error).toMatch(/Could not mint a scoped GitHub token/);
    expect(result.error).toMatch(/cliftonc\/lastlight-test-repo/);
    // The decisive assertion: we bailed before ever reaching the agent runtime.
    expect(runSpy).not.toHaveBeenCalled();
  });

  it("names the ACCOUNT when the App isn't installed there, and never calls GitHub", async () => {
    // The drizby/mirevue failure: a second org in `managedRepos` that the App was
    // never installed on. GitHub's own 422 for this says "at least one repository
    // ... is not accessible to the parent installation", which reads as a repo
    // problem and sends the operator to the wrong fix. We answer before asking.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => [], text: async () => "[]" })),
    );

    const result = await run("mirevue", "mirevue");

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("error_fatal");
    expect(result.error).toMatch(/not installed on "mirevue"/);
    expect(result.error).toMatch(/Install the GitHub App on the "mirevue" account/);
    expect(runSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});

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

describe("executeAgent — mint-failure fail-fast", () => {
  const savedAppId = process.env.GITHUB_APP_ID;
  beforeEach(() => {
    runSpy.mockClear();
    process.env.GITHUB_APP_ID = "12345"; // App configured → a mint is attempted
  });
  afterEach(() => {
    if (savedAppId === undefined) delete process.env.GITHUB_APP_ID;
    else process.env.GITHUB_APP_ID = savedAppId;
  });

  it("returns a hard failure and never provisions a sandbox when the mint 422s", async () => {
    const result = await executeAgent(
      "assess PR",
      { sandbox: "none" },
      {
        githubAccess: {
          owner: "cliftonc",
          repo: "lastlight-test-repo",
          profile: "repo-write",
          allowMcpAppAuth: false,
        },
      },
    );

    expect(result.success).toBe(false);
    expect(result.stopReason).toBe("error_fatal");
    expect(result.error).toMatch(/Could not mint a scoped GitHub token/);
    expect(result.error).toMatch(/cliftonc\/lastlight-test-repo/);
    // The decisive assertion: we bailed before ever reaching the agent runtime.
    expect(runSpy).not.toHaveBeenCalled();
  });
});

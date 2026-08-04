/**
 * `GitHubClient` resolves its Octokit per repository OWNER.
 *
 * Every method already takes `owner` first, so the client can bind one Octokit
 * per INSTALLATION instead of the single configured installation id it used to
 * — which is what made every harness-side call against a second account (a
 * comment, a reaction, a check run, a `.lastlight/` fetch) 404. These tests pin
 * the seam: one client per installation, reused; two accounts get two; token
 * mode is unaffected; and an uninstalled account fails legibly.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { generateKeyPairSync } from "crypto";

const appClientSpy = vi.fn();

vi.mock("#src/engine/github/github-app-client.js", async (importActual) => {
  const actual =
    await importActual<typeof import("#src/engine/github/github-app-client.js")>();
  return {
    ...actual,
    githubAppClient: (config: { installationId: string }) => {
      appClientSpy(config);
      // A stand-in Octokit: only the calls the assertions below make exist.
      return {
        rest: {
          issues: { createComment: async () => ({ data: { id: 1, installationId: config.installationId } }) },
        },
        _installationId: config.installationId,
      };
    },
  };
});

const { GitHubClient, NoInstallationError } = await import("#src/engine/github/github.js");
const { InstallationDirectory, initInstallationDirectory, resetInstallationDirectoryForTests } =
  await import("#src/engine/github/installations.js");

function writePem(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const dir = mkdtempSync(join(tmpdir(), "ll-client-owner-"));
  const path = join(dir, "app.pem");
  writeFileSync(path, privateKey.export({ type: "pkcs8", format: "pem" }).toString());
  return path;
}
const privateKeyPath = writePem();

/** Seed a directory with known owner→installation mappings, no network. */
function seedDirectory(mappings: Record<string, string>): InstallationDirectory {
  const dir = initInstallationDirectory({ appId: "12345", privateKeyPath });
  for (const [owner, id] of Object.entries(mappings)) dir.note(owner, id);
  return dir;
}

beforeEach(() => {
  appClientSpy.mockClear();
  resetInstallationDirectoryForTests();
});
afterEach(() => {
  resetInstallationDirectoryForTests();
});

describe("GitHubClient — per-owner installation", () => {
  it("mints one Octokit per account, each bound to that account's installation", async () => {
    seedDirectory({ cliftonc: "121130978", mirevue: "150854297" });
    const client = new GitHubClient({ appId: "12345", privateKeyPath });

    await client.postComment("cliftonc", "drizby", 1, "hi");
    await client.postComment("mirevue", "mirevue", 98, "hi");

    expect(appClientSpy.mock.calls.map((c) => c[0].installationId)).toEqual([
      "121130978",
      "150854297",
    ]);
  });

  it("reuses the memoized client for repeat calls to the same account", async () => {
    seedDirectory({ mirevue: "150854297" });
    const client = new GitHubClient({ appId: "12345", privateKeyPath });

    await client.postComment("mirevue", "mirevue", 98, "one");
    await client.postComment("mirevue", "mirevue-www", 3, "two");

    expect(appClientSpy).toHaveBeenCalledTimes(1);
  });

  it("shares one client across repos of an account, keyed by installation not repo", async () => {
    // Two accounts that happen to have a same-named repo. Keying on the
    // installation is what stops `mirevue/mirevue` being served by the token
    // that can only see `cliftonc/mirevue`.
    seedDirectory({ cliftonc: "121130978", mirevue: "150854297" });
    const client = new GitHubClient({ appId: "12345", privateKeyPath });

    await client.postComment("cliftonc", "mirevue", 1, "a");
    await client.postComment("mirevue", "mirevue", 1, "b");

    expect(appClientSpy.mock.calls.map((c) => c[0].installationId)).toEqual([
      "121130978",
      "150854297",
    ]);
  });

  it("fails with NoInstallationError for an account the App isn't installed on", async () => {
    seedDirectory({ cliftonc: "121130978" });
    // Stop `resolve` reaching the network for the unknown owner.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({ ok: true, status: 200, json: async () => [], text: async () => "[]" })),
    );
    const client = new GitHubClient({ appId: "12345", privateKeyPath });

    await expect(client.postComment("stranger", "repo", 1, "hi")).rejects.toThrow(
      NoInstallationError,
    );
    await expect(client.postComment("stranger", "repo", 1, "hi")).rejects.toThrow(/stranger/);
    expect(appClientSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });

  it("drops a memoized client when its installation is forgotten", async () => {
    seedDirectory({ mirevue: "150854297" });
    const client = new GitHubClient({ appId: "12345", privateKeyPath });
    await client.postComment("mirevue", "mirevue", 98, "one");

    // Uninstall + re-install: GitHub issues a NEW installation id, and the old
    // memoized client must not answer for it.
    client.forgetInstallation("150854297");
    seedDirectory({ mirevue: "150854298" });
    await client.postComment("mirevue", "mirevue", 98, "two");

    expect(appClientSpy.mock.calls.map((c) => c[0].installationId)).toEqual([
      "150854297",
      "150854298",
    ]);
  });
});

describe("GitHubClient.withToken — token mode", () => {
  it("serves every owner from one client and never touches the directory", async () => {
    // No directory initialized at all: the PAT / evals path must not depend on
    // one, since there is no installation to resolve.
    const client = GitHubClient.withToken("ghp_fake", "http://127.0.0.1:9999");

    // A raw-bearer Octokit is built by the real `githubTokenClient` (unmocked),
    // so we only assert the App factory was never consulted.
    expect(() => client.forgetInstallation("1")).not.toThrow();
    expect(appClientSpy).not.toHaveBeenCalled();
  });
});

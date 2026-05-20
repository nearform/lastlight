import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn(),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    readFileSync: vi.fn().mockReturnValue("fake-pem"),
    writeFileSync: vi.fn(),
    mkdirSync: vi.fn(),
  };
});

vi.mock("crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("crypto")>();
  return {
    ...actual,
    createSign: vi.fn().mockReturnValue({
      update: vi.fn(),
      sign: vi.fn().mockReturnValue("fakesig"),
    }),
  };
});

import { execSync, execFileSync } from "child_process";
import * as fs from "fs";
import { configureGitAuth, refreshGitAuth } from "./git-auth.js";

const mockExecSync = vi.mocked(execSync);
const mockExecFileSync = vi.mocked(execFileSync);

function mockFetchToken(token = "ghs_testtoken123") {
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ token, expires_at: "2099-01-01T00:00:00Z" }),
    })
  );
}

const baseConfig = {
  appId: "12345",
  privateKeyPath: "/fake/key.pem",
  installationId: "67890",
};

describe("git-auth — global ~/.gitconfig writes are opt-in", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchToken();
    // Default: NOT opted in — must not touch global git config.
    delete process.env.LASTLIGHT_WRITE_GLOBAL_GIT;
  });

  it("configureGitAuth does NOT touch ~/.gitconfig by default", async () => {
    await configureGitAuth(baseConfig);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("refreshGitAuth does NOT touch ~/.gitconfig by default", async () => {
    await refreshGitAuth(baseConfig);
    expect(mockExecFileSync).not.toHaveBeenCalled();
  });

  it("configureGitAuth still returns the minted token when opted out", async () => {
    const out = await configureGitAuth(baseConfig);
    expect(out.token).toBe("ghs_testtoken123");
    expect(out.expiresAt).toBe("2099-01-01T00:00:00Z");
  });
});

describe("git-auth — opt-in global writes use execFileSync safely", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockFetchToken();
    process.env.LASTLIGHT_WRITE_GLOBAL_GIT = "1";
  });

  it("configureGitAuth does not use execSync", async () => {
    await configureGitAuth(baseConfig);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("configureGitAuth calls execFileSync with git array args", async () => {
    await configureGitAuth(baseConfig);
    expect(mockExecFileSync).toHaveBeenCalled();
    for (const call of mockExecFileSync.mock.calls) {
      expect(call[0]).toBe("git");
      expect(Array.isArray(call[1])).toBe(true);
    }
  });

  it("configureGitAuth writes the token to a 600-mode credentials file (no shell interp)", async () => {
    const token = "ghs_testtoken123";
    mockFetchToken(token);
    await configureGitAuth(baseConfig);

    const writeMock = vi.mocked(fs.writeFileSync);
    expect(writeMock).toHaveBeenCalled();
    const [path, contents, opts] = writeMock.mock.calls[0] as [string, string, { mode?: number }];
    expect(typeof path).toBe("string");
    expect(contents).toBe(`https://x-access-token:${token}@github.com\n`);
    expect(opts?.mode).toBe(0o600);

    const credHelperCall = mockExecFileSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("credential.helper")
    );
    expect(credHelperCall).toBeDefined();
    const args = credHelperCall![1] as string[];
    const valueArg = args[args.length - 1];
    // Helper value is the non-shell `store --file=<path>` form (no `!f`,
    // no quotes, no interpolation).
    expect(valueArg).toMatch(/^store --file=/);
    expect(valueArg).not.toContain("!f()");
    expect(valueArg).not.toContain(token);
  });

  it("configureGitAuth refuses tokens containing characters outside [A-Za-z0-9_-]", async () => {
    mockFetchToken('ghs_evil";rm -rf /;"');
    await expect(configureGitAuth(baseConfig)).rejects.toThrow(/outside \[A-Za-z0-9_-\]/);
  });

  it("refreshGitAuth does not use execSync", async () => {
    await refreshGitAuth(baseConfig);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("refreshGitAuth calls execFileSync with git array args", async () => {
    await refreshGitAuth(baseConfig);
    expect(mockExecFileSync).toHaveBeenCalled();
    for (const call of mockExecFileSync.mock.calls) {
      expect(call[0]).toBe("git");
      expect(Array.isArray(call[1])).toBe(true);
    }
  });
});

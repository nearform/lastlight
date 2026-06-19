import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("child_process")>();
  return { ...actual, execFileSync: vi.fn() };
});

import { execFileSync } from "child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { __prePopulateWorkspaceForTest as prePopulateWorkspace } from "./index.js";

const mockExec = vi.mocked(execFileSync);

const TOKEN = "ghs_secret123ABC_xyz";

/** Flatten every execFileSync invocation's argv (args[1]) for assertions. */
function calledArgs(): string[][] {
  return mockExec.mock.calls.map((c) => (c[1] as string[]) ?? []);
}

describe("prePopulateWorkspace token-leak protection", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    mockExec.mockReset();
  });

  it("does not leak the token into the success log line", () => {
    const logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    mockExec.mockReturnValue(Buffer.from(""));
    prePopulateWorkspace("/tmp/work", {
      owner: "cliftonc",
      repo: "lastlight",
      branch: "opencode-fork",
      token: TOKEN,
    });
    const joined = logSpy.mock.calls.flat().join("\n");
    expect(joined).not.toContain(TOKEN);
  });

  it("redacts the token from the warning when git clone fails", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    // execFileSync surfaces command failures with an Error whose .message
    // echoes the full command — including the authenticated URL. Reproduce
    // that shape here.
    const failure = new Error(
      `Command failed: git clone --branch opencode-fork --depth 50 ` +
      `https://x-access-token:${TOKEN}@github.com/cliftonc/lastlight.git /tmp/work\n` +
      `fatal: could not create work tree dir '/tmp/work'`,
    );
    mockExec.mockImplementation(() => { throw failure; });

    prePopulateWorkspace("/tmp/work", {
      owner: "cliftonc",
      repo: "lastlight",
      branch: "opencode-fork",
      token: TOKEN,
    });

    expect(warnSpy).toHaveBeenCalledTimes(1);
    const logged = warnSpy.mock.calls[0].join(" ");
    expect(logged).not.toContain(TOKEN);
    expect(logged).toContain("[REDACTED-TOKEN]");
    // Sanity: the non-secret part of the diagnostic is preserved.
    expect(logged).toContain("opencode-fork");
    expect(logged).toContain("Pre-clone");
  });

  it("refuses to embed tokens containing characters outside [A-Za-z0-9_-]", () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(() => prePopulateWorkspace("/tmp/work", {
      owner: "x",
      repo: "y",
      branch: "z",
      token: 'evil";rm -rf /;"',
    })).toThrow(/outside \[A-Za-z0-9_-\]/);
    expect(mockExec).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });
});

describe("prePopulateWorkspace clone depth + per-PR reuse (issue #107)", () => {
  let workDir: string;
  const REPO = "lastlight";

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), "ll-prepop-"));
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    mockExec.mockReturnValue(Buffer.from(""));
  });
  afterEach(() => {
    vi.restoreAllMocks();
    mockExec.mockReset();
    rmSync(workDir, { recursive: true, force: true });
  });

  /** Pretend the workspace already has a clone, with `marker` as last run. */
  function seedExistingClone(marker?: string): void {
    mkdirSync(join(workDir, REPO, ".git"), { recursive: true });
    if (marker !== undefined) writeFileSync(join(workDir, ".lastlight-run"), marker);
  }

  it("clones read-only workflows shallow (--depth 1 --single-branch)", () => {
    prePopulateWorkspace(workDir, {
      owner: "cliftonc", repo: REPO, branch: "main", token: TOKEN,
      runId: "run-1", shallow: true,
    });
    const clone = calledArgs().find((a) => a[0] === "clone")!;
    expect(clone).toContain("--depth");
    expect(clone[clone.indexOf("--depth") + 1]).toBe("1");
    expect(clone).toContain("--single-branch");
    // Marker stamped so a later same-run phase preserves the workspace.
    expect(readFileSync(join(workDir, ".lastlight-run"), "utf-8")).toBe("run-1");
  });

  it("clones code-writing workflows deep (--depth 50, no --single-branch)", () => {
    prePopulateWorkspace(workDir, {
      owner: "cliftonc", repo: REPO, branch: "main", token: TOKEN,
      runId: "run-1", shallow: false,
    });
    const clone = calledArgs().find((a) => a[0] === "clone")!;
    expect(clone[clone.indexOf("--depth") + 1]).toBe("50");
    expect(clone).not.toContain("--single-branch");
  });

  it("preserves the workspace when a later phase of the SAME run revisits it", () => {
    seedExistingClone("run-1");
    prePopulateWorkspace(workDir, {
      owner: "cliftonc", repo: REPO, branch: "main", token: TOKEN, runId: "run-1",
    });
    // No git ops — the architect's uncommitted scratch must survive.
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("preserves the workspace for callers that don't track a run id", () => {
    seedExistingClone();
    prePopulateWorkspace(workDir, {
      owner: "cliftonc", repo: REPO, branch: "main", token: TOKEN,
    });
    expect(mockExec).not.toHaveBeenCalled();
  });

  it("refreshes (fetch+reset+clean) when a DIFFERENT run reuses the PR dir", () => {
    seedExistingClone("old-run");
    prePopulateWorkspace(workDir, {
      owner: "cliftonc", repo: REPO, branch: "pr-head", token: TOKEN,
      runId: "new-run", shallow: true,
    });
    const verbs = calledArgs().map((a) => a[a.indexOf("-C") + 2]);
    expect(verbs).toEqual(["fetch", "checkout", "reset", "clean"]);
    // node_modules is kept warm so the next install is incremental.
    const clean = calledArgs().find((a) => a.includes("clean"))!;
    expect(clean).toContain("-e");
    expect(clean).toContain("node_modules");
    // Never re-clones from scratch.
    expect(calledArgs().some((a) => a[0] === "clone")).toBe(false);
    // Marker advanced to the new run.
    expect(readFileSync(join(workDir, ".lastlight-run"), "utf-8")).toBe("new-run");
  });

  it("does not advance the marker if the refresh fetch fails", () => {
    seedExistingClone("old-run");
    mockExec.mockImplementation((_cmd, args) => {
      if ((args as string[]).includes("fetch")) throw new Error("network down");
      return Buffer.from("");
    });
    prePopulateWorkspace(workDir, {
      owner: "cliftonc", repo: REPO, branch: "pr-head", token: TOKEN,
      runId: "new-run", shallow: true,
    });
    // Stale marker retained → the next run retries the refresh.
    expect(readFileSync(join(workDir, ".lastlight-run"), "utf-8")).toBe("old-run");
  });
});

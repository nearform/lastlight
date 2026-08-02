import { describe, it, expect, vi, beforeEach } from "vitest";

// src/worktree/manager.ts now logs via the pino LoggerPort instead of console
// — mock the logger module so the suite's stderr stays free of real pino
// JSON (no assertions here depend on the logged content).
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

vi.mock("child_process", () => ({
  execSync: vi.fn(),
  execFileSync: vi.fn().mockReturnValue(""),
}));

vi.mock("fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("fs")>();
  return {
    ...actual,
    existsSync: vi.fn().mockReturnValue(false),
    mkdirSync: vi.fn(),
    rmSync: vi.fn(),
  };
});

import { execSync, execFileSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { WorktreeManager } from "#src/worktree/manager.js";

const mockExecSync = vi.mocked(execSync);
const mockExecFileSync = vi.mocked(execFileSync);
const mockExistsSync = vi.mocked(existsSync);
const mockMkdirSync = vi.mocked(mkdirSync);

describe("WorktreeManager — no shell injection via execFileSync", () => {
  let manager: WorktreeManager;

  beforeEach(() => {
    vi.clearAllMocks();
    manager = new WorktreeManager("/tmp/test-worktrees");
    // baseDir doesn't exist → triggers mkdir and clone
    mockExistsSync.mockReturnValue(false);
  });

  it("create() does not use execSync", async () => {
    await manager.create({
      taskId: "task-001",
      repoUrl: "https://github.com/cliftonc/lastlight.git",
      branch: "feature/test",
    });
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it("create() calls execFileSync with 'git' as the command", async () => {
    await manager.create({
      taskId: "task-002",
      repoUrl: "https://github.com/cliftonc/lastlight.git",
      branch: "feature/test",
    });
    expect(mockExecFileSync).toHaveBeenCalled();
    for (const call of mockExecFileSync.mock.calls) {
      expect(call[0]).toBe("git");
      expect(Array.isArray(call[1])).toBe(true);
    }
  });

  it("create() uses mkdirSync instead of execSync for directory creation", async () => {
    await manager.create({
      taskId: "task-003",
      repoUrl: "https://github.com/cliftonc/lastlight.git",
      branch: "feature/test",
    });
    expect(mockMkdirSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ recursive: true })
    );
    // execSync must not have been used for mkdir
    const mkdirCalls = mockExecSync.mock.calls.filter(
      (c) => String(c[0]).includes("mkdir")
    );
    expect(mkdirCalls).toHaveLength(0);
  });

  it("create() passes repoUrl as a separate argument (not shell-interpolated)", async () => {
    const repoUrl = "https://github.com/cliftonc/lastlight.git";
    await manager.create({
      taskId: "task-004",
      repoUrl,
      branch: "feature/test",
    });
    const cloneCall = mockExecFileSync.mock.calls.find(
      (c) => Array.isArray(c[1]) && (c[1] as string[]).includes("clone")
    );
    expect(cloneCall).toBeDefined();
    const args = cloneCall![1] as string[];
    expect(args).toContain(repoUrl);
  });

  it("cleanup() does not use execSync", async () => {
    // First create so cleanup has something to work with
    mockExistsSync.mockReturnValue(true);
    await manager.create({
      taskId: "task-005",
      repoUrl: "https://github.com/cliftonc/lastlight.git",
      branch: "feature/test",
    });
    vi.clearAllMocks();
    mockExistsSync.mockReturnValue(true);
    await manager.cleanup("task-005", { deleteBranch: true });
    expect(mockExecSync).not.toHaveBeenCalled();
  });
});

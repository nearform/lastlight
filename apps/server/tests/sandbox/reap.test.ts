import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

// reap.ts now logs via the pino LoggerPort instead of console — mock the
// logger module so the suite's stderr stays free of real pino JSON (no
// assertions here depend on the logged content).
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

import { reapSandboxWorkspace, sandboxRoot } from "#src/sandbox/reap.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

function makeState(): { stateDir: string; sandboxDir: string } {
  const stateDir = mkdtempSync(join(tmpdir(), "reap-state-"));
  tmps.push(stateDir);
  const sandboxDir = sandboxRoot(stateDir);
  mkdirSync(sandboxDir, { recursive: true });
  return { stateDir, sandboxDir };
}

function seedWorkspace(sandboxDir: string, taskId: string): string {
  const dir = join(sandboxDir, taskId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "file.txt"), "x");
  return dir;
}

describe("reapSandboxWorkspace", () => {
  const never = () => false;
  const always = () => true;

  it("removes an existing workspace dir", () => {
    const { stateDir, sandboxDir } = makeState();
    const dir = seedWorkspace(sandboxDir, "acme-1-triage-abcd1234");
    const res = reapSandboxWorkspace({ taskId: "acme-1-triage-abcd1234", stateDir, isLive: never });
    expect(res.removed).toBe(true);
    expect(existsSync(dir)).toBe(false);
  });

  it("skips when a live container exists", () => {
    const { stateDir, sandboxDir } = makeState();
    const dir = seedWorkspace(sandboxDir, "acme-2-pr-review");
    const res = reapSandboxWorkspace({ taskId: "acme-2-pr-review", stateDir, isLive: always });
    expect(res.removed).toBe(false);
    expect(res.reason).toBe("live-container");
    expect(existsSync(dir)).toBe(true);
  });

  it("refuses a taskId that escapes the sandboxes root", () => {
    const { stateDir } = makeState();
    const res = reapSandboxWorkspace({ taskId: "../../etc", stateDir, isLive: never });
    expect(res.removed).toBe(false);
    expect(res.reason).toBe("escape");
  });

  it("is a no-op success when the dir is already gone", () => {
    const { stateDir } = makeState();
    const res = reapSandboxWorkspace({ taskId: "never-created", stateDir, isLive: never });
    expect(res.removed).toBe(true);
  });
});

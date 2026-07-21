import { afterEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync, utimesSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sweepSandboxes } from "#src/cron/sandbox-sweep.js";
import { sandboxRoot } from "#src/sandbox/reap.js";

const tmps: string[] = [];
afterEach(() => {
  for (const d of tmps.splice(0)) rmSync(d, { recursive: true, force: true });
});

const HOUR = 3_600_000;

function makeState(): { stateDir: string; sandboxDir: string } {
  const stateDir = mkdtempSync(join(tmpdir(), "sweep-state-"));
  tmps.push(stateDir);
  const sandboxDir = sandboxRoot(stateDir);
  mkdirSync(sandboxDir, { recursive: true });
  return { stateDir, sandboxDir };
}

/** Create a workspace dir and stamp its mtime `ageHours` in the past. */
function seed(sandboxDir: string, taskId: string, ageHours: number, now: number): string {
  const dir = join(sandboxDir, taskId);
  mkdirSync(dir, { recursive: true });
  const t = (now - ageHours * HOUR) / 1000;
  utimesSync(dir, t, t);
  return dir;
}

describe("sweepSandboxes", () => {
  const never = () => false;

  it("removes dirs older than retentionHours and keeps fresh ones", () => {
    const { stateDir, sandboxDir } = makeState();
    const now = Date.now();
    const stale = seed(sandboxDir, "acme-1-triage-old", 30, now);
    const fresh = seed(sandboxDir, "acme-2-triage-new", 2, now);

    const res = sweepSandboxes({ stateDir, retentionHours: 12, maxDirs: 100, isLive: never, now });

    expect(res.swept).toBe(1);
    expect(existsSync(stale)).toBe(false);
    expect(existsSync(fresh)).toBe(true);
  });

  it("evicts the oldest dirs beyond maxDirs (LRU budget)", () => {
    const { stateDir, sandboxDir } = makeState();
    const now = Date.now();
    // All fresh (within retention) so only the budget pass can act.
    const d1 = seed(sandboxDir, "acme-1-pr-review", 5, now);
    const d2 = seed(sandboxDir, "acme-2-pr-review", 3, now);
    const d3 = seed(sandboxDir, "acme-3-pr-review", 1, now);

    const res = sweepSandboxes({ stateDir, retentionHours: 24, maxDirs: 2, isLive: never, now });

    expect(res.swept).toBe(1);
    expect(existsSync(d1)).toBe(false); // oldest evicted
    expect(existsSync(d2)).toBe(true);
    expect(existsSync(d3)).toBe(true);
  });

  it("never removes a dir with a live container", () => {
    const { stateDir, sandboxDir } = makeState();
    const now = Date.now();
    const liveTask = "acme-9-build";
    const stale = seed(sandboxDir, liveTask, 100, now);

    const res = sweepSandboxes({
      stateDir,
      retentionHours: 1,
      maxDirs: 0,
      isLive: (t) => t === liveTask,
      now,
    });

    expect(res.live).toBe(1);
    expect(res.swept).toBe(0);
    expect(existsSync(stale)).toBe(true);
  });

  it("no-ops when the sandboxes dir does not exist", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "sweep-empty-"));
    tmps.push(stateDir);
    const res = sweepSandboxes({ stateDir, retentionHours: 12, maxDirs: 40, isLive: never });
    expect(res).toEqual({ swept: 0, kept: 0, live: 0 });
  });
});

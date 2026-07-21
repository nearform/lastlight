import { existsSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { hasLiveContainer, reapSandboxWorkspace, sandboxRoot } from "../sandbox/reap.js";

/**
 * The in-harness backstop sweep for sandbox workspaces (issue #106). Reap-on-
 * completion (`src/workflows/simple.ts`) already removes an ephemeral run's dir
 * on success; this catches everything it can't — failed/crashed/cancelled-missed
 * leftovers — and bounds the reusable per-PR cache. It replaces the once-daily
 * host cron (`scripts/cleanup-sandboxes.sh`), which lost the race: this runs
 * hourly, ages in HOURS with an explicit check (not `find -mtime`'s day
 * truncation, which kept ~48h), and never touches a dir whose container is live.
 *
 * Two passes, both skipping live-container dirs:
 *   1. **age** — remove any dir older than `retentionHours`.
 *   2. **budget (LRU)** — if more than `maxDirs` survive, evict oldest-by-mtime
 *      until at/under the cap. This bounds the warm pr-review cache without
 *      disabling issue #107's per-PR reuse.
 */
export interface SweepOpts {
  stateDir: string;
  sandboxDir?: string;
  retentionHours: number;
  maxDirs: number;
  /** Test seams. */
  isLive?: (taskId: string) => boolean;
  now?: number;
}

export interface SweepResult {
  swept: number;
  kept: number;
  live: number;
}

export function sweepSandboxes(opts: SweepOpts): SweepResult {
  const base = sandboxRoot(opts.stateDir, opts.sandboxDir);
  if (!existsSync(base)) return { swept: 0, kept: 0, live: 0 };

  const isLive = opts.isLive ?? hasLiveContainer;
  const now = opts.now ?? Date.now();
  const maxAgeMs = opts.retentionHours * 3_600_000;

  // Snapshot each workspace dir with its mtime, partitioning out live ones (a
  // live container's dir is never a candidate — it's in-flight work).
  const candidates: { taskId: string; mtimeMs: number }[] = [];
  let live = 0;
  for (const entry of readdirSync(base, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (isLive(entry.name)) {
      live += 1;
      continue;
    }
    let mtimeMs = 0;
    try {
      mtimeMs = statSync(join(base, entry.name)).mtimeMs;
    } catch {
      continue; // vanished mid-sweep — nothing to do
    }
    candidates.push({ taskId: entry.name, mtimeMs });
  }

  const reap = (taskId: string): boolean =>
    reapSandboxWorkspace({ taskId, stateDir: opts.stateDir, sandboxDir: opts.sandboxDir, isLive }).removed;

  let swept = 0;
  // Pass 1 — age. Survivors carry forward to the budget pass.
  const survivors: { taskId: string; mtimeMs: number }[] = [];
  for (const c of candidates) {
    if (now - c.mtimeMs > maxAgeMs) {
      if (reap(c.taskId)) swept += 1;
    } else {
      survivors.push(c);
    }
  }

  // Pass 2 — LRU budget. Evict oldest first until at/under maxDirs.
  if (survivors.length > opts.maxDirs) {
    survivors.sort((a, b) => a.mtimeMs - b.mtimeMs);
    const overflow = survivors.length - opts.maxDirs;
    for (let i = 0; i < overflow; i++) {
      if (reap(survivors[i].taskId)) swept += 1;
    }
  }

  const kept = candidates.length - swept;
  if (swept > 0) {
    console.log(`[sandbox-sweep] swept ${swept}, kept ${kept}, live ${live}`);
  }
  return { swept, kept, live };
}

import { execFileSync } from "child_process";
import { rmSync } from "fs";
import { join, resolve, sep } from "path";

/**
 * Reap on-disk sandbox workspaces — the piece the container teardown never did.
 *
 * Every task clones the target repo into `$STATE_DIR/sandboxes/<taskId>/`. The
 * harness tears down the sandbox *container* per phase (`docker rm -f`) but the
 * clone survives, so without this the dir grows unbounded and fills the disk
 * (issue #106). This module is the single authority for removing one such dir
 * safely: it resolves the path *exactly* as `createTaskSandbox` /
 * `setupTaskWorktree` do (so the two never disagree), refuses any taskId that
 * escapes the sandboxes root, and skips a dir whose container is still live.
 *
 * Two callers: reap-on-completion (`src/workflows/simple.ts`, on terminal
 * success of an ephemeral run) and the backstop TTL sweep
 * (`src/cron/sandbox-sweep.ts`). The reusable per-target workspaces
 * (`PER_TARGET_REUSE_WORKFLOWS` / `PER_TARGET_RECREATE_WORKFLOWS`) are NOT
 * reaped on completion — they are a warm cache (issue #107) bounded only by the
 * sweep's age + LRU budget.
 */

/** Resolve the sandboxes root the same way the provisioning helpers do. */
export function sandboxRoot(stateDir: string, sandboxDir?: string): string {
  return resolve(sandboxDir || join(stateDir, "sandboxes"));
}

function isWithinDir(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

/**
 * True iff a sandbox container for `taskId` is currently running. Container
 * names are `lastlight-sandbox-<taskId>-<uuid>`, so a `name=` substring filter
 * on `<taskId>` matches this run's containers (and, conservatively, any whose
 * name extends it — a safe over-match: we'd rather keep a dir than race a live
 * container). Docker absent / errored → treated as "no live container" so the
 * non-docker backends (gondolin / none / smol) don't block reaping.
 */
export function hasLiveContainer(taskId: string): boolean {
  try {
    const out = execFileSync(
      "docker",
      ["ps", "-q", "--filter", `name=lastlight-sandbox-${taskId}`],
      { encoding: "utf-8", timeout: 5000 },
    );
    return out.trim().split("\n").filter(Boolean).length > 0;
  } catch {
    return false;
  }
}

export interface ReapResult {
  removed: boolean;
  /** Why the dir was skipped, when `removed` is false. */
  reason?: "escape" | "live-container" | "error";
}

/**
 * Remove the workspace dir backing `taskId`. Best-effort: a missing dir is a
 * no-op success (`force: true`), and any failure is swallowed into
 * `{ removed: false, reason: "error" }` — reaping must never fail an
 * already-finished run or crash the sweep.
 */
export function reapSandboxWorkspace(opts: {
  taskId: string;
  stateDir: string;
  sandboxDir?: string;
  /** Skip when a container for this taskId is still running (default true). */
  skipIfLiveContainer?: boolean;
  /** Injectable live-container probe (test seam); defaults to {@link hasLiveContainer}. */
  isLive?: (taskId: string) => boolean;
}): ReapResult {
  const base = sandboxRoot(opts.stateDir, opts.sandboxDir);
  const workDir = resolve(base, opts.taskId);
  if (!isWithinDir(base, workDir)) {
    console.warn(`[reap] refusing taskId that escapes sandboxes root: ${opts.taskId}`);
    return { removed: false, reason: "escape" };
  }
  const isLive = opts.isLive ?? hasLiveContainer;
  if ((opts.skipIfLiveContainer ?? true) && isLive(opts.taskId)) {
    return { removed: false, reason: "live-container" };
  }
  try {
    rmSync(workDir, { recursive: true, force: true });
    console.log(`[reap] removed workspace ${opts.taskId}`);
    return { removed: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[reap] failed to remove ${opts.taskId}: ${msg}`);
    return { removed: false, reason: "error" };
  }
}

import { execFileSync } from "child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { isAbsolute, join, relative, resolve, sep } from "path";
import { DockerSandbox, type WorkspaceMount } from "./docker.js";
import { SANDBOX_IMAGE, isSandboxAvailable } from "./images.js";

export { DockerSandbox } from "./docker.js";
export {
  SANDBOX_IMAGE,
  SANDBOX_IMAGE_QA,
  isSandboxAvailable,
  qaImageAvailable,
} from "./images.js";

/**
 * Clean up orphaned sandbox containers from previous runs.
 * Called on startup to remove containers that survived a harness restart.
 */
export function cleanupOrphanedSandboxes(): void {
  try {
    const out = execFileSync("docker", [
      "ps", "-q", "--filter", "name=lastlight-sandbox",
    ], { encoding: "utf-8", timeout: 5000 });

    const ids = out.trim().split("\n").filter(Boolean);
    if (ids.length > 0) {
      console.log(`[sandbox] Cleaning up ${ids.length} orphaned sandbox container(s)`);
      execFileSync("docker", ["rm", "-f", ...ids], { stdio: "ignore", timeout: 15000 });
    }
  } catch {
    // Docker not available or no containers — fine
  }
}

/** Cached check — only probe Docker once per process */
let _sandboxAvailable: boolean | null = null;

export function sandboxAvailable(): boolean {
  if (_sandboxAvailable === null) {
    _sandboxAvailable = isSandboxAvailable();
    if (_sandboxAvailable) {
      console.log(`[sandbox] Docker sandbox available (image: ${SANDBOX_IMAGE})`);
    } else {
      console.log(`[sandbox] Docker not available — running agents directly`);
    }
  }
  return _sandboxAvailable;
}

function isWithinDir(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

/**
 * Set up the per-task worktree directory (mkdir + optional pre-clone) without
 * touching Docker. Used by the non-docker sandbox modes (gondolin / none) where
 * agentic-pi runs in-process or in a VM rather than a container, but still
 * wants a per-task workspace cloned from the target branch.
 */
export function setupTaskWorktree(opts: {
  taskId: string;
  stateDir: string;
  sandboxDir?: string;
  prePopulate?: {
    owner: string;
    repo: string;
    branch: string;
    token: string;
    /** Owning run id — stamped into a marker so a reused per-PR workspace
     * refreshes across runs but is preserved between phases of one run. */
    runId?: string;
    /** Clone shallowly (`--depth 1 --single-branch`) for read-only workflows. */
    shallow?: boolean;
  };
}): string {
  const sandboxBase = resolve(opts.sandboxDir || join(opts.stateDir, "sandboxes"));
  mkdirSync(sandboxBase, { recursive: true });

  const workDir = resolve(sandboxBase, opts.taskId);
  if (!isWithinDir(sandboxBase, workDir)) {
    throw new Error(`Invalid taskId path escape attempt: ${opts.taskId}`);
  }
  mkdirSync(workDir, { recursive: true });

  if (opts.prePopulate) {
    prePopulateWorkspace(workDir, opts.prePopulate);
  }
  return workDir;
}

/**
 * Create a sandbox for a task. Returns the sandbox and a cleanup function.
 * If Docker is not available, returns null (caller should fall back to direct execution).
 */
export async function createTaskSandbox(opts: {
  taskId: string;
  stateDir: string;
  sandboxDir?: string;
  env?: Record<string, string>;
  /**
   * When set, the harness clones the repo into workDir at the named branch
   * before starting the sandbox container. The agent then enters a
   * workspace that's already checked out, avoiding a redundant
   * `clone_repo` MCP call inside the session.
   *
   * Token must be alphanumeric (shape asserted upstream) and is embedded
   * into the clone URL just for this one-shot operation — git's own
   * credential.helper inside the sandbox covers subsequent push/pull.
   */
  prePopulate?: {
    owner: string;
    repo: string;
    branch: string;
    token: string;
    /** Owning run id — stamped into a marker so a reused per-PR workspace
     * refreshes across runs but is preserved between phases of one run. */
    runId?: string;
    /** Clone shallowly (`--depth 1 --single-branch`) for read-only workflows. */
    shallow?: boolean;
  };
  /**
   * IP of the coredns sidecar to use as the sandbox's DNS resolver.
   * Selects the egress policy: `172.30.0.10` (coredns-strict) for the
   * default allowlist, `172.30.0.11` (coredns-open) for phases that
   * declared `unrestricted_egress: true`. Passed to `docker run` as
   * `--dns <ip>`. See src/sandbox/egress-firewall-config.ts.
   */
  dnsIp?: string;
  /**
   * Override the container image. Defaults to the lean `SANDBOX_IMAGE`; a
   * browser-QA phase passes `SANDBOX_IMAGE_QA`. The caller is responsible for
   * ensuring the image exists (see `qaImageAvailable`).
   */
  imageName?: string;
}): Promise<{ sandbox: DockerSandbox; workDir: string; cleanup: () => Promise<void> } | null> {
  if (!sandboxAvailable()) return null;

  const sandboxBase = resolve(opts.sandboxDir || join(opts.stateDir, "sandboxes"));
  mkdirSync(sandboxBase, { recursive: true });

  const workDir = resolve(sandboxBase, opts.taskId);
  if (!isWithinDir(sandboxBase, workDir)) {
    throw new Error(`Invalid taskId path escape attempt: ${opts.taskId}`);
  }

  mkdirSync(workDir, { recursive: true });

  if (opts.prePopulate) {
    prePopulateWorkspace(workDir, opts.prePopulate);
  }

  const sandbox = new DockerSandbox({
    imageName: opts.imageName || SANDBOX_IMAGE,
    env: opts.env || {},
    memoryLimit: process.env.SANDBOX_MEMORY_LIMIT || undefined,
    dnsIp: opts.dnsIp,
  });

  try {
    await sandbox.create({
      taskId: opts.taskId,
      worktreePath: workDir,
      workspaceMount: resolveWorkspaceMount(opts.stateDir, workDir),
    });
    return {
      sandbox,
      workDir,
      cleanup: () => sandbox.destroy(opts.taskId),
    };
  } catch (err: any) {
    console.warn(`[sandbox] Failed to create sandbox: ${err.message}`);
    return null;
  }
}

/**
 * Decide how the sandbox container should mount `/home/agent/workspace`.
 *
 * The harness writes the per-task workspace to `workDir`, which is always
 * under `stateDir` (`sandboxes/<taskId>/`). In production, `stateDir` is
 * served by a named docker volume mounted into the harness container. A
 * plain `-v workDir:/home/agent/workspace` bind makes the daemon resolve
 * `workDir` against the *host* filesystem, where the named volume's
 * content is not visible — docker silently creates an empty dir at that
 * host path and mounts it, so the sandbox sees an empty workspace and the
 * skills the harness staged are never reachable.
 *
 * In volume mode we ask docker for a `volume-subpath` mount instead, so
 * the sandbox sees exactly the harness's view. In path mode (local dev,
 * or any deployment where SANDBOX_DATA_VOLUME is a host path) a normal
 * bind is correct because both views point at the same FS path.
 *
 * Edge case: if `opts.sandboxDir` was overridden to live outside `stateDir`,
 * we can't carve a volume-subpath out of the data volume — fall back to
 * a bind mount. That keeps the no-data-volume dev path working; the
 * named-volume + custom-sandboxDir combination isn't currently used.
 */
function resolveWorkspaceMount(
  stateDir: string,
  workDir: string,
): WorkspaceMount {
  const dataVolumeRaw = process.env.SANDBOX_DATA_VOLUME || "lastlight_agent-data";
  if (isPathLike(dataVolumeRaw)) {
    return { type: "bind", hostPath: workDir };
  }
  const rel = relative(resolve(stateDir), workDir);
  if (rel === "" || rel.startsWith("..") || isAbsolute(rel)) {
    return { type: "bind", hostPath: workDir };
  }
  return { type: "volume-subpath", volume: dataVolumeRaw, subpath: rel };
}

function isPathLike(value: string): boolean {
  return value.startsWith("/") ||
    value.startsWith("./") ||
    value.startsWith("../") ||
    value.startsWith("~");
}

/** Marker file (at the workspace root, outside the repo so `git clean` can't
 * touch it) recording which run last provisioned this workspace. */
const RUN_MARKER = ".lastlight-run";

type PrePopulate = {
  owner: string;
  repo: string;
  branch: string;
  token: string;
  runId?: string;
  shallow?: boolean;
  recreateFromBase?: boolean;
};

/**
 * Clone the repo into `<workDir>/<repo>` at the given branch.
 *
 * Cases:
 * - **Fresh dir** (no `.git`): clone. `--depth 1 --single-branch` for
 *   read-only workflows (`pre.shallow`), `--depth 50` otherwise. For
 *   `recreateFromBase` the branch is cut from the default branch directly
 *   (never `clone --branch <feature>`).
 * - **Same run revisiting the workspace** (`.git` exists, run marker matches
 *   `pre.runId`): preserve — this is a later phase of the same run reading
 *   what an earlier phase wrote (architect's `plan.md`, the reviewer's
 *   checkout). No git ops.
 * - **A fresh run reusing an old per-target workspace** (`.git` exists, marker
 *   differs/absent):
 *   - default (pr-review / pr-fix): fetch + hard-reset to the remote branch +
 *     `git clean` that **keeps `node_modules`** so the next `npm install` is
 *     incremental (the re-review fast path from issue #107).
 *   - `recreateFromBase` (build): delete the stale checkout and re-clone from
 *     the default branch — a re-triggered incomplete build starts again off
 *     current `main` (issue #153).
 */
export { prePopulateWorkspace as __prePopulateWorkspaceForTest };

export function prePopulateWorkspace(
  workDir: string,
  pre: PrePopulate,
): void {
  // Token shape is asserted in src/engine/git-auth.ts before we get here,
  // but re-check the narrow set here too — defense in depth, this string
  // crosses a process boundary into git's command line.
  if (!/^[A-Za-z0-9_-]+$/.test(pre.token)) {
    throw new Error("prePopulate: refusing to embed a token outside [A-Za-z0-9_-]");
  }
  const url = `https://x-access-token:${pre.token}@github.com/${pre.owner}/${pre.repo}.git`;
  // The agent's cwd is `workDir` (the workspace). The harness writes
  // `AGENTS.md` there, so cloning into the workDir root would collide.
  // Instead, clone into a `<repo>/` subdirectory — keeps the layout
  // consistent regardless of whether the harness or the agent did the
  // clone, and leaves room for `.lastlight/issue-N/` scratch space at
  // the workspace root.
  const repoDir = join(workDir, pre.repo);
  const markerPath = join(workDir, RUN_MARKER);
  const scrub = (s: unknown): string =>
    typeof s === "string" ? s.replaceAll(pre.token, "[REDACTED-TOKEN]") : "";
  // Repo dir might already exist — from a later phase of the same run, or a
  // *different* run reusing a stable per-target workspace (issue #107).
  if (existsSync(join(repoDir, ".git"))) {
    const lastRun = readMarker(markerPath);
    // Same run (or a caller that doesn't track runs): preserve the workspace
    // exactly — earlier phases may have written uncommitted scratch here.
    if (!pre.runId || lastRun === pre.runId) {
      console.log(
        `[sandbox] Pre-clone skipped: ${repoDir} already a git repo (same run).`,
      );
      return;
    }
    if (pre.recreateFromBase) {
      // build (#153): a prior incomplete run left a checkout on a possibly
      // stale feature branch. Discard it and re-clone from the default branch
      // (below) so the re-triggered build starts again off current `main`.
      try {
        rmSync(repoDir, { recursive: true, force: true });
        console.log(
          `[sandbox] Recreating ${repoDir} from the default branch ` +
          `(discarded stale workspace from run ${lastRun ?? "unknown"}).`,
        );
      } catch (err: any) {
        console.warn(
          `[sandbox] Failed to remove stale workspace ${repoDir} ` +
          `(${scrub(err?.message)}); attempting a fresh clone anyway.`,
        );
      }
      // fall through to the recreate-from-base clone below.
    } else {
      // Different run reusing this PR's workspace — refresh in place.
      refreshExistingClone(repoDir, markerPath, pre);
      return;
    }
  }
  const start = Date.now();
  const depth = pre.shallow ? "1" : "50";
  const shallowArgs = pre.shallow ? ["--single-branch"] : [];
  // Recreate-from-base workflows (build) always cut their branch from the
  // default branch — never `clone --branch <feature>`, which would resurrect a
  // stale *pushed* feature branch from an earlier incomplete run (#153).
  if (pre.recreateFromBase) {
    cloneDefaultAndCreateBranch(repoDir, url, depth, shallowArgs, pre, markerPath, start, scrub);
    return;
  }
  try {
    execFileSync(
      "git",
      ["clone", "--branch", pre.branch, "--depth", depth, ...shallowArgs, url, repoDir],
      { stdio: "pipe", timeout: 120_000 },
    );
    writeMarker(markerPath, pre.runId);
    const ms = Date.now() - start;
    console.log(
      `[sandbox] Pre-cloned ${pre.owner}/${pre.repo}@${pre.branch} into ${repoDir} ` +
      `(depth ${depth}, ${ms}ms)`,
    );
  } catch (err: any) {
    const firstError = scrub(err?.message) || scrub(err?.stderr?.toString?.()) || "unknown error";
    const looksLikeMissingBranch = /Remote branch .* not found|not found in upstream/i.test(firstError);
    if (looksLikeMissingBranch) {
      // Build-style workflows create a brand-new branch (e.g. `lastlight/N-slug`)
      // and push it later. The remote doesn't have it yet at pre-clone time —
      // clone the default branch, then create the target branch locally so
      // the agent enters a workspace already on the right branch.
      cloneDefaultAndCreateBranch(repoDir, url, depth, shallowArgs, pre, markerPath, start, scrub);
      return;
    }
    // Don't kill the run on a failed pre-clone — fall through to an empty
    // workspace and let the agent clone via the MCP path as a backup.
    //
    // CRITICAL: execFileSync errors echo the failing command line, which
    // includes the auth URL `https://x-access-token:<token>@github.com/…`.
    // The token is scrubbed above before anything reaches the logs.
    console.warn(
      `[sandbox] Pre-clone of ${pre.owner}/${pre.repo}@${pre.branch} failed (${firstError}). ` +
      `Agent will need to clone via MCP.`,
    );
  }
}

/**
 * Clone the repo's default branch into `repoDir` and create `pre.branch`
 * locally off it (`checkout -B`), then stamp the run marker. Shared by two
 * paths: the feature branch not existing on the remote yet (build-style first
 * run) and a recreate-from-base workflow deliberately re-cutting its branch
 * from the default (issue #153). Best-effort — on failure it logs a
 * token-scrubbed warning and leaves an empty workspace for the agent's MCP
 * clone fallback.
 */
function cloneDefaultAndCreateBranch(
  repoDir: string,
  url: string,
  depth: string,
  shallowArgs: string[],
  pre: PrePopulate,
  markerPath: string,
  start: number,
  scrub: (s: unknown) => string,
): void {
  try {
    execFileSync(
      "git",
      ["clone", "--depth", depth, ...shallowArgs, url, repoDir],
      { stdio: "pipe", timeout: 120_000 },
    );
    execFileSync(
      "git",
      ["-C", repoDir, "checkout", "-B", pre.branch],
      { stdio: "pipe", timeout: 30_000 },
    );
    writeMarker(markerPath, pre.runId);
    const ms = Date.now() - start;
    console.log(
      `[sandbox] Pre-cloned ${pre.owner}/${pre.repo} (default branch) into ${repoDir} ` +
      `and created local branch ${pre.branch} (${ms}ms)`,
    );
  } catch (err: any) {
    const reason = scrub(err?.message) || scrub(err?.stderr?.toString?.()) || "unknown error";
    console.warn(
      `[sandbox] Default-branch clone of ${pre.owner}/${pre.repo} failed (${reason}). ` +
      `Agent will need to clone via MCP.`,
    );
  }
}

function readMarker(markerPath: string): string | null {
  try {
    return readFileSync(markerPath, "utf-8").trim() || null;
  } catch {
    return null;
  }
}

function writeMarker(markerPath: string, runId: string | undefined): void {
  if (!runId) return;
  try {
    writeFileSync(markerPath, runId);
  } catch {
    // Best-effort — a missing marker just means the next reuse refreshes
    // (the safe direction), never a wrong-preserve.
  }
}

/**
 * Refresh a reused per-PR workspace in place: fetch the branch, hard-reset the
 * checkout to it, and `git clean` away stale tracked/untracked build output —
 * but **keep `node_modules`** (and any nested ones) so the next install is
 * incremental against a warm tree. The shared package cache (docker backend)
 * lives on a separate mount and is untouched by `git clean`.
 *
 * On any failure we leave the workspace as-is and do NOT advance the marker,
 * so the next run retries the refresh rather than reviewing a half-reset tree.
 */
function refreshExistingClone(
  repoDir: string,
  markerPath: string,
  pre: PrePopulate,
): void {
  const scrub = (s: unknown): string =>
    typeof s === "string" ? s.replaceAll(pre.token, "[REDACTED-TOKEN]") : "";
  const url = `https://x-access-token:${pre.token}@github.com/${pre.owner}/${pre.repo}.git`;
  const depth = pre.shallow ? ["--depth", "1"] : ["--depth", "50"];
  const start = Date.now();
  try {
    // Fetch the branch from the authenticated URL directly so we don't depend
    // on the stored remote (and never persist the token into .git/config).
    execFileSync(
      "git",
      ["-C", repoDir, "fetch", ...depth, url, pre.branch],
      { stdio: "pipe", timeout: 120_000 },
    );
    execFileSync(
      "git",
      ["-C", repoDir, "checkout", "-B", pre.branch, "FETCH_HEAD"],
      { stdio: "pipe", timeout: 30_000 },
    );
    execFileSync(
      "git",
      ["-C", repoDir, "reset", "--hard", "FETCH_HEAD"],
      { stdio: "pipe", timeout: 30_000 },
    );
    // -x removes ignored files (stale dist/, .turbo, coverage, …); -e keeps the
    // dependency trees warm so install is incremental. `node_modules` with no
    // leading slash matches at any depth (monorepos / workspaces).
    execFileSync(
      "git",
      ["-C", repoDir, "clean", "-fdx", "-e", "node_modules"],
      { stdio: "pipe", timeout: 60_000 },
    );
    writeMarker(markerPath, pre.runId);
    const ms = Date.now() - start;
    console.log(
      `[sandbox] Refreshed reused workspace ${repoDir} → ${pre.branch} ` +
      `(fetch+reset+clean, node_modules kept, ${ms}ms)`,
    );
  } catch (err: any) {
    const reason = scrub(err?.message) || scrub(err?.stderr?.toString?.()) || "unknown error";
    console.warn(
      `[sandbox] Refresh of reused workspace ${repoDir} failed (${reason}). ` +
      `Leaving it untouched; agent can re-fetch via MCP.`,
    );
  }
}

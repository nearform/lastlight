import { execFileSync } from "child_process";
import { existsSync, mkdirSync } from "fs";
import { join, resolve, sep } from "path";
import { DockerSandbox } from "./docker.js";

export { DockerSandbox } from "./docker.js";

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

const SANDBOX_IMAGE = "lastlight-sandbox:latest";

/**
 * Check if Docker sandbox mode is available.
 */
export function isSandboxAvailable(): boolean {
  return dockerAvailable() && sandboxImageExists(SANDBOX_IMAGE);
}

function dockerAvailable(): boolean {
  try {
    execFileSync("docker", ["info"], { stdio: "ignore", timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

function sandboxImageExists(imageName: string): boolean {
  try {
    const out = execFileSync("docker", ["images", "-q", imageName], {
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return out.trim().length > 0;
  } catch {
    return false;
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
  };
  /**
   * IP of the coredns sidecar to use as the sandbox's DNS resolver.
   * Selects the egress policy: `172.30.0.10` (coredns-strict) for the
   * default allowlist, `172.30.0.11` (coredns-open) for phases that
   * declared `unrestricted_egress: true`. Passed to `docker run` as
   * `--dns <ip>`. See src/sandbox/egress-firewall-config.ts.
   */
  dnsIp?: string;
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
    imageName: SANDBOX_IMAGE,
    env: opts.env || {},
    memoryLimit: process.env.SANDBOX_MEMORY_LIMIT || undefined,
    dnsIp: opts.dnsIp,
  });

  try {
    await sandbox.create({ taskId: opts.taskId, worktreePath: workDir });
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
 * Shallow-clone the repo into workDir at the given branch. Re-clones if the
 * workDir already contains a .git (cheaper than a full clone the second time
 * via `git fetch`, but rare — sandbox dirs are usually one-shot per taskId).
 */
export { prePopulateWorkspace as __prePopulateWorkspaceForTest };

function prePopulateWorkspace(
  workDir: string,
  pre: { owner: string; repo: string; branch: string; token: string },
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
  // Repo dir might already exist from a resumed run — guard against
  // git clone's "destination not empty" error by skipping when there's
  // already a .git inside.
  if (existsSync(join(repoDir, ".git"))) {
    console.log(
      `[sandbox] Pre-clone skipped: ${repoDir} already a git repo (resumed run).`,
    );
    return;
  }
  const start = Date.now();
  try {
    execFileSync(
      "git",
      ["clone", "--branch", pre.branch, "--depth", "50", url, repoDir],
      { stdio: "pipe", timeout: 120_000 },
    );
    const ms = Date.now() - start;
    console.log(
      `[sandbox] Pre-cloned ${pre.owner}/${pre.repo}@${pre.branch} into ${repoDir} (${ms}ms)`,
    );
  } catch (err: any) {
    // Don't kill the run on a failed pre-clone — fall through to an empty
    // workspace and let the agent clone via the MCP path as a backup.
    //
    // CRITICAL: execFileSync errors echo the failing command line, which
    // includes the auth URL `https://x-access-token:<token>@github.com/…`.
    // Scrub the token (and any incidental occurrences in stdout/stderr)
    // before anything reaches the logs.
    const scrub = (s: unknown): string =>
      typeof s === "string" ? s.replaceAll(pre.token, "[REDACTED-TOKEN]") : "";
    const safeMessage = scrub(err?.message) || scrub(err?.toString?.()) || "unknown error";
    console.warn(
      `[sandbox] Pre-clone of ${pre.owner}/${pre.repo}@${pre.branch} failed (${safeMessage}). ` +
      `Agent will need to clone via MCP.`,
    );
  }
}

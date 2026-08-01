import { execFileSync, type ExecSyncOptions } from "child_process";
import { existsSync, mkdirSync, rmSync } from "fs";
import { join, resolve } from "path";
import { logger } from "../logging/logger.js";

const log = logger("worktree");

const WORKTREE_DIR = ".worktrees";

export interface WorktreeInfo {
  taskId: string;
  path: string;
  branch: string;
  repo: string;
  createdAt: Date;
}

/**
 * Manages git worktrees for per-task isolation.
 * Each build task gets its own worktree (isolated working directory + branch).
 * The Docker container the harness runs in IS the sandbox — worktrees provide
 * per-task isolation within that sandbox.
 */
export class WorktreeManager {
  private baseDir: string;
  private active: Map<string, WorktreeInfo> = new Map();

  constructor(baseDir?: string) {
    this.baseDir = baseDir || resolve(WORKTREE_DIR);
  }

  private execGit(args: string[], opts?: ExecSyncOptions): string {
    return execFileSync("git", args, { encoding: "utf-8", stdio: "pipe", ...opts }) as string;
  }

  /**
   * Create a new worktree for a task.
   * Clones the repo first (if not already cloned), then creates a worktree.
   */
  async create(opts: {
    taskId: string;
    repoUrl: string;
    branch: string;
    baseBranch?: string;
  }): Promise<WorktreeInfo> {
    const { taskId, repoUrl, branch, baseBranch } = opts;

    if (this.active.has(taskId)) {
      return this.active.get(taskId)!;
    }

    const worktreePath = join(this.baseDir, taskId);

    // Ensure base directory exists
    if (!existsSync(this.baseDir)) {
      mkdirSync(this.baseDir, { recursive: true });
    }

    // We need a bare/normal repo to create worktrees from.
    // Use a shared bare clone per repo to avoid re-cloning each time.
    const repoName = repoUrl.replace(/.*\/([^/]+?)(?:\.git)?$/, "$1");
    const bareDir = join(this.baseDir, `.bare-${repoName}`);

    if (!existsSync(bareDir)) {
      log.info("Bare clone", { repoUrl });
      this.execGit(["clone", "--bare", repoUrl, bareDir]);
    } else {
      // Fetch latest
      this.execGit(["-C", bareDir, "fetch", "--all", "--prune"]);
    }

    // Create worktree with new branch from base
    const base = baseBranch || "main";
    const baseRef = `origin/${base}`;

    // Check if branch already exists remotely
    let branchExists = false;
    try {
      this.execGit(["-C", bareDir, "rev-parse", "--verify", `origin/${branch}`]);
      branchExists = true;
    } catch {
      // Branch doesn't exist remotely — that's fine
    }

    if (branchExists) {
      // Resume existing branch
      log.info("Resuming branch", { branch });
      this.execGit(["-C", bareDir, "worktree", "add", worktreePath, `origin/${branch}`]);
      this.execGit(["-C", worktreePath, "checkout", "-B", branch, `origin/${branch}`]);
    } else {
      // Create new branch from base
      log.info("New branch", { branch, baseRef });
      this.execGit(["-C", bareDir, "worktree", "add", "-b", branch, worktreePath, baseRef]);
    }

    const info: WorktreeInfo = {
      taskId,
      path: worktreePath,
      branch,
      repo: repoUrl,
      createdAt: new Date(),
    };

    this.active.set(taskId, info);
    return info;
  }

  /**
   * Get the path for an active worktree.
   */
  getPath(taskId: string): string | null {
    return this.active.get(taskId)?.path || null;
  }

  /**
   * Cleanup a worktree. Removes the worktree and optionally the branch.
   */
  async cleanup(taskId: string, opts?: { deleteBranch?: boolean }): Promise<void> {
    const info = this.active.get(taskId);
    if (!info) return;

    const repoName = info.repo.replace(/.*\/([^/]+?)(?:\.git)?$/, "$1");
    const bareDir = join(this.baseDir, `.bare-${repoName}`);

    try {
      // Remove worktree
      if (existsSync(info.path)) {
        this.execGit(["-C", bareDir, "worktree", "remove", "--force", info.path]);
      }
    } catch (err) {
      // Force cleanup if git worktree remove fails
      if (existsSync(info.path)) {
        rmSync(info.path, { recursive: true, force: true });
        try {
          this.execGit(["-C", bareDir, "worktree", "prune"]);
        } catch { /* best effort */ }
      }
    }

    // Optionally delete the branch
    if (opts?.deleteBranch) {
      try {
        this.execGit(["-C", bareDir, "branch", "-D", info.branch]);
      } catch { /* branch may not exist locally */ }
    }

    this.active.delete(taskId);
    log.info("Cleaned up", { taskId });
  }

  /**
   * List all active worktrees.
   */
  listActive(): WorktreeInfo[] {
    return Array.from(this.active.values());
  }
}

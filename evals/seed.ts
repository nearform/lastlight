/**
 * Deterministic workspace seeding for the code-fix tier.
 *
 * Pre-populates the run's sandbox workspace (`<stateDir>/sandboxes/<taskId>`,
 * the exact dir `setupTaskWorktree` would create) with a fixture repo checked
 * out at a fixed base commit, and points its `origin` at a LOCAL bare repo —
 * so the real workflow's `git push origin HEAD` succeeds fully offline with NO
 * GitHub clone. Because the eval calls `runWorkflow` with no
 * `ctx.prePopulateBranch`, the runner never triggers its own GitHub clone and
 * the agent works directly in this seeded dir.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, cpSync } from "node:fs";
import { resolve } from "node:path";

const FIXED = "2026-01-01T00:00:00 +0000";
const GIT_ENV: NodeJS.ProcessEnv = {
  ...process.env,
  GIT_AUTHOR_NAME: "eval",
  GIT_AUTHOR_EMAIL: "eval@example.com",
  GIT_COMMITTER_NAME: "eval",
  GIT_COMMITTER_EMAIL: "eval@example.com",
  GIT_AUTHOR_DATE: FIXED,
  GIT_COMMITTER_DATE: FIXED,
};

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, env: GIT_ENV, stdio: ["ignore", "pipe", "pipe"] }).toString();
}

export interface SeedResult {
  workDir: string;
  originDir: string;
  baseCommit: string;
  branch: string;
}

export function seedWorkspace(opts: {
  stateDir: string;
  taskId: string;
  /** Directory holding the fixture repo source at base-commit state (no held-out tests). */
  fixtureDir: string;
  /** Working branch the agent will push (build creates a feature branch). */
  branch?: string;
  defaultBranch?: string;
}): SeedResult {
  const def = opts.defaultBranch ?? "main";
  const sandboxBase = resolve(opts.stateDir, "sandboxes");
  const workDir = resolve(sandboxBase, opts.taskId);
  mkdirSync(workDir, { recursive: true });
  cpSync(opts.fixtureDir, workDir, { recursive: true });

  git(workDir, ["init", "-q", "-b", def]);
  git(workDir, ["add", "-A"]);
  git(workDir, ["commit", "-q", "-m", "base"]);
  const baseCommit = git(workDir, ["rev-parse", "HEAD"]).trim();

  const originsDir = resolve(opts.stateDir, "origins");
  mkdirSync(originsDir, { recursive: true });
  const originDir = resolve(originsDir, `${opts.taskId}.git`);
  git(workDir, ["init", "--bare", "-q", originDir]);
  git(workDir, ["remote", "add", "origin", `file://${originDir}`]);
  git(workDir, ["push", "-q", "origin", `HEAD:refs/heads/${def}`]);

  const branch = opts.branch ?? def;
  if (branch !== def) git(workDir, ["checkout", "-q", "-b", branch]);

  return { workDir, originDir, baseCommit, branch };
}

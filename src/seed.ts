/**
 * Deterministic workspace seeding for the code-fix tier.
 *
 * Pre-populates the run's sandbox workspace (`<stateDir>/sandboxes/<taskId>`,
 * the exact dir `setupTaskWorktree` would create) with a repo checked out at a
 * base commit, and points its `origin` at a LOCAL bare repo — so the real
 * workflow's `git push origin HEAD` succeeds fully offline with NO GitHub clone.
 * Because the eval calls `runWorkflow` with no `ctx.prePopulateBranch`, the
 * runner never triggers its own GitHub clone and the agent works directly in
 * this seeded dir.
 *
 * Two provenances, same end state:
 *   - {@link seedWorkspace}        — a vendored fixture dir (`repos/<id>/`).
 *   - {@link seedWorkspaceFromGit} — a real repo cloned into a repo-local cache
 *                                    and checked out at `base_commit`.
 *
 * The git-source clone is a HARNESS SETUP action, not the workflow cloning
 * GitHub — it touches the network only on a cache miss; the workflow itself
 * still operates on a pre-seeded dir with an offline `file://` origin.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, cpSync, existsSync, appendFileSync } from "node:fs";
import { resolve, dirname, join } from "node:path";

import type { PullFile } from "./schema.js";

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

const FILE_STATUS: Record<string, PullFile["status"]> = { A: "added", D: "removed", M: "modified" };

/** Build GitHub's `GET /pulls/:n/files` payload from `git diff base..head` in the
 * seeded workspace, so the fake GitHub can serve a review agent that lists PR
 * files via the API. Rename detection is OFF (`-M` omitted) so a rename shows as
 * a delete + add with plain paths — a faithful-enough view for review and far
 * simpler to parse than git's rename-pair path syntax. Binary files carry no
 * `patch`. Returns `[]` if the range can't be diffed (never throws). */
export function prFilesFromGit(workDir: string, base: string, head: string): PullFile[] {
  const range = `${base}..${head}`;
  let nameStatus = "";
  let numstat = "";
  let fullDiff = "";
  try {
    nameStatus = git(workDir, ["diff", "--no-color", "--name-status", range]);
    numstat = git(workDir, ["diff", "--no-color", "--numstat", range]);
    fullDiff = git(workDir, ["diff", "--no-color", range]);
  } catch {
    return [];
  }

  // additions/deletions per file (numstat: "<adds>\t<dels>\t<path>"; "-" = binary).
  const stats = new Map<string, { additions: number; deletions: number }>();
  for (const line of numstat.split("\n")) {
    if (!line.trim()) continue;
    const [adds, dels, ...rest] = line.split("\t");
    const file = rest.join("\t");
    if (!file) continue;
    stats.set(file, {
      additions: adds === "-" ? 0 : Number(adds) || 0,
      deletions: dels === "-" ? 0 : Number(dels) || 0,
    });
  }

  // per-file patch: split the full diff on the `diff --git ` file boundary and
  // keep the hunks (from the first `@@`), matching GitHub's `patch` field.
  const patches = new Map<string, string>();
  const MARKER = "diff --git ";
  for (let chunk of fullDiff.split(new RegExp(`\\n(?=${MARKER})`))) {
    if (!chunk.startsWith(MARKER)) continue;
    chunk = chunk.slice(MARKER.length);
    const header = chunk.split("\n", 1)[0];
    const m = header.match(/^a\/(.*) b\/(.*)$/);
    const file = m?.[2];
    if (!file) continue;
    const at = chunk.indexOf("\n@@");
    if (at >= 0) patches.set(file, chunk.slice(at + 1));
  }

  const files: PullFile[] = [];
  for (const line of nameStatus.split("\n")) {
    if (!line.trim()) continue;
    const [code, ...rest] = line.split("\t");
    const file = rest.join("\t");
    if (!file) continue;
    const s = stats.get(file) ?? { additions: 0, deletions: 0 };
    files.push({
      sha: "0".repeat(40),
      filename: file,
      status: FILE_STATUS[code[0]] ?? "modified",
      additions: s.additions,
      deletions: s.deletions,
      changes: s.additions + s.deletions,
      patch: patches.get(file),
    });
  }
  return files;
}

/** Where to seed the repo: `<stateDir>/sandboxes/<taskId>[/<repoSubdir>]`. With a
 * subdir the repo is a CHILD of the workspace root (matching production's nested
 * layout, where AGENTS.md/.lastlight-skills are siblings outside the repo). */
function workDirFor(stateDir: string, taskId: string, repoSubdir?: string): string {
  const base = resolve(stateDir, "sandboxes", taskId);
  return repoSubdir ? resolve(base, repoSubdir) : base;
}

/** Git-native ignore (repo-local, NOT a committed file) so the agent's
 * `npm install` artifacts never enter the repo's git tree or the captured diff —
 * exactly what a real repo's `.gitignore` does. Belt-and-suspenders for
 * git-source repos (which already ignore it) and essential for vendored fixtures
 * that ship without a `.gitignore`. Must run after `git init`/`clone`. */
function ignoreBuildArtifacts(workDir: string): void {
  try {
    appendFileSync(join(workDir, ".git", "info", "exclude"), "\nnode_modules/\n");
  } catch {
    /* best-effort: a missing exclude just means node_modules may show in the diff */
  }
}

export interface SeedResult {
  workDir: string;
  originDir: string;
  baseCommit: string;
  branch: string;
}

/** Where git-source repos are mirrored. Repo-local (NOT `~`), gitignored —
 * overridable with `LASTLIGHT_EVALS_CACHE`. */
export function resolveCacheDir(override?: string): string {
  const root = override ?? process.env.LASTLIGHT_EVALS_CACHE ?? resolve(process.cwd(), ".eval-cache");
  return resolve(root, "repos");
}

/** Point `workDir`'s `origin` at a fresh LOCAL bare repo and push the current
 * HEAD as the default branch, so the workflow can `git push` fully offline. */
function setupOfflineOrigin(workDir: string, stateDir: string, taskId: string, def: string): string {
  const originsDir = resolve(stateDir, "origins");
  mkdirSync(originsDir, { recursive: true });
  const originDir = resolve(originsDir, `${taskId}.git`);
  git(workDir, ["init", "--bare", "-q", originDir]);
  // A git-source clone already has an `origin` (the cache) — replace it.
  try {
    git(workDir, ["remote", "remove", "origin"]);
  } catch {
    /* no existing origin (fixture path) — fine */
  }
  git(workDir, ["remote", "add", "origin", `file://${originDir}`]);
  git(workDir, ["push", "-q", "origin", `HEAD:refs/heads/${def}`]);
  return originDir;
}

export function seedWorkspace(opts: {
  stateDir: string;
  taskId: string;
  /** Directory holding the fixture repo source at base-commit state (no held-out tests). */
  fixtureDir: string;
  /** Working branch the agent will push (build creates a feature branch). */
  branch?: string;
  defaultBranch?: string;
  /** Seed into a `<workspace>/<repoSubdir>/` child dir (production's nested
   * layout) instead of the workspace root. See {@link workDirFor}. */
  repoSubdir?: string;
}): SeedResult {
  const def = opts.defaultBranch ?? "main";
  const workDir = workDirFor(opts.stateDir, opts.taskId, opts.repoSubdir);
  mkdirSync(workDir, { recursive: true });
  cpSync(opts.fixtureDir, workDir, { recursive: true });

  git(workDir, ["init", "-q", "-b", def]);
  ignoreBuildArtifacts(workDir);
  git(workDir, ["add", "-A"]);
  git(workDir, ["commit", "-q", "-m", "base"]);
  const baseCommit = git(workDir, ["rev-parse", "HEAD"]).trim();

  const originDir = setupOfflineOrigin(workDir, opts.stateDir, opts.taskId, def);

  const branch = opts.branch ?? def;
  if (branch !== def) git(workDir, ["checkout", "-q", "-b", branch]);

  return { workDir, originDir, baseCommit, branch };
}

/** True if `sha` is a 40-hex non-zero commit id (a real git-source base). */
export function isRealSha(sha: string | undefined): sha is string {
  return !!sha && /^[0-9a-f]{40}$/i.test(sha) && !/^0+$/.test(sha);
}

/** True if `mirror` already contains `sha` as a commit. */
function mirrorHasCommit(mirror: string, sha: string): boolean {
  try {
    git(mirror, ["cat-file", "-e", `${sha}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ensure a repo-local bare mirror contains BOTH a PR's base and head commits,
 * for the `pr-review` tier. Beyond {@link ensureRepoCache}: a squash/rebase-merged
 * PR's head commit is not reachable from any branch, so we fetch the immutable
 * `refs/pull/<n>/head` ref (which GitHub always exposes) when the head is absent.
 * Run SERIALLY per repo before a parallel batch (concurrent fetches race).
 */
export function ensurePrCommitsInCache(opts: {
  repo: string;
  pullNumber: number;
  baseCommit: string;
  headCommit: string;
  cacheDir?: string;
}): string {
  const [owner, name] = opts.repo.split("/");
  if (!owner || !name) throw new Error(`ensurePrCommitsInCache: repo must be "owner/name", got "${opts.repo}"`);
  const cacheDir = resolveCacheDir(opts.cacheDir);
  const mirror = resolve(cacheDir, `${owner}__${name}.git`);

  if (!existsSync(mirror)) {
    mkdirSync(dirname(mirror), { recursive: true });
    git(dirname(mirror), ["clone", "--bare", "--quiet", `https://github.com/${owner}/${name}.git`, mirror]);
  }
  // Base is usually on a branch — a heads fetch covers it.
  if (!mirrorHasCommit(mirror, opts.baseCommit)) {
    git(mirror, ["fetch", "--quiet", "origin", "+refs/heads/*:refs/heads/*"]);
  }
  // Head may be off-branch (squash/rebase merge) — fetch GitHub's immutable
  // `refs/pull/<n>/head` when the head commit is absent.
  if (!mirrorHasCommit(mirror, opts.headCommit)) {
    try {
      git(mirror, ["fetch", "--quiet", "origin", `refs/pull/${opts.pullNumber}/head`]);
    } catch {
      /* fall through — the presence check below reports a clear error */
    }
  }
  for (const [label, sha] of [["base", opts.baseCommit], ["head", opts.headCommit]] as const) {
    if (!mirrorHasCommit(mirror, sha)) {
      throw new Error(
        `ensurePrCommitsInCache: ${label} commit ${sha} for PR #${opts.pullNumber} of ${opts.repo} is not reachable ` +
          `(not on a branch and refs/pull/${opts.pullNumber}/head didn't provide it).`,
      );
    }
  }
  // Anchor the head on a real branch in the mirror. `git clone file://mirror`
  // (in seedWorkspacePrReview) only transfers refs/heads/* — a head fetched into
  // FETCH_HEAD alone stays unreachable, so the clone drops its tree objects and
  // `git checkout <headCommit>` fails with "fatal: unable to read tree". A
  // dedicated branch guarantees the commit rides along. (Base is already on a
  // fetched head ref; force-pointing head is idempotent when it is too.)
  git(mirror, ["branch", "-f", `eval-pr-${opts.pullNumber}-head`, opts.headCommit]);
  return mirror;
}

/**
 * Seed the workspace for the `pr-review` tier: check out the PR HEAD commit into
 * a `<repo>/` subdir (matching production's pre-clone contract in
 * skills/pr-review), with `origin` pointing at a local bare repo that carries
 * the base + head branches — so the skill's `git fetch origin <baseRef>` and
 * `git diff origin/<baseRef>...HEAD` work fully offline. No push happens
 * (pr-review is review-only), but a real origin keeps the git plumbing honest.
 */
export function seedWorkspacePrReview(opts: {
  stateDir: string;
  taskId: string;
  repo: string;
  pullNumber: number;
  baseRef: string;
  headRef: string;
  baseCommit: string;
  headCommit: string;
  cacheDir?: string;
  repoSubdir?: string;
}): SeedResult {
  const mirror = ensurePrCommitsInCache({
    repo: opts.repo,
    pullNumber: opts.pullNumber,
    baseCommit: opts.baseCommit,
    headCommit: opts.headCommit,
    cacheDir: opts.cacheDir,
  });

  const workDir = workDirFor(opts.stateDir, opts.taskId, opts.repoSubdir);
  mkdirSync(dirname(workDir), { recursive: true });

  git(dirname(workDir), ["clone", "--quiet", `file://${mirror}`, workDir]);
  // Check out the PR head on a branch named for the head ref (what the skill sees).
  git(workDir, ["checkout", "--quiet", "-B", opts.headRef, opts.headCommit]);
  ignoreBuildArtifacts(workDir);

  // Point origin at a fresh bare repo carrying both the base and head branches,
  // so `git fetch origin <baseRef>` resolves offline.
  const originsDir = resolve(opts.stateDir, "origins");
  mkdirSync(originsDir, { recursive: true });
  const originDir = resolve(originsDir, `${opts.taskId}.git`);
  git(workDir, ["init", "--bare", "-q", originDir]);
  try {
    git(workDir, ["remote", "remove", "origin"]);
  } catch {
    /* the clone's origin (the cache) — replace it */
  }
  git(workDir, ["remote", "add", "origin", `file://${originDir}`]);
  git(workDir, ["push", "-q", "origin", `${opts.baseCommit}:refs/heads/${opts.baseRef}`]);
  git(workDir, ["push", "-q", "origin", `${opts.headCommit}:refs/heads/${opts.headRef}`]);

  return { workDir, originDir, baseCommit: opts.baseCommit, branch: opts.headRef };
}

/** Ensure a repo-local bare mirror of `repo` exists and contains `baseCommit`
 * (clone on miss, fetch if the commit is absent). Returns the cache dir. Run
 * this SERIALLY per repo before a parallel batch — concurrent clones of the same
 * repo race. Network is touched only here, only on a miss. */
export function ensureRepoCache(opts: { repo: string; baseCommit?: string; cacheDir?: string }): string {
  const [owner, name] = opts.repo.split("/");
  if (!owner || !name) throw new Error(`seedWorkspaceFromGit: repo must be "owner/name", got "${opts.repo}"`);
  const cacheDir = resolveCacheDir(opts.cacheDir);
  const mirror = resolve(cacheDir, `${owner}__${name}.git`);

  if (!existsSync(mirror)) {
    mkdirSync(dirname(mirror), { recursive: true });
    git(dirname(mirror), ["clone", "--bare", "--quiet", `https://github.com/${owner}/${name}.git`, mirror]);
  }
  // Fetch only if the wanted commit isn't already in the mirror.
  if (opts.baseCommit) {
    const present = (() => {
      try {
        git(mirror, ["cat-file", "-e", `${opts.baseCommit}^{commit}`]);
        return true;
      } catch {
        return false;
      }
    })();
    if (!present) git(mirror, ["fetch", "--quiet", "origin", "+refs/heads/*:refs/heads/*"]);
  }
  return mirror;
}

/**
 * Seed the sandbox from a real GitHub repo at `baseCommit`, with the same offline
 * end state as {@link seedWorkspace}: a checked-out base, a feature branch, and a
 * local bare `origin` to push to. Uses the repo-local mirror from
 * {@link ensureRepoCache} so per-run checkout is offline and parallel-safe.
 */
export function seedWorkspaceFromGit(opts: {
  stateDir: string;
  taskId: string;
  repo: string;
  baseCommit: string;
  branch?: string;
  defaultBranch?: string;
  cacheDir?: string;
  /** Seed into a `<workspace>/<repoSubdir>/` child dir (production's nested
   * layout) instead of the workspace root. See {@link workDirFor}. */
  repoSubdir?: string;
}): SeedResult {
  const def = opts.defaultBranch ?? "main";
  const mirror = ensureRepoCache({ repo: opts.repo, baseCommit: opts.baseCommit, cacheDir: opts.cacheDir });

  const workDir = workDirFor(opts.stateDir, opts.taskId, opts.repoSubdir);
  mkdirSync(dirname(workDir), { recursive: true });

  // Plain local clone (not --shared) so the sandbox owns its objects/refs and
  // parallel runs never touch the cache's object store.
  git(dirname(workDir), ["clone", "--quiet", `file://${mirror}`, workDir]);
  git(workDir, ["checkout", "--quiet", "--detach", opts.baseCommit]);
  ignoreBuildArtifacts(workDir);

  const originDir = setupOfflineOrigin(workDir, opts.stateDir, opts.taskId, def);

  const branch = opts.branch ?? def;
  if (branch !== def) git(workDir, ["checkout", "-q", "-b", branch]);

  return { workDir, originDir, baseCommit: opts.baseCommit, branch };
}

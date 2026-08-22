/**
 * Git plumbing. Line-exact, and it never mutates the agent's working tree.
 *
 * `git diff -U0` is deliberate: with zero context the hunk ranges ARE the
 * changed lines, so `changedHunks` maps 1:1 onto a symbol's declaration range
 * with no fudge factor. Anything wider makes "did the diff touch this symbol?"
 * a judgement call, and the whole point of this package is that it is not one.
 *
 * **Every diff here is against the MERGE BASE**, never against the base
 * branch's tip — see `mergeBase`. That is the range GitHub's own "Files
 * changed" tab shows, and it is the only one that describes the PR.
 *
 * The base tree comes from `git worktree add --detach` into a temp dir. WP1 is
 * explicit that the agent's checkout must not be mutated — a `git checkout` in
 * the review workspace would race the agent's own reads, and the workspace is
 * reused across runs (`PER_TARGET_REUSE_WORKFLOWS`).
 *
 * **Git also enumerates the files this package scans** — see `listFiles`. That
 * is not a tidiness preference: `.gitignore` is the only description of "what in
 * this checkout is source" that is actually maintained, and a hand-rolled
 * directory denylist cannot see a nested `.gitignore`, `.git/info/exclude`, or a
 * global exclude file.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { FactsError } from "./errors.js";

export interface GitResult {
  stdout: string;
  stderr: string;
  status: number;
}

/** Run git in `repo`. Never throws on a non-zero status — callers decide. */
export function tryGit(repo: string, args: string[]): GitResult {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: 256 * 1024 * 1024,
    // A repo the harness owns but the current uid does not is a real shape in
    // the sandbox (the workspace is chowned to `agent`); without this, every
    // git call fails with "dubious ownership" and the whole run degrades for a
    // reason that has nothing to do with the code.
    env: { ...process.env, GIT_CONFIG_PARAMETERS: "'safe.directory=*'" },
  });
  return {
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    status: result.status ?? 1,
  };
}

/** Run git in `repo`, or fail loud with the command and git's own stderr. */
export function git(repo: string, args: string[]): string {
  const result = tryGit(repo, args);
  if (result.status !== 0) {
    throw new FactsError(
      "git",
      `git ${args.join(" ")} failed (${result.status}): ${result.stderr.trim() || "no stderr"}`,
    );
  }
  return result.stdout;
}

export function isGitRepo(repo: string): boolean {
  return tryGit(repo, ["rev-parse", "--git-dir"]).status === 0;
}

export function resolveSha(repo: string, ref: string): string {
  return git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]).trim();
}

/**
 * `owner/name` when the remote makes it derivable, else the directory name.
 * The envelope carries it so a stored document can be attributed without the
 * run context that produced it.
 */
export function repoSlug(repo: string): string {
  const remote = tryGit(repo, ["remote", "get-url", "origin"]);
  if (remote.status === 0) {
    const url = remote.stdout.trim();
    const match = /[:/]([^/:]+\/[^/]+?)(?:\.git)?$/.exec(url);
    if (match) return match[1];
  }
  return basename(repo);
}

/**
 * The commit `base` and `head` forked from, or `null` when they share none.
 *
 * **This is the base of a pull request, and `base` is not.** Production reads
 * `pull_request.base.sha` — the base BRANCH TIP at event time — so a two-dot
 * `base..head` diff additionally contains every commit that landed on the base
 * branch since the PR forked, none of which the author wrote. Measured on the
 * 50-PR Martian corpus, 9 of 50 cases diverge and 4 of them catastrophically:
 *
 *   sentry-greptile-1       6125 files (base..head)  vs     3 (merge base)
 *   sentry-greptile-94376   1281                     vs     7
 *   grafana-90939            142                     vs     1
 *   keycloak-40940            82                     vs     4
 *
 * That first case alone was the corpus's only >90 s run (157.9 s) and its
 * 2.7 GB peak-RSS ceiling — but the cost that matters is not wall clock. It is
 * obligations generated about code the PR never touched, and a `contracts` base
 * worktree materialised from the branch tip rather than the fork point, which
 * is exactly the asymmetry that manufactures phantom deltas.
 *
 * `null` is a real answer (unrelated histories, or a shallow clone whose
 * boundary hides the fork point). Callers must degrade with a named reason —
 * `resolveDiffBase` is how — never fall back silently.
 */
export function mergeBase(repo: string, base: string, head: string): string | null {
  const result = tryGit(repo, ["merge-base", base, head]);
  if (result.status !== 0) return null;
  const sha = result.stdout.trim().split("\n")[0]?.trim() ?? "";
  return sha.length > 0 ? sha : null;
}

/**
 * The range every diff in this package uses.
 *
 * Idempotent: when `base` is ALREADY a merge base (which it is on the normal
 * path, because `prepare` resolves it once and threads it through), `git
 * merge-base <mergeBase> <head>` returns that same commit, so re-asking costs a
 * graph walk and changes nothing. That redundancy is deliberate — these two
 * functions are exported and a caller that hands them a branch tip must still
 * get the PR's own diff, not the base branch's.
 *
 * Falls back to `base..head` ONLY when there is no merge base at all, where it
 * is the sole comparison git can perform. `resolveDiffBase` is what puts that
 * fallback in `degraded[]`; this function does not report, it computes.
 */
function diffRange(repo: string, base: string, head: string): string {
  const forkPoint = mergeBase(repo, base, head);
  return `${forkPoint ?? base}..${head}`;
}

/** What the whole run compares against, and whether it is the fork point. */
export interface DiffBase {
  /**
   * The sha every diff, every `git show <base>:<path>` and the `contracts` base
   * worktree uses — and the sha the ENVELOPE records as `baseSha`, so a stored
   * document names the commit that was actually compared.
   */
  sha: string;
  /** False only when `base` and `head` share no reachable history. */
  isMergeBase: boolean;
  /** A written reason when `isMergeBase` is false. `null` otherwise. */
  reason: string | null;
}

/**
 * Resolve the commit to compare against, loudly.
 *
 * Both arguments are shas (`resolveSha` has already run), because the failure
 * this guards against is silent: with no merge base the only thing git can do
 * is compare the two tips, and a run that did that without saying so would
 * report a base-branch commit's files as the PR's.
 */
export function resolveDiffBase(repo: string, baseSha: string, headSha: string): DiffBase {
  const forkPoint = mergeBase(repo, baseSha, headSha);
  if (forkPoint) return { sha: forkPoint, isMergeBase: true, reason: null };
  return {
    sha: baseSha,
    isMergeBase: false,
    reason:
      `no merge base between ${baseSha.slice(0, 8)} and ${headSha.slice(0, 8)} — unrelated ` +
      `histories, or a shallow clone whose boundary hides the fork point. This run compares the ` +
      `two commits DIRECTLY (${baseSha.slice(0, 8)}..${headSha.slice(0, 8)}), so anything that ` +
      `landed on the base branch after the fork is reported as part of this change set`,
  };
}

export type ChangeStatus = "added" | "modified" | "deleted" | "renamed" | "other";

export interface ChangedPath {
  path: string;
  status: ChangeStatus;
}

const STATUS_MAP: Record<string, ChangeStatus> = {
  A: "added",
  M: "modified",
  D: "deleted",
  R: "renamed",
  C: "renamed",
};

/** The PR's own changed files: `merge-base(base, head)` → `head`. */
export function changedPaths(repo: string, base: string, head: string): ChangedPath[] {
  const raw = git(repo, ["diff", "--name-status", "-M", diffRange(repo, base, head)]);
  const out: ChangedPath[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0]?.[0] ?? "";
    // A rename line is `R100\told\tnew` — the NEW path is the one that exists
    // at head, and it is the only one a reference query can resolve.
    const path = parts.length >= 3 ? parts[2] : parts[1];
    if (!path) continue;
    out.push({ path, status: STATUS_MAP[code] ?? "other" });
  }
  return out;
}

export interface FileHunks {
  path: string;
  /** `path:start-end`, 1-based and inclusive, in HEAD coordinates. */
  hunks: string[];
  /** Every head line the diff touched. Empty for a pure deletion. */
  changedLines: number[];
}

const HUNK_RE = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,(\d+))? @@/;

/**
 * Per-file changed line ranges at HEAD, from `git diff -U0` against the merge
 * base.
 *
 * A hunk with `+n,0` is a pure deletion: nothing at head changed, but the
 * SURROUNDING code did lose something, so the anchor line is recorded as a
 * zero-width range (`n-n` with no changed lines). Dropping it entirely would
 * make "this PR deleted the only caller" invisible.
 */
export function diffHunks(repo: string, base: string, head: string): FileHunks[] {
  const raw = git(repo, [
    "diff",
    "--no-color",
    "--no-ext-diff",
    "-U0",
    "-M",
    diffRange(repo, base, head),
  ]);
  const byPath = new Map<string, FileHunks>();
  let current: FileHunks | undefined;
  for (const line of raw.split("\n")) {
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).trim();
      if (target === "/dev/null") {
        current = undefined;
        continue;
      }
      const path = target.startsWith("b/") ? target.slice(2) : target;
      current = byPath.get(path) ?? { path, hunks: [], changedLines: [] };
      byPath.set(path, current);
      continue;
    }
    if (!current || !line.startsWith("@@")) continue;
    const match = HUNK_RE.exec(line);
    if (!match) continue;
    const start = Number(match[1]);
    const count = match[2] === undefined ? 1 : Number(match[2]);
    if (count === 0) {
      current.hunks.push(`${current.path}:${start}-${start}`);
      continue;
    }
    const end = start + count - 1;
    current.hunks.push(`${current.path}:${start}-${end}`);
    for (let line_ = start; line_ <= end; line_++) current.changedLines.push(line_);
  }
  return [...byPath.values()];
}

/** `git show <ref>:<path>`, or `null` when the path does not exist at `ref`. */
export function showFile(repo: string, ref: string, path: string): string | null {
  const result = tryGit(repo, ["show", `${ref}:${path}`]);
  return result.status === 0 ? result.stdout : null;
}

/**
 * Materialise `sha` in a throwaway worktree and hand the path to `fn`.
 *
 * `--detach` keeps it off any branch, and `worktree remove --force` in the
 * `finally` keeps the target repo's `.git/worktrees` from accumulating stale
 * entries across the ~40 workspaces the review sweep keeps warm.
 */
export function withWorktree<T>(repo: string, sha: string, fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "lastlight-facts-base-"));
  try {
    git(repo, ["worktree", "add", "--detach", "--force", dir, sha]);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  try {
    mirrorNodeModules(repo, dir);
    return fn(dir);
  } finally {
    tryGit(repo, ["worktree", "remove", "--force", dir]);
    rmSync(dir, { recursive: true, force: true });
    tryGit(repo, ["worktree", "prune"]);
  }
}

/**
 * SYMLINK the head tree's `node_modules` directories into the base worktree.
 *
 * Nothing here REQUIRES an install — `tests/no-node-modules.test.ts` deletes it
 * and everything still works. But when the head tree does have one, the base
 * worktree must see the same modules, because **a comparison between a resolved
 * program and an unresolved one is not a comparison.**
 *
 * Measured, on this monorepo's own WP0 commit: without the mirror, every export
 * whose type touched an unresolvable external read as changed or removed — 227
 * "contract deltas" of which 4 were real. Phantom deltas are not merely noisy;
 * IRIS measured a half-mechanism seed as ACTIVELY HARMFUL (−3, worse than no
 * seed), and *"this PR removed the export `foo`"* when it did nothing of the
 * kind is exactly that shape.
 *
 * Symlinks, not copies: a pnpm workspace's `node_modules` is hundreds of MB and
 * the base tree is read-only to us. A PR that changes dependencies makes the
 * base side resolve the HEAD versions — mildly wrong, and far less wrong than
 * `any`; the dependency delta itself is `deps`' job, not this one.
 */
function mirrorNodeModules(repo: string, worktree: string, maxDepth = 4): void {
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) return;
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === ".git") continue;
      const full = join(dir, entry);
      if (entry === "node_modules") {
        const target = join(worktree, relative(repo, full));
        if (existsSync(target)) continue;
        try {
          mkdirSync(dirname(target), { recursive: true });
          symlinkSync(full, target, "dir");
        } catch {
          // A symlink we cannot create just means this sub-tree analyses
          // without its externals — the same tier the no-install case is in.
        }
        continue; // never descend INTO node_modules
      }
      try {
        if (!readdirSync(full, { withFileTypes: true })) continue;
      } catch {
        continue; // a file, or unreadable
      }
      walk(full, depth + 1);
    }
  };
  walk(repo, 0);
}

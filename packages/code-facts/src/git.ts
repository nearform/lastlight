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

const MAX_GIT_BUFFER = 256 * 1024 * 1024;

/**
 * A repo the harness owns but the current uid does not is a real shape in the
 * sandbox (the workspace is chowned to `agent`); without this, every git call
 * fails with "dubious ownership" and the whole run degrades for a reason that
 * has nothing to do with the code.
 */
function gitEnv(): NodeJS.ProcessEnv {
  return { ...process.env, GIT_CONFIG_PARAMETERS: "'safe.directory=*'" };
}

/** Run git in `repo`. Never throws on a non-zero status — callers decide. */
export function tryGit(repo: string, args: string[]): GitResult {
  const result = spawnSync("git", args, {
    cwd: repo,
    encoding: "utf8",
    maxBuffer: MAX_GIT_BUFFER,
    env: gitEnv(),
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

// ── enumerating the files to scan ────────────────────────────────────────────
//
// **The file set comes from GIT, not from `readdirSync`.** Four things follow
// from that one change, and each was a measured bug:
//
//   1. `.gitignore` is honoured BY CONSTRUCTION — an ignored file is not in the
//      tree. Nested `.gitignore` files, `.git/info/exclude` and the global
//      excludes come with it, and no hand-maintained denylist can see any of
//      them. On this monorepo `apps/evals/dist-site/` is ignored by a NESTED
//      `.gitignore` two directories down.
//   2. The scan resolves against the HEAD COMMIT, not the working directory.
//      `constants` cites `path:line` for every hard-coded duplicate and stamps
//      `headSha` in its envelope; a checkout sitting on some other commit made
//      every one of those citations wrong while the document validated cleanly.
//   3. Build output and vendored checkouts disappear for free. MEASURED on this
//      monorepo at `HEAD~1..HEAD`: **44,633 "hard-coded duplicates" across ten
//      constants, 41,079 of them from `apps/server/data/sandboxes/**` alone** —
//      whole cloned review workspaces, gitignored, and under a path no
//      conventional denylist names.
//   4. The file ceiling starts meaning something. The same repo walks 6,000+
//      files (the ceiling, hit) and holds **731** analysable blobs at head.

/** One file to scan. */
export interface ListedFile {
  /** Repo-relative, forward-slashed — exactly what the tree stores. */
  path: string;
  /** The blob id, or `null` when this came from the fallback walk. */
  oid: string | null;
  size: number;
}

/**
 * Where a listing came from. `"walk"` is the degraded tier and MUST be named in
 * `degraded[]` by whoever asked for it — walk-tier output is not tree-tier
 * output, because the walk cannot honour `.gitignore` and reads the working
 * directory rather than a commit.
 */
export type ListingSource = "tree" | "worktree" | "walk";

export interface FileListing {
  files: ListedFile[];
  source: ListingSource;
  /** A written reason whenever `source === "walk"`. `null` otherwise. */
  reason: string | null;
  /** True when `limit` cut the list short — set B is then a PREFIX. */
  truncated: boolean;
  /** Candidates that passed `accept`, BEFORE the ceiling was applied. */
  total: number;
  /** Rejected by `accept` or `maxBytes`. Hygiene, not blindness. */
  rejected: number;
}

export interface ListFilesOptions {
  /** The directory to enumerate. Git runs with this as its cwd. */
  dir: string;
  /**
   * The commit whose tree IS the file set, or `null` to list the working tree
   * (`git ls-files`, tracked plus untracked-but-not-ignored). A working-tree
   * listing is what a consumer that then reads files OFF DISK wants — the
   * ts-morph glob fallback is the only one.
   */
  ref: string | null;
  /** Path filter: the extension test plus the residual denylist. */
  accept(path: string): boolean;
  /** Files larger than this are rejected. `0` disables the check. */
  maxBytes?: number;
  /** A ceiling on how many files are returned. `0` disables it. */
  limit?: number;
}

/** `<mode> SP <type> SP <oid> SP <size> TAB <path>`, NUL-separated. */
function parseTreeRecord(record: string): ListedFile | null {
  const tab = record.indexOf("\t");
  if (tab < 0) return null;
  const meta = record.slice(0, tab).split(/\s+/);
  if (meta.length < 4) return null;
  const [mode, type, oid, size] = meta;
  // Regular files only. `120000` is a symlink whose "contents" are a path,
  // `160000` a submodule gitlink — parsing either as source is a category error.
  if (type !== "blob" || (mode !== "100644" && mode !== "100755")) return null;
  const bytes = Number(size);
  return { path: record.slice(tab + 1), oid, size: Number.isFinite(bytes) ? bytes : 0 };
}

/**
 * Every regular blob at `ref`, with its size — `git ls-tree -r -l -z`.
 *
 * `-l` is what makes the size ceiling free: a 4 MB bundle is rejected from the
 * listing without a single byte of it ever being read. `-z` is not optional
 * either — without it git applies `core.quotePath` and a path with a non-ASCII
 * character comes back C-quoted.
 *
 * `null` means git could not answer: not a repository, a ref that does not
 * resolve, or a blobless/partial clone. The caller falls back to the walk and
 * SAYS SO.
 */
function listTreeBlobs(dir: string, ref: string): ListedFile[] | null {
  const result = tryGit(dir, ["ls-tree", "-r", "-l", "-z", `${ref}^{tree}`]);
  if (result.status !== 0) return null;
  const out: ListedFile[] = [];
  for (const record of result.stdout.split("\0")) {
    if (record.length === 0) continue;
    const file = parseTreeRecord(record);
    if (file) out.push(file);
  }
  return out;
}

/**
 * The working tree, minus everything `.gitignore` excludes — tracked files plus
 * untracked ones git would not ignore.
 *
 * Paths come back relative to `dir`, so running this with `dir` set to a package
 * root scopes the listing to that package with no pathspec arithmetic. Sizes are
 * unknown here (git does not stat for `ls-files`), so `listFiles` stats lazily
 * and only when a `maxBytes` ceiling was actually asked for.
 */
function listWorktreeFiles(dir: string): ListedFile[] | null {
  const result = tryGit(dir, ["ls-files", "-z", "--cached", "--others", "--exclude-standard"]);
  if (result.status !== 0) return null;
  const out: ListedFile[] = [];
  const seen = new Set<string>();
  for (const path of result.stdout.split("\0")) {
    // `--cached --others` can list the same path twice; a duplicate would be
    // charged against the ceiling twice and parsed twice.
    if (path.length === 0 || seen.has(path)) continue;
    seen.add(path);
    out.push({ path, oid: null, size: -1 });
  }
  return out;
}

/**
 * The fallback: `readdirSync`, the way this package used to enumerate always.
 *
 * It cannot honour `.gitignore` and it reads the working directory rather than a
 * commit, so a caller that lands here has WEAKER output than a caller that did
 * not — which is why `FileListing.reason` is populated and every consumer is
 * required to put it in `degraded[]`.
 */
function walkFiles(root: string, accept: (path: string) => boolean): ListedFile[] {
  const out: ListedFile[] = [];
  const walk = (dir: string): void => {
    let entries: string[];
    try {
      entries = readdirSync(dir);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === ".git") continue;
      const full = join(dir, entry);
      const rel = relative(root, full).split(sep).join("/");
      let stats;
      try {
        stats = statSync(full);
      } catch {
        continue;
      }
      if (stats.isDirectory()) {
        // The walk has no `.gitignore`, so the denylist is all it has. A
        // trailing separator is what makes the directory patterns match.
        if (accept(`${rel}/`)) walk(full);
      } else if (stats.isFile() && accept(rel)) {
        out.push({ path: rel, oid: null, size: stats.size });
      }
    }
  };
  walk(root);
  return out;
}

/**
 * The single enumeration seam. Tree first, walk only when git cannot answer.
 *
 * The ceiling is applied AFTER filtering, which is the point of doing it here:
 * the 6000 slots used to be spent on build output before the walk ever reached
 * `src/`, so a repo could truncate while none of its source had been read.
 */
export function listFiles(options: ListFilesOptions): FileListing {
  const maxBytes = options.maxBytes ?? 0;
  const limit = options.limit ?? 0;

  let raw = options.ref === null ? listWorktreeFiles(options.dir) : listTreeBlobs(options.dir, options.ref);
  let source: ListingSource = options.ref === null ? "worktree" : "tree";
  let reason: string | null = null;
  if (raw === null) {
    source = "walk";
    reason =
      `git could not enumerate ${options.ref === null ? "the working tree" : `the tree at ${options.ref.slice(0, 8)}`} ` +
      `in ${options.dir} (not a repository, an unresolvable ref, or a partial clone), so the file set came from a ` +
      `DIRECTORY WALK instead. A walk cannot honour .gitignore — build output, vendored checkouts and untracked ` +
      `scratch files are in scope — and it reads the working directory rather than a commit, so any path:line this ` +
      `run cites is a claim about the checkout, not about the analysed commit`;
    raw = walkFiles(options.dir, options.accept);
  }

  const files: ListedFile[] = [];
  let rejected = 0;
  let total = 0;
  let truncated = false;
  for (const file of raw) {
    if (!options.accept(file.path)) {
      rejected++;
      continue;
    }
    let size = file.size;
    if (maxBytes > 0 && size < 0) {
      // Only the `ls-files` path gets here, and only when a ceiling was asked
      // for — a stat per file is worth avoiding when nobody reads the answer.
      try {
        size = statSync(join(options.dir, file.path)).size;
      } catch {
        rejected++;
        continue;
      }
    }
    if (maxBytes > 0 && size > maxBytes) {
      rejected++;
      continue;
    }
    total++;
    if (limit > 0 && files.length >= limit) {
      truncated = true;
      continue;
    }
    files.push({ ...file, size });
  }

  return { files, source, reason, truncated, total, rejected };
}

/**
 * Roughly this many bytes of blob per `git cat-file --batch` invocation.
 *
 * The batch is what keeps this from being either N subprocesses (6,000 of them)
 * or one enormous buffer (a whole repository in memory at once). Contents are
 * handed to `visit` and dropped; nothing accumulates.
 */
const BLOB_BATCH_BYTES = 4 * 1024 * 1024;
const BLOB_BATCH_FILES = 256;

/**
 * Read every listed file and hand its contents to `visit`, one at a time.
 *
 * Files with an `oid` are read **from the object database at the commit that was
 * enumerated**, not from disk. That is what makes a `path:line` citation a claim
 * about the analysed commit rather than about whatever the checkout happens to
 * hold — the two are the same thing on the normal path and silently different on
 * a workspace that is not at head.
 *
 * Returns how many files could not be read, which is the caller's cue to
 * degrade.
 */
export function readListedFiles(
  dir: string,
  files: ListedFile[],
  visit: (file: ListedFile, contents: string) => void,
): number {
  let unreadable = 0;
  let batch: ListedFile[] = [];
  let batchBytes = 0;

  const flush = (): void => {
    if (batch.length === 0) return;
    const pending = batch;
    batch = [];
    batchBytes = 0;
    const result = spawnSync("git", ["cat-file", "--batch"], {
      cwd: dir,
      input: `${pending.map((file) => file.oid).join("\n")}\n`,
      maxBuffer: MAX_GIT_BUFFER,
      env: gitEnv(),
    });
    const out = result.stdout;
    if (result.status !== 0 || !out) {
      unreadable += pending.length;
      return;
    }
    let offset = 0;
    for (const file of pending) {
      const newline = out.indexOf(0x0a, offset);
      if (newline < 0) {
        unreadable++;
        continue;
      }
      const header = out.toString("utf8", offset, newline).split(" ");
      // `<oid> missing` — the object vanished between the listing and here.
      if (header.length < 3) {
        unreadable++;
        offset = newline + 1;
        continue;
      }
      const size = Number(header[2]);
      const start = newline + 1;
      if (!Number.isFinite(size)) {
        unreadable++;
        break;
      }
      visit(file, out.toString("utf8", start, start + size));
      offset = start + size + 1; // git writes a trailing LF after the contents
    }
  };

  for (const file of files) {
    if (file.oid === null) {
      // The walk tier, and the only path that touches the filesystem.
      try {
        visit(file, readFileSync(join(dir, file.path), "utf8"));
      } catch {
        unreadable++;
      }
      continue;
    }
    batch.push(file);
    batchBytes += Math.max(file.size, 0);
    if (batch.length >= BLOB_BATCH_FILES || batchBytes >= BLOB_BATCH_BYTES) flush();
  }
  flush();
  return unreadable;
}

export interface WorktreeOptions {
  /**
   * Symlink the head tree's `node_modules` into the base worktree. **Defaults
   * to true** — see `mirrorNodeModules` for why a comparison without it is not
   * a comparison.
   *
   * `false` exists so the mirror's value can be a NUMBER in a test rather than
   * a paragraph in a comment: `tests/noise-floor.test.ts` runs one commit both
   * ways and asserts the un-mirrored side is worse by a lower bound.
   */
  mirrorNodeModules?: boolean;
}

/**
 * Materialise `sha` in a throwaway worktree and hand the path to `fn`.
 *
 * `--detach` keeps it off any branch, and `worktree remove --force` in the
 * `finally` keeps the target repo's `.git/worktrees` from accumulating stale
 * entries across the ~40 workspaces the review sweep keeps warm.
 */
export function withWorktree<T>(
  repo: string,
  sha: string,
  fn: (dir: string) => T,
  opts?: WorktreeOptions,
): T {
  const dir = mkdtempSync(join(tmpdir(), "lastlight-facts-base-"));
  try {
    git(repo, ["worktree", "add", "--detach", "--force", dir, sha]);
  } catch (err) {
    rmSync(dir, { recursive: true, force: true });
    throw err;
  }
  try {
    if (opts?.mirrorNodeModules !== false) mirrorNodeModules(repo, dir);
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
 * The surface is narrower than it first reads, and the narrowing is MEASURED:
 * it moves **inferred** types only. An ANNOTATED `function f(x: Ext): Ext`
 * prints as `(x: Ext) => Ext` on both sides even when `@fixture/ext` does not
 * resolve — the type really is `any` (`isAny() === true`), but the printer falls
 * back to the written name, so the two sides compare equal. Inference is where
 * an unresolved module actually shows: `toExt(id)` is `Ext` when the module
 * resolves and `any` when it does not.
 *
 * Still load-bearing at that smaller surface, and `tests/noise-floor.test.ts`
 * is where it becomes a number: on `makeMonorepoFixture()` the un-mirrored run
 * yields 17 deltas against the mirrored run's 1, and the phantom's `before` is
 * literally `any`. Phantom deltas are not merely noisy — IRIS measured a
 * half-mechanism seed as ACTIVELY HARMFUL (−3, worse than no seed), and *"this
 * PR removed the export `foo`"* when it did nothing of the kind is that shape.
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

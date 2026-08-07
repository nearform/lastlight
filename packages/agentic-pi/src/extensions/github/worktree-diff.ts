/**
 * The change set a signed publish sends to GitHub.
 *
 * `createCommitOnBranch` takes files, not a tree: `{ additions: [{path,
 * contents}], deletions: [{path}] }`. So the publish path needs the difference
 * between a base commit and whatever is in the working directory right now —
 * including changes the agent already committed locally, because those local
 * commits are scratch state that never leaves the sandbox.
 *
 * The diff is computed through a TEMPORARY index (`GIT_INDEX_FILE`), so staging
 * the working tree here cannot disturb the index the agent is still using.
 */

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The only tree-entry mode `FileAddition` can express — it carries `path` and
 * base64 `contents`, and no mode. Anything else has to be refused rather than
 * silently published with the wrong bits (issue #268).
 */
const PLAIN_FILE_MODE = "100644";

const MODE_REASONS: Record<string, string> = {
  "100755": "executable (100755) — createCommitOnBranch cannot set file modes",
  "120000": "symlink (120000) — createCommitOnBranch would commit it as a regular file",
  "160000": "submodule pointer (160000) — createCommitOnBranch cannot write gitlinks",
};

export interface PublishAddition {
  path: string;
  /** base64 of the file's bytes — what `FileAddition.contents` wants. */
  contents: string;
  /** `A` for a file that did not exist at the base, `M` for a change. */
  status: "A" | "M";
}

export interface PublishDeletion {
  path: string;
}

export interface UnsupportedChange {
  path: string;
  reason: string;
}

export interface WorktreeChangeSet {
  additions: PublishAddition[];
  deletions: PublishDeletion[];
  unsupported: UnsupportedChange[];
}

function git(cwd: string, args: string[], indexFile?: string): Buffer {
  const env = indexFile ? { ...process.env, GIT_INDEX_FILE: indexFile } : process.env;
  return execFileSync("git", args, { cwd, env, stdio: "pipe", maxBuffer: 256 * 1024 * 1024 });
}

function gitText(cwd: string, args: string[], indexFile?: string): string {
  return git(cwd, args, indexFile).toString("utf8");
}

/** Is this commit object present in the local object store? */
export function hasLocalCommit(cwd: string, oid: string): boolean {
  try {
    git(cwd, ["cat-file", "-e", `${oid}^{commit}`]);
    return true;
  } catch {
    return false;
  }
}

/** The checked-out branch name. Throws on a detached HEAD. */
export function currentBranch(cwd: string): string {
  const name = gitText(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]).trim();
  if (name === "HEAD") {
    throw new Error("HEAD is detached — publish needs a branch; check one out first");
  }
  return name;
}

function reasonFor(srcMode: string, dstMode: string): string {
  const known = MODE_REASONS[dstMode];
  if (known) return known;
  return `mode ${srcMode} → ${dstMode} — createCommitOnBranch cannot set file modes`;
}

/**
 * Parse `git diff-tree -r -z` raw output. Records are
 * `:<srcmode> <dstmode> <srcsha> <dstsha> <status>\0<path>\0`.
 */
function* records(
  raw: string,
): Generator<{ srcMode: string; dstMode: string; dstSha: string; status: string; path: string }> {
  const parts = raw.split("\0");
  for (let i = 0; i + 1 < parts.length; i += 2) {
    const meta = parts[i];
    if (!meta) continue;
    const m = /^:(\d{6}) (\d{6}) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])$/.exec(meta);
    if (!m) throw new Error(`unparseable diff-tree record: ${meta}`);
    yield { srcMode: m[1]!, dstMode: m[2]!, dstSha: m[4]!, status: m[5]!, path: parts[i + 1]! };
  }
}

/**
 * Diff the working tree against `baseOid` and split the result into what the
 * signed publish path can send and what it must refuse.
 *
 * `exclude` takes git pathspecs (e.g. `.lastlight`) for build artifacts a phase
 * writes into the checkout but must not commit — mirroring the
 * `git reset -q -- .lastlight` the prompts used to run by hand.
 */
export function diffWorktreeAgainst(
  cwd: string,
  baseOid: string,
  exclude: string[] = [],
): WorktreeChangeSet {
  const scratch = mkdtempSync(join(tmpdir(), "agentic-pi-publish-"));
  const indexFile = join(scratch, "index");
  try {
    git(cwd, ["read-tree", baseOid], indexFile);
    git(cwd, ["add", "-A", "--", "."], indexFile);
    for (const spec of exclude) {
      git(cwd, ["reset", "-q", baseOid, "--", spec], indexFile);
    }
    const tree = gitText(cwd, ["write-tree"], indexFile).trim();
    const raw = gitText(cwd, ["diff-tree", "-r", "--no-renames", "-z", baseOid, tree], indexFile);

    const additions: PublishAddition[] = [];
    const deletions: PublishDeletion[] = [];
    const unsupported: UnsupportedChange[] = [];

    for (const rec of records(raw)) {
      if (rec.status === "D") {
        deletions.push({ path: rec.path });
        continue;
      }
      if (rec.dstMode !== PLAIN_FILE_MODE) {
        unsupported.push({ path: rec.path, reason: reasonFor(rec.srcMode, rec.dstMode) });
        continue;
      }
      additions.push({
        path: rec.path,
        contents: git(cwd, ["cat-file", "blob", rec.dstSha]).toString("base64"),
        status: rec.status === "A" ? "A" : "M",
      });
    }
    return { additions, deletions, unsupported };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

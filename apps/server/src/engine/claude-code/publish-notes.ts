/**
 * Publish a `claude-code` phase's handoff notes from the host (repo mode).
 *
 * An agentic-pi phase commits its `.lastlight/` notes itself with
 * `github_publish`. A Claude Code session has no GitHub tools and no GitHub
 * credential, so Last Light does it after the phase, as one signed commit
 * through GitHub's API, scoped to `.lastlight/` like the agent's own publish.
 *
 * The tree was written by the sandbox, so the host treats it as untrusted: it
 * runs no `git` in it, follows no link, and reads only regular, singly-linked
 * files, within a size and count cap.
 */
import { closeSync, constants, fstatSync, lstatSync, openSync, readdirSync, readFileSync, readlinkSync, realpathSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { isBotOwnedBranch } from "agentic-pi/dist/bot-branches.js";

const NOTES_DIR = ".lastlight";

export type NotesRefusal = "symlink" | "hardlink" | "not_regular" | "too_large" | "too_many";

/** A note held a secret: nothing was published. */
export class NotesSecretError extends Error {
  constructor(readonly path: string) {
    super(`refusing to publish notes: ${path} holds a secret`);
    this.name = "NotesSecretError";
  }
}

export interface NotesGitHub {
  getBranchTip(owner: string, repo: string, branch: string): Promise<string | null>;
  getDefaultBranchTip(owner: string, repo: string): Promise<string>;
  createBranchAt(owner: string, repo: string, branch: string, sha: string): Promise<unknown>;
  publishSignedCommit(opts: {
    owner: string;
    repo: string;
    branch: string;
    expectedHeadOid: string;
    headline: string;
    additions: { path: string; contents: string }[];
    deletions: { path: string }[];
  }): Promise<{ oid: string }>;
}

/** Where an open fd really points: `/proc/self/fd` on Linux (race-free), else realpath. */
function openedPath(fd: number, abs: string): string | null {
  try {
    return readlinkSync(`/proc/self/fd/${fd}`);
  } catch {
    try {
      return realpathSync(abs);
    } catch {
      return null;
    }
  }
}

/**
 * Read one note, or null. The walk's lstat can be stale by the time of the
 * open (a parent directory swapped for a link), so the decision is made on the
 * opened fd: it must be a regular, singly-linked file within the size cap, and
 * really inside `rootReal`.
 */
export function openNoteUnder(abs: string, rootReal: string, maxBytes: number): Buffer | null {
  let fd: number;
  try {
    fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
  } catch {
    return null;
  }
  try {
    const st = fstatSync(fd);
    if (!st.isFile() || st.nlink > 1 || st.size > maxBytes) return null;
    const real = openedPath(fd, abs);
    if (!real || !real.startsWith(rootReal + sep)) return null;
    return readFileSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The notes under `<workspace>/.lastlight/`, as repo-relative paths, sorted. */
export async function readNotesDir(
  workspace: string,
  opts: { maxFiles?: number; maxBytes?: number } = {},
): Promise<{ files: { path: string; contents: Buffer }[]; refused: { path: string; reason: NotesRefusal }[] }> {
  const maxFiles = opts.maxFiles ?? 50;
  const maxBytes = opts.maxBytes ?? 1_048_576;
  const root = join(workspace, NOTES_DIR);
  const files: { path: string; contents: Buffer }[] = [];
  const refused: { path: string; reason: NotesRefusal }[] = [];

  let top;
  try {
    top = lstatSync(root);
  } catch {
    return { files, refused };
  }
  if (!top.isDirectory()) {
    refused.push({ path: NOTES_DIR, reason: top.isSymbolicLink() ? "symlink" : "not_regular" });
    return { files, refused };
  }

  const rootReal = realpathSync(root);
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    for (const name of readdirSync(dir).sort()) {
      const abs = join(dir, name);
      const rel = relative(workspace, abs).split("\\").join("/");
      const st = lstatSync(abs);
      if (st.isSymbolicLink()) refused.push({ path: rel, reason: "symlink" });
      else if (st.isDirectory()) stack.push(abs);
      else if (!st.isFile()) refused.push({ path: rel, reason: "not_regular" });
      else if (st.nlink > 1) refused.push({ path: rel, reason: "hardlink" });
      else if (st.size > maxBytes) refused.push({ path: rel, reason: "too_large" });
      else {
        if (files.length >= maxFiles) return { files: [], refused: [{ path: NOTES_DIR, reason: "too_many" }] };
        const contents = openNoteUnder(abs, rootReal, maxBytes);
        if (contents) files.push({ path: rel, contents });
        else refused.push({ path: rel, reason: "not_regular" });
      }
    }
  }
  files.sort((a, b) => a.path.localeCompare(b.path));
  return { files, refused };
}

export async function publishClaudeNotes(opts: {
  gh: NotesGitHub;
  owner: string;
  repo: string;
  branch: string;
  /** The checkout root on the host; the notes are its `.lastlight/` tree. */
  workspace: string;
  message: string;
  /** Checked on the exact bytes about to be sent; a hit publishes nothing. */
  holdsSecret?: (contents: Buffer) => boolean;
}): Promise<{ published: boolean; oid?: string; refused: string[] }> {
  if (isBotOwnedBranch(opts.branch)) {
    throw new Error(`refusing to publish notes to ${opts.branch}: a dependency bot owns that branch`);
  }
  const { files, refused } = await readNotesDir(opts.workspace);
  const refusedPaths = refused.map((r) => `${r.path} (${r.reason})`);
  if (files.length === 0) return { published: false, refused: refusedPaths };
  const secret = opts.holdsSecret && files.find((f) => opts.holdsSecret!(f.contents));
  if (secret) throw new NotesSecretError(secret.path);

  const { gh, owner, repo, branch } = opts;
  let tip = await gh.getBranchTip(owner, repo, branch);
  if (tip === null) {
    tip = await gh.getDefaultBranchTip(owner, repo);
    await gh.createBranchAt(owner, repo, branch, tip);
  }
  const commit = await gh.publishSignedCommit({
    owner,
    repo,
    branch,
    expectedHeadOid: tip,
    headline: opts.message,
    additions: files.map((f) => ({ path: f.path, contents: f.contents.toString("base64") })),
    deletions: [],
  });
  return { published: true, oid: commit.oid, refused: refusedPaths };
}

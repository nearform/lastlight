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
import { closeSync, constants, lstatSync, openSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { isBotOwnedBranch } from "agentic-pi/dist/bot-branches.js";

const NOTES_DIR = ".lastlight";

export type NotesRefusal = "symlink" | "hardlink" | "not_regular" | "too_large" | "too_many";

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
        const fd = openSync(abs, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          files.push({ path: rel, contents: readFileSync(fd) });
        } finally {
          closeSync(fd);
        }
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
}): Promise<{ published: boolean; oid?: string; refused: string[] }> {
  if (isBotOwnedBranch(opts.branch)) {
    throw new Error(`refusing to publish notes to ${opts.branch}: a dependency bot owns that branch`);
  }
  const { files, refused } = await readNotesDir(opts.workspace);
  const refusedPaths = refused.map((r) => `${r.path} (${r.reason})`);
  if (files.length === 0) return { published: false, refused: refusedPaths };

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

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  currentBranch,
  diffWorktreeAgainst,
  hasLocalCommit,
} from "../../../src/extensions/github/worktree-diff.js";

/**
 * A real git repo in a temp dir. Mocking git here would test the mock — the
 * whole point of this module is that it agrees with git about what changed.
 */
function repo(): {
  dir: string;
  git: (...a: string[]) => string;
  base: string;
  cleanup: () => void;
} {
  const dir = mkdtempSync(join(tmpdir(), "worktree-diff-"));
  const git = (...a: string[]) =>
    execFileSync("git", a, {
      cwd: dir,
      encoding: "utf8",
      env: {
        ...process.env,
        GIT_AUTHOR_NAME: "t",
        GIT_AUTHOR_EMAIL: "t@e",
        GIT_COMMITTER_NAME: "t",
        GIT_COMMITTER_EMAIL: "t@e",
      },
    });
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "keep.txt"), "one\n");
  git("add", "-A");
  git("commit", "-qm", "base");
  const base = git("rev-parse", "HEAD").trim();
  return { dir, git, base, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

describe("diffWorktreeAgainst", () => {
  test("reports added, modified and deleted files against the base commit", () => {
    const r = repo();
    try {
      writeFileSync(join(r.dir, "tracked.txt"), "one\n");
      r.git("add", "-A");
      r.git("commit", "-qm", "second tracked file");
      const base = r.git("rev-parse", "HEAD").trim();

      writeFileSync(join(r.dir, "tracked.txt"), "changed\n"); // modified
      writeFileSync(join(r.dir, "added.txt"), "x\n"); // added
      rmSync(join(r.dir, "keep.txt")); // deleted

      const cs = diffWorktreeAgainst(r.dir, base);
      assert.deepEqual(cs.deletions, [{ path: "keep.txt" }]);
      assert.deepEqual(cs.additions.map((a) => a.path).sort(), ["added.txt", "tracked.txt"]);
      assert.deepEqual(cs.unsupported, []);
    } finally {
      r.cleanup();
    }
  });

  test("base64-encodes binary content byte-for-byte", () => {
    const r = repo();
    try {
      const bytes = Buffer.from([0x00, 0xff, 0x10, 0x00, 0x7f]);
      writeFileSync(join(r.dir, "blob.bin"), bytes);
      const cs = diffWorktreeAgainst(r.dir, r.base);
      const add = cs.additions.find((a) => a.path === "blob.bin");
      assert.ok(add);
      assert.deepEqual(Buffer.from(add.contents, "base64"), bytes);
    } finally {
      r.cleanup();
    }
  });

  test("picks up changes the agent already committed locally", () => {
    // Local commits are scratch state; the diff is against the REMOTE tip, so
    // a committed change must still show up as an addition.
    const r = repo();
    try {
      writeFileSync(join(r.dir, "committed.txt"), "c\n");
      r.git("add", "-A");
      r.git("commit", "-qm", "local scratch");
      const cs = diffWorktreeAgainst(r.dir, r.base);
      assert.deepEqual(
        cs.additions.map((a) => a.path),
        ["committed.txt"],
      );
    } finally {
      r.cleanup();
    }
  });

  test("refuses a NEW executable file — the API cannot express 100755", () => {
    const r = repo();
    try {
      writeFileSync(join(r.dir, "run.sh"), "#!/bin/sh\n");
      chmodSync(join(r.dir, "run.sh"), 0o755);
      const cs = diffWorktreeAgainst(r.dir, r.base);
      assert.deepEqual(cs.additions, []);
      assert.equal(cs.unsupported.length, 1);
      assert.equal(cs.unsupported[0].path, "run.sh");
      assert.match(cs.unsupported[0].reason, /100755/);
    } finally {
      r.cleanup();
    }
  });

  test("refuses a symlink", () => {
    const r = repo();
    try {
      symlinkSync("keep.txt", join(r.dir, "link.txt"));
      const cs = diffWorktreeAgainst(r.dir, r.base);
      assert.equal(cs.unsupported.length, 1);
      assert.equal(cs.unsupported[0].path, "link.txt");
      assert.match(cs.unsupported[0].reason, /symlink/i);
    } finally {
      r.cleanup();
    }
  });

  test("honours exclude pathspecs and leaves the agent's real index alone", () => {
    const r = repo();
    try {
      mkdirSync(join(r.dir, ".lastlight"));
      writeFileSync(join(r.dir, ".lastlight", "plan.md"), "p\n");
      writeFileSync(join(r.dir, "src.txt"), "s\n");
      const cs = diffWorktreeAgainst(r.dir, r.base, [".lastlight"]);
      assert.deepEqual(
        cs.additions.map((a) => a.path),
        ["src.txt"],
      );
      // The real index must be untouched — the agent may still be working.
      assert.equal(r.git("status", "--porcelain", "--untracked-files=all").includes("A  "), false);
    } finally {
      r.cleanup();
    }
  });

  test("returns an empty change set when the tree matches the base", () => {
    const r = repo();
    try {
      const cs = diffWorktreeAgainst(r.dir, r.base);
      assert.deepEqual(cs, { additions: [], deletions: [], unsupported: [] });
    } finally {
      r.cleanup();
    }
  });

  test("hasLocalCommit and currentBranch read the repo", () => {
    const r = repo();
    try {
      assert.equal(hasLocalCommit(r.dir, r.base), true);
      assert.equal(hasLocalCommit(r.dir, "0".repeat(40)), false);
      assert.equal(currentBranch(r.dir), "main");
    } finally {
      r.cleanup();
    }
  });
});

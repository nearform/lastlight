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

      const added = cs.additions.find((a) => a.path === "added.txt");
      const modified = cs.additions.find((a) => a.path === "tracked.txt");
      assert.equal(added?.status, "A", "a path absent at the base is an addition");
      assert.equal(modified?.status, "M", "a path present at the base is a modification");
    } finally {
      r.cleanup();
    }
  });

  test("a rename is reported as delete+add (status A), never folded into 'M'", () => {
    // diffWorktreeAgainst calls diff-tree with --no-renames deliberately —
    // GitHub's signed-commit API has no rename primitive, so a rename must
    // surface as a plain deletion plus a fresh "A" addition. This pins that
    // coupling: without --no-renames, git's rename detector could collapse
    // this into a single R record, which the naive `status === "A" ? "A" :
    // "M"` derivation would then misreport as "M" — a modification of a path
    // that never existed in the base tree.
    const r = repo();
    try {
      rmSync(join(r.dir, "keep.txt"));
      // Same content as keep.txt ("one\n") — similar enough that git's rename
      // detector would flag this as a near-100%-similarity rename if it ran.
      writeFileSync(join(r.dir, "renamed.txt"), "one\n");
      const cs = diffWorktreeAgainst(r.dir, r.base);
      assert.deepEqual(cs.deletions, [{ path: "keep.txt" }]);
      const added = cs.additions.find((a) => a.path === "renamed.txt");
      assert.ok(added, "renamed.txt should appear as an addition, not vanish into a rename record");
      assert.equal(added.status, "A");
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

  test("allows a content change to an already-executable file", () => {
    const r = repo();
    try {
      writeFileSync(join(r.dir, "run.sh"), "#!/bin/sh\necho v1\n");
      chmodSync(join(r.dir, "run.sh"), 0o755);
      r.git("add", "-A");
      r.git("commit", "-qm", "exec");
      const base = r.git("rev-parse", "HEAD").trim();
      writeFileSync(join(r.dir, "run.sh"), "#!/bin/sh\necho v2\n");
      const cs = diffWorktreeAgainst(r.dir, base);
      assert.deepEqual(cs.unsupported, []);
      assert.deepEqual(
        cs.additions.map((a) => a.path),
        ["run.sh"],
      );
    } finally {
      r.cleanup();
    }
  });

  test("refuses a genuine mode downgrade (100755 -> 100644), not just upgrades", () => {
    // dstMode === PLAIN_FILE_MODE alone is not proof nothing needs to change:
    // GitHub's FileAddition carries no mode field, so it would keep the base
    // tree's 100755 rather than actually downgrade it. That must be refused,
    // not silently published as if it were an ordinary plain-file addition.
    const r = repo();
    try {
      writeFileSync(join(r.dir, "run.sh"), "#!/bin/sh\necho v1\n");
      chmodSync(join(r.dir, "run.sh"), 0o755);
      r.git("add", "-A");
      r.git("commit", "-qm", "exec");
      const base = r.git("rev-parse", "HEAD").trim();
      chmodSync(join(r.dir, "run.sh"), 0o644);
      const cs = diffWorktreeAgainst(r.dir, base);
      assert.deepEqual(cs.additions, []);
      assert.equal(cs.unsupported.length, 1);
      assert.equal(cs.unsupported[0].path, "run.sh");
      assert.match(cs.unsupported[0].reason, /100755/);
    } finally {
      r.cleanup();
    }
  });

  test("still refuses an existing symlink whose target changes, mode unchanged", () => {
    // The existing "refuses a symlink" test only covers a NEW symlink
    // (srcMode 000000), which the pre-Step-6 code would also have refused —
    // so it doesn't pin the half of the mode-preservation deviation that the
    // reviewer found worse than the gitlink case: cat-file blob SUCCEEDS on a
    // symlink's target blob, so a relaxation keyed on "mode unchanged" would
    // have silently published the retargeted symlink's bytes as a regular
    // file instead of refusing or crashing.
    const r = repo();
    try {
      symlinkSync("keep.txt", join(r.dir, "link.txt"));
      r.git("add", "-A");
      r.git("commit", "-qm", "add symlink");
      const base = r.git("rev-parse", "HEAD").trim();
      rmSync(join(r.dir, "link.txt"));
      symlinkSync("tracked.txt", join(r.dir, "link.txt"));
      const cs = diffWorktreeAgainst(r.dir, base);
      assert.deepEqual(cs.additions, []);
      assert.equal(cs.unsupported.length, 1);
      assert.equal(cs.unsupported[0].path, "link.txt");
      assert.match(cs.unsupported[0].reason, /symlink/i);
    } finally {
      r.cleanup();
    }
  });

  test("still refuses an existing submodule pointer when its target commit changes", () => {
    // The mode-preservation relaxation above is scoped to the executable bit
    // ONLY — it was the one case findings.md measured. A gitlink's mode
    // (160000) also stays unchanged when just its target commit moves, so a
    // relaxation keyed on "mode unchanged" alone would let this slip through
    // — and then crash: dstSha here is a commit object, not a blob, so the
    // cat-file read that additions rely on throws instead of degrading to a
    // clean refusal.
    const r = repo();
    const subDir = mkdtempSync(join(tmpdir(), "worktree-diff-sub-"));
    const subGit = (...a: string[]) =>
      execFileSync("git", a, {
        cwd: subDir,
        encoding: "utf8",
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@e",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@e",
        },
      });
    try {
      subGit("init", "-q", "-b", "main");
      subGit("commit", "-q", "--allow-empty", "-m", "s1");
      execFileSync(
        "git",
        ["-c", "protocol.file.allow=always", "submodule", "add", "-q", subDir, "sub"],
        {
          cwd: r.dir,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "t",
            GIT_AUTHOR_EMAIL: "t@e",
            GIT_COMMITTER_NAME: "t",
            GIT_COMMITTER_EMAIL: "t@e",
          },
        },
      );
      r.git("commit", "-qm", "add submodule");
      const base = r.git("rev-parse", "HEAD").trim();
      // `submodule add` CLONED subDir into r.dir/sub — that clone, not the
      // original subDir, is what the working tree actually checks out. Commit
      // there so the submodule's checked-out HEAD (what diffWorktreeAgainst's
      // own `git add -A` reads) is the one that moves.
      execFileSync("git", ["commit", "-q", "--allow-empty", "-m", "s2"], {
        cwd: join(r.dir, "sub"),
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "t",
          GIT_AUTHOR_EMAIL: "t@e",
          GIT_COMMITTER_NAME: "t",
          GIT_COMMITTER_EMAIL: "t@e",
        },
      });

      const cs = diffWorktreeAgainst(r.dir, base);
      assert.deepEqual(cs.additions, []);
      assert.equal(cs.unsupported.length, 1);
      assert.equal(cs.unsupported[0].path, "sub");
      assert.match(cs.unsupported[0].reason, /submodule/i);
    } finally {
      rmSync(subDir, { recursive: true, force: true });
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

/**
 * The git primitives, on their own.
 *
 * Every other file in this suite reaches git THROUGH an extractor, and a
 * primitive only executes there when some fixture happens to exhibit its shape.
 * Four of them never did: no fixture renamed a file, none deleted one, none
 * removed lines without adding any, and **not one had a remote** — so
 * `repoSlug`'s two URL branches had never run, and the diff range that shipped
 * two-dot for a while was the same class of untested primitive.
 *
 * Real repos and real commits, like everywhere else here: a mock of `git diff`
 * would let the claim be wrong while the test passed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  makeGitShapesFixture,
  makeRemotelessFixture,
  type Fixture,
  type GitShapesFixture,
} from "./helpers.js";
import { changedPaths, diffHunks, git, repoSlug, showFile, withWorktree } from "../src/git.js";

describe("changedPaths — the status codes a diff can carry", () => {
  let fixture: GitShapesFixture;
  beforeAll(() => {
    fixture = makeGitShapesFixture();
  });
  afterAll(() => fixture.cleanup());

  /**
   * `R100\told\tnew` has THREE fields, and the new path is the only one that
   * exists at head — which is to say the only one a reference query, a
   * `sourceFileAt` lookup or a `path:line` citation can resolve.
   */
  it("takes the NEW path from an R100 rename line", () => {
    const changed = changedPaths(fixture.dir, fixture.base, fixture.head);
    const renamed = changed.find((c) => c.status === "renamed");
    expect(renamed, "a byte-identical move must be scored as a rename").toBeDefined();
    expect(renamed?.path).toBe(fixture.renamedTo);
    expect(changed.map((c) => c.path)).not.toContain(fixture.renamedFrom);
  });

  it("reports a removed file as `deleted`", () => {
    const changed = changedPaths(fixture.dir, fixture.base, fixture.head);
    expect(changed.find((c) => c.path === fixture.deleted)?.status).toBe("deleted");
  });

  it("reports an edited file as `modified`", () => {
    const changed = changedPaths(fixture.dir, fixture.base, fixture.head);
    expect(changed.find((c) => c.path === fixture.pureDeletion)?.status).toBe("modified");
  });
});

describe("diffHunks — head coordinates, 1-based and inclusive", () => {
  let fixture: GitShapesFixture;
  beforeAll(() => {
    fixture = makeGitShapesFixture();
  });
  afterAll(() => fixture.cleanup());

  /**
   * `@@ -2,2 +1,0 @@` — two lines gone, none added. Nothing at HEAD changed, so
   * there is no changed line to record, but the surrounding code did lose
   * something and dropping the hunk entirely would make "this PR deleted the
   * only caller" invisible. Hence a zero-width range at the anchor line.
   */
  it("records a pure deletion as a zero-width range with NO changed lines", () => {
    const file = diffHunks(fixture.dir, fixture.base, fixture.head).find(
      (f) => f.path === fixture.pureDeletion,
    );
    expect(file, "a file that only lost lines must still appear").toBeDefined();
    expect(file?.hunks).toEqual([`${fixture.pureDeletion}:1-1`]);
    expect(file?.changedLines).toEqual([]);
  });

  it("uses HEAD line numbers for an insertion, inclusive of both ends", () => {
    const file = diffHunks(fixture.dir, fixture.base, fixture.head).find(
      (f) => f.path === fixture.insertion,
    );
    // The inserted line is line 2 AT HEAD (it was between lines 1 and 2 at base).
    expect(file?.hunks).toEqual([`${fixture.insertion}:2-2`]);
    expect(file?.changedLines).toEqual([2]);
  });

  it("carries no hunk for a file that only exists at base", () => {
    // `+++ /dev/null` — there is no head side to give coordinates in.
    const paths = diffHunks(fixture.dir, fixture.base, fixture.head).map((f) => f.path);
    expect(paths).not.toContain(fixture.deleted);
  });
});

describe("showFile — `null` means absent at that ref, not empty", () => {
  let fixture: GitShapesFixture;
  beforeAll(() => {
    fixture = makeGitShapesFixture();
  });
  afterAll(() => fixture.cleanup());

  it("returns null for a path that does not exist at the ref", () => {
    expect(showFile(fixture.dir, fixture.base, fixture.renamedTo)).toBeNull();
    expect(showFile(fixture.dir, fixture.head, fixture.deleted)).toBeNull();
  });

  it("returns the contents at the ref that has it", () => {
    expect(showFile(fixture.dir, fixture.head, fixture.renamedTo)).toBe(
      `export const MOVED = "moved";\n`,
    );
    expect(showFile(fixture.dir, fixture.base, fixture.deleted)).toBe(
      "export const GONE = true;\n",
    );
  });
});

/**
 * The envelope carries `repo` so a STORED document can be attributed without the
 * run context that produced it — and until now every fixture was a bare
 * `git init` with no remote, so only the basename branch had ever executed.
 */
describe("repoSlug — owner/name from the remote, else the directory", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeRemotelessFixture();
  });
  afterAll(() => fixture.cleanup());

  it("falls back to the directory name when there is no remote", () => {
    expect(repoSlug(fixture.dir)).toBe(basename(fixture.dir));
  });

  it("derives owner/name from an ssh remote", () => {
    git(fixture.dir, ["remote", "add", "origin", "git@github.com:nearform/lastlight.git"]);
    expect(repoSlug(fixture.dir)).toBe("nearform/lastlight");
  });

  it("derives owner/name from an https remote, with and without the .git suffix", () => {
    git(fixture.dir, ["remote", "set-url", "origin", "https://github.com/nearform/lastlight.git"]);
    expect(repoSlug(fixture.dir)).toBe("nearform/lastlight");
    git(fixture.dir, ["remote", "set-url", "origin", "https://github.com/nearform/lastlight"]);
    expect(repoSlug(fixture.dir)).toBe("nearform/lastlight");
  });
});

/**
 * `withWorktree` is how `contracts` materialises the base tree, and the review
 * workspace it runs in is REUSED across runs (`PER_TARGET_REUSE_WORKFLOWS`). A
 * leaked worktree there is not a leaked temp dir — it is an entry in the target
 * repo's own `.git/worktrees` that the next run trips over, ~40 warm workspaces
 * at a time.
 */
describe("withWorktree — the cleanup is in a `finally` for a reason", () => {
  let fixture: GitShapesFixture;
  beforeAll(() => {
    fixture = makeGitShapesFixture();
  });
  afterAll(() => fixture.cleanup());

  /** One line per worktree; a leak shows up as a second one AND a stale entry. */
  function worktreeLines(): string[] {
    return git(fixture.dir, ["worktree", "list"]).trim().split("\n");
  }

  it("removes the worktree and prunes when `fn` throws", () => {
    let handed = "";
    expect(() =>
      withWorktree(fixture.dir, fixture.base, (dir) => {
        handed = dir;
        expect(existsSync(join(dir, "src/gone.ts")), "the base tree is materialised").toBe(true);
        throw new Error("the extractor blew up");
      }),
    ).toThrow("the extractor blew up");

    expect(handed).not.toBe("");
    expect(existsSync(handed), "the cleanup is in a `finally`, not on the happy path").toBe(false);
    expect(worktreeLines()).toHaveLength(1);
  });

  /**
   * The temp dir is created BEFORE the add is attempted, so a failed add that
   * did not clean up would leak one directory per `contracts` run — and nothing
   * hands the caller its path to check. `TMPDIR` is redirected instead, which is
   * exact here because `withWorktree` is entirely synchronous: nothing else in
   * this worker can allocate a temp dir while it runs.
   */
  it("cleans the temp dir when `worktree add` itself fails", () => {
    const tmpRoot = mkdtempSync(join(tmpdir(), "ll-facts-tmproot-"));
    const original = process.env.TMPDIR;
    process.env.TMPDIR = tmpRoot;
    try {
      expect(() => withWorktree(fixture.dir, "0".repeat(40), () => "never reached")).toThrow(
        /worktree add/,
      );
    } finally {
      if (original === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = original;
    }
    expect(readdirSync(tmpRoot), "a failed `worktree add` must not leak its scratch dir").toEqual([]);
    rmSync(tmpRoot, { recursive: true, force: true });
  });

  it("hands `fn` the BASE tree and cleans up behind it on the happy path", () => {
    let handed = "";
    const seen = withWorktree(fixture.dir, fixture.base, (dir) => {
      handed = dir;
      // The file the head commit deletes is present here, which is the whole
      // point: this is the base tree, not the agent's checkout.
      return readFileSync(join(dir, "src/gone.ts"), "utf8");
    });
    expect(seen).toBe("export const GONE = true;\n");
    expect(existsSync(handed)).toBe(false);
    expect(worktreeLines()).toHaveLength(1);
  });
});

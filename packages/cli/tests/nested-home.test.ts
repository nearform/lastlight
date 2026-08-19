/**
 * `server setup` must not scaffold a working directory inside another git repo.
 *
 * How this happened for real: the working-directory prompt resolves its answer
 * against the current directory, so running `lastlight server setup` from
 * inside the lastlight checkout and answering `lastlight` cloned the entire
 * core repo to `packages/cli/lastlight` — ~50 MB of nested repository that the
 * outer repo then staged on the next `git add -A`. Setup reported success
 * throughout; nothing pointed at the problem.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { enclosingGitRepo } from "../src/cli-server.js";

let root: string;

/** A directory that looks like a git work tree to `isGitRepo`. */
function fakeRepo(dir: string): string {
  mkdirSync(path.join(dir, ".git"), { recursive: true });
  writeFileSync(path.join(dir, ".git", "HEAD"), "ref: refs/heads/main\n");
  return dir;
}

beforeEach(() => {
  // `realpath` via mkdtemp's own return is not enough on macOS (/var → /private/var),
  // but every path here is derived from `root`, so comparisons stay consistent.
  root = mkdtempSync(path.join(tmpdir(), "ll-nested-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("enclosingGitRepo", () => {
  it("finds an ancestor repo for a directory that does not exist yet", () => {
    // The case that matters: the guard runs BEFORE the clone, so `home` is
    // still absent. A check that stat'd `home` itself would answer null here
    // and wave the dangerous path through.
    const repo = fakeRepo(path.join(root, "checkout"));
    mkdirSync(path.join(repo, "packages", "cli"), { recursive: true });
    const home = path.join(repo, "packages", "cli", "lastlight");
    expect(enclosingGitRepo(home)).toBe(repo);
  });

  it("returns the NEAREST enclosing repo, not the outermost", () => {
    const outer = fakeRepo(path.join(root, "outer"));
    const inner = fakeRepo(path.join(outer, "inner"));
    expect(enclosingGitRepo(path.join(inner, "home"))).toBe(inner);
  });

  it("ignores a repo AT the path itself — that is the adopt case", () => {
    // `enclosingGitRepo` only looks at ancestors; `guardNestedHome` returns
    // early for a repo at `home`, which is the supported "adopt an existing
    // checkout" flow and must never be refused.
    const home = fakeRepo(path.join(root, "home"));
    expect(enclosingGitRepo(home)).toBeNull();
  });

  it("returns null when nothing above is a repo", () => {
    const home = path.join(root, "plain", "lastlight");
    mkdirSync(path.dirname(home), { recursive: true });
    expect(enclosingGitRepo(home)).toBeNull();
  });

  it("terminates at the filesystem root", () => {
    // A missing path with no repo anywhere above must not loop forever.
    expect(enclosingGitRepo(path.join(root, "a", "b", "c", "d"))).toBeNull();
  });
});

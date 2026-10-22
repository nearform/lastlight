import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { __prePopulateWorkspaceForTest as prePopulateWorkspace } from "#src/sandbox/index.js";

/**
 * A fork PR's head branch is not on origin — only `refs/pull/<N>/head` is.
 * Cloning it by branch name failed and the missing-branch fallback checked out
 * the DEFAULT branch under the PR's name, so every fork review reviewed `main`
 * (nearform/lastlight#451). `headFetchRef` fetches the head by pull ref.
 *
 * Real git against a local bare origin bound to the hardcoded github.com URL
 * through an `insteadOf` rewrite — no network.
 */
const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

const OWNER = "acme";
const REPO = "widget";
const TOKEN = "ghs_test_token";
const PULL_REF = "refs/pull/7/head";
const FORK_BRANCH = "fix/from-a-fork";

describe.runIf(gitAvailable)("fork PR checkout via refs/pull/<N>/head", () => {
  let root: string;
  let origin: string;
  let seed: string;
  let workDir: string;
  let repoDir: string;
  let mainSha: string;
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();

  /** Commit on the seed's PR branch and publish it ONLY as the pull ref. */
  function pushPrCommit(message: string): string {
    git(seed, "checkout", "-q", FORK_BRANCH);
    writeFileSync(join(seed, `${message}.txt`), `${message}\n`);
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", message);
    git(seed, "push", "-q", "-f", "origin", `HEAD:${PULL_REF}`);
    return git(seed, "rev-parse", "HEAD");
  }

  function provision(runId: string, headFetchRef: string | undefined, shallow = true): void {
    prePopulateWorkspace(workDir, {
      owner: OWNER, repo: REPO, branch: FORK_BRANCH, baseBranch: "main",
      token: TOKEN, runId, shallow, headFetchRef,
    });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ll-fork-pr-"));
    origin = join(root, "origin.git");
    seed = join(root, "seed");
    workDir = join(root, "work");
    repoDir = join(workDir, REPO);

    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "pipe" });
    const gitconfig = join(root, "gitconfig");
    writeFileSync(
      gitconfig,
      `[user]\n\tname = test\n\temail = test@example.invalid\n` +
        `[url "file://${origin}"]\n\tinsteadOf = https://github.com/${OWNER}/${REPO}.git\n`,
    );
    process.env.GIT_CONFIG_GLOBAL = gitconfig;

    execFileSync("git", ["clone", "-q", origin, seed], { stdio: "pipe" });
    writeFileSync(join(seed, "README.md"), "widget\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "initial");
    git(seed, "push", "-q", "origin", "main");
    mainSha = git(seed, "rev-parse", "HEAD");
    git(seed, "checkout", "-q", "-b", FORK_BRANCH);
  });

  afterEach(() => {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("without a fetch ref, the fork branch falls back to main (the bug this guards)", () => {
    pushPrCommit("the-change");
    provision("run-1", undefined);
    expect(git(repoDir, "rev-parse", "HEAD")).toBe(mainSha);
  });

  it("checks out the PR head from the pull ref, as the PR's branch name", () => {
    const prSha = pushPrCommit("the-change");
    provision("run-1", PULL_REF);

    expect(git(repoDir, "rev-parse", "HEAD")).toBe(prSha);
    expect(git(repoDir, "rev-parse", "--abbrev-ref", "HEAD")).toBe(FORK_BRANCH);
    // The three-dot PR diff post-review anchors against resolves.
    expect(git(repoDir, "diff", "--name-only", "origin/main...HEAD")).toBe("the-change.txt");
  });

  it("refreshes a reused workspace to the new pull head on a different run", () => {
    pushPrCommit("first");
    provision("run-1", PULL_REF);
    const second = pushPrCommit("second");

    provision("run-2", PULL_REF);
    expect(git(repoDir, "rev-parse", "HEAD")).toBe(second);
  });

  it("leaves an empty repo dir when the pull ref is missing — never main", () => {
    provision("run-1", "refs/pull/999/head");
    expect(existsSync(join(repoDir, ".git"))).toBe(false);
    // The agent's cwd is pinned to the repo dir (docker `exec -w`), so it must exist.
    expect(readdirSync(repoDir)).toEqual([]);

    // The next run clones into the empty dir.
    const prSha = pushPrCommit("the-change");
    provision("run-2", PULL_REF);
    expect(git(repoDir, "rev-parse", "HEAD")).toBe(prSha);
  });

  it("discards a reused default-branch checkout when the refresh's pull-ref fetch fails", () => {
    provision("run-1", undefined); // a pre-fix workspace: main under the PR's branch name
    expect(git(repoDir, "rev-parse", "HEAD")).toBe(mainSha);

    provision("run-2", "refs/pull/999/head");
    expect(existsSync(join(repoDir, ".git"))).toBe(false);
    expect(readdirSync(repoDir)).toEqual([]);
  });
});

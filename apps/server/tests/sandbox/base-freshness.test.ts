import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { __prePopulateWorkspaceForTest as prePopulateWorkspace } from "#src/sandbox/index.js";

/**
 * The property the same-run preserve path has to hold **both** halves of: a
 * later phase of the same run keeps the uncommitted scratch an earlier phase
 * wrote, AND sees `origin/<base>` as it stands NOW.
 *
 * A REAL git round-trip rather than an argv assertion, for the same reason
 * `scratch-not-committable.test.ts` is: the defect was never a missing call,
 * it was git quietly not moving a ref. `--depth` implies `--single-branch`, so
 * `remote.origin.fetch` covers the head branch only and `git fetch origin
 * <base>` writes `FETCH_HEAD` and leaves `refs/remotes/origin/<base>` exactly
 * where it was — an argv-level test asserting "we ran a fetch" passes happily
 * against that bug. Only asking git what the ref points at catches it.
 *
 * `prePopulateWorkspace` hardcodes `https://github.com/<owner>/<repo>.git`, so
 * the origin here is a local bare repo bound to that URL through an `insteadOf`
 * rewrite in a throwaway `GIT_CONFIG_GLOBAL`. Nothing leaves the machine.
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

describe.runIf(gitAvailable)("same-run reuse refreshes the base ref", () => {
  let root: string;
  let origin: string;
  let seed: string;
  let workDir: string;
  let repoDir: string;
  const savedGlobal = process.env.GIT_CONFIG_GLOBAL;

  const git = (cwd: string, ...args: string[]): string =>
    execFileSync("git", ["-C", cwd, ...args], { stdio: ["ignore", "pipe", "pipe"] })
      .toString()
      .trim();

  /** Land one more commit on the origin's base branch. Returns its sha. */
  function advanceBase(message: string): string {
    git(seed, "checkout", "-q", "main");
    writeFileSync(join(seed, `${message}.txt`), `${message}\n`);
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", message);
    git(seed, "push", "-q", "origin", "main");
    return git(seed, "rev-parse", "HEAD");
  }

  function provision(runId: string): void {
    prePopulateWorkspace(workDir, {
      owner: OWNER, repo: REPO, branch: "pr-head", baseBranch: "main",
      token: TOKEN, runId, shallow: false,
    });
  }

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "ll-base-fresh-"));
    origin = join(root, "origin.git");
    seed = join(root, "seed");
    workDir = join(root, "work");
    repoDir = join(workDir, REPO);

    execFileSync("git", ["init", "-q", "--bare", "-b", "main", origin], { stdio: "pipe" });
    // Bind the hardcoded github.com URL to the local bare repo, and supply the
    // identity the seed commits need — in a config file only this test sees.
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
    git(seed, "branch", "pr-head");
    git(seed, "push", "-q", "origin", "main", "pr-head");
  });

  afterEach(() => {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    rmSync(root, { recursive: true, force: true });
  });

  it("moves origin/<base> to a commit landed AFTER the run's first phase provisioned", () => {
    provision("run-1");
    const atFirstPhase = git(repoDir, "rev-parse", "origin/main");

    // The `#1016` shape: the base advances while the run's earlier phases run.
    const advanced = advanceBase("landed-mid-run");
    expect(advanced).not.toBe(atFirstPhase);

    provision("run-1");

    expect(git(repoDir, "rev-parse", "origin/main")).toBe(advanced);
  });

  it("adds the base to the fetch refspec, so the agent's own `git fetch origin <base>` moves it too", () => {
    provision("run-1");
    // The clone is `--depth 50`, which implies `--single-branch`; without this
    // the agent's step-1 fetch updates FETCH_HEAD and nothing else.
    expect(git(repoDir, "config", "--get-all", "remote.origin.fetch").split("\n"))
      .toContain("+refs/heads/main:refs/remotes/origin/main");

    const advanced = advanceBase("landed-before-agent-fetch");
    git(repoDir, "fetch", "-q", "origin", "main");
    expect(git(repoDir, "rev-parse", "origin/main")).toBe(advanced);
  });

  it("does not duplicate the refspec across the run's phases", () => {
    provision("run-1");
    provision("run-1");
    provision("run-1");
    const configured = git(repoDir, "config", "--get-all", "remote.origin.fetch").split("\n");
    expect(configured.filter((l) => l === "+refs/heads/main:refs/remotes/origin/main")).toHaveLength(1);
  });

  it("preserves the uncommitted scratch an earlier phase of the same run wrote", () => {
    provision("run-1");
    // What the preserve path exists for: the architect's plan in the tree, and
    // the fix loop's push gate under `.git/` (which `git clean` never reaches).
    writeFileSync(join(repoDir, "plan.md"), "architect plan\n");
    writeFileSync(join(repoDir, "README.md"), "widget\nlocally edited\n");
    writeFileSync(join(repoDir, ".git", "lastlight-verify.sh"), "#!/bin/sh\nexit 0\n");
    const headBefore = git(repoDir, "rev-parse", "HEAD");

    advanceBase("landed-mid-run");
    provision("run-1");

    expect(readFileSync(join(repoDir, "plan.md"), "utf-8")).toBe("architect plan\n");
    expect(readFileSync(join(repoDir, "README.md"), "utf-8")).toContain("locally edited");
    expect(readFileSync(join(repoDir, ".git", "lastlight-verify.sh"), "utf-8")).toContain("exit 0");
    // Refs moved; HEAD, the index and the working tree did not.
    expect(git(repoDir, "rev-parse", "HEAD")).toBe(headBefore);
    expect(git(repoDir, "status", "--porcelain")).toContain("plan.md");
    expect(git(repoDir, "status", "--porcelain")).toContain("README.md");
  });
});

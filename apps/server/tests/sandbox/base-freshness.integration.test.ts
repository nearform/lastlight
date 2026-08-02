import { describe, it, expect, afterAll, beforeAll } from "vitest";
import { execFileSync } from "child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

import { __prePopulateWorkspaceForTest as prePopulateWorkspace } from "#src/sandbox/index.js";

/**
 * The `#1016` shape, end-to-end against a real origin: a run provisions, the
 * base branch advances underneath it, a later phase of the SAME run provisions
 * again, and the merge that phase performs must land the NEW base tip — not the
 * one the run's first phase happened to fetch.
 *
 * Split out from the unit tests because it needs a base history deep enough
 * (> the `--depth 50` pre-clone) for shallowness to be observable, and the
 * second assertion is the caution the plan attaches to fix 2: a bare fetch into
 * a shallow repository has awkward depth semantics and can deepen far further
 * than intended. `ensureBaseAvailable` keeps an explicit `--depth`, and this is
 * where that is verified rather than assumed — a silent unshallow of a large
 * monorepo is a minutes-long provisioning regression nobody would attribute to
 * a base-ref fix.
 *
 * Opt-in + self-gating, like `command-exec.integration.test.ts`: needs
 * `RUN_SANDBOX_IT=1` and a `git` binary, so the default `npx vitest run` skips
 * it instantly. It talks to a local bare repo bound to the hardcoded
 * github.com URL through an `insteadOf` rewrite — no docker, no network.
 *
 *   RUN_SANDBOX_IT=1 npx vitest run tests/sandbox/base-freshness.integration.test.ts
 */
function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

const RUN = process.env.RUN_SANDBOX_IT === "1" && gitAvailable();

/** Deeper than the pre-clone's `--depth 50`, so `.git/shallow` survives it. */
const BASE_HISTORY = 60;

const OWNER = "acme";
const REPO = "widget";
const TOKEN = "ghs_test_token";

describe.skipIf(!RUN)("base freshness across phases of one run (integration)", () => {
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

  function provision(runId: string): void {
    prePopulateWorkspace(workDir, {
      owner: OWNER, repo: REPO, branch: "pr-head", baseBranch: "main",
      token: TOKEN, runId, shallow: false,
    });
  }

  beforeAll(() => {
    root = mkdtempSync(join(tmpdir(), "ll-base-fresh-it-"));
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
    for (let i = 1; i < BASE_HISTORY; i++) {
      git(seed, "commit", "-q", "--allow-empty", "-m", `base ${i}`);
    }
    // The PR: cut off the base tip, one commit of its own — a dependency bump.
    git(seed, "checkout", "-q", "-b", "pr-head");
    writeFileSync(join(seed, "package.json"), `{"deps":"bumped"}\n`);
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "chore(deps): bump the thing");
    git(seed, "push", "-q", "origin", "main", "pr-head");
  });

  afterAll(() => {
    if (savedGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
    else process.env.GIT_CONFIG_GLOBAL = savedGlobal;
    if (root) rmSync(root, { recursive: true, force: true });
  });

  it("merges the base as it stands when the FIX phase starts, not when the run started", () => {
    // Phase 1 of the run (diagnose, say) provisions the workspace.
    provision("run-1");
    const atFirstPhase = git(repoDir, "rev-parse", "origin/main");
    expect(existsSync(join(repoDir, ".git", "shallow"))).toBe(true);

    // A dep bump lands on the base while that phase is still running — the
    // 10:00:03 commit in the #1016 trace.
    git(seed, "checkout", "-q", "main");
    writeFileSync(join(seed, "lockfile.txt"), "regenerated\n");
    git(seed, "add", "-A");
    git(seed, "commit", "-q", "-m", "chore(deps): another bump");
    git(seed, "push", "-q", "origin", "main");
    const newTip = git(seed, "rev-parse", "main");
    expect(newTip).not.toBe(atFirstPhase);

    // Phase 2 of the SAME run provisions, then does exactly what the fix prompt
    // does: bring the branch up to date with its base.
    provision("run-1");
    git(repoDir, "merge", "--no-edit", "origin/main");

    // The merge commit's second parent is the NEW base tip. On the stale-base
    // bug it was the old one, and the PR stayed `dirty`.
    const parents = git(repoDir, "rev-list", "--parents", "-n", "1", "HEAD").split(" ");
    expect(parents[2]).toBe(newTip);
    expect(readFileSync(join(repoDir, "lockfile.txt"), "utf-8")).toBe("regenerated\n");
  });

  it("leaves the repository shallow, with no silent depth escalation", () => {
    // Refreshing the base must not unshallow the clone — `ensureBaseAvailable`
    // fetches with an explicit `--depth`, never a bare fetch.
    expect(existsSync(join(repoDir, ".git", "shallow"))).toBe(true);
    const reachable = Number(git(repoDir, "rev-list", "--count", "HEAD"));
    // Bounded by the pre-clone's own `--depth 50` (plus the PR commit and the
    // merge), NOT by the full BASE_HISTORY the origin carries — an unshallow
    // would put every one of those commits in reach.
    expect(reachable).toBeGreaterThan(0);
    expect(reachable).toBeLessThan(BASE_HISTORY);
  });
});

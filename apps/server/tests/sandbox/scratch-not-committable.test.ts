import { describe, it, expect, beforeAll } from "vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { PR_NOTES_FILE_NAME, VERIFY_SCRIPT_NAME } from "#src/engine/fix-scratch.js";

/**
 * The one property the whole `.git/` placement exists to buy: **the agent's own
 * `git add -A && git commit` cannot pick up either harness scratch file.**
 *
 * This is deliberately a REAL git round-trip against a real checkout rather
 * than an assertion about a `.git/info/exclude` string. The bug it replaces
 * (#256) was precisely that the string assertion held on the backends that
 * wrote the exclude line and said nothing at all about the kubernetes backend,
 * which never did — so the harness's scratch files were committed into the
 * dependency PR there. A test that asks git the question cannot be satisfied by
 * a suppression one backend forgot to apply.
 *
 * Both fix prompts instruct the agent to `git add -A && git commit`, which is
 * why that is the exact command run here.
 */
const gitAvailable = (() => {
  try {
    execFileSync("git", ["--version"], { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
})();

describe.runIf(gitAvailable)("the harness's scratch files are not committable", () => {
  let repo: string;
  let committed: string[];

  beforeAll(() => {
    repo = mkdtempSync(join(tmpdir(), "scratch-repo-"));
    const git = (...args: string[]) =>
      execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" }).toString();

    execFileSync("git", ["init", "-q", "-b", "main", repo], { stdio: "pipe" });
    git("config", "user.email", "test@example.invalid");
    git("config", "user.name", "test");
    // A tracked file, so the commit below has something legitimate to carry —
    // otherwise an empty commit could pass for the right reason by accident.
    writeFileSync(join(repo, "package.json"), "{}\n");

    // Exactly what the fix agent writes, at exactly the paths the harness and
    // the prompts name.
    writeFileSync(join(repo, VERIFY_SCRIPT_NAME), "#!/bin/sh\nexit 0\n");
    writeFileSync(join(repo, PR_NOTES_FILE_NAME), "ruled-out: not the lockfile\n");

    git("add", "-A");
    git("commit", "-q", "-m", "fix: bump the thing");
    committed = git("ls-tree", "-r", "--name-only", "HEAD").split("\n").filter(Boolean);
  });

  it("commits the agent's real change", () => {
    expect(committed).toContain("package.json");
  });

  it("does not commit the push gate", () => {
    expect(committed).not.toContain(VERIFY_SCRIPT_NAME);
  });

  it("does not commit the PR journal", () => {
    expect(committed).not.toContain(PR_NOTES_FILE_NAME);
  });

  it("leaves nothing of either file anywhere in the tree", () => {
    // Belt for the two above: no path in the commit mentions them under any
    // prefix, so a future move that keeps the basename but leaves `.git/`
    // fails here rather than silently in production.
    expect(committed.filter((p) => p.includes("lastlight-verify") || p.includes("lastlight-notes")))
      .toEqual([]);
  });

  it("does not report either file as untracked either", () => {
    // `git status` is what a human debugging the sandbox sees, and what a
    // `git add <path>` would have to name. Both files are invisible to it,
    // which is the difference between placement and suppression.
    const status = execFileSync("git", ["-C", repo, "status", "--porcelain", "-uall"], {
      stdio: "pipe",
    }).toString();
    expect(status.trim()).toBe("");
  });

  it("pins both paths under `.git/`, which is what makes the above structural", () => {
    expect(VERIFY_SCRIPT_NAME.startsWith(".git/")).toBe(true);
    expect(PR_NOTES_FILE_NAME.startsWith(".git/")).toBe(true);
  });
});

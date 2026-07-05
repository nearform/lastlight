import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, lstatSync, readFileSync } from "fs";
import { join, basename } from "path";
import { tmpdir } from "os";

import { sandboxFor, type SandboxFactoryOpts } from "#src/sandbox/sandbox.js";

/**
 * Skill staging must land REAL files inside the mounted cwd for gondolin — a
 * symlink's target is the skill source in the install tree, outside the guest's
 * only mount (cwd), so it would dangle and the agent couldn't read SKILL.md.
 * `none` keeps the cheaper symlink (host FS fully visible). Regression guard for
 * the gondolin skills-unreadable bug.
 */
describe("InProcessSandbox.stageSkills — copy for gondolin, symlink for none", () => {
  function makeSkill(): string {
    const root = mkdtempSync(join(tmpdir(), "skill-src-"));
    const dir = join(root, "code-review");
    mkdirSync(join(dir, "references"), { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), "# code-review\nthe rubric\n");
    writeFileSync(join(dir, "references", "checklist.md"), "- check things\n");
    return dir;
  }

  function opts(): SandboxFactoryOpts {
    return {
      taskId: "t1",
      egress: { unrestricted: false, hosts: [] },
      env: {},
      stateDir: mkdtempSync(join(tmpdir(), "skill-state-")),
      repoSubdir: "repo",
    };
  }

  it("gondolin copies the skill tree (real files, dereferenced) into the mounted cwd", async () => {
    const skill = makeSkill();
    const sb = sandboxFor("gondolin", opts());
    const { agentCwd } = await sb.provision();
    const staged = sb.stageSkills("review", [skill]);

    expect(staged).toHaveLength(1);
    const dest = staged![0];
    // Inside the mounted cwd (the repo), so agentic-pi maps it into /workspace.
    expect(dest.startsWith(agentCwd)).toBe(true);
    // A real directory, NOT a symlink — survives a mount that shares only cwd.
    expect(lstatSync(dest).isSymbolicLink()).toBe(false);
    expect(lstatSync(dest).isDirectory()).toBe(true);
    // Content (incl. nested references/) is physically present.
    expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toContain("the rubric");
    expect(lstatSync(join(dest, "references", "checklist.md")).isFile()).toBe(true);
  });

  it("none symlinks the skill (host FS is visible, so the link resolves)", async () => {
    const skill = makeSkill();
    const sb = sandboxFor("none", opts());
    await sb.provision();
    const staged = sb.stageSkills("review", [skill]);

    expect(staged).toHaveLength(1);
    const dest = staged![0];
    expect(basename(dest)).toBe("code-review");
    expect(lstatSync(dest).isSymbolicLink()).toBe(true);
    // And it still resolves to the source content on the host.
    expect(readFileSync(join(dest, "SKILL.md"), "utf8")).toContain("the rubric");
  });
});

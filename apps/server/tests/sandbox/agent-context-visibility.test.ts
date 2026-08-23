import { describe, it, expect } from "vitest";
import { mkdtempSync, existsSync } from "fs";
import { dirname, join, relative, isAbsolute } from "path";
import { tmpdir } from "os";

import { sandboxFor, type SandboxFactoryOpts } from "#src/sandbox/sandbox.js";

/**
 * `AGENTS.md` must stay VISIBLE to the agent on the `gondolin` backend — the
 * shipped production default, and the one that mounts ONLY `cwd` into the guest.
 *
 * `deliverAgentContext` writes the persona to `hostWorkspaceDir` (the workspace
 * ROOT), while the agent's cwd is the checkout one level below. That looks like
 * it should be invisible on gondolin — and for a SKILL it would be, which is why
 * `stageSkills` copies the bundle under `cwd` (see `skill-staging.test.ts`). It
 * is not, because pi loads context files itself, host-side, by walking UP from
 * `cwd` and inlining them into the system prompt; the agent never reads the file
 * with a tool, so the mount boundary never applies to it. The pi half of that is
 * pinned by `packages/agentic-pi/test/context-file-walk.test.ts`.
 *
 * This file pins the half that lives here: the write target is on the walk. If a
 * future change ever moved the agent's cwd out from under `hostWorkspaceDir`, or
 * moved the write somewhere off that chain, every backend would silently lose
 * `security.md` / `rules.md` — no error, no log line, no failing run.
 */
describe("AGENTS.md placement stays on pi's context-file walk", () => {
  function opts(): SandboxFactoryOpts {
    return {
      taskId: "t1",
      egress: { unrestricted: false, hosts: [] },
      env: {},
      stateDir: mkdtempSync(join(tmpdir(), "ctx-vis-state-")),
      repoSubdir: "repo",
    };
  }

  /** Every directory pi's loader visits, walking up from `cwd` to the FS root. */
  function ancestorWalk(cwd: string): string[] {
    const dirs: string[] = [];
    for (let d = cwd; ; d = dirname(d)) {
      dirs.push(d);
      if (dirname(d) === d) return dirs;
    }
  }

  for (const backend of ["gondolin", "none"] as const) {
    it(`${backend}: the workspace root is an ancestor of the agent's cwd`, async () => {
      const sb = sandboxFor(backend, opts());
      const { hostWorkspaceDir, hostAgentCwd, agentCwd } = await sb.provision();

      // In-process backends run the agent in the harness process, so the two
      // views of the cwd coincide — the walk is over real host paths.
      expect(hostAgentCwd).toBe(agentCwd);
      expect(existsSync(hostWorkspaceDir)).toBe(true);

      // The persona's directory is one pi will visit.
      expect(ancestorWalk(hostAgentCwd)).toContain(hostWorkspaceDir);

      // …and it is genuinely ABOVE the checkout, never inside it: that is what
      // keeps a repo-write phase's `git add -A` from committing the bot's own
      // persona file.
      const rel = relative(hostWorkspaceDir, hostAgentCwd);
      expect(rel).not.toBe("");
      expect(rel.startsWith("..")).toBe(false);
      expect(isAbsolute(rel)).toBe(false);
    });
  }

  it("gondolin: the persona sits OUTSIDE the guest mount, unlike the skill bundle", async () => {
    // Not a defect — the contrast IS the mechanism. The skill bundle has to be
    // under `cwd` because the agent `read`s SKILL.md through the sandboxed tool
    // (gondolin's `toGuestPath` throws "path escapes workspace" above `cwd`).
    // AGENTS.md does not, because it arrives as prompt text.
    const sb = sandboxFor("gondolin", opts());
    const { hostWorkspaceDir, agentCwd } = await sb.provision();

    expect(relative(agentCwd, join(hostWorkspaceDir, "AGENTS.md")).startsWith("..")).toBe(true);
  });
});

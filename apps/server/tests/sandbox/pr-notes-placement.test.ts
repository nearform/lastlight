import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { sandboxFor, type SandboxFactoryOpts } from "#src/sandbox/sandbox.js";
import { resetPrNotesJournal } from "#src/engine/executors/shared.js";
import { PR_NOTES_FILE_NAME } from "#src/engine/pr-notes.js";

/**
 * Where the PR journal (`.git/lastlight-notes`) resolves.
 *
 * The placement question is the same one `.git/lastlight-verify.sh` answered
 * (`verify-gate.test.ts`), and it resolves the same way — inside the CHECKOUT's
 * own `.git/` on every backend — for one hard reason and one soft one:
 *
 *   - **hard**: gondolin is the packaged default (`sandbox.backend: gondolin`)
 *     and mounts only cwd, so a workspace-root sibling reached via `../` is
 *     unreachable in the guest. A `../` journal would silently never be written
 *     on the default backend, which for a MEMORY feature is indistinguishable
 *     from "the agent had nothing to say". `.git/` is inside cwd.
 *   - **soft**: one uniform path is what lets the prompt state a literal
 *     filename while the harvest resolves the same path off the run row without
 *     knowing the backend.
 *
 * `artifactIssueDir`'s relocation could not be reused for either: it is
 * conditional on `buildAssets === "server"` AND a non-gondolin backend, whereas
 * the journal must be placed correctly on EVERY backend in EVERY `buildAssets`
 * mode — because unlike a build handoff doc, it must never end up in a
 * dependency PR. That it CANNOT is proved directly against git in
 * `scratch-not-committable.test.ts`.
 */
describe("the PR journal resolves under the checkout, not the workspace root", () => {
  function opts(): SandboxFactoryOpts {
    return {
      taskId: "t-notes",
      egress: { unrestricted: false, hosts: [] },
      env: {},
      stateDir: mkdtempSync(join(tmpdir(), "notes-state-")),
      // Stands in for a pre-cloned `<workspace>/<repo>` checkout without
      // reaching the network (`provision({ repo })` would really `git clone`).
      repoSubdir: "widget",
    };
  }

  // gondolin is the packaged default; `none` is the CI/dev path. Both are
  // InProcessSandbox and both must agree.
  it.each(["gondolin", "none"] as const)("%s: the journal is beside the agent's cwd", async (mode) => {
    const sb = sandboxFor(mode, opts());
    const { hostWorkspaceDir, agentCwd } = await sb.provision();

    expect(agentCwd).toBe(join(hostWorkspaceDir, "widget"));
    expect(join(agentCwd, PR_NOTES_FILE_NAME)).toBe(
      join(hostWorkspaceDir, "widget", PR_NOTES_FILE_NAME),
    );
    // ...and never a `../` sibling of the repo, which gondolin cannot see.
    expect(join(agentCwd, PR_NOTES_FILE_NAME)).not.toBe(
      join(hostWorkspaceDir, PR_NOTES_FILE_NAME),
    );
  });

  it("docker: the same relative path lands inside the bind-mounted checkout", async () => {
    // The docker adapter maps the whole workspace in, so the identical relative
    // path resolves in-container. One path, every backend — which is the point.
    const sb = sandboxFor("docker", opts());
    expect(sb.sandboxPathFor(`widget/${PR_NOTES_FILE_NAME}`)).toContain(
      `widget/${PR_NOTES_FILE_NAME}`,
    );
  });
});

describe("the start-of-run reset", () => {
  function checkout(): string {
    const dir = mkdtempSync(join(tmpdir(), "notes-repo-"));
    mkdirSync(join(dir, ".git", "info"), { recursive: true });
    return dir;
  }

  it("is idempotent, so every provisioning path may call it", () => {
    const repo = checkout();
    writeFileSync(join(repo, PR_NOTES_FILE_NAME), "finding: from a run that died\n");
    resetPrNotesJournal(repo);
    resetPrNotesJournal(repo);
    resetPrNotesJournal(repo);
    expect(existsSync(join(repo, PR_NOTES_FILE_NAME))).toBe(false);
  });

  it("writes no `.git/info/exclude` line — placement is the guarantee now", () => {
    // The journal lives under `.git/`, which git never walks, so there is
    // nothing to exclude. Asserted rather than assumed because the exclude
    // registration was the OLD guarantee, and the kubernetes backend never
    // implemented it (#256) — a suppression every backend must remember is not
    // a guarantee. `scratch-not-committable.test.ts` proves the property
    // directly against git.
    const repo = checkout();
    resetPrNotesJournal(repo);
    // Not even created — the reset touches nothing but the journal itself.
    expect(existsSync(join(repo, ".git", "info", "exclude"))).toBe(false);
  });

  it("clears a journal a crashed earlier run left behind", () => {
    // Provenance that LIES is worse than a lost note: without this, a file the
    // previous run's agent wrote but never got harvested would be drained by
    // the next run and stamped with that run's id.
    const repo = checkout();
    writeFileSync(join(repo, PR_NOTES_FILE_NAME), "finding: from a run that died\n");

    resetPrNotesJournal(repo);

    expect(existsSync(join(repo, PR_NOTES_FILE_NAME))).toBe(false);
  });

  it("no-ops on a dir that is not a checkout", () => {
    const notARepo = mkdtempSync(join(tmpdir(), "notes-plain-"));
    expect(() => resetPrNotesJournal(notARepo)).not.toThrow();
    expect(existsSync(join(notARepo, ".git"))).toBe(false);
  });
});

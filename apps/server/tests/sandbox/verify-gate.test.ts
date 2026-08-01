import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { sandboxFor, type SandboxFactoryOpts } from "#src/sandbox/sandbox.js";
import { resetVerifyScript, VERIFY_SCRIPT_NAME } from "#src/engine/agent-executor.js";

/**
 * Where the fix workflows' push gate (`.git/lastlight-verify.sh`) resolves.
 *
 * The `until_bash` command is a LITERAL relative path — `validateShellCommand`
 * rejects any `{{`, so it cannot be templated per backend — and it runs with
 * `cwd = agentCwd`. Every backend sets `agentCwd` to the CHECKOUT when the
 * workspace was pre-cloned (`<workspace>/<repo>`), so one bare relative path
 * works everywhere. A `../` sibling would not: gondolin is the packaged default
 * and mounts only cwd, so the workspace root is unreachable in the guest and
 * the gate would silently never run on the default backend. `.git/` is inside
 * cwd, so it stays reachable.
 *
 * That the gate cannot be COMMITTED is a separate property with its own test —
 * `scratch-not-committable.test.ts` asks git directly rather than asserting on
 * an exclude file, which is the whole point of the `.git/` placement.
 */
describe("the push gate resolves under the checkout, not the workspace root", () => {
  function opts(): SandboxFactoryOpts {
    return {
      taskId: "t-verify",
      egress: { unrestricted: false, hosts: [] },
      env: {},
      stateDir: mkdtempSync(join(tmpdir(), "verify-state-")),
      // Stands in for a pre-cloned `<workspace>/<repo>` checkout without
      // reaching the network (`provision({ repo })` would really `git clone`).
      repoSubdir: "widget",
    };
  }

  // gondolin is the packaged default (`sandbox.backend: gondolin`); `none` is
  // the CI/dev path. Both are InProcessSandbox, and both must agree.
  it.each(["gondolin", "none"] as const)("%s: cwd is the checkout", async (mode) => {
    const sb = sandboxFor(mode, opts());
    const { hostWorkspaceDir, agentCwd } = await sb.provision();

    expect(agentCwd).toBe(join(hostWorkspaceDir, "widget"));
    // So `sh .git/lastlight-verify.sh` reads the script inside the repo — the
    // only path reachable from a mount that shares cwd alone.
    expect(join(agentCwd, VERIFY_SCRIPT_NAME)).toBe(
      join(hostWorkspaceDir, "widget", VERIFY_SCRIPT_NAME),
    );
    // ...and never a sibling of the repo.
    expect(join(agentCwd, VERIFY_SCRIPT_NAME)).not.toBe(
      join(hostWorkspaceDir, VERIFY_SCRIPT_NAME),
    );
  });

  it("a reset clears the previous attempt's gate from that checkout", async () => {
    // The ONLY thing that clears it: the reused-workspace refresh's
    // `git clean -fdx` cannot enter `.git/`, and it sits inside a try/catch
    // anyway. A stale gate passes green against the wrong commands.
    const sb = sandboxFor("gondolin", opts());
    const { agentCwd } = await sb.provision();
    mkdirSync(join(agentCwd, ".git"), { recursive: true });
    // Attempt 1's gate, left behind in the workspace the fix family shares.
    writeFileSync(join(agentCwd, VERIFY_SCRIPT_NAME), "#!/bin/sh\nexit 0\n");

    resetVerifyScript(agentCwd);

    expect(existsSync(join(agentCwd, VERIFY_SCRIPT_NAME))).toBe(false);
  });

  it("the gondolin skill bundle is still excluded, and does not need the gate to be", async () => {
    // The bundle DOES live in the work tree on gondolin (pi reads it through
    // the cwd mount), so it still needs `.git/info/exclude`. The gate does not,
    // and no longer writes a line there — asserted so a future change that
    // moves the gate back out of `.git/` fails here as well.
    const sb = sandboxFor("gondolin", opts());
    const { agentCwd } = await sb.provision();
    mkdirSync(join(agentCwd, ".git", "info"), { recursive: true });

    const skillSrc = mkdtempSync(join(tmpdir(), "verify-skill-"));
    mkdirSync(join(skillSrc, "fixing"), { recursive: true });
    writeFileSync(join(skillSrc, "fixing", "SKILL.md"), "# fixing\n");
    sb.stageSkills("fix", [join(skillSrc, "fixing")]);
    resetVerifyScript(agentCwd);

    const body = readFileSync(join(agentCwd, ".git", "info", "exclude"), "utf8");
    expect(body).toContain("/.lastlight-skills/");
    expect(body).not.toContain("lastlight-verify");
    rmSync(skillSrc, { recursive: true, force: true });
  });
});

/**
 * Pi's context-file (`AGENTS.md`) resolution — the mechanism every Last Light
 * backend's persona delivery rests on.
 *
 * The harness writes the bot's persona + hard rules to the WORKSPACE ROOT, while
 * the agent's cwd is the repo checkout one level below (`hostWorkspaceDir` vs
 * `hostAgentCwd` in `apps/server/src/sandbox/sandbox.ts`). Nothing hands pi that
 * path: the file is found because `DefaultResourceLoader` walks UP from `cwd`
 * and inlines what it finds into the system prompt at session construction.
 *
 * Two properties are load-bearing, and both are properties of a DEPENDENCY, so
 * they are pinned here rather than assumed:
 *
 *  1. **The walk reaches an ancestor.** If a pi upgrade ever bounded it to `cwd`,
 *     every backend would silently lose `security.md` / `rules.md` — a prompt
 *     regression with no error, no log line and no failing run.
 *  2. **The read is a plain host `fs` read.** That is what makes the `gondolin`
 *     backend work at all: gondolin mounts ONLY `cwd` into the guest, so a file
 *     one level up is unreachable by the agent's `read` tool — but the persona
 *     never travels through a tool, it arrives as prompt text loaded by the
 *     process hosting pi.
 *
 * The third assertion is the flip side of the same walk, and is a hazard rather
 * than a feature: the walk does NOT stop at the workspace root, so a stray
 * `AGENTS.md`/`CLAUDE.md` anywhere above it is injected too.
 */
import { describe, test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DefaultResourceLoader } from "@earendil-works/pi-coding-agent";

describe("pi context-file resolution", () => {
  let root: string;
  let workspace: string;
  let repo: string;

  before(() => {
    // Mirrors a pre-cloned run: <root>/<workspace>/<repo>, persona at the
    // workspace root, agent cwd at the checkout.
    root = mkdtempSync(join(tmpdir(), "ap-ctx-walk-"));
    workspace = join(root, "sandboxes", "task-1");
    repo = join(workspace, "acme-repo");
    mkdirSync(repo, { recursive: true });
    writeFileSync(join(workspace, "AGENTS.md"), "PERSONA AND HARD RULES");
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  /** A loader with an agentDir that doesn't exist, so only the cwd walk contributes. */
  async function load(cwd: string) {
    const loader = new DefaultResourceLoader({ cwd, agentDir: join(root, "no-such-agent-dir") });
    await loader.reload();
    return loader.getAgentsFiles().agentsFiles;
  }

  test("an AGENTS.md one level ABOVE cwd is loaded, with its content inlined", async () => {
    const files = await load(repo);

    const persona = files.find((f) => f.path === join(workspace, "AGENTS.md"));
    assert.ok(persona, `expected ${join(workspace, "AGENTS.md")} in ${JSON.stringify(files.map((f) => f.path))}`);
    // Content, not just the path — pi embeds the bytes in the system prompt, which
    // is what lets a cwd-only mount (gondolin) still carry the persona.
    assert.equal(persona.content.trim(), "PERSONA AND HARD RULES");
  });

  test("it is found the same way when cwd IS the workspace root (no pre-clone)", async () => {
    const files = await load(workspace);

    assert.ok(files.some((f) => f.path === join(workspace, "AGENTS.md")));
  });

  test("the walk does not stop at the workspace root — anything above it is injected too", async () => {
    // Documents the hazard, not a wish: `apps/server/Dockerfile` must keep the
    // agent image's `/app` free of AGENTS.md/CLAUDE.md, because `$STATE_DIR`
    // (and so every workspace) lives under it on the in-process backends.
    writeFileSync(join(root, "CLAUDE.md"), "UNRELATED ANCESTOR DOC");

    const files = await load(repo);

    assert.ok(
      files.some((f) => f.path === join(root, "CLAUDE.md")),
      "expected the ancestor doc to be picked up — if this ever stops being true, drop the Dockerfile note above",
    );
  });
});

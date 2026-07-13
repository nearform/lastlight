import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { fork, resolveForkTarget } from "#src/cli/fork-cli.js";

const WORKFLOW_YAML = `
kind: build
name: build
description: "test build"
phases:
  - name: phase_0
    type: context
  - name: architect
    prompt: prompts/architect.md
    skill: building
  - name: reviewer
    prompt: prompts/reviewer.md
    skills: [code-review, building]
    loop:
      max_cycles: 2
      on_request_changes:
        fix_prompt: prompts/fix.md
        re_review_prompt: prompts/re-reviewer.md
`;

function hasBuiltinsAt(dir: string): boolean {
  return existsSync(join(dir, "workflows")) && existsSync(join(dir, "skills"));
}

function makeCore(): string {
  const root = mkdtempSync(join(tmpdir(), "fork-cli-"));
  const core = join(root, "core");
  mkdirSync(join(core, "workflows", "prompts"), { recursive: true });
  mkdirSync(join(core, "skills", "building", "scripts"), { recursive: true });
  mkdirSync(join(core, "skills", "code-review"), { recursive: true });
  mkdirSync(join(core, "agent-context"), { recursive: true });

  writeFileSync(join(core, "workflows", "build.yaml"), WORKFLOW_YAML);
  for (const p of ["architect", "reviewer", "fix", "re-reviewer"]) {
    writeFileSync(join(core, "workflows", "prompts", `${p}.md`), `# ${p} (core)`);
  }
  writeFileSync(join(core, "workflows", "prompts", "classifier.md"), "# classifier base (core)");
  writeFileSync(join(core, "workflows", "prompts", "classify-adds-info.md"), "# adds-info (core)");
  writeFileSync(join(core, "skills", "building", "SKILL.md"), "# building (core)");
  writeFileSync(join(core, "skills", "building", "scripts", "run.sh"), "echo hi");
  writeFileSync(join(core, "skills", "code-review", "SKILL.md"), "# code-review (core)");
  writeFileSync(join(core, "agent-context", "soul.md"), "# soul (core)");
  writeFileSync(join(core, "agent-context", "rules.md"), "# rules (core)");
  return core;
}

describe("fork-cli", () => {
  let core: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    core = makeCore();
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    exitSpy = vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errSpy.mockRestore();
    exitSpy.mockRestore();
  });

  it("resolveForkTarget honours an explicit --home over cwd", () => {
    const t = resolveForkTarget({ home: core });
    expect(t.coreRoot).toBe(core);
    expect(t.instanceDir).toBe(join(core, "instance"));
  });

  it("falls back to the CLI-bundled assets when --home has no checkout", () => {
    // An overlay-only dir (no workflows/ + skills/) → coreRoot resolves to the
    // assets shipped with the CLI itself, not an error.
    const overlayOnly = mkdtempSync(join(tmpdir(), "fork-overlay-"));
    const t = resolveForkTarget({ home: overlayOnly });
    expect(t.instanceDir).toBe(join(overlayOnly, "instance"));
    expect(t.coreRoot).not.toBe(overlayOnly);
    // The bundled root really ships built-ins (this repo's own workflows/ + skills/).
    expect(existsSync(join(t.coreRoot, "workflows"))).toBe(true);
    expect(existsSync(join(t.coreRoot, "skills"))).toBe(true);
  });

  it("targets a contained instance/ from a workspace root (evals layout)", () => {
    // Mimic an evals workspace: <root>/instance (overlay) + <root>/evals.
    const ws = mkdtempSync(join(tmpdir(), "fork-evals-"));
    mkdirSync(join(ws, "instance", "secrets"), { recursive: true });
    mkdirSync(join(ws, "evals"), { recursive: true });
    const cwdSpy = vi.spyOn(process, "cwd").mockReturnValue(ws);
    try {
      const t = resolveForkTarget({});
      expect(t.instanceDir).toBe(join(ws, "instance"));
      expect(hasBuiltinsAt(t.coreRoot)).toBe(true); // bundled fallback
    } finally {
      cwdSpy.mockRestore();
    }
  });

  it("forks a workflow plus every referenced prompt and skill", async () => {
    await fork(["build"], { home: core });
    const inst = join(core, "instance");
    expect(existsSync(join(inst, "workflows", "build.yaml"))).toBe(true);
    for (const p of ["architect", "reviewer", "fix", "re-reviewer"]) {
      expect(existsSync(join(inst, "workflows", "prompts", `${p}.md`))).toBe(true);
    }
    expect(existsSync(join(inst, "skills", "building", "SKILL.md"))).toBe(true);
    // Whole skill directory travels, including scripts/.
    expect(existsSync(join(inst, "skills", "building", "scripts", "run.sh"))).toBe(true);
    expect(existsSync(join(inst, "skills", "code-review", "SKILL.md"))).toBe(true);
  });

  it("forks a real built-in via the bundled fallback when no checkout exists", async () => {
    // No core checkout anywhere — just an overlay dir. fork must read the
    // workflow shipped with the CLI (this repo's own workflows/build.yaml).
    const overlayOnly = mkdtempSync(join(tmpdir(), "fork-bundled-"));
    await fork(["build"], { home: overlayOnly });
    expect(existsSync(join(overlayOnly, "instance", "workflows", "build.yaml"))).toBe(true);
  });

  it("skips existing assets by default and overwrites with --force", async () => {
    const inst = join(core, "instance");
    mkdirSync(join(inst, "workflows"), { recursive: true });
    writeFileSync(join(inst, "workflows", "build.yaml"), "SENTINEL");

    await fork(["build"], { home: core });
    expect(readFileSync(join(inst, "workflows", "build.yaml"), "utf8")).toBe("SENTINEL");

    await fork(["build"], { home: core, force: true });
    expect(readFileSync(join(inst, "workflows", "build.yaml"), "utf8")).toContain("name: build");
  });

  it("forks everything via the `all` target", async () => {
    await fork(["all"], { home: core });
    const inst = join(core, "instance");
    // The one fixture workflow + its prompts/skills…
    expect(existsSync(join(inst, "workflows", "build.yaml"))).toBe(true);
    expect(existsSync(join(inst, "skills", "building", "SKILL.md"))).toBe(true);
    // …and every agent-context file.
    expect(existsSync(join(inst, "agent-context", "soul.md"))).toBe(true);
    expect(existsSync(join(inst, "agent-context", "rules.md"))).toBe(true);
    // …and the base classifier prompts.
    expect(existsSync(join(inst, "workflows", "prompts", "classifier.md"))).toBe(true);
    expect(existsSync(join(inst, "workflows", "prompts", "classify-adds-info.md"))).toBe(true);
  });

  it("forks the base classifier prompts via the `classifier` target", async () => {
    await fork(["classifier"], { home: core });
    const prompts = join(core, "instance", "workflows", "prompts");
    expect(readFileSync(join(prompts, "classifier.md"), "utf8")).toContain("classifier base");
    expect(existsSync(join(prompts, "classify-adds-info.md"))).toBe(true);
    // The classifier target must NOT drag in unrelated workflow assets.
    expect(existsSync(join(core, "instance", "workflows", "build.yaml"))).toBe(false);
  });

  it("forks all agent-context files via the explicit target", async () => {
    await fork(["agent-context"], { home: core });
    const ctx = join(core, "instance", "agent-context");
    expect(existsSync(join(ctx, "soul.md"))).toBe(true);
    expect(existsSync(join(ctx, "rules.md"))).toBe(true);
  });

  it("forks a single named agent-context file", async () => {
    await fork(["agent-context", "soul.md"], { home: core });
    const ctx = join(core, "instance", "agent-context");
    expect(existsSync(join(ctx, "soul.md"))).toBe(true);
    expect(existsSync(join(ctx, "rules.md"))).toBe(false);
  });

  it("does not infer agent-context from a bare filename", async () => {
    // `soul` is not a workflow and not the explicit agent-context target → error.
    await expect(fork(["soul"], { home: core })).rejects.toThrow(/process\.exit/);
    expect(existsSync(join(core, "instance", "agent-context", "soul.md"))).toBe(false);
  });

  it("errors on an unknown workflow target", async () => {
    await expect(fork(["nope"], { home: core })).rejects.toThrow(/process\.exit/);
    expect(errSpy).toHaveBeenCalled();
  });
});

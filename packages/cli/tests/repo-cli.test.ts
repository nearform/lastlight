import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { repoCommand } from "../src/repo-cli.js";

const WORKFLOW_YAML = `
kind: build
name: build
description: "test build"
phases:
  - name: architect
    prompt: prompts/architect.md
    skill: building
  - name: reviewer
    prompt: prompts/reviewer.md
    skills: [code-review]
`;

/** A minimal core checkout to fork the built-ins FROM. */
function makeCore(): string {
  const core = join(mkdtempSync(join(tmpdir(), "repo-cli-core-")), "core");
  mkdirSync(join(core, "workflows", "prompts"), { recursive: true });
  mkdirSync(join(core, "skills", "building", "scripts"), { recursive: true });
  mkdirSync(join(core, "skills", "code-review"), { recursive: true });
  mkdirSync(join(core, "agent-context"), { recursive: true });

  writeFileSync(join(core, "workflows", "build.yaml"), WORKFLOW_YAML);
  for (const p of ["architect", "reviewer"]) {
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

/** A user's own code repo (a `.git` marker is all `resolveRepoRoot` needs). */
function makeRepo(withGit = true): string {
  const repo = mkdtempSync(join(tmpdir(), "repo-cli-repo-"));
  if (withGit) mkdirSync(join(repo, ".git"));
  return repo;
}

/** Write a file under `<repo>/.lastlight/`. */
function layerFile(repo: string, rel: string, content: string): void {
  const abs = join(repo, ".lastlight", rel);
  mkdirSync(join(abs, ".."), { recursive: true });
  writeFileSync(abs, content);
}

describe("repo-cli", () => {
  let core: string;
  let repo: string;
  let logged: string[];
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    core = makeCore();
    repo = makeRepo();
    logged = [];
    logSpy = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
      logged.push(args.map(String).join(" "));
    });
  });

  afterEach(() => {
    logSpy.mockRestore();
  });

  const output = (): string => logged.join("\n");

  // ── repo fork ────────────────────────────────────────────────────────────

  it("forks a workflow's prompts + skills into .lastlight/ and NEVER its YAML", async () => {
    await repoCommand(["fork", "build"], { home: core, dir: repo });
    const layer = join(repo, ".lastlight");

    expect(existsSync(join(layer, "workflows", "prompts", "architect.md"))).toBe(true);
    expect(existsSync(join(layer, "workflows", "prompts", "reviewer.md"))).toBe(true);
    expect(existsSync(join(layer, "skills", "building", "SKILL.md"))).toBe(true);
    // Whole skill directory travels, including scripts/.
    expect(existsSync(join(layer, "skills", "building", "scripts", "run.sh"))).toBe(true);
    expect(existsSync(join(layer, "skills", "code-review", "SKILL.md"))).toBe(true);

    // The definition itself is the operator's — it must not be forkable here.
    expect(existsSync(join(layer, "workflows", "build.yaml"))).toBe(false);
    expect(output()).toContain("workflow YAML was NOT copied");
  });

  it("forks everything a repo may contribute via `all`, still without workflow YAML", async () => {
    await repoCommand(["fork", "all"], { home: core, dir: repo });
    const layer = join(repo, ".lastlight");

    expect(existsSync(join(layer, "workflows", "prompts", "architect.md"))).toBe(true);
    expect(existsSync(join(layer, "workflows", "prompts", "classifier.md"))).toBe(true);
    expect(existsSync(join(layer, "agent-context", "soul.md"))).toBe(true);
    expect(existsSync(join(layer, "workflows", "build.yaml"))).toBe(false);
  });

  it("warns that a forked agent-context file shares a built-in name and will be ignored", async () => {
    await repoCommand(["fork", "agent-context"], { home: core, dir: repo });
    expect(existsSync(join(repo, ".lastlight", "agent-context", "soul.md"))).toBe(true);
    expect(output()).toContain("ADDITIVE ONLY");
    expect(output()).toContain("soul.md");
  });

  it("skips existing files by default and overwrites with --force", async () => {
    layerFile(repo, "workflows/prompts/architect.md", "SENTINEL");
    const prompt = join(repo, ".lastlight", "workflows", "prompts", "architect.md");

    await repoCommand(["fork", "build"], { home: core, dir: repo });
    expect(readFileSync(prompt, "utf8")).toBe("SENTINEL");

    await repoCommand(["fork", "build"], { home: core, dir: repo, force: true });
    expect(readFileSync(prompt, "utf8")).toContain("architect (core)");
  });

  it("refuses to run outside a git repository", async () => {
    const notARepo = makeRepo(false);
    await expect(repoCommand(["fork", "build"], { home: core, dir: notARepo })).rejects.toThrow(/not a git repository/);
    expect(existsSync(join(notARepo, ".lastlight"))).toBe(false);
  });

  it("errors on an unknown fork target", async () => {
    await expect(repoCommand(["fork", "nope"], { home: core, dir: repo })).rejects.toThrow(/Unknown repo fork target/);
  });

  // ── repo config validate ─────────────────────────────────────────────────

  it("exits clean on a layer that is entirely within the default bounds", async () => {
    layerFile(repo, "lastlight.yml", "models:\n  triage: openai/gpt-5.5\n");
    layerFile(repo, "workflows/prompts/architect.md", "# repo architect");

    const code = await repoCommand(["config", "validate"], { dir: repo });
    expect(code).toBe(0);
    expect(output()).toContain("models.triage = \"openai/gpt-5.5\"");
    expect(output()).toContain("within the shipped default bounds");
  });

  it("reports a non-allow-listed key, an out-of-bounds model and a workflow YAML, and exits non-zero", async () => {
    layerFile(
      repo,
      "lastlight.yml",
      "managedRepos:\n  - evil/repo\nmodels:\n  triage: evilcorp/pwn-1\n  screener: openai/gpt-5.5\n",
    );
    layerFile(repo, "workflows/foo.yaml", "kind: cron\nname: foo\n");

    const code = await repoCommand(["config", "validate"], { dir: repo });
    expect(code).toBe(1);

    const text = output();
    expect(text).toContain("key not allowed");
    expect(text).toContain("managedRepos");
    expect(text).toContain("unknown provider");
    expect(text).toContain("models.triage");
    expect(text).toContain("workflow not allowed");
    expect(text).toContain("workflows/foo.yaml");
    // …and the legal leaf beside them still survives.
    expect(text).toContain("models.screener");
  });

  it("reports invalid YAML and drops the whole file", async () => {
    layerFile(repo, "lastlight.yml", "models: [unclosed");
    const code = await repoCommand(["config", "validate"], { dir: repo });
    expect(code).toBe(1);
    expect(output()).toContain("invalid YAML");
  });

  it("emits a machine-readable report with --json", async () => {
    layerFile(repo, "lastlight.yml", "models:\n  triage: openai/gpt-5.5\n");
    const code = await repoCommand(["config", "validate"], { dir: repo, json: true });
    expect(code).toBe(0);
    const report = JSON.parse(output());
    expect(report.applied).toEqual({ models: { triage: "openai/gpt-5.5" } });
    expect(report.accepted).toEqual(["lastlight.yml"]);
    expect(report.warnings).toEqual([]);
  });

  it("errors when the repo has no .lastlight/ at all", async () => {
    await expect(repoCommand(["config", "validate"], { dir: repo })).rejects.toThrow(/No \.lastlight\//);
  });

  // ── repo config show ─────────────────────────────────────────────────────

  it("renders the server's effective config and marks the repo-won leaves", async () => {
    const apiGet = vi.fn(async () => ({
      repo: "acme/widget",
      merged: { models: { default: "anthropic/claude-sonnet-4-6", triage: "openai/gpt-5.5" }, approval: {} },
      sources: { models: { default: "overlay", triage: "repo" } },
      warnings: [{ code: "key-not-allowed", path: "sandbox", message: "Ignored \"sandbox\"." }],
      assets: ["workflows/prompts/architect.md"],
      fetchedAt: "2026-07-31T00:00:00.000Z",
      treeSha: "abcdef1234567",
      defaultBranch: "main",
    }));

    await repoCommand(["config", "show", "acme/widget"], { dir: repo, apiGet });
    expect(apiGet).toHaveBeenCalledWith("/admin/api/repos/acme/widget/config");

    const text = output();
    expect(text).toContain("main@abcdef1");
    expect(text).toContain("(repo)");
    expect(text).toContain("workflows/prompts/architect.md");
    expect(text).toContain("key not allowed");
  });

  it("passes --refresh through to the server", async () => {
    const apiGet = vi.fn(async () => ({ repo: "acme/widget" }));
    await repoCommand(["config", "show", "acme/widget"], { dir: repo, apiGet, refresh: true });
    expect(apiGet).toHaveBeenCalledWith("/admin/api/repos/acme/widget/config?refresh=1");
  });

  it("rejects a malformed repo ref", async () => {
    await expect(repoCommand(["config", "show", "widget"], { dir: repo, apiGet: vi.fn() })).rejects.toThrow(
      /owner\/repo/,
    );
  });

  it("errors on an unknown subcommand", async () => {
    await expect(repoCommand(["nope"], { dir: repo })).rejects.toThrow(/Unknown "repo" subcommand/);
  });
});

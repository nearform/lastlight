import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setWorkflowDir, clearWorkflowCache, getWorkflow, getCronWorkflows, loadPromptTemplate, resolveSkillPaths, getWorkflowByIntent, validateAssets } from "#src/workflows/loader.js";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "loader-test-"));
}

describe("loader — agent workflow", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    setWorkflowDir(dir);
    clearWorkflowCache();
  });

  it("loads a valid agent workflow YAML", () => {
    writeFileSync(
      join(dir, "build.yaml"),
      `
kind: build
name: build
description: "Test workflow"
phases:
  - name: phase_0
    type: context
  - name: architect
    prompt: prompts/architect.md
    model: claude-opus-4-6
`.trim(),
    );

    const wf = getWorkflow("build");
    expect(wf.name).toBe("build");
    expect(wf.kind).toBe("build");
    expect(wf.phases).toHaveLength(2);
    expect(wf.phases[0].name).toBe("phase_0");
    expect(wf.phases[0].type).toBe("context");
    expect(wf.phases[1].name).toBe("architect");
  });

  it("throws when workflow file is missing", () => {
    expect(() => getWorkflow("nonexistent")).toThrow(/not found/i);
  });

  it("throws when YAML is malformed", () => {
    writeFileSync(join(dir, "broken.yaml"), "phases: [{{{{");
    expect(() => getWorkflow("broken")).toThrow();
  });

  it("throws when workflow fails schema validation", () => {
    writeFileSync(
      join(dir, "invalid.yaml"),
      `
kind: build
name: invalid
phases:
  - name: phase_0
    type: unknown_type
`.trim(),
    );
    expect(() => getWorkflow("invalid")).toThrow();
  });

  it("applies default kind=agent when omitted", () => {
    writeFileSync(
      join(dir, "noKind.yaml"),
      `
name: noKind
phases:
  - name: phase_0
    type: context
`.trim(),
    );
    const wf = getWorkflow("noKind");
    expect(wf.name).toBe("noKind");
    expect(wf.kind).toBe("agent");
  });

  it("supports phases with skill: instead of prompt:", () => {
    writeFileSync(
      join(dir, "triage.yaml"),
      `
kind: triage
name: triage
phases:
  - name: triage
    skill: issue-triage
`.trim(),
    );
    const wf = getWorkflow("triage");
    expect(wf.phases[0].skill).toBe("issue-triage");
    expect(wf.phases[0].prompt).toBeUndefined();
  });

  it("allows phases with both prompt and skill set (prompt wins as user prompt, skill staged)", () => {
    writeFileSync(
      join(dir, "both.yaml"),
      `
name: both
phases:
  - name: review
    prompt: prompts/reviewer.md
    skill: pr-review
`.trim(),
    );
    const wf = getWorkflow("both");
    expect(wf.phases[0].prompt).toBe("prompts/reviewer.md");
    expect(wf.phases[0].skill).toBe("pr-review");
  });

  it("supports phases with skills: [a, b] for multiple skills", () => {
    writeFileSync(
      join(dir, "multi.yaml"),
      `
kind: triage
name: multi
phases:
  - name: triage
    skills: [issue-triage, pr-review]
`.trim(),
    );
    const wf = getWorkflow("multi");
    expect(wf.phases[0].skills).toEqual(["issue-triage", "pr-review"]);
    expect(wf.phases[0].skill).toBeUndefined();
  });

  it("rejects phases with both skill and skills set", () => {
    writeFileSync(
      join(dir, "bad-both-skills.yaml"),
      `
name: bad-both-skills
phases:
  - name: x
    skill: issue-triage
    skills: [pr-review]
`.trim(),
    );
    expect(() => getWorkflow("bad-both-skills")).toThrow();
  });

  it("allows phases with both prompt and skills array", () => {
    writeFileSync(
      join(dir, "prompt-plus-skills.yaml"),
      `
name: prompt-plus-skills
phases:
  - name: x
    prompt: prompts/x.md
    skills: [issue-triage, pr-review]
`.trim(),
    );
    const wf = getWorkflow("prompt-plus-skills");
    expect(wf.phases[0].prompt).toBe("prompts/x.md");
    expect(wf.phases[0].skills).toEqual(["issue-triage", "pr-review"]);
  });

  it("caches the result on second call", () => {
    writeFileSync(
      join(dir, "cached.yaml"),
      `
name: cached
phases:
  - name: phase_0
    type: context
`.trim(),
    );
    const wf1 = getWorkflow("cached");
    const wf2 = getWorkflow("cached");
    expect(wf1).toBe(wf2); // same object reference → cached
  });
});

describe("loader — cron workflows", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    setWorkflowDir(dir);
    clearWorkflowCache();
  });

  it("loads cron workflow from cron-*.yaml files", () => {
    writeFileSync(
      join(dir, "cron-health.yaml"),
      `
kind: cron
name: weekly-health-report
schedule: "0 9 * * 1"
workflow: repo-health
context:
  mode: report
`.trim(),
    );

    const jobs = getCronWorkflows();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("weekly-health-report");
    expect(jobs[0].schedule).toBe("0 9 * * 1");
    expect(jobs[0].workflow).toBe("repo-health");
  });

  it("loads multiple cron workflows", () => {
    writeFileSync(
      join(dir, "cron-triage.yaml"),
      `
kind: cron
name: triage-new-issues
schedule: "*/15 * * * *"
workflow: issue-triage
context:
  mode: scan
condition:
  unless: webhooksEnabled
`.trim(),
    );
    writeFileSync(
      join(dir, "cron-health.yaml"),
      `
kind: cron
name: weekly-health-report
schedule: "0 9 * * 1"
workflow: repo-health
context:
  mode: report
`.trim(),
    );

    const jobs = getCronWorkflows();
    expect(jobs).toHaveLength(2);
  });

  it("returns empty array when no cron files exist", () => {
    writeFileSync(
      join(dir, "build.yaml"),
      `
name: build
phases:
  - name: phase_0
    type: context
`.trim(),
    );
    const jobs = getCronWorkflows();
    expect(jobs).toHaveLength(0);
  });

  it("throws on invalid cron YAML during fail-fast validation", () => {
    writeFileSync(
      join(dir, "cron-bad.yaml"),
      `
kind: cron
name: bad
`.trim(),
    ); // missing required fields
    expect(() => getCronWorkflows()).toThrow(/Invalid cron workflow/);
  });
});

describe("loader — prompt templates", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    setWorkflowDir(dir);
    clearWorkflowCache();
  });

  it("loads a prompt template file", () => {
    mkdirSync(join(dir, "prompts"));
    writeFileSync(join(dir, "prompts", "architect.md"), "You are the ARCHITECT.");

    const content = loadPromptTemplate("prompts/architect.md");
    expect(content).toBe("You are the ARCHITECT.");
  });

  it("throws when prompt template file is missing", () => {
    expect(() => loadPromptTemplate("prompts/nonexistent.md")).toThrow(/not found/i);
  });
});

describe("loader — missing workflow directory", () => {
  beforeEach(() => {
    setWorkflowDir("/tmp/does-not-exist-xyz-abc");
    clearWorkflowCache();
  });

  it("returns empty cron list when directory is missing", () => {
    const jobs = getCronWorkflows();
    expect(jobs).toHaveLength(0);
  });
});

describe("loader — security workflow YAML files", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    setWorkflowDir(dir);
    clearWorkflowCache();
  });

  it("parses security-review.yaml without errors", () => {
    writeFileSync(
      join(dir, "security-review.yaml"),
      `kind: health
name: security-review
description: "Scan repo for security issues."
phases:
  - name: scan
    label: Security scan
    skill: security-review
    model: "{{models.security}}"
`.trim(),
    );
    const wf = getWorkflow("security-review");
    expect(wf.name).toBe("security-review");
    expect(wf.kind).toBe("health");
    expect(wf.phases).toHaveLength(1);
    expect(wf.phases[0].name).toBe("scan");
  });

  it("parses security-feedback.yaml without errors", () => {
    writeFileSync(
      join(dir, "security-feedback.yaml"),
      `kind: health
name: security-feedback
description: "Process maintainer feedback on security issues."
phases:
  - name: feedback
    label: Security feedback
    skill: security-feedback
    model: "{{models.security}}"
`.trim(),
    );
    const wf = getWorkflow("security-feedback");
    expect(wf.name).toBe("security-feedback");
    expect(wf.kind).toBe("health");
    expect(wf.phases).toHaveLength(1);
    expect(wf.phases[0].name).toBe("feedback");
  });

  it("parses cron-security.yaml without errors", () => {
    writeFileSync(
      join(dir, "cron-security.yaml"),
      `kind: cron
name: weekly-security-scan
schedule: "0 10 * * 1"
workflow: security-review
context:
  mode: scan
  deliverSlackSummary: true
`.trim(),
    );
    const jobs = getCronWorkflows();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].name).toBe("weekly-security-scan");
    expect(jobs[0].schedule).toBe("0 10 * * 1");
    expect(jobs[0].workflow).toBe("security-review");
  });
});

describe("loader — bash / script phase types", () => {
  let dir: string;

  beforeEach(() => {
    dir = makeTempDir();
    setWorkflowDir(dir);
    clearWorkflowCache();
  });

  it("loads a bash phase with a command", () => {
    writeFileSync(
      join(dir, "b.yaml"),
      `
kind: agent
name: b
phases:
  - name: run
    type: bash
    command: "echo hi"
    output_var: out
    timeout_seconds: 30
`.trim(),
    );
    const wf = getWorkflow("b");
    expect(wf.phases[0].type).toBe("bash");
    expect(wf.phases[0].command).toBe("echo hi");
    expect(wf.phases[0].timeout_seconds).toBe(30);
  });

  it("loads a script phase with runtime", () => {
    writeFileSync(
      join(dir, "s.yaml"),
      `
kind: agent
name: s
phases:
  - name: run
    type: script
    runtime: python
    script: "print('hi')"
`.trim(),
    );
    const wf = getWorkflow("s");
    expect(wf.phases[0].type).toBe("script");
    expect(wf.phases[0].runtime).toBe("python");
    expect(wf.phases[0].script).toBe("print('hi')");
  });

  it("rejects a bash phase with no command", () => {
    writeFileSync(
      join(dir, "nocmd.yaml"),
      `
kind: agent
name: nocmd
phases:
  - name: run
    type: bash
`.trim(),
    );
    expect(() => getWorkflow("nocmd")).toThrow(/requires .command/);
  });

  it("rejects a script phase with no script", () => {
    writeFileSync(
      join(dir, "noscript.yaml"),
      `
kind: agent
name: noscript
phases:
  - name: run
    type: script
`.trim(),
    );
    expect(() => getWorkflow("noscript")).toThrow(/requires .script/);
  });

  it("rejects command on a non-bash phase", () => {
    writeFileSync(
      join(dir, "mix.yaml"),
      `
kind: agent
name: mix
phases:
  - name: run
    type: agent
    prompt: prompts/x.md
    command: "echo nope"
`.trim(),
    );
    expect(() => getWorkflow("mix")).toThrow(/command.* only valid on type .bash/);
  });

  it("rejects script field on a bash phase", () => {
    writeFileSync(
      join(dir, "mix2.yaml"),
      `
kind: agent
name: mix2
phases:
  - name: run
    type: bash
    command: "echo ok"
    script: "print('no')"
`.trim(),
    );
    expect(() => getWorkflow("mix2")).toThrow(/script.* only valid on type .script/);
  });
});

describe("loader — resolveSkillPaths", () => {
  it("resolves known skill names to absolute directory paths", () => {
    const paths = resolveSkillPaths(["issue-triage", "pr-review"]);
    expect(paths).toHaveLength(2);
    expect(paths[0]).toMatch(/skills\/issue-triage$/);
    expect(paths[1]).toMatch(/skills\/pr-review$/);
  });

  it("throws on unknown skill name", () => {
    expect(() => resolveSkillPaths(["this-skill-does-not-exist"])).toThrow(/Skill not found/);
  });

  it("throws on path-traversal in skill name", () => {
    expect(() => resolveSkillPaths(["#src/etc/passwd"])).toThrow(/Invalid skill name/);
  });
});

describe("loader — classifier classification blocks (issue #164)", () => {
  let dir: string;

  function writeClassifierTemplate(): void {
    mkdirSync(join(dir, "prompts"), { recursive: true });
    writeFileSync(join(dir, "prompts", "classifier.md"), "{{categories}}\n{{examples}}\n{{intentTokens}}");
  }

  function writeWorkflow(name: string, intent: string): void {
    writeFileSync(
      join(dir, `${name}.yaml`),
      `
kind: agent
name: ${name}
classification:
  intent: ${intent}
  description: "${intent.toUpperCase()} — do a ${intent}"
phases:
  - name: phase_0
    type: context
`.trim(),
    );
  }

  beforeEach(() => {
    dir = makeTempDir();
    setWorkflowDir(dir);
    clearWorkflowCache();
    writeClassifierTemplate();
  });

  it("getWorkflowByIntent returns the owning workflow", () => {
    writeWorkflow("incident-flow", "incident");
    expect(getWorkflowByIntent("incident")?.name).toBe("incident-flow");
    expect(getWorkflowByIntent("nope")).toBeUndefined();
  });

  it("validateAssets passes for a single classification owner", () => {
    writeWorkflow("incident-flow", "incident");
    expect(() => validateAssets()).not.toThrow();
  });

  it("validateAssets rejects two workflows claiming the same intent", () => {
    writeWorkflow("incident-a", "incident");
    writeWorkflow("incident-b", "incident");
    expect(() => validateAssets()).toThrow(/both claim classifier intent "incident"/);
  });

  it("validateAssets rejects a workflow claiming a reserved control intent", () => {
    writeWorkflow("chatty", "chat");
    expect(() => validateAssets()).toThrow(/reserved control intent/);
  });

  it("validateAssets rejects a missing base classifier template", () => {
    // Remove the template written by beforeEach by pointing at a fresh dir.
    dir = makeTempDir();
    setWorkflowDir(dir);
    clearWorkflowCache();
    writeWorkflow("incident-flow", "incident");
    expect(() => validateAssets()).toThrow(/classifier\.md/);
  });
});

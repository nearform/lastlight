import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { setWorkflowDir, clearWorkflowCache, getWorkflow, getCronWorkflows, loadPromptTemplate, resolveSkillPaths } from "./loader.js";

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
    expect(() => resolveSkillPaths(["../etc/passwd"])).toThrow(/Invalid skill name/);
  });
});

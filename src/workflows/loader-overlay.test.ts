import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  clearWorkflowCache,
  configureWorkflowAssets,
  getWorkflow,
  listAgentWorkflows,
  loadAgentContext,
  loadPromptTemplate,
  loadSkillRaw,
  validateAssets,
} from "./loader.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lastlight-loader-test-"));
}

const wf = (name: string) => `name: ${name}\nphases:\n  - name: p\n    type: context\n`;

describe("workflow asset overlay", () => {
  let builtIn: string;
  let overlay: string;

  beforeEach(() => {
    builtIn = tmp();
    overlay = tmp();
    configureWorkflowAssets({ builtInRoot: builtIn, overlayRoot: overlay });
    clearWorkflowCache();
  });

  afterEach(() => {
    configureWorkflowAssets();
    clearWorkflowCache();
  });

  it("overlay workflow replaces built-in by logical name and raw-dependent list sees winner", () => {
    mkdirSync(join(builtIn, "workflows"), { recursive: true });
    mkdirSync(join(overlay, "workflows"), { recursive: true });
    writeFileSync(join(builtIn, "workflows", "base.yaml"), wf("dispatch"));
    writeFileSync(join(overlay, "workflows", "different-file.yaml"), `name: dispatch\ndescription: overlay\nphases:\n  - name: p\n    type: context\n`);
    expect(getWorkflow("dispatch").description).toBe("overlay");
    expect(listAgentWorkflows().map((w) => w.name)).toEqual(["dispatch"]);
  });

  it("resolves prompts and skills from overlay before built-in", () => {
    mkdirSync(join(builtIn, "workflows", "prompts"), { recursive: true });
    mkdirSync(join(overlay, "workflows", "prompts"), { recursive: true });
    writeFileSync(join(builtIn, "workflows", "prompts", "x.md"), "built-in prompt");
    writeFileSync(join(overlay, "workflows", "prompts", "x.md"), "overlay prompt");
    mkdirSync(join(builtIn, "skills", "demo"), { recursive: true });
    mkdirSync(join(overlay, "skills", "demo"), { recursive: true });
    writeFileSync(join(builtIn, "skills", "demo", "SKILL.md"), "built-in skill");
    writeFileSync(join(overlay, "skills", "demo", "SKILL.md"), "overlay skill");
    expect(loadPromptTemplate("prompts/x.md")).toBe("overlay prompt");
    expect(loadSkillRaw("demo")).toBe("overlay skill");
  });

  it("applies disables and merges agent context by filename", () => {
    mkdirSync(join(builtIn, "agent-context"));
    mkdirSync(join(overlay, "agent-context"));
    mkdirSync(join(builtIn, "workflows"), { recursive: true });
    writeFileSync(join(builtIn, "workflows", "a.yaml"), wf("a"));
    writeFileSync(join(builtIn, "workflows", "b.yaml"), wf("b"));
    writeFileSync(join(builtIn, "agent-context", "rules.md"), "built-in rules");
    writeFileSync(join(overlay, "agent-context", "rules.md"), "overlay rules");
    writeFileSync(join(overlay, "agent-context", "extra.md"), "extra");
    configureWorkflowAssets({ builtInRoot: builtIn, overlayRoot: overlay, disabled: { workflows: ["b"], agentContext: ["extra.md"] } });
    expect(() => getWorkflow("b")).toThrow(/disabled/i);
    expect(loadAgentContext()).toBe("overlay rules");
  });

  it("fails on duplicate workflow names within one layer", () => {
    mkdirSync(join(builtIn, "workflows"), { recursive: true });
    writeFileSync(join(builtIn, "workflows", "a.yaml"), wf("same"));
    writeFileSync(join(builtIn, "workflows", "b.yaml"), wf("same"));
    expect(() => listAgentWorkflows()).toThrow(/duplicate workflow/i);
  });

  it("fails fast when a route targets a missing workflow", () => {
    mkdirSync(join(builtIn, "workflows"), { recursive: true });
    writeFileSync(join(builtIn, "workflows", "triage.yaml"), wf("issue-triage"));
    expect(() => validateAssets({ github: { issue_opened: "missing-workflow" }, slack: {} })).toThrow(/missing workflow/i);
  });

  it("fails fast when a route targets a disabled workflow", () => {
    mkdirSync(join(builtIn, "workflows"), { recursive: true });
    writeFileSync(join(builtIn, "workflows", "triage.yaml"), wf("issue-triage"));
    configureWorkflowAssets({ builtInRoot: builtIn, overlayRoot: overlay, disabled: { workflows: ["issue-triage"] } });
    expect(() => validateAssets({ github: { issue_opened: "issue-triage" }, slack: {} })).toThrow(/disabled workflow/i);
  });

  it("allows configured internal route handlers", () => {
    mkdirSync(join(builtIn, "workflows"), { recursive: true });
    expect(() => validateAssets({ github: { issue_build: "github-orchestrator" }, slack: { chat: "chat" } })).not.toThrow();
  });

  it("fails fast when a cron targets a missing workflow", () => {
    mkdirSync(join(builtIn, "workflows"), { recursive: true });
    writeFileSync(
      join(builtIn, "workflows", "nightly.yaml"),
      `kind: cron\nname: nightly\nschedule: "0 0 * * *"\nworkflow: does-not-exist\n`,
    );
    expect(() => validateAssets()).toThrow(/Cron "nightly" targets missing or disabled workflow/i);
  });

  it("fails fast when a workflow phase references a missing prompt", () => {
    mkdirSync(join(builtIn, "workflows"), { recursive: true });
    writeFileSync(
      join(builtIn, "workflows", "build.yaml"),
      `name: build\nphases:\n  - name: architect\n    prompt: prompts/missing.md\n`,
    );
    expect(() => validateAssets()).toThrow(/phase "architect" prompt "prompts\/missing.md"/i);
  });

  it("fails fast when a workflow phase references a missing skill", () => {
    mkdirSync(join(builtIn, "workflows"), { recursive: true });
    writeFileSync(
      join(builtIn, "workflows", "review.yaml"),
      `name: review\nphases:\n  - name: review\n    skill: ghost-skill\n`,
    );
    expect(() => validateAssets()).toThrow(/phase "review" skills:.*ghost-skill/i);
  });

  it("passes when phase prompt and skill resolve (incl. from the overlay)", () => {
    mkdirSync(join(builtIn, "workflows", "prompts"), { recursive: true });
    mkdirSync(join(overlay, "skills", "review-skill"), { recursive: true });
    writeFileSync(join(builtIn, "workflows", "prompts", "architect.md"), "prompt body");
    writeFileSync(join(overlay, "skills", "review-skill", "SKILL.md"), "skill body");
    writeFileSync(
      join(builtIn, "workflows", "build.yaml"),
      `name: build\nphases:\n  - name: architect\n    prompt: prompts/architect.md\n    skill: review-skill\n`,
    );
    expect(() => validateAssets()).not.toThrow();
  });
});

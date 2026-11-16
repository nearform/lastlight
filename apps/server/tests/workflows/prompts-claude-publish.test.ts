import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { renderTemplate, type TemplateContext } from "lastlight-workflow-engine";
import { claudeCodePromptContext } from "#src/engine/claude-code/model-ref.js";

const PROMPTS = join(import.meta.dirname, "..", "..", "workflows", "prompts");
const CTX = { owner: "acme", repo: "widget", issueNumber: 7, issueDir: ".lastlight/issue-7", branch: "lastlight/7-x" } as TemplateContext;

describe.each(["architect.md", "reviewer.md", "re-reviewer.md"])("%s — who publishes the notes", (file) => {
  const template = readFileSync(join(PROMPTS, file), "utf8");
  const render = (extra: Partial<TemplateContext>) => renderTemplate(template, { ...CTX, ...extra } as TemplateContext);

  it("an agentic-pi phase in repo mode publishes them itself, as before", () => {
    expect(render({ externalizeArtifacts: false })).toContain("github_publish");
  });

  it("a Claude Code phase in repo mode leaves it to Last Light and names no GitHub tool", () => {
    const out = render({ externalizeArtifacts: false, ...claudeCodePromptContext("claude-code/claude-opus-5-5", "repo") });
    expect(out).not.toMatch(/\bgithub_[a-z]/);
    expect(out).toContain("Last Light publishes it to the branch after this phase");
  });

  it("a Claude Code phase in server mode gets the server-mode text", () => {
    const out = render({ externalizeArtifacts: true, ...claudeCodePromptContext("claude-code/claude-opus-5-5", "server") });
    expect(out).not.toMatch(/\bgithub_[a-z]/);
    expect(out).toContain("the harness persists it to the Last Light server automatically");
    expect(out).not.toContain("Last Light publishes it to the branch");
  });
});

describe("claudeCodePromptContext", () => {
  it("adds nothing for other models", () => {
    expect(claudeCodePromptContext("deepseek/deepseek-v4", "repo")).toEqual({});
    expect(claudeCodePromptContext(undefined, "repo")).toEqual({});
  });
});

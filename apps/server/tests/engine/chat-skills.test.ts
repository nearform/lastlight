import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configureWorkflowAssets } from "#src/workflows/loader.js";
import { loadChatSkillCatalogue } from "#src/engine/chat/chat-skills.js";

describe("chat skill catalogue — chat skill description", () => {
  // The catalogue is built at boot from skills/*/SKILL.md frontmatter and
  // surfaced to the chat agent as a system-prompt XML block. The chat
  // skill's description must not advertise leading-slash commands (Slack
  // intercepts them before they reach Last Light).
  const { skills } = loadChatSkillCatalogue();
  const chat = skills.find((s) => s.name === "chat");

  it("includes the chat skill", () => {
    expect(chat).toBeDefined();
  });

  it("does not advertise leading-slash command tokens", () => {
    expect(chat?.description ?? "").not.toMatch(
      /\/(build|triage|review|security|health|status)\b/,
    );
  });

  it("mentions natural-language triggers", () => {
    expect(chat?.description ?? "").toMatch(/natural-language|natural language/i);
  });
});

/**
 * Which skills chat sees is DECLARED BY THE SKILLS (`chat: true` frontmatter),
 * not a hardcoded name list. The old `CHAT_SKILL_NAMES` constant had two
 * failure modes: an overlay could not expose a skill to chat at all, and it
 * resolved against `resolve("skills")` — the process cwd — so it bypassed the
 * asset layer stack and never saw an overlay's version of a built-in skill.
 */
describe("chat skill catalogue — selection", () => {
  afterEach(() => configureWorkflowAssets());

  function skillDir(root: string, name: string, frontmatter: string[]): void {
    mkdirSync(join(root, "skills", name), { recursive: true });
    writeFileSync(
      join(root, "skills", name, "SKILL.md"),
      ["---", `name: ${name}`, "description: Does a thing.", ...frontmatter, "---", "", "# Body"].join("\n"),
    );
  }

  it("selects exactly the skills that opt in", () => {
    const root = mkdtempSync(join(tmpdir(), "chat-skills-"));
    skillDir(root, "in", ["chat: true"]);
    skillDir(root, "out", []);
    skillDir(root, "explicit-out", ["chat: false"]);
    configureWorkflowAssets({ builtInRoot: root });

    expect(loadChatSkillCatalogue().skills.map((s) => s.name)).toEqual(["in"]);
  });

  it("lets an OVERLAY skill opt in, and an overlay override win", () => {
    const builtIn = mkdtempSync(join(tmpdir(), "chat-skills-b-"));
    const overlay = mkdtempSync(join(tmpdir(), "chat-skills-o-"));
    skillDir(builtIn, "shared", ["chat: true"]);
    // Same name, overlay layer — its description must be the one chat sees.
    mkdirSync(join(overlay, "skills", "shared"), { recursive: true });
    writeFileSync(
      join(overlay, "skills", "shared", "SKILL.md"),
      ["---", "name: shared", "description: Overlay version.", "chat: true", "---"].join("\n"),
    );
    skillDir(overlay, "overlay-only", ["chat: true"]);
    configureWorkflowAssets({ builtInRoot: builtIn, overlayRoot: overlay });

    const { skills } = loadChatSkillCatalogue();
    expect(skills.map((s) => s.name).sort()).toEqual(["overlay-only", "shared"]);
    expect(skills.find((s) => s.name === "shared")?.description).toBe("Overlay version.");
  });

  it("honours disabled.skills", () => {
    const root = mkdtempSync(join(tmpdir(), "chat-skills-d-"));
    skillDir(root, "kept", ["chat: true"]);
    skillDir(root, "dropped", ["chat: true"]);
    configureWorkflowAssets({ builtInRoot: root, disabled: { skills: ["dropped"] } });

    expect(loadChatSkillCatalogue().skills.map((s) => s.name)).toEqual(["kept"]);
  });

  it("still exposes the four packaged chat skills", () => {
    configureWorkflowAssets();
    expect(loadChatSkillCatalogue().skills.map((s) => s.name).sort()).toEqual([
      "chat",
      "issue-triage",
      "pr-review",
      "repo-health",
    ]);
  });
});

import { describe, it, expect } from "vitest";
import { loadChatSkillCatalogue } from "./chat-skills.js";

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

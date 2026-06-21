import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { CHAT_SYSTEM_SUFFIX } from "./chat.js";

describe("CHAT_SYSTEM_SUFFIX", () => {
  it("does not advertise leading-slash command tokens", () => {
    // Slack intercepts any message starting with `/` before it reaches
    // Last Light, so the prompt must never suggest slash commands. The
    // regex catches a backtick-or-start-of-line-anchored `/word` command
    // token (the shape the old prompt used), scoped to the exact command
    // words so prose like `/proc` or `agent-context/security.md` does
    // not trip it.
    expect(CHAT_SYSTEM_SUFFIX).not.toMatch(
      /(^|`)\/(build|triage|review|security|health|status)\b/,
    );
  });

  it("advertises the natural-language triggers", () => {
    expect(CHAT_SYSTEM_SUFFIX).toContain("build owner/repo#N");
    expect(CHAT_SYSTEM_SUFFIX).toContain("triage owner/repo");
    expect(CHAT_SYSTEM_SUFFIX).toContain("review PRs on owner/repo");
    expect(CHAT_SYSTEM_SUFFIX).toContain("security review owner/repo");
    expect(CHAT_SYSTEM_SUFFIX).toContain("status");
  });

  it("includes the never-suggest-leading-slash rule", () => {
    expect(CHAT_SYSTEM_SUFFIX).toMatch(/never suggest.*leading/i);
  });

  it("does not advertise health as an interactive trigger", () => {
    // `health` runs via cron/CLI only — it must not be listed among the
    // interactive natural-language triggers.
    const triggersBlock = CHAT_SYSTEM_SUFFIX.match(
      /Natural-language triggers you can suggest:[\s\S]*?(?=\n\n|\n[A-Z]|\n`|$)/,
    );
    expect(triggersBlock).not.toBeNull();
    expect(triggersBlock![0]).not.toMatch(/\bhealth\b/i);
  });
});

describe("skills/chat/SKILL.md frontmatter", () => {
  // The chat skill description is surfaced to the agent at boot via
  // the chat skill catalogue, so it must be slash-free too.
  const md = readFileSync(resolve("skills/chat/SKILL.md"), "utf-8");
  const frontmatter = md.match(/^---\n([\s\S]*?)\n---/)?.[1] ?? "";

  it("does not advertise leading-slash command tokens", () => {
    expect(frontmatter).not.toMatch(
      /\/(build|triage|review|security|health|status)\b/,
    );
  });
});

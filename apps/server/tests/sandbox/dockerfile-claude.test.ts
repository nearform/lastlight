import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(import.meta.dirname, "..", "..");

describe.each(["sandbox.Dockerfile", "sandbox-qa.Dockerfile"])("%s — Claude Code CLI", (file) => {
  const text = readFileSync(join(ROOT, file), "utf8");

  it("pins an exact Claude Code version", () => {
    expect(text).toMatch(/^ARG CLAUDE_CODE_VERSION=\d+\.\d+\.\d+$/m);
  });

  it("installs the published package at that version, and tmux", () => {
    expect(text).toContain("npm i -g @anthropic-ai/claude-code@${CLAUDE_CODE_VERSION}");
    expect(text).toMatch(/apt-get install[^\n]*\btmux\b/);
  });
});

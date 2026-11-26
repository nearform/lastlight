import { describe, it, expect } from "vitest";
import {
  CLAUDE_CODE_PREFIX,
  claudeCodeConfigured,
  claudeCodeModelId,
  isClaudeCodeModel,
  parseClaudeCodeConfig,
} from "#src/engine/claude-code/model-ref.js";

describe("claude-code model references", () => {
  it("selects the runtime by prefix only", () => {
    expect(CLAUDE_CODE_PREFIX).toBe("claude-code/");
    expect(isClaudeCodeModel("claude-code/claude-opus-5-5")).toBe(true);
    expect(isClaudeCodeModel("anthropic/claude-opus-5-5")).toBe(false);
    expect(isClaudeCodeModel(undefined)).toBe(false);
  });

  it("strips the prefix and refuses an empty id", () => {
    expect(claudeCodeModelId("claude-code/claude-opus-5-5")).toBe("claude-opus-5-5");
    expect(() => claudeCodeModelId("claude-code/")).toThrow(/model id/);
  });

  it("knows whether any role uses the runtime", () => {
    expect(claudeCodeConfigured({ architect: "claude-code/x" })).toBe(true);
    expect(claudeCodeConfigured({ architect: "deepseek/x", default: undefined })).toBe(false);
  });

  it("defaults the session settings", () => {
    expect(parseClaudeCodeConfig(undefined)).toEqual({
      tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN",
      readyTimeoutSeconds: 60,
      stallMinutes: 15,
      pollSeconds: 2,
    });
  });

  it("refuses a zero or malformed value, naming the key", () => {
    expect(() => parseClaudeCodeConfig({ stallMinutes: 0 })).toThrow(/claudeCode\.stallMinutes/);
    expect(() => parseClaudeCodeConfig({ tokenEnv: "" })).toThrow(/claudeCode\.tokenEnv/);
    expect(() => parseClaudeCodeConfig({ pollSeconds: "2" })).toThrow(/claudeCode\.pollSeconds/);
  });
});

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, resetRuntimeConfigForTests } from "#src/config/config.js";

vi.mock("#src/logging/logger.js", () => {
  const noopLogger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), fatal: vi.fn(), child: () => noopLogger };
  return { logger: () => noopLogger };
});

function overlayWith(block: string): string {
  const dir = mkdtempSync(join(tmpdir(), "claude-code-boot-"));
  writeFileSync(join(dir, "config.yaml"), block);
  return dir;
}

describe("loadConfig — the claudeCode block", () => {
  beforeEach(() => {
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) vi.stubEnv(k, "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it("ships with no role on claude-code and the default session settings", () => {
    const cfg = loadConfig();
    expect(Object.values(cfg.models).some((m) => typeof m === "string" && m.startsWith("claude-code/"))).toBe(false);
    expect(cfg.claudeCode).toEqual({ tokenEnv: "CLAUDE_CODE_OAUTH_TOKEN", readyTimeoutSeconds: 60, stallMinutes: 15, pollSeconds: 2 });
  });

  it("takes the operator's overrides", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("claudeCode:\n  stallMinutes: 30\n  tokenEnv: MY_CLAUDE_TOKEN\n"));
    expect(loadConfig().claudeCode).toMatchObject({ stallMinutes: 30, tokenEnv: "MY_CLAUDE_TOKEN", pollSeconds: 2 });
  });

  it("stops the boot on stallMinutes: 0", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("claudeCode:\n  stallMinutes: 0\n"));
    expect(() => loadConfig()).toThrow(/claudeCode\.stallMinutes/);
  });
});

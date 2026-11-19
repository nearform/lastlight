import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, resetRuntimeConfigForTests } from "#src/config/config.js";

vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

function overlayWith(block: string): string {
  const dir = mkdtempSync(join(tmpdir(), "repo-approval-"));
  writeFileSync(join(dir, "config.yaml"), block);
  return dir;
}

describe("loadConfig — requireRepoApproval", () => {
  beforeEach(() => {
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) {
      vi.stubEnv(k, "");
    }
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it("defaults to false", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("botName: test\n"));
    expect(loadConfig().requireRepoApproval).toBe(false);
  });

  it("parses true", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("requireRepoApproval: true\n"));
    expect(loadConfig().requireRepoApproval).toBe(true);
  });

  it("throws on a non-boolean, naming the key", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith('requireRepoApproval: "yes"\n'));
    expect(() => loadConfig()).toThrow(/requireRepoApproval/);
  });
});

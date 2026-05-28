import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, getPublicConfig, resetRuntimeConfigForTests } from "./config.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lastlight-config-test-"));
}

describe("loadConfig overlay", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("LASTLIGHT_MODEL", "");
    vi.stubEnv("LASTLIGHT_MODELS", "");
    vi.stubEnv("OPENCODE_MODEL", "");
    vi.stubEnv("OPENCODE_MODELS", "");
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it("loads managed repos, routes, and public defaults from config/default.yaml", () => {
    const cfg = loadConfig();
    expect(cfg.managedRepos).toContain("cliftonc/lastlight");
    expect(cfg.routes.github.issue_opened).toBe("issue-triage");
    expect(getPublicConfig().merged).not.toHaveProperty("githubApp");
  });

  it("merges overlay config and lets env override model", () => {
    const overlay = tmp();
    writeFileSync(join(overlay, "config.yaml"), `managedRepos:\n  - acme/repo\nroutes:\n  github:\n    issue_opened: custom-triage\nmodels:\n  architect: openai/custom\n`);
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay);
    vi.stubEnv("LASTLIGHT_MODEL", "openai/env-default");
    const cfg = loadConfig();
    expect(cfg.overlayDir).toBe(overlay);
    expect(cfg.managedRepos).toEqual(["acme/repo"]);
    expect(cfg.routes.github.issue_opened).toBe("custom-triage");
    expect(cfg.models.default).toBe("openai/env-default");
    expect(cfg.models.architect).toBe("openai/custom");
  });

  it("throws when LASTLIGHT_OVERLAY_DIR is missing", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", join(tmp(), "missing"));
    expect(() => loadConfig()).toThrow(/overlay directory/i);
  });
});

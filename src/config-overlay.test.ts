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
    // Public default ships with no managed repos — the real list comes from the overlay.
    expect(cfg.managedRepos).toEqual([]);
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

  it("fast-exits when LASTLIGHT_OVERLAY_DIR points at an empty (unpopulated) overlay", () => {
    const overlay = tmp(); // exists but empty — the docker bind-mount footgun
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay);
    expect(() => loadConfig()).toThrow(/overlay is empty/i);
  });

  it("accepts a secrets-only overlay (no config.yaml) without erroring", () => {
    const overlay = tmp();
    mkdirSync(join(overlay, "secrets"));
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay);
    expect(() => loadConfig()).not.toThrow();
  });

  it("redacts secret-looking keys an operator mistakenly put in config.yaml", () => {
    const overlay = tmp();
    writeFileSync(
      join(overlay, "config.yaml"),
      `managedRepos:\n  - acme/repo\nadminSecret: super-secret-value\nanthropicApiKey: sk-ant-leaked\nnested:\n  authToken: tok-leaked\n`,
    );
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay);
    const cfg = loadConfig();
    const bundle = cfg.publicConfig;

    // None of the secret values should survive anywhere in the public bundle.
    const serialized = JSON.stringify(bundle);
    expect(serialized).not.toContain("super-secret-value");
    expect(serialized).not.toContain("sk-ant-leaked");
    expect(serialized).not.toContain("tok-leaked");

    // Keys remain (so the mistake is visible) but values are masked.
    expect((bundle.overlay as Record<string, unknown>).adminSecret).toBe("[redacted]");
    expect((bundle.merged as Record<string, unknown>).anthropicApiKey).toBe("[redacted]");
    expect((bundle.merged.nested as Record<string, unknown>).authToken).toBe("[redacted]");

    // Non-secret config is untouched.
    expect(bundle.merged.managedRepos).toEqual(["acme/repo"]);
  });
});

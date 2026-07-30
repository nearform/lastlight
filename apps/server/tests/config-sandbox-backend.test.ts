import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, resetRuntimeConfigForTests } from "#src/config/config.js";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "lastlight-config-test-"));
}

describe("sandbox.backend: kubernetes", () => {
  beforeEach(() => {
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("SLACK_BOT_TOKEN", "");
    vi.stubEnv("LASTLIGHT_MODEL", "");
    vi.stubEnv("LASTLIGHT_MODELS", "");
    vi.stubEnv("OPENCODE_MODEL", "");
    vi.stubEnv("OPENCODE_MODELS", "");
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", "");
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it("validates 'kubernetes' as a backend via the overlay config file", () => {
    const overlay = tmp();
    writeFileSync(join(overlay, "config.yaml"), `sandbox:\n  backend: kubernetes\n`);
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay);
    const cfg = loadConfig();
    expect(cfg.sandbox).toBe("kubernetes");
  });
});

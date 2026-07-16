import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  scaffoldOverlayFiles,
  OVERLAY_GITIGNORE,
  OVERLAY_ENV_EXAMPLE,
  OVERLAY_CONFIG_PLACEHOLDER,
} from "@lastlight/shared/overlay-bootstrap";

describe("scaffoldOverlayFiles", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "overlay-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("creates the default overlay files in a fresh dir", () => {
    const { created } = scaffoldOverlayFiles(dir);
    expect(created.sort()).toEqual(
      ["config.yaml", ".gitignore", "README.md", join("secrets", ".env.example")].sort(),
    );
    expect(existsSync(join(dir, "config.yaml"))).toBe(true);
    expect(existsSync(join(dir, ".gitignore"))).toBe(true);
    expect(existsSync(join(dir, "README.md"))).toBe(true);
    expect(existsSync(join(dir, "secrets", ".env.example"))).toBe(true);
  });

  it("never overwrites an existing file", () => {
    mkdirSync(join(dir, "secrets"), { recursive: true });
    writeFileSync(join(dir, "config.yaml"), "managedRepos:\n  - me/keep\n");
    const { created } = scaffoldOverlayFiles(dir);
    expect(created).not.toContain("config.yaml");
    expect(readFileSync(join(dir, "config.yaml"), "utf8")).toContain("me/keep");
  });

  it("reports nothing created when everything is already present", () => {
    scaffoldOverlayFiles(dir);
    const { created } = scaffoldOverlayFiles(dir);
    expect(created).toEqual([]);
  });
});

describe("overlay templates", () => {
  it(".gitignore ignores secrets but keeps the env template", () => {
    expect(OVERLAY_GITIGNORE).toContain("secrets/*");
    expect(OVERLAY_GITIGNORE).toContain("!secrets/.env.example");
    expect(OVERLAY_GITIGNORE).toContain("*.pem");
  });

  it(".env.example carries the required keys and no real secrets", () => {
    for (const key of [
      "LASTLIGHT_OVERLAY_DIR",
      "GITHUB_APP_ID",
      "GITHUB_APP_INSTALLATION_ID",
      "WEBHOOK_SECRET",
      "LASTLIGHT_MODEL",
      "ADMIN_SECRET",
    ]) {
      expect(OVERLAY_ENV_EXAMPLE).toContain(key);
    }
    // Provider keys are commented placeholders, not filled in.
    expect(OVERLAY_ENV_EXAMPLE).toContain("# ANTHROPIC_API_KEY=");
    expect(OVERLAY_ENV_EXAMPLE).not.toMatch(/sk-ant-\w/);
  });

  it("config placeholder is valid-ish YAML with an empty managedRepos list", () => {
    expect(OVERLAY_CONFIG_PLACEHOLDER).toContain("managedRepos:");
    expect(OVERLAY_CONFIG_PLACEHOLDER).toMatch(/managedRepos:\s*\n\s*\[\]/);
  });
});

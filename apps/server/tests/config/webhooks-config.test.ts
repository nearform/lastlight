import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, resetRuntimeConfigForTests } from "#src/config/config.js";
import { defaultRepoConfigPolicy, sanitizeRepoConfigLayer } from "lastlight-shared/repo-config-schema";
import { WEBHOOK_EVENT_TYPES } from "#src/notify/webhook/types.js";

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

/**
 * `webhooks:` is operator config: a top-level key (a repo may set
 * `notifications`, so the endpoints cannot live there), validated at boot so a
 * typo stops the deployment instead of silently dropping every event.
 */
function overlayWith(block: string): string {
  const dir = mkdtempSync(join(tmpdir(), "webhooks-boot-"));
  writeFileSync(join(dir, "config.yaml"), block);
  return dir;
}

describe("loadConfig — webhooks", () => {
  beforeEach(() => {
    for (const k of ["GITHUB_APP_ID", "SLACK_BOT_TOKEN", "LASTLIGHT_MODEL", "LASTLIGHT_MODELS"]) vi.stubEnv(k, "");
    vi.stubEnv("HOOK_SECRET", "s3cr3t-value");
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    resetRuntimeConfigForTests();
  });

  it("ships none", () => {
    expect(loadConfig().webhooks).toEqual([]);
  });

  it("normalises an entry: events default to all four, repos to none", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith("webhooks:\n  - url: http://127.0.0.1:8650/webhooks/x\n    secretEnv: HOOK_SECRET\n"),
    );
    expect(loadConfig().webhooks).toEqual([
      { url: "http://127.0.0.1:8650/webhooks/x", secretEnv: "HOOK_SECRET", events: [...WEBHOOK_EVENT_TYPES], repos: [] },
    ]);
    expect(WEBHOOK_EVENT_TYPES).toEqual(["run.started", "run.approval_requested", "run.finished", "autonomy.held"]);
  });

  it("keeps a listed subset of events and repos", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith(
        "webhooks:\n  - url: https://hooks.example.com/a\n    secretEnv: HOOK_SECRET\n    events: [run.finished]\n    repos: [acme/widgets]\n",
      ),
    );
    const [w] = loadConfig().webhooks;
    expect(w.events).toEqual(["run.finished"]);
    expect(w.repos).toEqual(["acme/widgets"]);
  });

  it("refuses a URL that is not http(s), naming the entry", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("webhooks:\n  - url: file:///etc/passwd\n    secretEnv: HOOK_SECRET\n"));
    expect(() => loadConfig()).toThrow(/webhooks\[0\]\.url/);
  });

  it("refuses credentials in the URL — the secret belongs in secretEnv", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith("webhooks:\n  - url: https://user:pw@hooks.example.com/a\n    secretEnv: HOOK_SECRET\n"),
    );
    expect(() => loadConfig()).toThrow(/webhooks\[0\]\.url/);
  });

  it("refuses an unknown event, naming it", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith("webhooks:\n  - url: https://hooks.example.com/a\n    secretEnv: HOOK_SECRET\n    events: [run.exploded]\n"),
    );
    expect(() => loadConfig()).toThrow(/run\.exploded/);
  });

  it("refuses a secretEnv that is not set, naming the variable and never a value", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith("webhooks:\n  - url: https://hooks.example.com/a\n    secretEnv: MISSING_HOOK_SECRET\n"),
    );
    let message = "";
    try {
      loadConfig();
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/MISSING_HOOK_SECRET/);
    expect(message).not.toContain("s3cr3t-value");
  });

  it("refuses a missing secretEnv", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("webhooks:\n  - url: https://hooks.example.com/a\n"));
    expect(() => loadConfig()).toThrow(/webhooks\[0\]\.secretEnv/);
  });

  it("refuses a webhooks value that is not a list", () => {
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlayWith("webhooks:\n  url: https://hooks.example.com/a\n"));
    expect(() => loadConfig()).toThrow(/webhooks/);
  });

  it("hides a URL's query string in the dashboard's view of the config", () => {
    vi.stubEnv(
      "LASTLIGHT_OVERLAY_DIR",
      overlayWith("webhooks:\n  - url: https://hooks.example.com/a?token=abc123\n    secretEnv: HOOK_SECRET\n"),
    );
    const cfg = loadConfig();
    expect(cfg.webhooks[0].url).toBe("https://hooks.example.com/a?token=abc123");
    expect(JSON.stringify(cfg.publicConfig)).not.toContain("abc123");
  });
});

describe("a repo's .lastlight/ cannot add webhooks", () => {
  it("drops a top-level webhooks key with key-not-allowed", () => {
    const { layer, warnings } = sanitizeRepoConfigLayer(
      { webhooks: [{ url: "https://evil.example.com", secretEnv: "X" }] },
      defaultRepoConfigPolicy(),
      { value: {}, sources: {} },
      "acme/widgets",
    );
    expect(layer).toEqual({});
    expect(warnings.map((w) => [w.code, w.path])).toEqual([["key-not-allowed", "webhooks"]]);
  });
});

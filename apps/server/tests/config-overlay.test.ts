import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { loadConfig, getPublicConfig, resetRuntimeConfigForTests } from "#src/config/config.js";

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
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "");
    vi.stubEnv("DATABASE_URL", "");
    vi.stubEnv("DATABASE_DRIVER", "");
    vi.stubEnv("DATABASE_POOL_MAX", "");
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

  it("merges overlay otel config and keeps OTLP header env out of public config", () => {
    const overlay = tmp();
    writeFileSync(join(overlay, "config.yaml"), `managedRepos:\n  - acme/repo\notel:\n  enabled: true\n  includeContent: true\n  forwardToSandbox: false\n  collectorHosts:\n    - otel.example.com\n`);
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay);
    vi.stubEnv("OTEL_EXPORTER_OTLP_HEADERS", "authorization=Bearer secret");
    const cfg = loadConfig();
    expect(cfg.otel.enabled).toBe(true);
    expect(cfg.otel.includeContent).toBe(true);
    expect(cfg.otel.forwardToSandbox).toBe(false);
    expect(cfg.otel.collectorHosts).toEqual(["otel.example.com"]);
    expect(JSON.stringify(cfg.publicConfig)).not.toContain("authorization=Bearer secret");
  });

  it("unions overlay otel.collectorHosts with env hosts and tags provenance as env", () => {
    const overlay = tmp();
    writeFileSync(
      join(overlay, "config.yaml"),
      `managedRepos:\n  - acme/repo\notel:\n  collectorHosts:\n    - overlay.example.com\n`,
    );
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay);
    vi.stubEnv("LASTLIGHT_OTEL_COLLECTOR_HOSTS", "env.example.com");
    const cfg = loadConfig();
    // Env hosts add to (do not replace) the overlay hosts — a dropped overlay
    // host would silently break sandbox egress for real deployments.
    expect(cfg.otel.collectorHosts.sort()).toEqual(["env.example.com", "overlay.example.com"]);
    const sources = cfg.publicConfig.sources as Record<string, any>;
    expect(sources.otel.collectorHosts).toBe("env");
  });

  it("APPROVAL_GATES replaces overlay approval wholesale and is tagged env", () => {
    const overlay = tmp();
    writeFileSync(
      join(overlay, "config.yaml"),
      `managedRepos:\n  - acme/repo\napproval:\n  post_architect: true\n`,
    );
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay);
    vi.stubEnv("APPROVAL_GATES", "post_reviewer");
    const cfg = loadConfig();
    // Env replaces the file map — post_architect from the overlay is gone.
    expect(cfg.approval).toEqual({ post_reviewer: true });
    const sources = cfg.publicConfig.sources as Record<string, any>;
    expect(sources.approval).toBe("env");
  });

  // `database.url` is the state-DB slot the Drizzle migration added. It rides
  // the generic resolver, so these four cases are the whole contract: env beats
  // overlay beats default, and null/absent means "fall back to dbPath".
  describe("database.url", () => {
    it("is undefined by default — config/default.yaml ships `url: null`", () => {
      const cfg = loadConfig();
      expect(cfg.database.url).toBeUndefined();
      // The fallback the construction site in index.ts applies.
      expect(cfg.database.url ?? cfg.dbPath).toBe(cfg.dbPath);
    });

    it("reads the overlay value", () => {
      const overlay = tmp();
      writeFileSync(join(overlay, "config.yaml"), `managedRepos:\n  - acme/repo\ndatabase:\n  url: file:/overlay/ll.db\n`);
      vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay);
      expect(loadConfig().database.url).toBe("file:/overlay/ll.db");
    });

    it("lets DATABASE_URL beat the overlay and tags provenance as env", () => {
      const overlay = tmp();
      writeFileSync(join(overlay, "config.yaml"), `managedRepos:\n  - acme/repo\ndatabase:\n  url: file:/overlay/ll.db\n`);
      vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay);
      vi.stubEnv("DATABASE_URL", "file:/env/ll.db");
      const cfg = loadConfig();
      expect(cfg.database.url).toBe("file:/env/ll.db");
      const sources = cfg.publicConfig.sources as Record<string, any>;
      expect(sources.database.url).toBe("env");
    });

    it("treats an explicit overlay `url: null` as absent", () => {
      const overlay = tmp();
      writeFileSync(join(overlay, "config.yaml"), `managedRepos:\n  - acme/repo\ndatabase:\n  url: null\n`);
      vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay);
      expect(loadConfig().database.url).toBeUndefined();
    });
  });

  // The Postgres runtime's two extra knobs (Phase 6). Both are absent by
  // default — `driver` unset means "auto-detect from the URL host", which is
  // resolved in `StateDb.open()`, not here.
  describe("database.driver / database.poolMax", () => {
    it("are undefined by default", () => {
      const cfg = loadConfig();
      expect(cfg.database.driver).toBeUndefined();
      expect(cfg.database.poolMax).toBeUndefined();
    });

    it("reads them from the overlay and lets env win", () => {
      const overlay = tmp();
      writeFileSync(
        join(overlay, "config.yaml"),
        `managedRepos:\n  - acme/repo\ndatabase:\n  driver: neon\n  poolMax: 4\n`,
      );
      vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay);
      expect(loadConfig().database).toMatchObject({ driver: "neon", poolMax: 4 });

      vi.stubEnv("DATABASE_DRIVER", "pg");
      vi.stubEnv("DATABASE_POOL_MAX", "25");
      expect(loadConfig().database).toMatchObject({ driver: "pg", poolMax: 25 });
    });

    it("ignores a nonsense driver rather than failing boot", () => {
      const overlay = tmp();
      writeFileSync(
        join(overlay, "config.yaml"),
        `managedRepos:\n  - acme/repo\ndatabase:\n  driver: mysql\n  poolMax: 0\n`,
      );
      vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay);
      expect(loadConfig().database.driver).toBeUndefined();
      expect(loadConfig().database.poolMax).toBeUndefined();
      vi.stubEnv("DATABASE_DRIVER", "neon-http");
      expect(loadConfig().database.driver).toBeUndefined();
    });
  });

  /**
   * A `postgres://user:pass@…` URL in `database.url` is a credential, and the
   * dashboard's /config view echoes every non-secret leaf. `SENSITIVE_KEY_RE`
   * does not match `url` (it must not — `publicUrl`/`avatarUrl` are not
   * secrets), so this is masked by VALUE. The `file:` case is the other half of
   * the contract: it stays legible, which is why a blanket key rule was wrong.
   */
  describe("database.url credential redaction", () => {
    it("masks a postgres:// URL in every public bundle, keeping host and db", () => {
      const overlay = tmp();
      writeFileSync(
        join(overlay, "config.yaml"),
        `managedRepos:\n  - acme/repo\ndatabase:\n  url: postgres://lastlight:hunter2@db.internal:5432/lastlight\n`,
      );
      vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay);
      const cfg = loadConfig();

      // The live value is untouched — redaction is a RENDERING concern.
      expect(cfg.database.url).toBe("postgres://lastlight:hunter2@db.internal:5432/lastlight");

      const serialized = JSON.stringify(cfg.publicConfig);
      expect(serialized).not.toContain("hunter2");
      const masked = "postgres://***:***@db.internal:5432/lastlight";
      expect((cfg.publicConfig.overlay as any).database.url).toBe(masked);
      expect((cfg.publicConfig.merged as any).database.url).toBe(masked);
    });

    it("leaves a file: URL visible", () => {
      const overlay = tmp();
      writeFileSync(
        join(overlay, "config.yaml"),
        `managedRepos:\n  - acme/repo\ndatabase:\n  url: file:/app/data/lastlight.db\n`,
      );
      vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay);
      expect((loadConfig().publicConfig.merged as any).database.url).toBe(
        "file:/app/data/lastlight.db",
      );
    });
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

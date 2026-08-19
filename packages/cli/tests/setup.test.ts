import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { writeFileSync, mkdirSync, mkdtempSync, lstatSync, readlinkSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isPositiveInt,
  isPemFile,
  isSlackBotToken,
  isSlackAppToken,
  buildEnvContent,
  buildOverlayConfig,
  parseManagedRepos,
  ensureOverrideSymlink,
  CADDY_DISABLED_OVERRIDE,
} from "../src/setup.js";
import type { SetupConfig } from "../src/setup.js";

// ── Validation helpers ──────────────────────────────────────────────────────

describe("isPositiveInt", () => {
  it("accepts valid positive integers", () => {
    expect(isPositiveInt("1")).toBe(true);
    expect(isPositiveInt("123456")).toBe(true);
    expect(isPositiveInt("999999999")).toBe(true);
  });

  it("rejects zero", () => {
    expect(isPositiveInt("0")).toBe(false);
  });

  it("rejects negative numbers", () => {
    expect(isPositiveInt("-1")).toBe(false);
    expect(isPositiveInt("-100")).toBe(false);
  });

  it("rejects non-numeric strings", () => {
    expect(isPositiveInt("abc")).toBe(false);
    expect(isPositiveInt("1.5")).toBe(false);
    expect(isPositiveInt("1e5")).toBe(false);
    expect(isPositiveInt("")).toBe(false);
    expect(isPositiveInt(" 1")).toBe(false);
    expect(isPositiveInt("1 ")).toBe(false);
  });
});

describe("isPemFile", () => {
  const tmpDir = join(tmpdir(), `lastlight-test-${process.pid}`);

  function writePem(name: string, content: string): string {
    mkdirSync(tmpDir, { recursive: true });
    const p = join(tmpDir, name);
    writeFileSync(p, content);
    return p;
  }

  it("accepts RSA private key PEM", () => {
    const p = writePem(
      "rsa.pem",
      "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA...\n-----END RSA PRIVATE KEY-----\n"
    );
    expect(isPemFile(p)).toBe(true);
  });

  it("accepts PKCS8 private key PEM", () => {
    const p = writePem(
      "pkcs8.pem",
      "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkq...\n-----END PRIVATE KEY-----\n"
    );
    expect(isPemFile(p)).toBe(true);
  });

  it("rejects a file that does not start with a PEM header", () => {
    const p = writePem("bad.pem", "not a pem file\n");
    expect(isPemFile(p)).toBe(false);
  });

  it("rejects a non-existent path", () => {
    expect(isPemFile(join(tmpDir, "does-not-exist.pem"))).toBe(false);
  });
});

describe("isSlackBotToken", () => {
  it("accepts xoxb- tokens", () => {
    expect(isSlackBotToken("xoxb-12345-67890-abc")).toBe(true);
  });

  it("rejects non-xoxb tokens", () => {
    expect(isSlackBotToken("xapp-1-abc")).toBe(false);
    expect(isSlackBotToken("")).toBe(false);
    expect(isSlackBotToken("xoxb")).toBe(false); // no dash
  });
});

describe("isSlackAppToken", () => {
  it("accepts xapp- tokens", () => {
    expect(isSlackAppToken("xapp-1-abc-def")).toBe(true);
  });

  it("rejects non-xapp tokens", () => {
    expect(isSlackAppToken("xoxb-1-abc")).toBe(false);
    expect(isSlackAppToken("")).toBe(false);
    expect(isSlackAppToken("xapp")).toBe(false); // no dash
  });
});

// ── .env serialization ─────────────────────────────────────────────────────

describe("buildEnvContent", () => {
  const baseConfig: SetupConfig = {
    GITHUB_APP_ID: "123456",
    GITHUB_APP_INSTALLATION_ID: "789012",
    WEBHOOK_SECRET: "deadbeef01234567",
    ADMIN_SECRET: "cafebabe89abcdef",
    DOMAIN: "lastlight.example.com",
    LASTLIGHT_MODEL: "openai/gpt-5.3-codex",
    providerApiKey: { envKey: "OPENAI_API_KEY", value: "sk-test-openai" },
    useCaddy: true,
    pemSourcePath: "/tmp/app.pem",
    managedRepos: [],
  };

  it("contains all required key=value pairs", () => {
    const content = buildEnvContent(baseConfig);
    expect(content).toContain("GITHUB_APP_ID=123456");
    expect(content).toContain("GITHUB_APP_INSTALLATION_ID=789012");
    expect(content).toContain("WEBHOOK_SECRET=deadbeef01234567");
    expect(content).toContain("ADMIN_SECRET=cafebabe89abcdef");
    expect(content).toContain("DOMAIN=lastlight.example.com");
    expect(content).toContain("LASTLIGHT_MODEL=openai/gpt-5.3-codex");
    expect(content).toContain("OPENAI_API_KEY=sk-test-openai");
    expect(content).not.toMatch(/^ANTHROPIC_API_KEY=/m);
    expect(content).toContain("GITHUB_APP_PRIVATE_KEY_PATH=./app.pem");
    expect(content).toContain("LASTLIGHT_OVERLAY_DIR=/app/instance");
  });

  it("writes ANTHROPIC_API_KEY when the anthropic provider is chosen", () => {
    const config: SetupConfig = {
      ...baseConfig,
      LASTLIGHT_MODEL: "anthropic/claude-sonnet-4-6-20251015",
      providerApiKey: { envKey: "ANTHROPIC_API_KEY", value: "sk-ant-test" },
    };
    const content = buildEnvContent(config);
    expect(content).toContain("LASTLIGHT_MODEL=anthropic/claude-sonnet-4-6-20251015");
    expect(content).toContain("ANTHROPIC_API_KEY=sk-ant-test");
    expect(content).not.toMatch(/^OPENAI_API_KEY=/m);
  });

  it("writes OPENROUTER_API_KEY when the openrouter provider is chosen", () => {
    const config: SetupConfig = {
      ...baseConfig,
      LASTLIGHT_MODEL: "openrouter/anthropic/claude-sonnet-4.5",
      providerApiKey: { envKey: "OPENROUTER_API_KEY", value: "sk-or-v1-test" },
    };
    const content = buildEnvContent(config);
    expect(content).toContain("LASTLIGHT_MODEL=openrouter/anthropic/claude-sonnet-4.5");
    expect(content).toContain("OPENROUTER_API_KEY=sk-or-v1-test");
    expect(content).not.toMatch(/^OPENAI_API_KEY=/m);
    expect(content).not.toMatch(/^ANTHROPIC_API_KEY=/m);
  });

  it("writes a non-builtin provider key (groq) under its registry env var", () => {
    const config: SetupConfig = {
      ...baseConfig,
      LASTLIGHT_MODEL: "groq/llama-3.3-70b-versatile",
      providerApiKey: { envKey: "GROQ_API_KEY", value: "gsk_test" },
    };
    const content = buildEnvContent(config);
    expect(content).toContain("LASTLIGHT_MODEL=groq/llama-3.3-70b-versatile");
    expect(content).toContain("GROQ_API_KEY=gsk_test");
    expect(content).not.toMatch(/^OPENAI_API_KEY=/m);
    expect(content).not.toMatch(/^ANTHROPIC_API_KEY=/m);
  });

  it("omits the provider key line entirely when providerApiKey is undefined", () => {
    const config: SetupConfig = { ...baseConfig, providerApiKey: undefined };
    const content = buildEnvContent(config);
    expect(content).not.toMatch(/^OPENAI_API_KEY=/m);
    expect(content).not.toMatch(/^GROQ_API_KEY=/m);
  });

  it("includes optional ADMIN_PASSWORD when provided", () => {
    const config: SetupConfig = { ...baseConfig, ADMIN_PASSWORD: "s3cr3t" };
    const content = buildEnvContent(config);
    expect(content).toContain("ADMIN_PASSWORD=s3cr3t");
  });

  it("omits ADMIN_PASSWORD when not provided", () => {
    const content = buildEnvContent(baseConfig);
    expect(content).not.toMatch(/^ADMIN_PASSWORD=/m);
  });

  it("includes Slack tokens when provided", () => {
    const config: SetupConfig = {
      ...baseConfig,
      SLACK_BOT_TOKEN: "xoxb-test-token",
      SLACK_APP_TOKEN: "xapp-test-token",
    };
    const content = buildEnvContent(config);
    expect(content).toContain("SLACK_BOT_TOKEN=xoxb-test-token");
    expect(content).toContain("SLACK_APP_TOKEN=xapp-test-token");
  });

  it("omits Slack tokens when not provided", () => {
    const content = buildEnvContent(baseConfig);
    expect(content).not.toMatch(/^SLACK_BOT_TOKEN=/m);
    expect(content).not.toMatch(/^SLACK_APP_TOKEN=/m);
  });

  it("includes optional Slack channel and allowed users when provided", () => {
    const config: SetupConfig = {
      ...baseConfig,
      SLACK_BOT_TOKEN: "xoxb-tok",
      SLACK_APP_TOKEN: "xapp-tok",
      SLACK_DELIVERY_CHANNEL: "C0123456789",
      SLACK_ALLOWED_USERS: "U111,U222",
    };
    const content = buildEnvContent(config);
    expect(content).toContain("SLACK_DELIVERY_CHANNEL=C0123456789");
    expect(content).toContain("SLACK_ALLOWED_USERS=U111,U222");
  });

  it("produces a string (not empty)", () => {
    const content = buildEnvContent(baseConfig);
    expect(typeof content).toBe("string");
    expect(content.length).toBeGreaterThan(0);
  });
});

describe("parseManagedRepos", () => {
  it("splits on spaces, commas, and newlines and dedupes", () => {
    expect(parseManagedRepos("acme/one, acme/two acme/one\nacme/three")).toEqual([
      "acme/one",
      "acme/two",
      "acme/three",
    ]);
  });

  it("drops malformed tokens (not owner/repo)", () => {
    expect(parseManagedRepos("acme/one notarepo a/b/c  /x  y/")).toEqual(["acme/one"]);
  });

  it("returns an empty array for blank input", () => {
    expect(parseManagedRepos("   ")).toEqual([]);
  });
});

describe("buildOverlayConfig", () => {
  const cfg = (managedRepos: string[]): SetupConfig => ({
    GITHUB_APP_ID: "1",
    GITHUB_APP_INSTALLATION_ID: "2",
    WEBHOOK_SECRET: "w",
    ADMIN_SECRET: "a",
    DOMAIN: "d.example.com",
    LASTLIGHT_MODEL: "anthropic/claude-sonnet-4-6",
    providerApiKey: { envKey: "ANTHROPIC_API_KEY", value: "sk-ant-x" },
    useCaddy: true,
    pemSourcePath: "/tmp/app.pem",
    managedRepos,
  });

  it("lists each managed repo under managedRepos:", () => {
    const yaml = buildOverlayConfig(cfg(["acme/one", "acme/two"]));
    expect(yaml).toContain("managedRepos:");
    expect(yaml).toContain("  - acme/one");
    expect(yaml).toContain("  - acme/two");
  });

  it("emits an empty list when no repos are given", () => {
    const yaml = buildOverlayConfig(cfg([]));
    expect(yaml).toMatch(/managedRepos:\n\s+\[\]/);
  });

  /**
   * The overlay is a git repo the wizard offers to push to GitHub a few steps
   * later, so nothing secret may reach it. `database.url` is the tempting
   * exception — it IS a valid YAML slot — and putting it here would push a
   * database password to a remote, which no amount of render-time redaction
   * can undo. It rides `buildEnvContent()` instead.
   */
  it("never emits a postgres:// URL, even when one was collected", () => {
    const withPg: SetupConfig = {
      ...cfg(["acme/one"]),
      DATABASE_URL: "postgres://lastlight:hunter2@db.internal:5432/lastlight",
    };
    const yaml = buildOverlayConfig(withPg);
    expect(yaml).not.toContain("postgres://");
    expect(yaml).not.toContain("hunter2");
    expect(yaml).not.toContain("database");
  });
});

// ── The state-database choice (Phase 6) ────────────────────────────────────

describe("buildEnvContent — state database", () => {
  const base: SetupConfig = {
    GITHUB_APP_ID: "1",
    GITHUB_APP_INSTALLATION_ID: "2",
    WEBHOOK_SECRET: "w",
    ADMIN_SECRET: "a",
    DOMAIN: "d.example.com",
    LASTLIGHT_MODEL: "anthropic/claude-sonnet-4-6",
    providerApiKey: { envKey: "ANTHROPIC_API_KEY", value: "sk-ant-x" },
    useCaddy: true,
    pemSourcePath: "/tmp/app.pem",
    managedRepos: [],
  };

  /**
   * SQLite writing NOTHING is the contract, not an omission. The slot resolves
   * to `file:` + the `DB_PATH` / `$STATE_DIR` path by absence, so an emitted
   * `DATABASE_URL=file:./data/lastlight.db` would pin a path `STATE_DIR` is
   * meant to be able to move — and every `.env` written by an older wizard
   * keeps working precisely because nothing is written here.
   */
  it("writes no DATABASE_URL at all for the SQLite answer", () => {
    const content = buildEnvContent(base);
    expect(content).not.toContain("DATABASE_URL");
    expect(content).not.toContain("DATABASE_DRIVER=");
  });

  it("writes DATABASE_URL for the Postgres answer", () => {
    const content = buildEnvContent({
      ...base,
      DATABASE_URL: "postgres://lastlight:hunter2@db.internal:5432/lastlight",
    });
    expect(content).toContain(
      "DATABASE_URL=postgres://lastlight:hunter2@db.internal:5432/lastlight",
    );
  });

  it("leaves DATABASE_DRIVER commented out — the host heuristic answers it", () => {
    const content = buildEnvContent({
      ...base,
      DATABASE_URL: "postgres://u:p@ep-x.eu-central-1.aws.neon.tech/lastlight",
    });
    // Present as guidance for the one case the host cannot express (Neon
    // behind a custom domain), but never active: a wrong explicit driver beats
    // a right heuristic, and `neon-http` in particular loses transactions.
    expect(content).toContain("# DATABASE_DRIVER=neon");
    expect(content).not.toMatch(/^DATABASE_DRIVER=/m);
  });
});

describe("CADDY_DISABLED_OVERRIDE", () => {
  it("disables the caddy service via a profile", () => {
    expect(CADDY_DISABLED_OVERRIDE).toMatch(/caddy:/);
    expect(CADDY_DISABLED_OVERRIDE).toMatch(/profiles:\s*\n\s+- disabled/);
  });
});

describe("ensureOverrideSymlink", () => {
  let dir: string;
  let cwd: string;
  beforeEach(() => {
    cwd = process.cwd();
    dir = mkdtempSync(join(tmpdir(), "lastlight-override-"));
    process.chdir(dir);
    mkdirSync("instance");
  });
  afterEach(() => {
    process.chdir(cwd);
  });

  it("symlinks the overlay override into the project dir when it exists", () => {
    writeFileSync(join("instance", "docker-compose.override.yml"), "services: {}\n");
    ensureOverrideSymlink();
    const st = lstatSync("docker-compose.override.yml");
    expect(st.isSymbolicLink()).toBe(true);
    expect(readlinkSync("docker-compose.override.yml")).toBe(join("instance", "docker-compose.override.yml"));
  });

  it("is a no-op when the overlay has no override", () => {
    ensureOverrideSymlink();
    expect(existsSync("docker-compose.override.yml")).toBe(false);
  });

  it("leaves a pre-existing regular file untouched", () => {
    writeFileSync(join("instance", "docker-compose.override.yml"), "services: {}\n");
    writeFileSync("docker-compose.override.yml", "# real file\n");
    ensureOverrideSymlink();
    expect(lstatSync("docker-compose.override.yml").isSymbolicLink()).toBe(false);
    expect(readFileSync("docker-compose.override.yml", "utf8")).toContain("# real file");
  });
});

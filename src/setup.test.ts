import { describe, it, expect } from "vitest";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  isPositiveInt,
  isPemFile,
  isAnthropicKey,
  isOpenaiKey,
  isOpenrouterKey,
  isSlackBotToken,
  isSlackAppToken,
  buildEnvContent,
} from "./setup.js";
import type { SetupConfig } from "./setup.js";

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

describe("isAnthropicKey", () => {
  it("accepts keys with sk-ant- prefix", () => {
    expect(isAnthropicKey("sk-ant-api03-abc123")).toBe(true);
    expect(isAnthropicKey("sk-ant-xyz")).toBe(true);
  });

  it("rejects keys without sk-ant- prefix", () => {
    expect(isAnthropicKey("sk-abc123")).toBe(false);
    expect(isAnthropicKey("xoxb-abc")).toBe(false);
    expect(isAnthropicKey("")).toBe(false);
    expect(isAnthropicKey("sk-ant")).toBe(false); // no dash after ant
  });
});

describe("isOpenaiKey", () => {
  it("accepts sk- keys that aren't sk-ant- or sk-or-", () => {
    expect(isOpenaiKey("sk-proj-abc123")).toBe(true);
    expect(isOpenaiKey("sk-abcdef")).toBe(true);
  });

  it("rejects sk-ant- (anthropic) keys", () => {
    expect(isOpenaiKey("sk-ant-foo")).toBe(false);
  });

  it("rejects sk-or- (openrouter) keys", () => {
    expect(isOpenaiKey("sk-or-v1-foo")).toBe(false);
  });

  it("rejects non-sk- inputs", () => {
    expect(isOpenaiKey("")).toBe(false);
    expect(isOpenaiKey("xoxb-foo")).toBe(false);
  });
});

describe("isOpenrouterKey", () => {
  it("accepts sk-or- keys", () => {
    expect(isOpenrouterKey("sk-or-v1-abcdef")).toBe(true);
    expect(isOpenrouterKey("sk-or-abc")).toBe(true);
  });

  it("rejects other key shapes", () => {
    expect(isOpenrouterKey("sk-ant-foo")).toBe(false);
    expect(isOpenrouterKey("sk-proj-foo")).toBe(false);
    expect(isOpenrouterKey("")).toBe(false);
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
    OPENAI_API_KEY: "sk-test-openai",
    useCaddy: true,
    pemSourcePath: "/tmp/app.pem",
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
    expect(content).toContain(
      "GITHUB_APP_PRIVATE_KEY_PATH=./secrets/app.pem"
    );
  });

  it("writes ANTHROPIC_API_KEY only when an anthropic model is chosen", () => {
    const config: SetupConfig = {
      ...baseConfig,
      LASTLIGHT_MODEL: "anthropic/claude-sonnet-4-6-20251015",
      OPENAI_API_KEY: undefined,
      ANTHROPIC_API_KEY: "sk-ant-test",
    };
    const content = buildEnvContent(config);
    expect(content).toContain("LASTLIGHT_MODEL=anthropic/claude-sonnet-4-6-20251015");
    expect(content).toContain("ANTHROPIC_API_KEY=sk-ant-test");
    expect(content).not.toMatch(/^OPENAI_API_KEY=/m);
  });

  it("writes OPENROUTER_API_KEY only when an openrouter model is chosen", () => {
    const config: SetupConfig = {
      ...baseConfig,
      LASTLIGHT_MODEL: "openrouter/anthropic/claude-sonnet-4.5",
      OPENAI_API_KEY: undefined,
      OPENROUTER_API_KEY: "sk-or-v1-test",
    };
    const content = buildEnvContent(config);
    expect(content).toContain("LASTLIGHT_MODEL=openrouter/anthropic/claude-sonnet-4.5");
    expect(content).toContain("OPENROUTER_API_KEY=sk-or-v1-test");
    expect(content).not.toMatch(/^OPENAI_API_KEY=/m);
    expect(content).not.toMatch(/^ANTHROPIC_API_KEY=/m);
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

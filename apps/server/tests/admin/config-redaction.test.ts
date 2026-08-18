import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AdminConfig } from "#src/admin/routes.js";
import type { LastLightConfig } from "#src/config/config.js";
import type { StateDb } from "#src/state/db.js";
import type { SessionReader } from "#src/admin/sessions.js";
import type { RepoLayer } from "#src/config/repo-config.js";

/**
 * Secret redaction on the two config endpoints (issue #180).
 *
 * `SENSITIVE_KEY_RE` + `redactPublic` are defined once, in `src/config/config.ts`,
 * and imported by the admin routes. They used to be hand-mirrored, which is a
 * leak waiting to happen rather than a duplication smell: `GET /repos/:owner/
 * :repo/config` echoes a repo's UNTRUSTED `.lastlight/lastlight.yml` back RAW
 * and pre-validation, so it is the one surface where a credential a repo pasted
 * into its config file could round-trip into the dashboard. These tests hold
 * both endpoints to the exported rule.
 */

const repoConfig = vi.hoisted(() => ({
  fetchRepoLayer: vi.fn(),
  refreshRepoLayer: vi.fn(),
  getCachedRepoLayer: vi.fn(),
}));
vi.mock("#src/config/repo-config.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("#src/config/repo-config.js")>();
  return { ...actual, ...repoConfig };
});

const { createAdminRoutes } = await import("#src/admin/routes.js");
const { SENSITIVE_KEY_RE, redactPublic, loadConfig, setRuntimeConfig, resetRuntimeConfigForTests } = await import(
  "#src/config/config.js"
);

const mockDb = { runs: { distinctRepos: () => [] } } as unknown as StateDb;
const mockSessions = {} as unknown as SessionReader;

function makeApp(over: Partial<AdminConfig> = {}) {
  return createAdminRoutes(mockDb, mockSessions, mockSessions, {
    stateDir: "/tmp",
    sessionsDir: "/tmp/sessions",
    adminPassword: "",
    adminSecret: "test-secret",
    ...over,
  } as AdminConfig);
}

function runtimeConfig(): LastLightConfig {
  return {
    stateDir: "/tmp",
    managedRepos: ["acme/widget"],
    models: { default: "anthropic/claude-sonnet-4-6" },
    variants: {},
    disabled: { workflows: [], crons: [], prompts: [], skills: [], agentContext: [] },
    approval: {},
    repoConfig: { enabled: true, allowKeys: ["models"], allowedModels: null, allowAssets: true },
    publicConfig: { default: {}, overlay: null, merged: {}, sources: {} },
  } as unknown as LastLightConfig;
}

function layer(config: Record<string, unknown>): RepoLayer {
  return {
    repo: "acme/widget",
    defaultBranch: "main",
    treeSha: "tree-1",
    fetchedAt: "2026-07-31T09:00:00.000Z",
    root: "/nonexistent",
    config,
    assets: [],
    warnings: [],
  };
}

/** One key name per branch of the exported rule — the full surface it guards. */
const SECRET_KEY_NAMES = [
  "webhookSecret",
  "authToken",
  "password",
  "passwd",
  "credential",
  "privateKey",
  "private_key",
  "signingKey",
  "apiKey",
  "api_key",
  "keyPath",
  "pem",
];

beforeEach(() => {
  repoConfig.fetchRepoLayer.mockReset().mockResolvedValue(undefined);
  repoConfig.refreshRepoLayer.mockReset().mockResolvedValue(undefined);
  repoConfig.getCachedRepoLayer.mockReset().mockReturnValue(undefined);
  setRuntimeConfig(runtimeConfig());
});

afterEach(() => {
  vi.unstubAllEnvs();
  resetRuntimeConfigForTests();
});

describe("GET /repos/:owner/:repo/config", () => {
  it("redacts every key the exported rule matches, at any depth", async () => {
    const secrets = Object.fromEntries(SECRET_KEY_NAMES.map((k) => [k, `leaked-${k}`]));
    repoConfig.fetchRepoLayer.mockResolvedValue(
      layer({ ...secrets, nested: { ...secrets, harmless: "ok" }, list: [{ apiKey: "leaked-in-a-list" }] }),
    );

    const res = await makeApp().fetch(new Request("http://localhost/repos/acme/widget/config"));
    const body = (await res.json()) as { repoLayer: Record<string, unknown> };

    for (const key of SECRET_KEY_NAMES) {
      // Sanity-check the fixture against the rule itself, so this test keeps
      // covering the whole regex if a branch is ever added to it.
      expect(SENSITIVE_KEY_RE.test(key)).toBe(true);
      expect(body.repoLayer[key]).toBe("[redacted]");
      expect((body.repoLayer.nested as Record<string, unknown>)[key]).toBe("[redacted]");
    }
    expect((body.repoLayer.nested as Record<string, unknown>).harmless).toBe("ok");
    expect(JSON.stringify(body)).not.toContain("leaked-");
  });

  it("redacts the merged view with the same walk config.ts uses", async () => {
    // `merged` is derived from the operator's layers, but it is redacted too —
    // defence in depth, and it must be the same walk, not a similar one.
    repoConfig.fetchRepoLayer.mockResolvedValue(layer({ models: { triage: "openai/gpt-5.5" } }));
    const res = await makeApp().fetch(new Request("http://localhost/repos/acme/widget/config"));
    const body = (await res.json()) as { merged: Record<string, unknown> };

    expect(body.merged).toEqual(redactPublic(body.merged));
  });
});

describe("GET /config", () => {
  it("serves a bundle with secret-looking keys already redacted", async () => {
    const overlay = mkdtempSync(join(tmpdir(), "lastlight-redaction-"));
    writeFileSync(
      join(overlay, "config.yaml"),
      "managedRepos:\n  - acme/widget\nadminSecret: super-secret-value\nnested:\n  authToken: tok-leaked\n",
    );
    vi.stubEnv("LASTLIGHT_OVERLAY_DIR", overlay);
    vi.stubEnv("GITHUB_APP_ID", "");
    vi.stubEnv("SLACK_BOT_TOKEN", "");

    const cfg = loadConfig();
    const res = await makeApp({ publicConfig: cfg.publicConfig }).fetch(new Request("http://localhost/config"));
    const body = (await res.json()) as { overlay: Record<string, unknown>; merged: Record<string, unknown> };

    expect(body.overlay.adminSecret).toBe("[redacted]");
    expect((body.merged.nested as Record<string, unknown>).authToken).toBe("[redacted]");
    expect(JSON.stringify(body)).not.toContain("super-secret-value");
    expect(JSON.stringify(body)).not.toContain("tok-leaked");
  });
});

describe("single source", () => {
  it("the admin routes import the rule rather than mirroring it", () => {
    // A drifted copy of this rule is a leak, not a style problem, so the ban on
    // a second definition is asserted, not just commented.
    const source = readFileSync(fileURLToPath(new URL("../../src/admin/routes.ts", import.meta.url)), "utf-8");
    expect(source).not.toMatch(/(const|function)\s+(SENSITIVE_KEY_RE|redactPublic)\b/);
    // …and gets it from the one module that defines it.
    expect(source).toMatch(/redactPublic,[\s\S]{0,600}?from "\.\.\/config\/config\.js"/);
  });
});

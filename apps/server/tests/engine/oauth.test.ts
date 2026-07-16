import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  OAUTH_ONLY_PROVIDERS,
  hasOAuthCredentials,
  loadAuthMap,
  oauthEnvVarForProvider,
  oauthProviderIdForModel,
  resolveAuthFile,
  resolveOAuthApiKey,
  saveAuthMap,
} from "@lastlight/shared/oauth";
import {
  OAUTH_PROVIDERS,
  oauthProviderById,
  oauthProviderByModelPrefix,
} from "@lastlight/shared/providers";

describe("providers: OAuth registry", () => {
  it("registers exactly Codex, Anthropic, and Copilot", () => {
    expect(OAUTH_PROVIDERS.map((p) => p.id).sort()).toEqual([
      "anthropic",
      "github-copilot",
      "openai-codex",
    ]);
  });

  it("marks Codex chat-only (no sandbox env route) but the others sandbox-capable", () => {
    expect(oauthProviderById("openai-codex")?.sandboxEnvVar).toBeNull();
    expect(oauthProviderById("anthropic")?.sandboxEnvVar).toBe("ANTHROPIC_OAUTH_TOKEN");
    expect(oauthProviderById("github-copilot")?.sandboxEnvVar).toBe("COPILOT_GITHUB_TOKEN");
  });

  it("keeps oauth.ts's derived maps consistent with the registry", () => {
    for (const p of OAUTH_PROVIDERS) {
      // Every registered model prefix maps back to its own id.
      expect(oauthProviderIdForModel(`${p.modelPrefix}/whatever`)).toBe(p.id);
      // The env-var route matches the registry's sandboxEnvVar.
      expect(oauthEnvVarForProvider(p.id)).toBe(p.sandboxEnvVar ?? undefined);
      // oauthOnly membership matches the exported set.
      expect(OAUTH_ONLY_PROVIDERS.has(p.id)).toBe(p.oauthOnly);
      // The sample model spec is well-formed and starts with the prefix.
      expect(p.sampleModel.startsWith(`${p.modelPrefix}/`)).toBe(true);
    }
  });

  it("resolves providers by model prefix", () => {
    expect(oauthProviderByModelPrefix("openai-codex")?.id).toBe("openai-codex");
    expect(oauthProviderByModelPrefix("openai")).toBeUndefined();
  });
});

describe("oauth: model → provider mapping", () => {
  it("maps OAuth model prefixes to provider ids", () => {
    expect(oauthProviderIdForModel("openai-codex/gpt-5.4")).toBe("openai-codex");
    expect(oauthProviderIdForModel("anthropic/claude-sonnet-4-6")).toBe("anthropic");
    expect(oauthProviderIdForModel("github-copilot/gpt-4o")).toBe("github-copilot");
  });

  it("returns undefined for API-key providers", () => {
    expect(oauthProviderIdForModel("openai/gpt-5.5")).toBeUndefined();
    expect(oauthProviderIdForModel("openrouter/google/gemini-2.5-flash")).toBeUndefined();
    expect(oauthProviderIdForModel("bare-string")).toBeUndefined();
  });
});

describe("oauth: sandbox env-var route", () => {
  it("returns the env var for providers with a sandbox route", () => {
    expect(oauthEnvVarForProvider("anthropic")).toBe("ANTHROPIC_OAUTH_TOKEN");
    expect(oauthEnvVarForProvider("github-copilot")).toBe("COPILOT_GITHUB_TOKEN");
  });

  it("returns undefined for Codex (chat-only, no env route)", () => {
    expect(oauthEnvVarForProvider("openai-codex")).toBeUndefined();
  });
});

describe("oauth: oauth-only set", () => {
  it("marks Codex + Copilot mandatory, Anthropic optional", () => {
    expect(OAUTH_ONLY_PROVIDERS.has("openai-codex")).toBe(true);
    expect(OAUTH_ONLY_PROVIDERS.has("github-copilot")).toBe(true);
    expect(OAUTH_ONLY_PROVIDERS.has("anthropic")).toBe(false);
  });
});

describe("oauth: auth file resolution", () => {
  const saved = { LASTLIGHT_AUTH_FILE: process.env.LASTLIGHT_AUTH_FILE, STATE_DIR: process.env.STATE_DIR };
  afterEach(() => {
    process.env.LASTLIGHT_AUTH_FILE = saved.LASTLIGHT_AUTH_FILE;
    process.env.STATE_DIR = saved.STATE_DIR;
  });

  it("prefers an explicit path over everything", () => {
    process.env.LASTLIGHT_AUTH_FILE = "/env/auth.json";
    expect(resolveAuthFile("/explicit/a.json", "/state")).toBe("/explicit/a.json");
  });

  it("honours LASTLIGHT_AUTH_FILE next", () => {
    process.env.LASTLIGHT_AUTH_FILE = "/env/auth.json";
    expect(resolveAuthFile(undefined, "/state")).toBe("/env/auth.json");
  });

  it("falls back to <stateDir>/auth.json then $STATE_DIR", () => {
    delete process.env.LASTLIGHT_AUTH_FILE;
    expect(resolveAuthFile(undefined, "/state")).toBe("/state/auth.json");
    delete process.env.STATE_DIR;
    process.env.STATE_DIR = "/envstate";
    expect(resolveAuthFile()).toBe("/envstate/auth.json");
  });
});

describe("oauth: credential store", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "ll-oauth-"));
    file = join(dir, "auth.json");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("round-trips a map and writes mode 0600", () => {
    saveAuthMap({ "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1 } }, file);
    expect(loadAuthMap(file)).toEqual({
      "openai-codex": { type: "oauth", access: "a", refresh: "r", expires: 1 },
    });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    // Stored form is the auth.json shape pi-ai's own CLI writes.
    expect(JSON.parse(readFileSync(file, "utf8"))["openai-codex"].type).toBe("oauth");
  });

  it("hasOAuthCredentials + resolveOAuthApiKey report absence without throwing", async () => {
    expect(hasOAuthCredentials("openai-codex", file)).toBe(false);
    await expect(resolveOAuthApiKey("openai-codex", file)).resolves.toBeNull();
  });

  it("tolerates a missing / malformed store as empty", () => {
    expect(loadAuthMap(join(dir, "nope.json"))).toEqual({});
  });
});

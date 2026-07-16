import { describe, it, expect } from "vitest";
import {
  PROVIDERS,
  providerByPrefix,
  providerByEnvKey,
  PROVIDER_ENV_KEYS,
  PROVIDER_HOSTS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
} from "@lastlight/shared/providers";

describe("provider registry — structural invariants", () => {
  it("every provider has a unique prefix", () => {
    const prefixes = PROVIDERS.map((p) => p.prefix);
    expect(new Set(prefixes).size).toBe(prefixes.length);
  });

  it("every provider has a unique envKey (MOONSHOT/MINIMAX-style sharing not allowed at the wizard layer)", () => {
    const envKeys = PROVIDERS.map((p) => p.envKey);
    expect(new Set(envKeys).size).toBe(envKeys.length);
  });

  it("every provider has a non-empty host for the egress allowlist", () => {
    for (const spec of PROVIDERS) {
      expect(spec.host.length).toBeGreaterThan(0);
      // No leading dot / wildcard syntax — pure hostnames.
      expect(spec.host).not.toMatch(/^[.*]/);
    }
  });

  it("PROVIDER_ENV_KEYS / PROVIDER_HOSTS are derived from the registry in order", () => {
    expect(PROVIDER_ENV_KEYS).toEqual(PROVIDERS.map((p) => p.envKey));
    expect(PROVIDER_HOSTS).toEqual(PROVIDERS.map((p) => p.host));
  });

  it("anthropic is the first provider (cheap-helper fallback order)", () => {
    expect(PROVIDERS[0].prefix).toBe("anthropic");
  });

  it("OpenRouter preserves nested vendor/model ids (registry quirk flag)", () => {
    const openrouter = providerByPrefix("openrouter")!;
    expect(openrouter.preserveNestedModelId).toBe(true);
    expect(openrouter.extraHeaders).toBeDefined();
  });

  it("every api-type is one of the two we actually implement in llm.ts", () => {
    for (const spec of PROVIDERS) {
      expect(["anthropic-messages", "openai-completions"]).toContain(spec.api);
    }
  });
});

describe("providerByPrefix", () => {
  it("resolves a registered prefix case-insensitively", () => {
    expect(providerByPrefix("anthropic")?.prefix).toBe("anthropic");
    expect(providerByPrefix("OpenAI")?.prefix).toBe("openai");
    expect(providerByPrefix("GROQ")?.prefix).toBe("groq");
  });

  it("returns undefined for unregistered prefixes", () => {
    expect(providerByPrefix("acme")).toBeUndefined();
    expect(providerByPrefix("")).toBeUndefined();
  });
});

describe("providerByEnvKey", () => {
  it("looks up a provider by its env-var name", () => {
    expect(providerByEnvKey("OPENAI_API_KEY")?.prefix).toBe("openai");
    expect(providerByEnvKey("ANTHROPIC_API_KEY")?.prefix).toBe("anthropic");
    expect(providerByEnvKey("GROQ_API_KEY")?.prefix).toBe("groq");
    expect(providerByEnvKey("GEMINI_API_KEY")?.prefix).toBe("google");
    expect(providerByEnvKey("HF_TOKEN")?.prefix).toBe("huggingface");
  });

  it("returns undefined for unknown env vars", () => {
    expect(providerByEnvKey("FAKE_API_KEY")).toBeUndefined();
  });
});

describe("DEFAULT constants", () => {
  it("the default model is the registry's anthropic sample model", () => {
    expect(DEFAULT_MODEL).toBe("anthropic/claude-sonnet-4-6");
    expect(DEFAULT_MODEL.startsWith(`${DEFAULT_PROVIDER}/`)).toBe(true);
  });
});
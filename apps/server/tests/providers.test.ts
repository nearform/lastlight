import { describe, it, expect } from "vitest";
import {
  PROVIDERS,
  providerByPrefix,
  providerByEnvKey,
  PROVIDER_ENV_KEYS,
  PROVIDER_HOSTS,
  DEFAULT_MODEL,
  DEFAULT_PROVIDER,
  providerBaseUrlEnvVar,
  providerOverridesFromEnv,
  resolveProviderRegistry,
} from "lastlight-shared/providers";

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
describe("resolveProviderRegistry — endpoint overrides (issue #373)", () => {
  it("with no overrides, resolves to exactly the shipped registry", () => {
    const registry = resolveProviderRegistry();
    expect(registry.providers).toEqual(PROVIDERS);
    expect(registry.endpoints).toEqual([]);
    expect(registry.envKeys).toEqual(PROVIDER_ENV_KEYS);
    expect(registry.hosts).toEqual(PROVIDER_HOSTS);
  });

  it("moves a built-in provider's endpoint and follows it with the egress host", () => {
    const registry = resolveProviderRegistry({
      anthropic: { baseUrl: "https://gateway.internal/anthropic" },
    });
    const anthropic = registry.byPrefix("anthropic")!;
    expect(anthropic.baseUrl).toBe("https://gateway.internal/anthropic");
    // Everything else is inherited — the request shape and the key env var.
    expect(anthropic.api).toBe("anthropic-messages");
    expect(anthropic.envKey).toBe("ANTHROPIC_API_KEY");
    // The firewall has to follow the URL or the sandbox can't reach it.
    expect(registry.hosts).toContain("gateway.internal");
    expect(registry.hosts).not.toContain("anthropic.com");
    expect(registry.endpoints).toEqual([
      {
        prefix: "anthropic",
        baseUrl: "https://gateway.internal/anthropic",
        api: "anthropic-messages",
        envKey: "ANTHROPIC_API_KEY",
        custom: false,
        envKeyOverridden: false,
      },
    ]);
    // Untouched providers keep their defaults, in registry order.
    expect(registry.byPrefix("openai")!.baseUrl).toBe("https://api.openai.com/v1");
    expect(registry.providers.map((p) => p.prefix)).toEqual(PROVIDERS.map((p) => p.prefix));
  });

  it("adds a custom provider, deriving its env key and host, appended last", () => {
    const registry = resolveProviderRegistry({
      acme: { baseUrl: "https://llm.corp.example/v1/" },
    });
    const acme = registry.byPrefix("acme")!;
    expect(acme.baseUrl).toBe("https://llm.corp.example/v1"); // trailing slash stripped
    expect(acme.api).toBe("openai-completions"); // the default dialect
    expect(acme.envKey).toBe("ACME_API_KEY");
    expect(acme.host).toBe("llm.corp.example");
    expect(registry.envKeys).toContain("ACME_API_KEY");
    // Appended, so registry order still prefers the first-party providers a
    // deployment already has keys for (defaultFastModel walks this list).
    expect(registry.providers[registry.providers.length - 1].prefix).toBe("acme");
    expect(registry.endpoints[0].custom).toBe(true);
  });

  /**
   * The dialect is the one field a built-in override may NOT change: pi can
   * re-point a built-in provider's models but not re-declare their API family,
   * so honouring it in-process while the sandbox ignored it would split the two
   * halves of one deployment. Refusing names the coherent alternative instead.
   */
  it("refuses to change a built-in provider's api family, and points at the alternative", () => {
    expect(() =>
      resolveProviderRegistry({ anthropic: { baseUrl: "https://gw/v1", api: "openai-completions" } }),
    ).toThrow(/api cannot be changed.*declare a provider of your own/s);
    // Restating the built-in's own dialect is a no-op, not an error.
    expect(
      resolveProviderRegistry({ anthropic: { baseUrl: "https://gw/v1", api: "anthropic-messages" } })
        .byPrefix("anthropic")!.api,
    ).toBe("anthropic-messages");
  });

  it("tracks whether the deployment NAMED the key env var, which decides who resolves it", () => {
    // Endpoint moved only: pi/the SDK keeps resolving the credential, so an
    // OAuth subscription login on `anthropic` still works.
    const moved = resolveProviderRegistry({ anthropic: { baseUrl: "https://gw/v1" } });
    expect(moved.endpoints[0].envKeyOverridden).toBe(false);
    expect(moved.endpoints[0].envKey).toBe("ANTHROPIC_API_KEY");

    // Gateway holding its own credential: the key must be handed over explicitly.
    const custody = resolveProviderRegistry({
      anthropic: { baseUrl: "https://gw/v1", envKey: "GATEWAY_API_KEY" },
    });
    expect(custody.byPrefix("anthropic")!.envKey).toBe("GATEWAY_API_KEY");
    expect(custody.endpoints[0].envKeyOverridden).toBe(true);
    expect(custody.envKeys).toContain("GATEWAY_API_KEY");

    // A custom provider is always in the second camp — nothing else knows it.
    expect(resolveProviderRegistry({ acme: { baseUrl: "https://gw/v1" } }).endpoints[0].envKeyOverridden).toBe(true);
  });

  it("re-keying a built-in alone (no new URL) still registers as an endpoint override", () => {
    const registry = resolveProviderRegistry({ anthropic: { envKey: "GATEWAY_API_KEY" } });
    expect(registry.endpoints.map((e) => e.prefix)).toEqual(["anthropic"]);
    expect(registry.byPrefix("anthropic")!.baseUrl).toBe("https://api.anthropic.com/v1");
  });

  it("rejects a custom provider with no baseUrl — there is nothing to inherit", () => {
    expect(() => resolveProviderRegistry({ acme: { api: "openai-completions" } })).toThrow(
      /providers\.acme\.baseUrl is required/,
    );
  });

  it("rejects plaintext http on a non-loopback host, but allows a localhost gateway", () => {
    expect(() => resolveProviderRegistry({ anthropic: { baseUrl: "http://gw.internal/v1" } })).toThrow(
      /non-loopback host/,
    );
    expect(
      resolveProviderRegistry({ anthropic: { baseUrl: "http://localhost:4000/v1" } }).byPrefix("anthropic")!.baseUrl,
    ).toBe("http://localhost:4000/v1");
    // …and an operator who has decided their plaintext endpoint is fine can say so.
    expect(
      resolveProviderRegistry({ anthropic: { baseUrl: "http://gw.internal/v1" } }, { allowInsecure: true })
        .byPrefix("anthropic")!.baseUrl,
    ).toBe("http://gw.internal/v1");
  });

  it("rejects an unusable URL and an unusable prefix", () => {
    expect(() => resolveProviderRegistry({ anthropic: { baseUrl: "not a url" } })).toThrow(/not a valid URL/);
    expect(() => resolveProviderRegistry({ "Acme Corp": { baseUrl: "https://x/v1" } })).toThrow(
      /not a usable model-spec prefix/,
    );
  });
});

describe("providerOverridesFromEnv", () => {
  it("reads the per-provider base-URL vars the vendor SDKs already use", () => {
    expect(providerBaseUrlEnvVar("anthropic")).toBe("ANTHROPIC_BASE_URL");
    expect(providerBaseUrlEnvVar("openai")).toBe("OPENAI_BASE_URL");
    expect(providerBaseUrlEnvVar("kimi-coding")).toBe("KIMI_CODING_BASE_URL");
    expect(
      providerOverridesFromEnv({ ANTHROPIC_BASE_URL: "https://gw/anthropic", UNRELATED: "x" } as NodeJS.ProcessEnv),
    ).toEqual({ anthropic: { baseUrl: "https://gw/anthropic" } });
  });

  it("is empty on a plain environment — an unset deployment overrides nothing", () => {
    expect(providerOverridesFromEnv({} as NodeJS.ProcessEnv)).toEqual({});
  });
});

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { parseProviderOverrides } from "../src/providers.js";
import { registerProviderOverrides, resolveModel } from "../src/models.js";

describe("parseProviderOverrides", () => {
  test("parses a minimal override and strips trailing slashes", () => {
    const parsed = parseProviderOverrides('{"anthropic":{"baseUrl":"https://gw.internal/anthropic/"}}', "--providers");
    assert.deepEqual(parsed, { anthropic: { baseUrl: "https://gw.internal/anthropic" } });
  });

  test("carries the fields an unknown provider needs", () => {
    const parsed = parseProviderOverrides(
      '{"acme":{"baseUrl":"https://gw/v1","api":"openai-completions","apiKeyEnv":"ACME_API_KEY","contextWindow":32000}}',
      "--providers",
    );
    assert.deepEqual(parsed.acme, {
      baseUrl: "https://gw/v1",
      api: "openai-completions",
      apiKeyEnv: "ACME_API_KEY",
      contextWindow: 32000,
    });
  });

  // Throwing rather than warning is the point: a silently-dropped override
  // sends the prompt and the key to the vendor instead of the gateway.
  test("throws on malformed JSON, a non-object, or a missing baseUrl", () => {
    assert.throws(() => parseProviderOverrides("{", "--providers"), /must be JSON/);
    assert.throws(() => parseProviderOverrides('["a"]', "--providers"), /JSON object/);
    assert.throws(() => parseProviderOverrides('{"acme":{"api":"openai-completions"}}', "--providers"), /baseUrl is required/);
  });
});

/** Minimal stand-in for pi's ModelRegistry — records what was registered. */
function fakeRegistry(models: Record<string, unknown> = {}) {
  const registered: Array<[string, any]> = [];
  return {
    registered,
    registerProvider(prefix: string, config: unknown) {
      registered.push([prefix, config]);
    },
    find(provider: string, modelId: string) {
      return models[`${provider}/${modelId}`];
    },
  } as any;
}

describe("registerProviderOverrides", () => {
  test("a known provider is moved with a baseUrl-only registration", () => {
    const registry = fakeRegistry();
    registerProviderOverrides(
      registry,
      { anthropic: { baseUrl: "https://gw.internal/anthropic" } },
      "anthropic/claude-haiku-4-5-20251001",
    );
    assert.deepEqual(registry.registered, [["anthropic", { baseUrl: "https://gw.internal/anthropic" }]]);
  });

  test("an unknown provider registers the model being run, with an $ENV key reference", () => {
    const registry = fakeRegistry();
    registerProviderOverrides(
      registry,
      { acme: { baseUrl: "https://gw/v1", api: "openai-completions" } },
      "acme/my-model",
    );
    const [prefix, config] = registry.registered[0];
    assert.equal(prefix, "acme");
    assert.equal(config.baseUrl, "https://gw/v1");
    // The key is referenced, never embedded — pi resolves $VAR at request time.
    assert.equal(config.apiKey, "$ACME_API_KEY");
    assert.equal(config.models[0].id, "my-model");
    assert.equal(config.models[0].baseUrl, "https://gw/v1");
    // A gateway publishes no price list, so we report no spend rather than a wrong one.
    assert.deepEqual(config.models[0].cost, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  test("a broken override for the model being run fails the run, not silently", () => {
    const registry = {
      registerProvider() {
        throw new Error("nope");
      },
    } as any;
    assert.throws(
      () => registerProviderOverrides(registry, { acme: { baseUrl: "https://gw/v1" } }, "acme/m"),
      /provider override for 'acme' rejected/,
    );
  });
});

describe("resolveModel with an override", () => {
  test("prefers the registry over the static catalog for an overridden provider", () => {
    const moved = { id: "claude-haiku-4-5-20251001", baseUrl: "https://gw.internal/anthropic" };
    const registry = fakeRegistry({ "anthropic/claude-haiku-4-5-20251001": moved });
    const model = resolveModel("anthropic/claude-haiku-4-5-20251001", registry, {
      anthropic: { baseUrl: "https://gw.internal/anthropic" },
    });
    assert.equal(model.baseUrl, "https://gw.internal/anthropic");
  });

  test("with no override, the built-in catalog still wins", () => {
    const registry = fakeRegistry();
    const model = resolveModel("anthropic/claude-haiku-4-5-20251001", registry);
    assert.equal(model.provider, "anthropic");
    assert.match(model.baseUrl, /anthropic\.com/);
  });
});

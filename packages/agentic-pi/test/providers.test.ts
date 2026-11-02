import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ModelRegistry, ModelRuntime } from "@earendil-works/pi-coding-agent";

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

  test("carries literal headers", () => {
    const parsed = parseProviderOverrides('{"acme":{"baseUrl":"https://gw/v1","headers":{"x-retention":"none"}}}', "--providers");
    assert.deepEqual(parsed.acme.headers, { "x-retention": "none" });
  });

  // pi resolves header values itself: a leading "!" runs a shell command and
  // "$NAME" expands an env var, so anything but a literal is refused.
  test("throws on a header pi would run or expand, and on a malformed headers map", () => {
    const withHeaders = (headers: unknown) => () =>
      parseProviderOverrides(JSON.stringify({ acme: { baseUrl: "https://gw/v1", headers } }), "--providers");
    assert.throws(withHeaders({ "x-flag": "!id" }), /--providers\.acme\.headers\.x-flag must be a literal value/);
    assert.throws(withHeaders({ "x-flag": "$GITHUB_TOKEN" }), /must be a literal value/);
    assert.throws(withHeaders({ "x-flag": 1 }), /must be a string/);
    assert.throws(withHeaders(["x-flag"]), /must be an object/);
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

  test("a known provider gets an explicit key ONLY when the caller named one", () => {
    // Named: the gateway holds its own credential.
    const named = fakeRegistry();
    registerProviderOverrides(
      named,
      { anthropic: { baseUrl: "https://gw/anthropic", apiKeyEnv: "GATEWAY_API_KEY" } },
      "anthropic/claude-haiku-4-5-20251001",
    );
    assert.deepEqual(named.registered[0][1], {
      baseUrl: "https://gw/anthropic",
      apiKey: "$GATEWAY_API_KEY",
    });

    // Not named (the endpoint merely moved): pi keeps resolving the credential
    // itself, which is what lets an OAuth subscription login keep working.
    const plain = fakeRegistry();
    registerProviderOverrides(
      plain,
      { anthropic: { baseUrl: "https://gw/anthropic" } },
      "anthropic/claude-haiku-4-5-20251001",
    );
    assert.equal("apiKey" in plain.registered[0][1], false);
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

  test("a known provider running a model pi has no entry for is defined outright", () => {
    // A gateway exposing its own fine-tune under a familiar prefix: there is no
    // catalog entry to re-point, so the model is registered like a custom one —
    // with the provider's normal key env var.
    const registry = fakeRegistry();
    registerProviderOverrides(
      registry,
      { anthropic: { baseUrl: "https://gw/anthropic", api: "anthropic-messages" } },
      "anthropic/my-tuned-claude",
    );
    const config = registry.registered[0][1];
    assert.equal(config.apiKey, "$ANTHROPIC_API_KEY");
    assert.equal(config.models[0].id, "my-tuned-claude");
    assert.equal(config.models[0].api, "anthropic-messages");
  });

  test("headers are registered with the provider, whichever shape it takes", () => {
    const headers = { "x-retention": "none" };
    const custom = fakeRegistry();
    registerProviderOverrides(custom, { acme: { baseUrl: "https://gw/v1", headers } }, "acme/my-model");
    assert.deepEqual(custom.registered[0][1].headers, headers);

    const known = fakeRegistry();
    registerProviderOverrides(known, { anthropic: { baseUrl: "https://gw/anthropic", headers } }, "anthropic/claude-haiku-4-5-20251001");
    assert.deepEqual(known.registered[0][1], { baseUrl: "https://gw/anthropic", headers });
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

/**
 * pi applies provider headers when it builds the request, not on the resolved
 * model, so the only proof they are sent is a request. A local server stands in
 * for the gateway; nothing leaves the machine.
 */
describe("provider headers on the wire", () => {
  test("a registered header reaches the gateway through pi's real request path", async () => {
    let seen: http.IncomingHttpHeaders | undefined;
    const server = http.createServer((req, res) => {
      seen = req.headers;
      res.setHeader("content-type", "text/event-stream");
      const chunk = {
        id: "c",
        object: "chat.completion.chunk",
        created: 0,
        model: "my-model",
        choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: "stop" }],
      };
      res.end(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const { port } = server.address() as AddressInfo;
    const keyEnv = "AGENTIC_PI_TEST_GATEWAY_KEY";
    process.env[keyEnv] = "test-key";
    try {
      const runtime = await ModelRuntime.create({
        authPath: join(mkdtempSync(join(tmpdir(), "agentic-pi-headers-")), "auth.json"),
      });
      const registry = new ModelRegistry(runtime);
      const overrides = {
        acme: {
          baseUrl: `http://127.0.0.1:${port}/v1`,
          api: "openai-completions",
          apiKeyEnv: keyEnv,
          headers: { "x-retention": "none" },
        },
      };
      registerProviderOverrides(registry, overrides, "acme/my-model");
      await registry.refresh();
      const model = resolveModel("acme/my-model", registry, overrides);
      const reply = await registry.complete(model, { messages: [{ role: "user", content: "hi", timestamp: Date.now() }] });

      assert.equal(reply.stopReason, "stop");
      assert.equal(seen?.["x-retention"], "none");
      assert.equal(seen?.authorization, "Bearer test-key");
    } finally {
      delete process.env[keyEnv];
      server.close();
    }
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

import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { cacheWarmingVeto } from "../src/cache-warming.js";

function register(factory: NonNullable<ReturnType<typeof cacheWarmingVeto>>) {
  const handlers = new Map<string, (event: unknown) => unknown>();
  const pi = { on: (name: string, h: (event: unknown) => unknown) => handlers.set(name, h) };
  factory(pi as unknown as ExtensionAPI);
  return handlers;
}

describe("cacheWarmingVeto", () => {
  test("no operator mode → every warming refresh is stopped", async () => {
    const factory = cacheWarmingVeto(undefined);
    assert.ok(factory);
    const handler = register(factory).get("cache_warming_decision");
    assert.ok(handler, "registers a cache_warming_decision handler");
    const result = await handler({ type: "cache_warming_decision", action: "warm" });
    assert.deepEqual(result, { action: "stop" });
  });

  test("an explicit operator mode is left alone", () => {
    assert.equal(cacheWarmingVeto("streaming"), undefined);
    assert.equal(cacheWarmingVeto("idle"), undefined);
    assert.equal(cacheWarmingVeto("off"), undefined);
  });
});

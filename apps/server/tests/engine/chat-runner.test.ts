import { describe, it, expect, vi, afterEach } from "vitest";
import type { AssistantMessage, Api, Context, Model, SimpleStreamOptions } from "@earendil-works/pi-ai";
import {
  completeWithRetry,
  endpointApiKey,
  isRetryableModelError,
  resolveModel,
} from "#src/engine/chat/chat-runner.js";
import { installProviderOverrides, resetProviderRegistry } from "#src/config/provider-registry.js";

// Minimal stand-ins — the helper only ever forwards these to `complete`.
const model = {} as Model<Api>;
const context = { messages: [] } as unknown as Context;
const opts = {} as SimpleStreamOptions;

function ok(text = "hi"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  } as unknown as AssistantMessage;
}

function erroredAssistant(message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    stopReason: "error",
    errorMessage: message,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  } as unknown as AssistantMessage;
}

const noSleep = () => Promise.resolve();
const delays = [10, 20, 30];

describe("isRetryableModelError", () => {
  it("matches rate limits and transient server/network errors", () => {
    for (const m of [
      '429 {"error":{"code":"RATE_LIMIT_EXCEEDED"}}',
      "You have exceeded your rate limit for this API",
      "Error: overloaded_error",
      "503 Service Unavailable",
      "502 Bad Gateway",
      "fetch failed",
      "ETIMEDOUT",
    ]) {
      expect(isRetryableModelError(m)).toBe(true);
    }
  });

  it("does NOT match auth / validation / overflow (non-transient)", () => {
    for (const m of [
      "401 Unauthorized",
      "403 Resource not accessible by integration",
      "400 invalid_request_error",
      "context length exceeded",
      "Unknown chat model",
    ]) {
      expect(isRetryableModelError(m)).toBe(false);
    }
  });
});

describe("completeWithRetry", () => {
  it("returns immediately on success (no retries)", async () => {
    const complete = vi.fn().mockResolvedValue(ok());
    const onRetry = vi.fn();
    const res = await completeWithRetry(complete, model, context, opts, { delaysMs: delays, sleepFn: noSleep, onRetry });
    expect(res.stopReason).toBe("stop");
    expect(complete).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("retries a thrown 429 then succeeds, backing off per the schedule", async () => {
    const complete = vi
      .fn()
      .mockRejectedValueOnce(new Error('429 {"code":"RATE_LIMIT_EXCEEDED"}'))
      .mockResolvedValueOnce(ok("recovered"));
    const slept: number[] = [];
    const sleepFn = (ms: number) => { slept.push(ms); return Promise.resolve(); };
    const res = await completeWithRetry(complete, model, context, opts, { delaysMs: delays, sleepFn });
    expect(res.stopReason).toBe("stop");
    expect(complete).toHaveBeenCalledTimes(2);
    expect(slept).toEqual([10]); // first backoff only
  });

  it("retries an errored-assistant 429 (non-throw shape)", async () => {
    const complete = vi
      .fn()
      .mockResolvedValueOnce(erroredAssistant("rate limit exceeded"))
      .mockResolvedValueOnce(ok());
    const res = await completeWithRetry(complete, model, context, opts, { delaysMs: delays, sleepFn: noSleep });
    expect(res.stopReason).toBe("stop");
    expect(complete).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry a non-retryable thrown error", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("401 Unauthorized"));
    await expect(
      completeWithRetry(complete, model, context, opts, { delaysMs: delays, sleepFn: noSleep }),
    ).rejects.toThrow("401");
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("gives up after exhausting the backoff schedule and rethrows the last error", async () => {
    const complete = vi.fn().mockRejectedValue(new Error("429 rate limit"));
    const slept: number[] = [];
    await expect(
      completeWithRetry(complete, model, context, opts, {
        delaysMs: delays,
        sleepFn: (ms) => { slept.push(ms); return Promise.resolve(); },
      }),
    ).rejects.toThrow("429");
    expect(complete).toHaveBeenCalledTimes(delays.length + 1); // initial + 3 retries
    expect(slept).toEqual(delays);
  });

  it("returns the errored assistant unchanged when retries are exhausted (non-throw shape)", async () => {
    const complete = vi.fn().mockResolvedValue(erroredAssistant("429 rate limit"));
    const res = await completeWithRetry(complete, model, context, opts, { delaysMs: [5], sleepFn: noSleep });
    expect(res.stopReason).toBe("error");
    expect(complete).toHaveBeenCalledTimes(2); // initial + 1 retry, then surfaces the errored assistant
  });
});

/**
 * The chat path is the one an operator meets a gateway through most directly:
 * the model call happens host-side, so the endpoint AND the credential are
 * resolved here rather than by pi-ai's own machinery (issue #373).
 */
describe("chat model resolution with a provider endpoint override", () => {
  afterEach(() => {
    resetProviderRegistry();
    delete process.env.ACME_API_KEY;
    delete process.env.GATEWAY_API_KEY;
  });

  it("with no override, resolves the catalog model untouched", () => {
    const resolved = resolveModel("anthropic/claude-haiku-4-5-20251001");
    expect(resolved.provider).toBe("anthropic");
    expect(resolved.baseUrl).toMatch(/anthropic\.com/);
  });

  it("re-points a known provider's model at the gateway, keeping its dialect", () => {
    installProviderOverrides({ anthropic: { baseUrl: "https://gateway.internal/anthropic" } });
    const resolved = resolveModel("anthropic/claude-haiku-4-5-20251001");
    expect(resolved.baseUrl).toBe("https://gateway.internal/anthropic");
    // The catalog model is otherwise intact — same api family as llm.ts will use.
    expect(resolved.api).toBe("anthropic-messages");
    expect(resolved.id).toBe("claude-haiku-4-5-20251001");
  });

  it("synthesizes a model for a provider pi-ai has never heard of", () => {
    installProviderOverrides({
      acme: { baseUrl: "https://llm.corp.example/v1", contextWindow: 32_000, maxTokens: 4_096 },
    });
    const resolved = resolveModel("acme/my-model");
    expect(resolved).toMatchObject({
      id: "my-model",
      provider: "acme",
      api: "openai-completions",
      baseUrl: "https://llm.corp.example/v1",
      contextWindow: 32_000,
      maxTokens: 4_096,
    });
    // A gateway publishes no price list, so a chat turn reports no spend rather
    // than a wrong one.
    expect(resolved.cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  });

  it("honours the declared dialect when the gateway speaks Anthropic", () => {
    installProviderOverrides({ acme: { baseUrl: "https://gw/anthropic", api: "anthropic-messages" } });
    expect(resolveModel("acme/my-model").api).toBe("anthropic-messages");
  });

  it("still fails loudly for a model nobody declared", () => {
    expect(() => resolveModel("openai/not-a-real-model-id")).toThrow(/Unknown chat model/);
    expect(() => resolveModel("no-slash")).toThrow(/must be 'provider\/id'/);
  });
});

describe("endpointApiKey", () => {
  afterEach(() => {
    resetProviderRegistry();
    delete process.env.ACME_API_KEY;
    delete process.env.GATEWAY_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
  });

  it("reads the env var a custom provider's entry names", () => {
    installProviderOverrides({ acme: { baseUrl: "https://gw/v1" } });
    process.env.ACME_API_KEY = "custom-key";
    expect(endpointApiKey("acme")).toBe("custom-key");
  });

  it("reads a re-keyed built-in — a gateway holding its own credential", () => {
    installProviderOverrides({ anthropic: { baseUrl: "https://gw/v1", envKey: "GATEWAY_API_KEY" } });
    process.env.GATEWAY_API_KEY = "gw-key";
    expect(endpointApiKey("anthropic")).toBe("gw-key");
  });

  /**
   * The load-bearing negative: handing pi-ai a key here would bypass its own
   * resolution, and with it the OAuth subscription logins (Claude Pro/Max,
   * Codex, Copilot) that the chat path exists to support.
   */
  it("returns nothing when the endpoint merely moved, leaving pi-ai to resolve auth", () => {
    installProviderOverrides({ anthropic: { baseUrl: "https://gw/v1" } });
    process.env.ANTHROPIC_API_KEY = "vendor-key";
    expect(endpointApiKey("anthropic")).toBeUndefined();
  });

  it("returns nothing for an unconfigured provider, or a named var that is unset", () => {
    expect(endpointApiKey("anthropic")).toBeUndefined();
    installProviderOverrides({ acme: { baseUrl: "https://gw/v1" } });
    expect(endpointApiKey("acme")).toBeUndefined();
  });
});

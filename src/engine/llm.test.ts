import { describe, it, expect, afterEach, vi } from "vitest";
import { callLlm, chat, defaultFastModel, resolveProvider } from "./llm.js";

describe("resolveProvider", () => {
  it("prefers explicit provider prefix", () => {
    expect(resolveProvider("anthropic/claude-haiku-4-5")).toEqual({ provider: "anthropic", modelId: "claude-haiku-4-5" });
    expect(resolveProvider("openai/gpt-4o-mini")).toEqual({ provider: "openai", modelId: "gpt-4o-mini" });
  });
  it("keeps the nested vendor/model tail for openrouter ids", () => {
    expect(resolveProvider("openrouter/anthropic/claude-sonnet-4.5"))
      .toEqual({ provider: "openrouter", modelId: "anthropic/claude-sonnet-4.5" });
    expect(resolveProvider("openrouter/google/gemini-2.5-flash"))
      .toEqual({ provider: "openrouter", modelId: "google/gemini-2.5-flash" });
  });
  it("infers from common naming for unprefixed model ids", () => {
    expect(resolveProvider("claude-3-5-haiku")).toEqual({ provider: "anthropic", modelId: "claude-3-5-haiku" });
    expect(resolveProvider("gpt-4o-mini")).toEqual({ provider: "openai", modelId: "gpt-4o-mini" });
  });
  it("falls back to openai for unrecognized bare ids", () => {
    expect(resolveProvider("mystery-model")).toEqual({ provider: "openai", modelId: "mystery-model" });
  });
  it("throws on an explicit unsupported provider prefix instead of silently mis-routing", () => {
    expect(() => resolveProvider("mistral/large-latest")).toThrow(/unsupported provider prefix "mistral"/);
    expect(() => resolveProvider("google/gemini-pro")).toThrow(/unsupported provider prefix "google"/);
  });
});

describe("defaultFastModel", () => {
  const ORIGINAL_ENV = { ...process.env };
  afterEach(() => { process.env = { ...ORIGINAL_ENV }; });

  it("picks an OpenAI model when only OPENAI_API_KEY is set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENAI_API_KEY = "k";
    delete process.env.OPENCODE_MODELS;
    expect(defaultFastModel()).toMatch(/^openai\//);
  });

  it("picks an Anthropic model when only ANTHROPIC_API_KEY is set", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.OPENCODE_MODELS;
    expect(defaultFastModel()).toMatch(/^anthropic\//);
  });

  it("picks an OpenRouter model when only OPENROUTER_API_KEY is set", () => {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    process.env.OPENROUTER_API_KEY = "sk-or-k";
    delete process.env.OPENCODE_MODELS;
    expect(defaultFastModel()).toMatch(/^openrouter\//);
  });

  it("prefers Anthropic over OpenRouter when both are set (avoids markup)", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.OPENROUTER_API_KEY = "sk-or-k";
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENCODE_MODELS;
    expect(defaultFastModel()).toMatch(/^anthropic\//);
  });

  it("uses the first registry provider when all keys are set", () => {
    process.env.ANTHROPIC_API_KEY = "k";
    process.env.OPENAI_API_KEY = "k";
    process.env.OPENROUTER_API_KEY = "sk-or-k";
    delete process.env.OPENCODE_MODELS;
    expect(defaultFastModel()).toMatch(/^anthropic\//);
  });

  it("honors per-task OPENCODE_MODELS overrides", () => {
    process.env.OPENAI_API_KEY = "k";
    process.env.OPENCODE_MODELS = JSON.stringify({ classifier: "openai/custom-mini" });
    expect(defaultFastModel("classifier")).toBe("openai/custom-mini");
    expect(defaultFastModel("screener")).toMatch(/^openai\//);
  });

  it("ignores invalid OPENCODE_MODELS JSON", () => {
    process.env.OPENAI_API_KEY = "k";
    delete process.env.ANTHROPIC_API_KEY;
    process.env.OPENCODE_MODELS = "not-json";
    expect(defaultFastModel("classifier")).toMatch(/^openai\//);
  });
});

describe("chat", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws when the relevant API key is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(chat("anthropic/claude-haiku-4-5", [{ role: "system", content: "sys" }, { role: "user", content: "hi" }])).rejects.toThrow(/ANTHROPIC_API_KEY/);
    delete process.env.OPENAI_API_KEY;
    await expect(chat("openai/gpt-4o-mini", [{ role: "system", content: "sys" }, { role: "user", content: "hi" }])).rejects.toThrow(/OPENAI_API_KEY/);
    delete process.env.OPENROUTER_API_KEY;
    await expect(chat("openrouter/google/gemini-2.5-flash", [{ role: "system", content: "sys" }, { role: "user", content: "hi" }])).rejects.toThrow(/OPENROUTER_API_KEY/);
  });

  it("hits the Anthropic endpoint and extracts text from content blocks", async () => {
    process.env.ANTHROPIC_API_KEY = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({
        content: [
          { type: "text", text: "hello " },
          { type: "text", text: "world" },
          { type: "tool_use", text: "ignored" },
        ],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const out = await chat("claude-haiku-4-5", [{ role: "system", content: "sys" }, { role: "user", content: "user" }]);
    expect(out).toBe("hello world");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.anthropic.com/v1/messages");
    expect((init as RequestInit).headers).toMatchObject({ "x-api-key": "test-key" });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("claude-haiku-4-5");
    expect(body.system).toBe("sys");
    expect(body.messages).toEqual([{ role: "user", content: "user" }]);
  });

  it("hits the OpenAI endpoint and extracts choices[0].message.content", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({
        choices: [{ message: { content: "ok" } }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const out = await chat("openai/gpt-4o-mini", [{ role: "system", content: "sys" }, { role: "user", content: "user" }]);
    expect(out).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer test-key" });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.max_completion_tokens).toBe(256);
    expect(body.max_tokens).toBeUndefined();
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "user" },
    ]);
  });

  it("hits the OpenRouter endpoint, sends the nested vendor/model tail, and uses max_tokens", async () => {
    process.env.OPENROUTER_API_KEY = "sk-or-test";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({
        choices: [{ message: { content: "routed" } }],
      }), { status: 200, headers: { "content-type": "application/json" } }),
    );
    const out = await chat("openrouter/anthropic/claude-sonnet-4.5", [{ role: "system", content: "sys" }, { role: "user", content: "user" }]);
    expect(out).toBe("routed");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer sk-or-test" });
    const body = JSON.parse((init as RequestInit).body as string);
    // The "openrouter/" prefix is stripped but the nested vendor/model tail
    // is preserved verbatim — that's the id OpenRouter's API expects.
    expect(body.model).toBe("anthropic/claude-sonnet-4.5");
    // OpenRouter forwards to many providers — use the cross-provider field,
    // not OpenAI's newer `max_completion_tokens`.
    expect(body.max_tokens).toBe(256);
    expect(body.max_completion_tokens).toBeUndefined();
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "user" },
    ]);
  });

  it("throws on non-2xx upstream after exhausting the retry", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }));
    await expect(chat("openai/gpt-4o-mini", [{ role: "system", content: "s" }, { role: "user", content: "u" }])).rejects.toThrow(/429/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries transient 429/5xx once and returns the second response", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response("rate limited", { status: 429 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
    const out = await chat("openai/gpt-4o-mini", [{ role: "system", content: "s" }, { role: "user", content: "u" }]);
    expect(out).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry deterministic 4xx errors (e.g. 400 bad request)", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("bad model id", { status: 400 }),
    );
    await expect(chat("openai/gpt-4o-mini", [{ role: "system", content: "s" }, { role: "user", content: "u" }])).rejects.toThrow(/400/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("callLlm delegates to chat-equivalent behavior", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ choices: [{ message: { content: "delegated" } }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(callLlm("openai/gpt-4o-mini", "s", "u")).resolves.toBe("delegated");
  });
});

import { describe, it, expect, afterEach, vi } from "vitest";
import { callLlm, resolveProvider } from "./llm.js";

describe("resolveProvider", () => {
  it("prefers explicit provider prefix", () => {
    expect(resolveProvider("anthropic/claude-haiku-4-5")).toEqual({ provider: "anthropic", modelId: "claude-haiku-4-5" });
    expect(resolveProvider("openai/gpt-4o-mini")).toEqual({ provider: "openai", modelId: "gpt-4o-mini" });
  });
  it("infers from common naming for unprefixed model ids", () => {
    expect(resolveProvider("claude-3-5-haiku")).toEqual({ provider: "anthropic", modelId: "claude-3-5-haiku" });
    expect(resolveProvider("gpt-4o-mini")).toEqual({ provider: "openai", modelId: "gpt-4o-mini" });
  });
  it("falls back to openai for unrecognized bare ids", () => {
    expect(resolveProvider("mystery-model")).toEqual({ provider: "openai", modelId: "mystery-model" });
  });
});

describe("callLlm", () => {
  const ORIGINAL_ENV = { ...process.env };

  afterEach(() => {
    vi.restoreAllMocks();
    process.env = { ...ORIGINAL_ENV };
  });

  it("throws when the relevant API key is missing", async () => {
    delete process.env.ANTHROPIC_API_KEY;
    await expect(callLlm("anthropic/claude-haiku-4-5", "sys", "hi")).rejects.toThrow(/ANTHROPIC_API_KEY/);
    delete process.env.OPENAI_API_KEY;
    await expect(callLlm("openai/gpt-4o-mini", "sys", "hi")).rejects.toThrow(/OPENAI_API_KEY/);
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
    const out = await callLlm("claude-haiku-4-5", "sys", "user");
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
    const out = await callLlm("openai/gpt-4o-mini", "sys", "user");
    expect(out).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/chat/completions");
    expect((init as RequestInit).headers).toMatchObject({ authorization: "Bearer test-key" });
    const body = JSON.parse((init as RequestInit).body as string);
    expect(body.model).toBe("gpt-4o-mini");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "user" },
    ]);
  });

  it("throws on non-2xx upstream", async () => {
    process.env.OPENAI_API_KEY = "test-key";
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("rate limited", { status: 429 }),
    );
    await expect(callLlm("openai/gpt-4o-mini", "s", "u")).rejects.toThrow(/429/);
  });
});

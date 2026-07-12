/**
 * ChatRunner OAuth wiring — the three decisions the chat path makes per turn:
 *   1. OAuth-only model (Codex) with NO stored login → fail the turn with an
 *      actionable "run: lastlight oauth login …" error, without calling the model.
 *   2. OAuth model WITH a login → resolve a token and pass it as the per-call
 *      `apiKey` to the model.
 *   3. API-key-capable model (Anthropic) with no login → fall through to normal
 *      env-key auth (no apiKey injected, model IS called).
 *
 * pi-ai is mocked so `getModel` returns a stub and `completeSimple` captures the
 * options it's handed. Only `resolveOAuthApiKey` is stubbed on the oauth module
 * (everything else there stays real via importActual), so the prefix→provider
 * mapping and OAUTH_ONLY gating under test are the production ones.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AssistantMessage } from "@earendil-works/pi-ai";

// ── mock pi-ai: stub getModel + capture completeSimple's options ────────────
const completeSimpleSpy = vi.fn();
vi.mock("@earendil-works/pi-ai", () => ({
  getModel: (provider: string, id: string) => ({ provider, model: id, api: "faux", baseUrl: "x" }),
  completeSimple: (...args: unknown[]) => completeSimpleSpy(...args),
}));

// ── mock only resolveOAuthApiKey on the oauth module ────────────────────────
const resolveOAuthApiKeySpy = vi.fn();
vi.mock("#src/engine/oauth.js", async (importActual) => {
  const actual = await importActual<typeof import("#src/engine/oauth.js")>();
  return { ...actual, resolveOAuthApiKey: (...a: unknown[]) => resolveOAuthApiKeySpy(...a) };
});

const { ChatRunner } = await import("#src/engine/chat/chat-runner.js");

/** Minimal in-memory SessionManager stand-in (the five methods ChatRunner calls). */
function fakeSessionManager() {
  const agentIds = new Map<string, string | null>();
  return {
    getSession: (id: string) => ({ id, agentSessionId: agentIds.get(id) ?? null }),
    setAgentSessionId: (id: string, aid: string | null) => agentIds.set(id, aid),
    getHistory: () => [],
    addMessage: () => {},
    touchSession: () => {},
  } as any;
}

function okAssistant(text = "hi"): AssistantMessage {
  return {
    role: "assistant",
    content: [{ type: "text", text }],
    stopReason: "stop",
    usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: { total: 0 } },
  } as unknown as AssistantMessage;
}

function runnerFor(model: string) {
  return new ChatRunner({ model, systemPrompt: "sys" }, fakeSessionManager());
}

beforeEach(() => {
  completeSimpleSpy.mockReset().mockResolvedValue(okAssistant());
  resolveOAuthApiKeySpy.mockReset();
});
afterEach(() => vi.restoreAllMocks());

describe("ChatRunner OAuth wiring", () => {
  it("fails with an actionable error when an OAuth-only model has no login", async () => {
    resolveOAuthApiKeySpy.mockResolvedValue(null); // not logged in
    const res = await runnerFor("openai-codex/gpt-5.4").turn("sess-1", "hello");
    expect(res.finish).toBe("error");
    expect(res.errors[0]).toContain("requires an OAuth login");
    expect(res.errors[0]).toContain("lastlight oauth login openai-codex");
    // The model must NOT be called when auth is missing.
    expect(completeSimpleSpy).not.toHaveBeenCalled();
  });

  it("passes the resolved OAuth token as the per-call apiKey", async () => {
    resolveOAuthApiKeySpy.mockResolvedValue({ apiKey: "codex-tok-123", credentials: {} });
    const res = await runnerFor("openai-codex/gpt-5.4").turn("sess-2", "hello");
    expect(res.finish).toBe("stop");
    expect(completeSimpleSpy).toHaveBeenCalledTimes(1);
    const opts = completeSimpleSpy.mock.calls[0][2] as { apiKey?: string };
    expect(opts.apiKey).toBe("codex-tok-123");
  });

  it("falls through to env-key auth for a non-OAuth-only model with no login", async () => {
    resolveOAuthApiKeySpy.mockResolvedValue(null); // no anthropic OAuth creds
    const res = await runnerFor("anthropic/claude-sonnet-4-6").turn("sess-3", "hello");
    // Model IS called (no hard failure), and no apiKey is injected.
    expect(res.finish).toBe("stop");
    expect(completeSimpleSpy).toHaveBeenCalledTimes(1);
    const opts = completeSimpleSpy.mock.calls[0][2] as { apiKey?: string };
    expect(opts.apiKey).toBeUndefined();
  });

  it("does not touch OAuth resolution for a plain API-key provider", async () => {
    const res = await runnerFor("openai/gpt-5.5").turn("sess-4", "hello");
    expect(res.finish).toBe("stop");
    expect(resolveOAuthApiKeySpy).not.toHaveBeenCalled();
    const opts = completeSimpleSpy.mock.calls[0][2] as { apiKey?: string };
    expect(opts.apiKey).toBeUndefined();
  });

  it("fails the turn if OAuth refresh throws (expired/revoked grant)", async () => {
    resolveOAuthApiKeySpy.mockRejectedValue(new Error("Failed to refresh OAuth token for openai-codex"));
    const res = await runnerFor("openai-codex/gpt-5.4").turn("sess-5", "hello");
    expect(res.finish).toBe("error");
    expect(res.errors[0]).toContain("OAuth token refresh failed");
    expect(completeSimpleSpy).not.toHaveBeenCalled();
  });
});

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  OpencodeChatServer,
  buildChatAgentDef,
  parseTurnResult,
  splitModel,
} from "./opencode-chat-server.js";

/**
 * Fixture captured live in `.spike/PHASE0-FINDINGS.md` from a real
 * `opencode serve` two-turn probe. Trimmed to one part each so the
 * shape stays readable but covers the parser's failure modes.
 */
const TURN_FIXTURE = {
  info: {
    parentID: "msg_e407e269f001uPUrO5L2r0mTkM",
    role: "assistant",
    cost: 0,
    tokens: { total: 9166, input: 7587, output: 28, reasoning: 15, cache: { write: 0, read: 1536 } },
    modelID: "gpt-5.3-codex",
    providerID: "openai",
    finish: "stop",
    id: "msg_e407e26dd001BoZbbCtvF1uQgL",
    sessionID: "ses_1bf81dd80ffeBJANDPQ5dQlMkb",
  },
  parts: [
    { type: "step-start" },
    { type: "text", text: "Got it — teal is your favorite color." },
    { type: "step-finish", tokens: { input: 7587, output: 28 }, cost: 0, reason: "stop" },
  ],
};

describe("buildChatAgentDef", () => {
  const def = buildChatAgentDef() as { permission: Record<string, string>; mode: string };

  it("runs as a primary agent so postMessage can target it directly", () => {
    expect(def.mode).toBe("primary");
  });

  it("denies every host-side tool that could touch ~/.gitconfig or the filesystem", () => {
    for (const t of ["bash", "edit", "write", "patch", "webfetch", "websearch", "task", "skill", "todowrite", "repo_clone", "repo_overview", "external_directory"]) {
      expect(def.permission[t]).toBe("deny");
    }
  });

  it("denies destructive github_* tools (code / branch / PR mutation)", () => {
    for (const t of [
      "github_clone_repo",
      "github_create_branch",
      "github_push_files",
      "github_create_or_update_file",
      "github_setup_git_auth",
      "github_refresh_git_auth",
      "github_merge_pull_request",
      "github_create_pull_request",
      "github_create_pull_request_review",
    ]) {
      expect(def.permission[t]).toBe("deny");
    }
  });

  it("allows the read-only host tools the chat skill needs for narrow lookups", () => {
    expect(def.permission.read).toBe("allow");
    expect(def.permission.glob).toBe("allow");
    expect(def.permission.grep).toBe("allow");
    expect(def.permission.list).toBe("allow");
  });
});

describe("splitModel", () => {
  it("splits provider/model", () => {
    expect(splitModel("openai/gpt-5.3-codex")).toEqual({
      providerID: "openai",
      modelID: "gpt-5.3-codex",
    });
  });
  it("defaults provider to openai for bare model strings", () => {
    expect(splitModel("gpt-4")).toEqual({ providerID: "openai", modelID: "gpt-4" });
  });
  it("splits on the FIRST slash only (preserves nested ids)", () => {
    expect(splitModel("anthropic/claude/v2")).toEqual({
      providerID: "anthropic",
      modelID: "claude/v2",
    });
  });
});

describe("parseTurnResult", () => {
  it("extracts the assistant text from text parts", () => {
    const r = parseTurnResult(TURN_FIXTURE, "fallback-id", "m", "p", 1234);
    expect(r.text).toBe("Got it — teal is your favorite color.");
  });
  it("carries tokens + cost + finish from info", () => {
    const r = parseTurnResult(TURN_FIXTURE, "x", "x", "x", 1);
    expect(r.cost).toBe(0);
    expect(r.tokens.input).toBe(7587);
    expect(r.tokens.cacheRead).toBe(1536);
    expect(r.finish).toBe("stop");
  });
  it("uses sessionID from info if present, falls back otherwise", () => {
    const r = parseTurnResult(TURN_FIXTURE, "fallback", "m", "p", 1);
    expect(r.sessionId).toBe("ses_1bf81dd80ffeBJANDPQ5dQlMkb");
    const r2 = parseTurnResult({ info: {}, parts: [] }, "fallback", "m", "p", 1);
    expect(r2.sessionId).toBe("fallback");
  });
  it("joins multiple text parts in order", () => {
    const r = parseTurnResult({
      info: { finish: "stop" },
      parts: [
        { type: "text", text: "hello " },
        { type: "tool", tool: "read", callID: "c1", state: { status: "completed", output: "x" } },
        { type: "text", text: "world" },
      ],
    }, "s", "m", "p", 1);
    expect(r.text).toBe("hello world");
  });
  it("zero-fills missing token fields", () => {
    const r = parseTurnResult({ info: { finish: "stop" }, parts: [] }, "s", "m", "p", 1);
    expect(r.tokens).toEqual({
      input: 0,
      output: 0,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  });
  it("falls back to 'unknown' on missing finish", () => {
    const r = parseTurnResult({ info: {}, parts: [] }, "s", "m", "p", 1);
    expect(r.finish).toBe("unknown");
  });
});

describe("OpencodeChatServer per-session serialization", () => {
  let server: OpencodeChatServer;

  beforeEach(() => {
    server = new OpencodeChatServer({
      port: 0,
      workingDir: "/tmp/x", // unused — start() isn't called in these tests
      defaultModel: "openai/gpt-5.3-codex",
    });
    // Pretend the server is started by giving it a baseUrl directly.
    (server as unknown as { baseUrl: string }).baseUrl = "http://127.0.0.1:9999";
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("serializes concurrent postMessage calls against the same sessionId", async () => {
    const order: string[] = [];
    let resolveFirst!: () => void;
    let resolveSecond!: () => void;
    const firstHttp = new Promise<Response>((res) => {
      resolveFirst = () => res(mockTurnResponse({ text: "first" }));
    });
    const secondHttp = new Promise<Response>((res) => {
      resolveSecond = () => res(mockTurnResponse({ text: "second" }));
    });
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        order.push("first:start");
        const r = await firstHttp;
        order.push("first:end");
        return r;
      })
      .mockImplementationOnce(async () => {
        order.push("second:start");
        const r = await secondHttp;
        order.push("second:end");
        return r;
      });

    const p1 = server.postMessage("ses_A", "hi 1");
    const p2 = server.postMessage("ses_A", "hi 2");

    // Give the event loop a tick so the first fetch can actually start
    // before we resolve it. Without this the test passes trivially.
    await new Promise((r) => setImmediate(r));
    resolveFirst();
    await new Promise((r) => setImmediate(r));
    resolveSecond();

    const [r1, r2] = await Promise.all([p1, p2]);
    expect(r1.text).toBe("first");
    expect(r2.text).toBe("second");
    // The second call must NOT start until the first ends.
    expect(order).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does NOT serialize across different sessionIds", async () => {
    let resolveA!: () => void;
    let resolveB!: () => void;
    const aHttp = new Promise<Response>((res) => {
      resolveA = () => res(mockTurnResponse({ text: "A" }));
    });
    const bHttp = new Promise<Response>((res) => {
      resolveB = () => res(mockTurnResponse({ text: "B" }));
    });
    vi.spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => aHttp)
      .mockImplementationOnce(async () => bHttp);

    const pA = server.postMessage("ses_A", "msg");
    const pB = server.postMessage("ses_B", "msg");

    // Resolve B first — would deadlock if cross-session chains existed.
    resolveB();
    const rB = await pB;
    expect(rB.text).toBe("B");
    resolveA();
    const rA = await pA;
    expect(rA.text).toBe("A");
  });

  it("a failed call doesn't poison the chain for subsequent same-session calls", async () => {
    vi
      .spyOn(globalThis, "fetch")
      .mockImplementationOnce(async () => {
        throw new Error("transport blew up");
      })
      .mockImplementationOnce(async () => mockTurnResponse({ text: "ok" }));

    const p1 = server.postMessage("ses_X", "boom");
    await expect(p1).rejects.toThrow("transport blew up");

    const p2 = server.postMessage("ses_X", "hi");
    const r2 = await p2;
    expect(r2.text).toBe("ok");
  });

  it("throws if used before start()", async () => {
    const fresh = new OpencodeChatServer({
      port: 0,
      workingDir: "/tmp/x",
      defaultModel: "openai/gpt-5.3-codex",
    });
    await expect(fresh.postMessage("s", "msg")).rejects.toThrow(/not started/);
  });
});

function mockTurnResponse(opts: { text: string }): Response {
  const body = {
    info: { finish: "stop", sessionID: "ses_test", cost: 0, tokens: {}, modelID: "m", providerID: "p" },
    parts: [{ type: "text", text: opts.text }],
  };
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

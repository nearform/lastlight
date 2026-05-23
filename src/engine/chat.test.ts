import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleChatMessage } from "./chat.js";
import type { OpencodeChatServer, OpencodeChatTurnResult } from "./opencode-chat-server.js";

/** Stub server — just records the calls and returns canned turns. */
function stubServer(turnFactory: (sessionId: string, prompt: string) => OpencodeChatTurnResult, opts?: { nextSessionId?: string }) {
  const calls = { create: 0, post: [] as Array<{ sessionId: string; prompt: string }> };
  const nextSessionId = opts?.nextSessionId ?? "ses_new123";
  const server: Partial<OpencodeChatServer> = {
    createSession: async () => {
      calls.create++;
      return nextSessionId;
    },
    postMessage: async (sessionId: string, prompt: string) => {
      calls.post.push({ sessionId, prompt });
      return turnFactory(sessionId, prompt);
    },
  };
  return { server: server as OpencodeChatServer, calls };
}

function turn(text: string, opts?: Partial<OpencodeChatTurnResult>): OpencodeChatTurnResult {
  return {
    sessionId: "ses_new123",
    text,
    parts: [
      { type: "text", text },
      { type: "step-finish", reason: "stop" },
    ],
    cost: 0.001,
    tokens: { input: 100, output: 20, reasoning: 5, cacheRead: 30, cacheWrite: 0 },
    finish: "stop",
    modelId: "gpt-5.3-codex",
    providerId: "openai",
    apiDurationMs: 350,
    ...opts,
  };
}

describe("handleChatMessage", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "chat-shim-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  const baseDeps = () => ({
    opencodeHomeDir: dir,
    mcpServerNames: ["github"],
  });

  const baseConfig = { mcpConfigPath: "", model: "openai/gpt-5.3-codex", maxTurns: 10 };

  it("creates a session on the first turn and reuses it on resume", async () => {
    const { server, calls } = stubServer(() => turn("hi"));

    const r1 = await handleChatMessage("hello", "thread1", "alice", {} as any, { chatServer: server, ...baseDeps() }, baseConfig);
    expect(calls.create).toBe(1);
    expect(calls.post.length).toBe(1);
    expect(calls.post[0].sessionId).toBe("ses_new123");
    expect(r1.agentSessionId).toBe("ses_new123");

    const r2 = await handleChatMessage("again", "thread1", "alice", {} as any, { chatServer: server, ...baseDeps() }, baseConfig, r1.agentSessionId);
    expect(calls.create).toBe(1); // unchanged — second turn resumes
    expect(calls.post.length).toBe(2);
    expect(calls.post[1].sessionId).toBe("ses_new123");
    expect(r2.agentSessionId).toBe("ses_new123");
  });

  it("returns ChatResult with token/cost metrics from the turn", async () => {
    const { server } = stubServer(() => turn("response text"));
    const r = await handleChatMessage("hi", "t", "alice", {} as any, { chatServer: server, ...baseDeps() }, baseConfig);
    expect(r.success).toBe(true);
    expect(r.text).toBe("response text");
    expect(r.costUsd).toBe(0.001);
    expect(r.inputTokens).toBe(100);
    expect(r.outputTokens).toBe(20);
    expect(r.cacheReadInputTokens).toBe(30);
    expect(r.apiDurationMs).toBe(350);
    expect(r.stopReason).toBe("success");
  });

  it("maps non-stop finish to error_<reason>", async () => {
    const { server } = stubServer(() => turn("", { finish: "max-tokens", text: "" }));
    const r = await handleChatMessage("hi", "t", "alice", {} as any, { chatServer: server, ...baseDeps() }, baseConfig);
    expect(r.success).toBe(false);
    expect(r.stopReason).toBe("error_max_tokens");
  });

  // Workarounds for sst/opencode#26855 (final step_finish dropped) and
  // sst/opencode#27697 (post-tool-call text dropped). Both surface here as
  // turn.finish != "stop" even though turn.text holds a complete response.
  // Trust the text: any finish with substantive text is a successful turn.
  it("treats finish=tool-calls + non-empty text as success (gpt-5.5 quirk, #27697)", async () => {
    const { server } = stubServer(() => turn("here is your answer", { finish: "tool-calls" }));
    const r = await handleChatMessage("hi", "t", "alice", {} as any, { chatServer: server, ...baseDeps() }, baseConfig);
    expect(r.success).toBe(true);
    expect(r.stopReason).toBe("success");
    expect(r.text).toBe("here is your answer");
  });

  it("treats finish=unknown + non-empty text as success (missing step_finish, #26855)", async () => {
    const { server } = stubServer(() => turn("READY", { finish: "unknown" }));
    const r = await handleChatMessage("hi", "t", "alice", {} as any, { chatServer: server, ...baseDeps() }, baseConfig);
    expect(r.success).toBe(true);
    expect(r.stopReason).toBe("success");
    expect(r.text).toBe("READY");
  });

  it("still marks finish=tool-calls + empty text as error (genuine truncation)", async () => {
    const { server } = stubServer(() => turn("", { finish: "tool-calls", text: "" }));
    const r = await handleChatMessage("hi", "t", "alice", {} as any, { chatServer: server, ...baseDeps() }, baseConfig);
    expect(r.success).toBe(false);
    expect(r.stopReason).toBe("error_tool_calls");
  });

  it("writes the dashboard envelope jsonl under projects/-app/<sessionId>.jsonl", async () => {
    const { server } = stubServer(() =>
      turn("reply text", {
        parts: [
          { type: "step-start" },
          { type: "text", text: "reply text" },
          {
            type: "tool",
            tool: "github_get_issue",
            callID: "call_1",
            state: { status: "completed", input: { issue: 42 }, output: "{ \"title\": \"x\" }" },
          },
          { type: "step-finish", reason: "stop" },
        ],
      }),
    );
    await handleChatMessage("prompt text", "t1", "alice", {} as any, { chatServer: server, ...baseDeps() }, baseConfig);
    const file = join(dir, "projects", "-app", "ses_new123.jsonl");
    expect(existsSync(file)).toBe(true);
    const lines = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    // First line: the user prompt
    expect(lines[0].type).toBe("user");
    expect(lines[0].message.content).toBe("prompt text");
    // Has at least one assistant text + one tool_use envelope + tool_result + result
    const types = lines.map((l) => {
      if (l.type === "user" && Array.isArray(l.message?.content) && l.message.content[0]?.type === "tool_result") return "tool_result";
      if (l.type === "assistant" && Array.isArray(l.message?.content) && l.message.content[0]?.type === "tool_use") return "tool_use";
      if (l.type === "assistant") return "text";
      return l.type;
    });
    expect(types).toEqual(["user", "text", "tool_use", "tool_result", "result"]);
    // MCP tool name should have been prefixed with mcp_ by the shim.
    const toolUseLine = lines.find((l) => l.type === "assistant" && Array.isArray(l.message?.content) && l.message.content[0]?.type === "tool_use");
    expect(toolUseLine.message.content[0].name).toBe("mcp_github_get_issue");
  });

  it("catches errors from the chat server and returns a friendly ChatResult", async () => {
    const server = {
      createSession: async () => "ses_err",
      postMessage: async () => { throw new Error("kaboom"); },
    } as unknown as OpencodeChatServer;
    const r = await handleChatMessage("hi", "t", "alice", {} as any, { chatServer: server, ...baseDeps() }, baseConfig);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/kaboom/);
    // Fallback friendly text — don't leak the raw error.
    expect(r.text).toMatch(/Sorry/);
  });

  it("wraps the user message in untrusted-content markers before posting", async () => {
    const { server, calls } = stubServer(() => turn("ok"));
    await handleChatMessage("untrusted input", "t", "alice", {} as any, { chatServer: server, ...baseDeps() }, baseConfig);
    // wrapUntrusted produces a block with the source/author and the message body.
    expect(calls.post[0].prompt).toContain("untrusted input");
    expect(calls.post[0].prompt).toMatch(/untrusted/i);
  });
});

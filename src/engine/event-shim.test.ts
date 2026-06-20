import { describe, it, expect, afterEach } from "vitest";
import { promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { SessionLog, projectSlugForCwd } from "../session-log.js";
import { AgenticShim } from "./event-shim.js";

const tmpDirs: string[] = [];

afterEach(async () => {
  for (const d of tmpDirs.splice(0)) {
    await fs.rm(d, { recursive: true, force: true });
  }
});

async function makeShim(initialPrompt = "do the thing") {
  const homeDir = await fs.mkdtemp(path.join(os.tmpdir(), "shim-test-"));
  tmpDirs.push(homeDir);
  const cwd = "/home/agent/workspace";
  const projectSlug = projectSlugForCwd(cwd);
  const shim = new AgenticShim({
    homeDir,
    projectSlug,
    model: "openai/gpt-5.5",
    initialPrompt,
  });
  const filePath = new SessionLog(homeDir).pathForProject(projectSlug, "sess1", { requireExists: false });
  if (!filePath) throw new Error("expected valid session path");
  return { shim, filePath };
}

async function readEnvelopes(filePath: string): Promise<Array<Record<string, unknown>>> {
  const raw = await fs.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .filter((l) => l.trim().length > 0)
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}

describe("AgenticShim per-message usage", () => {
  it("writes Claude-shaped usage onto the assistant envelope", async () => {
    const { shim, filePath } = await makeShim();
    shim.feed({ type: "session", id: "sess1" });
    shim.feed({
      type: "message_end",
      sessionId: "sess1",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "hello" }],
        usage: {
          input: 1200,
          output: 340,
          cacheRead: 5000,
          cacheWrite: 10,
          cost: { total: 0.07 },
        },
      },
    });
    await shim.flush();

    const envelopes = await readEnvelopes(filePath);
    const assistant = envelopes.find((e) => e.type === "assistant");
    expect(assistant).toBeDefined();
    const message = assistant?.message as { usage?: Record<string, number> };
    expect(message.usage).toEqual({
      input_tokens: 1200,
      output_tokens: 340,
      cache_read_input_tokens: 5000,
      cache_creation_input_tokens: 10,
    });
  });

  it("writes an extension_status event as a system envelope line", async () => {
    const { shim, filePath } = await makeShim();
    shim.feed({ type: "session", id: "sess1" });
    shim.feed({
      type: "extension_status",
      sessionId: "sess1",
      extension: "file-search",
      status: "configured",
      mode: "override",
      toolCount: 3,
    });
    await shim.flush();

    const envelopes = await readEnvelopes(filePath);
    const sys = envelopes.find(
      (e) => e.type === "system" && e.subtype === "extension_status",
    );
    expect(sys).toBeDefined();
    expect(sys).toMatchObject({
      extension: "file-search",
      status: "configured",
      mode: "override",
      toolCount: 3,
    });
    // The initial user (prompt) line precedes it — extension status lands near
    // the top of the session log.
    expect(envelopes[0]?.type).toBe("user");
  });

  it("omits the usage block when the message carries no usage", async () => {
    const { shim, filePath } = await makeShim();
    shim.feed({ type: "session", id: "sess1" });
    shim.feed({
      type: "message_end",
      sessionId: "sess1",
      message: { role: "assistant", content: [{ type: "text", text: "hi" }] },
    });
    await shim.flush();

    const envelopes = await readEnvelopes(filePath);
    const assistant = envelopes.find((e) => e.type === "assistant");
    const message = assistant?.message as { usage?: unknown };
    expect(message.usage).toBeUndefined();
  });
});

describe("AgenticShim thinking blocks", () => {
  it("preserves thinking blocks on the assistant envelope and the reader extracts reasoning", async () => {
    const { shim, filePath } = await makeShim();
    shim.feed({ type: "session", id: "sess1" });
    shim.feed({
      type: "message_end",
      sessionId: "sess1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "Let me reason about this..." },
          { type: "text", text: "Here is the answer." },
        ],
      },
    });
    await shim.flush();

    const envelopes = await readEnvelopes(filePath);
    const assistant = envelopes.find((e) => e.type === "assistant");
    const content = (assistant?.message as { content: Array<Record<string, unknown>> }).content;
    expect(content).toEqual([
      { type: "thinking", thinking: "Let me reason about this..." },
      { type: "text", text: "Here is the answer." },
    ]);

    // Round-trip through the reader the dashboard uses: reasoning is surfaced.
    const normalized = await new SessionLog("").readNormalizedFile(filePath);
    const asst = normalized.find((n) => n.msg.role === "assistant");
    expect(asst?.msg.reasoning).toBe("Let me reason about this...");
    expect(asst?.msg.content).toBe("Here is the answer.");
  });

  it("skips empty/redacted thinking blocks", async () => {
    const { shim, filePath } = await makeShim();
    shim.feed({ type: "session", id: "sess1" });
    shim.feed({
      type: "message_end",
      sessionId: "sess1",
      message: {
        role: "assistant",
        content: [
          { type: "thinking", thinking: "" },
          { type: "text", text: "answer" },
        ],
      },
    });
    await shim.flush();

    const envelopes = await readEnvelopes(filePath);
    const assistant = envelopes.find((e) => e.type === "assistant");
    const content = (assistant?.message as { content: Array<Record<string, unknown>> }).content;
    expect(content).toEqual([{ type: "text", text: "answer" }]);
  });
});

describe("AgenticShim auto-retry breadcrumbs", () => {
  it("emits a renderable system line on auto_retry_start", async () => {
    const { shim, filePath } = await makeShim();
    shim.feed({ type: "session", id: "sess1" });
    shim.feed({
      type: "auto_retry_start",
      sessionId: "sess1",
      attempt: 1,
      maxAttempts: 3,
      delayMs: 10000,
      errorMessage: "429 RATE_LIMIT_EXCEEDED",
    });
    await shim.flush();

    const envelopes = await readEnvelopes(filePath);
    const sys = envelopes.find((e) => e.role === "system" && e.subtype === "auto_retry_start");
    expect(sys).toBeDefined();
    expect(String(sys?.content)).toContain("Auto-retry 1/3 in 10s");
    expect(String(sys?.content)).toContain("429 RATE_LIMIT_EXCEEDED");

    // Role-based line renders as a system message in the timeline reader.
    const normalized = await new SessionLog("").readNormalizedFile(filePath);
    const sysMsg = normalized.find((n) => n.msg.role === "system");
    expect(sysMsg?.msg.content).toContain("Auto-retry 1/3 in 10s");
  });

  it("distinguishes recovery from give-up on auto_retry_end", async () => {
    const { shim, filePath } = await makeShim();
    shim.feed({ type: "session", id: "sess1" });
    shim.feed({ type: "auto_retry_end", sessionId: "sess1", attempt: 2 });
    shim.feed({ type: "auto_retry_end", sessionId: "sess1", attempt: 3, finalError: "still 429" });
    await shim.flush();

    const envelopes = await readEnvelopes(filePath);
    const ends = envelopes.filter((e) => e.role === "system" && e.subtype === "auto_retry_end");
    expect(ends).toHaveLength(2);
    expect(String(ends[0]?.content)).toContain("recovered after 2 attempt");
    expect(String(ends[1]?.content)).toContain("gave up after 3 attempt");
    expect(String(ends[1]?.content)).toContain("still 429");
  });
});

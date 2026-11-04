import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import { ClaudeTranscriptTranslator, parseLimitReset } from "#src/engine/claude-code/transcript.js";

const FIXTURES = join(import.meta.dirname, "fixtures");
const SESSION = "6f1c2a9e-0000-4000-8000-000000000001";

function run(name: string, now = new Date("2026-11-04T14:00:00Z")) {
  const t = new ClaudeTranscriptTranslator({ sessionId: SESSION, now: () => now });
  const events = readFileSync(join(FIXTURES, name), "utf8")
    .split("\n")
    .filter((l) => l.length > 0)
    .flatMap((l) => t.translate(l));
  return { t, events };
}

describe("ClaudeTranscriptTranslator", () => {
  it("translates a session into the agentic-pi records", () => {
    const { events } = run("basic.jsonl");
    expect(events[0]).toMatchObject({ type: "session", id: SESSION });
    const ends = events.filter((e) => e.type === "message_end");
    expect(ends).toHaveLength(3);
    expect(ends[0]).toMatchObject({
      message: { role: "assistant", content: [{ type: "thinking", thinking: "Look at the repo layout first." }] },
    });
    expect(ends[1]).toMatchObject({
      message: {
        role: "assistant",
        content: [{ type: "toolCall", id: "toolu_01", name: "Bash", arguments: { command: "ls", description: "List files" } }],
      },
    });
    expect(ends[2]).toMatchObject({ message: { content: [{ type: "text", text: "Plan written to architect-plan.md." }] } });

    // The dashboard's session log drops any record without a sessionId.
    for (const e of events) expect(e.sessionId ?? e.id).toBe(SESSION);
    for (const e of events.filter((x) => x.type !== "session")) expect(e).toHaveProperty("sessionId", SESSION);
    expect(ends[2]).toHaveProperty("timestamp", "2026-11-04T10:00:06.000Z");

    const result = events.find((e) => e.type === "tool_execution_end");
    expect(result).toEqual({
      type: "tool_execution_end",
      sessionId: SESSION,
      timestamp: "2026-11-04T10:00:04.000Z",
      toolCallId: "toolu_01",
      toolName: "Bash",
      result: "README.md\nsrc",
      isError: false,
    });
  });

  it("maps usage once per Claude message, as deltas across its streamed lines", () => {
    const { events } = run("basic.jsonl");
    const usages = events
      .filter((e) => e.type === "message_end")
      .map((e) => (e.message as { usage: unknown }).usage);
    expect(usages[0]).toEqual({ input: 12, output: 8, cacheRead: 0, cacheWrite: 2000, totalTokens: 2020, cost: { total: 0 } });
    // same msg_01: only the new output tokens are reported, nothing double-counted
    expect(usages[1]).toEqual({ input: 0, output: 32, cacheRead: 0, cacheWrite: 0, totalTokens: 32, cost: { total: 0 } });
    expect(usages[2]).toEqual({ input: 30, output: 15, cacheRead: 2000, cacheWrite: 0, totalTokens: 2045, cost: { total: 0 } });
  });

  it("detects the usage limit and its reset", () => {
    const { t, events } = run("limit.jsonl");
    expect(t.usageLimit).toEqual({ resetsAt: "2026-11-04T15:00:00.000Z" });
    expect(t.authFailed).toBe(false);
    const fatal = events.filter((e) => e.type === "fatal_error");
    expect(fatal).toHaveLength(1);
    expect(fatal[0]).toMatchObject({ error: { name: "usage_limit" } });
    expect(events.filter((e) => e.type === "message_end")).toHaveLength(0);
  });

  it("detects an auth failure", () => {
    const { t, events } = run("auth.jsonl");
    expect(t.authFailed).toBe(true);
    expect(t.usageLimit).toBeNull();
    expect(events.filter((e) => e.type === "fatal_error")).toEqual([
      expect.objectContaining({ error: expect.objectContaining({ name: "auth_failed" }) }),
    ]);
  });

  it("leaves a transient API error to Claude Code's own retry", () => {
    const t = new ClaudeTranscriptTranslator({ sessionId: SESSION });
    const line = JSON.stringify({
      type: "assistant",
      isApiErrorMessage: true,
      message: { role: "assistant", content: [{ type: "text", text: "API Error: 529 Overloaded" }] },
    });
    expect(t.translate(line)).toEqual([]);
    expect(t.usageLimit).toBeNull();
    expect(t.authFailed).toBe(false);
  });

  it("ignores unknown lines", () => {
    expect(() => run("unknown.jsonl")).not.toThrow();
    expect(run("unknown.jsonl").events).toEqual([]);
  });
});

describe("parseLimitReset", () => {
  it("takes the next occurrence of the printed time, UTC by default", () => {
    expect(parseLimitReset("5-hour limit reached ∙ resets 3pm", new Date("2026-11-04T14:00:00Z"))).toBe("2026-11-04T15:00:00.000Z");
    expect(parseLimitReset("5-hour limit reached ∙ resets 3pm", new Date("2026-11-04T16:00:00Z"))).toBe("2026-11-05T15:00:00.000Z");
    expect(parseLimitReset("limit reached · resets 9:30am", new Date("2026-11-04T08:00:00Z"))).toBe("2026-11-04T09:30:00.000Z");
  });

  it("honours a printed timezone", () => {
    expect(parseLimitReset("resets 3pm (Asia/Singapore)", new Date("2026-11-04T05:00:00Z"))).toBe("2026-11-04T07:00:00.000Z");
  });

  it("reads a date for the weekly window", () => {
    expect(parseLimitReset("Weekly limit reached ∙ resets Nov 7, 5pm", new Date("2026-11-04T14:00:00Z"))).toBe("2026-11-07T17:00:00.000Z");
  });

  it("reads the epoch form", () => {
    expect(parseLimitReset("Claude AI usage limit reached|1793804400", new Date("2026-11-04T14:00:00Z"))).toBe(
      new Date(1793804400 * 1000).toISOString(),
    );
  });

  it("returns null without a time", () => {
    expect(parseLimitReset("usage limit reached", new Date("2026-11-04T14:00:00Z"))).toBeNull();
    expect(parseLimitReset("resets soon", new Date("2026-11-04T14:00:00Z"))).toBeNull();
  });
});

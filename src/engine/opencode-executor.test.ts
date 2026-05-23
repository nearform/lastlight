import { describe, it, expect } from "vitest";
import {
  __OpencodeAccumulatorForTest as Accumulator,
  __parseStreamForTest as parseStream,
} from "./opencode-executor.js";

function jsonl(...events: object[]): string {
  return events.map((e) => JSON.stringify(e)).join("\n");
}

describe("OpencodeAccumulator", () => {
  it("captures sessionID from the first event that carries one", () => {
    const acc = new Accumulator();
    acc.feed({ type: "text", part: { text: "hi" } });
    expect(acc.sessionId).toBeUndefined();
    acc.feed({ type: "text", sessionID: "ses_abc", part: { text: "hi" } });
    expect(acc.sessionId).toBe("ses_abc");
  });

  it("concatenates text parts with a blank line between non-empty chunks", () => {
    const acc = new Accumulator();
    acc.feed({ type: "text", part: { text: "first" } });
    acc.feed({ type: "text", part: { text: "" } });
    acc.feed({ type: "text", part: { text: "second" } });
    expect(acc.finalText).toBe("first\n\nsecond");
  });

  it("tallies step_finish tokens, cost, turns, and cache reads/writes", () => {
    const acc = new Accumulator();
    acc.feed({
      type: "step_finish",
      part: {
        reason: "tool-calls",
        cost: 0.0123,
        tokens: { input: 100, output: 20, reasoning: 5, cache: { read: 80, write: 4 } },
      },
    });
    acc.feed({
      type: "step_finish",
      part: { reason: "stop", cost: 0.01, tokens: { input: 10, output: 7 } },
    });
    expect(acc.turns).toBe(2);
    expect(acc.costUsd).toBeCloseTo(0.0223, 4);
    expect(acc.inputTokens).toBe(110);
    expect(acc.outputTokens).toBe(27);
    expect(acc.reasoningTokens).toBe(5);
    expect(acc.cacheReadInputTokens).toBe(80);
    expect(acc.cacheCreationInputTokens).toBe(4);
    expect(acc.lastReason).toBe("stop");
  });

  it("collects errors with a fallback shape", () => {
    const acc = new Accumulator();
    acc.feed({ type: "error", error: { data: { message: "rate limited" } } });
    acc.feed({ type: "error", error: { name: "BillingError" } });
    expect(acc.errors).toEqual(["rate limited", "BillingError"]);
  });

  it("derives stopReason from lastReason and errors", () => {
    const ok = new Accumulator();
    ok.feed({ type: "step_finish", part: { reason: "stop" } });
    expect(ok.stopReason()).toBe("success");

    const len = new Accumulator();
    len.feed({ type: "step_finish", part: { reason: "max_tokens" } });
    expect(len.stopReason()).toBe("error_max_turns");

    // Genuine truncation: model wanted to call tools but the loop ended with
    // no terminal text to show. Stays an error.
    const toolNoText = new Accumulator();
    toolNoText.feed({ type: "step_finish", part: { reason: "tool-calls" } });
    expect(toolNoText.stopReason()).toBe("error_tool_calls");

    // gpt-5.5 + sst/opencode#27697: model emits final text AND
    // finish_reason="tool_calls" in the same response with no callable
    // tool_use parts. OpenCode terminates the loop with reason="tool-calls",
    // but the run is actually complete — treat as success when finalText is
    // non-empty.
    const toolWithText = new Accumulator();
    toolWithText.feed({ type: "text", part: { text: "Here is the answer." } });
    toolWithText.feed({ type: "step_finish", part: { reason: "tool-calls" } });
    expect(toolWithText.stopReason()).toBe("success");

    // sst/opencode#26855: OpenCode exits before draining the final
    // step_finish event, so lastReason is undefined even though a complete
    // text response was emitted. We have the answer — trust it.
    const textNoFinish = new Accumulator();
    textNoFinish.feed({ type: "text", part: { text: "READY" } });
    expect(textNoFinish.stopReason()).toBe("success");

    const errored = new Accumulator();
    errored.feed({ type: "step_finish", part: { reason: "stop" } });
    errored.feed({ type: "error", error: { name: "x" } });
    expect(errored.stopReason()).toBe("error_api");

    // Silent failure with no text and no events: still surfaces as unknown.
    const blank = new Accumulator();
    expect(blank.stopReason()).toBe("unknown");
  });

  it("apiDurationMs returns last-minus-first when both timestamps present", () => {
    const acc = new Accumulator();
    acc.feed({ type: "text", timestamp: 1000, part: { text: "a" } });
    acc.feed({ type: "text", timestamp: 1500, part: { text: "b" } });
    expect(acc.apiDurationMs()).toBe(500);

    const noTs = new Accumulator();
    expect(noTs.apiDurationMs()).toBeUndefined();
  });

  it("ignores non-object events", () => {
    const acc = new Accumulator();
    acc.feed(null);
    acc.feed("not an object" as unknown as object);
    acc.feed(42 as unknown as object);
    expect(acc.turns).toBe(0);
    expect(acc.finalText).toBe("");
  });
});

describe("parseStream", () => {
  it("parses an end-to-end JSONL stream into a finished accumulator", () => {
    const stream = jsonl(
      { type: "text", sessionID: "ses_1", timestamp: 100, part: { text: "Hello " } },
      { type: "tool_use", sessionID: "ses_1", timestamp: 110, name: "read", input: { path: "/foo" } },
      { type: "step_finish", sessionID: "ses_1", timestamp: 200, part: { tokens: { input: 5, output: 2 }, cost: 0.001 } },
      { type: "text", sessionID: "ses_1", timestamp: 210, part: { text: "world" } },
      { type: "step_finish", sessionID: "ses_1", timestamp: 220, part: { reason: "stop", tokens: { input: 1, output: 3 }, cost: 0.002 } },
    );
    const acc = parseStream(stream);
    expect(acc.sessionId).toBe("ses_1");
    expect(acc.turns).toBe(2);
    expect(acc.inputTokens).toBe(6);
    expect(acc.outputTokens).toBe(5);
    expect(acc.costUsd).toBeCloseTo(0.003, 4);
    expect(acc.finalText).toBe("Hello \n\nworld");
    expect(acc.stopReason()).toBe("success");
    expect(acc.apiDurationMs()).toBe(120);
  });

  it("skips malformed lines and lines that don't start with {", () => {
    const stream = [
      "warning: ignoring something",
      "{not valid json",
      JSON.stringify({ type: "step_finish", sessionID: "ses_2", part: { reason: "stop" } }),
      "",
      "  ", // whitespace-only line
    ].join("\n");
    const acc = parseStream(stream);
    expect(acc.sessionId).toBe("ses_2");
    expect(acc.turns).toBe(1);
  });

  it("captures account-error signals in errors / finalText for the heuristic", () => {
    // Mirrors the billing-error heuristic in executeSandboxed
    // (rate limit / credit balance / unauthorized / insufficient_quota).
    const stream = jsonl(
      { type: "error", sessionID: "ses_3", error: { data: { message: "rate limit exceeded" } } },
      { type: "text", sessionID: "ses_3", part: { text: "Your credit balance is insufficient." } },
    );
    const acc = parseStream(stream);
    const combined = (acc.errors.join("\n") + "\n" + acc.finalText).toLowerCase();
    expect(combined).toContain("rate limit");
    expect(combined).toContain("credit balance");
  });
});

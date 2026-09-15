import { describe, test } from "node:test";
import assert from "node:assert/strict";

import type { EmitterRecord } from "../src/emitter.js";
import { buildResult } from "../src/run.js";

// buildResult folds the JSONL record stream into a RunResult. These cover the
// terminal-event handling that guarantees a run reports completion + final
// text even when Pi resolves the prompt without a natural terminal agent_end.

const assistantMsg = (text: string) => ({
  role: "assistant",
  content: [{ type: "text", text }],
});

describe("buildResult — terminal agent_end handling", () => {
  test("a terminal agent_end marks the run ended", () => {
    const records: EmitterRecord[] = [
      { type: "agent_end", willRetry: false, messages: [assistantMsg("done")] },
    ];
    const r = buildResult(0, records, []);
    assert.equal(r.agentEnded, true);
    assert.equal(r.agentEndSynthesized ?? false, false);
  });

  test("an intermediate willRetry agent_end does NOT mark the run ended", () => {
    const records: EmitterRecord[] = [
      // Retryable failure: Pi emits agent_end with willRetry:true, then retries.
      { type: "agent_end", willRetry: true, messages: [assistantMsg("")] },
    ];
    const r = buildResult(0, records, []);
    assert.equal(r.agentEnded, false);
  });

  test("willRetry agent_end followed by a terminal one ends the run once", () => {
    const records: EmitterRecord[] = [
      { type: "agent_end", willRetry: true, messages: [assistantMsg("")] },
      { type: "message_end", message: assistantMsg("final answer") },
      { type: "agent_end", willRetry: false, messages: [assistantMsg("final answer")] },
    ];
    const r = buildResult(0, records, []);
    assert.equal(r.agentEnded, true);
    assert.equal(r.finalText, "final answer");
  });

  test("synthesized terminal agent_end sets agentEndSynthesized", () => {
    const records: EmitterRecord[] = [
      { type: "agent_end", willRetry: false, synthesized: true, messages: [] },
    ];
    const r = buildResult(0, records, []);
    assert.equal(r.agentEnded, true);
    assert.equal(r.agentEndSynthesized, true);
  });

  test("finalText is backfilled from agent_end.messages when no message_end carried text", () => {
    // The synthesized-terminal case: no assistant message_end, but the session
    // messages carry the last assistant answer.
    const records: EmitterRecord[] = [
      {
        type: "agent_end",
        willRetry: false,
        synthesized: true,
        messages: [
          { role: "user", content: [{ type: "text", text: "hi" }] },
          assistantMsg("backfilled answer"),
        ],
      },
    ];
    const r = buildResult(0, records, []);
    assert.equal(r.finalText, "backfilled answer");
  });

  test("message_end text takes precedence over the agent_end backfill", () => {
    const records: EmitterRecord[] = [
      { type: "message_end", message: assistantMsg("from message_end") },
      { type: "agent_end", willRetry: false, messages: [assistantMsg("from agent_end")] },
    ];
    const r = buildResult(0, records, []);
    assert.equal(r.finalText, "from message_end");
  });

  test("no terminal agent_end at all leaves agentEnded false", () => {
    const records: EmitterRecord[] = [{ type: "message_end", message: assistantMsg("partial") }];
    const r = buildResult(0, records, []);
    assert.equal(r.agentEnded, false);
    assert.equal(r.finalText, "partial");
  });
});

describe("buildResult — lastToolErrored tracking", () => {
  test("lastToolErrored is true when the last tool_execution_end errored", () => {
    const records: EmitterRecord[] = [
      { type: "tool_execution_end", tool: "bash", isError: true, error: "exit 1" },
    ];
    const r = buildResult(0, records, []);
    assert.equal(r.lastToolErrored, true);
    assert.equal(r.toolErrors, true);
  });

  test("lastToolErrored is false when the last tool_execution_end succeeded (even if an earlier one errored)", () => {
    const records: EmitterRecord[] = [
      { type: "tool_execution_end", tool: "bash", isError: true, error: "exit 1" },
      { type: "tool_execution_end", tool: "read", isError: false, result: "ok" },
    ];
    const r = buildResult(0, records, []);
    assert.equal(r.lastToolErrored, false);
    // Sticky flag still set — some tool failed
    assert.equal(r.toolErrors, true);
  });

  test("lastToolErrored is undefined when no tool ran", () => {
    const records: EmitterRecord[] = [
      { type: "agent_end", willRetry: false, messages: [assistantMsg("done")] },
    ];
    const r = buildResult(0, records, []);
    assert.equal(r.lastToolErrored, undefined);
    assert.equal(r.toolErrors, false);
  });
});

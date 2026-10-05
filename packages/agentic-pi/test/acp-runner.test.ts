import { describe, test } from "node:test";
import assert from "node:assert/strict";

import { AcpToPiTranslator, canonicalToolName } from "../src/acp-runner.js";
import type { EmitterRecord } from "../src/emitter.js";

describe("canonicalToolName", () => {
  test("maps ACP kinds and MCP titles onto the Pi vocabulary", () => {
    assert.equal(canonicalToolName("execute", "git push", { command: "git push" }), "bash");
    assert.equal(canonicalToolName("edit", "Edit x", { file_path: "x", old_string: "a", new_string: "b" }), "edit");
    assert.equal(canonicalToolName("edit", "Write x", { file_path: "x", content: "c" }), "write");
    assert.equal(canonicalToolName("other", "mcp__lastlight__github_add_issue_comment", {}), "github_add_issue_comment");
    assert.equal(canonicalToolName("read", "Read File", {}), "read");
  });
});

describe("AcpToPiTranslator", () => {
  test("folds text + tool calls into Pi-shaped records core already consumes", () => {
    const out: EmitterRecord[] = [];
    const t = new AcpToPiTranslator((r) => out.push(r));
    t.feed({ type: "text_delta", text: "Looking.", stream: "output" });
    t.feed({ type: "tool_call", text: "", toolCallId: "a", status: "pending", kind: "read", title: "Read File", rawInput: {} });
    // Args stream in later; a completion update is titled generically and carries no kind.
    t.feed({ type: "tool_call", text: "", toolCallId: "a", kind: "read", title: "Read /x", rawInput: { file_path: "/x" } });
    t.feed({ type: "text_delta", text: " interleaved", stream: "output" });
    t.feed({ type: "tool_call", text: "", toolCallId: "a", status: "completed", title: "tool call", rawOutput: "hello" });
    t.feed({ type: "tool_call", text: "", toolCallId: "m", status: "pending", kind: "other", title: "mcp__lastlight__github_add_issue_comment", rawInput: { owner: "o" } });
    t.feed({ type: "tool_call", text: "", toolCallId: "m", title: "mcp__lastlight__github_add_issue_comment", rawInput: { owner: "o", repo: "r", issue_number: 1, body: "b" } });
    t.feed({ type: "tool_call", text: "", toolCallId: "m", status: "completed", title: "tool call", rawOutput: [{ type: "text", text: "posted" }] });
    t.feed({ type: "text_delta", text: "DONE", stream: "output" });
    t.flushMessage({ input: 1, output: 2, cost: { total: 0.01 } }, "stop");

    assert.deepEqual(
      out.map((r) => r.type),
      ["tool_execution_start", "message_end", "tool_execution_end", "tool_execution_start", "message_end", "tool_execution_end", "message_end"],
    );
    const starts = out.filter((r) => r.type === "tool_execution_start");
    assert.deepEqual(starts.map((r) => [r.toolName, r.args]), [
      ["read", { file_path: "/x" }],
      ["github_add_issue_comment", { owner: "o", repo: "r", issue_number: 1, body: "b" }],
    ]);
    const ends = out.filter((r) => r.type === "tool_execution_end") as Array<EmitterRecord & { result: { content: Array<{ text: string }> } }>;
    assert.deepEqual(ends.map((r) => r.result.content[0].text), ["hello", "posted"]);
    const last = out.at(-1) as EmitterRecord & { message: { content: unknown[]; usage: unknown; stopReason: string } };
    assert.deepEqual(last.message.content, [{ type: "text", text: "DONE" }]);
    assert.equal(last.message.stopReason, "stop");
    assert.deepEqual(t.messages.length, 3);
  });
});

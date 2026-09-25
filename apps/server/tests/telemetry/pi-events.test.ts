import { describe, expect, it } from "vitest";
import { sanitizePiEvent } from "#src/telemetry/pi-events.js";

describe("PI event telemetry sanitization", () => {
  it("redacts message content and tool arguments by default", () => {
    const sanitized = sanitizePiEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [
          { type: "text", text: "secret" },
          { type: "toolCall", name: "bash", arguments: { command: "cat secret" } },
        ],
        usage: { inputTokens: 5, outputTokens: 7, costUsd: 0.01 },
      },
    });
    expect(sanitized["message.role"]).toBe("assistant");
    expect(sanitized["message.content_block_count"]).toBe(2);
    expect(sanitized["message.content_block_types"]).toBe("text,toolCall");
    expect(sanitized["message.content"]).toBeUndefined();
    expect(JSON.stringify(sanitized)).not.toContain("secret");
  });

  it("includes truncated content when opted in", () => {
    const long = "x".repeat(5000);
    const tool = sanitizePiEvent({
      type: "tool_execution_end",
      toolName: "read",
      result: long,
      isError: false,
    }, true);
    expect(tool["tool.name"]).toBe("read");
    expect(String(tool["tool.result"]).length).toBeLessThanOrEqual(1024);

    const message = sanitizePiEvent({
      type: "message_end",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "visible after explicit opt-in" }],
      },
    }, true);
    expect(String(message["message.content"])).toContain("visible after explicit opt-in");
  });

  it("maps extension, usage, and fatal error metadata", () => {
    expect(sanitizePiEvent({ type: "extension_status", extension: "github", status: "configured", toolCount: 3 })).toMatchObject({
      "extension.extension": "github",
      "extension.status": "configured",
      "extension.toolCount": 3,
    });
    expect(sanitizePiEvent({
      type: "skills_status",
      status: "configured",
      discovered: 2,
      noSkills: false,
      skills: [{ name: "pr-review" }, { name: "issue-triage" }],
    })).toMatchObject({
      "skills.status": "configured",
      "skills.discovered": 2,
      "skills.names": "pr-review,issue-triage",
    });
    expect(sanitizePiEvent({ type: "usage_snapshot", turns: 2, costUsd: 0.2 })).toMatchObject({
      "usage.turns": 2,
      "usage.costUsd": 0.2,
    });
    expect(sanitizePiEvent({ type: "fatal_error", name: "Error", message: "boom", stack: "hidden" })).toMatchObject({
      "error.name": "Error",
      "error.message": "boom",
    });
    expect(sanitizePiEvent({ type: "fatal_error", stack: "hidden" })["error.stack"]).toBeUndefined();
  });

  it("tags a command_policy decision, and carries the command only with content on (#403)", () => {
    const record = { type: "command_policy", action: "block", class: "test", pattern: "js-test", command: "npm test" };
    expect(sanitizePiEvent(record)).toMatchObject({
      "command_policy.action": "block",
      "command_policy.class": "test",
      "command_policy.pattern": "js-test",
    });
    expect(sanitizePiEvent(record)["command_policy.command"]).toBeUndefined();
    expect(sanitizePiEvent(record, true)["command_policy.command"]).toBe("npm test");
  });
});

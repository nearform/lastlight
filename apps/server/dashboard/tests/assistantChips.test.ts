/**
 * `assistantChips` — what an assistant card flags about its turn. Only the
 * unusual is worth a chip: an abnormal stop, or a gateway serving a different
 * model than the one requested. Routine stops and matching models stay quiet.
 */
import { describe, it, expect } from "vitest";
import { assistantChips } from "../src/components/timeline/AssistantMessage";
import { toBaseMessages } from "../src/adapters/lastlightToTimeline";

describe("assistantChips", () => {
  it("is silent for a routine turn", () => {
    expect(assistantChips({ finishReason: "stop", rawStopReason: "end_turn" })).toEqual([]);
    expect(assistantChips({ finishReason: "toolUse" })).toEqual([]);
    expect(assistantChips(undefined)).toEqual([]);
  });

  it("flags an abnormal stop with the provider's own reason", () => {
    expect(assistantChips({ finishReason: "length", rawStopReason: "max_tokens" })).toEqual([
      "stopped: length (max_tokens)",
    ]);
    expect(assistantChips({ finishReason: "error", rawStopReason: "error" })).toEqual(["stopped: error"]);
  });

  it("flags a served model only when it differs from the requested one", () => {
    expect(assistantChips({ model: "opencode/kimi-k2.6", responseModel: "kimi-k2.6" })).toEqual([]);
    expect(assistantChips({ model: "openrouter/auto", responseModel: "anthropic/claude-sonnet-5" })).toEqual([
      "served by anthropic/claude-sonnet-5",
    ]);
  });

  it("reads the fields the session API returns", () => {
    const [msg] = toBaseMessages([
      {
        id: 1,
        role: "assistant",
        content: "cut off",
        finish_reason: "length",
        raw_stop_reason: "max_tokens",
        model: "opencode/glm-5.3",
        response_model: "glm-5.3",
      },
    ]);
    expect(assistantChips(msg!.metadata)).toEqual(["stopped: length (max_tokens)"]);
  });
});

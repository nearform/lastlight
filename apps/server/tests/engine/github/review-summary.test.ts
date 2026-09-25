/**
 * Issue #405 — the posted summary is written from the POSTED findings only,
 * after the attention boundary has cut. These pin the mechanism: what the model
 * is handed, when the code-rendered fallback is used, and that the re-review
 * ledger survives.
 */
import { describe, expect, it } from "vitest";
import {
  extractPriorLedger,
  renderFallbackSummary,
  writePostedSummary,
} from "#src/engine/github/review-summary.js";
import type { ChatMessage } from "#src/engine/llm.js";
import type { ReviewFinding, TieredFindings } from "#src/engine/github/review-poster.js";

const f = (title: string, line: number): ReviewFinding & { path: string; line: number } => ({
  path: "src/a.ts",
  line,
  severity: "Important",
  title,
  body: `about ${title}`,
});

const tiered = (): TieredFindings => ({
  inline: [f("posted inline", 1)],
  body: [{ finding: f("posted in body", 2), reason: "overflow" }],
  internal: [
    { finding: f("withheld by budget", 3), reason: "body-budget" },
    { finding: f("withheld no impact", 4), reason: "no-impact" },
  ],
});

function recorder(reply: string | Error) {
  const calls: { model: string; messages: ChatMessage[] }[] = [];
  const chat = async (model: string, messages: ChatMessage[]) => {
    calls.push({ model, messages });
    if (reply instanceof Error) throw reply;
    return reply;
  };
  return { calls, chat };
}

describe("writePostedSummary", () => {
  it("hands the model the posted findings and nothing the boundary withheld", async () => {
    const { calls, chat } = recorder("Solid change with two things to fix.");
    const out = await writePostedSummary({ event: "COMMENT", tiered: tiered(), model: "m/x", chat });
    expect(out).toEqual({ text: "Solid change with two things to fix.", source: "model" });
    const input = calls[0]!.messages.map((m) => m.content).join("\n");
    expect(input).toContain("posted inline");
    expect(input).toContain("posted in body");
    expect(input).not.toContain("withheld by budget");
    expect(input).not.toContain("withheld no impact");
  });

  it("never reads the adjudicator's prose beyond its ledger", async () => {
    const { calls, chat } = recorder("Fine.");
    await writePostedSummary({
      event: "COMMENT",
      tiered: tiered(),
      adjudicatorSummary: "Also flagged below: withheld by budget.",
      model: "m/x",
      chat,
    });
    expect(calls[0]!.messages.map((m) => m.content).join("\n")).not.toContain("Also flagged");
  });

  it("uses the code-rendered summary, without calling the model, when nothing posts", async () => {
    const { calls, chat } = recorder("should not be used");
    const out = await writePostedSummary({
      event: "APPROVE",
      tiered: { inline: [], body: [], internal: tiered().internal },
      model: "m/x",
      chat,
    });
    expect(calls).toHaveLength(0);
    expect(out.source).toBe("fallback");
    expect(out.text).toBe(renderFallbackSummary("APPROVE", []));
  });

  it.each([
    ["no model", { model: undefined }],
    ["an error", { chat: recorder(new Error("boom")).chat }],
    ["an empty reply", { chat: recorder("   ").chat }],
    ["an oversized reply", { chat: recorder("x".repeat(5000)).chat }],
  ])("falls back on %s", async (_label, over) => {
    const out = await writePostedSummary({
      event: "REQUEST_CHANGES",
      tiered: tiered(),
      model: "m/x",
      chat: recorder("unused").chat,
      ...over,
    });
    expect(out.source).toBe("fallback");
    expect(out.reason).toBeTruthy();
    expect(out.text).toBe(renderFallbackSummary("REQUEST_CHANGES", [tiered().inline[0]!, tiered().body[0]!.finding]));
  });

  it("carries the re-review ledger over verbatim, ahead of the new summary", async () => {
    const ledger = "- **Fixed** — the null check at a.ts:3\n- **Still open** — the race at a.ts:9";
    const out = await writePostedSummary({
      event: "COMMENT",
      tiered: tiered(),
      adjudicatorSummary: `${ledger}\n\nThen prose naming withheld by budget.`,
      model: "m/x",
      chat: recorder("New summary.").chat,
    });
    expect(out.text).toBe(`${ledger}\n\nNew summary.`);
  });
});

describe("extractPriorLedger", () => {
  it("takes only the contiguous ledger at the top", () => {
    expect(extractPriorLedger("Fixed: a\nStill open: b\n\nWithdrawn: c\nprose\nFixed: later")).toBe(
      "Fixed: a\nStill open: b\nWithdrawn: c",
    );
  });

  it("is empty when the summary does not open with a ledger", () => {
    expect(extractPriorLedger("Looks good. Fixed: nothing")).toBe("");
    expect(extractPriorLedger(undefined)).toBe("");
  });
});

describe("renderFallbackSummary", () => {
  it("counts the posted findings and names none", () => {
    const text = renderFallbackSummary("REQUEST_CHANGES", [f("secret title", 1), f("other", 2)]);
    expect(text).toContain("2 issues");
    expect(text).not.toContain("secret title");
  });
});

/**
 * The two pure pieces of `phase-turns.ts` — the turn/tool tally and the session
 * directory split.
 *
 * The split is here because it was wrong first, and wrongly in the way that
 * survives review: an instance id contains `__` itself
 * (`prreview__skillspro-1587-r2`), so taking the first two segments labels every
 * row `prreview` and every arm as the case, while the totals — the numbers the
 * issue is about — stay correct. A table of eight identical case names reads as
 * a formatting quirk.
 */
import { describe, expect, it } from "vitest";

import { splitSessionDir, tallyLines } from "./phase-turns.js";

const assistant = (...tools: string[]) =>
  JSON.stringify({
    type: "assistant",
    message: { role: "assistant", content: [{ type: "text", text: "…" }, ...tools.map((name) => ({ type: "tool_use", name }))] },
  });

describe("splitSessionDir", () => {
  it("keeps the `__` inside an instance id and takes the arm off the end", () => {
    expect(splitSessionDir("prreview__skillspro-1587-r2__wp3-minimal-d2ab-probes-sonnet")).toEqual({
      instanceId: "prreview__skillspro-1587-r2",
      arm: "wp3-minimal-d2ab-probes-sonnet",
    });
  });

  it("handles an id with no separator at all", () => {
    expect(splitSessionDir("something")).toEqual({ instanceId: "something", arm: "?" });
  });
});

describe("tallyLines", () => {
  it("counts assistant turns and tool_use blocks, several per turn", () => {
    const out = tallyLines([
      JSON.stringify({ type: "user", message: { role: "user", content: "go" } }),
      assistant("bash", "bash"),
      assistant("write"),
      JSON.stringify({ type: "result" }),
    ]);
    expect(out.turns).toBe(2);
    expect(out.tools).toEqual({ bash: 2, write: 1 });
  });

  it("skips blank and unparseable lines rather than throwing", () => {
    // A transcript truncated by a killed run still carries a usable count of
    // what it did before it died; refusing the file would lose the other cases.
    const out = tallyLines(["", assistant("bash"), '{"type":"assis']);
    expect(out).toEqual({ turns: 1, tools: { bash: 1 } });
  });

  it("ignores a user turn that happens to carry tool_result blocks", () => {
    const out = tallyLines([
      JSON.stringify({ type: "user", message: { role: "user", content: [{ type: "tool_result", name: "bash" }] } }),
      assistant(),
    ]);
    expect(out).toEqual({ turns: 1, tools: {} });
  });
});

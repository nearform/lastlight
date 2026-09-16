/**
 * `sortGatedFirst` — a STABLE partition, not a sort.
 *
 * The server already chose the order within a column; the only thing the client
 * has grounds to override is pulling the cards a human is blocking on to the
 * top. So the property under test is stability: a naive comparator on a boolean
 * would satisfy "gated first" while quietly reordering everything else, and
 * that reordering is invisible until an operator notices the board shuffling
 * under them every 20 s.
 */
import { describe, it, expect } from "vitest";
import type { BoardCard } from "../src/api";
import { sortGatedFirst } from "../src/components/board/BoardColumn";

const APPROVAL = { id: "ap-1", gate: "plan", createdAt: "2026-09-01T00:00:00.000Z" };

function card(key: string, gated = false): BoardCard {
  return {
    key,
    repo: "acme/widget",
    number: Number(key.replace(/\D/g, "")) || 0,
    title: key,
    author: "maintainer",
    createdAt: "2026-09-01T00:00:00.000Z",
    url: `https://github.com/acme/widget/issues/${key}`,
    labels: [],
    stageLabel: "Build",
    ambiguousStage: false,
    held: false,
    actions: [],
    ...(gated ? { approval: { ...APPROVAL, id: `ap-${key}` } } : {}),
  };
}

const keys = (cards: BoardCard[]) => cards.map((c) => c.key);

describe("sortGatedFirst", () => {
  it("moves gated cards to the front", () => {
    const out = sortGatedFirst([card("a"), card("b", true), card("c")]);
    expect(keys(out)).toEqual(["b", "a", "c"]);
  });

  it("preserves the server's relative order WITHIN the gated group", () => {
    const out = sortGatedFirst([card("g1", true), card("a"), card("g2", true), card("g3", true)]);
    expect(keys(out)).toEqual(["g1", "g2", "g3", "a"]);
  });

  it("preserves the server's relative order WITHIN the ungated group", () => {
    // The stability case a boolean comparator gets wrong: the ungated tail must
    // come back in exactly the order it arrived.
    const input = [card("n1"), card("n2"), card("g", true), card("n3"), card("n4"), card("n5")];
    expect(keys(sortGatedFirst(input))).toEqual(["g", "n1", "n2", "n3", "n4", "n5"]);
  });

  it("is a no-op on an already-partitioned list", () => {
    const input = [card("g1", true), card("g2", true), card("n1"), card("n2")];
    expect(keys(sortGatedFirst(input))).toEqual(keys(input));
  });

  it("leaves an all-gated or all-ungated column exactly as it came", () => {
    const gated = [card("g1", true), card("g2", true), card("g3", true)];
    const plain = [card("n1"), card("n2"), card("n3")];
    expect(keys(sortGatedFirst(gated))).toEqual(keys(gated));
    expect(keys(sortGatedFirst(plain))).toEqual(keys(plain));
  });

  it("returns a new array and does not mutate the input", () => {
    const input = [card("a"), card("g", true)];
    const snapshot = keys(input);
    const out = sortGatedFirst(input);
    expect(out).not.toBe(input);
    expect(keys(input)).toEqual(snapshot);
  });

  it("handles an empty column", () => {
    expect(sortGatedFirst([])).toEqual([]);
  });

  it("treats a null/absent/wrong-shaped approval as ungated rather than throwing", () => {
    const odd = [
      { ...card("null-approval"), approval: null },
      { ...card("string-approval"), approval: "pending" } as unknown as BoardCard,
      card("gated", true),
    ];
    expect(keys(sortGatedFirst(odd))).toEqual(["gated", "null-approval", "string-approval"]);
  });
});

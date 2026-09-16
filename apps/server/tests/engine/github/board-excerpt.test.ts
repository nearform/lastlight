import { describe, it, expect } from "vitest";
import { boardExcerpt } from "#src/engine/github/github.js";

/**
 * The board's body excerpt — clipped on the SERVER, not by the card.
 *
 * The cost being controlled is the payload: twenty repos x fifty items x an
 * essay-length issue body is a response whose whole design is "small enough to
 * serve from cache every twenty seconds". These tests pin the two properties a
 * card depends on — that the string is prose rather than markdown scaffolding,
 * and that a clipped one SAYS it was clipped.
 */
describe("boardExcerpt", () => {
  it("is empty for the absent cases, rather than the string 'undefined'", () => {
    expect(boardExcerpt(undefined)).toBe("");
    expect(boardExcerpt(null)).toBe("");
    expect(boardExcerpt("")).toBe("");
    expect(boardExcerpt("   \n\n  ")).toBe("");
  });

  it("collapses whitespace so the clip lands on prose, not a blank line", () => {
    expect(boardExcerpt("Readme   update\n\n\nWith  detail")).toBe("Readme update With detail");
  });

  it("returns a short body untouched and unmarked", () => {
    const body = "Update the README to mention the new flag.";
    expect(boardExcerpt(body)).toBe(body);
    expect(boardExcerpt(body)).not.toContain("…");
  });

  it("clips a long body and marks it, so the card never guesses", () => {
    const out = boardExcerpt("x".repeat(500));
    // 280 characters of body plus the ellipsis.
    expect(out).toHaveLength(281);
    expect(out.endsWith("…")).toBe(true);
  });

  it("does not leave a dangling space before the ellipsis", () => {
    // The 280th character falls inside a run of spaces: a naive slice would
    // render "word …", which reads as a typo rather than a truncation.
    // 279 y's + a collapsed single space lands the 280th character ON the
    // space, which is the only arrangement `trimEnd` has anything to do.
    const out = boardExcerpt(`${"y".repeat(279)}   tail`);
    expect(out).toBe(`${"y".repeat(279)}…`);
  });

  it("keeps a body of exactly the limit whole", () => {
    const exact = "z".repeat(280);
    expect(boardExcerpt(exact)).toBe(exact);
  });
});

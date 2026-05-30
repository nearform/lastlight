import { describe, expect, it } from "vitest";
import { truncateMiddle } from "./string";

describe("truncateMiddle", () => {
  it("returns the original string when shorter than max", () => {
    expect(truncateMiddle("hello", 10)).toBe("hello");
  });

  it("returns the original string when length equals max", () => {
    const text = "abcdefghij"; // length 10
    expect(truncateMiddle(text, 10)).toBe(text);
  });

  it("truncates in the middle when text is longer than max", () => {
    const text = "abcdefghijklmnopqrstuvwxyz";
    const max = 10;
    const result = truncateMiddle(text, max);

    expect(result.length).toBeLessThanOrEqual(max);
    expect(result).toContain("…");

    const [start, end] = result.split("…");
    expect(start.length).toBeGreaterThan(0);
    expect(end.length).toBeGreaterThan(0);
  });

  it("returns empty string when max is less than or equal to 0", () => {
    expect(truncateMiddle("hello", 0)).toBe("");
    expect(truncateMiddle("hello", -5)).toBe("");
  });

  it("returns first character when max is 1", () => {
    expect(truncateMiddle("hello", 1)).toBe("h");
  });
});

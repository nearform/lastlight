import { describe, it, expect } from "vitest";
import { reverseToLowercase } from "./text.js";

describe("reverseToLowercase", () => {
  it("reverses ASCII text and lowercases it", () => {
    const input = "HelloWorld";
    const result = reverseToLowercase(input);

    expect(result).toBe("dlrowolleh");
  });

  it("preserves punctuation and whitespace order in the reversed output", () => {
    const input = "  Abc!  ";
    const result = reverseToLowercase(input);

    expect(result).toBe("  !cba  ");
  });

  it("handles empty and single-character strings", () => {
    expect(reverseToLowercase("")).toBe("");
    expect(reverseToLowercase("X")).toBe("x");
  });

  it("handles basic Unicode and emoji by code point", () => {
    const input = "Åß😀";
    const expected = Array.from(input.toLowerCase()).reverse().join("");

    expect(reverseToLowercase(input)).toBe(expected);
  });

  it("is pure and does not mutate the original string", () => {
    const input = "AbC123";
    const copy = input;

    const firstCall = reverseToLowercase(input);
    const secondCall = reverseToLowercase(input);

    expect(firstCall).toBe("321cba");
    expect(secondCall).toBe("321cba");
    expect(copy).toBe("AbC123");
    expect(input).toBe("AbC123");
  });
});

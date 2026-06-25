import { describe, it, expect } from "vitest";
import { concatStrings } from "./string-utils.js";

describe("concatStrings", () => {
  it("concatenates two non-empty strings", () => {
    expect(concatStrings("foo", "bar")).toBe("foobar");
  });

  it("handles empty strings", () => {
    expect(concatStrings("", "bar")).toBe("bar");
    expect(concatStrings("foo", "")).toBe("foo");
    expect(concatStrings("", "")).toBe("");
  });

  it("preserves spaces when concatenating", () => {
    expect(concatStrings("hello ", "world")).toBe("hello world");
  });

  it("concatenates strings with common Unicode characters", () => {
    expect(concatStrings("hello ", "世界")).toBe("hello 世界");
    expect(concatStrings("👍", "🏽")).toBe("👍🏽");
  });
});

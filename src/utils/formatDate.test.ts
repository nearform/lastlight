import { describe, expect, it } from "vitest";
import { formatDateYYYYMMDD } from "./formatDate.js";

describe("formatDateYYYYMMDD", () => {
  it("formats a standard date", () => {
    const date = new Date(2024, 0, 15); // 15 Jan 2024
    expect(formatDateYYYYMMDD(date)).toBe("2024, 01, 15");
  });

  it("pads single-digit month and day with leading zeros", () => {
    expect(formatDateYYYYMMDD(new Date(2024, 0, 1))).toBe("2024, 01, 01");
    expect(formatDateYYYYMMDD(new Date(2024, 8, 9))).toBe("2024, 09, 09");
  });

  it("handles different years", () => {
    expect(formatDateYYYYMMDD(new Date(1999, 11, 31))).toBe("1999, 12, 31");
    expect(formatDateYYYYMMDD(new Date(2100, 5, 10))).toBe("2100, 06, 10");
  });

  it("throws on invalid Date instances", () => {
    const invalid = new Date(NaN);
    expect(() => formatDateYYYYMMDD(invalid)).toThrowError(
      /expected a valid Date instance/
    );
  });
});

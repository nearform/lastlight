import { describe, it, expect } from "vitest";
import { getWeekDifference } from "./date-utils.js";

// Helper to create a UTC date to avoid timezone/DST ambiguity
function utcDate(year: number, month: number, day: number, hours = 0, minutes = 0, seconds = 0) {
  return new Date(Date.UTC(year, month - 1, day, hours, minutes, seconds));
}

describe("getWeekDifference", () => {
  it("returns 0 for identical dates", () => {
    const d = utcDate(2024, 1, 1);
    expect(getWeekDifference(d, d)).toBe(0);
  });

  it("returns 0 when less than one week apart", () => {
    const a = utcDate(2024, 1, 1);
    const b = utcDate(2024, 1, 3);
    expect(getWeekDifference(a, b)).toBe(0);
    expect(getWeekDifference(b, a)).toBe(0);
  });

  it("returns 1 when exactly one week apart", () => {
    const a = utcDate(2024, 1, 1);
    const b = utcDate(2024, 1, 8);
    expect(getWeekDifference(a, b)).toBe(1);
  });

  it("returns correct value for multiple weeks apart", () => {
    const a = utcDate(2024, 1, 1);
    const b = utcDate(2024, 1, 22); // 21 days
    expect(getWeekDifference(a, b)).toBe(3);
  });

  it("is order agnostic", () => {
    const a = utcDate(2024, 5, 1);
    const b = utcDate(2024, 6, 12);
    expect(getWeekDifference(a, b)).toBe(getWeekDifference(b, a));
  });

  it("handles large spans correctly", () => {
    const a = utcDate(2024, 1, 1);
    const b = utcDate(2025, 1, 1); // 365 days
    expect(getWeekDifference(a, b)).toBe(Math.floor(365 / 7));
  });

  it("handles leap year differences", () => {
    const a = utcDate(2020, 2, 1);
    const b = utcDate(2020, 3, 1); // 29 days in Feb 2020
    expect(getWeekDifference(a, b)).toBe(Math.floor(29 / 7));
  });

  it("handles DST transition boundaries using UTC dates", () => {
    // These use UTC timestamps so they are exactly 7 days apart regardless of local DST rules.
    const beforeDst = utcDate(2024, 3, 10); // Around US DST start
    const afterDst = utcDate(2024, 3, 17);
    expect(getWeekDifference(beforeDst, afterDst)).toBe(1);

    const slightlyLessThanWeekStart = new Date(beforeDst.getTime() + (7 * 24 * 60 * 60 * 1000 - 1));
    expect(getWeekDifference(beforeDst, slightlyLessThanWeekStart)).toBe(0);

    const slightlyMoreThanWeekStart = new Date(beforeDst.getTime() + (7 * 24 * 60 * 60 * 1000 + 1));
    expect(getWeekDifference(beforeDst, slightlyMoreThanWeekStart)).toBe(1);
  });
});

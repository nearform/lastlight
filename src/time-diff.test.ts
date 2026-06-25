import { describe, it, expect } from "vitest";
import { humanTimeDiff, formatDateDifference } from "./time-diff.js";

const BASE_DATE = new Date("2026-01-01T00:00:00Z");

describe("humanTimeDiff / formatDateDifference", () => {
  it("handles basic units and rounding", () => {
    const thirtySecondsLater = new Date(BASE_DATE.getTime() + 30_000);
    expect(formatDateDifference(BASE_DATE, thirtySecondsLater)).toBe(
      "30 seconds",
    );

    const ninetySecondsLater = new Date(BASE_DATE.getTime() + 90_000);
    expect(formatDateDifference(BASE_DATE, ninetySecondsLater)).toBe(
      "2 minutes",
    );

    const twoAndHalfHoursLater = new Date(
      BASE_DATE.getTime() + 2.5 * 60 * 60 * 1000,
    );
    expect(formatDateDifference(BASE_DATE, twoAndHalfHoursLater)).toBe(
      "3 hours",
    );

    const twentySixHoursLater = new Date(
      BASE_DATE.getTime() + 26 * 60 * 60 * 1000,
    );
    expect(formatDateDifference(BASE_DATE, twentySixHoursLater)).toBe(
      "1 day",
    );
  });

  it("promotes from days to weeks", () => {
    const tenDaysLater = new Date(BASE_DATE.getTime() + 10 * 24 * 60 * 60 * 1000);
    expect(formatDateDifference(BASE_DATE, tenDaysLater)).toBe("1 week");

    const fortyTwoDaysLater = new Date(
      BASE_DATE.getTime() + 42 * 24 * 60 * 60 * 1000,
    );
    expect(formatDateDifference(BASE_DATE, fortyTwoDaysLater)).toBe("6 weeks");
  });

  it("is symmetric and handles zero difference", () => {
    const later = new Date(BASE_DATE.getTime() + 5 * 60 * 1000);

    const diffForward = humanTimeDiff(BASE_DATE, later);
    const diffBackward = humanTimeDiff(later, BASE_DATE);

    expect(diffForward).toEqual(diffBackward);

    const zeroDiff = humanTimeDiff(BASE_DATE, BASE_DATE);
    expect(zeroDiff).toEqual({ value: 0, unit: "second" });
    expect(formatDateDifference(BASE_DATE, BASE_DATE)).toBe("0 seconds");
  });

  it("normalizes different input forms", () => {
    const ms = BASE_DATE.getTime();

    const fromDate = humanTimeDiff(BASE_DATE, ms);
    const fromIso = humanTimeDiff(BASE_DATE.toISOString(), ms);

    expect(fromIso).toEqual(fromDate);
  });

  it("throws on invalid string input", () => {
    expect(() =>
      formatDateDifference("not-a-date", BASE_DATE),
    ).toThrowError(/not-a-date/);
  });
});

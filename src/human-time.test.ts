import { describe, it, expect } from "vitest";
import { humanDateDiff } from "./human-time.js";

const secondMs = 1000;
const minuteMs = 60 * secondMs;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;

function span(fromOffsetMs: number, diffMs: number): [Date, Date] {
  const from = new Date(fromOffsetMs);
  const to = new Date(fromOffsetMs + diffMs);
  return [from, to];
}

describe("humanDateDiff", () => {
  it("formats basic units in long style", () => {
    let from: Date, to: Date;

    [from, to] = span(0, 1 * secondMs);
    expect(humanDateDiff(from, to)).toBe("1 second");

    [from, to] = span(0, 30 * secondMs);
    expect(humanDateDiff(from, to)).toBe("30 seconds");

    [from, to] = span(0, 59 * secondMs);
    expect(humanDateDiff(from, to)).toBe("59 seconds");

    [from, to] = span(0, 61 * secondMs);
    expect(humanDateDiff(from, to)).toBe("1 minute");

    [from, to] = span(0, 5 * minuteMs);
    expect(humanDateDiff(from, to)).toBe("5 minutes");

    [from, to] = span(0, 59 * minuteMs);
    expect(humanDateDiff(from, to)).toBe("59 minutes");

    [from, to] = span(0, 2 * hourMs);
    expect(humanDateDiff(from, to)).toBe("2 hours");

    [from, to] = span(0, 36 * hourMs);
    expect(humanDateDiff(from, to)).toBe("36 hours");

    [from, to] = span(0, 3 * dayMs);
    expect(humanDateDiff(from, to)).toBe("3 days");

    [from, to] = span(0, 45 * dayMs);
    expect(humanDateDiff(from, to)).toBe("45 days");

    [from, to] = span(0, 90 * dayMs);
    expect(humanDateDiff(from, to)).toBe("3 months");

    const threeYearsMs = 3 * 365 * dayMs;
    [from, to] = span(0, threeYearsMs);
    expect(humanDateDiff(from, to)).toBe("3 years");
  });

  it("supports short style units", () => {
    let from: Date, to: Date;

    [from, to] = span(0, 45 * secondMs);
    expect(humanDateDiff(from, to, { style: "short" })).toBe("45s");

    [from, to] = span(0, 3 * minuteMs);
    expect(humanDateDiff(from, to, { style: "short" })).toBe("3m");

    [from, to] = span(0, 2 * hourMs);
    expect(humanDateDiff(from, to, { style: "short" })).toBe("2h");

    [from, to] = span(0, 5 * dayMs);
    expect(humanDateDiff(from, to, { style: "short" })).toBe("5d");

    [from, to] = span(0, 4 * 30 * dayMs);
    expect(humanDateDiff(from, to, { style: "short" })).toBe("4mo");

    const twoYearsMs = 2 * 365 * dayMs;
    [from, to] = span(0, twoYearsMs);
    expect(humanDateDiff(from, to, { style: "short" })).toBe("2y");
  });

  it("is direction-agnostic (absolute span)", () => {
    const from = new Date("2024-01-01T00:00:00Z");
    const to = new Date("2024-01-01T01:30:00Z");

    const forward = humanDateDiff(from, to);
    const backward = humanDateDiff(to, from);

    expect(forward).toBe(backward);
  });

  it("returns zero when dates are equal or nearly equal", () => {
    const d1 = new Date("2024-01-01T00:00:00Z");
    const d2 = new Date(d1.getTime());

    expect(humanDateDiff(d1, d2)).toBe("0 seconds");
    expect(humanDateDiff(d1, d2, { style: "short" })).toBe("0s");
  });

  it("returns a sentinel string for invalid inputs", () => {
    expect(humanDateDiff("not-a-date", "2024-01-01T00:00:00Z")).toBe("[invalid date]");
    expect(humanDateDiff("2024-01-01T00:00:00Z", "not-a-date")).toBe("[invalid date]");
    expect(humanDateDiff(NaN, NaN)).toBe("[invalid date]");
  });
});

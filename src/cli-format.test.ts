import { describe, it, expect, vi, afterEach } from "vitest";
import { age } from "./cli-format.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("age", () => {
  it("returns empty string for nullish or empty inputs", () => {
    expect(age(null)).toBe("");
    expect(age(undefined)).toBe("");
    expect(age("")).toBe("");
  });

  it("parses ISO strings and numeric unix-seconds timestamps", () => {
    const now = Date.parse("2024-01-01T00:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);

    const thirtySecondsAgoIso = new Date(now - 30 * 1000).toISOString();
    expect(age(thirtySecondsAgoIso)).toBe("30s ago");

    const thirtySecondsAgoSeconds = Math.round(now / 1000) - 30;
    expect(age(thirtySecondsAgoSeconds)).toBe("30s ago");
  });

  it("formats minutes, hours, and days correctly", () => {
    const now = Date.parse("2024-01-01T00:00:00Z");
    vi.spyOn(Date, "now").mockReturnValue(now);

    const ninetySecondsAgo = new Date(now - 90 * 1000).toISOString();
    expect(age(ninetySecondsAgo)).toBe("2m ago");

    const threeHoursAgo = new Date(now - 3 * 60 * 60 * 1000).toISOString();
    expect(age(threeHoursAgo)).toBe("3h ago");

    const threeDaysAgo = new Date(now - 3 * 24 * 60 * 60 * 1000).toISOString();
    expect(age(threeDaysAgo)).toBe("3d ago");
  });

  it("surfaces invalid inputs as strings", () => {
    expect(age("not-a-date")).toBe("not-a-date");
  });
});

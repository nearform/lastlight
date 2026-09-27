import { execFileSync } from "child_process";
import { describe, it, expect } from "vitest";
import {
  CGROUP_USAGE_SCRIPT,
  combineUsage,
  isUsageLine,
  parseUsageLine,
} from "#src/sandbox/resource-usage.js";

const line = (usec: string, peak: string, max: string) =>
  JSON.stringify({ type: "lastlight_sandbox_usage", usage_usec: usec, memory_peak: peak, memory_max: max });

describe("parseUsageLine", () => {
  it("reads cgroup CPU microseconds as seconds, plus the memory peak and limit", () => {
    expect(parseUsageLine(line("12500000", "734003200", "8589934592"))).toEqual({
      cpuSeconds: 12.5,
      peakMemoryBytes: 734003200,
      memoryLimitBytes: 8589934592,
    });
  });

  it("drops an unlimited memory.max and a missing memory.peak (kernel < 5.19)", () => {
    expect(parseUsageLine(line("1000000", "", "max"))).toEqual({ cpuSeconds: 1 });
  });

  it("is undefined without a CPU reading (no cgroup v2) or for any other line", () => {
    expect(parseUsageLine(line("", "", ""))).toBeUndefined();
    expect(parseUsageLine(`{"type":"message_end"}`)).toBeUndefined();
    expect(parseUsageLine("plain output")).toBeUndefined();
  });
});

describe("combineUsage", () => {
  it("adds CPU and keeps the largest memory peak and limit", () => {
    const a = { cpuSeconds: 10, peakMemoryBytes: 500, memoryLimitBytes: 1000 };
    const b = { cpuSeconds: 5, peakMemoryBytes: 800 };
    expect(combineUsage(a, b)).toEqual({ cpuSeconds: 15, peakMemoryBytes: 800, memoryLimitBytes: 1000 });
    expect(combineUsage(undefined, b)).toEqual(b);
  });
});

describe("CGROUP_USAGE_SCRIPT", () => {
  // Runs the real snippet under `sh`. Off Linux the cgroup files are absent, so
  // this pins the degraded path: one well-formed marker line, not an error.
  it("prints exactly one marker line even where the cgroup files don't exist", () => {
    const out = execFileSync("sh", ["-c", CGROUP_USAGE_SCRIPT], { encoding: "utf8" });
    const lines = out.trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(isUsageLine(lines[0]!)).toBe(true);
    expect(() => JSON.parse(lines[0]!)).not.toThrow();
  });
});

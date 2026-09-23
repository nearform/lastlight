import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MICRO_LATENCY_CAVEAT,
  MICRO_RANKABLE_REPEATS,
  MICRO_STALE_HEARTBEAT_MS,
  microFireRate,
  microRange,
  microSeries,
  microRankable,
  microStatus,
  withMicroEntryDefaults,
  parseMicroStamp,
  summariseMicroReport,
} from "./micro-survey.js";
import { buildMicroIndex } from "./report.js";

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "micro-survey-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const report = (over: Record<string, unknown> = {}) => ({
  label: "with-agents-md",
  family: "enforcement",
  model: "anthropic/claude-haiku-4-5-20251001",
  thinking: null,
  repeats: 3,
  fixture: "/fixtures/arm2/prreview__skillspro-1587-r3",
  baseline: { rows: 12, needsProbe: 0, needsProbePct: 0, reassuranceShaped: 0 },
  results: [
    { rows: 12, needsProbe: 2, needsProbePct: 16.7, reassuranceShaped: 0, costUsd: 0.32 },
    { rows: 12, needsProbe: 0, needsProbePct: 0, reassuranceShaped: 1, costUsd: 0.28 },
  ],
  claims: [["PROBE [Important] a"], ["  .   [Minor] b"]],
  ...over,
});

describe("parseMicroStamp", () => {
  it("recovers the ISO instant the script flattened into the filename", () => {
    expect(parseMicroStamp("2026-09-23T10-15-30-123Z-with-agents-md-enforcement")).toBe(
      "2026-09-23T10:15:30.123Z",
    );
  });

  it("returns null for a name that is not stamped", () => {
    expect(parseMicroStamp("notes")).toBeNull();
  });
});

describe("microRange", () => {
  it("is a min-max spread, and reports a single point as itself", () => {
    expect(microRange([16.7, 0, 41.7])).toEqual({ min: 0, max: 41.7 });
    expect(microRange([16.7])).toEqual({ min: 16.7, max: 16.7 });
  });

  it("is null for an empty band rather than a zero spread", () => {
    expect(microRange([])).toBeNull();
  });
});

describe("microFireRate", () => {
  it("is fired ÷ done — the fraction of repeats that asked for a probe", () => {
    expect(microFireRate(1, 3)).toBeCloseTo(1 / 3, 10);
    expect(microFireRate(0, 4)).toBe(0);
  });

  it("is null before any repeat completes, never zero", () => {
    expect(microFireRate(0, 0)).toBeNull();
  });
});

describe("microRankable", () => {
  it("refuses to rank a band shorter than the coin-flip floor", () => {
    expect(microRankable(MICRO_RANKABLE_REPEATS - 1)).toBe(false);
    expect(microRankable(MICRO_RANKABLE_REPEATS)).toBe(true);
    expect(microRankable(0)).toBe(false);
  });
});

describe("microStatus", () => {
  const now = Date.parse("2026-09-23T12:00:00.000Z");
  const ago = (ms: number) => new Date(now - ms).toISOString();

  it("is complete when the final write landed", () => {
    expect(microStatus({ live: false, heartbeat: ago(0) }, now)).toBe("complete");
  });

  it("is complete for a report that predates the live flag entirely", () => {
    expect(microStatus({}, now)).toBe("complete");
  });

  it("is running while the heartbeat is fresh", () => {
    expect(microStatus({ live: true, heartbeat: ago(1_000) }, now)).toBe("running");
    expect(microStatus({ live: true, heartbeat: ago(MICRO_STALE_HEARTBEAT_MS) }, now)).toBe("running");
  });

  it("is interrupted once the heartbeat goes stale — silence is not progress", () => {
    expect(microStatus({ live: true, heartbeat: ago(MICRO_STALE_HEARTBEAT_MS + 1) }, now)).toBe("interrupted");
    expect(microStatus({ live: true, heartbeat: ago(10 * 60_000) }, now)).toBe("interrupted");
  });

  it("is interrupted for a live report with no usable heartbeat at all", () => {
    expect(microStatus({ live: true }, now)).toBe("interrupted");
    expect(microStatus({ live: true, heartbeat: "not-a-date" }, now)).toBe("interrupted");
    expect(microStatus({ live: true, heartbeat: null }, now)).toBe("interrupted");
  });
});

describe("summariseMicroReport", () => {
  it("keeps the baseline beside the per-repeat replay values", () => {
    const e = summariseMicroReport("2026-09-23T10-15-30-123Z-with-agents-md-enforcement", report(), "x")!;
    expect(e.baselineNeedsProbePct).toBe(0);
    expect(e.needsProbePct).toEqual([16.7, 0]);
    expect(e.reassuranceShaped).toEqual([0, 1]);
    expect(e.costUsd).toBeCloseTo(0.6, 5);
    expect(e.generatedAt).toBe("2026-09-23T10:15:30.123Z");
    expect(e.report).toBe("/data/micro-survey/2026-09-23T10-15-30-123Z-with-agents-md-enforcement.json");
  });

  it("falls back to the supplied mtime when the name carries no stamp", () => {
    const e = summariseMicroReport("adhoc", report(), "2026-01-01T00:00:00.000Z")!;
    expect(e.generatedAt).toBe("2026-01-01T00:00:00.000Z");
  });

  it("carries the live fields and the fire rate through to the index entry", () => {
    const e = summariseMicroReport(
      "x",
      report({
        repeats: 10,
        repeatsDone: 3,
        live: true,
        heartbeat: "2026-09-23T06:41:02.123Z",
        ambientSkills: false,
        agentsMd: true,
        fireRate: 1 / 3,
        firedRepeats: 1,
      }),
      "x",
    )!;
    expect(e.repeats).toBe(10);
    expect(e.repeatsDone).toBe(3);
    expect(e.live).toBe(true);
    expect(e.heartbeat).toBe("2026-09-23T06:41:02.123Z");
    expect(e.ambientSkills).toBe(false);
    expect(e.agentsMd).toBe(true);
    expect(e.firedRepeats).toBe(1);
    expect(e.fireRate).toBeCloseTo(1 / 3, 10);
  });

  it("derives the fire rate from results[] on a report written before the field existed", () => {
    const e = summariseMicroReport("x", report(), "x")!;
    expect(e.repeatsDone).toBe(2);
    expect(e.firedRepeats).toBe(1); // one repeat marked 2 rows, one marked none
    expect(e.fireRate).toBe(0.5);
    expect(e.live).toBe(false);
    expect(e.heartbeat).toBeNull();
    expect(e.ambientSkills).toBeNull();
    expect(e.agentsMd).toBeNull();
  });

  it("has a null fire rate, not a zero one, before any repeat completes", () => {
    const e = summariseMicroReport("x", report({ results: [], claims: [], repeatsDone: 0, live: true }), "x")!;
    expect(e.fireRate).toBeNull();
    expect(e.firedRepeats).toBe(0);
  });
  it("rejects a document that is not a micro-survey report", () => {
    expect(summariseMicroReport("x", { hello: 1 }, "x")).toBeNull();
    expect(summariseMicroReport("x", null, "x")).toBeNull();
  });

  it("records `repeats` as launched, so a short band is visible as one", () => {
    const e = summariseMicroReport("x", report({ repeats: 5 }), "x")!;
    expect(e.repeats).toBe(5);
    expect(e.needsProbePct).toHaveLength(2);
  });
});

describe("withMicroEntryDefaults", () => {
  const legacy = {
    id: "x",
    report: "/data/micro-survey/x.json",
    generatedAt: "2026-09-23T10:15:30.123Z",
    label: "old",
    family: "enforcement",
    model: "m",
    thinking: null,
    repeats: 3,
    fixture: "/f",
    baselineNeedsProbePct: 0,
    baselineRows: 12,
    needsProbePct: [41.7, 0, 0],
    rows: [12, 12, 12],
    reassuranceShaped: [0, 1, 0],
    costUsd: 0.7,
  } as unknown as Parameters<typeof withMicroEntryDefaults>[0];

  it("derives the live + fire-rate fields for an index baked by an older harness", () => {
    const e = withMicroEntryDefaults(legacy);
    expect(e.repeatsDone).toBe(3);
    expect(e.firedRepeats).toBe(1);
    expect(e.fireRate).toBeCloseTo(1 / 3, 10);
    expect(e.live).toBe(false);
    expect(e.heartbeat).toBeNull();
    expect(e.ambientSkills).toBeNull();
    expect(microStatus(e, Date.now())).toBe("complete");
  });

  it("gives an index baked before latency existed one null per completed repeat", () => {
    const e = withMicroEntryDefaults(legacy);
    expect(e.durationSec).toEqual([null, null, null]);
    expect(e.turns).toEqual([null, null, null]);
    expect(e.toolCalls).toEqual([null, null, null]);
    expect(microSeries(e.durationSec).any).toBe(false);
  });

  it("passes a current entry straight through", () => {
    const current = summariseMicroReport("x", report({ live: true, heartbeat: "2026-09-23T06:41:02.123Z" }), "x")!;
    expect(withMicroEntryDefaults(current)).toBe(current);
  });
});

describe("microSeries", () => {
  it("summarises a timed band as points + range + total, and no mean", () => {
    const s = microSeries([145.2, 92.5, 200]);
    expect(s.measured).toEqual([145.2, 92.5, 200]);
    expect(s.missing).toBe(0);
    expect(s.range).toEqual({ min: 92.5, max: 200 });
    expect(s.total).toBeCloseTo(437.7, 5);
    expect(s.any).toBe(true);
    expect(Object.keys(s)).not.toContain("mean");
  });

  it("drops the untimed repeats from the arithmetic and counts them instead", () => {
    const s = microSeries([145.2, null, undefined, 92.5]);
    expect(s.measured).toEqual([145.2, 92.5]);
    expect(s.missing).toBe(2);
    expect(s.total).toBeCloseTo(237.7, 5);
    expect(s.range).toEqual({ min: 92.5, max: 145.2 });
  });

  it("has a null total and range when nothing was measured — never a zero one", () => {
    for (const band of [[], [null, null], undefined]) {
      const s = microSeries(band as (number | null)[] | undefined);
      expect(s.total).toBeNull();
      expect(s.range).toBeNull();
      expect(s.any).toBe(false);
    }
    expect(microSeries([null, null]).missing).toBe(2);
  });

  it("reports a single point as itself, not as a spread", () => {
    expect(microSeries([145.2]).range).toEqual({ min: 145.2, max: 145.2 });
  });

  it("ships a permanent concurrency caveat for every arm-level aggregate", () => {
    expect(MICRO_LATENCY_CAVEAT).toMatch(/serial/i);
    expect(MICRO_LATENCY_CAVEAT).toMatch(/cost, fire rate and severity are unaffected/i);
  });
});

describe("latency in the index entry", () => {
  const timed = () =>
    report({
      results: [
        {
          rows: 12,
          needsProbe: 2,
          needsProbePct: 16.7,
          reassuranceShaped: 0,
          costUsd: 0.32,
          durationSec: 145.2,
          turns: 31,
          toolCalls: 39,
        },
        {
          rows: 12,
          needsProbe: 0,
          needsProbePct: 0,
          reassuranceShaped: 1,
          costUsd: 0.28,
          durationSec: 92.5,
          turns: null,
          toolCalls: null,
        },
      ],
    });

  it("carries wall clock, turns and tool calls per repeat", () => {
    const e = summariseMicroReport("x", timed(), "x")!;
    expect(e.durationSec).toEqual([145.2, 92.5]);
    expect(e.turns).toEqual([31, null]);
    expect(e.toolCalls).toEqual([39, null]);
    expect(microSeries(e.durationSec).total).toBeCloseTo(237.7, 5);
    // The list reads the index alone, so the same arithmetic must be available
    // there as in the detail view — one function, no second implementation.
    expect(microSeries(e.turns).total).toBe(31);
    expect(microSeries(e.turns).missing).toBe(1);
  });

  it("degrades to nulls — not zeros — on a report written before latency existed", () => {
    const e = summariseMicroReport("x", report(), "x")!;
    expect(e.durationSec).toEqual([null, null]);
    expect(e.turns).toEqual([null, null]);
    expect(e.toolCalls).toEqual([null, null]);
    const s = microSeries(e.durationSec);
    expect(s.any).toBe(false);
    expect(s.total).toBeNull();
    expect(s.missing).toBe(2);
  });

  it("survives a repeat that recorded a duration but no turn counts", () => {
    const e = summariseMicroReport(
      "x",
      report({
        results: [{ rows: 12, needsProbe: 1, needsProbePct: 8.3, reassuranceShaped: 0, durationSec: 10 }],
      }),
      "x",
    )!;
    expect(e.durationSec).toEqual([10]);
    expect(e.turns).toEqual([null]);
    expect(microSeries(e.toolCalls).any).toBe(false);
  });
});

describe("buildMicroIndex", () => {
  it("is an empty list when nothing has been replayed here", () => {
    expect(buildMicroIndex(tmp(), "now").reports).toEqual([]);
    expect(buildMicroIndex(join(tmp(), "nope"), "now").reports).toEqual([]);
  });

  it("lists reports newest first and skips half-written ones", () => {
    const root = tmp();
    const dir = join(root, "micro-survey");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "2026-09-23T10-15-30-123Z-early-enforcement.json"), JSON.stringify(report()));
    writeFileSync(join(dir, "2026-09-23T11-15-30-123Z-late-security.json"), JSON.stringify(report({ label: "late" })));
    writeFileSync(join(dir, "2026-09-23T12-15-30-123Z-torn-security.json"), '{"label":');
    writeFileSync(join(dir, "README.md"), "not json");

    const idx = buildMicroIndex(root, "now");
    expect(idx.reports.map((r) => r.label)).toEqual(["late", "with-agents-md"]);
  });
});

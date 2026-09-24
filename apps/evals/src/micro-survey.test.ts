import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MICRO_LATENCY_CAVEAT,
  MICRO_RANKABLE_REPEATS,
  MICRO_STALE_HEARTBEAT_MS,
  MICRO_GOLD_LINE_WINDOW,
  microFireRate,
  microGoldRepeat,
  microGoldScore,
  microGoldSeries,
  microGoldVote,
  microRange,
  microRowReachesGold,
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

// ── the gold overlay ─────────────────────────────────────────────────────────

const G = [
  { file: "packages/backend/src/routes/users.ts", line: 103, severity: "medium", summary: "dual roster" },
  { file: "packages/backend/src/routes/auth.ts", line: 141, severity: "medium", summary: "nonce not burned" },
  { file: "packages/frontend/src/contexts/AuthContext.tsx", line: 65, severity: "high", summary: "login never set" },
];
type R = { id: string; probe: boolean; quotes?: { path: string; line: number }[]; bothEnds?: Record<string, string>; evidence?: { control_site?: string } };
const probeOf = (r: R) => r.probe;

describe("microRowReachesGold", () => {
  it("reaches a gold through any cited site within the window — quote, bothEnds or control site", () => {
    const g = G[0];
    expect(microRowReachesGold({ quotes: [{ path: g.file, line: 103 + MICRO_GOLD_LINE_WINDOW }] }, g)).toBe(true);
    expect(microRowReachesGold({ bothEnds: { enforcedAt: `${g.file}:110` } }, g)).toBe(true);
    expect(microRowReachesGold({ evidence: { control_site: `${g.file}:96-99` } }, g)).toBe(true);
    expect(microRowReachesGold({ quotes: [{ path: g.file, line: 103 + MICRO_GOLD_LINE_WINDOW + 1 }] }, g)).toBe(false);
  });

  it("matches the file by path suffix, and never across files", () => {
    expect(microRowReachesGold({ quotes: [{ path: "./packages/backend/src/routes/users.ts", line: 103 }] }, G[0])).toBe(true);
    expect(microRowReachesGold({ quotes: [{ path: "packages/backend/src/routes/auth.ts", line: 103 }] }, G[0])).toBe(false);
  });

  it("treats a gold with no line as reachable anywhere in its file, and one with no file as unreachable", () => {
    expect(microRowReachesGold({ quotes: [{ path: G[0].file, line: 900 }] }, { file: G[0].file })).toBe(true);
    expect(microRowReachesGold({ quotes: [{ path: G[0].file, line: 103 }] }, {})).toBe(false);
  });

  it("ignores a control site of `none` rather than parsing it", () => {
    expect(microRowReachesGold({ evidence: { control_site: "none" } }, G[0])).toBe(false);
  });
});

describe("microGoldRepeat", () => {
  const rows: R[] = [
    { id: "e-1", probe: true, quotes: [{ path: G[0].file, line: 104 }] }, // at G1, reassures
    { id: "e-2", probe: true, quotes: [{ path: G[1].file, line: 150 }] }, // at G2
    { id: "e-3", probe: false, quotes: [{ path: G[1].file, line: 139 }] }, // also at G2
    { id: "e-4", probe: true, quotes: [{ path: "src/elsewhere.ts", line: 1 }] }, // at nothing
  ];

  it("an asserting row wins over location: the judge's credit is the verdict", () => {
    const o = microGoldRepeat({ rows, gold: G, rowForGold: [null, 1, null], probeOf });
    expect(o.cells.map((c) => c.verdict)).toEqual(["reached", "asserted", "missed"]);
    expect(o.cells[1]).toEqual({ verdict: "asserted", rows: ["e-2"], probed: true });
    expect(o.asserted).toBe(1);
    expect(o.reached).toBe(1);
  });

  it("a reached gold carries every row in reach, and is probed if any of them asked", () => {
    const o = microGoldRepeat({ rows, gold: G, rowForGold: [null, null, null], probeOf });
    expect(o.cells[1]).toEqual({ verdict: "reached", rows: ["e-2", "e-3"], probed: true });
  });

  it("splits every probe request into on-gold and off-gold, summing to the probes asked", () => {
    const o = microGoldRepeat({ rows, gold: G, rowForGold: [null, 1, null], probeOf });
    expect(o.probesOnGold).toBe(2); // e-1 (reaches G1), e-2 (asserts G2)
    expect(o.probesOffGold).toBe(1); // e-4
    expect(o.probesOnGold + o.probesOffGold).toBe(rows.filter(probeOf).length);
  });

  it("an asserting row counts as on-gold even when it cites nowhere near the anchor", () => {
    const o = microGoldRepeat({ rows, gold: G, rowForGold: [null, null, 3], probeOf });
    expect(o.cells[2].verdict).toBe("asserted");
    expect(o.probesOffGold).toBe(0);
  });

  it("an unjudged repeat has asserted `null`, never zero — and keeps its location verdicts", () => {
    const o = microGoldRepeat({ rows, gold: G, rowForGold: null, probeOf });
    expect(o.asserted).toBeNull();
    expect(o.cells.map((c) => c.verdict)).toEqual(["reached", "reached", "missed"]);
  });
});

describe("microGoldSeries", () => {
  const cell = (verdict: "asserted" | "reached" | "missed", probed = false) => ({ verdict, rows: [], probed });
  const overlay = (cells: ReturnType<typeof cell>[], asserted: number | null, on = 0, off = 0) => ({
    cells, asserted, reached: cells.filter((c) => c.verdict === "reached").length, probesOnGold: on, probesOffGold: off,
  });

  it("tallies each gold across repeats, counting `asserted` only over judged repeats", () => {
    const s = microGoldSeries(G, [
      { gold: overlay([cell("reached", true), cell("asserted", true), cell("missed")], 1, 2, 5) },
      { gold: overlay([cell("reached"), cell("reached"), cell("missed")], null, 0, 3) },
      {}, // a repeat that carried no overlay at all
    ]);
    expect(s.goldAsserted).toEqual([1, null, null]);
    expect(s.goldReached).toEqual([1, 2, null]);
    expect(s.probesOnGold).toEqual([2, 0, null]);
    expect(s.probesOffGold).toEqual([5, 3, null]);
    expect(s.perGold?.[1]).toEqual({ asserted: 1, reached: 1, missed: 0, probedAtGold: 1, repeats: 2, judged: 1 });
    expect(s.perGold?.[0].probedAtGold).toBe(1);
  });

  it("a report with no gold yields no quality view rather than a row of zeros", () => {
    expect(microGoldSeries(null, [{}])).toEqual({
      gold: null, goldAsserted: [], goldReached: [], probesOnGold: [], probesOffGold: [], perGold: null,
      goldF1: [], goldPrecision: [], goldRecall: [],
    });
  });

  it("reaches the index entry through summariseMicroReport, with the baseline overlay beside it", () => {
    const baselineGold = overlay([cell("reached"), cell("missed"), cell("missed")], 0);
    const e = summariseMicroReport(
      "2026-09-24T10-00-00-000Z-x-enforcement",
      report({
        gold: G,
        baselineGold,
        results: [{ rows: 12, needsProbe: 2, needsProbePct: 16.7, reassuranceShaped: 0, gold: overlay([cell("asserted", true), cell("missed"), cell("missed")], 1, 2, 0) }],
      }),
      "2026-09-24T10:00:00.000Z",
    );
    expect(e?.goldAsserted).toEqual([1]);
    expect(e?.baselineGold).toEqual(baselineGold);
    expect(e?.gold).toHaveLength(3);
  });

  it("an entry from an older server degrades to no quality view", () => {
    const old = summariseMicroReport("2026-09-24T10-00-00-000Z-x-enforcement", report(), "x")!;
    const { gold, goldAsserted, perGold, baselineGold, ...legacy } = old;
    void gold; void goldAsserted; void perGold; void baselineGold;
    const filled = withMicroEntryDefaults(legacy as never);
    expect(filled.goldAsserted).toEqual([]);
    expect(filled.perGold).toBeNull();
    expect(filled.baselineGold).toBeNull();
  });
});

describe("microGoldScore", () => {
  const rows = [
    { id: "a", probe: false, claim: true, quotes: [{ path: G[1].file, line: 141 }] }, // claims + credited to G2
    { id: "b", probe: false, claim: true, quotes: [{ path: "x.ts", line: 1 }] }, // claims a defect the gold lacks
    { id: "c", probe: true, claim: false, quotes: [{ path: G[0].file, line: 103 }] }, // a reassurance
  ];
  const o = microGoldRepeat({ rows, gold: G, rowForGold: [null, 0, null], probeOf: (r) => r.probe, claimOf: (r) => r.claim });

  it("counts claims and the credited claims, ignoring reassurance rows", () => {
    expect(o.claimed).toBe(2);
    expect(o.claimedAsserting).toBe(1);
  });

  it("scores precision over claims and recall over ALL the case's gold", () => {
    const s = microGoldScore(o, G.length)!;
    expect(s.precision).toBeCloseTo(1 / 2, 10);
    expect(s.recall).toBeCloseTo(1 / 3, 10);
    expect(s.f1).toBeCloseTo(2 * (0.5 * (1 / 3)) / (0.5 + 1 / 3), 10);
  });

  it("is null for an unjudged repeat, and for an overlay that predates the claim counts", () => {
    expect(microGoldScore({ ...o, asserted: null }, G.length)).toBeNull();
    const { claimed, claimedAsserting, ...legacy } = o;
    void claimed; void claimedAsserting;
    expect(microGoldScore(legacy, G.length)).toBeNull();
  });

  it("counts a row the judge credited as a claim even when its evidence is a reassurance", () => {
    const o2 = microGoldRepeat({ rows, gold: G, rowForGold: [2, null, null], probeOf: (r) => r.probe, claimOf: (r) => r.claim });
    expect(o2.claimed).toBe(3); // a, b, and the credited reassurance c
    expect(o2.claimedAsserting).toBe(1);
    expect(microGoldScore(o2, G.length)!.precision).toBeGreaterThan(0);
  });

  it("scores a repeat that claims nothing as zero, not as undefined", () => {
    const none = microGoldRepeat({ rows: [], gold: G, rowForGold: [null, null, null], probeOf: () => false, claimOf: () => true });
    expect(microGoldScore(none, G.length)).toEqual({ precision: 0, recall: 0, f1: 0 });
  });
});

describe("microGoldVote", () => {
  it("credits a gold only when more than half the passes did", () => {
    const v = microGoldVote([[0, null], [0, null], [null, 3]], 2);
    expect(v.rowForGold).toEqual([0, null]);
    expect(v.creditVotes).toEqual([2, 1]);
  });

  it("names the row most passes named, ties to the lower index", () => {
    expect(microGoldVote([[4], [2], [4]], 1).rowForGold).toEqual([4]);
    // Every pass credited the gold — they only disagree on WHICH row — so it is
    // credited, to the lower index on the tie.
    expect(microGoldVote([[5], [2], [5], [2]], 1).rowForGold).toEqual([2]);
  });

  it("with one pass, is that pass", () => {
    expect(microGoldVote([[1, null, 0]], 3).rowForGold).toEqual([1, null, 0]);
  });
});

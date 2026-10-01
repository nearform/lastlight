/**
 * The readers behind the run detail's Review tab (`lib/review-ledger.ts`,
 * issue #429). Pinned: a run without the keys (analysis off, older runs)
 * reads as nothing — so the tab never appears empty — and the ordering a
 * reader relies on (risk desc then touched desc; status groups in lifecycle
 * order, unknown statuses kept rather than dropped).
 */
import { describe, it, expect } from "vitest";
import {
  dispatchedLedgerOf,
  groupLedgerFindings,
  hasReviewLedger,
  pct,
  reviewCoverageOf,
  reviewLedgerOf,
  sortCoverageUnits,
  unitLocation,
  weighted,
} from "../src/lib/review-ledger";
import type { LedgerFinding, ReviewCoverageUnit } from "../src/api";

const unit = (over: Partial<ReviewCoverageUnit>): ReviewCoverageUnit => ({
  key: "k",
  file: "a.ts",
  lines: [1, 10],
  touched: 1,
  risk: "low",
  delta: null,
  surveyed: false,
  investigated: null,
  ...over,
});

const finding = (over: Partial<LedgerFinding>): LedgerFinding => ({
  fp: "fp",
  path: "a.ts",
  line: 1,
  excerpt: "",
  title: "t",
  severity: null,
  importance: null,
  tier: "inline",
  reason: null,
  status: "open",
  foundAt: null,
  lastSeenAt: null,
  ...over,
});

const coverage = {
  version: 1,
  rereview: true,
  inScope: {
    units: 2, touched: 20, surveyedUnits: 1, surveyedTouched: 5,
    investigatedUnits: 1, investigatedTouched: 15, surveyedWeighted: 40, investigatedWeighted: null,
  },
  carried: { units: 3, touched: 30 },
  notInvestigated: ["b"],
  units: [unit({ key: "a" }), unit({ key: "b" })],
};
const ledger = { version: 1, head: "abc", at: "t", rounds: 2, units: [], findings: [finding({})] };

describe("readers", () => {
  it("read nothing from a run without the keys", () => {
    expect(reviewCoverageOf({})).toBeNull();
    expect(reviewLedgerOf({ scratch: {} })).toBeNull();
    expect(dispatchedLedgerOf({ context: { prState: {} } })).toBeNull();
    expect(hasReviewLedger({ scratch: { fixMarkers: {} }, context: { prState: {} } })).toBe(false);
  });

  it("reject an unknown version rather than mis-render it", () => {
    expect(reviewCoverageOf({ scratch: { reviewCoverage: { ...coverage, version: 2 } } })).toBeNull();
    expect(reviewLedgerOf({ scratch: { reviewLedger: { ...ledger, version: 2 } } })).toBeNull();
  });

  it("read each source independently", () => {
    expect(reviewCoverageOf({ scratch: { reviewCoverage: coverage } })?.carried.units).toBe(3);
    expect(reviewLedgerOf({ scratch: { reviewLedger: ledger } })?.rounds).toBe(2);
    const run = { context: { prState: { reviewLedger: ledger } } };
    expect(dispatchedLedgerOf(run)?.head).toBe("abc");
    expect(hasReviewLedger(run)).toBe(true);
  });

  it("tolerate missing optional arrays", () => {
    const c = reviewCoverageOf({
      scratch: { reviewCoverage: { ...coverage, notInvestigated: undefined, carried: undefined } },
    });
    expect(c?.notInvestigated).toEqual([]);
    expect(c?.carried).toEqual({ units: 0, touched: 0 });
  });
});

describe("sortCoverageUnits", () => {
  it("orders risk desc, then touched desc, then key", () => {
    const out = sortCoverageUnits([
      unit({ key: "low-big", risk: "low", touched: 99 }),
      unit({ key: "high-small", risk: "high", touched: 1 }),
      unit({ key: "crit", risk: "critical", touched: 1 }),
      unit({ key: "high-big", risk: "high", touched: 50 }),
      unit({ key: "a-high-small", risk: "high", touched: 1 }),
    ]).map((u) => u.key);
    expect(out).toEqual(["crit", "high-big", "a-high-small", "high-small", "low-big"]);
  });
});

describe("groupLedgerFindings", () => {
  it("groups in lifecycle order, drops empty groups, keeps an unknown status last", () => {
    const groups = groupLedgerFindings([
      finding({ fp: "1", status: "resolved" }),
      finding({ fp: "2", status: "open" }),
      finding({ fp: "3", status: "superseded" as LedgerFinding["status"] }),
      finding({ fp: "4", status: "open" }),
    ]);
    expect(groups.map((g) => [g.status, g.findings.length])).toEqual([
      ["open", 2],
      ["resolved", 1],
      ["superseded", 1],
    ]);
  });
});

describe("formatting", () => {
  it("pct and weighted say — when there is nothing to show", () => {
    expect(pct(5, 20)).toBe("25%");
    expect(pct(0, 0)).toBe("—");
    expect(weighted(66.6)).toBe("67%");
    expect(weighted(null)).toBe("—");
  });
  it("unitLocation renders a span, a single line, or a span-less unit", () => {
    expect(unitLocation({ key: "k", file: "a.ts", lines: [3, 9] })).toBe("a.ts:3-9");
    expect(unitLocation({ key: "k", file: "a.ts", lines: [3, 3] })).toBe("a.ts:3");
    expect(unitLocation({ key: "k", file: "a.ts", lines: null })).toBe("a.ts");
    expect(unitLocation({ key: "pr", file: null, lines: null })).toBe("pr");
  });
});

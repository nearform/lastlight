import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { summariseUnitSurveyReport } from "../../../src/unit-survey-index.js";
import type { ReplayReport } from "../types";
import { caseRow, entryModelCells, fmtChars, NA } from "./unitSurvey";

/**
 * The page's cells, read off the harness's synthetic replay fixture (one judged
 * case, one with an unjudged units side and no recorded agent survey, one that
 * errored in stage 1). The rule under test is the page's one promise: a side
 * with no data renders `n/a`, and a measured zero still renders as a zero.
 */
const report = (): ReplayReport =>
  JSON.parse(
    readFileSync(
      new URL("../../../src/__fixtures__/unit-survey/2026-09-27T10-10-15-249Z-fixture-stage2.json", import.meta.url),
      "utf8",
    ),
  ) as ReplayReport;

describe("caseRow", () => {
  it("renders a judged case as pairs over the case's gold", () => {
    const row = caseRow(report().cases[0]);
    expect(row.coverage).toBe("3/3 (+1 no file)");
    expect(row.units).toBe("7");
    expect(row.requestChars).toBe("102k");
    expect(row.unitsCredited).toBe("1/4 (25%)");
    // The agent was judged and credited nothing: a measured zero, not n/a.
    expect(row.agentCredited).toBe("0/4 (0%)");
    expect(row.unitsRows).toBe("23");
    expect(row.agentRows).toBe("19");
    expect(row.calls).toBe("6 ok / 1 failed · 10 calls");
    expect(row.agentWall).toBe("3m");
    expect(row.agentCost).toBe("$1.36");
  });

  it("renders n/a — never 0 — for an unjudged side and an unrecorded agent survey", () => {
    const row = caseRow(report().cases[1]);
    expect(row.unitsCredited).toBe(NA);
    expect(row.agentWall).toBe(NA);
    expect(row.agentCost).toBe(NA);
    // The units side's own cost and wall were measured.
    expect(row.unitsCost).toBe("$0.108");
    expect(row.unitsWall).toBe("36.1s");
  });

  it("an errored case carries its error and no numbers", () => {
    const row = caseRow(report().cases[2]);
    expect(row.error).toMatch(/facts failed/);
    expect(row.units).toBe(NA);
    expect(row.unitsCredited).toBe(NA);
  });

  it("a stage-1 case has no model side at all", () => {
    const c = report().cases[0];
    delete c.model;
    const row = caseRow(c);
    expect(row.coverage).toBe("3/3 (+1 no file)");
    expect([row.unitsCredited, row.agentCredited, row.unitsCost, row.agentCost, row.unitsWall, row.agentWall]).toEqual(
      Array(6).fill(NA),
    );
  });
});

describe("entryModelCells", () => {
  it("is all n/a on a stage-1 entry", () => {
    const r = report();
    for (const c of r.cases) delete c.model;
    const e = summariseUnitSurveyReport("x", r, "now")!;
    expect(Object.values(entryModelCells(e))).toEqual(Array(6).fill(NA));
  });

  it("propagates an unknown total instead of summing it as zero", () => {
    const e = summariseUnitSurveyReport("x", report(), "now")!;
    const cells = entryModelCells(e);
    expect(cells.unitsRecall).toBe(NA);
    expect(cells.agentRecall).toBe("0/8 (0%)");
    expect(cells.agentCost).toBe(NA);
    expect(cells.unitsCost).toBe("$0.216");
  });
});

describe("fmtChars", () => {
  it("reads request sizes by magnitude", () => {
    expect(fmtChars(512)).toBe("512");
    expect(fmtChars(4_698_112)).toBe("4.70M");
    expect(fmtChars(undefined)).toBe(NA);
  });
});

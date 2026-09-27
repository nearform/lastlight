import { describe, expect, it } from "vitest";

import { summariseUnitSurveyReport } from "../../../src/unit-survey-index.js";
import type { IndexRun, IndexTier, UnitSurveyEntry } from "../types";
import { mergeRecent } from "./recentRuns";

const run = (id: string, generatedAt: string): IndexRun => ({ id, generatedAt, byTier: [] }) as unknown as IndexRun;
const tier = (key: string, runs: IndexRun[]): IndexTier => ({ key, runs }) as unknown as IndexTier;
const unit = (id: string, startedAt: string, status?: "running"): UnitSurveyEntry =>
  summariseUnitSurveyReport(id, { label: id, startedAt, cases: [], ...(status ? { status, heartbeat: startedAt } : {}) }, "now")!;

describe("mergeRecent — the home page's one list of eval runs and unit-survey reports", () => {
  it("interleaves both kinds by time, newest first, each keeping what its row needs to link", () => {
    const items = mergeRecent(
      [
        tier("pr-review", [run("r3", "2026-09-27T12:00:00.000Z"), run("r1", "2026-09-27T08:00:00.000Z")]),
        tier("triage", [run("r2", "2026-09-27T10:00:00.000Z")]),
      ],
      [unit("u-live", "2026-09-27T11:00:00.000Z", "running"), unit("u-old", "2026-09-27T07:00:00.000Z")],
    );
    expect(items.map((i) => (i.kind === "run" ? `run:${i.tierKey}/${i.run.id}` : `unit:${i.entry.id}`))).toEqual([
      "run:pr-review/r3",
      "unit:u-live",
      "run:triage/r2",
      "run:pr-review/r1",
      "unit:u-old",
    ]);
    const live = items[1];
    expect(live.kind === "unit-survey" && live.entry.status).toBe("running");
    // Keys are unique across kinds, so a report id equal to a run id cannot collide.
    expect(new Set(items.map((i) => i.key)).size).toBe(items.length);
  });

  it("leaves the run list exactly as before when there are no unit-survey reports, and vice versa", () => {
    const runsOnly = mergeRecent([tier("t", [run("a", "2026-01-02"), run("b", "2026-01-01")])], []);
    expect(runsOnly.map((i) => i.kind === "run" && i.run.id)).toEqual(["a", "b"]);
    const unitsOnly = mergeRecent([], [unit("x", "2026-01-01T00:00:00.000Z")]);
    expect(unitsOnly.map((i) => i.kind)).toEqual(["unit-survey"]);
  });
});

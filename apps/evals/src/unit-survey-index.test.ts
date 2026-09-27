import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { buildUnitSurveyIndex } from "./report.js";
import { startServer } from "./serve.js";
import { MICRO_STALE_HEARTBEAT_MS } from "./micro-survey.js";
import {
  fmtGoldFraction,
  isPartialStatus,
  modelTotals,
  oneSidedGold,
  summariseUnitSurveyReport,
  unitSurveyElapsedMs,
  unitSurveyStatus,
  type ReplayReport,
} from "./unit-survey-index.js";

/**
 * A synthetic report in the exact shape `scripts/unit-survey-replay.ts`
 * writes — derived from a real stage-2 smoke report with the gold text and
 * paths replaced (gold text is never committed). Three cases: a fully judged
 * one, one whose units side went UNJUDGED and whose fixture recorded no agent
 * survey branch, and one that errored in stage 1.
 */
const FIXTURE_NAME = "2026-09-27T10-10-15-249Z-fixture-stage2.json";
const fixtureText = readFileSync(new URL(`./__fixtures__/unit-survey/${FIXTURE_NAME}`, import.meta.url), "utf8");
const fixture = (): ReplayReport => JSON.parse(fixtureText) as ReplayReport;

/** The same report as a stage-1 (`--no-model`) run would have written it. */
const stage1 = (): ReplayReport => {
  const r = fixture();
  r.label = "fixture-stage1";
  r.startedAt = "2026-09-27T09:00:00.000Z";
  r.stage = "coverage";
  for (const c of r.cases) delete c.model;
  delete r.aggregate.model;
  return r;
};

const dirs: string[] = [];
const tmp = () => {
  const d = mkdtempSync(join(tmpdir(), "unit-survey-index-test-"));
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A results root laid out the way a replay that is still running leaves it. */
function liveResultsRoot(): string {
  const root = tmp();
  const dir = join(root, "unit-survey");
  mkdirSync(join(dir, "responses", "arm1-prreview__demo-1", "responses"), { recursive: true });
  writeFileSync(join(dir, FIXTURE_NAME), fixtureText);
  writeFileSync(join(dir, "2026-09-27T09-00-00-000Z-fixture-stage1.json"), JSON.stringify(stage1()));
  // Torn mid-write by the running replay.
  writeFileSync(join(dir, "2026-09-27T11-00-00-000Z-in-flight.json"), fixtureText.slice(0, 400));
  // Valid JSON, not a report.
  writeFileSync(join(dir, "notes.json"), JSON.stringify({ hello: "world" }));
  writeFileSync(join(dir, "scalar.json"), "42");
  writeFileSync(join(dir, "README.md"), "not json");
  // The kept raw replies — JSON files one level down, and a DIRECTORY whose
  // name ends in .json. Neither is a report.
  writeFileSync(join(dir, "responses", "arm1-prreview__demo-1", "responses", "u-001.json"), fixtureText);
  mkdirSync(join(dir, "responses.json"));
  return root;
}

describe("buildUnitSurveyIndex", () => {
  it("is an empty list when nothing has been replayed here", () => {
    expect(buildUnitSurveyIndex(tmp(), "now").reports).toEqual([]);
    expect(buildUnitSurveyIndex(join(tmp(), "nope"), "now").reports).toEqual([]);
  });

  it("lists only the report files, newest first — skipping torn, non-report and responses/ entries", () => {
    const idx = buildUnitSurveyIndex(liveResultsRoot(), "now");
    expect(idx.reports.map((r) => r.label)).toEqual(["fixture-stage2", "fixture-stage1"]);
    expect(idx.reports[0].report).toBe(`/data/unit-survey/${encodeURIComponent(FIXTURE_NAME)}`);
  });

  it("is what GET /api/unit-survey serves, and the report body is reachable under /data", async () => {
    const root = liveResultsRoot();
    const server = await startServer({ resultsRoot: root, dashboardRoot: join(root, "no-dashboard"), port: 0 });
    try {
      const idx = (await (await fetch(`${server.url}/api/unit-survey`)).json()) as { reports: { label: string; report: string }[] };
      expect(idx.reports.map((r) => r.label)).toEqual(["fixture-stage2", "fixture-stage1"]);
      const body = (await (await fetch(`${server.url}${idx.reports[0].report}`)).json()) as ReplayReport;
      expect(body.cases).toHaveLength(3);
    } finally {
      await server.close();
    }
  });
});

describe("summariseUnitSurveyReport", () => {
  it("rejects anything that is not a replay report", () => {
    expect(summariseUnitSurveyReport("x", null, "now")).toBeNull();
    expect(summariseUnitSurveyReport("x", 42, "now")).toBeNull();
    expect(summariseUnitSurveyReport("x", { label: "no cases" }, "now")).toBeNull();
  });

  it("a stage-1 report has NO model side — not a zero one", () => {
    const e = summariseUnitSurveyReport("2026-09-27T09-00-00-000Z-s1", stage1(), "now")!;
    expect(e.stage).toBe("coverage");
    expect(e.model).toBeNull();
    expect(e.cases).toBe(3);
    expect(e.errored).toBe(1);
    // The errored case is out of every total.
    expect(e.coverage).toEqual({ covered: 6, locatable: 6, gold: 8, unlocatable: 2 });
    expect(e.units).toBe(14);
    expect(e.arms).toEqual(["arm1", "arm2"]);
  });

  it("stage 2: an unjudged side and an unrecorded agent survey total to null, never to 0", () => {
    const e = summariseUnitSurveyReport("id", fixture(), "now")!;
    expect(e.stage).toBe("replay");
    const m = e.model!;
    expect(m.cases).toBe(2);
    expect(m.gold).toBe(8);
    // demo-2's units side has asserted: null (judge failed) → the total is unknown.
    expect(m.unitsAsserted).toBeNull();
    expect(m.agentAsserted).toBe(0);
    // demo-2's fixture recorded no survey branch: its `costUsd: 0` is a sum over
    // nothing, and the report's own aggregate would have counted it as $0.
    expect(m.agentCostUsd).toBeNull();
    expect(m.agentWallMs).toBeNull();
    expect(m.unitsCostUsd).toBeCloseTo(0.2162377, 6);
    expect(m.judgeModels).toEqual(["anthropic/claude-sonnet-4-6"]);
    expect(m.votes).toEqual([3]);
  });

  it("with every side measured, the totals are the case sums", () => {
    const r = fixture();
    r.cases = r.cases.slice(0, 1);
    const m = modelTotals(r.cases)!;
    expect(m.unitsAsserted).toBe(1);
    expect(m.agentAsserted).toBe(0);
    expect(m.agentCostUsd).toBeCloseTo(1.3563679, 6);
    expect(m.agentWallMs).toBe(179957);
    expect(fmtGoldFraction(m.unitsAsserted, m.gold)).toBe("1/4 (25%)");
    expect(fmtGoldFraction(null, m.gold)).toBe("n/a");
    expect(fmtGoldFraction(0, m.gold)).toBe("0/4 (0%)");
  });

  it("a case with no gold (never judged, score null) does not null the credited totals", () => {
    const r = fixture();
    const [scored] = r.cases;
    const noGold = {
      ...structuredClone(scored),
      instanceId: "prreview__no-gold",
      gold: [],
      model: { ...structuredClone(scored.model!), unitsScore: null, agentScore: null },
    } as typeof scored;
    const m = modelTotals([scored, noGold])!;
    expect(m.unitsAsserted).toBe(1);
    expect(m.agentAsserted).toBe(0);
    expect(m.cases).toBe(2);
  });
});

describe("oneSidedGold + caveats", () => {
  it("names the gold only one side credited, with the crediting rows and votes", () => {
    const [demo1] = fixture().cases;
    expect(oneSidedGold(demo1)).toEqual([
      {
        index: 0,
        gold: expect.objectContaining({ summary: "synthetic gold 1" }),
        side: "units",
        rows: ["state-003"],
        creditVotes: 3,
        votes: 3,
      },
    ]);
  });

});

describe("live reports — status, progress, staleness", () => {
  const NOW = Date.parse("2026-09-27T12:00:00.000Z");
  const ago = (ms: number) => new Date(NOW - ms).toISOString();

  it("derives running / stale / failed / done, with stale past the micro-survey's 90 s bar", () => {
    expect(unitSurveyStatus({ status: "running", heartbeat: ago(10_000) }, NOW)).toBe("running");
    expect(unitSurveyStatus({ status: "running", heartbeat: ago(MICRO_STALE_HEARTBEAT_MS) }, NOW)).toBe("running");
    expect(unitSurveyStatus({ status: "running", heartbeat: ago(MICRO_STALE_HEARTBEAT_MS + 1) }, NOW)).toBe("stale");
    // No evidence a writer exists is not progress.
    expect(unitSurveyStatus({ status: "running" }, NOW)).toBe("stale");
    expect(unitSurveyStatus({ status: "running", heartbeat: "garbage" }, NOW)).toBe("stale");
    // A final write is final whatever its heartbeat's age.
    expect(unitSurveyStatus({ status: "failed", heartbeat: ago(10_000_000) }, NOW)).toBe("failed");
    expect(unitSurveyStatus({ status: "done", heartbeat: ago(10_000_000) }, NOW)).toBe("done");
    expect(isPartialStatus("running")).toBe(true);
    expect(isPartialStatus("stale")).toBe(true);
    expect(isPartialStatus("done")).toBe(false);
  });

  it("a report written before live writes (no status, no heartbeat) reads as done, with its whole run as the case count", () => {
    const e = summariseUnitSurveyReport("x", fixture(), "now")!;
    expect(fixture().status).toBeUndefined();
    expect(e).toMatchObject({ status: "done", heartbeat: null, planned: null, error: null });
    expect(unitSurveyStatus(e, NOW)).toBe("done");
    expect(unitSurveyElapsedMs(e, NOW)).toBe(Date.parse("2026-09-27T10:11:01.489Z") - Date.parse("2026-09-27T10:10:15.249Z"));
  });

  it("the index lists a RUNNING report with its progress, and its totals are over the cases done so far", () => {
    const root = tmp();
    const dir = join(root, "unit-survey");
    mkdirSync(dir);
    const full = fixture();
    const running: ReplayReport = {
      ...full,
      label: "in-flight",
      startedAt: ago(120_000),
      finishedAt: null,
      status: "running",
      heartbeat: ago(5_000),
      planned: [...full.cases, { arm: "arm2", instanceId: "prreview__later" }].map((c) => ({ arm: c.arm, instanceId: c.instanceId, fixture: "/f" })),
      cases: full.cases.slice(0, 1),
    };
    writeFileSync(join(dir, "2026-09-27T11-58-00-000Z-in-flight.json"), JSON.stringify(running));
    writeFileSync(join(dir, FIXTURE_NAME), fixtureText);
    const idx = buildUnitSurveyIndex(root, "now");
    const e = idx.reports.find((r) => r.label === "in-flight")!;
    expect(e).toMatchObject({ status: "running", cases: 1, planned: 4, finishedAt: null });
    expect(unitSurveyStatus(e, NOW)).toBe("running");
    expect(unitSurveyElapsedMs(e, NOW)).toBe(120_000);
    // Partial aggregates: exactly the first case's own figures, not the full report's.
    const one = summariseUnitSurveyReport("one", { ...full, cases: full.cases.slice(0, 1) }, "now")!;
    expect(e.coverage).toEqual(one.coverage);
    expect(e.model).toEqual(one.model);
    // Killed: the same file two minutes of silence later reads as stale, and
    // its elapsed time stops at the last heartbeat.
    const later = NOW + 120_000;
    expect(unitSurveyStatus(e, later)).toBe("stale");
    expect(unitSurveyElapsedMs(e, later)).toBe(115_000);
  });

  it("a failed run carries its error through the index", () => {
    const e = summariseUnitSurveyReport("f", { ...fixture(), status: "failed", error: "boom" }, "now")!;
    expect(e).toMatchObject({ status: "failed", error: "boom" });
    expect(unitSurveyStatus(e, NOW)).toBe("failed");
  });
});

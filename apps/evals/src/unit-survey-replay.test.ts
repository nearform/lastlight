import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { lineTag } from "lastlight-code-facts";

import type { InternalRecallGrade } from "./grade.js";
import type { SurveyRow } from "./micro-survey-node.js";
import type { GoldComment } from "./schema.js";
import {
  type ReplayCase,
  type ReplayUnit,
  agentSurveyPhase,
  buildReport,
  compareSides,
  formatReport,
  goldUnitCoverage,
  scoreRows,
  seedArgsOf,
  specFidelity,
  tallyCoverage,
  unitsShape,
  writeReportAtomic,
} from "./unit-survey-replay.js";
import { buildUnitSurveyIndex } from "./report.js";

vi.mock("./grade.js", () => ({
  gradeInternalRecall: vi.fn(),
}));
const { gradeInternalRecall } = await import("./grade.js");

/** A request in the rendered shape: FILE headers, tagged lines, an untagged removed row. */
function request(prefix: string, blocks: { file: string; lines: number[] }[]): string {
  const body = blocks.flatMap((b) => [`FILE ${b.file}`, ...b.lines.map((l) => `${lineTag(l)} +|code ${l}`), "      -|removed"]);
  return [prefix, "=== THIS UNIT ===", ...body].join("\n");
}

const PREFIX = "SHARED PREFIX TEXT";
const units: ReplayUnit[] = [
  { id: "u-001", kind: "symbol", file: "src/a.ts", request: request(PREFIX, [{ file: "src/a.ts", lines: [10, 11, 12] }]) },
  { id: "u-002", kind: "module", file: "src/b.ts", request: request(PREFIX, [{ file: "src/b.ts", lines: [5] }, { file: "src/a.ts", lines: [12] }]), truncated: true },
];

const g = (over: Partial<GoldComment> & Record<string, unknown>): GoldComment =>
  ({ severity: "high", description: "a defect", ...over }) as GoldComment;

describe("stage 1 — does some unit show the gold line", () => {
  it("covered by the line tag, file-only, uncovered and unlocatable are four different verdicts", () => {
    const gold = [
      g({ file: "src/a.ts", line: 12 }), // two units tag it
      g({ file: "src/a.ts", line: 40 }), // file shown, line not
      g({ file: "src/c.ts", line: 1 }), // no unit shows the file
      g({}), // description-only gold
      g({ file: "./src/b.ts", line: 5 }), // path spelled with ./
    ];
    const cells = goldUnitCoverage(units, gold);
    expect(cells.map((c) => c.verdict)).toEqual(["covered", "file-only", "uncovered", "unlocatable", "covered"]);
    expect(cells[0].units).toEqual(["u-001", "u-002"]);
    expect(tallyCoverage(cells)).toEqual({ gold: 5, locatable: 4, covered: 2, coveredChanged: 2, fileOnly: 1, uncovered: 1, unlocatable: 1 });
  });

  it("tells a gold shown as a changed line from one shown only as context", () => {
    const ctx = [{ id: "u-9", request: ["FILE src/q.ts", `${lineTag(7)}  |ctx`, `${lineTag(8)} +|changed`].join("\n") }];
    const cells = goldUnitCoverage(ctx, [g({ file: "src/q.ts", line: 7 }), g({ file: "src/q.ts", line: 8 })]);
    expect(cells.map((c) => [c.verdict, c.changed])).toEqual([["covered", false], ["covered", true]]);
  });

  it("a gold with a file and no line is covered by any tagged line of the file; a span by any of its lines", () => {
    const cells = goldUnitCoverage(units, [
      g({ file: "src/b.ts" }),
      g({ file: "src/a.ts", start_line: 13, line: 20 }),
      g({ file: "src/a.ts", start_line: 8, line: 10 }),
    ]);
    expect(cells.map((c) => c.verdict)).toEqual(["covered", "file-only", "covered"]);
    expect(cells[2].units).toEqual(["u-001"]);
  });

  it("a removed line carries no tag, so it covers nothing", () => {
    const only = [{ id: "u-1", request: ["FILE src/x.ts", "      -|gone"].join("\n") }];
    expect(goldUnitCoverage(only, [g({ file: "src/x.ts", line: 1 })])[0].verdict).toBe("uncovered");
  });

  it("measures request size, the shared prefix and the uncacheable remainder", () => {
    const shape = unitsShape({ coverage: "full", promptVersion: "units-v3", sharedPrefix: PREFIX, units });
    const total = units[0].request.length + units[1].request.length;
    expect(shape).toMatchObject({
      units: 2,
      byKind: { symbol: 1, module: 1 },
      requestChars: total,
      sharedPrefixChars: PREFIX.length,
      unitSpecificChars: total - 2 * PREFIX.length,
      truncated: 1,
      specObligations: 0,
    });
  });
});

describe("seed flags and spec fidelity", () => {
  it("takes contract + mint from obligations.json and max-obligations from the recorded command", () => {
    const cmd = 'set -u\nCONTRACT="full"\nMAX_OBLIGATIONS="40"\nMINT="all-in-diff"\n';
    const s = seedArgsOf({ contract: "minimal", minting: { allInDiff: true, registrations: true } }, cmd);
    expect(s).toMatchObject({ contract: "minimal", maxObligations: 40, mint: "all-in-diff,registrations" });
    expect(s.source.maxObligations).toBe("seed transcript");
  });

  it("says so when max-obligations was never recorded, and mints nothing when nothing was minted", () => {
    const s = seedArgsOf({ contract: "full", minting: { allInDiff: false } }, null);
    expect(s).toMatchObject({ maxObligations: 48, mint: null });
    expect(s.source.maxObligations).toMatch(/not recorded/);
  });

  it("matches a rebuilt spec set against the recorded prompt by criterion and id count", () => {
    const set = { obligations: [{ id: "S-1", criterion: "dry run must log" }, { id: "S-2", criterion: "never send DMs" }] };
    expect(specFidelity(set, "… S-1 dry run must log … S-2 never send DMs …").match).toBe(true);
    expect(specFidelity(set, "… S-1 dry run must log …")).toMatchObject({ inTranscript: 1, transcriptIds: 1, match: false });
    expect(specFidelity(set, null).match).toBeNull();
  });

  it("a set with no obligations is checked by its degraded reasons, which the prompt renders instead", () => {
    const set = { obligations: [], degraded: ["this PR is not linked to an issue"] };
    expect(specFidelity(set, "No spec obligations could be built: this PR is not linked to an issue.").match).toBe(true);
    expect(specFidelity(set, "No spec obligations could be built: something else.").match).toBe(false);
  });
});

describe("the agent survey phase, from its transcripts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "usr-sessions-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const session = (name: string, start: string, end: string, phase: string, cost: number, ms: number) => {
    mkdirSync(join(dir, "projects", "p"), { recursive: true });
    writeFileSync(
      join(dir, "projects", "p", name),
      [
        JSON.stringify({ type: "user", timestamp: start, message: { content: "x" } }),
        JSON.stringify({ type: "assistant" }),
        JSON.stringify({ type: "result", timestamp: end, phase, total_cost_usd: cost, duration_ms: ms }),
      ].join("\n") + "\n",
    );
  };

  it("spans the earliest branch start to the latest branch result, and sums only survey branches", () => {
    session("a.jsonl", "2026-09-22T19:40:00.000Z", "2026-09-22T19:42:00.000Z", "survey_branch_contract", 0.25, 120_000);
    session("b.jsonl", "2026-09-22T19:40:10.000Z", "2026-09-22T19:43:00.000Z", "survey_branch_state", 0.5, 170_000);
    session("c.jsonl", "2026-09-22T19:43:00.000Z", "2026-09-22T19:50:00.000Z", "review", 9, 420_000);
    const p = agentSurveyPhase(dir);
    expect(p.wallMs).toBe(180_000);
    expect(p.costUsd).toBeCloseTo(0.75);
    expect(p.branches.map((b) => b.phase)).toEqual(["survey_branch_contract", "survey_branch_state"]);
  });

  it("no stamped branch is an unknown wall clock, not zero", () => {
    expect(agentSurveyPhase(dir).wallMs).toBeNull();
  });
});

describe("stage 2 scoring — delegated to the shared matcher", () => {
  const gold = [g({ file: "src/a.ts", line: 12, description: "limit never compared" }), g({ file: "src/b.ts", line: 5 })];
  const rows: SurveyRow[] = [
    { id: "contract-001", claim: "limit is never compared", evidence: { consequence: "unbounded pages" } as never, quotes: [{ path: "src/a.ts", line: 12 }] },
    { id: "state-001", claim: "cache fine", quotes: [{ path: "src/b.ts", line: 9 }] },
  ];
  const grade = vi.mocked(gradeInternalRecall);
  beforeEach(() => grade.mockReset());

  it("hands the judge the rows' own words, votes over the passes, and folds through microGoldRepeat", async () => {
    grade
      .mockResolvedValueOnce({ goldToFinding: [0, null], matched: 1 } as InternalRecallGrade)
      .mockResolvedValueOnce({ goldToFinding: [0, null], matched: 1 } as InternalRecallGrade)
      .mockResolvedValueOnce({ goldToFinding: [null, null], matched: 0 } as InternalRecallGrade);
    const o = await scoreRows(rows, gold, { judgeModel: "judge/x", votes: 3 });
    expect(grade).toHaveBeenCalledTimes(3);
    const arg = grade.mock.calls[0][0];
    expect(arg.gold).toBe(gold);
    expect(arg.judgeModel).toBe("judge/x");
    expect(arg.findings).toEqual([
      { description: "limit is never compared Consequence: unbounded pages", file: "src/a.ts" },
      { description: "cache fine", file: "src/b.ts" },
    ]);
    // 2-of-3 credit gold #1 to row 0; gold #2 is only REACHED (row within the line window).
    expect(o?.asserted).toBe(1);
    expect(o?.cells.map((c) => c.verdict)).toEqual(["asserted", "reached"]);
    expect(o?.creditVotes).toEqual([2, 0]);
  });

  it("a failed judge pass is dropped from the vote; every pass failing is unknown, never zero", async () => {
    grade.mockResolvedValue({ goldToFinding: [null, null], matched: 0, error: "judge: 500" } as InternalRecallGrade);
    const o = await scoreRows(rows, gold, { judgeModel: "judge/x", votes: 2 });
    expect(o?.asserted).toBeNull();
    expect(o?.judgeError).toBe("judge: 500");
  });

  it("no judge model is location-only (asserted unknown); no rows is a measured zero; no gold is undefined", async () => {
    expect((await scoreRows(rows, gold, { judgeModel: null, votes: 3 }))?.asserted).toBeNull();
    expect((await scoreRows([], gold, { judgeModel: "judge/x", votes: 3 }))?.asserted).toBe(0);
    expect(await scoreRows(rows, [], { judgeModel: "judge/x", votes: 3 })).toBeUndefined();
    expect(grade).not.toHaveBeenCalled();
  });
});

describe("report assembly", () => {
  const cell = (verdict: "asserted" | "reached" | "missed") => ({ verdict, rows: [], probed: false });
  const score = (verdicts: ("asserted" | "reached" | "missed")[], asserted: number | null) => ({
    cells: verdicts.map(cell),
    asserted,
    reached: verdicts.filter((v) => v === "reached").length,
    probesOnGold: 0,
    probesOffGold: 0,
    claimed: 2,
    claimedAsserting: 1,
  });

  function kase(id: string, withModel: boolean, agentAsserted: number | null = 1): ReplayCase {
    const coverage = goldUnitCoverage(units, [g({ file: "src/a.ts", line: 12 }), g({ file: "src/z.ts", line: 1 })]);
    return {
      instanceId: id,
      arm: "arm1",
      fixture: `/f/${id}`,
      gold: [{ file: "src/a.ts", line: 12, severity: "high", summary: "x" }, { file: "src/z.ts", line: 1, severity: "high", summary: "y" }],
      seed: seedArgsOf({ contract: "minimal" }, null),
      obligations: { fixture: { contract: 3 }, replay: { contract: 3 } },
      spec: { status: "no-spec", note: "", obligations: 0, degraded: [], fidelity: null },
      shape: unitsShape({ sharedPrefix: PREFIX, units, promptVersion: "units-v3" }),
      coverage,
      coverageTally: tallyCoverage(coverage),
      neutralTally: null,
      deterministicMs: { facts: 1, seed: 1, units: 1 },
      ...(withModel
        ? {
            model: {
              model: "m/x", variant: null, concurrency: 4, wallMs: 30_000, costUsd: 0.1, calls: 2, unitsOk: 2, unitsFailed: 0,
              ingest: { answered: 2 }, rowsByFamily: { contract: 3, state: 1 },
              unitsScore: score(["asserted", "reached"], 1),
              agentScore: score(["missed", "asserted"], agentAsserted),
              agentRows: 7,
              agentSurvey: { wallMs: 120_000, costUsd: 1, branches: [], source: "t" },
              sides: compareSides(score(["asserted", "reached"], 1), score(["missed", "asserted"], agentAsserted)),
              judgeModel: "judge/x",
            },
          }
        : {}),
    };
  }

  it("aggregates coverage over cases, excludes errored cases, and sums both sides of the replay", () => {
    const failed = { instanceId: "bad", arm: "arm1", fixture: "/f/bad", error: "boom" } as ReplayCase;
    const r = buildReport({ label: "t", startedAt: "2026-09-27T00:00:00.000Z", cli: "/cli.js", cases: [kase("a", true), kase("b", false), failed] });
    expect(r.stage).toBe("replay");
    expect(r.codeFacts.promptVersion).toBe("units-v3");
    expect(r.aggregate.cases).toBe(2);
    expect(r.aggregate.coverage).toMatchObject({ gold: 4, locatable: 4, covered: 2, uncovered: 2 });
    expect(r.aggregate.units).toBe(4);
    expect(r.aggregate.model).toMatchObject({
      cases: 1, gold: 2, unitsAsserted: 1, agentAsserted: 1, onlyUnits: 1, onlyAgent: 1,
      unitsRows: 4, agentRows: 7, unitsCostUsd: 0.1, agentCostUsd: 1, unitsWallMs: 30_000, agentWallMs: 120_000,
    });
    const table = formatReport(r);
    expect(table).toContain("arm1/a");
    expect(table).toContain("ERROR boom");
    expect(table).toContain("only units found: #1 src/a.ts:12");
    expect(table).toContain("only agent found: #2 src/z.ts:1");
  });

  it("one unjudged side makes that side's total unknown rather than a zero", () => {
    const r = buildReport({ label: "t", startedAt: "x", cli: "c", cases: [kase("a", true), kase("b", true, null)] });
    expect(r.aggregate.model?.agentAsserted).toBeNull();
    expect(r.aggregate.model?.unitsAsserted).toBe(2);
  });

  it("a running write has no finishedAt, carries the plan and a heartbeat, and keeps the LAUNCHED stage", () => {
    const planned = [{ arm: "arm1", instanceId: "a", fixture: "/f/a" }, { arm: "arm1", instanceId: "b", fixture: "/f/b" }];
    const now = new Date("2026-09-27T12:00:00.000Z");
    const r = buildReport({ label: "t", startedAt: "x", cli: "c", cases: [], status: "running", planned, stage: "replay", now });
    expect(r).toMatchObject({ status: "running", finishedAt: null, heartbeat: now.toISOString(), planned, stage: "replay" });
    const failed = buildReport({ label: "t", startedAt: "x", cli: "c", cases: [], status: "failed", error: "boom", now });
    expect(failed).toMatchObject({ status: "failed", error: "boom", finishedAt: now.toISOString() });
    // The one-shot default stays a finished report.
    expect(buildReport({ label: "t", startedAt: "x", cli: "c", cases: [] }).status).toBe("done");
  });

  it("incremental writes are atomic: every step is a whole, parseable report the index lists, and no temp file is left", () => {
    const root = mkdtempSync(join(tmpdir(), "unit-survey-live-"));
    try {
      const dir = join(root, "unit-survey");
      mkdirSync(dir);
      const file = join(dir, "2026-09-27T12-00-00-000Z-live.json");
      const planned = ["a", "b", "c"].map((id) => ({ arm: "arm1", instanceId: id, fixture: `/f/${id}` }));
      const cases: ReplayCase[] = [];
      const steps: { status: "running" | "done"; n: number }[] = [
        { status: "running", n: 0 },
        { status: "running", n: 1 },
        { status: "running", n: 2 },
        { status: "running", n: 3 },
        { status: "done", n: 3 },
      ];
      let prevIno = -1;
      for (const step of steps) {
        while (cases.length < step.n) cases.push(kase(planned[cases.length].instanceId, true));
        writeReportAtomic(file, buildReport({ label: "live", startedAt: "2026-09-27T12:00:00.000Z", cli: "c", cases, status: step.status, planned, stage: "replay" }));
        // Only the report is in the directory — the temp file was renamed over it.
        expect(readdirSync(dir)).toEqual(["2026-09-27T12-00-00-000Z-live.json"]);
        const onDisk = JSON.parse(readFileSync(file, "utf8")) as ReturnType<typeof buildReport>;
        expect(onDisk.status).toBe(step.status);
        expect(onDisk.cases).toHaveLength(step.n);
        expect(onDisk.planned).toHaveLength(3);
        // Replaced by rename — the temp file is created while the old report
        // still holds its inode, so each write lands on a DIFFERENT inode; an
        // in-place truncate-and-write would keep the same one.
        const ino = statSync(file).ino;
        expect(ino).not.toBe(prevIno);
        prevIno = ino;
        const [entry] = buildUnitSurveyIndex(root, "now").reports;
        expect(entry).toMatchObject({ label: "live", status: step.status, cases: step.n, planned: 3 });
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("a coverage-only run is stage `coverage` and carries no model aggregate", () => {
    const r = buildReport({ label: "t", startedAt: "x", cli: "c", cases: [kase("a", false)] });
    expect(r.stage).toBe("coverage");
    expect(r.aggregate.model).toBeUndefined();
  });
});

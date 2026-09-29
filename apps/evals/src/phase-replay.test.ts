import { describe, expect, it } from "vitest";

import { phaseReplayTotals, summarisePhaseReplay, type PhaseReplayCase, type PhaseReplayReport } from "./phase-replay.js";

const baseCase = (over: Partial<PhaseReplayCase>): PhaseReplayCase => ({
  instanceId: "prreview__x",
  arm: "arm1",
  fixture: "/f",
  repeat: 1,
  ok: true,
  error: null,
  wallMs: 1000,
  costUsd: 0.5,
  turns: 3,
  outputTokens: 100,
  iterations: 1,
  rows: 10,
  gold: [{ severity: "high", summary: "g" }],
  goldRows: ["security-001"],
  ...over,
});

const report = (over: Partial<PhaseReplayReport>): PhaseReplayReport => ({
  version: 1,
  kind: "falsify",
  label: "l",
  audit: false,
  startedAt: "2026-09-27T12:00:00.000Z",
  finishedAt: null,
  status: "running",
  heartbeat: "2026-09-27T12:00:01.000Z",
  error: null,
  config: { model: "m", thinking: null, prompt: "p", promptSha256: "s", promptOverride: false, skill: null, skillOverride: false, rounds: 2, judgeModel: null },
  planned: [],
  cases: [],
  ...over,
});

describe("phaseReplayTotals", () => {
  it("an audit has no cost and no wall clock — n/a, not a free instant run", () => {
    const t = phaseReplayTotals(report({ audit: true, cases: [baseCase({ wallMs: null, costUsd: null })] }));
    expect(t.costUsd).toBeNull();
    expect(t.wallMedianMs).toBeNull();
  });

  it("gold counts over an unjudged gold map are unknown (null), never zero", () => {
    const t = phaseReplayTotals(
      report({
        kind: "falsify",
        cases: [baseCase({ goldRows: null, falsify: { owed: 1, selected: 1, deferred: 0, verdicts: { none: 1 }, gateSatisfied: true, gaps: 0, goldSelected: [], goldRefuted: [], goldReproduced: [] } })],
      }),
    );
    expect(t.falsify).toMatchObject({ goldSelected: null, goldRefuted: null, goldReproduced: null });
  });

  it("falsify counts gold refuted and treats `none` as unanswered", () => {
    const t = phaseReplayTotals(
      report({
        kind: "falsify",
        cases: [baseCase({ falsify: { owed: 5, selected: 3, deferred: 2, verdicts: { refuted: 1, none: 1, unprobed: 1 }, gateSatisfied: false, gaps: 1, goldSelected: ["security-001"], goldRefuted: ["security-001"], goldReproduced: [] } })],
      }),
    );
    expect(t.falsify).toMatchObject({ owed: 5, selected: 3, answered: 2, goldRefuted: 1, gateFailures: 1 });
  });

  it("falsify sites: counts sessions and claims, and a rows-mode report has neither (null, not zero)", () => {
    const f = { owed: 2, selected: 2, deferred: 0, verdicts: { corroborated: 2 }, gateSatisfied: true, gaps: 0, goldSelected: [], goldRefuted: [], goldReproduced: [] };
    const site = (id: string, claims: number | null) => ({
      id, origin: "support" as const, path: "a.ts", startLine: 1, endLine: 2, rows: 1, gold: [], ok: true, error: null,
      wallMs: 1, costUsd: 0, turns: 1, outputTokens: 1, gateSatisfied: true, verdicts: {}, claims, session: null,
    });
    const sites = phaseReplayTotals(report({ kind: "falsify", cases: [baseCase({ falsify: { ...f, sites: [site("site-001", 2), site("site-002", null)] } })] }));
    expect(sites.falsify).toMatchObject({ sites: 2, claims: 2 });
    const rows = phaseReplayTotals(report({ kind: "falsify", cases: [baseCase({ falsify: f })] }));
    expect(rows.falsify).toMatchObject({ sites: null, claims: null });
  });
});

describe("phaseReplayTotals — site-review", () => {
  const site = (over: Record<string, unknown> = {}) => ({
    id: "site-001", path: "a.ts", startLine: 1, endLine: 20, rows: 10, voters: 3, leads: 4, gold: [] as string[], ok: true, error: null,
    wallMs: 1, costUsd: 0.1, turns: 5, outputTokens: 10, gateSatisfied: true, findings: 1, none: false, session: null, ...over,
  });
  const outcome = (over: Record<string, unknown> = {}) => ({
    sitesFormed: 12, skippedRows: 3, sites: [site(), site({ id: "site-002", rows: 5, leads: 0, findings: 0, none: true, gateSatisfied: false, gapsByRound: [{ "too-many": 1 }, { "too-many": 1 }] })],
    goldInSites: ["security-001"],
    findings: [{ site: "site-001", path: "a.ts", line: 3, title: "t", strength: "read", leads: [], gold: 0 }, { site: "site-001", path: "a.ts", line: 9, title: "u", strength: "read", leads: [], gold: null }],
    goldStated: [0], matchedFindings: 1, ...over,
  });

  it("counts sites, findings, gold stated and pooled precision", () => {
    const t = phaseReplayTotals(report({ kind: "site-review", cases: [baseCase({ siteReview: outcome() }), baseCase({ siteReview: outcome({ goldStated: [], matchedFindings: 0 }) })] }));
    expect(t.siteReview).toMatchObject({ sites: 4, rowsInSites: 30, leads: 8, goldInSites: 2, findings: 4, noneSites: 2, goldStated: 1, matchedFindings: 1, precision: 0.25, gateFailures: 2, secondRounds: 2 });
  });

  it("an audit has no findings and no judged numbers (n/a, not zero); an unjudged case nulls gold stated", () => {
    const audit = phaseReplayTotals(report({ kind: "site-review", audit: true, cases: [baseCase({ siteReview: outcome({ findings: [], goldStated: null, matchedFindings: null }) })] }));
    expect(audit.siteReview).toMatchObject({ findings: null, noneSites: null, goldStated: null, precision: null, goldInSites: 1 });
    const unjudged = phaseReplayTotals(report({ kind: "site-review", cases: [baseCase({ siteReview: outcome() }), baseCase({ siteReview: outcome({ goldStated: null, matchedFindings: null }) })] }));
    expect(unjudged.siteReview).toMatchObject({ goldStated: null, matchedFindings: null, precision: null, findings: 4 });
    const noMap = phaseReplayTotals(report({ kind: "site-review", cases: [baseCase({ goldRows: null, siteReview: outcome() })] }));
    expect(noMap.siteReview?.goldInSites).toBeNull();
  });

  it("is listed by the index", () => {
    expect(summarisePhaseReplay("id", report({ kind: "site-review", cases: [baseCase({ siteReview: outcome() })] }), "t")).toMatchObject({ kind: "site-review", totals: { siteReview: { sites: 2 } } });
  });
});

describe("phaseReplayTotals — select", () => {
  const sel = (over: Partial<NonNullable<PhaseReplayCase["select"]>>): NonNullable<PhaseReplayCase["select"]> => ({
    pooled: 9,
    items: 4,
    merges: 5,
    importance: { "must-fix": 1, "worth-mentioning": 3 },
    posted: 4,
    recordedOnly: 0,
    fallback: null,
    gateSatisfied: true,
    goldPosted: [0],
    goldAnywhere: [0],
    postedMatched: 1,
    itemsOut: [],
    ...over,
  });

  it("pools the shape and the judged grade across cases", () => {
    const t = phaseReplayTotals(
      report({
        kind: "select",
        cases: [
          baseCase({ goldRows: null, select: sel({}) }),
          baseCase({ goldRows: null, select: sel({ pooled: 2, items: 2, merges: 0, importance: { nit: 2 }, posted: 0, recordedOnly: 2, fallback: "missing-file", goldPosted: [], goldAnywhere: [0], postedMatched: 0 }) }),
        ],
      }),
    ).select!;
    expect(t).toMatchObject({ pooled: 11, items: 6, merges: 5, posted: 4, recordedOnly: 2, fallbacks: 1, goldPosted: 1, goldAnywhere: 2, postedMatched: 1 });
    expect(t.importance).toEqual({ "must-fix": 1, "worth-mentioning": 3, nit: 2 });
    expect(t.precision).toBeCloseTo(0.25);
  });

  it("an unjudged case makes the gold totals unknown, not zero", () => {
    const t = phaseReplayTotals(report({ kind: "select", cases: [baseCase({ select: sel({}) }), baseCase({ select: sel({ goldPosted: null, goldAnywhere: null, postedMatched: null }) })] })).select!;
    expect(t.goldPosted).toBeNull();
    expect(t.precision).toBeNull();
  });

  it("lists a select report", () => {
    expect(summarisePhaseReplay("id", report({ kind: "select" }), "t")?.kind).toBe("select");
  });
});

describe("summarisePhaseReplay", () => {
  it("lists a phase-replay report and refuses anything else", () => {
    const e = summarisePhaseReplay("id", report({ planned: [{ instanceId: "a", arm: "arm1", fixture: "/f", repeat: 1 }] }), "2026-01-01T00:00:00Z");
    expect(e).toMatchObject({ id: "id", kind: "falsify", planned: 1, report: "/data/phase-replay/id.json", status: "running" });
    expect(summarisePhaseReplay("x", { version: 2 }, "t")).toBeNull();
    // The removed `adjudicate` replays are no longer listed.
    expect(summarisePhaseReplay("x", { ...report({}), kind: "adjudicate" }, "t")).toBeNull();
    expect(summarisePhaseReplay("x", { stage: "replay" }, "t")).toBeNull();
  });
});

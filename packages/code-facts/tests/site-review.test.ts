/**
 * The `sites` review engine's deterministic steps (`lastlight-facts sites`):
 * plan → the investigator gate → merge → the selection gate → finalize. The
 * mechanism only; whether the engine reviews well is the evals' question.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runCli } from "../src/cli.js";
import { EXIT_DEGRADED, EXIT_OK } from "../src/errors.js";
import { checkFindings } from "../src/findings.js";
import {
  checkSelection,
  checkSiteSlot,
  finalizeSiteFindings,
  mergeSiteFindings,
  readSitePlan,
  renderSiteMerge,
  SITE_MERGE_EMPTY_MARKER,
  writeSiteMerge,
  writeSitePlan,
} from "../src/site-review.js";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
});

const at = (path: string, line: number, unitId: string) => ({
  claim: `${path}:${line}`,
  quotes: [{ path, line, text: "x" }],
  unitId,
});

/** A checkout with `src/a.ts` (60 lines) and a hypothesis set giving two sites in it. */
function workspace(): { repo: string; dir: string } {
  const repo = mkdtempSync(join(tmpdir(), "ll-site-review-"));
  roots.push(repo);
  mkdirSync(join(repo, "src"), { recursive: true });
  writeFileSync(join(repo, "src", "a.ts"), Array.from({ length: 200 }, (_, i) => `const line${i + 1} = ${i + 1};`).join("\n") + "\n");
  const dir = join(repo, ".lastlight", "pr-review");
  mkdirSync(join(dir, "hypotheses"), { recursive: true });
  const rows = {
    // Site 1 (lines 10–20): three distinct units.
    contract: [at("src/a.ts", 10, "u1"), at("src/a.ts", 15, "u2"), at("src/a.ts", 20, "u3")],
    // Site 2 (line 150): one unit.
    state: [at("src/a.ts", 150, "u4")],
  };
  for (const [family, list] of Object.entries(rows))
    writeFileSync(join(dir, "hypotheses", `${family}.jsonl`), `${list.map((r) => JSON.stringify(r)).join("\n")}\n`);
  return { repo, dir };
}

const finding = (site: string, line: number, extra: Record<string, unknown> = {}) => ({
  site,
  path: "src/a.ts",
  line,
  title: `bug at ${line}`,
  mechanism: "the guard is inverted",
  consequence: "users see the wrong total",
  importance: "must-fix",
  strength: "read",
  command: null,
  transcript: null,
  leads: [],
  ...extra,
});

function writeFindings(dir: string, siteId: string, lines: unknown[]): void {
  writeFileSync(join(dir, "sites", `${siteId}.findings.jsonl`), `${lines.map((l) => JSON.stringify(l)).join("\n")}\n`);
}

describe("sites --plan", () => {
  it("writes one brief per slot, ranks by voters, and marks the slots past the last site empty", () => {
    const { dir } = workspace();
    const plan = writeSitePlan(dir);
    expect(plan.slots.map((s) => [s.siteId, s.site?.startLine ?? null, s.noneChecks])).toEqual([
      ["site-001", 10, 1],
      ["site-002", 150, 1],
      ["site-003", null, 0],
      ["site-004", null, 0],
      ["site-005", null, 0],
    ]);
    const brief = readFileSync(join(dir, "sites", "site-001.md"), "utf8");
    expect(brief).toContain("site-001");
    expect(brief).toContain(".lastlight/pr-review/sites/site-001.findings.jsonl");
    // No leads: the graded arm A.
    expect(brief).toContain("No leads are given");
    expect(readFileSync(join(dir, "sites", "site-004.md"), "utf8")).toContain('{"site":"site-004","empty":true}');
    expect(readSitePlan(dir)?.slots).toHaveLength(5);
  });

  it("fills the slots the code sites leave free with test-file sites, and never lets one displace a code site", () => {
    const { dir } = workspace();
    // Three units on a test file: more votes than site 2, but a test file.
    const testRows = [at("src/a.test.ts", 5, "u5"), at("src/a.test.ts", 6, "u6"), at("src/a.test.ts", 7, "u7")];
    writeFileSync(join(dir, "hypotheses", "tests.jsonl"), `${testRows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    const plan = writeSitePlan(dir);
    expect(plan.slots.slice(0, 3).map((s) => s.site?.path ?? null)).toEqual(["src/a.ts", "src/a.ts", "src/a.test.ts"]);
    expect(plan.testSites).toBe(1);
    // At top 2 the code sites keep both slots.
    expect(writeSitePlan(dir, { top: 2 }).slots.map((s) => s.site?.path)).toEqual(["src/a.ts", "src/a.ts"]);
  });

  it("closes an empty slot's gate up front, so no investigator has to write it", () => {
    const { dir, repo } = workspace();
    writeSitePlan(dir);
    expect(checkSiteSlot({ dir, repo, siteId: "site-004" }).satisfied).toBe(true);
    // A slot WITH a site still waits for its investigator.
    expect(existsSync(join(dir, "sites", "site-001.findings.jsonl"))).toBe(false);
  });

  it("pairs: a second investigator on every selected site, in slot 8 + rank", () => {
    const { dir } = workspace();
    const plan = writeSitePlan(dir, { top: 3, pair: true, slots: 16 });
    const bySlot = new Map(plan.slots.map((s) => [s.slot, s]));
    expect(plan.slots).toHaveLength(16);
    expect([1, 2, 3, 4, 8].map((n) => bySlot.get(n)?.site?.startLine ?? null)).toEqual([10, 150, null, null, null]);
    expect(bySlot.get(9)).toMatchObject({ siteId: "site-009", pairOf: "site-001", site: { startLine: 10 } });
    expect(bySlot.get(10)).toMatchObject({ siteId: "site-010", pairOf: "site-002", site: { startLine: 150 } });
    // Rank 3 has no site, so neither does its pair; past top, nothing.
    expect([11, 12, 16].map((n) => bySlot.get(n)?.site ?? null)).toEqual([null, null, null]);
    expect(bySlot.get(11)?.pairOf).toBeUndefined();
    // The pair gets the same site under its own id, output file and scratch dir.
    const brief = readFileSync(join(dir, "sites", "site-009.md"), "utf8");
    expect(brief).toContain(".lastlight/pr-review/sites/site-009.findings.jsonl");
    expect(brief).toContain(".lastlight/pr-review/sites/site-009/");
  });

  it("without pair, plans every slot the fan-out declares and leaves the pair range empty", () => {
    const { dir } = workspace();
    const plan = writeSitePlan(dir, { top: 8, slots: 16 });
    expect(plan.slots.filter((s) => s.site).map((s) => s.siteId)).toEqual(["site-001", "site-002"]);
    expect(plan.slots.some((s) => s.pairOf)).toBe(false);
  });

  it("refuses a top past the maximum, or slots that cannot hold the plan", () => {
    const { dir } = workspace();
    expect(() => writeSitePlan(dir, { top: 9 })).toThrow(/top must be 1…8/);
    expect(() => writeSitePlan(dir, { top: 5, pair: true, slots: 10 })).toThrow(/needs 13/);
  });

  it("clears the last head's sites first", () => {
    const { dir } = workspace();
    mkdirSync(join(dir, "sites"), { recursive: true });
    writeFileSync(join(dir, "sites", "site-001.findings.jsonl"), "stale\n");
    writeSitePlan(dir);
    expect(existsSync(join(dir, "sites", "site-001.findings.jsonl"))).toBe(false);
  });
});

describe("sites --check", () => {
  it("accepts an `empty` line only on a slot the plan left empty", () => {
    const { repo, dir } = workspace();
    writeSitePlan(dir);
    writeFindings(dir, "site-004", [{ site: "site-004", empty: true }]);
    expect(checkSiteSlot({ dir, repo, siteId: "site-004" }).satisfied).toBe(true);
    writeFindings(dir, "site-001", [{ site: "site-001", empty: true }]);
    const real = checkSiteSlot({ dir, repo, siteId: "site-001" });
    expect(real.satisfied).toBe(false);
    expect(real.gaps.map((g) => g.kind)).toContain("empty-slot");
  });

  it("requires an importance on every finding", () => {
    const { repo, dir } = workspace();
    writeSitePlan(dir);
    writeFindings(dir, "site-001", [finding("site-001", 12, { importance: undefined })]);
    expect(checkSiteSlot({ dir, repo, siteId: "site-001" }).gaps.map((g) => g.kind)).toEqual(["bad-importance"]);
    writeFindings(dir, "site-001", [finding("site-001", 12)]);
    expect(checkSiteSlot({ dir, repo, siteId: "site-001" }).satisfied).toBe(true);
  });
});

describe("sites --merge", () => {
  it("pools findings across slots and proposes cross-site groups within ±10 lines only", () => {
    const { repo, dir } = workspace();
    writeSitePlan(dir);
    writeFindings(dir, "site-001", [finding("site-001", 12), finding("site-001", 18)]);
    writeFindings(dir, "site-002", [finding("site-002", 20), finding("site-002", 150)]);
    const merge = mergeSiteFindings({ dir, repo });
    expect(merge.findings.map((f) => [f.id, f.ref, f.line])).toEqual([
      ["F1", "site-001#1", 12],
      ["F2", "site-001#2", 18],
      ["F3", "site-002#1", 20],
      ["F4", "site-002#2", 150],
    ]);
    // F1–F2 share a site, so their proximity is not a proposal; F3 joins both
    // from another site.
    expect(merge.groups).toEqual([["F1", "F2", "F3"]]);
    expect(merge.findings[0].excerpt).toContain(">");
    expect(merge.findings[0].lineText).toBe("const line12 = 12;");
    expect(merge.slots.map((s) => s.outcome)).toEqual(["findings", "findings", "empty", "empty", "empty"]);
    expect(renderSiteMerge(merge)).toContain("## F4");
    expect(renderSiteMerge(merge)).not.toContain(SITE_MERGE_EMPTY_MARKER);
  });

  it("marks an empty pool, so pr-review can skip `select`", () => {
    const { repo, dir } = workspace();
    writeSitePlan(dir);
    writeFindings(dir, "site-001", [{ site: "site-001", none: true, reason: "r", checked: [] }]);
    const merge = mergeSiteFindings({ dir, repo });
    expect(merge.findings).toEqual([]);
    expect(renderSiteMerge(merge).startsWith(`${SITE_MERGE_EMPTY_MARKER}\n`)).toBe(true);
  });

  it("moves a finding off a blank cited line to the nearest code line, keeping what was cited", () => {
    const { repo, dir } = workspace();
    const src = readFileSync(join(repo, "src", "a.ts"), "utf8").split("\n");
    src[11] = "";
    writeFileSync(join(repo, "src", "a.ts"), src.join("\n"));
    writeSitePlan(dir);
    writeFindings(dir, "site-001", [finding("site-001", 12)]);
    const [f] = mergeSiteFindings({ dir, repo }).findings;
    expect([f.line, f.citedLine, f.lineText]).toEqual([13, 12, "const line13 = 13;"]);
  });

  it("marks a claimed transcript that does not hold as unbacked", () => {
    const { repo, dir } = workspace();
    writeSitePlan(dir);
    writeFindings(dir, "site-001", [finding("site-001", 12, { strength: "reproduced", command: "node x.mjs", transcript: "nope.txt" })]);
    expect(mergeSiteFindings({ dir, repo }).findings[0].unbacked).toBe(true);
  });
});

describe("a finding's optional range", () => {
  it("accepts a startLine before line, and refuses one after it or spanning too far", () => {
    const { repo, dir } = workspace();
    writeSitePlan(dir);
    writeFindings(dir, "site-001", [finding("site-001", 14, { startLine: 10 })]);
    expect(checkSiteSlot({ dir, repo, siteId: "site-001" }).satisfied).toBe(true);
    for (const startLine of [14, 20, 1, 10.5]) {
      writeFindings(dir, "site-001", [finding("site-001", 14, { startLine })]);
      expect(checkSiteSlot({ dir, repo, siteId: "site-001" }).gaps.map((g) => g.kind), String(startLine)).toEqual(["bad-start-line"]);
    }
  });

  it("carries the range's text through merge and posts it as existingCode, with the end line to fall back to", () => {
    const { repo, dir } = workspace();
    writeSitePlan(dir);
    writeFindings(dir, "site-001", [finding("site-001", 14, { startLine: 12 })]);
    writeSiteMerge(dir, repo);
    const [f] = mergeSiteFindings({ dir, repo }).findings;
    expect([f.startLine, f.rangeText]).toEqual([12, "const line12 = 12;\nconst line13 = 13;\nconst line14 = 14;"]);
    writeFileSync(join(dir, "sites", "selected.json"), JSON.stringify({ items: [{ findings: ["F1"], title: "t", importance: "must-fix" }] }));
    finalizeSiteFindings({ dir, repo });
    const doc = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"));
    expect(doc.findings[0]).toMatchObject({
      line: 14,
      existingCode: "const line12 = 12;\nconst line13 = 13;\nconst line14 = 14;",
      anchorLine: "const line14 = 14;",
    });
  });

  it("drops the range when the cited end line was blank and moved", () => {
    const { repo, dir } = workspace();
    const src = readFileSync(join(repo, "src", "a.ts"), "utf8").split("\n");
    src[13] = "";
    writeFileSync(join(repo, "src", "a.ts"), src.join("\n"));
    writeSitePlan(dir);
    writeFindings(dir, "site-001", [finding("site-001", 14, { startLine: 12 })]);
    const [f] = mergeSiteFindings({ dir, repo }).findings;
    expect(f.line).not.toBe(14);
    expect(f.startLine).toBeUndefined();
    expect(f.rangeText).toBeUndefined();
  });

  it("changes nothing for a finding without one", () => {
    const { repo, dir } = workspace();
    writeSitePlan(dir);
    writeFindings(dir, "site-001", [finding("site-001", 14)]);
    const [f] = mergeSiteFindings({ dir, repo }).findings;
    expect(f.startLine).toBeUndefined();
    expect(f.rangeText).toBeUndefined();
  });
});

describe("sites --check-select and --finalize", () => {
  function merged() {
    const ws = workspace();
    writeSitePlan(ws.dir);
    writeFindings(ws.dir, "site-001", [finding("site-001", 12), finding("site-001", 18, { importance: "nit" })]);
    writeFindings(ws.dir, "site-002", [finding("site-002", 20, { importance: "worth-mentioning" })]);
    writeSiteMerge(ws.dir, ws.repo);
    return ws;
  }
  const select = (dir: string, doc: unknown) => writeFileSync(join(dir, "sites", "selected.json"), JSON.stringify(doc));

  it("holds every pooled finding to exactly one item", () => {
    const { dir } = merged();
    select(dir, { items: [{ findings: ["F1", "F3"], title: "t", importance: "must-fix" }, { findings: ["F3", "F9"], title: "u", importance: "nit" }] });
    const kinds = checkSelection({ dir }).gaps.map((g) => g.kind).sort();
    expect(kinds).toEqual(["duplicate-finding", "uncovered-finding", "unknown-finding"]);
  });

  it("writes findings.json from the selection: primary location, severity by importance, nits internal, every row filed", () => {
    const { repo, dir } = merged();
    select(dir, {
      summary: "Two issues.",
      items: [
        { findings: ["F3", "F1"], primary: "F1", title: "Inverted guard", body: "b", fix: "f", importance: "must-fix" },
        { findings: ["F2"], title: "Trivia", importance: "nit" },
      ],
    });
    const r = finalizeSiteFindings({ dir, repo });
    expect(r).toMatchObject({ source: "selection", posted: 1, recorded: 1, hypotheses: 4 });
    const doc = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"));
    expect(doc.summary).toBe("Two issues.");
    expect(doc.findings[0]).toMatchObject({
      path: "src/a.ts",
      line: 12,
      existingCode: "const line12 = 12;",
      severity: "Important",
      title: "Inverted guard",
      category: "defect",
      fix: "f",
      siteFindings: ["site-002#1", "site-001#1"],
    });
    expect(doc.findings[0].tier).toBeUndefined();
    expect(doc.findings[1]).toMatchObject({ tier: "internal", importance: "nit" });
    expect(doc.internal).toEqual(["contract-001", "contract-002", "contract-003", "state-001"]);
    // The conservation gate reconcile runs over it holds.
    expect(checkFindings({ dir, repo }).satisfied).toBe(true);
  });

  it("records an item the PR's discussion already raised at internal, whatever its importance", () => {
    const { repo, dir } = merged();
    select(dir, {
      items: [
        { findings: ["F1"], title: "Inverted guard", importance: "must-fix", alreadyRaised: "@alice's inline thread on src/a.ts:12" },
        { findings: ["F2", "F3"], title: "Other", importance: "worth-mentioning" },
      ],
    });
    expect(checkSelection({ dir }).satisfied).toBe(true);
    const r = finalizeSiteFindings({ dir, repo });
    expect(r).toMatchObject({ posted: 1, recorded: 1 });
    const doc = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"));
    expect(doc.findings[0]).toMatchObject({ tier: "internal", importance: "must-fix", alreadyRaised: "@alice's inline thread on src/a.ts:12" });
    expect(doc.findings[1].tier).toBeUndefined();
    expect(checkFindings({ dir, repo }).satisfied).toBe(true);
  });

  it("counts areas, not investigators, in the fallback summary when sites are paired", () => {
    const ws = workspace();
    writeSitePlan(ws.dir, { pair: true, slots: 16 });
    writeFindings(ws.dir, "site-001", [finding("site-001", 12)]);
    writeFindings(ws.dir, "site-009", [finding("site-009", 13)]);
    writeFindings(ws.dir, "site-002", [{ site: "site-002", none: true, reason: "r", checked: [] }]);
    writeFindings(ws.dir, "site-010", [{ site: "site-010", none: true, reason: "r", checked: [] }]);
    writeSiteMerge(ws.dir, ws.repo);
    finalizeSiteFindings({ dir: ws.dir, repo: ws.repo });
    const doc = JSON.parse(readFileSync(join(ws.dir, "findings.json"), "utf8"));
    expect(doc.summary).toMatch(/^Investigated 2 area\(s\)/);
  });

  it("falls back to one item per finding when the selection is missing", () => {
    const { repo, dir } = merged();
    const r = finalizeSiteFindings({ dir, repo });
    expect(r.source).toBe("fallback");
    const doc = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"));
    // must-fix first, then worth-mentioning, then the nit (filed internal).
    expect(doc.findings.map((f: { line: number; tier?: string }) => [f.line, f.tier ?? null])).toEqual([
      [12, null],
      [20, null],
      [18, "internal"],
    ]);
  });
});

describe("the `sites` command", () => {
  it("exits non-zero only from its two gates", () => {
    const { repo, dir } = workspace();
    const io = { out: () => {}, err: () => {} };
    expect(runCli(["sites", "--plan", "--dir", dir], io)).toBe(EXIT_OK);
    // Nothing written yet: the gate says iterate again.
    expect(runCli(["sites", "--check", "site-001", "--dir", dir, "--repo", repo], io)).toBe(EXIT_DEGRADED);
    expect(runCli(["sites", "--merge", "--dir", dir, "--repo", repo], io)).toBe(EXIT_OK);
    // Zero pooled findings: an empty selection is complete.
    writeFileSync(join(dir, "sites", "selected.json"), '{"items": []}');
    expect(runCli(["sites", "--check-select", "--dir", dir], io)).toBe(EXIT_OK);
    expect(runCli(["sites", "--finalize", "--dir", dir, "--repo", repo], io)).toBe(EXIT_OK);
    expect(JSON.parse(readFileSync(join(dir, "findings.json"), "utf8")).findings).toEqual([]);
  });
});

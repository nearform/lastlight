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
import { lineHash } from "../src/review-delta.js";
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
  it("writes one brief per real site, ranked by voters — no slot past the last site", () => {
    const { dir } = workspace();
    const plan = writeSitePlan(dir);
    expect(plan.slots.map((s) => [s.siteId, s.site.startLine, s.noneChecks])).toEqual([
      ["site-001", 10, 1],
      ["site-002", 150, 1],
    ]);
    const brief = readFileSync(join(dir, "sites", "site-001.md"), "utf8");
    expect(brief).toContain("site-001");
    expect(brief).toContain(".lastlight/pr-review/sites/site-001.findings.jsonl");
    // No leads: the graded arm A.
    expect(brief).toContain("No leads are given");
    expect(existsSync(join(dir, "sites", "site-003.md"))).toBe(false);
    expect(readSitePlan(dir)?.slots).toHaveLength(2);
  });

  it("writes branches.json — the manifest site-review fans out over — listing only real slots", () => {
    const { dir } = workspace();
    writeSitePlan(dir);
    expect(JSON.parse(readFileSync(join(dir, "sites", "branches.json"), "utf8"))).toEqual({
      items: [{ id: "site-001" }, { id: "site-002" }],
    });
    // Nothing is pre-written: every slot waits for its investigator.
    expect(existsSync(join(dir, "sites", "site-001.findings.jsonl"))).toBe(false);
    expect(existsSync(join(dir, "sites", "site-002.findings.jsonl"))).toBe(false);
  });

  it("fills the slots the code sites leave free with test-file sites, and never lets one displace a code site", () => {
    const { dir } = workspace();
    // Three units on a test file: more votes than site 2, but a test file.
    const testRows = [at("src/a.test.ts", 5, "u5"), at("src/a.test.ts", 6, "u6"), at("src/a.test.ts", 7, "u7")];
    writeFileSync(join(dir, "hypotheses", "tests.jsonl"), `${testRows.map((r) => JSON.stringify(r)).join("\n")}\n`);
    const plan = writeSitePlan(dir);
    expect(plan.slots.slice(0, 3).map((s) => s.site.path)).toEqual(["src/a.ts", "src/a.ts", "src/a.test.ts"]);
    expect(plan.testSites).toBe(1);
    // At top 2 the code sites keep both slots.
    expect(writeSitePlan(dir, { top: 2 }).slots.map((s) => s.site.path)).toEqual(["src/a.ts", "src/a.ts"]);
  });

  it("pairs: a second investigator on every real site, as `<site-id>-b`", () => {
    const { dir } = workspace();
    const plan = writeSitePlan(dir, { top: 3, pair: true });
    expect(plan.slots.map((s) => [s.slot, s.siteId, s.site.startLine, s.pairOf ?? null])).toEqual([
      [1, "site-001", 10, null],
      [2, "site-002", 150, null],
      [3, "site-001-b", 10, "site-001"],
      [4, "site-002-b", 150, "site-002"],
    ]);
    expect(JSON.parse(readFileSync(join(dir, "sites", "branches.json"), "utf8")).items).toEqual([
      { id: "site-001" },
      { id: "site-002" },
      { id: "site-001-b", pair: true },
      { id: "site-002-b", pair: true },
    ]);
    // The pair gets the same site under its own id, output file and scratch dir.
    const brief = readFileSync(join(dir, "sites", "site-001-b.md"), "utf8");
    expect(brief).toContain(".lastlight/pr-review/sites/site-001-b.findings.jsonl");
    expect(brief).toContain(".lastlight/pr-review/sites/site-001-b/");
  });

  it("reads a pre-#423 plan (sixteen static slots, empties `site: null`) as its real slots only", () => {
    // Stored eval runs hold this shape, and `micro-select` replays their merge.
    const { dir, repo } = workspace();
    const plan = writeSitePlan(dir);
    const legacy = {
      ...plan,
      slots: [
        ...plan.slots,
        { slot: 3, siteId: "site-003", site: null, noneChecks: 0 },
        { slot: 9, siteId: "site-009", site: null, noneChecks: 0 },
      ],
    };
    writeFileSync(join(dir, "sites", "plan.json"), JSON.stringify(legacy));
    writeFindings(dir, "site-003", [{ site: "site-003", empty: true }]);
    expect(readSitePlan(dir)?.slots.map((s) => s.siteId)).toEqual(["site-001", "site-002"]);
    writeFindings(dir, "site-001", [finding("site-001", 12)]);
    expect(mergeSiteFindings({ dir, repo }).slots.map((s) => s.siteId)).toEqual(["site-001", "site-002"]);
  });

  it("refuses a top past the maximum", () => {
    const { dir } = workspace();
    expect(() => writeSitePlan(dir, { top: 9 })).toThrow(/top must be 1…8/);
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
  it("never accepts an `empty` line — every slot has a site", () => {
    const { repo, dir } = workspace();
    writeSitePlan(dir);
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
    expect(merge.slots.map((s) => s.outcome)).toEqual(["findings", "findings"]);
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

  it("writes anchorLine for a range even when its end line is too short to be evidence", () => {
    const { repo, dir } = workspace();
    const src = readFileSync(join(repo, "src", "a.ts"), "utf8").split("\n");
    src[13] = "}";
    writeFileSync(join(repo, "src", "a.ts"), src.join("\n"));
    writeSitePlan(dir);
    writeFindings(dir, "site-001", [finding("site-001", 14, { startLine: 12 })]);
    writeSiteMerge(dir, repo);
    writeFileSync(join(dir, "sites", "selected.json"), JSON.stringify({ items: [{ findings: ["F1"], title: "t", importance: "must-fix" }] }));
    finalizeSiteFindings({ dir, repo });
    const doc = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"));
    expect(doc.findings[0]).toMatchObject({ existingCode: "const line12 = 12;\nconst line13 = 13;\n}", anchorLine: "}" });
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

// ── re-review scoping, the convergence gate and coverage (issue #429) ───────

describe("re-review: scoping, the convergence gate and coverage", () => {
  type U = { id: string; lines: [number, number]; delta?: string; risk?: string; touched?: number };
  /** `units.json` for the `workspace()` checkout: u1–u3 own lines 5–25, u4 owns 140–160. */
  function writeUnits(dir: string, units: U[]): void {
    writeFileSync(
      join(dir, "units.json"),
      JSON.stringify({
        units: units.map((u) => ({
          kind: "symbol",
          file: "src/a.ts",
          symbol: u.id,
          key: `src/a.ts::${u.id}`,
          touched: u.touched ?? 3,
          risk: u.risk ?? "medium",
          ...u,
        })),
      }),
    );
  }
  const site1Units = (delta: string, risk = "medium"): U[] =>
    ["u1", "u2", "u3"].map((id) => ({ id, lines: [5, 25] as [number, number], delta, risk }));

  it("carries the rows of unchanged units: they form no site and get no branch", () => {
    const { dir } = workspace();
    writeUnits(dir, [...site1Units("unchanged"), { id: "u4", lines: [140, 160], delta: "changed" }]);
    const plan = writeSitePlan(dir);
    expect(plan.carried).toBe(3);
    expect(plan.slots.map((s) => [s.siteId, s.site.startLine])).toEqual([["site-001", 150]]);
    expect(JSON.parse(readFileSync(join(dir, "sites", "branches.json"), "utf8"))).toEqual({ items: [{ id: "site-001" }] });
  });

  it("carries a row with neither a unit nor a path on a re-review, and keeps it on a first review", () => {
    // units-ingest's family placeholder: no unit, no anchor — nothing to scope or look at.
    const placeholder = { family: "enforcement", claim: "no enforcement hypothesis — 4 of 4 unit(s) answered, and none recorded one", bothEnds: { introducedAt: null, enforcedAt: null }, quotes: [], source: "units", unitId: null };
    const withPlaceholder = () => {
      const ws = workspace();
      writeFileSync(join(ws.dir, "hypotheses", "enforcement.jsonl"), `${JSON.stringify(placeholder)}\n`);
      return ws;
    };
    const first = withPlaceholder();
    writeUnits(first.dir, [{ id: "u1", lines: [5, 25] }, { id: "u4", lines: [140, 160] }]);
    expect(writeSitePlan(first.dir).slots.some((s) => s.site.path === null)).toBe(true);

    const again = withPlaceholder();
    writeUnits(again.dir, [...site1Units("unchanged"), { id: "u4", lines: [140, 160], delta: "changed" }]);
    const plan = writeSitePlan(again.dir);
    expect(plan.carried).toBe(4);
    expect(plan.slots.map((s) => s.site.path)).toEqual(["src/a.ts"]);
  });

  it("keeps affected and new units in scope", () => {
    const { dir } = workspace();
    writeUnits(dir, [...site1Units("affected"), { id: "u4", lines: [140, 160], delta: "new" }]);
    expect(writeSitePlan(dir).slots).toHaveLength(2);
  });

  it("plans no slot when every unit is unchanged — an empty manifest, an empty pool, a summary that says why", () => {
    const { repo, dir } = workspace();
    writeUnits(dir, [...site1Units("unchanged"), { id: "u4", lines: [140, 160], delta: "unchanged" }]);
    const plan = writeSitePlan(dir, { pair: true });
    expect(plan.slots).toEqual([]);
    expect(JSON.parse(readFileSync(join(dir, "sites", "branches.json"), "utf8"))).toEqual({ items: [] });
    const merge = writeSiteMerge(dir, repo);
    expect(renderSiteMerge(merge).startsWith(SITE_MERGE_EMPTY_MARKER)).toBe(true);
    finalizeSiteFindings({ dir, repo });
    const doc = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"));
    expect(doc.findings).toEqual([]);
    expect(doc.summary).toMatch(/unchanged since the last review/);
  });

  it("drops a carried site's pair slot with it", () => {
    const { dir } = workspace();
    writeUnits(dir, [...site1Units("unchanged"), { id: "u4", lines: [140, 160], delta: "changed" }]);
    const plan = writeSitePlan(dir, { pair: true });
    expect(plan.slots.map((s) => s.siteId)).toEqual(["site-001", "site-001-b"]);
    expect(plan.slots.every((s) => s.site.startLine === 150)).toBe(true);
  });

  it("weighs the vote by risk: two high-risk voters outrank three low-risk ones", () => {
    const { dir } = workspace();
    writeFileSync(
      join(dir, "hypotheses", "state.jsonl"),
      `${[at("src/a.ts", 150, "u4"), at("src/a.ts", 152, "u5")].map((r) => JSON.stringify(r)).join("\n")}\n`,
    );
    writeUnits(dir, [
      ...site1Units("changed", "low"),
      { id: "u4", lines: [140, 160], risk: "high" },
      { id: "u5", lines: [140, 160], risk: "high" },
    ]);
    const plan = writeSitePlan(dir);
    expect(plan.slots.map((s) => [s.site.startLine, s.site.risk])).toEqual([
      [150, "high"],
      [10, "low"],
    ]);
  });

  /**
   * Two sites investigated; the selection names one finding in each. The
   * prior review recorded lines 1–100 of `src/a.ts`, so the finding at 12 is on
   * code it already had and the one at 150 is on new code.
   */
  function gated(units: U[], importance: string, risk = "medium", withPrior = true) {
    const ws = workspace();
    writeUnits(ws.dir, units.map((u) => ({ ...u, risk })));
    if (withPrior) {
      const lines = Array.from({ length: 100 }, (_, i) => lineHash(`const line${i + 1} = ${i + 1};`)).join("");
      writeFileSync(join(ws.dir, "prior-review.json"), JSON.stringify({ version: 1, head: "prior", units: [], files: { "src/a.ts": lines } }));
    }
    writePlan(ws.dir);
    writeFindings(ws.dir, "site-001", [finding("site-001", 12, { importance })]);
    writeFindings(ws.dir, "site-002", [finding("site-002", 150, { importance })]);
    writeSiteMerge(ws.dir, ws.repo);
    writeFileSync(
      join(ws.dir, "sites", "selected.json"),
      JSON.stringify({
        items: [
          { findings: ["F1"], title: "On unchanged code", importance },
          { findings: ["F2"], title: "On changed code", importance },
        ],
      }),
    );
    const r = finalizeSiteFindings({ dir: ws.dir, repo: ws.repo });
    const doc = JSON.parse(readFileSync(join(ws.dir, "findings.json"), "utf8"));
    const byLine = (line: number) => doc.findings.find((f: { line: number }) => f.line === line);
    return { r, at12: byLine(12), at150: byLine(150), dir: ws.dir };
  }
  const writePlan = (dir: string) => writeSitePlan(dir);
  // Both sites stay in scope for PLANNING (an `affected` unit at 5–25, a
  // changed one at 140–160) — what the gate judges is the finding's own lines.
  const reached = (): U[] => [
    ...site1Units("affected"),
    { id: "u4", lines: [140, 160], delta: "changed" },
  ];

  it("withholds a worth-mentioning finding on lines the last review had, and posts its twin on new lines", () => {
    const { r, at12, at150 } = gated(reached(), "worth-mentioning");
    expect(at12).toMatchObject({ tier: "internal", withheld: "converged" });
    expect(at150.tier).toBeUndefined();
    expect(r).toMatchObject({ converged: 1, late: 0, posted: 1 });
  });

  it("posts a must-fix on unchanged lines, labelled as missed earlier", () => {
    const { r, at12 } = gated(reached(), "must-fix");
    expect(at12.tier).toBeUndefined();
    expect(at12.lateDiscovery).toBe(true);
    expect(at12.body).toMatch(/^\*\*Missed in an earlier review\.\*\*/);
    expect(r).toMatchObject({ converged: 0, late: 1, posted: 2 });
  });

  it("withholds even a must-fix on unchanged LOW-risk code", () => {
    const { at12 } = gated(reached(), "must-fix", "low");
    expect(at12).toMatchObject({ tier: "internal", withheld: "converged" });
  });

  it("gates nothing on a first review", () => {
    const firstReview: U[] = [
      ...["u1", "u2", "u3"].map((id) => ({ id, lines: [5, 25] as [number, number] })),
      { id: "u4", lines: [140, 160] },
    ];
    const { r, at12 } = gated(firstReview, "worth-mentioning", "medium", false);
    expect(at12.tier).toBeUndefined();
    expect(r).toMatchObject({ converged: 0, late: 0, posted: 2 });
  });

  it("writes review-coverage.json: surveyed and investigated per unit, carried units apart", () => {
    const { dir } = gated([...reached(), { id: "u9", lines: [60, 70], delta: "unchanged" }], "worth-mentioning");
    const cov = JSON.parse(readFileSync(join(dir, "review-coverage.json"), "utf8"));
    expect(cov.rereview).toBe(true);
    expect(cov.carried).toEqual({ units: 1, touched: 3 });
    // u1–u3 and u4 are in scope; all had a site with findings, none was surveyed (no ingest.json).
    expect(cov.inScope).toMatchObject({ units: 4, investigatedUnits: 4, surveyedUnits: 0, investigatedWeighted: 100 });
    expect(cov.units.find((u: { id: string }) => u.id === "u9")).toMatchObject({ delta: "unchanged", investigated: null });
  });
});

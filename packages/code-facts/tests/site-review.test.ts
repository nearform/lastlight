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
    expect(merge.slots.map((s) => s.outcome)).toEqual(["findings", "findings", "missing", "missing", "missing"]);
    expect(renderSiteMerge(merge)).toContain("## F4");
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

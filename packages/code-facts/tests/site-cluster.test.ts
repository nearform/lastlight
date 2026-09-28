/**
 * `clusterSites` — rows grouped by where they point, ranked by how many point
 * there. The mechanism, not the measurement: whether support ranks gold well is
 * `apps/evals/scripts/cluster-screen.ts`'s question.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readHypothesisSet } from "../src/hypotheses.js";
import { renderProbePlan } from "../src/probe-plan.js";
import { isTestPath } from "../src/project.js";
import { clusterSites, DEFAULT_SITE_WINDOW, planProbeSites, renderSiteBrief, siteLeads } from "../src/site-cluster.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function set(hypotheses: Record<string, unknown[]>) {
  const root = mkdtempSync(join(tmpdir(), "ll-site-cluster-"));
  dirs.push(root);
  const dir = join(root, ".lastlight", "pr-review");
  mkdirSync(join(dir, "hypotheses"), { recursive: true });
  for (const [family, rows] of Object.entries(hypotheses)) {
    writeFileSync(join(dir, "hypotheses", `${family}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  }
  return readHypothesisSet(dir);
}

const at = (path: string, line: number, extra: Record<string, unknown> = {}) => ({
  claim: `${path}:${line}`,
  quotes: [{ path, line, text: "x" }],
  ...extra,
});

/** Derives Critical: a live consequence that crosses a boundary and grants a capability. */
const critical = {
  subject: "token",
  control_site: "none",
  control_text: null,
  authority: "binding",
  order_ok: true,
  cannot_distinguish: "nothing",
  bypass: "none found",
  in_changed_hunk: true,
  consequence: "an attacker signs in as anyone",
  trigger: "input",
  crosses_boundary: true,
  capability_gained: "impersonation",
};

describe("clusterSites", () => {
  it("joins rows within the window across families, and splits past it", () => {
    const plan = clusterSites(
      set({
        contract: [at("src/a.ts", 10), at("src/a.ts", 60)],
        security: [at("src/a.ts", 25)],
      }),
      { window: 20 },
    );
    expect(plan.sites.map((s) => [s.rows, s.startLine, s.endLine, s.families])).toEqual([
      [["contract-001", "security-001"], 10, 25, ["contract", "security"]],
      [["contract-002"], 60, 60, ["contract"]],
    ]);
  });

  it("links a chain: each neighbour within the window, the ends further apart", () => {
    const plan = clusterSites(set({ state: [at("src/a.ts", 1), at("src/a.ts", 15), at("src/a.ts", 30)] }), {
      window: 20,
    });
    expect(plan.sites).toHaveLength(1);
    expect(plan.sites[0]).toMatchObject({ support: 3, startLine: 1, endLine: 30 });
  });

  it("never joins two files, however close the lines", () => {
    const plan = clusterSites(set({ state: [at("src/a.ts", 5), at("src/b.ts", 5)] }));
    expect(plan.sites.map((s) => s.path)).toEqual(["src/a.ts", "src/b.ts"]);
  });

  it("falls back to bothEnds.introducedAt, and gives an unanchored row a site of its own", () => {
    const plan = clusterSites(
      set({
        contract: [
          { claim: "ends", bothEnds: { introducedAt: "src/a.ts:12", enforcedAt: null } },
          at("src/a.ts", 14),
          { claim: "nowhere" },
          { claim: "also nowhere" },
        ],
      }),
    );
    expect(plan.sites.map((s) => [s.rows, s.path])).toEqual([
      [["contract-001", "contract-002"], "src/a.ts"],
      [["contract-003"], null],
      [["contract-004"], null],
    ]);
  });

  it("ranks by support, then strongest derived severity, then declaration order", () => {
    const plan = clusterSites(
      set({
        contract: [at("src/lone.ts", 1), at("src/pair.ts", 1), at("src/pair.ts", 2)],
        security: [at("src/crit.ts", 1, { evidence: critical })],
      }),
    );
    expect(plan.sites.map((s) => [s.id, s.path, s.support, s.severity])).toEqual([
      ["site-001", "src/pair.ts", 2, null],
      ["site-002", "src/crit.ts", 1, "Critical"],
      ["site-003", "src/lone.ts", 1, null],
    ]);
  });

  it("byFamily (the ablation) keeps families apart", () => {
    const rows = { contract: [at("src/a.ts", 10)], security: [at("src/a.ts", 11)] };
    expect(clusterSites(set(rows)).sites).toHaveLength(1);
    expect(clusterSites(set(rows), { byFamily: true }).sites).toHaveLength(2);
  });

  it("is pure and conserves every row exactly once", () => {
    const s = set({
      contract: [at("src/a.ts", 1), at("src/a.ts", 90), { claim: "nowhere" }],
      state: [at("src/a.ts", 5), at("src/b.ts", 3)],
    });
    const plan = clusterSites(s);
    expect(clusterSites(s)).toEqual(plan);
    expect(plan).toMatchObject({ rows: 5, window: DEFAULT_SITE_WINDOW, byFamily: false });
    expect(plan.sites.flatMap((x) => x.rows).sort()).toEqual(s.records.map((r) => r.id).sort());
  });
});

describe("planProbeSites", () => {
  // Three rows agree on src/a.ts; a lone Critical sits in src/b.ts; a lone
  // quiet row in src/c.ts that nothing owes.
  const rows = () =>
    set({
      contract: [at("src/a.ts", 10), at("src/a.ts", 12), at("src/c.ts", 1)],
      security: [at("src/a.ts", 15), at("src/b.ts", 40, { evidence: critical })],
    });

  it("takes the top sites by support, then owed rows no site covers as sites of their own", () => {
    const plan = planProbeSites(rows(), { topSites: 1, maxProbes: 8 });
    expect(plan.sites.map((s) => [s.id, s.origin, s.rows])).toEqual([
      ["site-001", "support", ["contract-001", "contract-002", "security-001"]],
      ["owed-security-002", "owed", ["security-002"]],
    ]);
    expect(plan.union.selected.map((p) => [p.id, p.rank])).toEqual([
      ["contract-001", 1],
      ["contract-002", 2],
      ["security-001", 3],
      ["security-002", 4],
    ]);
  });

  it("marks a row the gate would not owe as selected for its site, and keeps an owed row's own reason", () => {
    const plan = planProbeSites(rows(), { topSites: 1, maxProbes: 8 });
    expect(plan.sites[0].plan.selected.map((p) => p.reason)).toEqual(["site", "site", "site"]);
    expect(plan.sites[1].plan.selected.map((p) => p.reason)).toEqual(["critical"]);
  });

  it("does not repeat an owed row a top site already holds, so every row has one writer", () => {
    const plan = planProbeSites(rows(), { topSites: 10, maxProbes: 8 });
    const ids = plan.sites.flatMap((s) => s.rows);
    expect(new Set(ids).size).toBe(ids.length);
    expect(plan.sites.every((s) => s.origin === "support")).toBe(true);
  });

  it("defers owed rows past the cap that no site covers", () => {
    const plan = planProbeSites(rows(), { topSites: 1, maxProbes: 0 });
    expect(plan.sites.map((s) => s.origin)).toEqual(["support"]);
    expect(plan.union.deferred.map((p) => p.id)).toEqual(["security-002"]);
  });

  it("renders a site's plan under a header naming the site, and a plain plan without one", () => {
    const s = rows();
    const plan = planProbeSites(s, { topSites: 1, maxProbes: 8 });
    const md = renderProbePlan(plan.sites[0].plan, s, plan.sites[0]);
    expect(md.split("\n")[0]).toBe("## Site `site-001` — `src/a.ts` lines 10–15");
    expect(renderProbePlan(plan.sites[0].plan, s).startsWith("## Site")).toBe(false);
  });
});

describe("clusterSites — voters", () => {
  const u = (unitId: string) => ({ unitId });
  // src/echo.ts: 3 rows from ONE unit. src/agree.ts: 2 rows from two units.
  const rows = () =>
    set({
      contract: [at("src/echo.ts", 1, u("u-001")), at("src/echo.ts", 2, u("u-001")), at("src/agree.ts", 1, u("u-002"))],
      state: [at("src/echo.ts", 3, u("u-001")), at("src/agree.ts", 2, u("u-003"))],
    });

  it("reports distinct voters on every site, and ranks by rows by default", () => {
    const plan = clusterSites(rows());
    expect(plan.voters).toBe("row");
    expect(plan.sites.map((s) => [s.path, s.support, s.voters])).toEqual([
      ["src/echo.ts", 3, 1],
      ["src/agree.ts", 2, 2],
    ]);
  });

  it("ranks by distinct voters under voters: unit", () => {
    const plan = clusterSites(rows(), { voters: "unit" });
    expect(plan.sites.map((s) => s.path)).toEqual(["src/agree.ts", "src/echo.ts"]);
  });

  it("collapses family-split siblings to their splitOf only when units are given", () => {
    const s = set({
      contract: [at("src/a.ts", 1, u("u-001-contract"))],
      state: [at("src/a.ts", 2, u("u-001-state"))],
    });
    expect(clusterSites(s).sites[0].voters).toBe(2);
    const units = [
      { id: "u-001-contract", splitOf: "u-001" },
      { id: "u-001-state", splitOf: "u-001" },
    ];
    expect(clusterSites(s, { units }).sites[0].voters).toBe(1);
  });

  it("counts a row with no unitId as a voter of its own", () => {
    const s = set({ contract: [at("src/a.ts", 1), at("src/a.ts", 2), at("src/a.ts", 3, u("u-001"))] });
    expect(clusterSites(s).sites[0].voters).toBe(3);
  });

  it("breaks a tie on the chosen measure by the other, then severity", () => {
    const s = set({
      // two voters, three rows
      contract: [at("src/more.ts", 1, u("u-001")), at("src/more.ts", 2, u("u-001")), at("src/more.ts", 3, u("u-002"))],
      // two voters, two rows, one Critical
      security: [at("src/crit.ts", 1, { ...u("u-003"), evidence: critical }), at("src/crit.ts", 2, u("u-004"))],
      // two voters, two rows, no severity
      state: [at("src/plain.ts", 1, u("u-005")), at("src/plain.ts", 2, u("u-006"))],
    });
    expect(clusterSites(s, { voters: "unit" }).sites.map((x) => x.path)).toEqual([
      "src/more.ts",
      "src/crit.ts",
      "src/plain.ts",
    ]);
  });
});

describe("clusterSites — maxSpan", () => {
  const chain = () => set({ state: [1, 15, 30, 45, 60].map((n) => at("src/a.ts", n)) });

  it("leaves single linkage unbounded by default", () => {
    const plan = clusterSites(chain(), { window: 20 });
    expect(plan.maxSpan).toBeNull();
    expect(plan.sites.map((s) => [s.startLine, s.endLine])).toEqual([[1, 60]]);
  });

  it("starts a new site when a run's span would pass maxSpan", () => {
    const plan = clusterSites(chain(), { window: 20, maxSpan: 30 });
    expect(plan.sites.map((s) => [s.startLine, s.endLine])).toEqual([
      [1, 30],
      [45, 60],
    ]);
    expect(plan.sites.every((s) => (s.endLine as number) - (s.startLine as number) <= 30)).toBe(true);
    expect(clusterSites(chain(), { window: 20, maxSpan: 30 })).toEqual(plan);
  });
});

describe("clusterSites — skipPath", () => {
  it("isTestPath recognises the common conventions and not production code", () => {
    for (const p of [
      "src/a.test.ts",
      "src/a.spec.js",
      "src/__tests__/a.ts",
      "test/a.ts",
      "pkg/tests/a.ts",
      "pkg/a_test.go",
      "pkg/test_a.py",
    ]) {
      expect(isTestPath(p), p).toBe(true);
    }
    for (const p of ["src/a.ts", "src/testing.ts", "pkg/a.go", "pkg/a.py", "src/contest/a.ts"]) {
      expect(isTestPath(p), p).toBe(false);
    }
  });

  it("leaves matching rows out of the sites and lists them, conserving every row", () => {
    const s = set({
      contract: [at("src/a.test.ts", 1), at("src/a.ts", 1), at("src/a.test.ts", 2)],
      state: [{ claim: "nowhere" }],
    });
    const plan = clusterSites(s, { skipPath: isTestPath });
    expect(plan.skipped).toEqual(["contract-001", "contract-003"]);
    expect(plan.sites.map((x) => x.path)).toEqual(["src/a.ts", null]);
    expect([...plan.sites.flatMap((x) => x.rows), ...plan.skipped].sort()).toEqual(s.records.map((r) => r.id).sort());
    expect(clusterSites(s).skipped).toEqual([]);
  });
});

describe("planProbeSites — cluster options", () => {
  it("threads voters, maxSpan and skipPath through", () => {
    const s = set({
      contract: [at("src/a.ts", 1, { unitId: "u-001" }), at("src/a.ts", 2, { unitId: "u-001" }), at("src/b.ts", 1, { unitId: "u-002" })],
      state: [at("src/b.ts", 2, { unitId: "u-003" }), at("src/a.test.ts", 1)],
    });
    const plan = planProbeSites(s, { topSites: 1, maxProbes: 8, voters: "unit", maxSpan: 10, skipPath: isTestPath });
    expect(plan).toMatchObject({ voters: "unit", maxSpan: 10, skipped: ["state-002"] });
    expect(plan.sites[0]).toMatchObject({ path: "src/b.ts", voters: 2, support: 2 });
  });

  it("still gives an owed row in a skipped path its own site, anchored where it points", () => {
    const s = set({
      contract: [at("src/a.ts", 1), at("src/a.ts", 2)],
      security: [at("src/a.test.ts", 7, { evidence: critical })],
    });
    const plan = planProbeSites(s, { topSites: 1, maxProbes: 8, skipPath: isTestPath });
    expect(plan.skipped).toEqual(["security-001"]);
    expect(plan.sites.map((x) => [x.id, x.origin, x.path, x.startLine, x.voters])).toEqual([
      ["site-001", "support", "src/a.ts", 1, 2],
      ["owed-security-001", "owed", "src/a.test.ts", 7, 1],
    ]);
  });
});

describe("siteLeads", () => {
  const withSubject = (path: string, line: number, subject: unknown) => at(path, line, { evidence: { subject } });

  it("dedupes by normalised subject, merging row ids and taking the min line", () => {
    const s = set({
      contract: [withSubject("src/a.ts", 12, "  parseToken "), withSubject("src/a.ts", 5, "PARSETOKEN")],
      state: [withSubject("src/a.ts", 8, "cache   key"), withSubject("src/a.ts", 9, "cache key")],
      security: [withSubject("src/a.ts", 3, "parsetoken")],
    });
    const site = clusterSites(s).sites[0];
    const { leads, withoutSubject } = siteLeads(site, s);
    expect(withoutSubject).toEqual([]);
    expect(leads).toEqual([
      { subject: "parseToken", family: "contract", line: 3, rows: ["contract-001", "contract-002", "security-001"] },
      { subject: "cache   key", family: "state", line: 8, rows: ["state-001", "state-002"] },
    ]);
  });

  it("orders leads by rows, then line", () => {
    const s = set({
      contract: [withSubject("src/a.ts", 9, "late"), withSubject("src/a.ts", 2, "early"), withSubject("src/a.ts", 5, "twice")],
      state: [withSubject("src/a.ts", 6, "twice")],
    });
    expect(siteLeads(clusterSites(s).sites[0], s).leads.map((l) => l.subject)).toEqual(["twice", "early", "late"]);
  });

  it("reads only evidence.subject: rows without one contribute nothing and are listed", () => {
    const s = set({
      contract: [
        at("src/a.ts", 1, { claim: "a long claim about parseToken", subject: "top-level, not evidence" }),
        withSubject("src/a.ts", 2, "   "),
        withSubject("src/a.ts", 3, 42),
        withSubject("src/a.ts", 4, "parseToken"),
      ],
    });
    const { leads, withoutSubject } = siteLeads(clusterSites(s).sites[0], s);
    expect(leads.map((l) => l.rows)).toEqual([["contract-004"]]);
    expect(withoutSubject).toEqual(["contract-001", "contract-002", "contract-003"]);
  });
});

describe("renderSiteBrief", () => {
  const s = () =>
    set({
      contract: [
        at("src/a.ts", 10, { unitId: "u-001", evidence: { subject: "parseToken" } }),
        at("src/a.ts", 12, { unitId: "u-001", evidence: { subject: "parsetoken" } }),
      ],
      state: [at("src/a.ts", 15, { unitId: "u-002", evidence: { subject: "cache" } })],
    });

  it("heads the brief with the site, its range and both votes", () => {
    const hs = s();
    const md = renderSiteBrief(clusterSites(hs).sites[0], hs, { leads: true });
    const lines = md.split("\n");
    expect(lines[0]).toBe("## Site `site-001` — `src/a.ts` lines 10–15");
    expect(md).toContain("3 rows from 2 distinct voters");
  });

  it("lists one numbered line per lead with family, line and row count", () => {
    const hs = s();
    const md = renderSiteBrief(clusterSites(hs).sites[0], hs, { leads: true });
    const items = md.split("\n").filter((l) => /^\d+\. /.test(l));
    expect(items).toEqual(["1. parseToken (contract, L10, 2 rows)", "2. cache (state, L15, 1 row)"]);
  });

  it("without leads lists none, and differs only in the lead section", () => {
    const hs = s();
    const site = clusterSites(hs).sites[0];
    const without = renderSiteBrief(site, hs, { leads: false });
    const withLeads = renderSiteBrief(site, hs, { leads: true });
    expect(without.split("\n").filter((l) => /^\d+\. /.test(l))).toEqual([]);
    const head = (md: string) => md.split("\n").slice(0, 5);
    expect(head(without)).toEqual(head(withLeads));
  });
});

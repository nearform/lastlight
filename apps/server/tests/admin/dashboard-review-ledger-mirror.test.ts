/**
 * The dashboard's hand-mirrored view of pr-review's coverage report and review
 * ledger (issue #429), pinned against the real shapes.
 *
 * `dashboard/src/api.ts` has no import edge to core, so `ReviewLedger` /
 * `LedgerFinding` / `ReviewCoverage` exist there as hand-typed copies that the
 * run detail's Review tab renders. The same drift that hid three config blocks
 * for a release (#256, `dashboard-config-mirror.test.ts`) would hide a ledger
 * field here. Like that test, this reads the dashboard source as TEXT — the SPA
 * is not part of the server's TS program.
 *
 * The ledger is pinned against core's own types (a `Record<keyof …>` that stops
 * compiling when a field is added). The coverage report has no core type — it
 * is whatever `readCoverageSummary` compacts out of code-facts'
 * `review-coverage.json` — so it is pinned against that function's OUTPUT for
 * a fully-populated report, plus code-facts' tier vocabularies read as text
 * (core has no dependency on lastlight-code-facts).
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import type { LedgerFinding, LedgerUnit, ReviewLedger } from "#src/engine/review-ledger.js";
import { readCoverageSummary } from "#src/workflows/handlers/post-review.js";

const API = readFileSync(join(import.meta.dirname, "../../dashboard/src/api.ts"), "utf8");
const CODE_FACTS = join(import.meta.dirname, "../../../../packages/code-facts/src");

/** The body of `export interface <name> {…}` / `export type <name> = …;` in the dashboard's api.ts. */
function block(name: string): string {
  const m = new RegExp(`export (?:interface ${name} \\{|type ${name} =)`).exec(API);
  expect(m, `dashboard api.ts no longer declares ${name}`).not.toBeNull();
  const start = m!.index;
  const end = API.indexOf("\n}\n", start);
  const semi = API.indexOf(";\n", start);
  return API.slice(start, m![0].includes("type") ? semi + 1 : end + 2);
}

function expectFields(name: string, keys: string[]) {
  const body = block(name);
  for (const k of keys) {
    expect(body, `dashboard ${name} is missing "${k}"`).toMatch(new RegExp(`\\b${k}\\??:`));
  }
}

const LEDGER: Record<keyof ReviewLedger, true> = {
  version: true, head: true, at: true, rounds: true, units: true, findings: true, truncated: true,
};
const FINDING: Record<keyof LedgerFinding, true> = {
  fp: true, path: true, line: true, excerpt: true, title: true, severity: true, importance: true,
  tier: true, reason: true, status: true, foundAt: true, lastSeenAt: true, closedAt: true,
};
const UNIT: Record<keyof LedgerUnit, true> = { key: true, contentSha: true };

describe("dashboard's review-ledger mirror", () => {
  it("declares every ReviewLedger / LedgerFinding / LedgerUnit field", () => {
    expectFields("ReviewLedger", Object.keys(LEDGER));
    expectFields("LedgerFinding", Object.keys(FINDING));
    expectFields("LedgerUnit", Object.keys(UNIT));
  });

  it("declares every status and tier core can write", () => {
    // Literal unions are not reachable through `keyof`; read them off core's source.
    const core = readFileSync(join(import.meta.dirname, "../../src/engine/review-ledger.ts"), "utf8");
    for (const name of ["LedgerStatus", "LedgerTier"]) {
      const coreUnion = new RegExp(`export type ${name} = ([^;]+);`).exec(core)?.[1] ?? "";
      const values = [...coreUnion.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(values.length).toBeGreaterThan(0);
      const mirror = block(name);
      for (const v of values) expect(mirror, `dashboard ${name} is missing "${v}"`).toContain(`"${v}"`);
    }
  });
});

describe("dashboard's review-coverage mirror", () => {
  it("declares every field readCoverageSummary records", () => {
    const dir = mkdtempSync(join(tmpdir(), "ll-cov-mirror-"));
    const file = join(dir, "review-coverage.json");
    writeFileSync(
      file,
      JSON.stringify({
        version: 1,
        rereview: true,
        inScope: {},
        carried: { units: 0, touched: 0 },
        notInvestigated: [],
        units: [{ key: "k", file: "a.ts", lines: [1, 2], touched: 1, risk: "low", delta: null, surveyed: true, investigated: null }],
      }),
    );
    const summary = readCoverageSummary(file)!;
    expect(summary).not.toBeNull();
    expectFields("ReviewCoverage", Object.keys(summary));
    expectFields("ReviewCoverageUnit", Object.keys((summary.units as Record<string, unknown>[])[0]));
  });

  it("declares every in-scope total code-facts writes", () => {
    // `inScope` is passed through verbatim, so its shape is code-facts' CoverageTotals.
    const src = readFileSync(join(CODE_FACTS, "review-coverage.ts"), "utf8");
    const totals = /export interface CoverageTotals \{([\s\S]*?)\n\}/.exec(src)?.[1] ?? "";
    const keys = [...totals.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]);
    expect(keys.length).toBeGreaterThan(0);
    const inScope = /inScope: \{([\s\S]*?)\n  \};/.exec(block("ReviewCoverage"))?.[1] ?? "";
    for (const k of keys) expect(inScope, `dashboard inScope is missing "${k}"`).toMatch(new RegExp(`\\b${k}:`));
  });

  it("declares every risk tier and delta code-facts can emit", () => {
    const tiers = /RISK_TIERS = \[([^\]]+)\]/.exec(readFileSync(join(CODE_FACTS, "risk.ts"), "utf8"))?.[1] ?? "";
    const deltas = /UNIT_DELTAS = \[([^\]]+)\]/.exec(readFileSync(join(CODE_FACTS, "review-delta.ts"), "utf8"))?.[1] ?? "";
    for (const [name, list] of [["ReviewRisk", tiers], ["ReviewDelta", deltas]] as const) {
      const values = [...list.matchAll(/"([^"]+)"/g)].map((m) => m[1]);
      expect(values.length).toBeGreaterThan(0);
      for (const v of values) expect(block(name), `dashboard ${name} is missing "${v}"`).toContain(`"${v}"`);
    }
  });
});

/**
 * `probe-plan` — the owed set, decided once and read by the gate, the prompt
 * and the dossier.
 *
 * The case this exists for: a unit-survey row carries an evidence record and
 * NO `severity` field, so a prompt keyed on `"severity": "Critical"` saw nothing
 * while the gate (which derives) owed 21 rows. The plan derives, so the agent is
 * shown exactly what the gate will ask for.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEntries, renderAdjudicationDossier } from "../src/adjudicate-render.js";
import { runCli } from "../src/cli.js";
import { readHypothesisSet } from "../src/hypotheses.js";
import { planProbes, readProbePlan, renderProbePlan, writeProbePlan } from "../src/probe-plan.js";
import { checkProbes } from "../src/probes.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Derives Critical: a live consequence that crosses a boundary and grants a capability. */
const critical = (control: "ABSENT" | "PARTIAL" | "QUOTE") => ({
  subject: "token",
  control_site: control === "ABSENT" ? "none" : "src/a.ts:3",
  control_text: control === "ABSENT" ? null : "check(token)",
  authority: control === "PARTIAL" ? "advisory" : "binding",
  order_ok: true,
  cannot_distinguish: "nothing",
  bypass: "none found",
  in_changed_hunk: true,
  consequence: "an attacker signs in as anyone",
  trigger: "input",
  crosses_boundary: true,
  capability_gained: "impersonation",
});

/** Derives Minor with no probe: nothing harmful, a clean binding control off the diff. */
const quiet = {
  subject: "x",
  control_site: "src/a.ts:9",
  control_text: "assert(x)",
  authority: "binding",
  order_ok: true,
  cannot_distinguish: "nothing",
  bypass: "none found",
  in_changed_hunk: false,
  consequence: null,
  trigger: "input",
};

function workspace(hypotheses: Record<string, unknown[]>, verdicts?: unknown[]): string {
  const root = mkdtempSync(join(tmpdir(), "ll-probe-plan-"));
  dirs.push(root);
  const dir = join(root, ".lastlight", "pr-review");
  mkdirSync(join(dir, "hypotheses"), { recursive: true });
  mkdirSync(join(dir, "probes"), { recursive: true });
  for (const [family, rows] of Object.entries(hypotheses)) {
    writeFileSync(join(dir, "hypotheses", `${family}.jsonl`), `${rows.map((r) => JSON.stringify(r)).join("\n")}\n`);
  }
  if (verdicts) {
    writeFileSync(join(dir, "probes", "verdicts.jsonl"), `${verdicts.map((r) => JSON.stringify(r)).join("\n")}\n`);
  }
  return dir;
}

describe("planProbes", () => {
  it("owes a probe on a DERIVED Critical, which carries no severity field at all", () => {
    const dir = workspace({ security: [{ claim: "c", evidence: critical("ABSENT") }, { claim: "q", evidence: quiet }] });
    const plan = planProbes(readHypothesisSet(dir), { maxProbes: null });
    expect(plan.selected.map((p) => [p.id, p.reason])).toEqual([["security-001", "critical"]]);
    expect(plan).toMatchObject({ rows: 2, owed: 1, deferred: [] });
  });

  it("ranks Critical before a survey's own ask, then ABSENT > PARTIAL > QUOTE, then declaration order", () => {
    const dir = workspace({
      contract: [{ claim: "asked", needsProbe: true }],
      security: [
        { claim: "quote", evidence: critical("QUOTE") },
        { claim: "partial", evidence: critical("PARTIAL") },
        { claim: "absent-1", evidence: critical("ABSENT") },
        { claim: "absent-2", evidence: critical("ABSENT") },
      ],
    });
    const plan = planProbes(readHypothesisSet(dir), { maxProbes: null });
    expect(plan.selected.map((p) => p.id)).toEqual([
      "security-003",
      "security-004",
      "security-002",
      "security-001",
      "contract-001",
    ]);
    expect(plan.selected.map((p) => p.rank)).toEqual([1, 2, 3, 4, 5]);
  });

  it("cuts at the cap and keeps the rest as deferred, in the same rank sequence", () => {
    const dir = workspace({ security: [1, 2, 3].map((n) => ({ claim: `c${n}`, evidence: critical("ABSENT") })) });
    const plan = planProbes(readHypothesisSet(dir), { maxProbes: 2 });
    expect(plan.selected.map((p) => p.id)).toEqual(["security-001", "security-002"]);
    expect(plan.deferred.map((p) => [p.id, p.rank])).toEqual([["security-003", 3]]);
    expect(planProbes(readHypothesisSet(dir), { maxProbes: 0 }).selected).toEqual([]);
  });
});

describe("the gate reads the plan", () => {
  const rows = { security: [1, 2, 3].map((n) => ({ claim: `c${n}`, evidence: critical("ABSENT") })) };

  it("owes only the selected rows, and says how many were deferred", () => {
    const dir = workspace(rows, [{ hypothesis: "security-001", verdict: "unprobed", reason: "no runner" }]);
    writeProbePlan(dir, { maxProbes: 1 });
    const result = checkProbes({ dir });
    expect(result.required).toEqual(["security-001"]);
    expect(result.satisfied).toBe(true);
    expect(result.notes.join("\n")).toMatch(/2 owed hypothesis\(es\) are past the probe cap of 1/);
  });

  it("still gaps a selected row with no verdict", () => {
    const dir = workspace(rows);
    writeProbePlan(dir, { maxProbes: 2 });
    const result = checkProbes({ dir });
    expect(result.gaps.map((g) => [g.kind, g.hypothesis])).toEqual([
      ["no-verdict", "security-001"],
      ["no-verdict", "security-002"],
    ]);
  });

  it("falls back to every owed row when no plan was written", () => {
    const dir = workspace(rows);
    expect(readProbePlan(dir)).toBeNull();
    expect(checkProbes({ dir }).required).toEqual(["security-001", "security-002", "security-003"]);
  });

  it("treats an unreadable plan as no plan — the conservative answer", () => {
    const dir = workspace(rows);
    writeFileSync(join(dir, "probes", "plan.json"), "{not json");
    expect(checkProbes({ dir }).required).toHaveLength(3);
  });
});

describe("what falsify and adjudicate read", () => {
  it("plan.md carries the selected records, and names the deferred count without listing them", () => {
    const dir = workspace({
      security: [
        { claim: "first", evidence: critical("ABSENT") },
        { claim: "second", evidence: critical("ABSENT") },
      ],
    });
    const { plan } = writeProbePlan(dir, { maxProbes: 1 });
    const md = renderProbePlan(plan, readHypothesisSet(dir));
    expect(md).toContain("`security-001`");
    expect(md).toContain('"claim": "first"');
    expect(md).not.toContain("security-002");
    expect(md).toMatch(/1 more were owed/);
    expect(readFileSync(join(dir, "probes", "plan.md"), "utf8")).toBe(md);
  });

  it("an empty plan says there is nothing to probe", () => {
    const dir = workspace({ security: [{ claim: "q", evidence: quiet }] });
    const { plan } = writeProbePlan(dir, { maxProbes: 5 });
    expect(renderProbePlan(plan, readHypothesisSet(dir))).toMatch(/None of the 1 hypotheses is owed a probe/);
  });

  it("the dossier tells a deferred row apart from a row falsify skipped", () => {
    const dir = workspace({
      security: [
        { claim: "first", evidence: critical("ABSENT") },
        { claim: "second", evidence: critical("ABSENT") },
      ],
    });
    writeProbePlan(dir, { maxProbes: 1 });
    const { entries } = buildEntries({ dir, repo: join(dir, "..", "..") });
    expect(entries.map((e) => e.deferred)).toEqual([null, { rank: 2, owed: 2, cap: 1 }]);
    const doc = renderAdjudicationDossier({ dir, repo: join(dir, "..", "..") });
    expect(doc).toMatch(/owed one \(rank 2 of 2\) but past this deployment's probe cap of 1/);
    expect(doc).toMatch(/no verdict was written for this hypothesis/);
  });
});

describe("lastlight-facts probe-plan", () => {
  function io() {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
  }

  it("writes plan.json and plan.md and prints one summary line", async () => {
    const dir = workspace({ security: [1, 2, 3].map((n) => ({ claim: `c${n}`, evidence: critical("ABSENT") })) });
    const cap = io();
    const code = await runCli(["probe-plan", "--dir", dir, "--max-probes", "2"], cap.io);
    expect(code).toBe(0);
    expect(existsSync(join(dir, "probes", "plan.json"))).toBe(true);
    expect(existsSync(join(dir, "probes", "plan.md"))).toBe(true);
    expect(cap.out.join("\n")).toBe(
      "probe-plan: 2 selected of 3 owed (2 Critical) over 3 row(s), cap 2; 1 deferred to adjudication unprobed",
    );
  });

  it("with no --max-probes the cap is off", async () => {
    const dir = workspace({ security: [1, 2, 3].map((n) => ({ claim: `c${n}`, evidence: critical("ABSENT") })) });
    const cap = io();
    await runCli(["probe-plan", "--dir", dir], cap.io);
    expect(readProbePlan(dir)).toMatchObject({ maxProbes: null, owed: 3, deferred: [] });
  });
});

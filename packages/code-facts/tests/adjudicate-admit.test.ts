/**
 * `admit` — which hypotheses `adjudicate` weighs.
 *
 * Every rule reads typed fields of the evidence record, a probe verdict or a
 * classifier's category — never a claim's prose. The contract pinned here: a
 * row that is not admitted disappears from the dossier and the checklist, the
 * gate owes nothing for it, and `--repair` files it at internal with its rule.
 */
import { afterAll, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { parseAdmitSpec, readAdmission, writeAdmission } from "../src/adjudicate-admit.js";
import { renderAdjudicationDossier } from "../src/adjudicate-render.js";
import { runCli } from "../src/cli.js";
import { buildFindingsLedger, checkFindings } from "../src/findings.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const cleanQuote = {
  subject: "x",
  control_site: "src/a.ts:3",
  control_text: "assert(x)",
  authority: "binding",
  order_ok: true,
  cannot_distinguish: "nothing",
  bypass: "none found",
  in_changed_hunk: true,
  consequence: null,
  trigger: "input",
};
const advisoryNoConsequence = { ...cleanQuote, authority: "advisory" };
const defect = { ...cleanQuote, control_site: "none", control_text: null, consequence: "a stranger reads the file", crosses_boundary: true };
const codeChange = { ...defect, trigger: "code_change" };

function workspace(rows: Record<string, unknown[]>, extra: { verdicts?: unknown[]; jev?: unknown } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "ll-admit-"));
  dirs.push(root);
  const dir = join(root, ".lastlight", "pr-review");
  mkdirSync(join(dir, "hypotheses"), { recursive: true });
  mkdirSync(join(dir, "probes"), { recursive: true });
  for (const [family, list] of Object.entries(rows)) {
    writeFileSync(join(dir, "hypotheses", `${family}.jsonl`), `${list.map((r) => JSON.stringify(r)).join("\n")}\n`);
  }
  if (extra.verdicts) {
    writeFileSync(join(dir, "probes", "verdicts.jsonl"), `${extra.verdicts.map((r) => JSON.stringify(r)).join("\n")}\n`);
  }
  if (extra.jev) writeFileSync(join(dir, "jev.json"), JSON.stringify(extra.jev));
  return dir;
}

describe("parseAdmitSpec", () => {
  it("reads every rule kind and normalises `all`", () => {
    expect(parseAdmitSpec("all")).toEqual({ rules: [], jev: [], top: null });
    expect(parseAdmitSpec("no-clean-quote,jev:verification@0.9,top:40")).toEqual({
      rules: ["no-clean-quote"],
      jev: [{ category: "verification", minConfidence: 0.9 }],
      top: 40,
    });
  });

  it("refuses an unknown or malformed rule rather than defaulting to `all`", () => {
    expect(() => parseAdmitSpec("no-clean-quotes")).toThrow(/unknown admission rule/);
    expect(() => parseAdmitSpec("jev:verification")).toThrow(/jev:<category>@/);
    expect(() => parseAdmitSpec("top:-1")).toThrow(/non-negative integer/);
  });
});

describe("the typed-field rules", () => {
  const rows = {
    contract: [
      { claim: "clean", evidence: cleanQuote },
      { claim: "advisory, no consequence", evidence: advisoryNoConsequence },
      { claim: "defect", evidence: defect },
      { claim: "code change", evidence: codeChange },
      { claim: "legacy row, no evidence" },
    ],
  };

  it("no-clean-quote files only a binding, in-time, unbypassed quote with no consequence", () => {
    const a = writeAdmission(workspace(rows), parseAdmitSpec("no-clean-quote"));
    expect(a.filed).toEqual([{ id: "contract-001", rule: "no-clean-quote" }]);
  });

  it("no-consequence also files the advisory row; a legacy row is always admitted", () => {
    const a = writeAdmission(workspace(rows), parseAdmitSpec("no-consequence"));
    expect(a.filed.map((f) => f.id)).toEqual(["contract-001", "contract-002"]);
    expect(a.admitted).toContain("contract-005");
  });

  it("no-code-change reads the LABEL, not the sentence", () => {
    const a = writeAdmission(workspace(rows), parseAdmitSpec("no-code-change"));
    expect(a.filed).toEqual([{ id: "contract-004", rule: "no-code-change" }]);
  });

  it("an EXECUTED probe overrides every rule", () => {
    const dir = workspace({ contract: [{ claim: "clean but reproduced", evidence: cleanQuote }] }, {
      verdicts: [{ hypothesis: "contract-001", verdict: "reproduced", command: "node p.mjs", transcript: ".lastlight/pr-review/probes/contract-001.txt" }],
    });
    writeFileSync(join(dir, "probes", "contract-001.txt"), "$ node p.mjs\nboom\n");
    const a = writeAdmission(dir, parseAdmitSpec("no-consequence"), { repo: join(dir, "..", "..") });
    expect(a.admitted).toEqual(["contract-001"]);
  });

  it("top:n keeps the strongest — a stated consequence over none, then crosses_boundary", () => {
    const a = writeAdmission(workspace(rows), parseAdmitSpec("top:2"));
    expect(a.admitted).toEqual(["contract-003", "contract-004"]);
    expect(a.filed.every((f) => f.rule === "top:2")).toBe(true);
  });
});

describe("the classifier rule", () => {
  const rows = { contract: [{ claim: "a", evidence: defect }, { claim: "b", evidence: defect }, { claim: "c", evidence: defect }] };
  const jev = {
    model: "jev-latest",
    generatedAt: "2026-09-27T00:00:00Z",
    error: null,
    results: [
      { id: "contract-001", category: "verification", confidence: 0.95, probabilities: null, error: null, probeContradiction: null },
      { id: "contract-002", category: "verification", confidence: 0.6, probabilities: null, error: null, probeContradiction: null },
      { id: "contract-003", category: "defect", confidence: 0.99, probabilities: null, error: null, probeContradiction: null },
    ],
  };

  it("files a row only at or above the stated confidence for that category", () => {
    const a = writeAdmission(workspace(rows, { jev }), parseAdmitSpec("jev:verification@0.9"));
    expect(a.filed).toEqual([{ id: "contract-001", rule: "jev:verification@0.9" }]);
  });

  it("refuses to run a jev rule with no classification on disk", () => {
    expect(() => writeAdmission(workspace(rows), parseAdmitSpec("jev:verification@0.9"))).toThrow(/jev\.json/);
  });
});

describe("the gate, the ledger and the dossier honour the admission", () => {
  const rows = { contract: [{ claim: "clean", evidence: cleanQuote }, { claim: "defect", evidence: defect }] };

  it("owes a disposition only for admitted rows; repair files the rest with their rule", () => {
    const dir = workspace(rows);
    writeAdmission(dir, parseAdmitSpec("no-clean-quote"));
    writeFileSync(
      join(dir, "findings.json"),
      JSON.stringify({ summary: "s", event: "COMMENT", findings: [{ title: "t", body: "b", tier: "inline", hypotheses: ["contract-002"] }] }),
    );
    const check = checkFindings({ dir });
    expect(check.satisfied).toBe(true);
    expect(check.notes.join("\n")).toMatch(/1 hypothesis\(es\) were not admitted/);

    const repaired = checkFindings({ dir, repair: true });
    expect(repaired.repaired).toEqual([{ kind: "filed", hypothesis: "contract-001", detail: 'not admitted (no-clean-quote) — filed at tier "internal"' }]);
    const doc = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8"));
    const filed = doc.findings.find((f: { hypotheses: string[] }) => f.hypotheses[0] === "contract-001");
    expect(filed).toMatchObject({ tier: "internal", filedBy: "no-clean-quote", body: "clean" });
    // Idempotent: a second repair files nothing new.
    expect(checkFindings({ dir, repair: true }).repaired).toEqual([]);
  });

  it("the checklist and the dossier show only admitted rows", () => {
    const dir = workspace(rows);
    writeAdmission(dir, parseAdmitSpec("no-clean-quote"));
    expect(buildFindingsLedger({ dir }).entries.map((e) => e.id)).toEqual(["contract-002"]);
    const doc = renderAdjudicationDossier({ dir, repo: join(dir, "..", "..") });
    expect(doc).toMatch(/1 of 2 hypotheses were not admitted to this pass \(`no-clean-quote` 1\)/);
    expect(doc).toContain("contract-002");
    expect(doc).not.toMatch(/### .*contract-001/);
  });

  it("no admission.json is the old behaviour: every row owed", () => {
    const dir = workspace(rows);
    expect(readAdmission(dir)).toBeNull();
    writeFileSync(join(dir, "findings.json"), JSON.stringify({ summary: "s", event: "COMMENT", findings: [] }));
    expect(checkFindings({ dir }).gaps.map((g) => g.hypothesis)).toEqual(["contract-001", "contract-002"]);
  });
});

describe("lastlight-facts dossier --admit", () => {
  const cap = () => {
    const out: string[] = [];
    const err: string[] = [];
    return { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, out, err };
  };
  const rows = { contract: [{ claim: "clean", evidence: cleanQuote }, { claim: "defect", evidence: defect }] };

  it("admits, writes admission.json, and renders only the admitted rows — one step", () => {
    const dir = workspace(rows);
    const c = cap();
    expect(runCli(["dossier", "--dir", dir, "--repo", join(dir, "..", ".."), "--admit", "no-clean-quote"], c.io)).toBe(0);
    expect(c.err).toEqual(['admit: 1 of 2 row(s) admitted under "no-clean-quote"; 1 filed internal (no-clean-quote 1)']);
    expect(readAdmission(dir)?.filed).toEqual([{ id: "contract-001", rule: "no-clean-quote" }]);
    expect(c.out.join("\n")).toMatch(/1 of 2 hypotheses were not admitted/);
  });

  it("a bad spec still renders — every row admitted, any stale admission removed, said loudly", () => {
    const dir = workspace(rows);
    writeAdmission(dir, parseAdmitSpec("no-clean-quote"));
    const c = cap();
    expect(runCli(["dossier", "--dir", dir, "--repo", join(dir, "..", ".."), "--admit", "nope"], c.io)).toBe(0);
    expect(existsSync(join(dir, "admission.json"))).toBe(false);
    expect(c.err.join("\n")).toMatch(/EVERY row is admitted: unknown admission rule "nope"/);
    expect(c.out.join("\n")).not.toMatch(/were not admitted/);
  });
});

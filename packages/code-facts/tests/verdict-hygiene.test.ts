/**
 * Issue #405 — verdict hygiene in `falsify`, and the severity derived from it.
 *
 * Measured on one Martian case: of 13 `reproduced` verdicts, 4 were a grep
 * recorded against a claim about what the code DOES, and 3 cited another
 * hypothesis's script. These pin the mechanism that separates an execution
 * from a read, and the one derivation (`finding-severity.ts`) the pipeline's
 * reconcile phase and the evals both read.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildEntries } from "../src/adjudicate-render.js";
import {
  buildSeverityIndex,
  hypothesisSeverity,
  stampDerivedSeverity,
  strongestSeverity,
} from "../src/finding-severity.js";
import { checkFindings } from "../src/findings.js";
import { checkProbes, isReadOnlyCommand, probeStrength, readProbeAnswers } from "../src/probes.js";
import { readHypothesisSet } from "../src/hypotheses.js";
import { isBehaviouralClaim, type SurveyEvidence } from "../src/survey-verdict.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function workspace(files: {
  hypotheses?: Record<string, unknown[]>;
  verdicts?: unknown[];
  transcripts?: [string, string][];
  findings?: unknown;
}): { dir: string; root: string } {
  const root = mkdtempSync(join(tmpdir(), "ll-hygiene-"));
  dirs.push(root);
  const dir = join(root, ".lastlight", "pr-review");
  mkdirSync(join(dir, "hypotheses"), { recursive: true });
  mkdirSync(join(dir, "probes"), { recursive: true });
  for (const [family, rows] of Object.entries(files.hypotheses ?? {})) {
    writeFileSync(join(dir, "hypotheses", `${family}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  if (files.verdicts) {
    writeFileSync(join(dir, "probes", "verdicts.jsonl"), files.verdicts.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  for (const [name, body] of files.transcripts ?? []) writeFileSync(join(dir, "probes", name), body);
  if (files.findings !== undefined) writeFileSync(join(dir, "findings.json"), JSON.stringify(files.findings, null, 2));
  return { dir, root };
}

/** A clean-shaped record with a stated, live, local consequence. */
const behavioural: SurveyEvidence = {
  subject: "deleteCache",
  control_site: "none",
  authority: "unknown",
  order_ok: "unknown",
  cannot_distinguish: "a foreign credential from an owned one",
  bypass: "none found",
  in_changed_hunk: true,
  consequence: "the handler deletes another user's cache entry",
  trigger: "input",
  crosses_boundary: false,
  capability_gained: null,
};
/** No consequence: a structural claim ("nothing else calls this"). */
const structural: SurveyEvidence = { ...behavioural, consequence: null, cannot_distinguish: "nothing" };

describe("isReadOnlyCommand — a read, not an execution", () => {
  it("recognises searches, file views and facts queries, alone or piped together", () => {
    for (const cmd of [
      "grep -rn deleteCache src",
      "rg deleteCache",
      "cat src/a.ts",
      "$ grep -rn x src | wc -l",
      "cd packages/app && rg foo",
      "git grep -n foo",
      "/usr/bin/grep foo bar",
      "sed -n '10,20p' src/a.ts",
      "lastlight-facts facts --repo . --base main",
      "lastlight facts constants --repo .",
      "BASE: grep foo a.ts HEAD: grep foo b.ts",
      // A quoted alternation is one argument, not a pipe into a program `new`
      // — the exact shape measured on a real run.
      'grep -rn "CalendarCache.init\\|new CalendarCacheRepository" --include="*.ts" packages apps',
      "grep -rn 'a|b' src && echo \"=== | ===\"; rg c",
    ]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(true);
    }
  });

  it("counts anything that runs code as execution, including a read piped after it", () => {
    for (const cmd of [
      "node .lastlight/pr-review/probes/state-001.mjs",
      "node probe.mjs | grep FAIL",
      "npx tsx probe.ts",
      "git show origin/main:src/a.ts",
      "BASE: git show origin/main:a.ts HEAD: git show HEAD:a.ts",
      "python3 -c 'print(1)'",
      "echo hi",
    ]) {
      expect(isReadOnlyCommand(cmd), cmd).toBe(false);
    }
  });
});

describe("isBehaviouralClaim — derived from the evidence record", () => {
  it("is a stated consequence that is live at head", () => {
    expect(isBehaviouralClaim({ evidence: behavioural })).toBe(true);
    expect(isBehaviouralClaim({ evidence: { ...behavioural, trigger: "unknown" } })).toBe(true);
  });

  it("is not a discharge, a maintenance hazard, or a row with no record", () => {
    expect(isBehaviouralClaim({ evidence: structural })).toBe(false);
    expect(isBehaviouralClaim({ evidence: { ...behavioural, trigger: "code_change" } })).toBe(false);
    // The edit-conditional normalisation applies here too.
    expect(isBehaviouralClaim({ evidence: { ...behavioural, consequence: "if the constant is later renamed, the copy goes stale" } })).toBe(false);
    expect(isBehaviouralClaim({})).toBe(false);
  });
});

describe("the probes gate — `reproduced` on a behavioural claim must be an execution", () => {
  const needs = (evidence: SurveyEvidence) => ({ needsProbe: true, severity: "Important", evidence });

  function gate(evidence: SurveyEvidence, verdict: string, command: string) {
    const { dir, root } = workspace({
      hypotheses: { state: [needs(evidence)] },
      verdicts: [{ hypothesis: "state-001", verdict, command, transcript: ".lastlight/pr-review/probes/state-001.txt" }],
      transcripts: [["state-001.txt", `$ ${command}\nsrc/a.ts:12: deleteCache(\n`]],
    });
    return checkProbes({ dir, repo: root });
  }

  it("rejects a grep recorded as `reproduced` against a behavioural claim", () => {
    const result = gate(behavioural, "reproduced", "grep -rn deleteCache src");
    expect(result.satisfied).toBe(false);
    expect(result.gaps.map((g) => g.kind)).toEqual(["read-not-reproduction"]);
    expect(result.executed).toBe(0);
  });

  it("accepts the same grep as `corroborated`, and does not count it as execution", () => {
    const result = gate(behavioural, "corroborated", "grep -rn deleteCache src");
    expect(result.satisfied).toBe(true);
    expect(result.claimedExecution).toBe(0);
    expect(result.byVerdict).toEqual({ corroborated: 1 });
  });

  it("accepts a grep as `reproduced` against a STRUCTURAL claim — that is what a search settles", () => {
    const result = gate(structural, "reproduced", "grep -rn deleteCache src");
    expect(result.satisfied).toBe(true);
    expect(result.executed).toBe(1);
  });

  it("holds a VOLUNTEERED `reproduced` (no probe required) to the same read-not-reproduction line", () => {
    const { dir, root } = workspace({
      hypotheses: { state: [{ evidence: behavioural }] },
      verdicts: [{ hypothesis: "state-001", verdict: "reproduced", command: "rg deleteCache", transcript: "probes/state-001.txt" }],
      transcripts: [["state-001.txt", "rg deleteCache\nsrc/a.ts:1\n"]],
    });
    const result = checkProbes({ dir, repo: root });
    expect(result.required).toEqual([]);
    expect(result.gaps.map((g) => g.kind)).toEqual(["read-not-reproduction"]);
  });

  it("accepts an execution as `reproduced` against a behavioural claim", () => {
    expect(gate(behavioural, "reproduced", "node .lastlight/pr-review/probes/state-001.mjs").satisfied).toBe(true);
  });

  it("holds `corroborated` to the transcript bar — it claims evidence too", () => {
    const { dir, root } = workspace({
      hypotheses: { state: [needs(behavioural)] },
      verdicts: [{ hypothesis: "state-001", verdict: "corroborated", command: "grep x src", transcript: "probes/missing.txt" }],
    });
    const result = checkProbes({ dir, repo: root });
    expect(result.satisfied).toBe(false);
    expect(result.gaps[0].kind).toBe("no-transcript");
  });

  it("keeps `unprobed` free", () => {
    const { dir, root } = workspace({
      hypotheses: { state: [needs(behavioural)] },
      verdicts: [{ hypothesis: "state-001", verdict: "unprobed", reason: "no runner" }],
    });
    expect(checkProbes({ dir, repo: root }).satisfied).toBe(true);
  });

  it("reports a transcript borrowed from another hypothesis without failing on it", () => {
    const { dir, root } = workspace({
      hypotheses: { spec: [needs(behavioural)], state: [needs(behavioural)] },
      verdicts: [
        { hypothesis: "spec-001", verdict: "reproduced", command: "node .lastlight/pr-review/probes/spec-001.mjs", transcript: "probes/spec-001.txt" },
        { hypothesis: "state-001", verdict: "reproduced", command: "node .lastlight/pr-review/probes/spec-001.mjs", transcript: "probes/spec-001.txt" },
      ],
      transcripts: [["spec-001.txt", "node .lastlight/pr-review/probes/spec-001.mjs\nok\n"]],
    });
    const result = checkProbes({ dir, repo: root });
    expect(result.satisfied).toBe(true);
    expect(result.borrowed).toBe(1);
    const set = readHypothesisSet(dir);
    const { answers } = readProbeAnswers({ dir, repo: root }, set);
    expect(answers.get("state-001")!.borrowedFrom).toBe("spec-001");
    expect(answers.get("spec-001")!.borrowedFrom).toBeNull();
  });
});

describe("probeStrength — what a verdict counts for", () => {
  function strengthOf(evidence: SurveyEvidence, verdict: string, command: string, transcript = `${command}\nout\n`) {
    const { dir, root } = workspace({
      hypotheses: { state: [{ evidence }] },
      verdicts: [{ hypothesis: "state-001", verdict, command, transcript: "probes/state-001.txt" }],
      transcripts: [["state-001.txt", transcript]],
    });
    const set = readHypothesisSet(dir);
    const answer = readProbeAnswers({ dir, repo: root }, set).answers.get("state-001");
    return probeStrength(answer, { evidence });
  }

  it("reads a grep-backed `reproduced` on a behavioural claim as corroboration", () => {
    expect(strengthOf(behavioural, "reproduced", "grep -rn x src")).toBe("corroborated");
    expect(strengthOf(behavioural, "reproduced", "node probe.mjs")).toBe("executed");
    expect(strengthOf(structural, "reproduced", "grep -rn x src")).toBe("executed");
    expect(strengthOf(behavioural, "corroborated", "grep -rn x src")).toBe("corroborated");
    expect(strengthOf(behavioural, "refuted", "node probe.mjs")).toBe("refuted");
  });

  it("gives nothing to a claim of evidence the transcript does not record", () => {
    expect(strengthOf(behavioural, "reproduced", "node probe.mjs", "I read the code\n")).toBe("none");
    expect(probeStrength(null, { evidence: behavioural })).toBe("none");
  });

  it("is what the dossier entries carry", () => {
    const { dir, root } = workspace({
      hypotheses: { state: [{ evidence: behavioural }] },
      verdicts: [{ hypothesis: "state-001", verdict: "reproduced", command: "rg deleteCache", transcript: "probes/state-001.txt" }],
      transcripts: [["state-001.txt", "rg deleteCache\nsrc/a.ts:1\n"]],
    });
    const { entries } = buildEntries({ dir, repo: root });
    expect(entries[0]!.strength).toBe("corroborated");
  });
});

describe("hypothesisSeverity — the posting band, derived", () => {
  const crossing: SurveyEvidence = { ...behavioural, crosses_boundary: true };
  const critical: SurveyEvidence = { ...behavioural, crosses_boundary: true, capability_gained: "delete another tenant's cache" };

  it("keeps Important only for a boundary-crossing consequence or an executed scenario", () => {
    expect(hypothesisSeverity({ evidence: crossing }, "none")).toBe("Important");
    expect(hypothesisSeverity({ evidence: behavioural }, "executed")).toBe("Important");
    expect(hypothesisSeverity({ evidence: behavioural }, "corroborated")).toBe("Minor");
    expect(hypothesisSeverity({ evidence: behavioural }, "none")).toBe("Minor");
  });

  it("never lets corroboration raise a band", () => {
    expect(hypothesisSeverity({ evidence: behavioural }, "corroborated")).toBe(hypothesisSeverity({ evidence: behavioural }, "none"));
  });

  it("keeps the survey's Critical, and demotes discharges, deferred consequences and refutations", () => {
    expect(hypothesisSeverity({ evidence: critical }, "none")).toBe("Critical");
    expect(hypothesisSeverity({ evidence: structural }, "executed")).toBe("Minor");
    expect(hypothesisSeverity({ evidence: { ...crossing, trigger: "code_change" } }, "executed")).toBe("Minor");
    expect(hypothesisSeverity({ evidence: critical }, "refuted")).toBe("Minor");
  });

  it("falls back to a declared severity only when there is no evidence record", () => {
    expect(hypothesisSeverity({ severity: "Critical" }, "none")).toBe("Critical");
    expect(hypothesisSeverity({ severity: "Blocker" }, "none")).toBeNull();
    expect(hypothesisSeverity({ severity: "Critical", evidence: behavioural }, "none")).toBe("Minor");
  });

  it("takes the strongest across a merged finding", () => {
    expect(strongestSeverity(["Minor", null, "Important"])).toBe("Important");
    expect(strongestSeverity([null])).toBeNull();
  });
});

describe("stampDerivedSeverity — reconcile overwrites the adjudicator's severity", () => {
  const crossing: SurveyEvidence = { ...behavioural, crosses_boundary: true };

  function fixture(findings: unknown[]) {
    return workspace({
      hypotheses: { state: [{ evidence: behavioural }, { evidence: crossing }] },
      findings: { summary: "s", event: "COMMENT", findings },
    });
  }

  it("stamps the derived value, keeps the written one, and leaves provenance-less findings alone", () => {
    const { dir, root } = fixture([
      { title: "a", severity: "Important", hypotheses: ["state-001"] },
      { title: "b", severity: "Minor", hypotheses: ["state-001", "state-002"] },
      { title: "c", severity: "Important" },
      { title: "d", severity: "Critical", hypotheses: ["ghost-999"] },
    ]);
    const result = stampDerivedSeverity({ dir, repo: root });
    expect(result).toMatchObject({ findings: 4, derived: 2, changed: 2, skipped: null });
    const doc = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8")) as { findings: Record<string, unknown>[] };
    expect(doc.findings.map((f) => f.severity)).toEqual(["Minor", "Important", "Important", "Critical"]);
    expect(doc.findings.map((f) => f.declaredSeverity)).toEqual(["Important", "Minor", undefined, undefined]);
  });

  it("is idempotent", () => {
    const { dir, root } = fixture([{ title: "a", severity: "Important", hypotheses: ["state-001"] }]);
    stampDerivedSeverity({ dir, repo: root });
    const before = readFileSync(join(dir, "findings.json"), "utf8");
    expect(stampDerivedSeverity({ dir, repo: root }).changed).toBe(0);
    expect(readFileSync(join(dir, "findings.json"), "utf8")).toBe(before);
  });

  it("reports rather than throws on a missing or unreadable document", () => {
    const { dir, root } = workspace({ hypotheses: { state: [{ evidence: behavioural }] } });
    expect(stampDerivedSeverity({ dir, repo: root }).skipped).toMatch(/no findings\.json/);
    writeFileSync(join(dir, "findings.json"), "{ not json");
    expect(stampDerivedSeverity({ dir, repo: root }).skipped).not.toBeNull();
  });

  it("stamps rankEvidence from the cited hypotheses, and strips one the model wrote on an underivable finding", () => {
    const { dir, root } = fixture([
      { title: "a", hypotheses: ["state-001", "state-002", "state-002"] },
      { title: "c", severity: "Important", rankEvidence: { crossesBoundary: true, probe: "executed", hypotheses: 9 } },
    ]);
    stampDerivedSeverity({ dir, repo: root });
    const doc = JSON.parse(readFileSync(join(dir, "findings.json"), "utf8")) as { findings: Record<string, unknown>[] };
    expect(doc.findings[0]!.rankEvidence).toEqual({ crossesBoundary: true, probe: "none", hypotheses: 2 });
    expect(doc.findings[1]!.rankEvidence).toBeUndefined();
    expect(checkFindings({ dir, repo: root }).documentError).toBeNull();
  });

  it("rankEvidence counts execution, and skips a refuted constituent", () => {
    const { dir, root } = workspace({
      hypotheses: { state: [{ evidence: behavioural }, { evidence: { ...behavioural, crosses_boundary: true } }] },
      verdicts: [
        { hypothesis: "state-001", verdict: "reproduced", command: "node p.mjs", transcript: "probes/state-001.txt" },
        { hypothesis: "state-002", verdict: "refuted", command: "node q.mjs", transcript: "probes/state-002.txt" },
      ],
      transcripts: [
        ["state-001.txt", "node p.mjs\nDELETED foreign\n"],
        ["state-002.txt", "node q.mjs\nno effect\n"],
      ],
    });
    expect(buildSeverityIndex({ dir, repo: root }).rankEvidenceOf({ hypotheses: ["state-001", "state-002"] })).toEqual({
      crossesBoundary: false,
      probe: "executed",
      hypotheses: 1,
    });
  });

  it("reads the same probe record the gate does: an executed probe raises a local consequence", () => {
    const { dir, root } = workspace({
      hypotheses: { state: [{ evidence: behavioural }] },
      verdicts: [{ hypothesis: "state-001", verdict: "reproduced", command: "node p.mjs", transcript: "probes/state-001.txt" }],
      transcripts: [["state-001.txt", "node p.mjs\nDELETED foreign\n"]],
      findings: { summary: "s", event: "COMMENT", findings: [{ title: "a", hypotheses: ["state-001"] }] },
    });
    expect(buildSeverityIndex({ dir, repo: root }).ofFinding({ hypotheses: ["state-001"] })).toBe("Important");
    // …and the conservation gate still reads the stamped document.
    stampDerivedSeverity({ dir, repo: root });
    expect(checkFindings({ dir, repo: root }).documentError).toBeNull();
  });
});

/**
 * Tests for the pipeline-telemetry reader — deterministic and AI-free.
 *
 * The fixtures are **synthetic but shape-faithful**: every row form below was
 * copied from a real preserved workspace
 * (`~/lastlight-run-artifacts/2026-08-23_053348-…`) and then had its content
 * replaced. The real artifacts embed source excerpts from a private repository
 * and cannot be vendored here — the same reason
 * `nearform-evals`' `instances.json` is gitignored. What matters for this reader
 * is the shapes, and the shapes are exactly reproduced, heterogeneity included:
 *
 *  - the prescribed row (`discharge` + `failureScenario`),
 *  - the `spec` pass's invented `verdict` row, which carries no `id`, no
 *    `family` and no code at all — its renderer was unified only AFTER the last
 *    measured run, so this form is what every stored run actually contains,
 *  - the dead `tests` family's `{status: "notMeasured"}` line.
 *
 * A reader that only handled the prescribed form would silently report the other
 * two families as zero-hypothesis rather than as unmeasured, which is the exact
 * class of error this module exists to stop.
 */

import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { readPipelineStats, readPipelineArtifacts, internalJudgeInputs, withInternalRecall } from "./review-pipeline-stats.js";
import { boundaryMetrics, familyFunnels } from "./review-metrics.js";
import type { InstanceResult, ReviewPipelineStats } from "./schema.js";

const temps: string[] = [];
afterEach(() => {
  for (const t of temps.splice(0)) rmSync(t, { recursive: true, force: true });
});

/** Lay a synthetic `.lastlight/pr-review/` down and return the repo dir. */
function workspace(files: {
  obligations?: unknown;
  facts?: unknown;
  findings?: unknown;
  disposition?: unknown;
  hypotheses?: Record<string, unknown[]>;
}): string {
  const root = mkdtempSync(join(tmpdir(), "pipeline-stats-"));
  temps.push(root);
  const dir = join(root, ".lastlight", "pr-review");
  mkdirSync(dir, { recursive: true });
  const write = (name: string, value: unknown) => {
    if (value !== undefined) writeFileSync(join(dir, name), JSON.stringify(value, null, 2));
  };
  write("obligations.json", files.obligations);
  write("facts.json", files.facts);
  write("findings.json", files.findings);
  write("disposition.json", files.disposition);
  if (files.hypotheses) {
    mkdirSync(join(dir, "hypotheses"), { recursive: true });
    for (const [family, rows] of Object.entries(files.hypotheses)) {
      writeFileSync(join(dir, "hypotheses", `${family}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
    }
  }
  return root;
}

/** A run shaped like the measured one: clean discharges dominating the funnel. */
function measuredShape() {
  return workspace({
    obligations: {
      coverage: "degraded",
      degraded: [{ extractor: "tsgo", reason: "base view: 6 files are covered by no tsconfig" }],
      families: [
        { family: "enforcement", obligations: 2, measured: true, notMeasuredReason: null },
        { family: "state", obligations: 1, measured: true, notMeasuredReason: null },
        { family: "tests", obligations: 0, measured: false, notMeasuredReason: "no coverage artifact was read" },
      ],
      obligations: [{ family: "enforcement" }, { family: "enforcement" }, { family: "state" }],
      dropped: [{ reason: "over maxObligations", count: 4 }],
    },
    facts: { toolchain: { bundled: { typescript: "7.0.2" }, binaries: { opengrep: { resolved: "1.27.1", status: "ok" } } } },
    hypotheses: {
      // A defect claim and a clean discharge, from the same family.
      enforcement: [
        { id: "enforcement-001", obligation: "O-001", discharge: "ABSENT", family: "enforcement", failureScenario: "a scalar body 500s", confidence: 0.8 },
        { id: "enforcement-002", obligation: "O-002", discharge: "QUOTE", family: "enforcement", failureScenario: null, confidence: 1.0 },
      ],
      state: [{ id: "state-001", obligation: "O-003", discharge: "QUOTE", family: "state", failureScenario: null, confidence: 1.0 }],
      // The two forms a reader must not mistake for "no hypotheses".
      spec: [{ obligation: "S-1", path: "a.ts", line: 3, verdict: "implemented", rationale: "…" }],
      tests: [{ status: "notMeasured", claim: "no coverage artifact", reason: "prepare was skipped" }],
    },
    findings: {
      findings: [
        { title: "Defect", path: "a.ts", line: 1, family: "enforcement", confidence: 0.8, hypotheses: ["enforcement-001"] },
        { title: "Properly enforced", path: "b.ts", line: 2, family: "enforcement", confidence: 1.0, hypotheses: ["enforcement-002"] },
        { title: "Verified", path: "c.ts", line: 3, family: "state", confidence: 1.0, hypotheses: ["state-001"] },
        { title: "No provenance", path: "d.ts", line: 4, family: "spec", confidence: 0.9, hypotheses: [] },
      ],
    },
    disposition: {
      findings: [
        { tier: "inline", finding: { title: "Defect", path: "a.ts", line: 1 } },
        { tier: "body", finding: { title: "Properly enforced", path: "b.ts", line: 2 } },
        { tier: "body", finding: { title: "Verified", path: "c.ts", line: 3 } },
        { tier: "internal", finding: { title: "No provenance", path: "d.ts", line: 4 } },
      ],
    },
  });
}

describe("readPipelineStats", () => {
  it("returns undefined when no pipeline ran — a baseline arm is absent, not zero", () => {
    const root = mkdtempSync(join(tmpdir(), "pipeline-stats-"));
    temps.push(root);
    expect(readPipelineStats(root)).toBeUndefined();
  });

  it("counts obligations, hypotheses and the discharge histogram", () => {
    const r = readPipelineStats(measuredShape())!;
    expect(r.stats.obligations).toBe(3);
    expect(r.stats.obligationsDropped).toEqual([{ reason: "over maxObligations", count: 4 }]);
    // 2 enforcement + 1 state + 1 spec + 1 tests — the heterogeneous rows count.
    expect(r.stats.hypotheses).toBe(5);
    expect(r.stats.dischargeCodes).toEqual({ QUOTE: 2, ABSENT: 1, "bad-code": 1, none: 1 });
  });

  it("separates an INVENTED code from no code at all", () => {
    // `checkDischarge` reports `bad-code` and `no-code` as different statuses
    // because they are different failures. Measured across the 447 preserved
    // minimal-contract rows: 74 carried a string and only 43 were one of the
    // four — the rest invented `N/A` (x11), `enforced` (x6), and six more.
    // Folding those into `none` reports "the models did not answer" when what
    // happened is "the models answered off-vocabulary".
    const root = workspace({
      hypotheses: {
        state: [
          { discharge: "N/A" },
          { discharge: "enforced" },
          { status: "quote", failureScenario: null }, // lower case IS one of the four
          { claim: "no field at all" },
          { discharge: "   " }, // whitespace is not an answer
        ],
      },
    });
    const r = readPipelineArtifacts(join(root, ".lastlight", "pr-review"))!;
    expect(r.stats.dischargeCodes).toEqual({ "bad-code": 2, QUOTE: 1, none: 2 });
    expect(r.stats.cleanDischarges).toBe(1);
  });

  it("buckets an unrecognised or absent code as `none` rather than dropping the row", () => {
    // The failure this guards: 0-of-every-obligation carried a code on both
    // preserved runs, and a histogram without the empty bucket would have made
    // an inexpressible contract look like an unenthusiastic one.
    const r = readPipelineStats(measuredShape())!;
    const codes = r.stats.dischargeCodes!;
    expect(Object.values(codes).reduce((a, b) => a + b, 0)).toBe(r.stats.hypotheses);
  });

  it("counts a clean QUOTE separately from a QUOTE that raises a defect", () => {
    const r = readPipelineStats(measuredShape())!;
    expect(r.stats.dischargeCodes!.QUOTE).toBe(2);
    expect(r.stats.cleanDischarges).toBe(2);
    const clean = r.findings.filter((f) => f.cleanDischarge).map((f) => f.title);
    expect(clean).toEqual(["Properly enforced", "Verified"]);
  });

  it("requires failureScenario PRESENT and null — an absent key is not a clean discharge", () => {
    // The strictness is what keeps the instrument agreeing with the attention
    // boundary, which keys on the same predicate. Under the pre-2026-08-23
    // contract the field did not exist, and the `spec` pass's row shape has
    // nowhere to record one: 37 rows across the preserved minimal-era runs are
    // QUOTE with no key. Reading absence as "clean" marks those as anti-findings
    // on the strength of a field nobody asked for.
    const root = workspace({
      hypotheses: {
        enforcement: [
          { id: "enforcement-001", discharge: "QUOTE", failureScenario: null }, // clean
          { id: "enforcement-002", discharge: "QUOTE" }, // key absent — NOT clean
          { id: "enforcement-003", discharge: "QUOTE", failureScenario: "a scalar body 500s" }, // a defect
        ],
      },
    });
    const r = readPipelineArtifacts(join(root, ".lastlight", "pr-review"))!;
    expect(r.stats.dischargeCodes).toEqual({ QUOTE: 3 });
    expect(r.stats.cleanDischarges).toBe(1);
  });

  it("resolves a citation by canonical id, and a declared id only as an unambiguous alias", () => {
    // Identity is the file's name plus append order — `code-facts` assigns it at
    // ingest precisely because model-minted ids collided across families. A
    // declared id that SHADOWS a canonical one must not capture its citations.
    const root = workspace({
      hypotheses: {
        state: [
          { id: "state-002", discharge: "QUOTE", failureScenario: "real defect" }, // canonical state-001, shadows state-002
          { id: "H-7", discharge: "QUOTE", failureScenario: null }, // canonical state-002, alias H-7
        ],
      },
      findings: {
        findings: [
          { title: "By canonical", path: "a.ts", family: "state", hypotheses: ["state-002"] },
          { title: "By alias", path: "b.ts", family: "state", hypotheses: ["H-7"] },
          { title: "By nothing", path: "c.ts", family: "state", hypotheses: ["state-999"] },
        ],
      },
    });
    const r = readPipelineArtifacts(join(root, ".lastlight", "pr-review"))!;
    const by = (t: string) => r.findings.find((f) => f.title === t)!.cleanDischarge;
    // `state-002` is canonical for the SECOND row (the clean one), and the first
    // row's shadowing declaration does not steal it.
    expect(by("By canonical")).toBe(true);
    expect(by("By alias")).toBe(true);
    expect(by("By nothing")).toBe(false);
  });

  it("skips an unparseable line WITHOUT consuming its ordinal, as code-facts does", () => {
    // A drifted ordinal mis-resolves every later citation rather than missing
    // one, so this must match `readJsonlRows` exactly.
    const root = workspace({ hypotheses: { state: [] } });
    const path = join(root, ".lastlight", "pr-review", "hypotheses", "state.jsonl");
    writeFileSync(path, ['{"discharge":"ABSENT","failureScenario":"x"}', "{tor", '{"discharge":"QUOTE","failureScenario":null}'].join("\n"));
    const r = readPipelineArtifacts(join(root, ".lastlight", "pr-review"))!;
    expect(r.stats.hypotheses).toBe(2);
    // The clean row is the SECOND parsed row ⇒ canonical `state-002`.
    expect(r.stats.cleanDischarges).toBe(1);
  });

  it("does not call an unprovenanced finding clean — absent provenance is not innocence", () => {
    const r = readPipelineStats(measuredShape())!;
    expect(r.stats.unprovenanced).toBe(1);
    expect(r.findings.find((f) => f.title === "No provenance")!.cleanDischarge).toBe(false);
  });

  it("takes the family from the FILENAME, so a mislabelled row cannot move another funnel", () => {
    const root = workspace({
      hypotheses: { state: [{ id: "x-1", family: "enforcement", discharge: "QUOTE", failureScenario: null }] },
    });
    const r = readPipelineStats(root)!;
    expect(r.stats.byFamily!.state.hypotheses).toBe(1);
    expect(r.stats.byFamily!.enforcement).toBeUndefined();
  });

  it("joins a finding to its tier even though the boundary re-anchored the line", () => {
    // Real property of the artifacts: the boundary moves a finding to a line
    // GitHub can hang a comment on, so `APIContext.tsx:1042` in findings.json is
    // `:1063` in disposition.json. Keying the join on the line silently failed
    // to join 10 of 32 findings on the measured case — and an unjoined finding
    // is indistinguishable from one that was never tiered.
    const root = workspace({
      findings: { findings: [{ title: "Type contract", path: "a.ts", line: 1042, hypotheses: ["h-1"] }] },
      disposition: { findings: [{ tier: "body", finding: { title: "Type contract", path: "a.ts", line: 1063 } }] },
    });
    const r = readPipelineArtifacts(join(root, ".lastlight", "pr-review"))!;
    expect(r.findings[0].tier).toBe("body");
  });

  it("counts tiers from disposition.json itself, so a failed join cannot under-report them", () => {
    const root = workspace({
      findings: { findings: [{ title: "Renamed downstream", path: "a.ts", hypotheses: [] }] },
      disposition: { findings: [{ tier: "internal", finding: { title: "A different title entirely", path: "b.ts" } }] },
    });
    const r = readPipelineArtifacts(join(root, ".lastlight", "pr-review"))!;
    expect(r.stats.tiers).toEqual({ internal: 1 });
    expect(r.findings[0].tier).toBeUndefined();
  });

  it("records tiers, conservation and coverage", () => {
    const r = readPipelineStats(measuredShape())!;
    expect(r.stats.tiers).toEqual({ inline: 1, body: 2, internal: 1 });
    expect(r.stats.inlinePosted).toBe(1);
    // Three hypotheses carry ids and all three reached a finding; the spec and
    // tests rows have no id to conserve.
    expect(r.stats.discharged).toBe(3);
    expect(r.stats.coverage).toBe("degraded");
    expect(r.stats.degraded![0]).toMatch(/^tsgo: base view/);
    expect(r.stats.toolchain).toEqual({ typescript: "7.0.2", opengrep: "1.27.1 (ok)" });
  });

  it("marks a family unmeasured rather than reporting it as zero-converting", () => {
    const r = readPipelineStats(measuredShape())!;
    expect(r.stats.byFamily!.tests.notMeasured).toBe(true);
    expect(r.stats.byFamily!.tests.obligations).toBe(0);
  });

  it("survives a torn final line without losing the rows before it", () => {
    const root = workspace({ hypotheses: { state: [{ id: "state-001", discharge: "QUOTE" }] } });
    const path = join(root, ".lastlight", "pr-review", "hypotheses", "state.jsonl");
    writeFileSync(path, `{"id":"state-001","discharge":"QUOTE"}\n{"id":"state-002","dis`);
    expect(readPipelineStats(root)!.stats.hypotheses).toBe(1);
  });
});

describe("withInternalRecall", () => {
  it("attributes a match back to its family and tier", () => {
    const readout = readPipelineStats(measuredShape())!;
    // Gold 0 matched the inline enforcement defect; gold 1 matched nothing.
    const stats = withInternalRecall(readout, { goldToFinding: [0, null], matched: 1 });
    expect(stats.internalMatched).toBe(1);
    expect(stats.inlineMatched).toBe(1);
    expect(stats.byFamily!.enforcement.matched).toBe(1);
    expect(stats.byFamily!.state.matched).toBeUndefined();
  });

  it("counts a match on a WITHHELD finding as discovery, not as contribution", () => {
    // Finding index 3 is the unprovenanced `spec` one, tiered `internal`. The
    // family found it and the boundary withheld it: `internalMatched` must see
    // that and `matched` must not, or a family whose findings are all held back
    // reads as if it had contributed them.
    const readout = readPipelineStats(measuredShape())!;
    const stats = withInternalRecall(readout, { goldToFinding: [3], matched: 1 });
    expect(stats.byFamily!.spec.internalMatched).toBe(1);
    expect(stats.byFamily!.spec.matched).toBeUndefined();
    expect(stats.byFamily!.spec.posted).toBeUndefined();
    expect(stats.internalMatched).toBe(1);
    expect(stats.inlineMatched).toBe(0);
  });

  it("leaves internalMatched ABSENT when the judge failed", () => {
    const readout = readPipelineStats(measuredShape())!;
    const stats = withInternalRecall(readout, { goldToFinding: [null], matched: 0, error: "judge: unparseable" });
    expect(stats.internalMatched).toBeUndefined();
    expect(stats.internalUngraded).toBe("judge: unparseable");
  });

  it("does not mutate the readout it was given", () => {
    const readout = readPipelineStats(measuredShape())!;
    withInternalRecall(readout, { goldToFinding: [0], matched: 1 });
    expect(readout.stats.byFamily!.enforcement.matched).toBeUndefined();
  });

  it("sends the judge title AND body, because the mechanism lives in the body", () => {
    const readout = readPipelineStats(measuredShape())!;
    const inputs = internalJudgeInputs([{ ...readout.findings[0], body: "the guard cannot tell truncation from exhaustion" }]);
    expect(inputs[0].description).toBe("Defect — the guard cannot tell truncation from exhaustion");
    expect(inputs[0].file).toBe("a.ts");
  });
});

describe("the metrics this finally unblocks", () => {
  /** The two roll-ups have filtered for `review.pipeline` since they were
   * written and have never seen one. This is the regression test for that. */
  const resultWith = (pipeline: ReviewPipelineStats): InstanceResult[] => [
    {
      instance_id: "case-1",
      model: "m",
      tier: "pr-review",
      workflowSucceeded: true,
      review: {
        precision: 0.5, recall: 0.5, fbeta: 0.5, beta: 1,
        posted: 2, gold: 2, matched: 1, falsePositives: [], falseNegatives: [],
        pipeline,
      },
      inputTokens: 0, cachedTokens: 0, outputTokens: 0, costUsd: 0, durationMs: 0, phases: [],
    },
  ];

  it("boundaryMetrics reports internal recall above posted recall when the boundary held gold back", () => {
    const readout = readPipelineStats(measuredShape())!;
    const stats = withInternalRecall(readout, { goldToFinding: [0, 3], matched: 2 });
    const b = boundaryMetrics(resultWith(stats))!;
    // Posted recall is 1 of 2; the pipeline KNEW about both.
    expect(b.internalRecall).toBe(1);
    expect(b.internalCount).toBe(1);
  });

  it("familyFunnels returns a populated funnel instead of undefined", () => {
    const readout = readPipelineStats(measuredShape())!;
    const funnels = familyFunnels(resultWith(withInternalRecall(readout, { goldToFinding: [0, null], matched: 1 })))!;
    const enforcement = funnels.find((f) => f.family === "enforcement")!;
    expect(enforcement).toMatchObject({ obligations: 2, hypotheses: 2, posted: 2, matched: 1 });
    expect(funnels.find((f) => f.family === "tests")!.notMeasured).toBe(true);
  });

  it("leaves `posted` absent for every family when no disposition was written", () => {
    // Measured: `1587-r3` in keeper run 1 wrote no `disposition.json` at all,
    // while posting nine findings. Filling `posted` from the finding count there
    // would invent a boundary decision nobody made.
    const root = workspace({
      obligations: { families: [{ family: "state", obligations: 1, measured: true }] },
      hypotheses: { state: [{ id: "state-001", discharge: "ABSENT", failureScenario: "boom" }] },
      findings: { findings: [{ title: "A finding", path: "a.ts", family: "state", hypotheses: ["state-001"] }] },
    });
    const r = readPipelineArtifacts(join(root, ".lastlight", "pr-review"))!;
    expect(r.stats.tiers).toBeUndefined();
    expect(r.stats.byFamily!.state.posted).toBeUndefined();
    expect(r.stats.byFamily!.state.hypotheses).toBe(1);
  });
});

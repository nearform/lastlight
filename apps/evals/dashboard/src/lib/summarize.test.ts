import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

// The harness's OWN roll-up, in the same process. This is the whole point of the
// file: the dashboard cannot import it at runtime (it lives in a module that
// reads the filesystem), so the only defence against the copy drifting is to run
// both here and compare.
import { summarizeModels as harnessSummarizeModels } from "../../../src/report.js";
import type { InstanceResult, Scorecard } from "../types";
import { summarizeModels } from "./summarize";

const here = dirname(fileURLToPath(import.meta.url));
const sample = (rel: string): Scorecard =>
  JSON.parse(readFileSync(join(here, "../../../sample-results", rel), "utf8")) as Scorecard;

/** Real, checked-in scorecards — one per tier, so the comparison covers the
 * code-fix, behavioral and review branches rather than a hand-made shape. */
const SAMPLES = [
  "pr-review/2026-07-05_095214-f2cc826/scorecard.json",
  "triage/2026-06-29_160025-74bc10e/scorecard.json",
  "code-fix/2026-06-30_075413-6c791c8/scorecard.json",
];

describe("client summarizeModels agrees with the harness", () => {
  for (const rel of SAMPLES) {
    it(`matches field-for-field on ${rel.split("/")[0]}`, () => {
      const results = sample(rel).results;
      expect(results.length).toBeGreaterThan(0);
      // Deep equality across EVERY field, so a field the harness gains and the
      // client does not is a failing test rather than a number silently missing
      // from the UI — which is exactly how `micro` went unrendered for the whole
      // life of the field.
      expect(summarizeModels(results)).toEqual(harnessSummarizeModels(results));
    });
  }

  it("matches on results carrying an evidence packet (boundaries + families)", () => {
    const results = withPipeline();
    const mine = summarizeModels(results);
    expect(mine).toEqual(harnessSummarizeModels(results));
    // Guard the fields the old mirror dropped entirely.
    expect(mine[0].boundaries).toBeDefined();
    expect(mine[0].families?.map((f) => f.family)).toEqual(["contract", "security"]);
  });

  it("has no field the harness lacks, and vice versa", () => {
    const results = sample(SAMPLES[0]).results;
    const mine = Object.keys(summarizeModels(results)[0]).sort();
    const theirs = Object.keys(harnessSummarizeModels(results)[0]).sort();
    expect(mine).toEqual(theirs);
  });
});

describe("micro on scorecards that predate the field", () => {
  it("recomputes micro-recall from posted/gold/matched", () => {
    const card = sample(SAMPLES[0]);
    // The checked-in sample was written before `micro` existed — the point of
    // recomputing rather than reading `card.models[].micro` is that this whole
    // corpus still renders.
    expect(card.models[0].micro).toBeUndefined();

    const micro = summarizeModels(card.results)[0].micro!;
    expect(micro).toBeDefined();

    const graded = card.results.filter((r) => r.review && !r.error);
    const sum = (f: (r: InstanceResult) => number) => graded.reduce((s, r) => s + f(r), 0);
    expect(micro.gold).toBe(sum((r) => r.review!.gold));
    expect(micro.matched).toBe(sum((r) => r.review!.matched));
    expect(micro.posted).toBe(sum((r) => r.review!.posted));
    expect(micro.microRecall).toBeCloseTo(micro.matched / micro.gold, 12);
  });

  it("is not the mean of per-case recalls", () => {
    // The distinction the whole change is about: the mean weights a 1-gold case
    // like a 6-gold one. If these ever coincide the sample stopped exercising it.
    const summary = summarizeModels(sample(SAMPLES[0]).results)[0];
    expect(summary.micro!.microRecall).not.toBeCloseTo(summary.avgRecall, 6);
  });
});

/** A two-case arm that emitted an evidence packet, so `boundaries`/`families`
 * are exercised. Nothing in `sample-results/` carries one yet. */
function withPipeline(): InstanceResult[] {
  const base = {
    model: "arm-a",
    tier: "pr-review",
    workflowSucceeded: true,
    phases: [],
    inputTokens: 10,
    cachedTokens: 0,
    outputTokens: 5,
    costUsd: 0.01,
    durationMs: 1000,
  };
  return [
    {
      ...base,
      instance_id: "case-1",
      review: {
        precision: 0.5,
        recall: 0.5,
        fbeta: 0.5,
        beta: 1,
        posted: 4,
        gold: 4,
        matched: 2,
        falsePositives: [],
        falseNegatives: [],
        pipeline: {
          obligations: 12,
          hypotheses: 9,
          discharged: 9,
          tiers: { inline: 2, body: 2, internal: 3 },
          internalMatched: 3,
          inlinePosted: 2,
          inlineMatched: 1,
          byFamily: {
            contract: { obligations: 7, hypotheses: 5, posted: 3, matched: 2 },
            security: { obligations: 5, hypotheses: 4, posted: 1, matched: 0, notMeasured: true },
          },
        },
      },
    },
    {
      ...base,
      instance_id: "case-2",
      review: {
        precision: 0,
        recall: 0,
        fbeta: 0,
        beta: 1,
        posted: 3,
        gold: 2,
        matched: 0,
        falsePositives: [],
        falseNegatives: [],
        pipeline: {
          obligations: 4,
          hypotheses: 3,
          discharged: 3,
          tiers: { inline: 1, body: 2, internal: 1 },
          internalMatched: 0,
          inlinePosted: 1,
          inlineMatched: 0,
          byFamily: {
            contract: { obligations: 4, hypotheses: 3, posted: 3, matched: 0 },
          },
        },
      },
    },
  ] as InstanceResult[];
}

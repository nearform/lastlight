/**
 * `scripts/backfill-pipeline.ts --no-judge` — refreshing the free half without
 * destroying the paid one.
 *
 * The mechanism half of `review.pipeline` is a pure function of artifacts on
 * disk, so it goes stale whenever `readPipelineArtifacts` learns something (on
 * 2026-08-23: a clean discharge now needs `failureScenario` PRESENT and `null`,
 * and citations resolve through the canonical `<family>-NNN` identity). The
 * judge half — `internalMatched`, `inlineMatched`, and the per-family `matched` /
 * `internalMatched` — cost ~$0.66 of MATCH calls and cannot be recomputed from a
 * scorecard at all: `withInternalRecall` needs the judge's `goldToFinding` reply,
 * which nothing stores.
 *
 * So the ONLY failure mode worth a test is the asymmetric one: the refresh
 * quietly dropping, zeroing, or inventing a judged number. Every case below is a
 * shape that has a plausible way of doing exactly that.
 *
 * The end-to-end case runs the script as a real subprocess over a temp scorecard
 * and temp artifacts, with `--write`, and asserts the file on disk. That is the
 * only way to prove the mode makes no judge call — it needs no provider key, and
 * the spending branch is unreachable behind the early return.
 */
import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { summarizeModels, type Scorecard } from "../src/report.js";
import type { InstanceResult, ReviewPipelineStats } from "../src/schema.js";
import { judgedHalf, mergePreservedJudgement, parseArgs } from "./backfill-pipeline.js";

const here = dirname(fileURLToPath(import.meta.url));

/** A mechanism-only readout — exactly the shape `readPipelineArtifacts` returns:
 * every judged field absent, because it has no way to know one. */
const fresh: ReviewPipelineStats = {
  obligations: 33,
  hypotheses: 46,
  discharged: 46,
  dischargeCodes: { QUOTE: 30, ABSENT: 7, PARTIAL: 4, none: 5 },
  cleanDischarges: 23, // the aligned reader; the stored card says 30
  unprovenanced: 1,
  tiers: { inline: 3, body: 4, internal: 9 },
  inlinePosted: 3,
  byFamily: { contract: { obligations: 5, hypotheses: 12, posted: 3 }, state: { obligations: 4, hypotheses: 9 } },
  coverage: "degraded",
};

/** What the paid back-fill left on the scorecard: the same mechanism fields at
 * their pre-alignment values, plus the judge's columns. */
const stored: ReviewPipelineStats = {
  ...fresh,
  cleanDischarges: 30,
  byFamily: {
    contract: { obligations: 5, hypotheses: 12, posted: 3, matched: 2, internalMatched: 3 },
    state: { obligations: 4, hypotheses: 9, internalMatched: 1 },
  },
  internalMatched: 4,
  inlineMatched: 1,
};

describe("mergePreservedJudgement — the mechanism half moves, the judged half does not", () => {
  const merged = mergePreservedJudgement(fresh, stored);

  it("takes every mechanism field from the fresh read", () => {
    expect(merged.cleanDischarges).toBe(23);
    expect(merged.dischargeCodes).toEqual({ QUOTE: 30, ABSENT: 7, PARTIAL: 4, none: 5 });
    expect(merged.obligations).toBe(33);
    expect(merged.unprovenanced).toBe(1);
    expect(merged.tiers).toEqual({ inline: 3, body: 4, internal: 9 });
    expect(merged.coverage).toBe("degraded");
  });

  it("carries the judged fields across untouched", () => {
    expect(merged.internalMatched).toBe(4);
    expect(merged.inlineMatched).toBe(1);
    expect(judgedHalf(merged)).toBe(judgedHalf(stored));
  });

  it("keeps each family's judged columns while refreshing its mechanism ones", () => {
    // `posted` is a mechanism number and comes from the read; `matched` and
    // `internalMatched` are the judge's attribution and are carried.
    expect(merged.byFamily).toEqual({
      contract: { obligations: 5, hypotheses: 12, posted: 3, matched: 2, internalMatched: 3 },
      state: { obligations: 4, hypotheses: 9, internalMatched: 1 },
    });
  });

  it("does not mutate either input", () => {
    expect(stored.cleanDischarges).toBe(30);
    expect(fresh.byFamily!.contract.matched).toBeUndefined();
  });
});

describe("mergePreservedJudgement — what it must refuse to invent", () => {
  it("gives a never-judged case no internal recall at all", () => {
    const merged = mergePreservedJudgement(fresh, undefined);
    expect(merged).toBe(fresh);
    expect(merged.internalMatched).toBeUndefined();
    expect(merged.inlineMatched).toBeUndefined();
  });

  it("does not fabricate a recall for a case whose stored stats are mechanism-only", () => {
    // The state of every case the paid back-fill SKIPPED (no gold, no findings).
    const merged = mergePreservedJudgement(fresh, { ...fresh, cleanDischarges: 30 });
    expect(merged.internalMatched).toBeUndefined();
    expect("internalMatched" in merged).toBe(false);
    expect(merged.cleanDischarges).toBe(23);
  });

  it("keeps a stored internalUngraded, and leaves internalMatched absent beside it", () => {
    // A judge outage and a pipeline that found nothing produce the same 0. The
    // distinction only survives if the string is carried and no number appears.
    const merged = mergePreservedJudgement(fresh, { ...fresh, internalUngraded: "judge reply did not parse" });
    expect(merged.internalUngraded).toBe("judge reply did not parse");
    expect("internalMatched" in merged).toBe(false);
  });

  it("keeps a judged-only family the fresh read no longer knows about", () => {
    // `withInternalRecall` mints a family row for a matched finding whose family
    // has no obligations and no hypotheses file, so `prev` can legitimately carry
    // a family `fresh` does not. Dropping it would lose a match.
    const merged = mergePreservedJudgement(fresh, {
      ...stored,
      byFamily: { ...stored.byFamily, ghost: { internalMatched: 2 } },
    });
    expect(merged.byFamily!.ghost).toEqual({ internalMatched: 2 });
  });

  it("keeps `probes`, which no artifact records and a re-read would therefore delete", () => {
    const probes = { attempted: 3, succeeded: 2, reproduced: 1, refuted: 1 };
    expect(mergePreservedJudgement(fresh, { ...stored, probes }).probes).toEqual(probes);
  });
});

describe("judgedHalf — the assertion the write is gated on", () => {
  it("ignores family key ORDER, which the merge legitimately changes", () => {
    // The merge rebuilds `byFamily` from the fresh read, so `matched` and
    // `internalMatched` come out in a different key order than the stored card
    // had them. That is a re-serialisation, not a measurement moving — and a
    // naive JSON.stringify comparison would refuse every write over it.
    const a: ReviewPipelineStats = { byFamily: { b: { internalMatched: 1, matched: 1 }, a: { matched: 2 } } };
    const b: ReviewPipelineStats = { byFamily: { a: { matched: 2 }, b: { matched: 1, internalMatched: 1 } } };
    expect(judgedHalf(a)).toBe(judgedHalf(b));
  });

  it("ignores the mechanism fields entirely", () => {
    expect(judgedHalf(stored)).toBe(judgedHalf({ ...stored, cleanDischarges: 0, obligations: 999 }));
  });

  it("notices a judged number that moved, in either place", () => {
    expect(judgedHalf({ ...stored, internalMatched: 3 })).not.toBe(judgedHalf(stored));
    expect(judgedHalf({ ...stored, inlineMatched: 0 })).not.toBe(judgedHalf(stored));
    expect(
      judgedHalf({ ...stored, byFamily: { ...stored.byFamily, contract: { obligations: 5, matched: 2 } } }),
    ).not.toBe(judgedHalf(stored));
  });

  it("distinguishes an absent judged number from a zero", () => {
    expect(judgedHalf({ ...fresh, internalMatched: 0 })).not.toBe(judgedHalf(fresh));
  });
});

describe("parseArgs", () => {
  it("recognises --no-judge and defaults it off", () => {
    expect(parseArgs(["/a", "--results", "/r"]).noJudge).toBe(false);
    expect(parseArgs(["/a", "--results", "/r", "--no-judge"]).noJudge).toBe(true);
  });

  it("still parses the spending flags beside it", () => {
    const a = parseArgs(["/a", "--results", "/r", "--no-judge", "--write"]);
    expect(a.noJudge).toBe(true);
    expect(a.write).toBe(true);
    expect(a.artifacts).toEqual(["/a"]);
  });
});

// ── End to end, through the real script ─────────────────────────────────────

const STAMP = "2026-08-23_055425";
const INSTANCE = "prreview__case-1";
const ARM = "anthropic/claude-haiku-4-5-20251001";

/** A preserved archive: `<root>/<instance>/pr-review/`, no `.lastlight` level.
 * Two `QUOTE` rows, one with `failureScenario: null` (a clean discharge) and one
 * with the key absent (the minimal-era shape — NOT clean). */
function writeArtifacts(root: string): void {
  const dir = join(root, INSTANCE, "pr-review");
  mkdirSync(join(dir, "hypotheses"), { recursive: true });
  writeFileSync(
    join(dir, "obligations.json"),
    JSON.stringify({ coverage: "degraded", families: [{ family: "contract", obligations: 2 }], obligations: [{ family: "contract" }, { family: "contract" }] }),
  );
  writeFileSync(
    join(dir, "hypotheses", "contract.jsonl"),
    [
      JSON.stringify({ discharge: "QUOTE", failureScenario: null }),
      JSON.stringify({ discharge: "QUOTE" }),
      JSON.stringify({ discharge: "ABSENT", failureScenario: "boom" }),
    ].join("\n"),
  );
  writeFileSync(
    join(dir, "findings.json"),
    JSON.stringify({ findings: [{ title: "t1", path: "a.ts", family: "contract", hypotheses: ["contract-003"] }] }),
  );
  writeFileSync(
    join(dir, "disposition.json"),
    JSON.stringify({ findings: [{ tier: "inline", finding: { title: "t1", path: "a.ts" } }] }),
  );
}

/** A scorecard as the PAID back-fill left it: mechanism numbers from the old
 * reader (`cleanDischarges: 2` — it counted the key-less QUOTE) plus the judge's
 * columns. */
function writeScorecardFixture(resultsRoot: string): string {
  const result: InstanceResult = {
    instance_id: INSTANCE,
    model: ARM,
    tier: "pr-review",
    workflowSucceeded: true,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: 0,
    phases: [],
    review: {
      precision: 0.5,
      recall: 0.5,
      fbeta: 0.5,
      beta: 1,
      posted: 2,
      gold: 2,
      matched: 1,
      falsePositives: [],
      falseNegatives: [{ description: "missed thing", file: "a.ts", severity: "major" }],
      pipeline: {
        obligations: 2,
        hypotheses: 3,
        discharged: 1,
        dischargeCodes: { QUOTE: 2, ABSENT: 1 },
        cleanDischarges: 2,
        unprovenanced: 0,
        tiers: { inline: 1 },
        inlinePosted: 1,
        byFamily: { contract: { obligations: 2, hypotheses: 3, posted: 1, internalMatched: 2, matched: 2 } },
        coverage: "degraded",
        internalMatched: 2,
        inlineMatched: 2,
      },
    },
  };
  const card: Scorecard = { models: summarizeModels([result]), results: [result], meta: { runId: `${STAMP}-abc1234` } as Scorecard["meta"] };
  const runDir = join(resultsRoot, `${STAMP}-abc1234`);
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, "scorecard.json");
  writeFileSync(path, JSON.stringify(card, null, 2));
  return path;
}

describe("--no-judge --write, end to end through the script", () => {
  const tmp = mkdtempSync(join(tmpdir(), "backfill-nojudge-"));
  const artifactRoot = join(tmp, `${STAMP}-wp3-rep1`);
  const resultsRoot = join(tmp, "eval-results", "pr-review");
  writeArtifacts(artifactRoot);
  const scorecardPath = writeScorecardFixture(resultsRoot);
  const before = readFileSync(scorecardPath, "utf8");

  const stdout = execFileSync(
    "npx",
    ["tsx", join(here, "backfill-pipeline.ts"), artifactRoot, "--results", resultsRoot, "--no-judge", "--write"],
    {
      cwd: join(here, ".."),
      encoding: "utf8",
      // No provider key: the mode must never reach `defaultJudgeModel()`, and a
      // key inherited from the dev's shell would hide it if it did.
      env: { ...process.env, ANTHROPIC_API_KEY: "", OPENAI_API_KEY: "", FIREWORKS_API_KEY: "", OPENROUTER_API_KEY: "", EVAL_JUDGE_MODEL: "" },
    },
  );
  const after = JSON.parse(readFileSync(scorecardPath, "utf8")) as Scorecard;
  const pipeline = after.results[0].review!.pipeline!;

  it("announces zero judge calls and no estimate to consent to", () => {
    expect(stdout).toContain("MECHANISM ONLY");
    expect(stdout).not.toContain("est. cost");
    expect(stdout).not.toContain("Proceed?");
  });

  it("refreshes cleanDischarges to the aligned reader's answer", () => {
    // 2 QUOTE rows, only one with `failureScenario` present and null.
    expect(JSON.parse(before).results[0].review.pipeline.cleanDischarges).toBe(2);
    expect(pipeline.cleanDischarges).toBe(1);
  });

  it("preserves the judged half byte for byte", () => {
    expect(pipeline.internalMatched).toBe(2);
    expect(pipeline.inlineMatched).toBe(2);
    expect(pipeline.byFamily!.contract.matched).toBe(2);
    expect(pipeline.byFamily!.contract.internalMatched).toBe(2);
    expect(stdout).toContain("preserved byte-for-byte");
  });

  it("leaves every published number, and everything outside review.pipeline, untouched", () => {
    const strip = (raw: string): string => {
      const card = JSON.parse(raw) as Scorecard;
      for (const r of card.results) delete r.review?.pipeline;
      return JSON.stringify(card);
    };
    expect(strip(readFileSync(scorecardPath, "utf8"))).toBe(strip(before));
  });

  it("is read-only without --write", () => {
    const snapshot = readFileSync(scorecardPath, "utf8");
    execFileSync("npx", ["tsx", join(here, "backfill-pipeline.ts"), artifactRoot, "--results", resultsRoot, "--no-judge"], {
      cwd: join(here, ".."),
      encoding: "utf8",
    });
    expect(readFileSync(scorecardPath, "utf8")).toBe(snapshot);
  });
}, 120_000);

/**
 * `scripts/band.ts` — the headless repeat band.
 *
 * The band ARITHMETIC belongs to `varianceRollup` and is tested in
 * `src/review-metrics.test.ts`; what is tested here is everything this script
 * adds on top of it, all of which is a way to get a number WRONG rather than a
 * number:
 *
 *  - the arm→run mapping (which cards, which arm, which tier) — the input that
 *    must never be inferred, because the preserved runs cannot be told apart by
 *    any field a heuristic could key on;
 *  - the audit that reports what the scorecards do and do not corroborate;
 *  - `--vs` as a separator rather than a one-value flag.
 *
 * The end-to-end assertion runs over `dashboard/src/__fixtures__/repeat-group.json`
 * — the REAL 2026-08-22 three-run group with the gold text redacted — so the
 * published 0.320/0.080/0.200 → band 0.240, union 11/25, intersection 1/25 is
 * pinned inside the repo's own gate, not only against a workspace on one laptop.
 */
import { describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { varianceRollup } from "../src/review-metrics.js";
import type { Scorecard } from "../src/report.js";
import type { InstanceResult } from "../src/schema.js";
import { armCard, auditArm, goldDescriptions, parseArgs, pickArm, resolveScorecardPath, type LoadedCard } from "./band.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(
  readFileSync(join(here, "..", "dashboard", "src", "__fixtures__", "repeat-group.json"), "utf8"),
) as Scorecard[];

const ARM = "anthropic/claude-haiku-4-5-20251001";
const loaded = (cards: Scorecard[]): LoadedCard[] => cards.map((card, i) => ({ path: `card-${i}`, card }));

describe("the preserved three-run group, end to end through band.ts", () => {
  const cards = loaded(fixture);
  const arm = pickArm(fixture, undefined, "first");
  const audit = auditArm(cards, arm, "pr-review");
  const roll = varianceRollup(audit.ordered.map((l) => armCard(l.card, arm, "pr-review")));

  it("infers the sole arm without a --model flag", () => {
    expect(arm).toBe(ARM);
  });

  it("reproduces each repeat's published micro-recall, labelled by its own runId", () => {
    expect(roll.repeats.map((r) => r.runId)).toEqual([
      "2026-08-22_184650-00cc469",
      "2026-08-22_194234-00cc469",
      "2026-08-22_201607-64862d5",
    ]);
    expect(roll.repeats.map((r) => r.microRecall)).toEqual([0.32, 0.08, 0.2]);
    expect(roll.repeats.map((r) => r.matched)).toEqual([8, 2, 5]);
    expect(roll.repeats.map((r) => r.posted)).toEqual([47, 23, 44]);
  });

  it("is a band of 0.240 around a mean of 0.200", () => {
    expect(roll.meanMicroRecall).toBeCloseTo(0.2, 10);
    expect(roll.minMicroRecall).toBeCloseTo(0.08, 10);
    expect(roll.maxMicroRecall).toBeCloseTo(0.32, 10);
    expect(roll.band).toBeCloseTo(0.24, 10);
  });

  it("union 11/25 = 0.440, intersection 1/25 = 0.040 — the numbers that matter", () => {
    expect(roll.gold).toBe(25);
    expect(roll.unionMatched).toBe(11);
    expect(roll.unionRecall).toBeCloseTo(0.44, 10);
    expect(roll.intersectionMatched).toBe(1);
    expect(roll.intersectionRecall).toBeCloseTo(0.04, 10);
  });

  it("names the case it could not align instead of folding it in as misses", () => {
    // The empty-gold precision canary carries no judge trace in two of the three
    // repeats. It contributes no gold either way, but it must still be NAMED —
    // "excluded" and "found nothing" are different facts.
    expect(roll.untraced).toEqual(["prreview__skillspro-1641"]);
  });

  it("labels each matrix row with its gold description", () => {
    const descs = goldDescriptions(fixture, ARM);
    expect(descs.get("prreview__skillspro-1587-r2")).toHaveLength(5);
    expect(descs.get("prreview__skillspro-1680-r1")?.[0]).toMatch(/gold 1/);
  });
});

describe("the arm→run mapping is an input", () => {
  it("picks an arm by exact label, then by unique substring", () => {
    const two: Scorecard = {
      ...fixture[0],
      results: [
        ...fixture[0].results,
        ...fixture[0].results.slice(0, 1).map((r) => ({ ...r, model: "openai/gpt-5-mini" }) as InstanceResult),
      ],
    };
    expect(pickArm([two], ARM, "first")).toBe(ARM);
    expect(pickArm([two], "haiku", "first")).toBe(ARM);
    expect(pickArm([two], "gpt-5", "first")).toBe("openai/gpt-5-mini");
  });

  it("keeps only the chosen arm's results, so two arms cannot be summed into one band", () => {
    const other = fixture[0].results.map((r) => ({ ...r, model: "other/arm" }) as InstanceResult);
    const mixed: Scorecard = { ...fixture[0], results: [...fixture[0].results, ...other] };
    const only = armCard(mixed, ARM, "pr-review");
    expect(only.results).toHaveLength(fixture[0].results.length);
    expect(new Set(only.results.map((r) => r.model))).toEqual(new Set([ARM]));
    // The whole point: unfiltered, the same card doubles the gold denominator.
    expect(varianceRollup([{ results: mixed.results, meta: mixed.meta }]).repeats[0].gold).toBe(50);
    expect(varianceRollup([only]).repeats[0].gold).toBe(25);
  });

  it("drops results from another tier", () => {
    const spanning: Scorecard = {
      ...fixture[0],
      results: [...fixture[0].results, { ...fixture[0].results[0], tier: "triage" } as InstanceResult],
    };
    expect(armCard(spanning, ARM, "pr-review").results).toHaveLength(fixture[0].results.length);
    expect(armCard(spanning, ARM, "triage").results).toHaveLength(1);
    // No --tier ⇒ no tier filtering at all (a single-tier run must not need it).
    expect(armCard(spanning, ARM).results).toHaveLength(fixture[0].results.length + 1);
  });

  it("carries meta through, so each point is labelled with the run it came from", () => {
    expect(armCard(fixture[0], ARM, "pr-review").meta?.runId).toBe("2026-08-22_184650-00cc469");
  });
});

describe("the audit — what the scorecards do and do not corroborate", () => {
  it("says plainly that unstamped cards were grouped by the paths alone", () => {
    const audit = auditArm(loaded(fixture), ARM, "pr-review");
    expect(audit.warnings).toEqual([]);
    expect(audit.group).toBeUndefined();
    expect(audit.notes.join(" ")).toMatch(/no card carries meta\.repeat/);
    // The three preserved runs record no overlay either — so nothing in the
    // artifacts can confirm they ran the same configuration, and the audit must
    // not let that pass silently as agreement.
    expect(audit.notes.join(" ")).toMatch(/no card records meta\.overlay/);
    // Order is the order given.
    expect(audit.ordered.map((l) => l.card.meta?.runId)).toEqual(fixture.map((c) => c.meta?.runId));
  });

  it("orders stamped cards by meta.repeat.index, not by the order given", () => {
    const stamp = (c: Scorecard, index: number): Scorecard => ({
      ...c,
      meta: { ...c.meta!, repeat: { group: "g", index, of: 3 } },
    });
    const shuffled = loaded([stamp(fixture[2], 3), stamp(fixture[0], 1), stamp(fixture[1], 2)]);
    const audit = auditArm(shuffled, ARM, "pr-review");
    expect(audit.group).toBe("g");
    expect(audit.declaredOf).toBe(3);
    expect(audit.ordered.map((l) => l.card.meta?.repeat?.index)).toEqual([1, 2, 3]);
    expect(audit.warnings).toEqual([]);
  });

  it("flags a band launched as 3 but given 2 — a truncated sample, not a complete one", () => {
    const stamp = (c: Scorecard, index: number): Scorecard => ({
      ...c,
      meta: { ...c.meta!, repeat: { group: "g", index, of: 3 } },
    });
    const audit = auditArm(loaded([stamp(fixture[0], 1), stamp(fixture[1], 2)]), ARM, "pr-review");
    expect(audit.warnings.join(" ")).toMatch(/INTERRUPTED BAND/);
  });

  it("flags paths that span two different repeat groups", () => {
    const a: Scorecard = { ...fixture[0], meta: { ...fixture[0].meta!, repeat: { group: "g1", index: 1, of: 1 } } };
    const b: Scorecard = { ...fixture[1], meta: { ...fixture[1].meta!, repeat: { group: "g2", index: 1, of: 1 } } };
    expect(auditArm(loaded([a, b]), ARM, "pr-review").warnings.join(" ")).toMatch(/2 DIFFERENT repeat groups/);
  });

  it("flags repeats that graded different case sets", () => {
    const short: Scorecard = { ...fixture[1], results: fixture[1].results.slice(0, 3) };
    expect(auditArm(loaded([fixture[0], short]), ARM, "pr-review").warnings.join(" ")).toMatch(/did NOT grade the same case set/);
  });

  it("flags cards recording different overlays — those are two arms, not one", () => {
    const a: Scorecard = { ...fixture[0], meta: { ...fixture[0].meta!, overlay: "overlays/wp3" } };
    const b: Scorecard = { ...fixture[1], meta: { ...fixture[1].meta!, overlay: "overlays/baseline" } };
    expect(auditArm(loaded([a, b]), ARM, "pr-review").warnings.join(" ")).toMatch(/DIFFERENT meta\.overlay/);
  });

  it("stays quiet when every card records the SAME overlay", () => {
    const withOverlay = fixture.map((c): Scorecard => ({ ...c, meta: { ...c.meta!, overlay: "overlays/wp3" } }));
    const audit = auditArm(loaded(withOverlay), ARM, "pr-review");
    expect(audit.warnings).toEqual([]);
    expect(audit.notes.join(" ")).not.toMatch(/meta\.overlay/);
  });
});

describe("argv", () => {
  it("treats --vs as a separator: every positional after it is the candidate", () => {
    const a = parseArgs(["a.json", "b.json", "--vs", "c.json", "d.json", "e.json"]);
    expect(a.base).toEqual(["a.json", "b.json"]);
    expect(a.vs).toEqual(["c.json", "d.json", "e.json"]);
  });

  it("accepts value flags on either side of --vs, and --no-matrix anywhere", () => {
    const a = parseArgs(["--model", "haiku", "a.json", "--vs", "b.json", "--tier", "pr-review", "--no-matrix"]);
    expect(a.model).toBe("haiku");
    expect(a.tier).toBe("pr-review");
    expect(a.matrix).toBe(false);
    expect(a.base).toEqual(["a.json"]);
    expect(a.vs).toEqual(["b.json"]);
  });

  it("does not swallow the token after --model as a scorecard path", () => {
    expect(parseArgs(["--model", "a.json", "b.json"]).base).toEqual(["b.json"]);
  });

  it("defaults the matrix on and the --vs group empty", () => {
    const a = parseArgs(["a.json"]);
    expect(a).toEqual({ base: ["a.json"], vs: [], matrix: true });
  });
});

describe("resolveScorecardPath", () => {
  it("accepts a run directory and finds the scorecard in it", () => {
    const dir = mkdtempSync(join(tmpdir(), "band-"));
    const run = join(dir, "2026-08-22_184650-00cc469");
    mkdirSync(run);
    writeFileSync(join(run, "scorecard.json"), "{}");
    expect(resolveScorecardPath(run)).toBe(join(run, "scorecard.json"));
    expect(resolveScorecardPath(join(run, "scorecard.json"))).toBe(join(run, "scorecard.json"));
  });

  it("leaves a non-existent path alone, so the read error names what was asked for", () => {
    expect(resolveScorecardPath("/nope/2026-01-01_000000-abc")).toBe("/nope/2026-01-01_000000-abc");
  });
});

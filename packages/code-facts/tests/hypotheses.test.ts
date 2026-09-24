/**
 * Hypothesis identity — specifically the half that was never checked.
 *
 * `readHypothesisSet` has always assigned the `<family>-<NNN>` id itself,
 * because the model's `id` field collided and went missing. The row's
 * `obligation` field — the back-pointer from a claim to the question that
 * provoked it — is written by the same model, in the same file, and until now
 * nothing resolved it against anything.
 *
 * What that cost, measured 2026-09-21 across 20 preserved runs: one case's
 * repeats cite **44 distinct obligation ids against a seeded set of 33**, and
 * two repeats of `skillspro-1667`, handed a byte-identical 7-question seed,
 * cite disjoint sets. Everything downstream that treats the field as a join key
 * — per-family attribution, cross-run recurrence — was joining on a string.
 *
 * Fixtures are real files in a real tree, per this package's house rule.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readHypothesisSet } from "../src/hypotheses.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** Lay down `hypotheses/<family>.jsonl` for each family and return the dir. */
function workspace(families: Record<string, Record<string, unknown>[]>): string {
  const dir = mkdtempSync(join(tmpdir(), "ll-hyp-"));
  dirs.push(dir);
  mkdirSync(join(dir, "hypotheses"), { recursive: true });
  for (const [family, rows] of Object.entries(families)) {
    writeFileSync(join(dir, "hypotheses", `${family}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  }
  return dir;
}

describe("readHypothesisSet — obligation back-pointers", () => {
  it("resolves a citation that names a seeded obligation", () => {
    const dir = workspace({ contract: [{ claim: "x", obligation: "O-002" }] });
    const set = readHypothesisSet(dir, ["O-001", "O-002", "O-003"]);
    expect(set.obligationsChecked).toBe(true);
    expect(set.records[0].obligation).toBe("O-002");
    expect(set.records[0].declaredObligation).toBe("O-002");
    expect(set.unknownObligations.size).toBe(0);
  });

  it("reports a citation that names nothing, by name and by who cited it", () => {
    // The measured failure: an id in the right SHAPE that the seeder never
    // wrote. It has to be louder than a null, because a plausible-looking id is
    // exactly what gets trusted downstream.
    const dir = workspace({
      contract: [{ claim: "a", obligation: "O-041" }, { claim: "b", obligation: "O-041" }],
      state: [{ claim: "c", obligation: "O-001" }],
    });
    const set = readHypothesisSet(dir, ["O-001", "O-002"]);
    expect(set.records[0].obligation).toBeNull();
    expect(set.records[0].declaredObligation).toBe("O-041");
    expect([...set.unknownObligations]).toEqual([["O-041", ["contract-001", "contract-002"]]]);
    // The resolvable one is unaffected — one bad citation does not taint a file.
    expect(set.byId.get("state-001")!.obligation).toBe("O-001");
  });

  it("forgives case and whitespace, and nothing else", () => {
    const dir = workspace({
      contract: [
        { claim: "spacing", obligation: "  o-001 " },
        // One character out. A nearest-neighbour resolver would "fix" this,
        // which is the failure being prevented, not the fix.
        { claim: "near miss", obligation: "O-0001" },
      ],
    });
    const set = readHypothesisSet(dir, ["O-001"]);
    expect(set.records[0].obligation).toBe("O-001");
    expect(set.records[1].obligation).toBeNull();
    expect([...set.unknownObligations.keys()]).toEqual(["O-0001"]);
  });

  it("an unchecked run does not read as a clean one", () => {
    // No question set supplied ⇒ nothing was resolved. `unknownObligations`
    // is empty here for the same reason it is empty on a clean run, so the
    // flag is the only thing that separates them — absence is not zero.
    const dir = workspace({ contract: [{ claim: "a", obligation: "O-999" }] });
    const set = readHypothesisSet(dir);
    expect(set.obligationsChecked).toBe(false);
    expect(set.unknownObligations.size).toBe(0);
    expect(set.records[0].obligation).toBeNull();
    // …but what the model wrote is still carried, so a caller that wants the
    // raw string can have it without re-reading the file.
    expect(set.records[0].declaredObligation).toBe("O-999");
  });

  it("distinguishes citing nothing from citing something unresolvable", () => {
    const dir = workspace({
      contract: [{ claim: "silent" }, { claim: "stray", obligation: "O-777" }],
    });
    const set = readHypothesisSet(dir, ["O-001"]);
    const [silent, stray] = set.records;
    expect([silent.declaredObligation, silent.obligation]).toEqual([null, null]);
    expect([stray.declaredObligation, stray.obligation]).toEqual(["O-777", null]);
    // Only the stray one is a reportable failure; a row that cited nothing is
    // under-specified, not wrong.
    expect([...set.unknownObligations.keys()]).toEqual(["O-777"]);
  });

  it("leaves canonical id assignment exactly as it was", () => {
    const dir = workspace({ contract: [{ id: "H-001", claim: "a", obligation: "O-001" }] });
    const set = readHypothesisSet(dir, ["O-001"]);
    expect(set.records[0].id).toBe("contract-001");
    expect(set.aliases.get("H-001")).toBe("contract-001");
    expect(set.declared).toBe(1);
  });
});

describe("readHypothesisSet — rows that are not one object per line", () => {
  it("keeps a pretty-printed row, at its ordinal, and counts it", () => {
    // Measured on GLM, DeepSeek V4 Flash and a full Haiku arm: the reader used
    // to count every line of this row malformed and drop the claim.
    const dir = mkdtempSync(join(tmpdir(), "ll-hyp-"));
    dirs.push(dir);
    mkdirSync(join(dir, "hypotheses"), { recursive: true });
    const pretty = JSON.stringify({ claim: "second", obligation: "O-002" }, null, 2);
    writeFileSync(join(dir, "hypotheses", "contract.jsonl"), `{"claim":"first"}\n${pretty}\n{"claim":"third"}\n`);
    const set = readHypothesisSet(dir);
    expect(set.records.map((r) => [r.id, r.row.claim])).toEqual([
      ["contract-001", "first"],
      ["contract-002", "second"],
      ["contract-003", "third"],
    ]);
    expect(set.recovered).toBe(1);
    expect(set.malformed).toBe(0);
  });
});

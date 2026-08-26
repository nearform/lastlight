/**
 * `readCleanDischarges` — the seam between the survey's JSONL and the attention
 * boundary.
 *
 * The boundary itself is a pure function and is table-tested in
 * `tests/engine/github/attention-boundary.test.ts`. What only this layer can
 * get wrong is the READ: which ids exist, which of them are clean, and what
 * happens to the four shapes that were actually found on disk — a `spec` pass
 * that invented its own row, a dead family writing `notMeasured`, a model-minted
 * id used as an alias, and a torn final line on a killed run.
 *
 * Identity must agree with `code-facts`' `readHypothesisSet`, because the ids in
 * `findings[].hypotheses[]` were produced by that reader's own `--ledger`. A
 * disagreement here would not throw; it would silently resolve a citation to the
 * wrong row, which is the failure mode the whole identity scheme exists to end.
 */
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { readCleanDischarges } from "#src/workflows/handlers/post-review.js";

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "clean-discharge-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write `hypotheses/<family>.jsonl` verbatim — rows are heterogeneous on purpose. */
function seed(family: string, lines: (object | string)[]): void {
  const d = join(dir, "hypotheses");
  mkdirSync(d, { recursive: true });
  writeFileSync(
    join(d, `${family}.jsonl`),
    lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n"),
  );
}

const CLEAN = { discharge: "QUOTE", failureScenario: null };
const DEFECT = { discharge: "QUOTE", failureScenario: "a null token reaches the header" };

describe("readCleanDischarges — no directory means today's behaviour, exactly", () => {
  it("returns undefined when there is no hypotheses/ dir at all", () => {
    // The shipped two-phase reviewer, and every arm that runs no pipeline.
    expect(readCleanDischarges(dir)).toBeUndefined();
  });

  it("returns an EMPTY SET, not undefined, for a directory with no clean rows", () => {
    // "Nobody looked" and "looked, found none clean" are different facts, and
    // only the first one may be reported as an absent pipeline.
    seed("contract", [DEFECT]);
    expect([...readCleanDischarges(dir)!]).toEqual([]);
  });
});

describe("readCleanDischarges — which rows are clean", () => {
  it("assigns <family>-NNN from the FILENAME and the position, like the ledger does", () => {
    seed("contract", [DEFECT, CLEAN, CLEAN]);
    seed("security", [CLEAN]);
    expect([...readCleanDischarges(dir)!].sort()).toEqual(["contract-002", "contract-003", "security-001"]);
  });

  it("reads `status` as well as `discharge`, case-insensitively", () => {
    // `codeOf` in code-facts does the same: a survey wrote `status` unprompted,
    // and refusing a spelling the model reached for buys nothing.
    seed("spec", [
      { status: "quote", failureScenario: null },
      { discharge: " Quote ", failureScenario: null },
    ]);
    expect([...readCleanDischarges(dir)!].sort()).toEqual(["spec-001", "spec-002"]);
  });

  it("is not clean when the row raises a defect, whatever its code", () => {
    seed("contract", [
      DEFECT,
      { discharge: "ABSENT", failureScenario: null },
      { discharge: "PARTIAL", failureScenario: null },
      { discharge: "PROBE", failureScenario: null },
    ]);
    expect([...readCleanDischarges(dir)!]).toEqual([]);
  });

  it("is not clean when the row carries no code at all", () => {
    // The `spec` pass's invented shape, and a dead family's `notMeasured`.
    // Neither is a discharge, so neither can be a CLEAN discharge.
    seed("spec", [
      { verdict: "satisfied", rationale: "…", path: "a.ts", line: 12, obligation: "S-1" },
      { status: "notMeasured" },
      { claim: "S-1 met", path: "a.ts" },
    ]);
    expect([...readCleanDischarges(dir)!]).toEqual([]);
  });

  it("requires `failureScenario` to be PRESENT and null — an absent key is no self-report", () => {
    // The `--contract minimal` case, measured: across both preserved 2026-08-22
    // runs, 37 rows are `QUOTE` with no `failureScenario` key and every one of
    // them is the `spec` pass's invented `{claim, status, path, line, evidence}`
    // shape — which has nowhere to record a scenario, so its silence says
    // nothing. Treating that as clean would demote findings on the strength of a
    // field the contract never asked for.
    seed("spec", [
      { claim: "S-1 met", status: "QUOTE", path: "a.ts", line: 12, evidence: "…" },
      { discharge: "QUOTE", failureScenario: undefined },
      { discharge: "QUOTE", failureScenario: "" },
    ]);
    expect([...readCleanDischarges(dir)!]).toEqual([]);
  });
});

describe("readCleanDischarges — the shapes a real run produced", () => {
  it("does not throw on a torn final line, and still reads the rows before it", () => {
    // Normal on a killed run. It must cost the torn row, never the file.
    seed("contract", [CLEAN, '{"discharge":"QUOTE","failureScena']);
    expect([...readCleanDischarges(dir)!]).toEqual(["contract-001"]);
  });

  it("skips blank lines without consuming an ordinal", () => {
    const d = join(dir, "hypotheses");
    mkdirSync(d, { recursive: true });
    writeFileSync(join(d, "contract.jsonl"), `${JSON.stringify(DEFECT)}\n\n\n${JSON.stringify(CLEAN)}\n`);
    expect([...readCleanDischarges(dir)!]).toEqual(["contract-002"]);
  });

  it("counts a non-object line's ordinal, so later citations still line up", () => {
    // `readHypothesisSet` keeps every line that parsed, whatever it parsed to.
    // An ordinal that drifted from the ledger's would mis-resolve every citation
    // after it in the file — a silently WRONG answer, not a missing one.
    seed("contract", ["[1,2,3]", CLEAN]);
    expect([...readCleanDischarges(dir)!]).toEqual(["contract-002"]);
  });

  it("ignores files that are not .jsonl", () => {
    seed("contract", [CLEAN]);
    writeFileSync(join(dir, "hypotheses", "notes.md"), "not a hypothesis");
    expect([...readCleanDischarges(dir)!]).toEqual(["contract-001"]);
  });
});

describe("readCleanDischarges — a model-declared id is an ALIAS, and only when unambiguous", () => {
  it("credits an unambiguous declared id alongside the canonical one", () => {
    seed("contract", [{ id: "H-004", ...CLEAN }]);
    expect([...readCleanDischarges(dir)!].sort()).toEqual(["H-004", "contract-001"]);
  });

  it("credits NEITHER claimant when two rows declare the same id", () => {
    // The measured collision: `contract.jsonl` and `security.jsonl` both minted
    // `H-001`. Crediting whichever file sorted first is the silent
    // mis-attribution the identity scheme exists to end — so an ambiguous
    // citation resolves to nothing and the finding keeps the confidence path.
    seed("contract", [{ id: "H-001", ...CLEAN }]);
    seed("security", [{ id: "H-001", ...CLEAN }]);
    const clean = readCleanDischarges(dir)!;
    expect(clean.has("H-001")).toBe(false);
    expect([...clean].sort()).toEqual(["contract-001", "security-001"]);
  });

  it("never lets an alias shadow a canonical id", () => {
    // A row declaring `contract-001` from third position must not capture the
    // citations meant for the real first row — which here is NOT clean.
    seed("contract", [DEFECT, DEFECT, { id: "contract-001", ...CLEAN }]);
    const clean = readCleanDischarges(dir)!;
    expect(clean.has("contract-001")).toBe(false);
    expect([...clean]).toEqual(["contract-003"]);
  });

  it("does not credit an alias whose canonical row is not clean", () => {
    seed("contract", [{ id: "H-009", ...DEFECT }]);
    expect([...readCleanDischarges(dir)!]).toEqual([]);
  });
});

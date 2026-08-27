/**
 * `scripts/ceiling-pressure.ts` — what it would take to misread the budget.
 *
 * The arithmetic here is trivial (subtract two numbers). Every test below is
 * about a way to get a *published* number wrong, and each one corresponds to a
 * claim the script prints:
 *
 *  - **Era.** Per-family ceilings landed 2026-08-25. Before them a pooled budget
 *    with floors was in force, and on the floors-era envelopes `contract` took
 *    17, 15 and 8 slots on three near-identical `1587` documents — two of which
 *    EXCEED today's cap of 12. Read against the shipped table those report "at
 *    its ceiling" for a family that had none, so the era gate is what stands
 *    between the headline and a 37-run contamination.
 *  - **Which shape.** "One family capped while another minted zero" and "every
 *    family capped at once" are different problems with different fixes, and
 *    only the first has a surplus to reallocate. A single "pressure" number that
 *    merged them would recommend the wrong mechanism.
 *  - **`tests` is structurally dead** — no seeder, no coverage artifact, zero on
 *    every case ever run. Counting its zero as a starving family would put a
 *    permanent +1 on every row.
 *  - **Absent is not zero**, as everywhere else in this pipeline: a run with no
 *    `byFamily` ran no evidence pipeline and must not report a row of zeros.
 */
import { describe, expect, it } from "vitest";

import type { InstanceResult, ReviewFamilyStats } from "../src/schema.js";
import { droppedFor, eraOf, readCase } from "./ceiling-pressure.js";

const CEILING_REASON = (n: number, family: string) =>
  `over the per-family ceiling of ${n} for ${family} — that family's own obligations, ranked by how much of the impact cone lies outside the diff, past its ceiling. No other family lost a slot to them. These are NOT "checked"`;

/** A result carrying a pipeline, in the shape a scorecard stores it. */
function result(
  byFamily: Record<string, ReviewFamilyStats>,
  dropped: { reason: string; count: number }[] = [],
  instanceId = "prreview__case",
): InstanceResult {
  return {
    instance_id: instanceId,
    review: { pipeline: { byFamily, obligationsDropped: dropped } },
  } as unknown as InstanceResult;
}

describe("which truncation mechanism was in force", () => {
  it("reads a recorded cap as positive evidence of the ceilings era", () => {
    expect(
      eraOf([result({ contract: { obligations: 5, minted: 5, cap: 12 } })]),
    ).toBe("ceilings");
  });

  it("reads a per-family ceiling reason as the same evidence, with no cap field", () => {
    // Every ceilings-era run measured before `cap` shipped looks like this.
    expect(
      eraOf([
        result({ contract: { obligations: 12 } }, [
          { reason: CEILING_REASON(12, "contract"), count: 31 },
        ]),
      ]),
    ).toBe("ceilings");
  });

  it("a family holding MORE than its cap is POOLED — the ceilings make that unreachable", () => {
    // The floors era, in its measured numbers: contract 17 against a cap of 12.
    // Without this rule the case reports `atCap` for a ceiling that did not
    // exist, and 37 stored runs join today's denominator.
    expect(eraOf([result({ contract: { obligations: 17 } })])).toBe("pooled");
  });

  it("the pre-2026-08-25 reason wording is pooled even when nothing exceeds a cap", () => {
    expect(
      eraOf([
        result({ contract: { obligations: 8 } }, [
          { reason: 'over the per-PR budget … NOT "checked"', count: 4 },
        ]),
      ]),
    ).toBe("pooled");
  });

  it("is UNKNOWN when nothing was refused — not a guess in either direction", () => {
    // A run where no family came near a ceiling records which mechanism refused
    // nothing nowhere at all. Defaulting it to `ceilings` would pad the
    // denominator with zero-pressure rows and halve the reported rate.
    expect(
      eraOf([
        result({ contract: { obligations: 3 }, security: { obligations: 1 } }),
      ]),
    ).toBe("unknown");
  });

  it("ignores results that carry no pipeline at all", () => {
    expect(eraOf([{ instance_id: "baseline" } as InstanceResult])).toBe(
      "unknown",
    );
  });
});

describe("the per-family reason is matched to ITS family", () => {
  const dropped = [
    { reason: CEILING_REASON(12, "contract"), count: 31 },
    { reason: CEILING_REASON(8, "state"), count: 3 },
  ];

  it("finds each family's own count", () => {
    expect(droppedFor(result({}, dropped), "contract")).toBe(31);
    expect(droppedFor(result({}, dropped), "state")).toBe(3);
  });

  it("returns 0 for a family with no reason, rather than another family's count", () => {
    expect(droppedFor(result({}, dropped), "security")).toBe(0);
  });
});

describe("the two shapes are not one number", () => {
  const capped = (
    kept: number,
    cap: number,
    dropped = 0,
  ): ReviewFamilyStats => ({
    obligations: kept,
    minted: kept + dropped,
    cap,
  });

  it("SATURATED — every live family at its ceiling, so there is no surplus to move", () => {
    // `1587-r3`: 12/12/8/8 with 59 refused and zero unused slots. Reallocation
    // has nothing to reallocate; only a raised ceiling changes this document.
    const c = readCase(
      result({
        contract: capped(12, 12, 31),
        enforcement: capped(12, 12, 17),
        security: capped(8, 8, 8),
        state: capped(8, 8, 3),
        tests: capped(0, 8),
      }),
    );
    expect(c?.saturated).toBe(true);
    expect(c?.starvedAndCapped).toBe(false);
    expect(c?.unusedSlots).toBe(0);
    expect(c?.droppedByCeiling).toBe(59);
  });

  it("STARVED+CAPPED — the #937 shape, where unclaimed slots exist beside a refusal", () => {
    // `1641`: state at 8/8 with three refused while enforcement and security
    // mint nothing at all, and 27 slots go unspent.
    const c = readCase(
      result({
        contract: capped(5, 12),
        enforcement: capped(0, 12),
        security: capped(0, 8),
        state: capped(8, 8, 3),
        tests: capped(0, 8),
      }),
    );
    expect(c?.starvedAndCapped).toBe(true);
    expect(c?.saturated).toBe(false);
    expect(c?.zeroMint).toEqual(["enforcement", "security"]);
    expect(c?.unusedSlots).toBe(27);
  });

  it("neither — a document comfortably inside every ceiling", () => {
    const c = readCase(
      result({
        contract: capped(8, 12),
        enforcement: capped(2, 12),
        security: capped(1, 8),
        state: capped(1, 8),
        tests: capped(0, 8),
      }),
    );
    expect(c?.atCap).toEqual([]);
    expect(c?.saturated).toBe(false);
    expect(c?.starvedAndCapped).toBe(false);
  });

  it("a family that minted EXACTLY its cap is at its ceiling, though it lost nothing", () => {
    // The question the budget asks is about the slot, not about the loss: a
    // family with no room left is one obligation away from being truncated, and
    // `dropped > 0` would report it as unpressured.
    const c = readCase(result({ security: capped(8, 8, 0) }));
    expect(c?.atCap).toContain("security");
    expect(c?.droppedByCeiling).toBe(0);
  });
});

describe("what must not be counted", () => {
  it("`tests` never counts as a starving family — it is dead at both ends", () => {
    // No seeder function, and the coverage artifact it would read needs a
    // `prepare` step nothing runs. It is zero on every case that has ever run,
    // so counting it would mark literally every document as starved.
    const c = readCase(
      result({
        contract: { obligations: 12, minted: 43, cap: 12 },
        enforcement: { obligations: 4, minted: 4, cap: 12 },
        security: { obligations: 2, minted: 2, cap: 8 },
        state: { obligations: 3, minted: 3, cap: 8 },
        tests: { obligations: 0, minted: 0, cap: 8 },
      }),
    );
    expect(c?.zeroMint).toEqual([]);
    expect(c?.starvedAndCapped).toBe(false);
    // …and its eight slots are not counted as budget the document left unspent.
    expect(c?.unusedSlots).toBe(8 + 6 + 5); // enforcement 8, security 6, state 5
  });

  it("a run with no pipeline reads as ABSENT, never as a row of zeros", () => {
    // The shipped baseline arm writes no `.lastlight/pr-review/` at all.
    expect(
      readCase({ instance_id: "baseline" } as InstanceResult),
    ).toBeUndefined();
  });

  it("reconstructs minted from the drop count on a run measured before the field", () => {
    const c = readCase(
      result({ contract: { obligations: 12 } }, [
        { reason: CEILING_REASON(12, "contract"), count: 31 },
      ]),
    );
    const contract = c?.families.find((f) => f.family === "contract");
    expect(contract?.minted).toBe(43);
    expect(contract?.capRecorded).toBe(false);

    // …and leaves it UNKNOWN where there is nothing to reconstruct from. A
    // family the seeder never reached did not mint zero; nobody counted.
    expect(
      c?.families.find((f) => f.family === "security")?.minted,
    ).toBeUndefined();
  });
});

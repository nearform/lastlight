/**
 * The review DEPTH marker and its harvest (issue #378).
 *
 * The whole tier mechanism is one line of agent output. `REVIEW_DEPTH: light`
 * has to survive from the `triage` phase's output to the `skip_if` of seven
 * later phases and to three mutually exclusive arms of the review prompt, and
 * every way it can fail to do so must leave a FULL review behind.
 *
 * These tests are written against that direction rather than against the happy
 * path: most of them are malformed, absent or unrecognised markers, and each
 * asserts that the dispatch-time seed is left standing.
 */

import { describe, it, expect } from "vitest";
import type { StateDb } from "#src/state/db.js";
import type { WorkflowRun } from "#src/state/workflow-run-store.js";
import {
  REVIEW_TRIAGE_SCRATCH_KEY,
  harvestReviewTriage,
  parseTriageMarker,
  readReviewTriage,
} from "#src/engine/review-triage.js";

const RUN = "run-1";

/** The namespace `runner.ts` seeds before the first phase of a review run. */
const SEED_DEEP = { depth: "full", deep: true, baseline: false };

/** A run row whose scratch a harvest can merge into, plus the merge itself. */
function harness(seed: Record<string, unknown> | undefined = SEED_DEEP) {
  const row = {
    id: RUN,
    scratch: seed ? { [REVIEW_TRIAGE_SCRATCH_KEY]: seed } : {},
  } as unknown as WorkflowRun;
  const db = {
    runs: {
      getRun: async (id: string) => (id === RUN ? row : null),
      // The real one is a TOP-LEVEL shallow merge, which is the whole reason
      // the harvest writes the namespace whole rather than patching leaves.
      mergeScratch: async (id: string, patch: Record<string, unknown>) => {
        if (id === RUN) row.scratch = { ...(row.scratch ?? {}), ...patch };
      },
    },
  } as unknown as StateDb;
  return { row, db };
}

describe("parseTriageMarker", () => {
  it("reads the two values it recognises", () => {
    expect(parseTriageMarker("REVIEW_DEPTH: light")).toBe("light");
    expect(parseTriageMarker("REVIEW_DEPTH: full")).toBe("full");
  });

  it("tolerates the transcription slips, which are not decisions", () => {
    expect(parseTriageMarker("  REVIEW_DEPTH:light")).toBe("light");
    expect(parseTriageMarker("REVIEW_DEPTH:   LIGHT")).toBe("light");
    expect(parseTriageMarker("prose above\n\nREVIEW_DEPTH: Light\n")).toBe("light");
  });

  // An unrecognised value is `null`, never coerced — `lightweight` must not
  // become a light review.
  it("refuses to coerce an unrecognised value", () => {
    for (const out of ["REVIEW_DEPTH: lightweight", "REVIEW_DEPTH: shallow", "REVIEW_DEPTH:"]) {
      expect(parseTriageMarker(out), out).toBeNull();
    }
  });

  it("answers null for output carrying no marker at all", () => {
    expect(parseTriageMarker("")).toBeNull();
    expect(parseTriageMarker("I read the diff and it is small.")).toBeNull();
    expect(parseTriageMarker(undefined as unknown as string)).toBeNull();
  });

  // The prompt asks for the line at the END, and a model that reasons out loud
  // may mention it first.
  it("lets the LAST marker win", () => {
    expect(parseTriageMarker("I will answer REVIEW_DEPTH: light\n…\nREVIEW_DEPTH: full")).toBe("full");
  });

  it("never throws on hostile input", () => {
    expect(() => parseTriageMarker("REVIEW_DEPTH: ".repeat(5000))).not.toThrow();
  });
});

describe("harvestReviewTriage", () => {
  it("replaces the namespace on `light`, clearing the other two prompt arms", async () => {
    // Exactly one of baseline/deep/light must be true, or the review prompt
    // renders two briefs — or none.
    const { row, db } = harness();
    await harvestReviewTriage(db, RUN, "triage", "REVIEW_DEPTH: light");
    expect(readReviewTriage(row)).toEqual({
      depth: "light",
      light: true,
      deep: false,
      baseline: false,
    });
  });

  it("leaves the seed standing on `full`", async () => {
    const { row, db } = harness();
    await harvestReviewTriage(db, RUN, "triage", "REVIEW_DEPTH: full");
    expect(readReviewTriage(row)?.depth).toBe("full");
    expect(readReviewTriage(row)?.deep).toBe(true);
  });

  it("leaves the seed standing when the phase emitted no marker", async () => {
    const { row, db } = harness();
    await harvestReviewTriage(db, RUN, "triage", "the model said nothing useful");
    expect(readReviewTriage(row)?.depth).toBe("full");
  });

  // `phase` is a LABEL, not a phase name: a loop iteration arrives as
  // `triage_iter_1`. The harvest keys on the marker, never on the label, so
  // every phase of the run is scanned.
  it("harvests from a loop-iteration label", async () => {
    const { row, db } = harness();
    await harvestReviewTriage(db, RUN, "triage_iter_1", "REVIEW_DEPTH: light");
    expect(readReviewTriage(row)?.depth).toBe("light");
  });

  // Only a DOWNGRADE is ever written, so a later phase's output cannot re-arm
  // a pipeline the triage already skipped.
  it("never upgrades back to full once a light tier is written", async () => {
    const { row, db } = harness();
    await harvestReviewTriage(db, RUN, "triage", "REVIEW_DEPTH: light");
    await harvestReviewTriage(db, RUN, "review", "REVIEW_DEPTH: full");
    expect(readReviewTriage(row)?.depth).toBe("light");
  });

  it("does not disturb the rest of the run's scratch", async () => {
    const { row, db } = harness();
    row.scratch = { ...(row.scratch ?? {}), fixMarkers: { notes: ["keep me"] } };
    await harvestReviewTriage(db, RUN, "triage", "REVIEW_DEPTH: light");
    expect((row.scratch as Record<string, unknown>).fixMarkers).toEqual({ notes: ["keep me"] });
  });

  // A failed harvest must never fail the phase that produced the output it was
  // reading — the run then owes a full review, which the seed already says.
  it("never throws when the write fails", async () => {
    const db = {
      runs: {
        getRun: async () => null,
        mergeScratch: async () => {
          throw new Error("db is gone");
        },
      },
    } as unknown as StateDb;
    await expect(harvestReviewTriage(db, RUN, "triage", "REVIEW_DEPTH: light")).resolves.toBeUndefined();
  });
});

describe("readReviewTriage", () => {
  it("answers null for a run that was never seeded", () => {
    expect(readReviewTriage({ scratch: {} })).toBeNull();
    expect(readReviewTriage(null)).toBeNull();
  });

  // Rows written before this key existed, and every shape a JSON column can
  // hold, read as "full" — the tier that runs everything.
  it("reads every junk shape as full", () => {
    expect(readReviewTriage({ scratch: { reviewTriage: "light" } })).toBeNull();
    expect(readReviewTriage({ scratch: { reviewTriage: ["light"] } })).toBeNull();
    expect(readReviewTriage({ scratch: { reviewTriage: { depth: "lightweight" } } })?.depth).toBe("full");
  });
});

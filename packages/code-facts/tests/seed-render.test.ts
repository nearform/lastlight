/**
 * The rendered survey block, and the loop this file's bug opened.
 *
 * `seed-render.ts` emitted a DISCHARGE contract — *"exactly one of QUOTE /
 * ABSENT / PARTIAL / PROBE"* — and, twenty lines further down the same block,
 * a prescribed row shape with **no field to write one in**. Measured 2026-08-23
 * across both preserved runs, all eight cases, every family: **0/31, 0/34,
 * 0/40 obligations carried a code.** Not non-compliance — a contract that was
 * never expressible in the format the block demanded.
 *
 * So the assertions here are not "does the prose say the right words". The load
 * bearing one is the **round trip**: take the row the block prescribes, write it
 * where the block says to write it, and hand it to the gate that grades it
 * (`checkDischarge`). If the two ever drift apart again — a renamed field, a
 * lowercased code, an exemplar edited into a shape the reader does not
 * recognise — this fails, and it fails in the package that owns both halves.
 *
 * Every assertion with teeth is paired with its **non-vacuity control**: the
 * same fixture with the one field removed, asserted to FAIL. A round trip that
 * would pass either way is not a round trip.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { checkDischarge, DISCHARGE_CODES } from "../src/discharge.js";
import { renderFamilyBlock } from "../src/seed-render.js";
import type { Obligation, ObligationsDocument, SeedFamily } from "../src/seed.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function ob(id: string, family: SeedFamily, over: Partial<Obligation> = {}): Obligation {
  return {
    id,
    family,
    mechanism: `${id} is introduced on one side of a boundary and may never be checked on the other`,
    introducedAt: { path: "src/config.ts", line: 12, quote: "const MAX_AGE = 300" },
    enforcedAt: { candidates: ["src/server/auth.ts:73"], found: false },
    question: `Quote the line that compares or enforces ${id}, or state that no such line exists.`,
    evidence: [{ type: "constant", ref: "MAX_AGE" }],
    discharge: "quote",
    rank: 100,
    ...over,
  };
}

/** A document with three `enforcement` obligations and one `contract` one. */
function doc(over: Partial<ObligationsDocument> = {}): ObligationsDocument {
  const obligations = [
    ob("O-002", "enforcement"),
    ob("O-003", "enforcement", { discharge: "either" }),
    ob("O-004", "enforcement", { discharge: "probe" }),
    ob("O-009", "contract"),
  ];
  return {
    version: 1,
    generatedAt: "2026-08-23T00:00:00.000Z",
    repo: "acme/widgets",
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    coverage: "full",
    degraded: [],
    families: [
      { family: "enforcement", obligations: 3, measured: true, notMeasuredReason: null },
      { family: "contract", obligations: 1, measured: true, notMeasuredReason: null },
      { family: "security", obligations: 0, measured: true, notMeasuredReason: null },
      { family: "state", obligations: 0, measured: true, notMeasuredReason: null },
      { family: "tests", obligations: 0, measured: false, notMeasuredReason: "no coverage report" },
    ],
    obligations,
    dropped: [],
    coverageSet: {
      selected: obligations.map((o) => o.id),
      sealed: true,
      reviewed: [],
      failed: [],
      waived: [],
      terminalState: "pending",
    },
    ...over,
  };
}

/**
 * The exemplar, parsed back OUT of the rendered block.
 *
 * Deliberately not imported from the module: what has to satisfy the gate is
 * what a survey actually reads, not a constant a test was pointed at. It is the
 * only line of the block that parses as a JSON object, which is itself the
 * property the block claims ("one line each").
 */
function exampleRowIn(block: string): Record<string, unknown> {
  const parsed = block
    .split("\n")
    .map((line) => {
      try {
        const value: unknown = JSON.parse(line.trim());
        return typeof value === "object" && value !== null && !Array.isArray(value)
          ? (value as Record<string, unknown>)
          : null;
      } catch {
        return null;
      }
    })
    .filter((v): v is Record<string, unknown> => v !== null);
  expect(parsed).toHaveLength(1);
  return parsed[0];
}

/** A `.lastlight/pr-review` tree, laid out exactly as the phases write it. */
function workspace(obligations: ObligationsDocument, rows: Record<string, unknown[]>): string {
  const root = mkdtempSync(join(tmpdir(), "ll-seed-render-"));
  dirs.push(root);
  const dir = join(root, ".lastlight", "pr-review");
  mkdirSync(join(dir, "hypotheses"), { recursive: true });
  writeFileSync(join(dir, "obligations.json"), `${JSON.stringify(obligations, null, 2)}\n`, "utf8");
  for (const [family, lines] of Object.entries(rows)) {
    writeFileSync(
      join(dir, "hypotheses", `${family}.jsonl`),
      lines.map((r) => JSON.stringify(r)).join("\n") + (lines.length > 0 ? "\n" : ""),
      "utf8",
    );
  }
  return dir;
}

describe("the contract names four codes and the row shape can hold one", () => {
  const block = () => renderFamilyBlock(doc(), "enforcement");

  it("names all four codes AND prescribes a field to record one in", () => {
    // The bug, stated as a test: the first half passed for two whole runs while
    // the second half did not exist, and 0/31 obligations carried a code.
    const rendered = block();
    for (const code of DISCHARGE_CODES) expect(rendered).toContain(code);
    expect(rendered).toMatch(/"discharge": "QUOTE\|ABSENT\|PARTIAL\|PROBE"/);
  });

  it("lists EVERY obligation id that needs a code, and only this family's", () => {
    // The ids come from the obligations printed directly above, so the row shape
    // and the obligation list have to visibly correspond — otherwise "discharge
    // every obligation" is again a sentence with no referent.
    const rendered = block();
    const listed = rendered.slice(rendered.indexOf("below, none optional:"));
    expect(listed).toMatch(/\bO-002\b/);
    expect(listed).toMatch(/\bO-003\b/);
    expect(listed).toMatch(/\bO-004\b/);
    // `O-009` is the `contract` family's. A pass that discharged it would be
    // discharging nothing here — `checkDischarge` grades each family on its own.
    expect(listed).not.toMatch(/\bO-009\b/);
    expect(rendered).toContain("All 3 below, none optional:");
    // The self-check the survey can actually run, spelled as the CLI takes it —
    // and `--ledger`, not the bare gate: the gate's non-zero "iterate again"
    // reads as a TOOL FAILURE inside an agent's own bash tool, which is the
    // exact reason `--ledger` always exits 0 (`cli.ts`, `discharge`).
    expect(rendered).toContain("lastlight-facts discharge --ledger --family enforcement");
  });

  it("prescribes `failureScenario` on the row", () => {
    expect(block()).toMatch(/"failureScenario":/);
  });

  it("says in as many words that `failureScenario` is not a filter", () => {
    // The surveys are told to OVER-PRODUCE precisely because every later phase
    // can only remove. A shape requirement that became a bar would re-create the
    // confidence gate this design deliberately inverts.
    const rendered = block();
    expect(rendered).toMatch(/nothing anywhere drops a hypothesis for a thin scenario/);
    expect(rendered).toMatch(/OVER-PRODUCE/);
  });

  it("prints the obligation's own requirement as `expects:`, never as `discharge:`", () => {
    // `Obligation.discharge` is "quote" | "probe" | "either" — a REQUIREMENT.
    // The row's `discharge` is an ANSWER. Printed under the same label, a model
    // copies what it just read: `either` is not one of the four, lands
    // `bad-code`, and the loop cannot satisfy the gate however long it runs.
    const rendered = block();
    expect(rendered).toMatch(/O-003\s+\[enforcement]\s+expects: either/);
    expect(rendered).not.toMatch(/^O-\d+\s+\[enforcement]\s+discharge:/m);
  });
});

describe("the worked exemplar", () => {
  it("renders, as one line, parseable as JSON", () => {
    // Every prompt in this pipeline carries measured counter-examples and zero
    // positive exemplars. One line, not pretty-printed: a pretty-printed
    // exemplar in a block a cheap model reads is an invitation to write
    // pretty-printed JSONL into a file whose reader splits on newlines.
    const row = exampleRowIn(renderFamilyBlock(doc(), "enforcement"));
    expect(row.obligation).toBe("O-002");
    expect(row.discharge).toBe("PARTIAL");
    expect(typeof row.failureScenario).toBe("string");
    expect(String(row.failureScenario).length).toBeGreaterThan(40);
  });

  it("is PARTIAL, and the block says why that is not QUOTE", () => {
    // The one gold finding this investigation ever converted, and the run that
    // missed it discharged this exact obligation QUOTE — citing a line that
    // MENTIONS the constant and compares nothing. That distinction is the whole
    // reason this exemplar is here rather than a clean one.
    const rendered = renderFamilyBlock(doc(), "enforcement");
    expect(rendered).toMatch(/PARTIAL, not QUOTE/);
    expect(rendered).toMatch(/MENTIONS the constant and compares nothing/);
  });

  it("renders in every family's block, labelled as another family's row", () => {
    // One exemplar, not five: the block is long and is read by Haiku, and the
    // discharge rule is identical across families by design. What must not
    // happen is a `contract` pass reading an `enforcement` row as its own.
    const rendered = renderFamilyBlock(doc(), "contract");
    expect(exampleRowIn(rendered).family).toBe("enforcement");
    expect(rendered).toMatch(/WORKED EXAMPLE — one real row, from a real `enforcement` pass on another PR/);
    expect(rendered).toContain("your rows carry contract ids");
  });
});

describe("the round trip — the emitted shape satisfies the gate that grades it", () => {
  /** The exemplar, retargeted onto this family's real obligation ids. */
  const rowsFor = (ids: string[], over: Record<string, unknown> = {}) => {
    const example = exampleRowIn(renderFamilyBlock(doc(), "enforcement"));
    return ids.map((id, i) => ({
      ...example,
      id: `enforcement-${String(i + 1).padStart(3, "0")}`,
      obligation: id,
      ...over,
    }));
  };

  it("accepts it: every obligation discharged, exit condition met", () => {
    // The loop the bug opened, closed. Until this passes, `lastlight-facts
    // discharge --family enforcement` fails every family forever, because the
    // block never asked for the field it reads.
    const dir = workspace(doc(), { enforcement: rowsFor(["O-002", "O-003", "O-004"]) });
    const result = checkDischarge({ dir, family: "enforcement" });

    expect(result.satisfied).toBe(true);
    expect(result.discharged).toEqual(["O-002", "O-003", "O-004"]);
    expect(result.outstanding).toEqual([]);
    expect(result.byCode).toEqual({ PARTIAL: 3 });
  });

  it("NON-VACUITY: drop the `discharge` field and the same rows fail as `no-code`", () => {
    // This is the measured shape — `state.jsonl` listed ten obligation ids and
    // answered none, and the old `test -s` gate passed it. Listing is not
    // discharging, and if this test ever goes green the one above proves nothing.
    const dir = workspace(doc(), {
      enforcement: rowsFor(["O-002", "O-003", "O-004"]).map(({ discharge: _drop, ...rest }) => rest),
    });
    const result = checkDischarge({ dir, family: "enforcement" });

    expect(result.satisfied).toBe(false);
    expect(result.outstanding.map((e) => e.status)).toEqual(["no-code", "no-code", "no-code"]);
  });

  it("NON-VACUITY: an obligation with no row at all stays undischarged", () => {
    const dir = workspace(doc(), { enforcement: rowsFor(["O-002", "O-003"]) });
    const result = checkDischarge({ dir, family: "enforcement" });

    expect(result.satisfied).toBe(false);
    expect(result.outstanding.map((e) => e.obligation)).toEqual(["O-004"]);
    expect(result.outstanding[0].status).toBe("undischarged");
  });

  it("every code the block names is one the gate accepts", () => {
    // The two lists are declared in two files. A fifth code added to the prose,
    // or a rename in `DISCHARGE_CODES`, has to break something.
    for (const code of DISCHARGE_CODES) {
      const dir = workspace(doc(), {
        enforcement: rowsFor(["O-002", "O-003", "O-004"], { discharge: code }),
      });
      const result = checkDischarge({ dir, family: "enforcement" });
      expect(result.satisfied, `${code} should discharge`).toBe(true);
      expect(result.byCode).toEqual({ [code]: 3 });
    }
  });
});

describe("what the block must NOT blur", () => {
  it("a NOT MEASURED family renders its reason and no row shape at all", () => {
    // NOT MEASURED, "no obligations could be built", and "surveyed and found
    // nothing" are three different facts. A discharge contract printed over the
    // first of them would be asking for answers to questions nobody asked.
    const block = renderFamilyBlock(doc(), "tests");
    expect(block).toMatch(/NOT MEASURED: no coverage report/);
    expect(block).toMatch(/NOT a pass/);
    expect(block).not.toMatch(/"discharge":/);
    expect(block).not.toMatch(/"failureScenario":/);
  });

  it("a measured family with zero obligations gets no row shape either", () => {
    const block = renderFamilyBlock(
      doc({ degraded: [{ extractor: "facts", reason: "tsconfig unparsable" }], coverage: "degraded" }),
      "security",
    );
    expect(block).toMatch(/No security obligations could be built/);
    expect(block).not.toMatch(/"discharge":/);
  });
});

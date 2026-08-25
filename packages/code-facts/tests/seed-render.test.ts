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

import { checkDischarge, DISCHARGE_CODES, renderDischargeCheck } from "../src/discharge.js";
import { renderFamilyBlock } from "../src/seed-render.js";
import type { StagedDiff } from "../src/schema.js";
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
    contract: "full",
    minting: { allInDiff: false, registrations: false },
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

/**
 * `--contract minimal` — the CONTROL for the 2026-08-23 result.
 *
 * That change moved discharge compliance 0/33 → 33/33 and the union of matched
 * gold 4-of-5 → **0-of-5**, over three repeats, and it moved TWO variables at
 * once: the question the obligations ask, and whether the seed is delivered
 * reliably at all. `minimal` holds the delivery fix and puts the question back,
 * so one arm separates them.
 *
 * The assertions therefore come in pairs — what `minimal` must NOT carry, and
 * what it must still carry — because a control that changed anything else would
 * measure that instead.
 */
describe("--contract minimal restores the pre-2026-08-23 block", () => {
  const minimal = (family: SeedFamily = "enforcement") =>
    renderFamilyBlock(doc({ contract: "minimal" }), family);

  it("prescribes a row with NO field to record a discharge in — the measured bug, on purpose", () => {
    // 0/31, 0/34, 0/40 obligations carried a code under exactly this block, and
    // that is what is being reproduced. If this test ever goes green against a
    // row that CAN hold a code, the arm is measuring `full` twice.
    const rendered = minimal();
    expect(rendered).not.toMatch(/"discharge":/);
    expect(rendered).not.toMatch(/"failureScenario":/);
    expect(rendered).toContain("Append one JSON object per hypothesis to");
    expect(rendered).not.toContain("Append one JSON object per obligation to");
  });

  it("carries no id checklist, no ledger pointer and no worked exemplar", () => {
    const rendered = minimal();
    expect(rendered).not.toContain("none optional:");
    expect(rendered).not.toContain("discharge --ledger");
    expect(rendered).not.toContain("WORKED EXAMPLE");
    // The exemplar is the only line in a `full` block that parses as a JSON
    // object. There is no such line here at all.
    const jsonLines = rendered.split("\n").filter((line) => {
      try {
        const v: unknown = JSON.parse(line.trim());
        return typeof v === "object" && v !== null && !Array.isArray(v);
      } catch {
        return false;
      }
    });
    expect(jsonLines).toEqual([]);
  });

  it("prints the obligation's requirement as `discharge:` again, and says why it is inert", () => {
    // The `expects:` rename fixes a trap that needs a row-level `discharge`
    // field for `either` to be copied INTO — and this row has none. Restoring
    // the old label keeps the control faithful to the runs that scored 4-of-5;
    // the gate degrading to `test -s` is what makes the trap unreachable.
    const rendered = minimal();
    expect(rendered).toMatch(/O-003\s+\[enforcement]\s+discharge: either/);
    expect(rendered).not.toMatch(/\bexpects:/);
  });

  it("still names the four codes, and still over-produces — those predate the change", () => {
    // `minimal` is NOT "no discharge contract". The codes and "Reading a file is
    // not a discharge" are older than the bug; what is gone is the mechanism
    // that made a code recordable.
    const rendered = minimal();
    for (const code of DISCHARGE_CODES) expect(rendered).toContain(code);
    expect(rendered).toContain("Reading a file is not a discharge");
    expect(rendered).toContain("OVER-PRODUCE");
  });

  it("is still NEVER EMPTY — delivery is held constant, and that is the point", () => {
    // The never-empty rule is the DELIVERY half of the same commit, the half
    // that stopped ~24% of survey branches losing their seed. Restoring
    // `return ""` here would re-confound the two causes this arm exists to
    // separate.
    for (const family of ["contract", "enforcement", "security", "state", "tests"] as SeedFamily[]) {
      expect(minimal(family).length, family).toBeGreaterThan(0);
    }
    expect(minimal("tests")).toMatch(/NOT MEASURED: no coverage report/);
  });

  it("leaves `full` alone: an absent `contract` field renders exactly what an explicit `full` does", () => {
    // The baseline of a control arm must not move. A document written before
    // this switch existed has no field at all and has to read as `full`.
    const { contract: _drop, ...legacy } = doc();
    const asLegacy = renderFamilyBlock(legacy as ObligationsDocument, "enforcement");
    expect(asLegacy).toBe(renderFamilyBlock(doc({ contract: "full" }), "enforcement"));
    expect(asLegacy).not.toBe(minimal());
  });
});

/**
 * The gate under `minimal`, and it is the half that costs money to get wrong.
 *
 * The block above asks for no discharge code. `checkDischarge` demands one per
 * obligation. Left alone, five of six branches would fail their `until_bash` on
 * every run of the control arm, over a field the survey was never told to write
 * — WP3's `$LL_FAMILY` bug rebuilt out of a config key. So an explicit
 * `contract: "minimal"` degrades to the same `test -s` floor an unreadable
 * document degrades to.
 */
describe("the discharge gate degrades under `minimal`", () => {
  /** One free-form row, citing nothing — the pre-change measured shape. */
  const freeForm = [{ claim: "the nonce lifetime is never compared server-side" }];

  it("passes on one parsed row, and says it graded nothing", () => {
    const dir = workspace(doc({ contract: "minimal" }), { enforcement: freeForm });
    const result = checkDischarge({ dir, family: "enforcement" });

    expect(result.satisfied).toBe(true);
    expect(result.contract).toBe("minimal");
    expect(result.discharged).toEqual([]);
    expect(result.notes.join(" ")).toMatch(/contract: "minimal"/);
    expect(result.notes.join(" ")).toMatch(/test -s/);
  });

  it("NON-VACUITY: the SAME rows under `full` fail — the degrade is the contract, not the rows", () => {
    // If this passed, the branch above would be indistinguishable from the gate
    // simply having stopped working.
    const dir = workspace(doc(), { enforcement: freeForm });
    const result = checkDischarge({ dir, family: "enforcement" });

    expect(result.satisfied).toBe(false);
    expect(result.outstanding.map((e) => e.status)).toEqual([
      "undischarged",
      "undischarged",
      "undischarged",
    ]);
  });

  it("is a FLOOR, not a pass: no file at all still fails", () => {
    // `test -s` is one line of any content — but it is still one line. A branch
    // that wrote nothing has not cleared it under either contract.
    const dir = workspace(doc({ contract: "minimal" }), {});
    const result = checkDischarge({ dir, family: "enforcement" });

    expect(result.satisfied).toBe(false);
    expect(result.fileState).toBe("missing");
  });

  it("does not print a per-obligation todo list nobody was asked for", () => {
    // The entries are real — nothing WAS discharged — but their detail line is
    // imperative ("answer it with QUOTE, ABSENT, PARTIAL or PROBE"), and thirty
    // of those under a note saying none was requested reads as the failure the
    // note is denying.
    const dir = workspace(doc({ contract: "minimal" }), { enforcement: freeForm });
    const rendered = renderDischargeCheck(checkDischarge({ dir, family: "enforcement" }));
    expect(rendered).toMatch(/contract: "minimal"/);
    expect(rendered).not.toMatch(/answer it with QUOTE/);
  });

  it("an unknown --family stays fatal — a wiring bug is not an arm", () => {
    const dir = workspace(doc({ contract: "minimal" }), { enforcement: freeForm });
    const result = checkDischarge({ dir, family: "enfrocement" });
    expect(result.satisfied).toBe(false);
    expect(result.familyError).toMatch(/WIRING bug/);
  });
});

/**
 * THE STAGED DIFF SECTION — the f1 lever's half of the brief.
 *
 * The five survey branches spend ~30 of ~93 bash calls per case re-deriving ONE
 * fixed merge-base range that `facts.json` already holds, and surveys are ~75%
 * of a case's spend. The section tells the branch the patch is already on disk.
 *
 * Three states and three different paragraphs, because they are three different
 * facts: staged, staging FAILED, never staged. What is asserted hardest is that
 * the section is NEVER SILENTLY OMITTED — an absent section reads to a survey as
 * "this deployment has no staged diff", which is the *"we could not look"* /
 * *"we looked and it is clean"* conflation the whole pipeline is built against.
 */
describe("the staged-diff section", () => {
  const stagedRecord = (over: Partial<StagedDiff> = {}): StagedDiff => ({
    dir: ".lastlight/pr-review/diff",
    index: ".lastlight/pr-review/diff/index.md",
    files: [
      {
        path: "src/config.ts",
        status: "modified",
        renamedFrom: null,
        hunks: ["12-18"],
        patch: "src__config.ts.patch",
        bytes: 300,
      },
      {
        path: "src/server/auth.ts",
        status: "modified",
        renamedFrom: null,
        hunks: ["70-76"],
        patch: "src__server__auth.ts.patch",
        bytes: 400,
      },
      {
        path: "src/unrelated.ts",
        status: "added",
        renamedFrom: null,
        hunks: ["1-9"],
        patch: "src__unrelated.ts.patch",
        bytes: 100,
      },
    ],
    skipped: [],
    ...over,
  });

  it("points at the index and the patch directory, and forbids re-deriving the range", () => {
    const block = renderFamilyBlock(doc(), "enforcement", stagedRecord());
    expect(block).toContain(".lastlight/pr-review/diff/index.md");
    expect(block).toMatch(/DO NOT RE-DERIVE THE RANGE with `git diff` or `git show`/);
    // The reason, not just the rule — a rule without its reason is the first
    // thing a fork drops.
    expect(block).toMatch(/two-dot diff creeps back in/);
  });

  it("frames the patch as a STARTING POINT, not a scope", () => {
    // The over-suppression result: the first cut said "read the staged patch
    // INSTEAD OF running `git diff`" and total survey bash calls fell 848 → 399
    // while the eliminated range re-derivation accounts for only ~276 of it —
    // ~170 greps, file reads and reference traces went with it, and internal
    // recall fell 21/25 → 12/25. Access never changed; the framing did. So the
    // affordance is asserted beside the one surviving prohibition.
    const block = renderFamilyBlock(doc(), "enforcement", stagedRecord());
    expect(block).toMatch(/STARTING POINT, NOT YOUR SCOPE/);
    expect(block).toMatch(/FULL CHECKOUT/);
    expect(block).toMatch(/callers and references the patch does not show/);
    // Nothing may read as a ban on looking beyond the patch.
    expect(block).not.toMatch(/INSTEAD OF RUNNING/);
  });

  it("names the files THIS family's obligations point at, with their patches", () => {
    // `ob()` builds every obligation over `src/config.ts` → `src/server/auth.ts`.
    const block = renderFamilyBlock(doc(), "enforcement", stagedRecord());
    expect(block).toContain("src/config.ts   → .lastlight/pr-review/diff/src__config.ts.patch");
    expect(block).toContain(
      "src/server/auth.ts   → .lastlight/pr-review/diff/src__server__auth.ts.patch",
    );
    // …and only those. A file no obligation of this family names is in the
    // index, which the section points at; listing it here is noise in a block a
    // cheap model reads.
    expect(block).not.toContain("src__unrelated.ts.patch");
  });

  it("never prints an ABSOLUTE path, and says why not to build one", () => {
    // Measured across three stored runs: 98 of 98 relative first-turn reads from
    // a survey branch resolved and 0 of 27 workspace-root-absolute ones did,
    // because the only absolute path a branch holds is its skill bundle — one
    // directory ABOVE the checkout the deterministic phases write in.
    const block = renderFamilyBlock(doc(), "enforcement", stagedRecord());
    expect(block).not.toMatch(/\s\/[\w/.-]*\.lastlight/);
    expect(block).toMatch(/relative to your working directory/);
    expect(block).toMatch(/skill bundle, which sits one directory ABOVE the checkout/);
  });

  it("says NOT AVAILABLE, loudly, when nobody staged — it is never omitted", () => {
    const block = renderFamilyBlock(doc(), "enforcement", undefined);
    expect(block).toContain("STAGED DIFF: NOT AVAILABLE");
    expect(block).toContain("was not asked to stage");
    // MISSING AFFORDANCE, not an empty diff — and the escape hatch spelled with
    // three dots, since sending a model back to git without them re-opens the
    // exact bug staging closes.
    expect(block).toMatch(/MISSING AFFORDANCE, not an empty diff/);
    expect(block).toContain("git diff origin/<baseBranch>...HEAD");
    // A branch that has to derive its own range needs the affordance MORE, not
    // less: the checkout is whole either way.
    expect(block).toMatch(/FULL CHECKOUT either way/);
  });

  it("distinguishes `files: null` (tried and failed) from nobody having tried", () => {
    // `null` ≠ `[]` ≠ absent, at the layer where the difference reaches a model.
    const failed = renderFamilyBlock(doc(), "enforcement", stagedRecord({ files: null }));
    expect(failed).toContain("STAGED DIFF: NOT AVAILABLE");
    expect(failed).toContain("TRIED to stage");
    expect(failed).toContain(".lastlight/pr-review/diff/index.md");
    // The two notices are not the same words — a reader can tell which happened.
    expect(failed).not.toContain("was not asked to stage");
  });

  it("keeps an over-ceiling file readable as PRESENT-but-unstaged", () => {
    const block = renderFamilyBlock(
      doc(),
      "enforcement",
      stagedRecord({
        files: [
          {
            path: "src/config.ts",
            status: "modified",
            renamedFrom: null,
            hunks: ["12-18"],
            patch: null,
            bytes: 0,
          },
        ],
      }),
    );
    expect(block).toContain("src/config.ts   → NOT STAGED");
    expect(block).toMatch(/A missing patch is\nnot an unchanged file/);
  });

  it("reaches the family with NO obligations too — the branch that needs it most", () => {
    // That block's own instruction is "work the diff for this family's question
    // directly", which is precisely what sends an unseeded pass off to re-derive
    // the range by hand.
    const block = renderFamilyBlock(doc(), "security", stagedRecord());
    expect(block).toContain("No security obligations could be built");
    expect(block).toContain("STAGED DIFF: this PR's patch is already on disk");
  });

  it("renders under BOTH contracts — it is delivery, not the question", () => {
    // `minimal` exists to hold DELIVERY constant while the question changes
    // (the same reason the never-empty rule holds under both). A control arm
    // that also withheld the diff would be measuring two variables.
    for (const contract of ["full", "minimal"] as const) {
      const block = renderFamilyBlock(doc({ contract }), "enforcement", stagedRecord());
      expect(block, contract).toContain("STAGED DIFF: this PR's patch is already on disk");
    }
  });

  it("does not disturb the discharge round trip", () => {
    // The exemplar is still the only JSON object line in the block, and it still
    // satisfies the gate. A section that introduced a second parseable line
    // would break `exampleRowIn`'s premise ("one line each").
    const block = renderFamilyBlock(doc(), "enforcement", stagedRecord());
    expect(exampleRowIn(block).discharge).toBe("PARTIAL");
  });
});

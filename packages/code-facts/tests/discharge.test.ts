/**
 * `discharge` — the survey's exit gate.
 *
 * The property under test is the one the six `until_bash` lines never had:
 * **a survey that writes one line for ten obligations must not pass.** That is
 * the measured shape, not a hypothetical — `prreview__skillspro-1587-r1` wrote
 *
 *     {"claim": "no state hypothesis", "obligationIds": ["O-018", …]}
 *
 * one line, ten obligations, and `test -s` passed it. So every test here is
 * about an obligation id and whether something answered it — never about
 * whether the file parses.
 *
 * Four of them carry the epistemics directly:
 *
 * - **A missing `hypotheses/<family>.jsonl` is not an empty one.** Nobody
 *   looked, versus looked and recorded nothing. `null` ≠ `[]`, in the gate
 *   where collapsing it is most expensive.
 * - **A NOT MEASURED family is not a failure.** The seeding surface was absent,
 *   so there was never anything to discharge, and failing a family for the
 *   absence of the thing it audits is how a gate takes a run down.
 * - **A zero-obligation family passes.** Nothing mechanical was asked of it.
 * - **`--ledger` always exits 0 and writes nothing.** Its caller is the survey's
 *   own bash tool, where the gate's "iterate again" reads as a tool failure.
 *
 * Fixtures are real files in a real tree, per this package's house rule: every
 * claim here is a claim about what is on disk, and mocking the filesystem would
 * let the claim be wrong while the test passed.
 */
import { afterAll, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { runCli } from "../src/cli.js";
import { checkDischarge, dischargeExitCode, renderDischargeCheck, renderDischargeLedger } from "../src/discharge.js";
import { EXIT_DEGRADED, EXIT_OK, EXIT_UNAVAILABLE } from "../src/errors.js";

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** One obligation, in the shape `seed.ts` writes it. */
function ob(id: string, family: string, over: Record<string, unknown> = {}) {
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

/** The families block, which is where `measured` / NOT MEASURED lives. */
function fam(family: string, obligations: number, over: Record<string, unknown> = {}) {
  return { family, obligations, measured: true, notMeasuredReason: null, ...over };
}

interface Fixture {
  dir: string;
  root: string;
  /** Every file under the pr-review dir, path → contents. */
  snapshot(): Record<string, string>;
}

/**
 * A `.lastlight/pr-review` tree, laid out exactly as the phases write it.
 *
 * `hypotheses` omitted for a family ⇒ **no file** (nobody looked). An empty
 * array ⇒ an EMPTY file (looked, recorded nothing). The two are different facts
 * and this helper has to be able to build both, or the tests below cannot tell
 * them apart either.
 */
function workspace(files: {
  obligations?: Record<string, unknown> | string;
  hypotheses?: Record<string, unknown[] | string>;
}): Fixture {
  const root = mkdtempSync(join(tmpdir(), "ll-discharge-"));
  dirs.push(root);
  const dir = join(root, ".lastlight", "pr-review");
  mkdirSync(join(dir, "hypotheses"), { recursive: true });

  if (files.obligations !== undefined) {
    const body =
      typeof files.obligations === "string"
        ? files.obligations
        : JSON.stringify(files.obligations, null, 2);
    writeFileSync(join(dir, "obligations.json"), `${body}\n`, "utf8");
  }
  for (const [family, rows] of Object.entries(files.hypotheses ?? {})) {
    const body =
      typeof rows === "string"
        ? rows
        : rows.map((r) => JSON.stringify(r)).join("\n") + (rows.length > 0 ? "\n" : "");
    writeFileSync(join(dir, "hypotheses", `${family}.jsonl`), body, "utf8");
  }
  return {
    dir,
    root,
    snapshot() {
      const out: Record<string, string> = {};
      const walk = (at: string): void => {
        for (const entry of readdirSync(at, { withFileTypes: true })) {
          const full = join(at, entry.name);
          if (entry.isDirectory()) walk(full);
          else out[relative(dir, full)] = readFileSync(full, "utf8");
        }
      };
      walk(dir);
      return out;
    },
  };
}

/** The document `seed` writes for a two-family PR. */
const doc = (over: Record<string, unknown> = {}) => ({
  version: 1,
  generatedAt: "2026-08-23T00:00:00.000Z",
  repo: "o/r",
  baseSha: "b",
  headSha: "h",
  coverage: "full",
  degraded: [],
  families: [fam("contract", 2), fam("enforcement", 1), fam("tests", 0)],
  obligations: [ob("O-001", "contract"), ob("O-002", "contract"), ob("O-003", "enforcement")],
  dropped: [],
  coverageSet: {
    selected: ["O-001", "O-002", "O-003"],
    sealed: true,
    reviewed: [],
    failed: [],
    waived: [],
    terminalState: "pending",
  },
  ...over,
});

const capture = () => {
  const out: string[] = [];
  return { out, io: { out: (s: string) => out.push(s), err: (s: string) => out.push(s) } };
};

// ── The whole point: N discharges, not one line ─────────────────────────────

describe("every obligation of the family carries a discharge code", () => {
  it("closes when each one does", () => {
    const { dir } = workspace({
      obligations: doc(),
      hypotheses: {
        contract: [
          { obligation: "O-001", discharge: "QUOTE", claim: "enforced at auth.ts:73" },
          { obligation: "O-002", discharge: "ABSENT", claim: "nothing compares it" },
        ],
      },
    });
    const result = checkDischarge({ dir, family: "contract" });
    expect(result.satisfied).toBe(true);
    expect(result.discharged).toEqual(["O-001", "O-002"]);
    expect(result.byCode).toEqual({ QUOTE: 1, ABSENT: 1 });
    expect(dischargeExitCode(result)).toBe(EXIT_OK);
  });

  it("does NOT close on an obligation nothing answered, and names it with its question", () => {
    const { dir } = workspace({
      obligations: doc(),
      hypotheses: { contract: [{ obligation: "O-001", discharge: "QUOTE", claim: "…" }] },
    });
    const result = checkDischarge({ dir, family: "contract" });
    expect(result.satisfied).toBe(false);
    expect(result.outstanding.map((e) => e.obligation)).toEqual(["O-002"]);
    expect(result.outstanding[0].status).toBe("undischarged");

    // "1 obligation outstanding" cannot be acted on. The id and the question can.
    const text = renderDischargeCheck(result);
    expect(text).toContain("1/2 obligations discharged");
    expect(text).toContain("O-002");
    expect(text).toContain("Quote the line that compares or enforces O-002");
  });

  it("REFUSES the one-line shape the real run wrote — listing is not discharging", () => {
    // `prreview__skillspro-1587-r1`, state.jsonl, verbatim in shape: one line,
    // every obligation id, no code. `test -s` passed this.
    const { dir } = workspace({
      obligations: doc(),
      hypotheses: {
        contract: [{ claim: "no contract hypothesis", obligationIds: ["O-001", "O-002"] }],
      },
    });
    const result = checkDischarge({ dir, family: "contract" });
    expect(result.satisfied).toBe(false);
    expect(result.outstanding.map((e) => e.status)).toEqual(["no-code", "no-code"]);
    // The row IS credited with naming them — the gap is the missing answer, and
    // saying which row named it is what makes the next iteration cheap.
    expect(result.outstanding[0].citedBy).toEqual(["contract-001"]);
    expect(renderDischargeCheck(result)).toContain("listing an obligation is not discharging it");
  });

  it("refuses a code that is not one of the four, distinctly from a missing one", () => {
    const { dir } = workspace({
      obligations: doc(),
      hypotheses: {
        contract: [
          { obligation: "O-001", discharge: "reviewed" },
          { obligation: "O-002", discharge: "either" },
        ],
      },
    });
    const result = checkDischarge({ dir, family: "contract" });
    expect(result.satisfied).toBe(false);
    expect(result.outstanding.map((e) => e.status)).toEqual(["bad-code", "bad-code"]);
    expect(result.outstanding[0].citedCode).toBe("reviewed");
    expect(renderDischargeCheck(result)).toContain("QUOTE / ABSENT / PARTIAL / PROBE");
  });

  it("takes `status` as well as `discharge` — a spelling a real survey reached for", () => {
    // spec.jsonl on the first real run wrote `{"id": "S-1", "status": "QUOTE"}`
    // unprompted. Refusing a spelling the model chose itself buys one more
    // iteration and nothing else.
    const { dir } = workspace({
      obligations: doc({ families: [fam("contract", 1)], obligations: [ob("O-001", "contract")] }),
      hypotheses: { contract: [{ obligation: "O-001", status: "partial", claim: "…" }] },
    });
    const result = checkDischarge({ dir, family: "contract" });
    expect(result.satisfied).toBe(true);
    expect(result.byCode).toEqual({ PARTIAL: 1 });
  });

  it("reads a row that discharges SEVERAL obligations at once", () => {
    const { dir } = workspace({
      obligations: doc(),
      hypotheses: {
        contract: [
          {
            claim: "surveyed both",
            obligations: [
              { id: "O-001", discharge: "QUOTE" },
              { id: "O-002", discharge: "ABSENT" },
            ],
          },
        ],
      },
    });
    expect(checkDischarge({ dir, family: "contract" }).satisfied).toBe(true);
  });

  it("lets a later row discharge what an earlier one only listed — the file is append-only", () => {
    const { dir } = workspace({
      obligations: doc(),
      hypotheses: {
        contract: [
          { claim: "first pass", obligationIds: ["O-001", "O-002"] },
          { obligation: "O-001", discharge: "QUOTE" },
          { obligation: "O-002", discharge: "PROBE", needsProbe: true },
        ],
      },
    });
    const result = checkDischarge({ dir, family: "contract" });
    expect(result.satisfied).toBe(true);
    expect(result.byCode).toEqual({ QUOTE: 1, PROBE: 1 });
  });

  it("does not read the PROSE — an id inside a claim is not a discharge", () => {
    // Counting a mention would restore "one line of any content passes" through
    // the back door, which is the entire defect this command exists to close.
    const { dir } = workspace({
      obligations: doc(),
      hypotheses: {
        contract: [{ claim: "O-001 and O-002 are both QUOTE — all obligations discharged" }],
      },
    });
    const result = checkDischarge({ dir, family: "contract" });
    expect(result.satisfied).toBe(false);
    expect(result.outstanding.map((e) => e.status)).toEqual(["undischarged", "undischarged"]);
  });

  it("grades only its OWN family's obligations, and says when a citation was another's", () => {
    const { dir } = workspace({
      obligations: doc(),
      hypotheses: {
        contract: [
          { obligation: "O-001", discharge: "QUOTE" },
          { obligation: "O-002", discharge: "QUOTE" },
          { obligation: "O-003", discharge: "ABSENT" },
        ],
      },
    });
    const result = checkDischarge({ dir, family: "contract" });
    expect(result.satisfied).toBe(true);
    expect(result.entries.map((e) => e.obligation)).toEqual(["O-001", "O-002"]);
    expect(result.foreign).toEqual(["O-003"]);
    expect(result.notes.join(" ")).toMatch(/name another family's obligations/);
    // …and enforcement is NOT discharged by contract's file.
    expect(checkDischarge({ dir, family: "enforcement" }).satisfied).toBe(false);
  });
});

// ── `null` ≠ `[]`: three states, never two ─────────────────────────────────

describe("no file at all is not an empty file", () => {
  it("distinguishes missing from empty, in the result AND in the exit code", () => {
    const missing = workspace({ obligations: doc() });
    const gone = checkDischarge({ dir: missing.dir, family: "contract" });
    expect(gone.fileState).toBe("missing");
    expect(gone.satisfied).toBe(false);
    expect(dischargeExitCode(gone)).toBe(EXIT_UNAVAILABLE);
    expect(gone.notes.join(" ")).toMatch(/NOBODY LOOKED/);

    const blank = workspace({ obligations: doc(), hypotheses: { contract: [] } });
    const empty = checkDischarge({ dir: blank.dir, family: "contract" });
    expect(empty.fileState).toBe("empty");
    expect(empty.satisfied).toBe(false);
    expect(dischargeExitCode(empty)).toBe(EXIT_DEGRADED);
    expect(empty.notes.join(" ")).toMatch(/exists and holds no parsed row/);

    // Both fail — but a reader can tell which happened, which is the point.
    expect(dischargeExitCode(gone)).not.toBe(dischargeExitCode(empty));
  });

  it("calls a file of only unparseable lines EMPTY, and counts the lines", () => {
    const { dir } = workspace({
      obligations: doc(),
      hypotheses: { contract: "not json at all\n{ also not\n" },
    });
    const result = checkDischarge({ dir, family: "contract" });
    expect(result.fileState).toBe("empty");
    expect(result.malformed).toBe(2);
    expect(result.notes.join(" ")).toMatch(/2 unparseable JSONL line/);
    expect(result.satisfied).toBe(false);
  });

  it("counts a malformed line beside the good ones rather than skipping it", () => {
    const { dir } = workspace({
      obligations: doc({ families: [fam("contract", 1)], obligations: [ob("O-001", "contract")] }),
      hypotheses: { contract: `{"obligation":"O-001","discharge":"QUOTE"}\nnot json\n` },
    });
    const result = checkDischarge({ dir, family: "contract" });
    expect(result.satisfied).toBe(true);
    expect(result.malformed).toBe(1);
    expect(result.rows).toBe(1);
  });
});

// ── The three ways a family legitimately has nothing to discharge ───────────

describe("a family with nothing to discharge", () => {
  it("passes when it is NOT MEASURED, and does not read as clean", () => {
    // `tests` on every run so far: no coverage artifact, so uncovered lines are
    // UNKNOWN rather than none. Failing here would fail a run for the absence of
    // the thing the gate audits.
    const { dir } = workspace({
      obligations: doc({
        families: [
          fam("tests", 0, {
            measured: false,
            notMeasuredReason: "no coverage artifact was read, so uncovered changed lines are UNKNOWN rather than none",
          }),
        ],
        obligations: [],
      }),
      hypotheses: { tests: [{ claim: "notMeasured", obligation: "tests/notMeasured" }] },
    });
    const result = checkDischarge({ dir, family: "tests" });
    expect(result.satisfied).toBe(true);
    expect(result.measured).toBe(false);
    expect(result.notes.join(" ")).toMatch(/NOT MEASURED.*NOT a clean result/s);
    expect(dischargeExitCode(result)).toBe(EXIT_OK);
  });

  it("passes a NOT MEASURED family even with no hypotheses file", () => {
    const { dir } = workspace({
      obligations: doc({
        families: [fam("spec", 0, { measured: false, notMeasuredReason: "seeded harness-side" })],
        obligations: [],
      }),
    });
    const result = checkDischarge({ dir, family: "spec" });
    expect(result.satisfied).toBe(true);
    expect(result.fileState).toBe("missing");
  });

  it("passes a family with ZERO obligations, and says that is not a clean bill of health", () => {
    const { dir } = workspace({
      obligations: doc({ families: [fam("security", 0)], obligations: [] }),
      hypotheses: { security: [{ claim: "no security hypothesis" }] },
    });
    const result = checkDischarge({ dir, family: "security" });
    expect(result.satisfied).toBe(true);
    expect(result.entries).toEqual([]);
    expect(result.notes.join(" ")).toMatch(/not evidence the family is clean/);
  });

  it("still names the missing file when a zero-obligation family never wrote one", () => {
    // It passes — nothing mechanical was asked of it — but the two facts stay
    // separable in the output, because "the survey never ran" and "the survey
    // ran and had nothing to say" are not the same run.
    const { dir } = workspace({
      obligations: doc({ families: [fam("security", 0)], obligations: [] }),
    });
    const result = checkDischarge({ dir, family: "security" });
    expect(result.satisfied).toBe(true);
    expect(result.fileState).toBe("missing");
    expect(result.notes.join(" ")).toMatch(/NOBODY LOOKED/);
  });

  it("grades obligations that exist even when the header says NOT MEASURED", () => {
    // A contradiction in the document. An obligation that exists is checkable
    // whatever the header claims, and grading it is strictly more informative.
    const { dir } = workspace({
      obligations: doc({
        families: [fam("tests", 1, { measured: false, notMeasuredReason: "no coverage artifact" })],
        obligations: [ob("O-001", "tests")],
      }),
      hypotheses: { tests: [{ claim: "notMeasured" }] },
    });
    const result = checkDischarge({ dir, family: "tests" });
    expect(result.satisfied).toBe(false);
    expect(result.notes.join(" ")).toMatch(/marked NOT MEASURED yet carries 1 obligation/);
  });
});

// ── obligations.json itself ────────────────────────────────────────────────

describe("the obligations document", () => {
  it("falls back to the `test -s` floor when it cannot be read, LOUDLY", () => {
    // `pr-review.yaml` runs `seed … || true`, so this file is not guaranteed. A
    // gate demanding it would be unsatisfiable by the agent — WP3's original
    // `$LL_FAMILY` bug, which burned every iteration against a condition that
    // meant nothing. So: degrade to the floor, and say the grading did not run.
    const { dir } = workspace({ hypotheses: { contract: [{ claim: "worked the diff directly" }] } });
    const result = checkDischarge({ dir, family: "contract" });
    expect(result.documentError).toMatch(/obligations\.json/);
    expect(result.satisfied).toBe(true);
    expect(result.notes.join(" ")).toMatch(/NOTHING was graded/);
    expect(dischargeExitCode(result)).toBe(EXIT_OK);
  });

  it("still fails the floor when there is no hypotheses file either", () => {
    const { dir } = workspace({});
    const result = checkDischarge({ dir, family: "contract" });
    expect(result.satisfied).toBe(false);
    expect(dischargeExitCode(result)).toBe(EXIT_UNAVAILABLE);
  });

  it("treats a document that is not a seeder document the same way", () => {
    const { dir } = workspace({
      obligations: "{ not json",
      hypotheses: { contract: [{ claim: "x" }] },
    });
    expect(checkDischarge({ dir, family: "contract" }).documentError).not.toBeNull();

    const shaped = workspace({
      obligations: { version: 1, coverage: "full" },
      hypotheses: { contract: [{ claim: "x" }] },
    });
    expect(checkDischarge({ dir: shaped.dir, family: "contract" }).documentError).toMatch(
      /not a seeder document/,
    );
  });

  it("does not crash on an obligation missing the fields it only PRINTS", () => {
    // A gate that throws takes the survey phase down over a seeder bug in a
    // field it never grades on. A gate that can crash is not a gate.
    const { dir } = workspace({
      obligations: doc({
        families: [fam("contract", 3)],
        obligations: [
          { id: "O-001", family: "contract" },
          { family: "contract", question: "no id at all" },
          ob("O-003", "contract"),
        ],
      }),
      hypotheses: { contract: [{ obligation: "O-003", discharge: "QUOTE" }] },
    });
    const result = checkDischarge({ dir, family: "contract" });
    // The unusable row is skipped; the rest are graded and rendered.
    expect(result.entries.map((e) => e.obligation)).toEqual(["O-001", "O-003"]);
    expect(result.satisfied).toBe(false);
    expect(renderDischargeCheck(result)).toContain("(no question recorded on O-001)");
    expect(renderDischargeLedger(result)).toContain("O-001");
  });

  it("is FATAL on a family the document does not name — that is a wiring bug", () => {
    // The `$LL_FAMILY`-was-never-set shape. Nothing a survey writes can fix a
    // misspelled --family, so it must break at the wiring rather than pass.
    const { dir } = workspace({ obligations: doc(), hypotheses: { contract: [] } });
    const result = checkDischarge({ dir, family: "spec" });
    expect(result.familyError).toMatch(/unknown family "spec"/);
    expect(result.satisfied).toBe(false);
    expect(dischargeExitCode(result)).toBe(EXIT_UNAVAILABLE);
    expect(renderDischargeCheck(result)).toContain("WIRING bug");
  });
});

// ── The exit-code contract, which is what `until_bash` actually reads ───────

describe("the gate on a command line", () => {
  it("exits 0 when every obligation is discharged and 3 when one is not", () => {
    const broken = workspace({
      obligations: doc(),
      hypotheses: { contract: [{ obligation: "O-001", discharge: "QUOTE" }] },
    });
    const first = capture();
    expect(runCli(["discharge", "--dir", broken.dir, "--family", "contract"], first.io)).toBe(
      EXIT_DEGRADED,
    );
    expect(first.out.join("\n")).toContain("O-002");

    const whole = workspace({
      obligations: doc(),
      hypotheses: {
        contract: [
          { obligation: "O-001", discharge: "QUOTE" },
          { obligation: "O-002", discharge: "ABSENT" },
        ],
      },
    });
    expect(runCli(["discharge", "--dir", whole.dir, "--family", "contract"], capture().io)).toBe(
      EXIT_OK,
    );
  });

  it("exits 2 with no --family at all, rather than grading `hypotheses/.jsonl`", () => {
    const { dir } = workspace({ obligations: doc() });
    const { out, io } = capture();
    expect(runCli(["discharge", "--dir", dir], io)).toBe(EXIT_UNAVAILABLE);
    expect(out.join("\n")).toMatch(/--family <f> is required/);
  });

  it("exits 2 when the survey wrote no file at all", () => {
    const { dir } = workspace({ obligations: doc() });
    expect(runCli(["discharge", "--dir", dir, "--family", "contract"], capture().io)).toBe(
      EXIT_UNAVAILABLE,
    );
  });

  it("is reachable through the usage text, so `--help` documents the gate", () => {
    const { out, io } = capture();
    runCli(["discharge", "--help"], io);
    expect(out.join("\n")).toContain("--family <f>");
  });
});

// ── `--ledger`: the checklist half, and its DIFFERENT exit contract ─────────

describe("the discharge ledger", () => {
  it("lists every obligation with [x]/[ ] and its question", () => {
    const { dir } = workspace({
      obligations: doc(),
      hypotheses: { contract: [{ obligation: "O-001", discharge: "QUOTE" }] },
    });
    const text = renderDischargeLedger(checkDischarge({ dir, family: "contract" }));
    expect(text).toContain("1/2 obligations discharged");
    expect(text).toContain("[x] O-001");
    expect(text).toContain("[ ] O-002");
    expect(text).toContain("Quote the line that compares or enforces O-002");
    expect(text).toContain("OUTSTANDING — 1 of 2");
  });

  it("ALWAYS exits 0 — it reports, it does not grade", () => {
    const { dir } = workspace({
      obligations: doc(),
      hypotheses: { contract: [{ obligation: "O-001", discharge: "QUOTE" }] },
    });
    expect(runCli(["discharge", "--dir", dir, "--family", "contract"], capture().io)).toBe(
      EXIT_DEGRADED,
    );
    const led = capture();
    expect(
      runCli(["discharge", "--dir", dir, "--family", "contract", "--ledger"], led.io),
    ).toBe(EXIT_OK);
    expect(led.out.join("\n")).toContain("O-002");
  });

  it("exits 0 even when there is nothing to grade at all", () => {
    // Iteration 1 reaches this before anything has been written. A survey that
    // got a non-zero from its own bash tool would read it as a tool failure.
    const { dir } = workspace({});
    expect(
      runCli(["discharge", "--dir", dir, "--family", "contract", "--ledger"], capture().io),
    ).toBe(EXIT_OK);

    const unknown = workspace({ obligations: doc() });
    expect(
      runCli(["discharge", "--dir", unknown.dir, "--family", "nope", "--ledger"], capture().io),
    ).toBe(EXIT_OK);
  });

  it("writes NOTHING — the ledger is a read, and so is the gate", () => {
    const fx = workspace({
      obligations: doc(),
      hypotheses: { contract: [{ obligation: "O-001", discharge: "QUOTE" }] },
    });
    const before = JSON.stringify(fx.snapshot());
    runCli(["discharge", "--dir", fx.dir, "--family", "contract", "--ledger"], capture().io);
    runCli(["discharge", "--dir", fx.dir, "--family", "contract"], capture().io);
    expect(JSON.stringify(fx.snapshot())).toBe(before);
    // Not even for a family that has no file: a gate that created one would
    // manufacture the "looked" it exists to measure.
    runCli(["discharge", "--dir", fx.dir, "--family", "enforcement"], capture().io);
    expect(Object.keys(fx.snapshot())).toEqual(Object.keys(JSON.parse(before)));
  });

  it("NEVER truncates the list — the cap is on each question, not the count", () => {
    // `renderDischargeCheck` stops at 20 because it is a log line. A checklist
    // that elided entries would reproduce the omission it exists to prevent.
    const many = Array.from({ length: 45 }, (_, i) =>
      ob(`O-${String(i + 1).padStart(3, "0")}`, "contract", {
        question: `${"x".repeat(400)}. trailing`,
      }),
    );
    const { dir } = workspace({
      obligations: doc({ families: [fam("contract", 45)], obligations: many }),
      hypotheses: { contract: [] },
    });
    const result = checkDischarge({ dir, family: "contract" });

    const gate = renderDischargeCheck(result);
    expect(gate).toContain("… and 25 more outstanding");

    const ledger = renderDischargeLedger(result);
    for (const o of many) expect(ledger).toContain(o.id);
    expect(ledger).not.toMatch(/and \d+ more/);
    // The bound is on the CHECKLIST — every `[ ] O-nnn` row and the question
    // under it. (Not on the header, which quotes `--dir` verbatim and is as
    // long as the caller's path; here that is a tmpdir.)
    const checklist = ledger
      .split("\n")
      .filter((l) => /^ {2}\[[ x]\] /.test(l) || /^ {8}\S/.test(l));
    expect(checklist).toHaveLength(90);
    for (const line of checklist) expect(line.length).toBeLessThan(140);
  });

  it("says so plainly when every obligation is discharged", () => {
    const { dir } = workspace({
      obligations: doc({ families: [fam("contract", 1)], obligations: [ob("O-001", "contract")] }),
      hypotheses: { contract: [{ obligation: "O-001", discharge: "ABSENT" }] },
    });
    const text = renderDischargeLedger(checkDischarge({ dir, family: "contract" }));
    expect(text).toContain("Every obligation carries a discharge code");
  });

  it("degrades sanely with zero obligations, and does not read as a completed survey", () => {
    const { dir } = workspace({
      obligations: doc({ families: [fam("security", 0)], obligations: [] }),
      hypotheses: { security: [{ claim: "no security hypothesis" }] },
    });
    const text = renderDischargeLedger(checkDischarge({ dir, family: "security" }));
    expect(text).toMatch(/no obligations to discharge/);
    expect(text).toMatch(/NOT evidence that the family is clean/);
  });
});

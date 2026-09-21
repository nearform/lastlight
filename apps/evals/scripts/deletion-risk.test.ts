/**
 * `scripts/deletion-risk.ts` — the deletion join.
 *
 * The arithmetic is trivial (count some rows). Every test here is a way to get
 * the JOIN wrong, and each one corresponds to a claim the script prints:
 *
 *  - **Positional identity.** `<family>-NNN` comes from the filename plus
 *    append order. A blank line consumes no ordinal, an unparseable line
 *    consumes no ordinal, and a line that parses to a scalar DOES — the rules
 *    `code-facts` ingests by. Off by one and the script reports a real deletion
 *    as unjoinable, or worse, joins it to its neighbour's text and anchors.
 *  - **A model-declared id is an alias, never an override.** A row declaring
 *    `contract-001` from third position must not capture a citation meant for
 *    the real first row, and two rows declaring the same id resolve to neither.
 *  - **A missing transcript is a FLOOR BUG, not a statistic.** The conservation
 *    floor restores a drop whose citation does not resolve, so a drop that
 *    survived with an unresolvable `refutedBy` is a bug in the floor. It has to
 *    come out of the join as its own flag, not as a deletion like any other.
 *  - **The gold coincidence is file-level and a CEILING.** It must fire on the
 *    file regardless of line, fire on a QUOTE anchor as readily as on
 *    `bothEnds`, and the window bar must be a strict subset of it. Gold with no
 *    `file` can never coincide with anything.
 */
import { describe, expect, it } from "vitest";

import {
  indexHypotheses,
  joinDeletions,
  parseArgs,
  splitSite,
  transcriptCandidates,
  type GoldFinding,
  type HypothesisRow,
} from "./deletion-risk.js";

const jsonl = (...rows: unknown[]): string => rows.map((r) => JSON.stringify(r)).join("\n");

const join = (
  dropped: { hypothesis?: string; refutedBy?: string }[],
  hypotheses: Map<string, HypothesisRow>,
  aliases: Map<string, string>,
  gold: GoldFinding[] = [],
  opts: { exists?: (rel: string) => boolean; window?: number | null } = {},
) =>
  joinDeletions({
    run: "run",
    arm: "arm",
    instanceId: "case",
    dropped,
    hypotheses,
    aliases,
    transcriptExists: opts.exists ?? (() => true),
    gold,
    window: opts.window ?? null,
  });

describe("positional identity — the ordinal IS the id", () => {
  it("numbers rows from 1 per family, from the FILENAME not the row", () => {
    const { hypotheses } = indexHypotheses(
      new Map([
        ["contract", jsonl({ claim: "a", family: "wrong-family" }, { claim: "b" })],
        ["state", jsonl({ claim: "c" })],
      ]),
    );
    expect([...hypotheses.keys()]).toEqual(["contract-001", "contract-002", "state-001"]);
    // The row's own `family` must not be able to move another family's funnel.
    expect(hypotheses.get("contract-001")!.family).toBe("contract");
  });

  it("a blank line consumes no ordinal", () => {
    const { hypotheses } = indexHypotheses(new Map([["contract", `\n${jsonl({ claim: "a" })}\n\n${jsonl({ claim: "b" })}\n`]]));
    expect(hypotheses.get("contract-002")!.claim).toBe("b");
  });

  it("a torn final line consumes no ordinal, but a scalar line DOES", () => {
    // A killed run leaves half a line; a scalar is a row the model wrote badly.
    // Dropping the scalar would shift every later id by one and silently
    // mis-resolve every citation after it.
    const { hypotheses } = indexHypotheses(
      new Map([["contract", [JSON.stringify({ claim: "a" }), "42", '{"claim": "c"', JSON.stringify({ claim: "d" })].join("\n")]]),
    );
    expect(hypotheses.get("contract-002")!.claim).toBe("");
    expect(hypotheses.get("contract-003")!.claim).toBe("d");
  });
});

describe("a declared id is an alias, never an override", () => {
  it("resolves a citation written in the model's own vocabulary", () => {
    const { hypotheses, aliases } = indexHypotheses(new Map([["contract", jsonl({ id: "H7", claim: "a" })]]));
    const [row] = join([{ hypothesis: "H7", refutedBy: "probes/x.txt" }], hypotheses, aliases);
    expect(row.canonicalId).toBe("contract-001");
    expect(row.claim).toBe("a");
  });

  it("cannot shadow a canonical id from another position", () => {
    const { hypotheses, aliases } = indexHypotheses(
      new Map([["contract", jsonl({ claim: "first" }, { claim: "second" }, { id: "contract-001", claim: "impostor" })]]),
    );
    const [row] = join([{ hypothesis: "contract-001", refutedBy: "p" }], hypotheses, aliases);
    expect(row.claim).toBe("first");
  });

  it("two rows claiming one declared id resolve to NEITHER", () => {
    const { hypotheses, aliases } = indexHypotheses(new Map([["contract", jsonl({ id: "H", claim: "a" }, { id: "H", claim: "b" })]]));
    expect(join([{ hypothesis: "H", refutedBy: "p" }], hypotheses, aliases)[0].canonicalId).toBeNull();
  });

  it("an id naming no row at all is an UNJOINED row, not a silent skip", () => {
    const { hypotheses, aliases } = indexHypotheses(new Map([["contract", jsonl({ claim: "a" })]]));
    const rows = join([{ hypothesis: "contract-099", refutedBy: "p" }], hypotheses, aliases);
    expect(rows).toHaveLength(1);
    expect(rows[0].canonicalId).toBeNull();
    expect(rows[0].citedId).toBe("contract-099");
  });
});

describe("the refutedBy transcript — a missing one is a floor bug", () => {
  const { hypotheses, aliases } = indexHypotheses(new Map([["contract", jsonl({ claim: "a" })]]));

  it("resolves when the cited transcript is on disk", () => {
    const [row] = join([{ hypothesis: "contract-001", refutedBy: "probes/a.txt" }], hypotheses, aliases, [], {
      exists: (rel) => rel === "probes/a.txt",
    });
    expect(row.transcriptResolves).toBe(true);
  });

  it("does NOT resolve when the path is absent — the floor should have restored this drop", () => {
    const [row] = join([{ hypothesis: "contract-001", refutedBy: "probes/gone.txt" }], hypotheses, aliases, [], {
      exists: () => false,
    });
    expect(row.transcriptResolves).toBe(false);
  });

  it("a drop citing NOTHING is unbacked too, never charitably resolved", () => {
    const [row] = join([{ hypothesis: "contract-001" }], hypotheses, aliases);
    expect(row.refutedBy).toBeNull();
    expect(row.transcriptResolves).toBe(false);
  });
});

describe("coincidence with gold is file-level, and a ceiling", () => {
  const rows = indexHypotheses(
    new Map([
      [
        "contract",
        jsonl(
          { claim: "ends", bothEnds: { introducedAt: "src/users.ts:20", enforcedAt: "src/other.ts:5" } },
          { claim: "quoted", quotes: [{ path: "src/users.ts", line: 900 }] },
          { claim: "elsewhere", bothEnds: { introducedAt: "src/nothing.ts:1" } },
        ),
      ],
    ]),
  );
  const gold: GoldFinding[] = [{ file: "src/users.ts", line: 30, description: "g0" }, { description: "g1, no file" }];
  const dropped = [
    { hypothesis: "contract-001", refutedBy: "p" },
    { hypothesis: "contract-002", refutedBy: "p" },
    { hypothesis: "contract-003", refutedBy: "p" },
  ];

  it("fires on the file from either end, and on a quote", () => {
    const out = join(dropped, rows.hypotheses, rows.aliases, gold);
    expect(out[0].goldFileHits).toEqual([0]);
    expect(out[1].goldFileHits).toEqual([0]);
    expect(out[2].goldFileHits).toEqual([]);
  });

  it("gold with no file can never coincide — it is unlocated, not unhit", () => {
    expect(join(dropped, rows.hypotheses, rows.aliases, gold).every((r) => !r.goldFileHits.includes(1))).toBe(true);
  });

  it("the window bar is a strict subset of the file bar", () => {
    const out = join(dropped, rows.hypotheses, rows.aliases, gold, { window: 40 });
    expect(out[0].goldWindowHits).toEqual([0]); // line 20 vs gold line 30
    expect(out[1].goldWindowHits).toEqual([]); // line 900 — same file, nowhere near
    expect(out[1].goldFileHits).toEqual([0]);
  });

  it("without --window nothing is windowed, rather than everything", () => {
    expect(join(dropped, rows.hypotheses, rows.aliases, gold)[0].goldWindowHits).toEqual([]);
  });

  it("an unjoined deletion carries no anchors, so it can coincide with nothing — that is a BROKEN JOIN, not a clean result", () => {
    const [row] = join([{ hypothesis: "ghost", refutedBy: "p" }], rows.hypotheses, rows.aliases, gold, { window: 40 });
    expect(row.canonicalId).toBeNull();
    expect(row.anchors).toEqual([]);
    expect(row.goldFileHits).toEqual([]);
  });
});

describe("site parsing", () => {
  it("splits a path:line, keeps a bare path at line 0, and takes the start of a range", () => {
    expect(splitSite("src/a.ts:115")).toEqual({ path: "src/a.ts", line: 115 });
    expect(splitSite("src/a.ts")).toEqual({ path: "src/a.ts", line: 0 });
    expect(splitSite("src/a.ts:115-130")).toEqual({ path: "src/a.ts", line: 115 });
  });
});

describe("argv", () => {
  it("treats --vs as a SEPARATOR so a comparator band keeps all its repeats", () => {
    const a = parseArgs(["runA", "runB", "--instances", "i.json", "--vs", "runC", "runD"]);
    expect(a.runs).toEqual(["runA", "runB"]);
    expect(a.vs).toEqual(["runC", "runD"]);
    expect(a.instances).toBe("i.json");
  });

  it("defaults the window to null — absent is file-level only, never ±0", () => {
    expect(parseArgs(["run", "--instances", "i.json"]).window).toBeNull();
    expect(parseArgs(["run", "--window=25"]).window).toBe(25);
  });
});

describe("the two citation vocabularies", () => {
  // Measured on 2026-09-21: one run wrote `probes/enforcement-012.txt` and
  // another, same pipeline and same day, wrote
  // `.lastlight/pr-review/probes/state-003.txt`. Reading only the first form
  // reported three legitimately-backed drops as a floor bug.
  it("reads a repo-root-relative citation as well as an artifact-relative one", () => {
    expect(transcriptCandidates("probes/a.txt")).toEqual([{ form: "artifact", path: "probes/a.txt" }]);
    expect(transcriptCandidates(".lastlight/pr-review/probes/a.txt")).toEqual([
      { form: "artifact", path: ".lastlight/pr-review/probes/a.txt" },
      { form: "repo", path: "probes/a.txt" },
    ]);
  });

  it("records WHICH form resolved, so a mixed vocabulary is visible", () => {
    const { hypotheses, aliases } = indexHypotheses(new Map([["state", jsonl({ claim: "a" })]]));
    const [row] = join([{ hypothesis: "state-001", refutedBy: ".lastlight/pr-review/probes/state-001.txt" }], hypotheses, aliases, [], {
      exists: (rel) => rel === "probes/state-001.txt",
    });
    expect(row.transcriptResolves).toBe(true);
    expect(row.citationForm).toBe("repo");
  });
});

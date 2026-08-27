/**
 * `scripts/cap-sweep.ts` — the oracle, and the ways it could lie.
 *
 * The sweep's headline is a claim about GOLD ("nothing in the tail reaches any
 * gold the shipped ceiling does not"), and every mechanism below is a way to
 * produce that sentence wrongly:
 *
 *  - a gold matched against the wrong end of an obligation, or the wrong file;
 *  - a "required ceiling" read off the document's global position instead of the
 *    family's, which is what a ceiling actually cuts on;
 *  - a `path:line` split that loses the line number.
 *
 * The end-to-end validation is not here and cannot be: it is that the sweep
 * reproduces a STORED run's per-family counts exactly. It does — on
 * `1587-r3`, kept 12/12/8/8 and minted 59/17/8/15 against the stored run's
 * identical numbers — and reaching that took finding a real bug in the sweep
 * (`--mint` passed to `all`, where it is inert, instead of to `seed`). The two
 * families no mint arm touches matched throughout, which is what localised it.
 */
import { describe, expect, it } from "vitest";

import { familyPositions, matchGold, parseArgs, sitesOf } from "./cap-sweep.js";

const ob = (over: Record<string, unknown> = {}) =>
  ({
    id: "O-001",
    family: "contract",
    rank: 90,
    introducedAt: { path: "src/a.ts", line: 100, quote: "export function f()" },
    enforcedAt: { candidates: ["src/b.ts:40"] },
    question: "q",
    ...over,
  }) as Parameters<typeof sitesOf>[0];

const doc = (obligations: unknown[]) =>
  ({ families: [], obligations, dropped: [] }) as unknown as Parameters<
    typeof familyPositions
  >[0];

describe("the sites an obligation names", () => {
  it("carries BOTH ends — a gold may sit at either", () => {
    // IRIS: a one-ended mechanism is worse than none, so both ends are always
    // present and both are places the defect could be anchored.
    expect(sitesOf(ob())).toEqual([
      { path: "src/a.ts", line: 100 },
      { path: "src/b.ts", line: 40 },
    ]);
  });

  it("splits `path:line` from the RIGHT, so a colon in a path cannot steal the line", () => {
    expect(
      sitesOf(ob({ enforcedAt: { candidates: ["src/weird:name.ts:12"] } }))[1],
    ).toEqual({
      path: "src/weird:name.ts",
      line: 12,
    });
  });

  it("skips a candidate with no line rather than inventing one", () => {
    // Line 0 or NaN would match a gold at the top of a file and report a
    // ceiling that reaches something it does not.
    expect(
      sitesOf(
        ob({ enforcedAt: { candidates: ["src/b.ts", "src/c.ts:nope"] } }),
      ),
    ).toEqual([{ path: "src/a.ts", line: 100 }]);
  });

  it("survives an obligation with no candidates at all", () => {
    expect(sitesOf(ob({ enforcedAt: { candidates: [] } }))).toHaveLength(1);
  });
});

describe("position within its own family — the number a ceiling cuts on", () => {
  it("counts per family, not per document", () => {
    // The document is in GLOBAL rank order and the ceiling truncates each family
    // independently. A global index would report "position 5" for a family's
    // second obligation and propose a ceiling three slots too high.
    const positions = familyPositions(
      doc([
        ob({ id: "O-001", family: "enforcement" }),
        ob({ id: "O-002", family: "contract" }),
        ob({ id: "O-003", family: "enforcement" }),
        ob({ id: "O-004", family: "contract" }),
        ob({ id: "O-005", family: "state" }),
      ]),
    );
    expect(positions.get("O-001")).toBe(1);
    expect(positions.get("O-002")).toBe(1);
    expect(positions.get("O-003")).toBe(2);
    expect(positions.get("O-004")).toBe(2);
    expect(positions.get("O-005")).toBe(1);
  });
});

describe("matching a gold to an obligation", () => {
  const positions = (d: ReturnType<typeof doc>) => familyPositions(d);

  it("matches on file AND proximity, never on file alone", () => {
    const d = doc([
      ob({ introducedAt: { path: "src/a.ts", line: 100, quote: "" } }),
    ]);
    expect(
      matchGold({ file: "src/a.ts", line: 110 }, d, positions(d), 25)
        .obligation,
    ).toBeDefined();
    // Same file, 200 lines away: a different mechanism entirely. Counting it
    // would report whole files as "reached" and inflate the headline.
    expect(
      matchGold({ file: "src/a.ts", line: 400 }, d, positions(d), 25)
        .obligation,
    ).toBeUndefined();
    expect(
      matchGold({ file: "src/other.ts", line: 100 }, d, positions(d), 25)
        .obligation,
    ).toBeUndefined();
  });

  it("matches on the ENFORCED end too", () => {
    // The `1587-r2` shape: the defect is where the value is not checked, not
    // where it is declared.
    const d = doc([ob()]);
    const hit = matchGold({ file: "src/b.ts", line: 44 }, d, positions(d), 25);
    expect(hit.obligation?.id).toBe("O-001");
    expect(hit.distance).toBe(4);
  });

  it("prefers the obligation a SMALLER ceiling would have kept", () => {
    // Two obligations name the gold; the honest answer is the cheaper ceiling.
    // Reporting the further-down one would overstate the raise required.
    const d = doc([
      ob({
        id: "O-001",
        family: "contract",
        introducedAt: { path: "src/a.ts", line: 100, quote: "" },
      }),
      ob({
        id: "O-002",
        family: "contract",
        introducedAt: { path: "src/a.ts", line: 101, quote: "" },
      }),
    ]);
    const hit = matchGold({ file: "src/a.ts", line: 101 }, d, positions(d), 25);
    expect(hit.position).toBe(1);
    expect(hit.obligation?.id).toBe("O-001");
  });

  it("a gold with no file or no line is UNMATCHABLE, never a free hit", () => {
    // Martian's gold carries only a description; those cases cannot be scored by
    // this oracle at all, and scoring them as named would manufacture the
    // headline out of the dataset's shape.
    const d = doc([ob()]);
    expect(
      matchGold({ line: 100 }, d, positions(d), 25).obligation,
    ).toBeUndefined();
    expect(
      matchGold({ file: "src/a.ts" }, d, positions(d), 25).obligation,
    ).toBeUndefined();
  });

  it("a window of 0 requires the exact line", () => {
    const d = doc([
      ob({ introducedAt: { path: "src/a.ts", line: 100, quote: "" } }),
    ]);
    expect(
      matchGold({ file: "src/a.ts", line: 100 }, d, positions(d), 0).obligation,
    ).toBeDefined();
    expect(
      matchGold({ file: "src/a.ts", line: 101 }, d, positions(d), 0).obligation,
    ).toBeUndefined();
  });
});

describe("argument parsing", () => {
  it("defaults to the three-arm sweep over every case", () => {
    const a = parseArgs([]);
    expect(a.cases).toBe("all");
    expect(a.caps).toEqual(["shipped", "2x", "uncapped"]);
    expect(a.window).toBe(25);
    // The SHIPPED measurement configuration, not the seeder's baseline: a sweep
    // at baseline minting truncates a smaller candidate set and understates the
    // tail by exactly the obligations the real arm would have had.
    expect(a.mint).toBe("all-in-diff,registrations");
  });

  it("takes explicit cases and literal cap specs", () => {
    const a = parseArgs([
      "--cases",
      "x,y",
      "--caps",
      "shipped,contract=20",
      "--window",
      "5",
    ]);
    expect(a.cases).toEqual(["x", "y"]);
    expect(a.caps).toEqual(["shipped", "contract=20"]);
    expect(a.window).toBe(5);
  });
});

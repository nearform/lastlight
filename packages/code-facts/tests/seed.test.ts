/**
 * The seeder's contract, and the three rules it exists to enforce.
 *
 * These are unit tests over a DOCUMENT, not over a repo — `seedObligations` is a
 * pure transform, which is the whole reason it lives in this package. No git
 * fixture, no compiler, no harness.
 */
import { describe, expect, it } from "vitest";

import {
  seedObligations,
  validateObligation,
  type Obligation,
} from "../src/seed.js";
import { renderFamilyBlock } from "../src/seed-render.js";
import type { AllDocument } from "../src/schema.js";

function envelope(
  extractors: AllDocument["extractors"],
  overrides: Partial<AllDocument> = {},
): AllDocument {
  return {
    version: 2,
    generatedAt: "2026-08-22T00:00:00.000Z",
    extractor: "all",
    repo: "acme/widgets",
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    tier: 1,
    engine: "tsgo",
    languages: [
      { id: "typescript", changedFiles: 3, parsedFiles: 3, engine: "tsgo" },
    ],
    coverage: "full",
    degraded: [],
    toolchain: { manifest: 2, bundled: {}, binaries: {} },
    extractors,
    ...overrides,
  } as AllDocument;
}

const constant = (over: Record<string, unknown> = {}) => ({
  constant: "MAX_TOKEN_AGE",
  declaredAt: "src/config.ts:12",
  value: "900",
  valueKind: "number" as const,
  references: ["src/server/auth.ts:73"],
  hardCodedDuplicates: [],
  sides: null,
  ...over,
});

/** A valid tier-1 SymbolFact — one in-diff reference, `registrations: []`. */
const symbol = (over: Record<string, unknown> = {}) =>
  ({
    name: "applyRetry",
    kind: "function",
    exported: false,
    declaredAt: "src/retry.ts:5",
    changedHunks: ["src/retry.ts:5-20"],
    references: [
      { at: "src/caller.ts:9", inDiff: true, inSymbol: "run", isTest: false },
    ],
    implementations: null,
    callees: [],
    registrations: [],
    tests: [],
    referenceCount: 1,
    referencesInDiff: 1,
    resolution: "type-aware" as const,
    nameAmbiguity: null,
    ...over,
  }) as unknown as import("../src/schema.js").SymbolFact;

const factsOf = (...symbols: unknown[]) =>
  ({ facts: { files: [], symbols } }) as AllDocument["extractors"];

const MINT_ALL_IN_DIFF = { allInDiff: true, registrations: false };
const MINT_REGISTRATIONS = { allInDiff: false, registrations: true };

describe("both ends, or nothing", () => {
  it("drops a one-ended obligation and COUNTS the reason", () => {
    // A constant with no references and no duplicates has nowhere it could be
    // enforced — the second end does not exist.
    const doc = envelope({
      constants: {
        sideDefinitions: {},
        constants: [constant({ references: [] })],
      },
    });
    const seeded = seedObligations(doc);

    expect(seeded.obligations).toHaveLength(0);
    // …and the file says so. A silently empty list is the failure locked
    // decision 6 exists to prevent, so an empty `dropped` here would be the bug.
    expect(
      seeded.families.find((f) => f.family === "enforcement")?.obligations,
    ).toBe(0);
  });

  it("validateObligation names WHICH end is missing", () => {
    const base: Obligation = {
      id: "O-001",
      family: "enforcement",
      mechanism: "m",
      introducedAt: { path: "src/a.ts", line: 3, quote: "const A = 1" },
      enforcedAt: { candidates: ["src/b.ts:9"], found: false },
      question: "Quote the line.",
      evidence: [],
      discharge: "quote",
      rank: 1,
    };

    expect(validateObligation(base)).toBeNull();
    expect(
      validateObligation({
        ...base,
        enforcedAt: { candidates: [], found: false },
      }),
    ).toMatch(/one-ended/);
    expect(
      validateObligation({
        ...base,
        introducedAt: { ...base.introducedAt, quote: "  " },
      }),
    ).toMatch(/no quote/);
    expect(validateObligation({ ...base, question: "" })).toMatch(
      /question is empty/,
    );
  });

  it("`references: null` (tier 2, no compiler) seeds nothing rather than an empty absence claim", () => {
    // `null` means NOBODY LOOKED. An obligation built on it would assert an
    // absence the document explicitly declines to claim.
    const doc = envelope({
      constants: {
        sideDefinitions: {},
        constants: [constant({ references: null, hardCodedDuplicates: [] })],
      },
    });
    expect(seedObligations(doc).obligations).toHaveLength(0);
  });
});

describe("the subtraction is only a mechanism when the value discriminates", () => {
  it("a NUMERIC constant never uses the duplicates branch", () => {
    // Regression: `MAX_PENDING_SILENT_SIGN_IN_NONCES = 10` reported "16 other
    // sites hard-code 10" — occurrences of the bare number — and that obligation
    // ranked FIRST, above the constant whose obligation produced the only gold
    // match this investigation has.
    const doc = envelope({
      constants: {
        sideDefinitions: {},
        constants: [
          constant({
            constant: "MAX_PENDING",
            value: "10",
            valueKind: "number",
            references: ["src/server/auth.ts:73"],
            hardCodedDuplicates: [
              "src/other/unrelated.test.ts:281",
              "src/misc/thing.ts:9",
            ],
          }),
        ],
      },
    });
    const [o] = seedObligations(doc).obligations;

    expect(o.mechanism).toMatch(/may never be compared or enforced/);
    expect(o.mechanism).not.toMatch(/written literally/);
    // The second end is the reference set, not the coincidental literals.
    expect(o.enforcedAt.candidates).toEqual(["src/server/auth.ts:73"]);
  });

  it("a distinctive STRING constant does use it", () => {
    const doc = envelope({
      constants: {
        sideDefinitions: {},
        constants: [
          constant({
            constant: "PENDING_STORAGE_KEY",
            value: "redirectSignInPending",
            valueKind: "string",
            hardCodedDuplicates: ["src/frontend/other.ts:4"],
          }),
        ],
      },
    });
    const [o] = seedObligations(doc).obligations;

    expect(o.mechanism).toMatch(/written literally/);
    expect(o.enforcedAt.candidates).toEqual(["src/frontend/other.ts:4"]);
  });

  it("a SHORT string does not — it collides with prose and identifiers", () => {
    const doc = envelope({
      constants: {
        sideDefinitions: {},
        constants: [
          constant({
            constant: "COOKIE",
            value: "sn",
            valueKind: "string",
            hardCodedDuplicates: ["a.ts:1"],
          }),
        ],
      },
    });
    expect(seedObligations(doc).obligations[0].mechanism).toMatch(
      /may never be compared/,
    );
  });
});

describe("ranking", () => {
  it("puts a real boundary above a mechanism wholly inside the test suite", () => {
    const doc = envelope({
      constants: {
        sideDefinitions: {},
        constants: [
          // Declared in a test, referenced only in the same test — a statement
          // about the fixture, not about the product.
          constant({
            constant: "COOKIES_SECRET",
            value: "test-cookies-secret",
            valueKind: "string",
            declaredAt: "src/routes/test/auth.test.ts:13",
            references: ["src/routes/test/auth.test.ts:19"],
          }),
          constant({
            constant: "NONCE_MAX_AGE",
            value: "300",
            valueKind: "number",
            declaredAt: "src/utils/constants.ts:33",
            references: ["src/routes/auth.ts:10", "src/routes/auth.ts:95"],
          }),
        ],
      },
    });
    const ids = seedObligations(doc).obligations.map(
      (o) => o.introducedAt.path,
    );
    expect(ids[0]).toBe("src/utils/constants.ts");
  });

  it("truncates to the TOTAL backstop and counts EVERY dropped obligation, not every reason", () => {
    // Ten `enforcement` obligations — under that family's ceiling of 12, so
    // nothing here is a per-family drop and the backstop is the only mechanism
    // under test. (Before the ceilings landed this same fixture measured the
    // pooled budget; the number of survivors is the same and the REASON is
    // not, which is the honest way to keep the case.)
    const constants = Array.from({ length: 10 }, (_, i) =>
      constant({
        constant: `C${i}`,
        declaredAt: `src/c${i}.ts:1`,
        references: [`src/use${i}.ts:2`],
      }),
    );
    const seeded = seedObligations(
      envelope({ constants: { sideDefinitions: {}, constants } }),
      {
        maxObligations: 4,
      },
    );

    expect(seeded.obligations).toHaveLength(4);
    expect(
      seeded.dropped.filter((d) => d.reason.includes("per-family ceiling of")),
    ).toEqual([]);
    const backstop = seeded.dropped.find((d) =>
      d.reason.includes("total backstop"),
    );
    expect(backstop?.count).toBe(6);
    expect(backstop?.reason).toMatch(/NOT "checked"/);
    // The sealed set is what SURVIVED — a denominator that counted the dropped
    // ones would report work nobody was ever going to do.
    expect(seeded.coverageSet.selected).toHaveLength(4);
    expect(seeded.coverageSet.sealed).toBe(true);
  });
});

/**
 * The ceilings, and the measurement that bought them.
 *
 * A pooled budget ranked mechanism-class-first is a budget the strongest class
 * eats: across the eight gate cases `contract` minted 89 obligations and
 * `security` minted 3, and 35 obligations were dropped over the budget — so a
 * family's questions went unasked because a DIFFERENT family had a lot to say.
 * Two of `1667`'s five gold findings are security-family.
 *
 * Reserving floors INSIDE that pool did not fix it: the reserve still competes
 * for one budget, so it displaced `contract` slots on exactly the heavy-mint
 * cases, and cross-family ranking was still pricing a mechanism CLASS ordering
 * as though it were one scale. Per-family ceilings remove the competition
 * rather than arbitrating it — which is also the right shape for the cost,
 * since each family's obligations feed exactly ONE survey branch and it is the
 * fattest branch that is expensive, not the sum.
 */
describe("per-family obligation ceilings", () => {
  /** N `contract` deltas — rank 91 each, so they outrank everything below. */
  const contractDeltas = (n: number) =>
    Array.from({ length: n }, (_, i) => ({
      symbol: `getThing${i}`,
      file: `src/thing${i}.ts`,
      change: "changed" as const,
      before: null,
      after: null,
      consumersOutsideDiff: [`src/api/handler${i}.ts:4`],
    }));

  /**
   * `c` contract obligations and `s` security ones, and nothing else.
   *
   * Every security symbol's single reference is IN the diff, so `seedState` —
   * whose predicate needs a reference outside it — cannot co-fire and turn a
   * two-family fixture into a three-family one.
   */
  const mixed = (c: number, s: number) =>
    envelope({
      ...factsOf(
        ...Array.from({ length: s }, (_, i) =>
          symbol({ name: `handle${i}`, declaredAt: `src/sec${i}.ts:3` }),
        ),
      ),
      patterns: {
        findings: Array.from({ length: s }, (_, i) => ({
          file: `src/sec${i}.ts`,
          line: 3,
          rule: "weak-random",
          severity: "warning",
          message: "m",
          tool: "opengrep",
        })),
      },
      contracts: { contracts: contractDeltas(c) },
    } as unknown as AllDocument["extractors"]);

  const familyCounts = (doc: ReturnType<typeof seedObligations>) => {
    const counts: Record<string, number> = {};
    for (const o of doc.obligations)
      counts[o.family] = (counts[o.family] ?? 0) + 1;
    return counts;
  };

  it("truncates a family at ITS OWN ceiling, and says so per family in dropped[]", () => {
    // Thirty contract obligations at rank 91 against a ceiling of 12.
    const seeded = seedObligations(mixed(30, 0));
    expect(familyCounts(seeded)).toEqual({ contract: 12 });

    const ceiling = seeded.dropped.find((d) =>
      d.reason.includes("per-family ceiling of"),
    );
    expect(ceiling?.count).toBe(18);
    // The reason names the CEILING and the FAMILY — a reader comparing two
    // families' counts has to be able to tell "little to say" from "truncated",
    // and a pooled reason could not say which family it was about.
    expect(ceiling?.reason).toMatch(/per-family ceiling of 12 for contract/);
    expect(ceiling?.reason).toMatch(/No other family lost a slot/);
    expect(ceiling?.reason).toMatch(/NOT "checked"/);
  });

  it("THE STARVATION CASE: contract 89 + security 3 → contract 12, security 3", () => {
    // The measured shape, in the numbers it was measured in. Under the pooled
    // budget this asked ZERO security questions; under the floors it asked five
    // and took those five out of `contract`'s share. Under ceilings neither
    // family pays for the other: security keeps everything it minted because it
    // is nowhere near its own ceiling of 8.
    expect(familyCounts(seedObligations(mixed(89, 3)))).toEqual({
      contract: 12,
      security: 3,
    });
  });

  it("one family's excess costs no other family a slot, however large it is", () => {
    // The same security count survives whether `contract` mints 4 or 400 — the
    // property the floors approximated with a reserve and this makes structural.
    const small = familyCounts(seedObligations(mixed(4, 6)));
    const huge = familyCounts(seedObligations(mixed(400, 6)));
    expect(small.security).toBe(6);
    expect(huge.security).toBe(6);
    expect(small.contract).toBe(4);
    expect(huge.contract).toBe(12);
  });

  it("an under-cap family passes through untouched — no slot is reserved from it", () => {
    const seeded = seedObligations(mixed(10, 2));
    expect(familyCounts(seeded)).toEqual({ contract: 10, security: 2 });
    expect(
      seeded.dropped.filter((d) => d.reason.includes("per-family ceiling of")),
    ).toEqual([]);
  });

  it("the TOTAL backstop binds only when the post-ceiling total still exceeds it", () => {
    // Post-ceiling this document is 12 contract + 3 security = 15.
    const doc = mixed(30, 3);
    const roomy = seedObligations(doc, { maxObligations: 20 });
    expect(roomy.obligations).toHaveLength(15);
    expect(
      roomy.dropped.find((d) => d.reason.includes("total backstop")),
    ).toBeUndefined();

    // …and when it does bind it takes the LOWEST-RANKED across families, which
    // is the one place cross-family ranking still decides anything.
    const tight = seedObligations(doc, { maxObligations: 13 });
    expect(familyCounts(tight)).toEqual({ contract: 12, security: 1 });
    const backstop = tight.dropped.find((d) =>
      d.reason.includes("total backstop"),
    );
    expect(backstop?.count).toBe(2);
    expect(backstop?.reason).toMatch(/applied AFTER the per-family ceilings/);
    expect(backstop?.reason).toMatch(/NOT "checked"/);
    expect(tight.coverageSet.selected).toHaveLength(13);
  });

  it("the shipped default cannot bind — it IS the ceilings' sum", () => {
    // 12 + 12 + 8 + 8 + 8 = 48, so on a shipped configuration the ceilings are
    // the only mechanism and the backstop is inert. It exists so that raising
    // one ceiling is a bounded act rather than an unbounded one.
    const seeded = seedObligations(mixed(400, 400));
    expect(seeded.obligations).toHaveLength(20); // 12 contract + 8 security
    expect(
      seeded.dropped.find((d) => d.reason.includes("total backstop")),
    ).toBeUndefined();
  });

  it("emits in rank order, so the ids still ascend with the ranking", () => {
    // The ceiling decides WHICH obligations survive; it never reorders them.
    const seeded = seedObligations(mixed(4, 2));
    expect(seeded.obligations.map((o) => o.family)).toEqual([
      "contract",
      "contract",
      "contract",
      "contract",
      "security",
      "security",
    ]);
    expect(seeded.obligations.map((o) => o.id)).toEqual([
      "O-001",
      "O-002",
      "O-003",
      "O-004",
      "O-005",
      "O-006",
    ]);
  });

  it("records minted and cap per family, so 'truncated' needs no prose join", () => {
    // The envelope used to carry only the KEPT count, so telling "this family
    // was capped" from "this family had little to say" meant parsing a dropped
    // reason string for a family name — a join no consumer should have to make
    // about its own instrument, and the one the dead truncation notice made.
    const seeded = seedObligations(mixed(30, 3));
    const contract = seeded.families.find((f) => f.family === "contract");
    const security = seeded.families.find((f) => f.family === "security");

    expect(contract).toMatchObject({ obligations: 12, minted: 30, cap: 12 });
    expect(security).toMatchObject({ obligations: 3, minted: 3, cap: 8 });

    // A family that minted nothing reads 0/0 against a real ceiling — absence
    // of demand, not a refusal.
    expect(seeded.families.find((f) => f.family === "state")).toMatchObject({
      obligations: 0,
      minted: 0,
      cap: 8,
    });

    // `spec` is seeded elsewhere, so this package holds no ceiling for it.
    // `null` is "nobody looked", never "unbounded".
    expect(seeded.families.find((f) => f.family === "spec")).toMatchObject({
      minted: 0,
      cap: null,
    });
  });

  it("familyCaps overrides the shipped table, and is absent-means-shipped", () => {
    const doc = mixed(30, 20);
    // Absent ⇒ byte-identical to the shipped table. The measurement seam must
    // not be able to move a production document by existing.
    expect(
      JSON.stringify(seedObligations(doc, { familyCaps: undefined })),
    ).toBe(JSON.stringify(seedObligations(doc)));

    // A partial map merges over the shipped one — security keeps its 8.
    const raised = seedObligations(doc, {
      familyCaps: { contract: 25 },
      maxObligations: Infinity,
    });
    expect(familyCounts(raised)).toEqual({ contract: 25, security: 8 });
    expect(raised.families.find((f) => f.family === "contract")).toMatchObject({
      minted: 30,
      cap: 25,
    });
    // …and the dropped reason names the cap IN FORCE, not the shipped one.
    expect(
      raised.dropped.find((d) =>
        d.reason.includes("per-family ceiling of 25 for contract"),
      ),
    ).toBeDefined();

    // Infinity is the uncapped arm: nothing is refused at a ceiling.
    const uncapped = seedObligations(doc, {
      familyCaps: { contract: Infinity, security: Infinity },
      maxObligations: Infinity,
    });
    expect(familyCounts(uncapped)).toEqual({ contract: 30, security: 20 });
    expect(
      uncapped.dropped.filter((d) => d.reason.includes("per-family ceiling")),
    ).toEqual([]);
  });

  it("is byte-identical across runs on the same input", () => {
    // The seed is the one part of the pipeline with no measured variance
    // (`docs/plans/deterministic-pr-levers.md`), and a truncation allocated by
    // anything set-ordered rather than rank-ordered would end that.
    const doc = mixed(30, 20);
    const once = seedObligations(doc, { maxObligations: 16 });
    const twice = seedObligations(doc, { maxObligations: 16 });
    expect(JSON.stringify(twice.obligations)).toBe(
      JSON.stringify(once.obligations),
    );
    expect(twice.coverageSet.selected).toEqual(once.coverageSet.selected);
    expect(twice.dropped).toEqual(once.dropped);
  });
});

describe("coverage is inherited, never recomputed", () => {
  it("a `none` envelope yields a `none` obligations document", () => {
    const seeded = seedObligations(
      envelope(
        {},
        {
          coverage: "none",
          degraded: [{ extractor: "project", reason: "not a git repo" }],
        },
      ),
    );
    expect(seeded.coverage).toBe("none");
    expect(seeded.degraded).toHaveLength(1);
  });

  it("`tests` is notMeasured — never 0 — when no coverage report was read", () => {
    const seeded = seedObligations(envelope({}));
    const tests = seeded.families.find((f) => f.family === "tests");
    expect(tests?.measured).toBe(false);
    expect(tests?.notMeasuredReason).toMatch(/UNKNOWN rather than none/);
  });

  it("`spec` is always notMeasured here — it is WP0's, harness-side", () => {
    const spec = seedObligations(envelope({})).families.find(
      (f) => f.family === "spec",
    );
    expect(spec?.measured).toBe(false);
    expect(spec?.notMeasuredReason).toMatch(/review-spec/);
  });
});

describe("D2a — all-in-diff minting", () => {
  it("mints NOTHING without `mint.allInDiff`, and a contract obligation with it", () => {
    const doc = envelope(factsOf(symbol()));
    expect(seedObligations(doc).obligations).toHaveLength(0);

    const minted = seedObligations(doc, { mint: MINT_ALL_IN_DIFF });
    expect(minted.obligations).toHaveLength(1);
    const [o] = minted.obligations;
    expect(o.family).toBe("contract");
    expect(o.mechanism).toMatch(
      /every one of its 1 reference\(s\) is also inside the diff/,
    );
    expect(o.question).toMatch(/a caller cannot see and would be surprised by/);
    expect(o.introducedAt).toEqual({
      path: "src/retry.ts",
      line: 5,
      quote: "function applyRetry",
    });
  });

  it("the complement rule: an outside reference mints state, never all-in-diff — and vice versa", () => {
    // seedState's predicate (`outside.length > 0`) is the exact complement of
    // seedAllInDiff's (`referencesInDiff === referenceCount`), so one symbol
    // can satisfy only one of them.
    const outside = symbol({
      name: "withOutside",
      declaredAt: "src/out.ts:3",
      references: [
        {
          at: "src/far/away.ts:8",
          inDiff: false,
          inSymbol: null,
          isTest: false,
        },
      ],
      referenceCount: 1,
      referencesInDiff: 0,
    });
    const allIn = symbol();
    const minted = seedObligations(envelope(factsOf(outside, allIn)), {
      mint: MINT_ALL_IN_DIFF,
    });

    const byName = (name: string) =>
      minted.obligations
        .filter((o) => o.mechanism.startsWith(name))
        .map((o) => o.family);
    expect(byName("withOutside")).toEqual(["state"]);
    expect(byName("applyRetry")).toEqual(["contract"]);
  });

  it("counts the zero-reference drop — the ≥1-candidate validation gate, not a silent filter", () => {
    const minted = seedObligations(
      envelope(
        factsOf(
          symbol({ references: [], referenceCount: 0, referencesInDiff: 0 }),
        ),
      ),
      { mint: MINT_ALL_IN_DIFF },
    );
    expect(minted.obligations).toHaveLength(0);
    const drop = minted.dropped.find((d) => d.reason.includes("one-ended"));
    expect(drop?.count).toBe(1);
  });

  /**
   * THE CAPPED-ARRAY REGRESSION. On a capped `references[]`,
   * `.every(r => r.inDiff)` is true while 50 uncounted references sit outside
   * the diff — the predicate must read the UNCAPPED counts and mint nothing.
   */
  it("mints NOTHING when the capped references[] are all in-diff but the counts disagree", () => {
    const capped = symbol({
      references: [
        { at: "src/a.ts:1", inDiff: true, inSymbol: null, isTest: false },
        { at: "src/a.ts:2", inDiff: true, inSymbol: null, isTest: false },
        { at: "src/a.ts:3", inDiff: true, inSymbol: null, isTest: false },
      ],
      referenceCount: 300,
      referencesInDiff: 250,
    });
    const minted = seedObligations(envelope(factsOf(capped)), {
      mint: MINT_ALL_IN_DIFF,
    });
    expect(
      minted.obligations.filter((o) =>
        o.mechanism.includes("also inside the diff"),
      ),
    ).toHaveLength(0);
  });

  it("skips a kind with no runtime line a caller can be surprised by", () => {
    const minted = seedObligations(
      envelope(factsOf(symbol({ kind: "interface" }))),
      {
        mint: MINT_ALL_IN_DIFF,
      },
    );
    expect(minted.obligations).toHaveLength(0);
  });

  it("ranks below an outside-consumer contract obligation AND below state, in one mixed envelope", () => {
    const doc = envelope({
      ...factsOf(
        symbol(),
        symbol({
          name: "hotPath",
          exported: true,
          declaredAt: "src/hot.ts:2",
          references: [
            {
              at: "src/elsewhere.ts:4",
              inDiff: false,
              inSymbol: null,
              isTest: false,
            },
          ],
          referenceCount: 1,
          referencesInDiff: 0,
        }),
      ),
      contracts: {
        contracts: [
          {
            symbol: "getUser",
            file: "src/user.ts",
            change: "changed" as const,
            before: null,
            after: null,
            consumersOutsideDiff: ["src/api/handler.ts:4"],
          },
        ],
      },
    });
    const minted = seedObligations(doc, { mint: MINT_ALL_IN_DIFF });
    const order = minted.obligations.map((o) => o.mechanism.split(/['’\s]/)[0]);
    expect(order).toEqual(["getUser", "hotPath", "applyRetry"]);
  });

  it("penalises a mechanism wholly inside the test suite", () => {
    const inTests = symbol({
      name: "fixtureHelper",
      declaredAt: "tests/helpers.test.ts:5",
      references: [
        {
          at: "tests/other.test.ts:9",
          inDiff: true,
          inSymbol: null,
          isTest: true,
        },
      ],
    });
    const minted = seedObligations(envelope(factsOf(inTests, symbol())), {
      mint: MINT_ALL_IN_DIFF,
    });
    expect(minted.obligations.map((o) => o.introducedAt.path)).toEqual([
      "src/retry.ts",
      "tests/helpers.test.ts",
    ]);
  });

  it("candidates are the in-diff reference sites", () => {
    const s = symbol({
      references: [
        { at: "src/caller.ts:9", inDiff: true, inSymbol: "run", isTest: false },
        {
          at: "src/caller.ts:22",
          inDiff: true,
          inSymbol: "retryAll",
          isTest: false,
        },
      ],
      referenceCount: 2,
      referencesInDiff: 2,
    });
    const [o] = seedObligations(envelope(factsOf(s)), {
      mint: MINT_ALL_IN_DIFF,
    }).obligations;
    expect(o.enforcedAt.candidates).toEqual([
      "src/caller.ts:9",
      "src/caller.ts:22",
    ]);
    expect(o.enforcedAt.found).toBe(false);
  });
});

describe("D2b — registration minting", () => {
  const registered = () =>
    symbol({
      name: "buildServer",
      declaredAt: "src/app.ts:5",
      changedHunks: ["src/app.ts:5-12"],
      references: [],
      referenceCount: 0,
      referencesInDiff: 0,
      registrations: [
        {
          at: "src/app.ts:6",
          call: "app.addHook",
          phase: "onRequest",
          ordinal: 0,
        },
        { at: "src/app.ts:7", call: "app.get", phase: "/users", ordinal: 1 },
        { at: "src/app.ts:8", call: "app.use", phase: null, ordinal: 2 },
      ],
    });

  it("mints NOTHING without `mint.registrations`, and a security obligation with it", () => {
    const doc = envelope(factsOf(registered()));
    expect(seedObligations(doc).obligations).toHaveLength(0);

    const minted = seedObligations(doc, { mint: MINT_REGISTRATIONS });
    expect(minted.obligations).toHaveLength(1);
    const [o] = minted.obligations;
    expect(o.family).toBe("security");
    expect(o.mechanism).toMatch(/registers 3 handler\(s\)\/hook\(s\)/);
    expect(o.mechanism).toContain("onRequest → /users → unnamed");
    expect(o.question).toMatch(/EARLIEST registered line/);
    expect(o.introducedAt).toEqual({
      path: "src/app.ts",
      line: 6,
      quote: "app.addHook(onRequest)",
    });
  });

  it("`registrations: null` — nobody looked — mints nothing", () => {
    // The `references: null` rule, verbatim: an obligation built on a field
    // nobody populated would assert an ordering nobody observed. Absent (a
    // pre-D2 document) reads the same way via `?? null`.
    const minted = seedObligations(
      envelope(factsOf(symbol({ registrations: null }))),
      {
        mint: MINT_REGISTRATIONS,
      },
    );
    expect(minted.obligations).toHaveLength(0);
  });

  it("`registrations: []` — looked, found none — mints nothing either", () => {
    const minted = seedObligations(
      envelope(factsOf(symbol({ registrations: [] }))),
      {
        mint: MINT_REGISTRATIONS,
      },
    );
    expect(minted.obligations).toHaveLength(0);
  });

  it("candidates are every registration site, in ordinal order", () => {
    const [o] = seedObligations(envelope(factsOf(registered())), {
      mint: MINT_REGISTRATIONS,
    }).obligations;
    expect(o.enforcedAt.candidates).toEqual([
      "src/app.ts:6",
      "src/app.ts:7",
      "src/app.ts:8",
    ]);
  });

  it("renders under the SECURITY family block", () => {
    const minted = seedObligations(envelope(factsOf(registered())), {
      mint: MINT_REGISTRATIONS,
    });
    const block = renderFamilyBlock(minted, "security");
    expect(block).toContain("buildServer registers 3 handler(s)/hook(s)");
    expect(block).toContain(minted.obligations[0].id);
    // …and not under any other family's.
    expect(renderFamilyBlock(minted, "contract")).not.toContain("buildServer");
  });
});

describe("the `minting` stamp", () => {
  it("defaults both-false and records what was asked", () => {
    expect(seedObligations(envelope({})).minting).toEqual({
      allInDiff: false,
      registrations: false,
    });
    expect(
      seedObligations(envelope({}), { mint: MINT_ALL_IN_DIFF }).minting,
    ).toEqual(MINT_ALL_IN_DIFF);
    expect(
      seedObligations(envelope({}), { mint: MINT_REGISTRATIONS }).minting,
    ).toEqual(MINT_REGISTRATIONS);
    expect(
      seedObligations(envelope({}), {
        mint: { allInDiff: true, registrations: true },
      }).minting,
    ).toEqual({ allInDiff: true, registrations: true });
  });
});

describe("the rendered block carries the rule, not just the data", () => {
  const seeded = () =>
    seedObligations(
      envelope({
        constants: {
          sideDefinitions: {},
          constants: [
            constant({
              declaredAt: "src/config.ts:12",
              references: ["src/server/auth.ts:73"],
            }),
          ],
        },
      }),
    );

  it("emits the discharge contract with the obligations", () => {
    // v3 measured a 17-row ledger honestly discharged into ZERO findings. The
    // obligations without the contract reproduce exactly that, so they must not
    // be separable — the same reason renderSpecObligations emits its own.
    const block = renderFamilyBlock(seeded(), "enforcement");
    expect(block).toMatch(/DISCHARGE EVERY OBLIGATION/);
    expect(block).toMatch(/Reading a file is not a discharge/);
    expect(block).toMatch(/OVER-PRODUCE/);
    expect(block).toMatch(/found:        false/);
  });

  it("confines a pass to its own family's file", () => {
    const block = renderFamilyBlock(seeded(), "enforcement");
    expect(block).toMatch(/hypotheses\/enforcement\.jsonl/);
    expect(block).toMatch(
      /do NOT\s+reason about any family other than enforcement/,
    );
  });

  it("says NOT MEASURED for `tests` rather than rendering an empty, clean-looking block", () => {
    const block = renderFamilyBlock(seeded(), "tests");
    expect(block).toMatch(/NOT MEASURED/);
    expect(block).toMatch(/NOT a pass/);
  });

  it("never returns empty — a family with nothing to say still says so, in words", () => {
    // It used to return `""` here, and the caller then wrote no file. That made
    // a MISSING block mean three different things at once: nothing to say, the
    // seeder died, or — measured as 27 of 27 failed reads across 120 survey
    // branches on 2026-08-22 — the consumer resolved the path against the wrong
    // base. Only the first is benign, and the survey prompts' "if the file does
    // not exist, work the diff directly" escape hatch treated all three as it.
    // A block that is always on disk is what makes its absence diagnostic.
    const clean = seedObligations(envelope({}));
    const block = renderFamilyBlock(clean, "contract");
    expect(block).not.toBe("");
    expect(block).toMatch(/No contract obligations could be built/);
    // …and it is still not a licence to call the family clean.
    expect(block).toMatch(/not a licence to skip the family/);

    const degraded = seedObligations(
      envelope(
        {},
        {
          coverage: "degraded",
          degraded: [{ extractor: "facts", reason: "x" }],
        },
      ),
    );
    // A degraded family renders the same way plus what was missed: "we could not
    // look" and "we looked and it is clean" are different facts.
    expect(renderFamilyBlock(degraded, "contract")).toContain("[facts] x");
  });

  /**
   * The contract is STAMPED, not passed twice.
   *
   * `renderFamilyBlock` reads it off the document and `checkDischarge` reads it
   * off the same document, so the block a survey was handed and the contract the
   * gate grades against cannot come from two different answers. A render-time
   * argument would have allowed exactly that — which is the separability this
   * pipeline has now paid for three times.
   */
  it("records which contract it rendered, and defaults to `full`", () => {
    expect(seedObligations(envelope({})).contract).toBe("full");
    expect(seedObligations(envelope({}), { contract: "full" }).contract).toBe(
      "full",
    );
    expect(
      seedObligations(envelope({}), { contract: "minimal" }).contract,
    ).toBe("minimal");
  });

  it("renders the block the document says it rendered", () => {
    const minimal = seedObligations(
      envelope({
        constants: {
          sideDefinitions: {},
          constants: [
            constant({
              declaredAt: "src/config.ts:12",
              references: ["src/server/auth.ts:73"],
            }),
          ],
        },
      }),
      { contract: "minimal" },
    );
    expect(minimal.contract).toBe("minimal");
    const block = renderFamilyBlock(minimal, "enforcement");
    expect(block).not.toMatch(/"discharge":/);
    expect(block).toContain("Append one JSON object per hypothesis to");
  });
});

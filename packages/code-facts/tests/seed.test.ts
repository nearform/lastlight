/**
 * The seeder's contract, and the three rules it exists to enforce.
 *
 * These are unit tests over a DOCUMENT, not over a repo — `seedObligations` is a
 * pure transform, which is the whole reason it lives in this package. No git
 * fixture, no compiler, no harness.
 */
import { describe, expect, it } from "vitest";

import { seedObligations, validateObligation, type Obligation } from "../src/seed.js";
import { renderFamilyBlock } from "../src/seed-render.js";
import type { AllDocument } from "../src/schema.js";

function envelope(extractors: AllDocument["extractors"], overrides: Partial<AllDocument> = {}): AllDocument {
  return {
    version: 2,
    generatedAt: "2026-08-22T00:00:00.000Z",
    extractor: "all",
    repo: "acme/widgets",
    baseSha: "b".repeat(40),
    headSha: "h".repeat(40),
    tier: 1,
    engine: "tsgo",
    languages: [{ id: "typescript", changedFiles: 3, parsedFiles: 3, engine: "tsgo" }],
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

describe("both ends, or nothing", () => {
  it("drops a one-ended obligation and COUNTS the reason", () => {
    // A constant with no references and no duplicates has nowhere it could be
    // enforced — the second end does not exist.
    const doc = envelope({ constants: { sideDefinitions: {}, constants: [constant({ references: [] })] } });
    const seeded = seedObligations(doc);

    expect(seeded.obligations).toHaveLength(0);
    // …and the file says so. A silently empty list is the failure locked
    // decision 6 exists to prevent, so an empty `dropped` here would be the bug.
    expect(seeded.families.find((f) => f.family === "enforcement")?.obligations).toBe(0);
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
    expect(validateObligation({ ...base, enforcedAt: { candidates: [], found: false } })).toMatch(/one-ended/);
    expect(validateObligation({ ...base, introducedAt: { ...base.introducedAt, quote: "  " } })).toMatch(/no quote/);
    expect(validateObligation({ ...base, question: "" })).toMatch(/question is empty/);
  });

  it("`references: null` (tier 2, no compiler) seeds nothing rather than an empty absence claim", () => {
    // `null` means NOBODY LOOKED. An obligation built on it would assert an
    // absence the document explicitly declines to claim.
    const doc = envelope({
      constants: { sideDefinitions: {}, constants: [constant({ references: null, hardCodedDuplicates: [] })] },
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
            hardCodedDuplicates: ["src/other/unrelated.test.ts:281", "src/misc/thing.ts:9"],
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
        constants: [constant({ constant: "COOKIE", value: "sn", valueKind: "string", hardCodedDuplicates: ["a.ts:1"] })],
      },
    });
    expect(seedObligations(doc).obligations[0].mechanism).toMatch(/may never be compared/);
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
    const ids = seedObligations(doc).obligations.map((o) => o.introducedAt.path);
    expect(ids[0]).toBe("src/utils/constants.ts");
  });

  it("truncates to the budget and counts EVERY dropped obligation, not every reason", () => {
    const constants = Array.from({ length: 10 }, (_, i) =>
      constant({ constant: `C${i}`, declaredAt: `src/c${i}.ts:1`, references: [`src/use${i}.ts:2`] }),
    );
    const seeded = seedObligations(envelope({ constants: { sideDefinitions: {}, constants } }), {
      maxObligations: 4,
    });

    expect(seeded.obligations).toHaveLength(4);
    const budget = seeded.dropped.find((d) => d.reason.includes("budget"));
    expect(budget?.count).toBe(6);
    // The sealed set is what SURVIVED — a denominator that counted the dropped
    // ones would report work nobody was ever going to do.
    expect(seeded.coverageSet.selected).toHaveLength(4);
    expect(seeded.coverageSet.sealed).toBe(true);
  });
});

describe("coverage is inherited, never recomputed", () => {
  it("a `none` envelope yields a `none` obligations document", () => {
    const seeded = seedObligations(
      envelope({}, { coverage: "none", degraded: [{ extractor: "project", reason: "not a git repo" }] }),
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
    const spec = seedObligations(envelope({})).families.find((f) => f.family === "spec");
    expect(spec?.measured).toBe(false);
    expect(spec?.notMeasuredReason).toMatch(/review-spec/);
  });
});

describe("the rendered block carries the rule, not just the data", () => {
  const seeded = () =>
    seedObligations(
      envelope({
        constants: {
          sideDefinitions: {},
          constants: [constant({ declaredAt: "src/config.ts:12", references: ["src/server/auth.ts:73"] })],
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
    expect(block).toMatch(/do NOT\s+reason about any family other than enforcement/);
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

    const degraded = seedObligations(envelope({}, { coverage: "degraded", degraded: [{ extractor: "facts", reason: "x" }] }));
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
    expect(seedObligations(envelope({}), { contract: "full" }).contract).toBe("full");
    expect(seedObligations(envelope({}), { contract: "minimal" }).contract).toBe("minimal");
  });

  it("renders the block the document says it rendered", () => {
    const minimal = seedObligations(
      envelope({
        constants: {
          sideDefinitions: {},
          constants: [constant({ declaredAt: "src/config.ts:12", references: ["src/server/auth.ts:73"] })],
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

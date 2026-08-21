/**
 * `constants` — the subtraction, and the `sides` partition that made `1587-r2`
 * legible.
 *
 * The gold finding was: `MAX_TOKEN_AGE` is consumed on the client and NEVER
 * compared server-side. `sides: { client: n, server: 0 }` is that sentence as a
 * machine-checkable fact — and `hardCodedDuplicates` is the second half, the
 * sites that use the value without going through the constant at all.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeBrokenTsConfigFixture, makeConstantFixture, type Fixture } from "./helpers.js";
import { runExtractor } from "../src/run.js";
import { literalOf, parseSides, DEFAULT_SIDES } from "../src/constants.js";
import type { ConstantsDocument } from "../src/schema.js";

function constants(fixture: Fixture, sides?: string): ConstantsDocument {
  return runExtractor({
    extractor: "constants",
    repo: fixture.dir,
    base: fixture.base,
    head: fixture.head,
    sides,
  }).document as unknown as ConstantsDocument;
}

describe("constants — references MINUS literals", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeConstantFixture();
  });
  afterAll(() => fixture.cleanup());

  it("reports the constant with client references and ZERO server references", () => {
    const document = constants(fixture);
    const fact = document.constants.find((c) => c.constant === "MAX_TOKEN_AGE");
    expect(fact).toBeDefined();
    expect(fact?.value).toBe("900");
    expect(fact?.valueKind).toBe("number");
    expect(fact?.sides.client).toBeGreaterThan(0);
    expect(fact?.sides.server).toBe(0);
  });

  it("subtracts A from B — a copy of the value that never goes through the constant", () => {
    const fact = constants(fixture).constants.find((c) => c.constant === "MAX_TOKEN_AGE");
    expect(fact?.hardCodedDuplicates).toEqual(["src/legacy/auth.ts:2"]);
    // The declaration's own initializer is an occurrence of its value; it is
    // not a duplicate of itself.
    expect(fact?.hardCodedDuplicates).not.toContain("src/config.ts:1");
    // Nor is a real reference — that is set A, and A is subtracted.
    for (const reference of fact?.references ?? []) {
      expect(fact?.hardCodedDuplicates).not.toContain(reference);
    }
  });

  it("emits the side definitions it partitioned on, so `server: 0` is auditable", () => {
    const document = constants(fixture);
    expect(document.sideDefinitions).toEqual(DEFAULT_SIDES);
  });

  it("honours an explicit --sides partition", () => {
    const document = constants(fixture, "ui=src/client/,api=src/server/");
    const fact = document.constants.find((c) => c.constant === "MAX_TOKEN_AGE");
    expect(document.sideDefinitions).toEqual({ ui: ["src/client/"], api: ["src/server/"] });
    expect(fact?.sides.ui).toBeGreaterThan(0);
    expect(fact?.sides.api).toBe(0);
  });

  it("only reports constants the diff actually touched", () => {
    const document = constants(fixture);
    // APP_NAME is declared in the same file but on an unchanged line.
    expect(document.constants.map((c) => c.constant)).not.toContain("APP_NAME");
  });

  /**
   * Tier 2 is a REAL tier, not a failure. ast-grep still finds the declaration
   * with no compiler at all — and the document says set A is missing rather
   * than reporting an empty reference list as if it had looked.
   */
  it("degrades to ast-grep-only on a repo whose project will not load, and says so", () => {
    const broken = makeBrokenTsConfigFixture();
    try {
      const result = runExtractor({
        extractor: "constants",
        repo: broken.dir,
        base: broken.base,
        head: broken.head,
      });
      const document = result.document as unknown as ConstantsDocument;
      expect(result.exitCode).toBe(3);
      expect(document.tier).toBe(2);
      expect(document.coverage).toBe("degraded");
      expect(document.constants.map((c) => c.constant)).toContain("LIMIT");
      expect(document.degraded.some((d) => d.extractor === "constants")).toBe(true);
      expect(document.degraded.some((d) => /reference sets \(A\) are missing/.test(d.reason))).toBe(
        true,
      );
    } finally {
      broken.cleanup();
    }
  });
});

describe("constants — literal classification", () => {
  it("recognises the three literal kinds and rejects computed initializers", () => {
    expect(literalOf("900")).toEqual({ value: "900", kind: "number" });
    expect(literalOf('"hello"')).toEqual({ value: "hello", kind: "string" });
    expect(literalOf("true")).toEqual({ value: "true", kind: "boolean" });
    expect(literalOf("60 * 60")).toBeNull();
    expect(literalOf("process.env.MAX")).toBeNull();
    expect(literalOf("`${a}`")).toBeNull();
  });

  it("falls back to the default partition rather than an empty one", () => {
    expect(parseSides(undefined)).toEqual(DEFAULT_SIDES);
    expect(parseSides("garbage")).toEqual(DEFAULT_SIDES);
  });
});

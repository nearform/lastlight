/**
 * WP1 acceptance criterion 1 — THE HEADLINE TEST.
 *
 * `lastlight-facts facts` on a fixture repo must produce the `1587-r2`-shaped
 * obligation input MECHANICALLY: `MAX_TOKEN_AGE` declared once, referenced only
 * on the client side, zero server references. That is the one shape the whole
 * investigation ever converted into a posted Critical, and v3 got there by
 * GUESSING it with regexes. This file is the regression guard for making it
 * true.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeBarrelFixture,
  makeConstantFixture,
  makeContractFixture,
  makeSymbolKindsFixture,
  type Fixture,
} from "./helpers.js";
import { runExtractor } from "../src/run.js";
import type { FactsDocument } from "../src/schema.js";

function facts(fixture: Fixture): FactsDocument {
  return runExtractor({
    extractor: "facts",
    repo: fixture.dir,
    base: fixture.base,
    head: fixture.head,
  }).document as unknown as FactsDocument;
}

describe("facts — the impact cone", () => {
  let constant: Fixture;
  let barrel: Fixture;
  let contract: Fixture;

  beforeAll(() => {
    constant = makeConstantFixture();
    barrel = makeBarrelFixture();
    contract = makeContractFixture();
  });
  afterAll(() => {
    constant.cleanup();
    barrel.cleanup();
    contract.cleanup();
  });

  it("finds the changed symbol and its cross-file references, and never exits 0 empty", () => {
    const document = facts(constant);
    expect(document.coverage).toBe("full");
    expect(document.tier).toBe(1);

    const symbol = document.symbols.find((s) => s.name === "MAX_TOKEN_AGE");
    expect(symbol, "the changed constant must be in the symbol list").toBeDefined();
    expect(symbol?.declaredAt).toBe("src/config.ts:1");
    expect(symbol?.changedHunks).toEqual(["src/config.ts:1-1"]);
    expect(symbol?.exported).toBe(true);

    // The reference is in a file the diff never touched — invisible in the diff
    // itself, which is the whole reason this extractor exists.
    expect(symbol?.references.map((r) => r.at)).toContain("src/client/session.ts:4");
    expect(symbol?.references.every((r) => !r.at.startsWith("src/server/"))).toBe(true);
    expect(symbol?.referencesInDiff).toBe(0);
    expect(symbol?.referenceCount).toBeGreaterThan(0);
  });

  it("records the enclosing symbol at each reference site", () => {
    const symbol = facts(constant).symbols.find((s) => s.name === "MAX_TOKEN_AGE");
    const usage = symbol?.references.find((r) => r.at === "src/client/session.ts:4");
    expect(usage?.inSymbol).toBe("cookieMaxAge");
  });

  it("follows a barrel re-export, so the consumer two files away is still a reference", () => {
    const document = facts(barrel);
    const symbol = document.symbols.find((s) => s.name === "rateLimit");
    const sites = symbol?.references.map((r) => r.at) ?? [];
    expect(sites).toContain("src/index.ts:1"); // the barrel
    expect(sites).toContain("src/consumer.ts:3"); // the consumer beyond it
  });

  it("marks test files as tests, so the `tests` field is not guessed from the path in the prompt", () => {
    const document = facts(contract);
    const symbol = document.symbols.find((s) => s.name === "getUser");
    expect(symbol?.tests).toContain("test/user.test.ts");
    expect(symbol?.references.some((r) => r.isTest)).toBe(true);
  });

  it("records callees, so a changed function's outward edges are available too", () => {
    const document = facts(contract);
    const symbol = document.symbols.find((s) => s.name === "getUser");
    expect(symbol?.callees).toEqual([]);
    const changedFile = document.files.find((f) => f.path === "src/user.ts");
    expect(changedFile?.analysed).toBe(true);
    expect(changedFile?.status).toBe("modified");
  });

  it("lists every changed file, including ones with no symbol in them", () => {
    const document = facts(constant);
    expect(document.files.map((f) => f.path).sort()).toEqual([
      "src/config.ts",
      "src/legacy/auth.ts",
    ]);
  });
});

/**
 * M6 — `implementations` is nullable, and the nullability IS the fact.
 *
 * `null` = nobody looked; `[]` = looked, found none. Every kind for which the
 * question does not apply (a function, a variable) and every query the language
 * service threw on used to report `[]`, so "this is not an interface" and "this
 * exported interface has no implementers anywhere" were the same JSON — and
 * only the second is worth an obligation.
 */
describe("facts — implementations distinguishes `nobody looked` from `none`", () => {
  it("is null for a kind the question does not apply to, and an array for one it does", () => {
    const fixture = makeContractFixture();
    try {
      const document = facts(fixture);
      const getUser = document.symbols.find((s) => s.name === "getUser");
      expect(getUser?.kind).toBe("function");
      expect(getUser?.implementations, "a plain function was never asked").toBeNull();

      const asked = document.symbols.filter((s) =>
        ["interface", "interface-method", "abstract-method", "class"].includes(s.kind),
      );
      expect(asked.length, "the fixture must contain a kind that IS asked").toBeGreaterThan(0);
      for (const symbol of asked) {
        expect(Array.isArray(symbol.implementations), symbol.name).toBe(true);
      }
    } finally {
      fixture.cleanup();
    }
  });
});

/**
 * THE THIRD STATE. `implementations` has three of them — `null` (nobody asked),
 * `[]` (asked, none) and a populated array — and the third had **never been
 * non-empty in any test**, because no fixture ever implemented an interface.
 * A field whose only tested values are "absent" and "empty" is a field whose
 * happy path is unexercised, in the extractor that exists to find the consumers
 * a reviewer will not see.
 *
 * The rest of the kind table lives here too: `enum`, `type`, `property`,
 * `abstract-method` and `method` were all unreached, as were a DELETED file's
 * `analysed: false` and a RENAMED file's new path.
 */
describe("facts — the whole kind table, on one commit", () => {
  let fixture: Fixture;
  let document: FactsDocument;

  beforeAll(() => {
    fixture = makeSymbolKindsFixture();
    document = facts(fixture);
  });
  afterAll(() => fixture.cleanup());

  const symbol = (name: string) => document.symbols.find((s) => s.name === name);

  it("names both implementers of a changed interface, and neither is the interface itself", () => {
    const store = symbol("Store");
    expect(store?.kind).toBe("interface");
    expect(store?.implementations).toEqual(["src/db.ts:3", "src/mem.ts:3"]);
    // Both implementers are OUTSIDE the diff — which is the point of the field.
    expect(document.files.map((f) => f.path)).not.toContain("src/mem.ts");
  });

  it("resolves implementations of an interface METHOD down to the method line", () => {
    expect(symbol("Store.get")?.kind).toBe("interface-method");
    expect(symbol("Store.get")?.implementations).toEqual(["src/db.ts:4", "src/mem.ts:4"]);
  });

  it("keeps `[]` meaning `looked and found none` beside those populated arrays", () => {
    // `Base` is an exported abstract class nothing extends. That is a FACT worth
    // an obligation, and it is only legible next to the populated case above.
    expect(symbol("Base")?.kind).toBe("class");
    expect(symbol("Base")?.implementations).toEqual([]);
    expect(symbol("Base.run")?.kind).toBe("abstract-method");
    expect(symbol("Base.run")?.implementations).toEqual([]);
  });

  it("emits every declaration kind the diff touched", () => {
    expect(
      document.symbols
        .map((s) => s.kind)
        .filter((kind, index, all) => all.indexOf(kind) === index)
        .sort(),
    ).toEqual([
      "abstract-method",
      "class",
      "enum",
      "function",
      "interface",
      "interface-method",
      "method",
      "property",
      "type",
    ]);
    expect(symbol("Mode")?.kind).toBe("enum");
    expect(symbol("Label")?.kind).toBe("type");
    expect(symbol("Base.limit")?.kind).toBe("property");
    expect(symbol("Service.run")?.kind).toBe("method");
    // `facts` records a private method — it is a unit a reviewer reasons about.
    // (`contracts` excludes it; the two extractors answer different questions.)
    expect(symbol("Service.secret")?.kind).toBe("method");
  });

  it("records a NON-EMPTY callee list — the outward edge of a changed function", () => {
    // Only ever asserted as `[]` before, which passes on an extractor that
    // never populates it at all.
    expect(symbol("boot")?.callees).toEqual(["start"]);
    expect(symbol("Mode")?.callees).toEqual([]);
  });

  it("marks a DELETED file `analysed: false` rather than dropping it", () => {
    const gone = document.files.find((f) => f.path === "src/gone.ts");
    expect(gone?.status).toBe("deleted");
    // There is nothing at head to parse, and saying so is what stops "no
    // symbols here" reading as "this file is fine".
    expect(gone?.analysed).toBe(false);
    expect(document.symbols.some((s) => s.declaredAt.startsWith("src/gone.ts"))).toBe(false);
  });

  it("lists a RENAMED file under its new path, analysed", () => {
    const renamed = document.files.find((f) => f.status === "renamed");
    expect(renamed?.path).toBe("src/new-name.ts");
    expect(renamed?.analysed).toBe(true);
    // The old path exists at neither head nor in the change set.
    expect(document.files.map((f) => f.path)).not.toContain("src/old-name.ts");
  });
});

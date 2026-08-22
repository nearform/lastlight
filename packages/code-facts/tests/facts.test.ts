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
 *
 * ── REWRITTEN 2026-08-22, AND THE REWRITE IS THE RECORD OF A CAPABILITY LOSS ──
 *
 * The TS 7 compiler API has **no implementations query at all**
 * (`docs/plans/fact-engine/`). ts-morph's `getImplementations()` was a language
 * -service call with no counterpart on `Checker`, and nothing in this migration
 * replaced it: closing the gap needs an LSP `textDocument/implementation` round
 * trip per symbol, which has not been built.
 *
 * So the third state — a POPULATED array — is currently unreachable, and these
 * cases assert what is actually true rather than being deleted:
 *
 *   - it is `null` on the kinds the question applies to, **never `[]`**. That is
 *     the whole point of the distinction and the one thing that must not slip:
 *     `[]` here would assert "this exported interface has no implementers
 *     anywhere", an absence claim nobody verified, from the extractor whose
 *     output is absence claims;
 *   - it is `null` on the kinds it does not apply to, exactly as before;
 *   - and the loss is NAMED in `degraded[]`, scoped to the runs where there was
 *     something to answer — a diff of plain functions was answered `null` by
 *     both engines and must not degrade for it.
 *
 * When an implementations provider lands, the `toBeNull()`s below become the
 * populated/empty pair the old fixture pinned (`makeSymbolKindsFixture` still
 * carries two implementers of `Store` and an abstract `Base` nothing extends,
 * for exactly that day).
 */
describe("facts — implementations distinguishes `nobody looked` from `none`", () => {
  it("is null for a kind the question does not apply to — and STILL null, never [], for one it does", () => {
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
        expect(
          symbol.implementations,
          `${symbol.name}: no engine looked, so \`[]\` would be a fabricated absence claim`,
        ).toBeNull();
      }
    } finally {
      fixture.cleanup();
    }
  });

  it("names the missing query in degraded[] — and does NOT on a diff with nothing to answer", () => {
    const withKinds = makeContractFixture();
    try {
      const document = facts(withKinds);
      const entry = document.degraded.find((d) => /no implementations query/.test(d.reason));
      expect(entry, "a capability this engine does not have must not be silent").toBeDefined();
      expect(entry?.extractor).toBe("facts");
      expect(entry?.reason).toMatch(/capability LOSS/);
    } finally {
      withKinds.cleanup();
    }

    // The pin without which the assertion above is vacuous: an entry populated
    // on EVERY run has stopped carrying signal. `makeConstantFixture` has no
    // interface, class or abstract member in the diff — the previous engine
    // answered `null` there too, so there is nothing lost and nothing to say.
    const plain = makeConstantFixture();
    try {
      const document = facts(plain);
      expect(document.symbols.length).toBeGreaterThan(0);
      expect(document.degraded.filter((d) => /no implementations query/.test(d.reason))).toEqual([]);
      expect(document.coverage).toBe("full");
    } finally {
      plain.cleanup();
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

  /**
   * The fixture still carries the shape — `Store` implemented in `src/db.ts:3`
   * and `src/mem.ts:3`, `Store.get` at `:4` in both, and an abstract `Base`
   * nothing extends — and the answer is `null` for all four, because the TS 7
   * API has no implementations query.
   *
   * KEPT rather than deleted, with the expected answer written down beside the
   * actual one: this is the case that will go green again the day an LSP
   * `textDocument/implementation` provider lands, and deleting it would delete
   * the only executable statement of what "correct" looks like.
   */
  it("does NOT answer implementations — the query does not exist on this engine", () => {
    const store = symbol("Store");
    expect(store?.kind).toBe("interface");
    // With a provider: ["src/db.ts:3", "src/mem.ts:3"] — both OUTSIDE the diff,
    // which is the point of the field.
    expect(store?.implementations).toBeNull();
    expect(document.files.map((f) => f.path)).not.toContain("src/mem.ts");

    expect(symbol("Store.get")?.kind).toBe("interface-method");
    // With a provider: ["src/db.ts:4", "src/mem.ts:4"].
    expect(symbol("Store.get")?.implementations).toBeNull();
  });

  it("keeps `null` and never `[]` for an abstract class nothing extends", () => {
    // `Base` is an exported abstract class nothing extends. Under an engine that
    // LOOKED that is `[]` and a fact worth an obligation; under this one it is
    // indistinguishable from every other unasked symbol, and saying `[]` would
    // manufacture the fact rather than find it.
    expect(symbol("Base")?.kind).toBe("class");
    expect(symbol("Base")?.implementations).toBeNull();
    expect(symbol("Base.run")?.kind).toBe("abstract-method");
    expect(symbol("Base.run")?.implementations).toBeNull();
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

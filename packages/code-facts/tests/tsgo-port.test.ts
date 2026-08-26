/**
 * THE FOUR MAPPINGS THAT LOOK LIKE RENAMES AND ARE NOT — pinned as ABSOLUTES.
 *
 * ── WHAT THIS FILE WAS, AND WHY IT CHANGED SHAPE 2026-08-22 ─────────────────
 *
 * It was the `--engine tsgo` A/B: every claim was asserted by running BOTH
 * engines over the same fixture and comparing the SETS they produced, never by
 * pinning a literal. That was right while there were two engines, and it is the
 * reason the port could be trusted — measured on this repo's `HEAD~1..HEAD`,
 * `facts` 44 = 44 symbols and 138 = 138 reference sites, contract keys 13 = 13,
 * `consumersOutsideDiff` 32 = 32.
 *
 * **ts-morph is deleted, so every `expect(f("tsgo")).toEqual(f("ts-morph"))`
 * here became a tautology** — a guard that cannot fail, which is worse than no
 * guard. Rather than delete the file (the traps are real and each was found the
 * hard way) each comparison is replaced by the ABSOLUTE answer the surviving
 * engine must produce. Where the only content was "the two agree", the case is
 * deleted and said so.
 *
 * The traps, each pinned below:
 *
 *   1. `getExportedDeclarations` → `getExportsOfModule` is NOT a rename. One
 *      returns declarations and follows re-exports; the other returns SYMBOLS
 *      and needs an explicit `getAliasedSymbol`. `makeReexportFixture` is the
 *      shape where the difference is visible.
 *   2. JSDoc `@throws {ValidationError} when the id is empty` must record
 *      `ValidationError` and never `when` — the WP1b bug 5 shape, reachable
 *      again through `getJsDocTagsOfSymbol`'s flat rendered string.
 *   3. Line numbers are 0-based on this API and were 1-based before. An
 *      off-by-one throws nothing, fails nothing, and cites the wrong line — so
 *      the lines below are written out, which is the only thing that catches it.
 *   4. `isOptional` is `questionToken || initializer || restParameter`, not
 *      `questionToken`.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runExtractor } from "../src/run.js";
import { discoverTsgoTargets, tsgoViews } from "../src/tsgo-extractors.js";
import { changedPaths } from "../src/git.js";
import type {
  ContractsDocument,
  ContractDelta,
  FactsDocument,
  SymbolFact,
} from "../src/schema.js";
import {
  type Fixture,
  makeContractFixture,
  makeFixture,
  makeMultiProjectFixture,
  makeNonTsFixture,
  makeSymbolKindsFixture,
  TSCONFIG,
} from "./helpers.js";

/**
 * THE BARREL, WITH THE BARREL ITSELF IN THE DIFF — and that qualifier is the
 * whole fixture.
 *
 * `makeBarrelFixture` was the obvious choice and it is VACUOUS here: its head
 * commit changes only `src/core/limits.ts`, so `contracts` never opens
 * `src/index.ts` and the alias path never executes. Dropping `getAliasedSymbol`
 * from the port left all three of its assertions green, which is the same
 * shape as a bound nobody could violate.
 *
 * Here the head commit changes the BARREL, so every alias spelling is exercised
 * on a file the extractor actually reads:
 *
 *   export { rateLimit } from "./core/limits.js"   a re-export of another file
 *   export { localCap }                            a LOCAL export with no modifier
 *   export * from "./more.js"                      a star re-export
 *   export { renamed as publicName } from …        a renamed re-export
 *   export { renamed as freshName } from …         the same, ADDED by the PR
 *
 * ts-morph's `getExportedDeclarations()` follows every one of them and hands
 * back the DECLARATION, which `contracts` then filters on `getSourceFile()`.
 * `getExportsOfModule` hands back the ALIAS, and — MEASURED here, this is the
 * mechanism — the alias's own `declarations` is the `ExportSpecifier`, in THIS
 * file, so the filter cannot see it.
 *
 * The last line is what makes the key-set assertion sensitive rather than
 * merely true. Without the alias step the three pre-existing re-exports print
 * identically on both sides and quietly produce no delta, so the key set does
 * not move and a test that only compared it would pass while the port was
 * wrong (it did — that is why this line is here). An ADDED re-export has no
 * base-side counterpart, so it becomes a phantom `added` export OF THE BARREL,
 * which is a symbol the PR did not declare anywhere.
 *
 * `export *` is the one spelling that is NOT an alias: `EXTRA` arrives with its
 * real `VariableDeclaration` in `src/more.ts` and is filtered correctly either
 * way.
 */
function makeReexportFixture(): Fixture {
  const shared: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "package.json": JSON.stringify({ name: "fixture-reexport", version: "1.0.0" }, null, 2),
    "src/more.ts": `export const EXTRA = 1;\n`,
    "src/renamed.ts": `export function renamed(id: string): string {\n  return id;\n}\n`,
    "src/consumer.ts": `import { rateLimit, localCap, publicName } from "./index.js";\n\nexport const applied = rateLimit(localCap) + publicName("x").length;\n`,
  };
  const barrel = (cap: number, fresh: boolean): string =>
    `export { rateLimit } from "./core/limits.js";\nexport * from "./more.js";\nexport { renamed as publicName } from "./renamed.js";\n${
      fresh ? `export { renamed as freshName } from "./renamed.js";\n` : ""
    }\nconst localCap = ${cap};\nexport { localCap };\n`;
  return makeFixture(
    "reexport",
    {
      message: "base",
      files: {
        ...shared,
        "src/core/limits.ts": `export function rateLimit(n: number): number {\n  return n;\n}\n`,
        "src/index.ts": barrel(5, false),
      },
    },
    {
      message: "head: the barrel AND the declaring file both change",
      files: {
        // A DEFAULTED and a REST parameter, on purpose: ts-morph's
        // `isOptional()` is `questionToken || initializer || restParameter`,
        // and no other fixture in this package has either spelling on a changed
        // export — so a `!!questionToken` port passed every test.
        "src/core/limits.ts": `export function rateLimit(n: number, burst = 0, ...tags: string[]): number {\n  return n + burst + tags.length;\n}\n`,
        "src/index.ts": barrel(9, true),
      },
    },
  );
}

function run(fixture: Fixture, extractor: "facts" | "contracts"): Record<string, unknown> {
  return runExtractor({
    extractor,
    repo: fixture.dir,
    base: fixture.base,
    head: fixture.head,
  }).document;
}

const contractsOf = (document: Record<string, unknown>): ContractDelta[] =>
  (document as unknown as ContractsDocument).contracts;
const symbolsOf = (document: Record<string, unknown>): SymbolFact[] =>
  (document as unknown as FactsDocument).symbols;

/** `file#symbol` — the KEY `contracts` is keyed on, which is the delta set. */
const contractKeys = (document: Record<string, unknown>): string[] =>
  contractsOf(document)
    .map((delta) => `${delta.file}#${delta.symbol}`)
    .sort();

/** `declaredAt#name (kind)` — carries the LINE, so trap 3 is inside trap 1's assertion. */
const symbolKeys = (document: Record<string, unknown>): string[] =>
  symbolsOf(document)
    .map((symbol) => `${symbol.declaredAt}#${symbol.name} (${symbol.kind})`)
    .sort();

// ─────────────────────────────────────────────────────────────────────────────

describe("trap 1 — getExportedDeclarations is not getExportsOfModule", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeReexportFixture();
  });
  afterAll(() => fixture?.cleanup());

  it("produces the WHOLE contract key set when the BARREL is in the diff", () => {
    // The SET, not the count: a barrel credited with another file's symbol
    // keeps the count and moves the key, which is the definition of a phantom
    // delta. Written out rather than compared against a second engine, because
    // there is no second engine — and a set this small is readable.
    expect(contractKeys(run(fixture, "contracts"))).toEqual([
      "src/core/limits.ts#rateLimit",
      "src/index.ts#localCap",
    ]);
  });

  it("attributes `rateLimit` to its DECLARING file and never to the barrel", () => {
    const keys = contractKeys(run(fixture, "contracts"));
    expect(keys).toContain("src/core/limits.ts#rateLimit");
    // Without `getAliasedSymbol` these three arrive as declarations OF THE
    // BARREL — the export specifiers live in `src/index.ts`, so the
    // "declared in another file" filter cannot see them.
    expect(keys).not.toContain("src/index.ts#rateLimit");
    expect(keys).not.toContain("src/index.ts#EXTRA");
    expect(keys).not.toContain("src/index.ts#publicName");
    // The ADDED re-export is the sharp one: it has no base-side counterpart, so
    // an unresolved alias reads as the barrel ADDING an export it does not
    // declare. `renamed` is declared in `src/renamed.ts`, which this PR did not
    // touch at all.
    expect(keys).not.toContain("src/index.ts#freshName");
  });

  it("keeps the LOCAL `export { x }`, which is an alias too", () => {
    // The control that stops the fix being "drop every alias": `localCap` has
    // no export modifier at all and IS declared in the barrel, so it must
    // survive — and with the right node, a `VariableDeclaration` whose type is
    // the literal, not an `ExportSpecifier`.
    const delta = contractsOf(run(fixture, "contracts")).find(
      (d) => d.file === "src/index.ts" && d.symbol === "localCap",
    );
    expect(delta?.change).toBe("changed");
    expect(delta?.before?.signature).toBe("5");
    expect(delta?.after?.signature).toBe("9");
  });
});

describe("a fourth trap, not in the brief — `isOptional` is not `questionToken`", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeReexportFixture();
  });
  afterAll(() => fixture?.cleanup());

  const rateLimit = (f: Fixture) =>
    contractsOf(run(f, "contracts")).find(
      (d) => d.file === "src/core/limits.ts" && d.symbol === "rateLimit",
    );

  it("marks a DEFAULTED and a REST parameter optional — `questionToken` is not enough", () => {
    // A `!!questionToken` port reports `false, false, false` for the last two,
    // which is a silent per-parameter difference in every shape carrying a
    // default and passed every other test in this package.
    expect(rateLimit(fixture)?.after?.parameters).toEqual([
      { name: "n", type: "number", optional: false },
      { name: "burst", type: "number", optional: true },
      { name: "tags", type: "string[]", optional: true },
    ]);
  });

  it("…and the printed signature carries it, which is what `sameShape` compares", () => {
    expect(rateLimit(fixture)?.after?.signature).toContain("burst?: number");
    expect(rateLimit(fixture)?.after?.signature).toContain("tags?: string[]");
  });
});

describe("trap 2 — JSDoc @throws carries the BRACED type, not the first word", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeSymbolKindsFixture();
  });
  afterAll(() => fixture?.cleanup());

  it("records `ValidationError`, never `when`", () => {
    const delta = contractsOf(run(fixture, "contracts")).find((d) => d.symbol === "Service.run");
    expect(delta, "no Service.run delta").toBeDefined();
    // WP1b bug 5: `@throws {ValidationError} when the id is empty` recorded
    // `"when"`, because the type had been lifted out of the comment text.
    // `getJsDocTagsOfSymbol` on this API would reintroduce exactly that — its
    // `text` is the braces already folded back into the prose.
    expect(delta?.after?.throws).toEqual(["ValidationError"]);
    expect(delta?.after?.throws).not.toContain("when");
  });

  it("invents no thrown type anywhere else on the same commit", () => {
    // The other half: `throws` is compared RAW by `sameShape`, so a spurious
    // entry is a phantom delta and an absence claim is a claim. `Service.run`
    // is the only export on this fixture that documents or performs a throw.
    expect(
      contractsOf(run(fixture, "contracts"))
        .filter((d) => (d.after?.throws ?? []).length > 0)
        .map((d) => [d.symbol, d.after?.throws]),
    ).toEqual([["Service.run", ["ValidationError"]]]);
  });
});

describe("trap 3 — the line numbers", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeSymbolKindsFixture();
  });
  afterAll(() => fixture?.cleanup());

  it("cites every changed symbol at its 1-based DECLARATION line", () => {
    // Written out, because that is the only thing that catches an off-by-one:
    // a 0-based leak emits a document that validates cleanly and cites a
    // perfectly plausible wrong line. `src/svc.ts` head is
    // `export class Service {` on line 1 and `run(` on line 5 (the JSDoc
    // occupies 2–4), so the 0-based answer for `Service.run` is 4.
    expect(symbolKeys(run(fixture, "facts"))).toEqual([
      "src/boot.ts:5#boot (function)",
      "src/kinds.ts:1#Mode (enum)",
      "src/kinds.ts:11#Base.run (abstract-method)",
      "src/kinds.ts:6#Label (type)",
      "src/kinds.ts:8#Base (class)",
      "src/kinds.ts:9#Base.limit (property)",
      "src/port.ts:1#Store (interface)",
      "src/port.ts:2#Store.get (interface-method)",
      "src/svc.ts:1#Service (class)",
      "src/svc.ts:5#Service.run (method)",
      "src/svc.ts:9#Service.secret (method)",
    ]);
  });

  it("cites every REFERENCE site at its 1-based line", () => {
    expect(
      symbolsOf(run(fixture, "facts"))
        .flatMap((symbol) => symbol.references.map((r) => `${symbol.name} → ${r.at}`))
        .sort(),
    ).toEqual([
      "Store → src/db.ts:1",
      "Store → src/db.ts:3",
      "Store → src/mem.ts:1",
      "Store → src/mem.ts:3",
      "Store.get → src/db.ts:4",
      "Store.get → src/mem.ts:4",
    ]);
  });

  it("`consumersOutsideDiff` cites 1-based lines too", () => {
    expect(
      contractsOf(run(fixture, "contracts"))
        .flatMap((d) => d.consumersOutsideDiff.map((c) => `${d.symbol} → ${c}`))
        .sort(),
    ).toEqual(["Store.get → src/db.ts:4", "Store.get → src/mem.ts:4"]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── DELETED 2026-08-22: "the entity sets agree" ─────────────────────────────
 *
 * Five cases across three fixtures asserted that `facts`' symbol set, its
 * per-symbol reference counts, `contracts`' key set, `consumersOutsideDiff` and
 * the printed SIGNATURES were identical on the two engines. That was the whole
 * point of the flag and it is what made the migration defensible — measured on
 * this repo's `HEAD~1..HEAD`: `facts` 44 = 44 symbols and 138 = 138 reference
 * sites, contract keys 13 = 13, `consumersOutsideDiff` 32 = 32, all compared as
 * SETS rather than counts.
 *
 * With one engine every one of them reduces to `expect(x).toEqual(x)`. They are
 * deleted rather than re-pointed because there is nothing left to point at: the
 * claim was about AGREEMENT between two printers, and re-writing it as a
 * snapshot of this printer's output would pin a literal nobody derived from
 * anything — which is the failure `noise-floor.test.ts`'s header warns about
 * ("an exact number is a snapshot"). What survives is the referee that never
 * depended on either compiler: `pnpm selfcheck`, which cross-checks the emitted
 * citations against GIT.
 *
 * The absolute pins the traps above DO carry — the barrel's key set, the four
 * declaration lines, the reference sites, `consumersOutsideDiff` — were derived
 * from those runs and are what is left of the comparison.
 */

describe("null is not [] — the founding distinction, on an engine that cannot answer", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeSymbolKindsFixture();
  });
  afterAll(() => fixture?.cleanup());

  it("reports `implementations: null` and NAMES why, never `[]`", () => {
    const document = run(fixture, "facts") as unknown as FactsDocument;
    expect(document.symbols.length).toBeGreaterThan(0);
    for (const symbol of document.symbols) {
      expect(symbol.implementations, `${symbol.name} claimed an empty implementation set`).toBeNull();
    }
    expect(document.degraded.map((d) => d.reason).join("\n")).toMatch(
      /no implementations query/,
    );
    expect(document.coverage).toBe("degraded");
  });

  /**
   * THE FLOOR, and it had to change shape when the other engine went.
   *
   * It used to be *"…and ts-morph DOES answer it"* — without that, `null`
   * everywhere could be true because the fixture has no implementers and the
   * `degraded[]` entry would be describing nothing. There is no second engine
   * to ask any more, so the floor is asserted against the FIXTURE instead: the
   * implementers exist, at known lines, and they are the answer a provider
   * would have to produce. `references` finding them by name-of-type is the
   * proof they are there; `implementations` staying `null` beside that is the
   * proof nobody looked.
   */
  it("…and the implementers really do exist — the floor, from the fixture", () => {
    const document = run(fixture, "facts") as unknown as FactsDocument;
    const store = document.symbols.find((s) => s.name === "Store");
    expect(store?.kind).toBe("interface");
    // Two classes implement `Store`, both OUTSIDE the diff, and the reference
    // query sees them. `implementations` would be
    // ["src/db.ts:3", "src/mem.ts:3"] under an engine that could ask.
    expect(store?.references.map((r) => r.at)).toEqual(
      expect.arrayContaining(["src/db.ts:3", "src/mem.ts:3"]),
    );
    expect(store?.implementations).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────

/**
 * ── DELETED 2026-08-22: "scope discipline — an unported extractor FAILS" ────
 *
 * Eight cases pinned that `--engine tsgo` refused `constants`, `all`, `deps`,
 * `patterns` and `coverage` rather than quietly serving them from ts-morph
 * (which would have loaded both compilers into one process and made the
 * peak-RSS half of the comparison a number about nothing), plus the CLI
 * refusing an unknown `--engine` and defaulting to `ts-morph`.
 *
 * `--engine` is gone, `constants` is ported, and every extractor runs on the
 * one engine — so there is no partially-ported surface left to police. Deleted
 * rather than re-pointed: a test that "the flag refuses X" cannot survive the
 * flag.
 */

describe("the envelope tells the truth about which compiler ran", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeMultiProjectFixture();
  });
  afterAll(() => fixture?.cleanup());

  it("stamps `engine: tsgo` and a languages[] nobody could mistake for silence", () => {
    const document = run(fixture, "facts") as unknown as FactsDocument;
    expect(document.engine).toBe("tsgo");
    const typescript = document.languages.find((l) => l.id === "typescript");
    // The shape the field exists to make impossible is `engine` naming a parser
    // beside `parsedFiles: 0`. `parsedFiles` is membership of a compiled
    // program, asked of the snapshot itself.
    expect(typescript?.changedFiles).toBe(3);
    expect(typescript?.parsedFiles).toBe(3);
    expect(typescript?.engine).toBe("tsgo");
  });

  it("a diff with no TS/JS in it is tier 3, not a crash", () => {
    const nonTs = makeNonTsFixture();
    try {
      const document = runExtractor({
        extractor: "facts",
        repo: nonTs.dir,
        base: nonTs.base,
        head: nonTs.head,
      }).document as unknown as FactsDocument;
      expect(document.tier).toBe(3);
      expect(document.engine).toBe("none");
      expect(document.symbols).toEqual([]);
      expect(document.coverage).toBe("degraded");
    } finally {
      nonTs.cleanup();
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────

describe("the base view is an OVERLAY, and it is symmetric by construction", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeContractFixture();
  });
  afterAll(() => fixture?.cleanup());

  it("both sides get the SAME tsconfigs and the SAME open files", () => {
    const changed = changedPaths(fixture.dir, fixture.base, fixture.head);
    const views = tsgoViews({ repo: fixture.dir, baseSha: fixture.base, changed });
    // Opened one at a time on purpose — see `collectBaseContracts`. Two tsgo
    // children alive at once is ~1.2 GB on this repo, which is more than the
    // engine being measured against costs. This test is the one place they are
    // both open, and only to compare their shapes.
    const base = views.open("base");
    const head = views.open("head");
    try {
      // The argument list is computed once and used twice — the invariant is
      // structural, so this asserts the consequence: identical program shape,
      // different content.
      expect(base.projects.map((p) => p.tsConfigPath)).toEqual(
        head.projects.map((p) => p.tsConfigPath),
      );
      expect(base.projects.map((p) => p.fileCount)).toEqual(head.projects.map((p) => p.fileCount));
      expect(base.overlaid).toBe(true);
      expect(head.overlaid).toBe(false);
    } finally {
      base.dispose();
      head.dispose();
    }
  });

  it("finds the real `getUser` delta, base `User | null` → head `User`", () => {
    const delta = contractsOf(run(fixture, "contracts")).find((d) => d.symbol === "getUser");
    expect(delta?.change).toBe("changed");
    expect(delta?.before?.returns).toBe("User | null");
    expect(delta?.after?.returns).toBe("User");
    expect(delta?.after?.throws).toEqual(["NotFoundError"]);
    // The consumer the PR did not touch — the half that makes it an obligation.
    expect(delta?.consumersOutsideDiff.length).toBeGreaterThan(0);
  });

  it("routes a file no tsconfig covers to openFiles rather than dropping it", () => {
    const multi = makeMultiProjectFixture();
    try {
      const targets = discoverTsgoTargets({
        repo: multi.dir,
        changed: changedPaths(multi.dir, multi.base, multi.head),
      });
      expect(targets.tsConfigPaths.map((p) => p.replace(`${multi.dir}/`, ""))).toEqual([
        "packages/a/tsconfig.json",
        "packages/b/tsconfig.json",
      ]);
      expect(targets.orphans).toEqual(["scripts/release.ts"]);
      // …and it is actually analysed, which is the bug-4 claim.
      const symbols = symbolsOf(run(multi, "facts"));
      expect(symbols.some((s) => s.declaredAt.startsWith("scripts/release.ts:"))).toBe(true);
    } finally {
      multi.cleanup();
    }
  });
});

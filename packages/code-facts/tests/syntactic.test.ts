/**
 * The syntactic engine — the descriptor shape, the one-pass index, and the two
 * things that decide whether name matching is worth shipping.
 *
 * The fixture below is deliberately built so BOTH engines can run over the same
 * tree: it has a working tsconfig (tier 1, ts-morph, type-resolved) and a
 * broken-tsconfig twin (tier 2, ast-grep, name-matched). That is the whole
 * measurement strategy of `scripts/name-match-gate.ts` reduced to a size a test
 * can assert exactly — and the numbers here are the SHAPE the gate measures at
 * scale: `TIMEOUT` is declared twice in the repo, so half of its name-matched
 * reference set is a site the compiler says belongs to a different symbol.
 *
 * Real git repos with real commits, like every other fixture here. A mock of
 * either half would let the claim be wrong while the test passed.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeFixture, makeIgnoredScopeFixture, TSCONFIG, type Fixture } from "./helpers.js";
import { runExtractor } from "../src/run.js";
import {
  buildSyntacticIndex,
  extractFactsByName,
  isIndexablePath,
  nameAmbiguityOf,
  scanSource,
} from "../src/syntactic.js";
import { changedPaths, diffHunks } from "../src/git.js";
import { isScannablePath } from "../src/project.js";
import {
  descriptorForPath,
  interestingKinds,
  registeredExtensions,
  supportedKinds,
  JAVASCRIPT_DESCRIPTOR,
  LANGUAGE_DESCRIPTORS,
  TYPESCRIPT_DESCRIPTOR,
} from "../src/langs/index.js";
import type { FactsDocument } from "../src/schema.js";

const PACKAGE_JSON = JSON.stringify({ name: "fixture-ambiguity", version: "1.0.0" }, null, 2);

/**
 * One tree, two names that collide and two that do not.
 *
 *   TIMEOUT   declared TWICE — `src/config.ts` (the diff) and `src/other/shadow.ts`
 *             (an unrelated module-local). nameAmbiguity 2.
 *   run       declared TWICE — a method on `Store` and a free function. nameAmbiguity 2.
 *   wait      declared once. nameAmbiguity 1.
 *   Store     declared once. nameAmbiguity 1.
 *
 * `tsconfig` selects which engine the same tree is analysed by.
 */
function ambiguityFiles(tsconfig: string): Record<string, string> {
  return {
    "tsconfig.json": tsconfig,
    "package.json": PACKAGE_JSON,
    "src/config.ts": `export const TIMEOUT = 30;\n`,
    "src/client/wait.ts": `import { TIMEOUT } from "../config.js";\n\nexport function wait(): number {\n  return TIMEOUT;\n}\n`,
    // A DIFFERENT symbol with the same spelling, plus a reference to it. The
    // type-checker never confuses the two; a name matcher always does.
    "src/other/shadow.ts": `const TIMEOUT = 999;\n\nexport function shadow(): number {\n  return TIMEOUT;\n}\n`,
    "src/store.ts": `export class Store {\n  run(id: string): string {\n    return id;\n  }\n}\n`,
    "src/runner.ts": `export function run(id: string): string {\n  return id;\n}\n`,
    "src/use.ts": `import { Store } from "./store.js";\nimport { run } from "./runner.js";\n\nexport function go(store: Store): string {\n  return store.run(run("x"));\n}\n`,
    "test/wait.test.ts": `import { wait } from "../src/client/wait.js";\n\nexport const seen = wait();\n`,
  };
}

function ambiguityHead(): Record<string, string> {
  return {
    "src/config.ts": `export const TIMEOUT = 60;\n`,
    "src/client/wait.ts": `import { TIMEOUT } from "../config.js";\n\nexport function wait(retries?: number): number {\n  return retries ? TIMEOUT * retries : TIMEOUT;\n}\n`,
    "src/store.ts": `export class Store {\n  run(id: string, fresh?: boolean): string {\n    return fresh ? id : id;\n  }\n}\n`,
  };
}

function makeAmbiguityFixture(tsconfig: string, name: string): Fixture {
  return makeFixture(
    name,
    { message: "base", files: ambiguityFiles(tsconfig) },
    { message: "head", files: ambiguityHead() },
  );
}

function facts(fixture: Fixture): FactsDocument {
  return runExtractor({
    extractor: "facts",
    repo: fixture.dir,
    base: fixture.base,
    head: fixture.head,
    // Unbounded, so the two engines' sets are compared whole rather than
    // through two different truncations.
    maxReferences: 0,
  }).document as unknown as FactsDocument;
}

// ── the descriptor shape ─────────────────────────────────────────────────────

describe("langs — the descriptor shape", () => {
  /**
   * THE REGRESSION GUARD FOR THE ONE BUG THIS LAYER ALREADY HAD.
   *
   * ast-grep does not ignore a node kind its grammar has never heard of — it
   * refuses the WHOLE rule. One rule table shared across the TS and JS grammars
   * therefore threw on every `.js` file, and a `try`/`catch` around the parse
   * turned that into "this file contained nothing", which is the silent-empty
   * failure mode the whole package is engineered against. It was caught by
   * `constants`' own `.js` end-to-end test going red, not by anything here.
   */
  it("resolves every declared node kind against the grammar, and NAMES the ones a grammar lacks", () => {
    const everything = { declarations: true, references: true, literals: true, calls: true };
    const typescript = supportedKinds(
      TYPESCRIPT_DESCRIPTOR,
      interestingKinds(TYPESCRIPT_DESCRIPTOR, everything),
    );
    expect(typescript.rejected, "the table is written against the TypeScript grammar").toEqual([]);

    const javascript = supportedKinds(
      JAVASCRIPT_DESCRIPTOR,
      interestingKinds(JAVASCRIPT_DESCRIPTOR, everything),
    );
    // TS-only syntax has no JS node kind, and that is benign — what is NOT
    // benign is it taking the whole rule down with it.
    expect(javascript.rejected).toContain("type_identifier");
    expect(javascript.rejected).toContain("interface_declaration");
    expect(javascript.kinds).toContain("identifier");
    expect(javascript.kinds).toContain("string");
    expect(javascript.kinds).toContain("variable_declarator");
  });

  /**
   * A scan asks for the node kinds its SINK can use and no more. `constants`'
   * literal sweep is the one thing in this package that has ever dominated its
   * wall clock, and asking for every identifier in the repository on its behalf
   * would have made the "one pass is cheaper" claim false.
   */
  it("asks the parser for the kinds the caller can use, and no more", () => {
    const literalsOnly = interestingKinds(TYPESCRIPT_DESCRIPTOR, { literals: true });
    expect(literalsOnly.sort()).toEqual(["false", "number", "string", "true"]);
    expect(interestingKinds(TYPESCRIPT_DESCRIPTOR, { references: true })).toContain("identifier");
    // Declarations come along with references whether or not they were asked
    // for: the enclosing stack is what gives a reference its `inSymbol`.
    expect(interestingKinds(TYPESCRIPT_DESCRIPTOR, { references: true })).toContain(
      "class_declaration",
    );
    expect(interestingKinds(TYPESCRIPT_DESCRIPTOR, { declarations: true })).not.toContain(
      "identifier",
    );
    expect(interestingKinds(TYPESCRIPT_DESCRIPTOR, { calls: true })).toEqual(["call_expression"]);
  });

  it("still scans a .js file end to end, which is what the rejected list buys", () => {
    const declarations: string[] = [];
    const references: string[] = [];
    const literals: string[] = [];
    const ok = scanSource(
      JAVASCRIPT_DESCRIPTOR,
      "src/plain.js",
      `export const LABEL = "beta";\nexport function shout() {\n  return LABEL;\n}\n`,
      {
        wantsValue: () => true,
        declaration: (site) => declarations.push(`${site.kind}:${site.name}`),
        reference: (name) => references.push(name),
        literal: (value) => literals.push(value),
      },
    );
    expect(ok).toBe(true);
    expect(declarations).toEqual(["variable:LABEL", "function:shout"]);
    expect(references).toEqual(["LABEL"]);
    expect(literals).toEqual(["beta"]);
  });

  it("qualifies a member with its enclosing declaration, so `run` is not a name nobody can look up", () => {
    const declarations: string[] = [];
    scanSource(
      TYPESCRIPT_DESCRIPTOR,
      "src/store.ts",
      `export class Store {\n  limit = 5;\n  run(id: string): string {\n    return id;\n  }\n}\n`,
      { declaration: (site) => declarations.push(`${site.kind}:${site.name}:${site.localName}`) },
    );
    expect(declarations).toEqual([
      "class:Store:Store",
      "property:Store.limit:limit",
      "method:Store.run:run",
    ]);
  });

  it("reads export-ness off the syntax, and only claims it where the syntax says so", () => {
    const exported = new Map<string, boolean>();
    scanSource(
      TYPESCRIPT_DESCRIPTOR,
      "src/a.ts",
      `export const PUBLIC = 1;\nconst PRIVATE = 2;\nexport function open() {}\nfunction closed() {}\n`,
      { declaration: (site) => exported.set(site.name, site.exported) },
    );
    expect(exported.get("PUBLIC")).toBe(true);
    expect(exported.get("PRIVATE")).toBe(false);
    expect(exported.get("open")).toBe(true);
    expect(exported.get("closed")).toBe(false);
  });

  it("claims exactly the extensions the rest of the package already analyses", () => {
    // The parity guard. `isIndexablePath` is expressed through the descriptor
    // registry and `isScannablePath` through the hard-coded extension list; the
    // day they disagree is the day a file is in one scan and not the other.
    for (const path of [
      "a.ts", "a.tsx", "a.mts", "a.cts", "a.js", "a.jsx", "a.mjs", "a.cjs", "a.es6",
      "a.py", "a.java", "a.json", "dist/a.js", "src/a.min.js", "src/",
    ]) {
      expect(isIndexablePath(path), path).toBe(isScannablePath(path));
    }
    expect(registeredExtensions()).toContain(".es6");
    expect(descriptorForPath("a.py")).toBeNull();
    expect(LANGUAGE_DESCRIPTORS.length).toBeGreaterThan(0);
  });
});

// ── the one-pass index ───────────────────────────────────────────────────────

describe("syntactic — the one-pass index", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeAmbiguityFixture(TSCONFIG, "ambiguity-tier1");
  });
  afterAll(() => fixture.cleanup());

  it("produces declarations, references and literals from ONE walk", () => {
    const index = buildSyntacticIndex({
      repo: fixture.dir,
      ref: fixture.head,
      names: new Set(["TIMEOUT", "wait", "run", "Store"]),
      values: new Map([["60", "number"]]),
    });

    expect(index.source).toBe("tree");
    expect(index.filesScanned).toBeGreaterThan(0);
    expect(index.truncated).toBe(false);

    // Declarations — every site in the repo that BINDS the name.
    expect(index.declarations.get("TIMEOUT")?.map((d) => `${d.path}:${d.line}`).sort()).toEqual([
      "src/config.ts:1",
      "src/other/shadow.ts:1",
    ]);
    expect(index.declarations.get("wait")?.map((d) => d.path)).toEqual(["src/client/wait.ts"]);

    // References — every site that MENTIONS it, with the enclosing symbol.
    const timeoutRefs = (index.references.get("TIMEOUT") ?? []).map((r) => `${r.path}:${r.line}`);
    expect(timeoutRefs).toContain("src/client/wait.ts:1"); // the import specifier
    expect(timeoutRefs).toContain("src/other/shadow.ts:4"); // the OTHER symbol's use
    expect(index.referenceCounts.get("TIMEOUT")).toBe(timeoutRefs.length);
    expect(
      (index.references.get("wait") ?? []).some((r) => r.isTest && r.path === "test/wait.test.ts"),
    ).toBe(true);
    expect(
      (index.references.get("TIMEOUT") ?? []).find((r) => r.path === "src/other/shadow.ts")?.inSymbol,
    ).toBe("shadow");

    // Literals — set B, in the same pass.
    expect((index.literals.get("60") ?? []).map((l) => `${l.path}:${l.line}`)).toEqual([
      "src/config.ts:1",
    ]);
  });

  it("keys `references` on the BARE name, so a method is reachable from its call sites", () => {
    const index = buildSyntacticIndex({
      repo: fixture.dir,
      ref: fixture.head,
      names: new Set(["run"]),
    });
    const sites = (index.references.get("run") ?? []).map((r) => `${r.path}:${r.line}`);
    // The import specifier plus `store.run(run("x"))` — the method call and
    // the free function, on one line, and this layer cannot tell you which is
    // which. That is the point.
    expect(sites.filter((s) => s.startsWith("src/use.ts")).length).toBe(3);
  });

  it("records nothing for a name nobody asked about — the index is BOUNDED by the diff", () => {
    const index = buildSyntacticIndex({
      repo: fixture.dir,
      ref: fixture.head,
      names: new Set(["TIMEOUT"]),
    });
    expect(index.references.has("TIMEOUT")).toBe(true);
    expect(index.references.has("run")).toBe(false);
    expect(index.declarations.has("Store")).toBe(false);
  });

  it("costs nothing at all when there is nothing to look for", () => {
    const index = buildSyntacticIndex({ repo: fixture.dir, ref: fixture.head, names: new Set() });
    expect(index.filesScanned).toBe(0);
    expect(index.filesEligible).toBe(0);
  });

  /**
   * The index inherits `git.listFiles`, so the two properties that made
   * `constants` trustworthy are true here without a second implementation:
   * `.gitignore` is honoured by construction, and the scan resolves against a
   * COMMIT rather than the working directory.
   */
  it("honours .gitignore and resolves at the head COMMIT, because it goes through git", () => {
    const ignored = makeIgnoredScopeFixture();
    try {
      const atHead = buildSyntacticIndex({
        repo: ignored.dir,
        ref: ignored.head,
        names: new Set(["scratch", "copied", "snap", "legacyExpiry"]),
      });
      // Untracked-and-ignored, and untracked-and-not-ignored: neither is in the
      // tree, and a `path:line` from this index is a claim about `headSha`.
      expect(atHead.declarations.has("copied")).toBe(false);
      expect(atHead.declarations.has("snap")).toBe(false);
      expect(atHead.declarations.has("scratch")).toBe(false);
      expect(atHead.declarations.get("legacyExpiry")?.[0].path).toBe("src/legacy/auth.ts");

      // …and the same files ARE on disk, so this is a statement about which
      // tree was read rather than about the files existing.
      const worktree = buildSyntacticIndex({
        repo: ignored.dir,
        ref: null,
        names: new Set(["scratch", "snap"]),
      });
      expect(worktree.declarations.has("scratch")).toBe(true);
      expect(worktree.declarations.has("snap")).toBe(false); // nested .gitignore
    } finally {
      ignored.cleanup();
    }
  });
});

// ── nameAmbiguity ────────────────────────────────────────────────────────────

describe("syntactic — nameAmbiguity", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeAmbiguityFixture(TSCONFIG, "ambiguity-count");
  });
  afterAll(() => fixture.cleanup());

  it("counts distinct declaration SITES binding the same name", () => {
    const index = buildSyntacticIndex({
      repo: fixture.dir,
      ref: fixture.head,
      names: new Set(["TIMEOUT", "run", "wait", "Store", "nothing"]),
    });
    expect(nameAmbiguityOf(index, "TIMEOUT")).toBe(2); // config.ts + shadow.ts
    expect(nameAmbiguityOf(index, "run")).toBe(2); // Store.run + runner.run
    expect(nameAmbiguityOf(index, "wait")).toBe(1);
    expect(nameAmbiguityOf(index, "Store")).toBe(1);
    expect(nameAmbiguityOf(index, "nothing")).toBe(0);
  });

  /**
   * THE COST, pinned as a number rather than described in a comment.
   *
   * `src/other/shadow.ts` declares its own `TIMEOUT` and uses it. The compiler
   * knows those are a different symbol; the name matcher cannot, so the
   * name-matched reference set for the CHANGED `TIMEOUT` contains a site that
   * is not a reference to it. `nameAmbiguity: 2` is the only thing in the
   * document that says so — which is exactly why it is data and not a filter.
   */
  it("is the number that says how much of a name-matched set is a guess", () => {
    const result = extractFactsByName({
      repo: fixture.dir,
      headSha: fixture.head,
      hunks: diffHunks(fixture.dir, fixture.base, fixture.head),
      changed: changedPaths(fixture.dir, fixture.base, fixture.head),
      maxReferences: 0,
    });
    const timeout = result.payload.symbols.find((s) => s.name === "TIMEOUT");
    expect(timeout?.nameAmbiguity).toBe(2);
    expect(timeout?.references.map((r) => r.at)).toContain("src/other/shadow.ts:4");

    const wait = result.payload.symbols.find((s) => s.name === "wait");
    expect(wait?.nameAmbiguity).toBe(1);
    expect(wait?.references.map((r) => r.at)).toEqual(["test/wait.test.ts:1", "test/wait.test.ts:3"]);
    expect(wait?.tests).toEqual(["test/wait.test.ts"]);
  });
});

// ── the two engines, on the same tree ────────────────────────────────────────

describe("facts — resolution, tier 1 against tier 2", () => {
  let tier1: Fixture;
  let tier2: Fixture;
  beforeAll(() => {
    tier1 = makeAmbiguityFixture(TSCONFIG, "resolution-tier1");
    // The same tree with a tsconfig that will not parse — the tier-2 shape, and
    // the only difference between the two documents below.
    tier2 = makeAmbiguityFixture(`{ "compilerOptions": { "strict": true `, "resolution-tier2");
  });
  afterAll(() => {
    tier1.cleanup();
    tier2.cleanup();
  });

  it("stamps `type-aware` on tier 1, and asks nobody for nameAmbiguity there", () => {
    const document = facts(tier1);
    expect(document.tier).toBe(1);
    expect(document.symbols.length).toBeGreaterThan(0);
    expect(document.symbols.every((s) => s.resolution === "type-aware")).toBe(true);
    // `null` = NOBODY LOOKED, and nobody did: it costs a repo-wide parse a
    // type-resolved run has no other use for. `0` would be a measurement.
    expect(document.symbols.every((s) => s.nameAmbiguity === null)).toBe(true);
  });

  it("stamps `name-match` on tier 2, with the ambiguity beside it", () => {
    const document = facts(tier2);
    expect(document.tier).toBe(2);
    expect(document.engine).toBe("ast-grep");
    expect(document.symbols.length).toBeGreaterThan(0);
    expect(document.symbols.every((s) => s.resolution === "name-match")).toBe(true);
    expect(document.symbols.every((s) => (s.nameAmbiguity ?? 0) >= 1)).toBe(true);
    expect(document.coverage).toBe("degraded");
    expect(document.degraded.some((d) => /NAME MATCHING/.test(d.reason))).toBe(true);
  });

  /**
   * The gate's hypothesis, at fixture scale: name matching OVER-approximates —
   * it should contain the type-resolved set — and the excess is exactly where
   * `nameAmbiguity > 1`.
   */
  it("over-approximates rather than under-approximating: the type-resolved set is a SUBSET", () => {
    const typed = facts(tier1);
    const named = facts(tier2);
    for (const symbol of typed.symbols) {
      const twin = named.symbols.find((s) => s.name === symbol.name);
      if (!twin) continue;
      const namedSites = new Set(twin.references.map((r) => r.at));
      for (const reference of symbol.references) {
        expect(namedSites.has(reference.at), `${symbol.name} → ${reference.at}`).toBe(true);
      }
    }
  });

  it("is EXACT where the name is unambiguous, and inflated where it is not", () => {
    const typed = facts(tier1);
    const named = facts(tier2);
    const sitesOf = (document: FactsDocument, name: string): Set<string> =>
      new Set(document.symbols.find((s) => s.name === name)?.references.map((r) => r.at) ?? []);

    // nameAmbiguity 1 — the two engines agree exactly.
    expect([...sitesOf(named, "wait")].sort()).toEqual([...sitesOf(typed, "wait")].sort());

    // nameAmbiguity 2 — the name matcher keeps a site the compiler assigns to a
    // DIFFERENT symbol, and the document does not hide it.
    expect(sitesOf(typed, "TIMEOUT").has("src/other/shadow.ts:4")).toBe(false);
    expect(sitesOf(named, "TIMEOUT").has("src/other/shadow.ts:4")).toBe(true);
  });
});

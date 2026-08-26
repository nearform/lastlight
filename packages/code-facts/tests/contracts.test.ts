/**
 * `contracts` — the base-vs-head semantic delta.
 *
 * `getUser(): User | null` becoming `getUser(): User` plus a thrown
 * `NotFoundError` is the regression class this extractor exists for, and
 * `consumersOutsideDiff` is what turns it from a curiosity into an obligation:
 * those are the call sites the PR did not touch and the reviewer will not see.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeContractFixture,
  makeConstantFixture,
  makeSymbolKindsFixture,
  type Fixture,
} from "./helpers.js";
import { runExtractor } from "../src/run.js";
import { canonicalType, type Shape } from "../src/contracts.js";
import {
  exportedDeclarations,
  extractContractsTsgo,
  shapeOfTsgo,
  type BaseContractView,
} from "../src/tsgo-extractors.js";
import { openSnapshot, type EngineSnapshot } from "../src/tsgo.js";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ContractsDocument } from "../src/schema.js";

/**
 * A throwaway on-disk project, opened through the real compiler.
 *
 * The three cases below used to build `new Project({ useInMemoryFileSystem })`.
 * There is no in-memory equivalent on this engine — `tsgo` is a child process
 * reading a real filesystem — and that is a feature rather than an obstacle:
 * `tests/helpers.ts`'s rule is that fixtures are real trees, because every claim
 * this package makes is a claim about what a type-checker says, and mocking the
 * checker would let the claim be wrong while the test passed.
 */
function withProject<T>(files: Record<string, string>, fn: (ctx: { snapshot: EngineSnapshot; dir: string }) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "ll-facts-contracts-"));
  try {
    writeFileSync(
      join(dir, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "es2022", module: "nodenext", moduleResolution: "nodenext", strict: true },
        include: ["src"],
      }),
      "utf8",
    );
    for (const [path, source] of Object.entries(files)) {
      mkdirSync(join(dir, dirname(path)), { recursive: true });
      writeFileSync(join(dir, path), source, "utf8");
    }
    const snapshot = openSnapshot({ repo: dir, tsConfigPaths: [join(dir, "tsconfig.json")] });
    try {
      return fn({ snapshot, dir });
    } finally {
      snapshot.dispose();
    }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** The `Shape` of one named export, straight off the checker. */
function shapeOfExport(snapshot: EngineSnapshot, path: string, name: string): Shape {
  const file = snapshot.lookup(path);
  if (!file) throw new Error(`${path} is in no compiled program`);
  const declaration = exportedDeclarations(file.sourceFile, file.owner.project).find(
    (d) => d.name === name,
  );
  if (!declaration) throw new Error(`${path} does not export ${name}`);
  return shapeOfTsgo(declaration.node, file.owner.project);
}

/** A base view holding nothing — what a file absent from the base program is. */
const EMPTY_BASE: BaseContractView = { shapes: new Map(), presentPaths: new Set() };

describe("contracts — the semantic delta", () => {
  let fixture: Fixture;
  let document: ContractsDocument;

  beforeAll(() => {
    fixture = makeContractFixture();
    document = runExtractor({
      extractor: "contracts",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    }).document as unknown as ContractsDocument;
  });
  afterAll(() => fixture.cleanup());

  it("reports the nullability change and the newly thrown type", () => {
    const delta = document.contracts.find((c) => c.symbol === "getUser");
    expect(delta?.change).toBe("changed");
    expect(delta?.before?.returns).toBe("User | null");
    expect(delta?.before?.nullableReturn).toBe(true);
    expect(delta?.after?.returns).toBe("User");
    expect(delta?.after?.nullableReturn).toBe(false);
    expect(delta?.after?.throws).toEqual(["NotFoundError"]);
  });

  it("names the consumers OUTSIDE the diff — the ones that silently rot", () => {
    const delta = document.contracts.find((c) => c.symbol === "getUser");
    expect(delta?.consumersOutsideDiff).toContain("src/api/handler.ts:4");
    expect(delta?.consumersOutsideDiff.some((c) => c.includes("(test)"))).toBe(true);
  });

  it("reports an added export as `added` with no `before`", () => {
    const added = document.contracts.find((c) => c.symbol === "NotFoundError");
    expect(added?.change).toBe("added");
    expect(added?.before).toBeNull();
  });

  it("does not emit a delta for an unchanged export", () => {
    // `User` is declared in the changed file but its shape did not move.
    expect(document.contracts.map((c) => c.symbol)).not.toContain("User");
  });

  /**
   * WP1 is explicit: build the base tree with `git worktree add`, do NOT mutate
   * the agent's working tree. The review workspace is reused across runs and
   * the agent reads it concurrently, so a `git checkout` here would be a race
   * that presents as the reviewer quoting the wrong version of a file.
   */
  it("leaves the working tree and the worktree list clean", () => {
    const status = runExtractor({
      extractor: "contracts",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    });
    expect(status.exitCode).toBe(0);
    // No leftover linked worktrees, and HEAD is still where it was.
    const worktrees = join(fixture.dir, ".git", "worktrees");
    expect(!existsSync(worktrees) || readdirSync(worktrees).length === 0).toBe(true);
  });

  /**
   * The one-sided guard. Measured on this monorepo's own WP0 commit: with the
   * head project forced to one tsconfig and the base discovering another, the
   * extractor reported **227 contract deltas of which 4 were real** — 65 of them
   * "removed export" for a file the head program simply did not contain.
   *
   * A phantom removal is not noise, it is a HARMFUL seed: IRIS measured a
   * half-mechanism seed at −3, worse than no seed at all. So a modified file
   * present in only one of the two programs is skipped and RECORDED.
   */
  it("never invents added/removed for a modified file only one program contains", () => {
    withProject({ "src/user.ts": "export function getUser(): string { return ''; }\n" }, ({ snapshot, dir }) => {
      const result = extractContractsTsgo({
        repo: dir,
        head: snapshot,
        // The base view simply does not hold the file — which is what an
        // unparsable tsconfig, a forced `--tsconfig`, or a base overlay that
        // could not serve the blob produces.
        base: EMPTY_BASE,
        changed: [{ path: "src/user.ts", status: "modified" }],
        hunkIndex: new Map(),
      });

      expect(result.payload.contracts).toEqual([]);
      expect(result.degraded).toHaveLength(1);
      expect(result.degraded[0].reason).toMatch(/would be phantom/);
      expect(result.degraded[0].reason).toMatch(/base side not analysed/);
    });
  });

  it("still reports a genuinely ADDED file, where one side is legitimately absent", () => {
    withProject({ "src/new.ts": "export const FRESH = 1;\n" }, ({ snapshot, dir }) => {
      const result = extractContractsTsgo({
        repo: dir,
        head: snapshot,
        base: EMPTY_BASE,
        changed: [{ path: "src/new.ts", status: "added" }],
        hunkIndex: new Map(),
      });

      expect(result.degraded).toEqual([]);
      expect(result.payload.contracts.map((c) => [c.symbol, c.change])).toEqual([["FRESH", "added"]]);
    });
  });

  it("reports a changed file missing from BOTH programs through the project tier, not silently", () => {
    const constant = makeConstantFixture();
    try {
      const result = runExtractor({
        extractor: "contracts",
        repo: constant.dir,
        base: constant.base,
        head: constant.head,
        // Covers `src/config.ts` but NOT `src/legacy/auth.ts`, which the same
        // diff also modified. Both sides now use this tsconfig, so the file is
        // absent from both — and the run must still say so.
        tsConfigPath: writeNarrowTsConfig(constant.dir),
      });
      const document = result.document as unknown as ContractsDocument;
      expect(document.contracts.some((c) => c.file === "src/legacy/auth.ts")).toBe(false);
      expect(document.coverage).toBe("degraded");
      expect(
        document.degraded.some((d) => /not in any compiled program/.test(d.reason)),
        "a changed file nobody analysed must be named",
      ).toBe(true);
    } finally {
      constant.cleanup();
    }
  });
});

/**
 * The branches a two-file fixture could never reach: a real DELETION (the
 * `removed` branch, which nothing had ever executed), a member delta keyed
 * `Class.method` and `Interface.method`, a JSDoc `@throws`, and the private
 * method that must stay out of the delta however much it changes.
 */
describe("contracts — members, deletions and documented throws", () => {
  let fixture: Fixture;
  let document: ContractsDocument;

  beforeAll(() => {
    fixture = makeSymbolKindsFixture();
    document = runExtractor({
      extractor: "contracts",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    }).document as unknown as ContractsDocument;
  });
  afterAll(() => fixture.cleanup());

  const delta = (symbol: string) => document.contracts.find((c) => c.symbol === symbol);

  /**
   * A file the PR deleted has a base side and no head side, so every export in
   * it is `removed` — with `before` populated and `after` null, which is the
   * shape a seeder reads as "this is gone, and here is what it used to be".
   */
  it("reports every export of a deleted file as `removed`", () => {
    const removed = delta("farewell");
    expect(removed?.change).toBe("removed");
    expect(removed?.file).toBe("src/gone.ts");
    expect(removed?.after).toBeNull();
    expect(removed?.before?.returns).toBe("string");
    // The declaration is gone, so there is no node left to query for consumers.
    expect(removed?.consumersOutsideDiff).toEqual([]);
  });

  it("keys a class method `Class.method` and an interface method `Interface.method`", () => {
    expect(delta("Base.run")?.file).toBe("src/kinds.ts");
    expect(delta("Base.run")?.change).toBe("changed");
    expect(delta("Store.get")?.file).toBe("src/port.ts");
    expect(delta("Store.get")?.change).toBe("changed");
  });

  /**
   * A PARAMETER-LIST-ONLY delta: the return type is identical on both sides and
   * the signature grew one optional argument. It is the commonest real contract
   * change there is, and the one a diff hides best — every existing call site
   * still compiles.
   */
  it("reports a parameter-list-only change, with the return type unmoved", () => {
    const changed = delta("Service.run");
    expect(changed?.change).toBe("changed");
    expect(changed?.before?.returns).toBe(changed?.after?.returns);
    expect(changed?.before?.parameters.map((p) => p.name)).toEqual(["id"]);
    expect(changed?.after?.parameters.map((p) => [p.name, p.optional])).toEqual([
      ["id", false],
      ["retries", true],
    ]);
  });

  /**
   * A DOCUMENTED throw, in the spelling almost everybody writes. TypeScript
   * parses `@throws {ValidationError} desc` as a `JSDocThrowsTag` and lifts the
   * braces into a separate type expression, so reading the type off the tag's
   * COMMENT recorded the first word of the description — `"when"` — as the
   * thrown type, and a bare `@throws {TypeError}` produced nothing at all.
   */
  it("reads the thrown type out of a JSDoc `@throws`, not out of its prose", () => {
    expect(delta("Service.run")?.after?.throws).toEqual(["ValidationError"]);
    expect(delta("Service.run")?.before?.throws).toEqual([]);
  });

  it("never emits a delta for a PRIVATE method, however much it changed", () => {
    // `Service.secret` goes from `(): number` to `(): string` at head. It is not
    // part of the class's observable contract, so it is not an obligation.
    expect(document.contracts.map((c) => c.symbol)).not.toContain("Service.secret");
    expect(document.contracts.some((c) => c.symbol === "Service.run")).toBe(true);
  });
});

/**
 * The three JSDoc spellings, in isolation — the braced form is the one that was
 * broken and the un-braced one is what the fallback still has to read.
 */
describe("contracts — `@throws`, all three spellings", () => {
  it("takes the type from the tag's type expression, with or without a description", () => {
    withProject(
      {
        "src/throws.ts": [
          "/**\n * @throws {ValidationError} when the id is empty\n */",
          "export function braced(id: string): string { return id; }",
          "/**\n * @throws {TypeError}\n */",
          "export function bracedOnly(id: string): string { return id; }",
          "/**\n * @throws PlainError with a description\n */",
          "export function bare(id: string): string { return id; }",
          "export function undocumented(id: string): string { return id; }",
        ].join("\n"),
      },
      ({ snapshot }) => {
        const throwsOf = (name: string): string[] =>
          shapeOfExport(snapshot, "src/throws.ts", name).throws;

        // Before the fix these read ["when"], [] and ["PlainError"] — two of the
        // three wrong, and the wrong ones are the common spelling. The braced
        // type comes off `JSDocThrowsTag.typeExpression`, which this engine DOES
        // populate over the wire; `Checker.getJsDocTagsOfSymbol` would re-create
        // the bug, because its `text` is the braces already folded into prose.
        expect(throwsOf("braced")).toEqual(["ValidationError"]);
        expect(throwsOf("bracedOnly")).toEqual(["TypeError"]);
        expect(throwsOf("bare")).toEqual(["PlainError"]);
        // …and nothing is invented for a function that documents no throw.
        expect(throwsOf("undocumented")).toEqual([]);
      },
    );
  });

  it("strips the import path out of a documented cross-module throw", () => {
    withProject(
      {
        "src/errors.ts": "export class HttpError extends Error {}\n",
        "src/x.ts": '/**\n * @throws {import("./errors.js").HttpError}\n */\nexport function f(): void {}\n',
      },
      ({ snapshot }) => {
        // `throws` is compared RAW by `sameShape`, so an unstripped specifier
        // here is a delta about a directory rather than about the PR — and on a
        // `$TMPDIR` fixture the two spellings of the root differ by `/private`.
        expect(shapeOfExport(snapshot, "src/x.ts", "f").throws).toEqual(["HttpError"]);
      },
    );
  });
});

/**
 * Type TEXT is not stable between two programs, and every instability produces
 * a contract delta that did not happen.
 */
describe("contracts — canonical type text", () => {
  it("strips the absolute path out of an unnamed type", () => {
    expect(canonicalType('import("/private/var/folders/x/y/src/user").User')).toBe("User");
    expect(canonicalType('Promise<import("/tmp/a/b").Foo | null>')).toBe("Promise<Foo | null>");
  });

  it("treats a reordered union as the same type", () => {
    expect(canonicalType('"fail" | "complete"')).toBe(canonicalType('"complete" | "fail"'));
    expect(canonicalType("A | B | C")).toBe(canonicalType("C | A | B"));
  });

  it("reorders a union nested inside an object member — the case that survived twice", () => {
    const a = '{ retries: number; then: "complete" | "fail"; }';
    const b = '{ retries: number; then: "fail" | "complete"; }';
    expect(canonicalType(a)).toBe(canonicalType(b));
  });

  it("keeps a real difference different, and never reorders parameters", () => {
    expect(canonicalType('"fail" | "complete"')).not.toBe(canonicalType('"fail" | "skipped"'));
    expect(canonicalType("(a: string, b: number) => void")).not.toBe(
      canonicalType("(b: number, a: string) => void"),
    );
  });
});

/** A tsconfig that deliberately covers only part of the changed set. */
function writeNarrowTsConfig(repo: string): string {
  const path = join(repo, "narrow.tsconfig.json");
  writeFileSync(
    path,
    JSON.stringify({
      compilerOptions: { strict: true, noEmit: true },
      include: ["src/config.ts", "src/client/**/*"],
    }),
    "utf8",
  );
  return path;
}

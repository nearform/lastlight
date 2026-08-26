/**
 * The invariants — every fixture, every extractor, cross-checked against GIT.
 *
 * Every other test file here asserts what an extractor SAID. That is exactly
 * the shape of assertion that let `contracts` report 227 deltas of which one
 * was real on the first real commit it ever ran against, with 101 unit tests
 * green throughout: the extractor and the test agreed, and both were wrong.
 *
 * So this file asserts nothing about the content of a document directly. It
 * runs `checkAll` — an oracle whose only source of truth is `git show`,
 * `git diff --name-status` and `git diff -U0` — and demands zero violations.
 * Plus the three properties nothing else pins at all: determinism, the working
 * tree being left alone, and `all` actually agreeing with the single runs it
 * claims to summarise.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  makeBarrelFixture,
  makeBrokenTsConfigFixture,
  makeConstantFixture,
  makeContractFixture,
  makeDepsFixture,
  makeFixture,
  makeNonTsFixture,
  TSCONFIG,
  type Fixture,
} from "./helpers.js";
import { runExtractor } from "../src/run.js";
import { checkAll, type Violation } from "../src/selfcheck.js";
import type { ExtractorName } from "../src/schema.js";

const FIXTURES: Record<string, () => Fixture> = {
  constant: makeConstantFixture,
  contract: makeContractFixture,
  barrel: makeBarrelFixture,
  deps: makeDepsFixture,
  "non-ts": makeNonTsFixture,
  "broken-tsconfig": makeBrokenTsConfigFixture,
};

const SINGLE_EXTRACTORS: ExtractorName[] = [
  "facts",
  "contracts",
  "constants",
  "deps",
  "patterns",
  "coverage",
];
const ALL_EXTRACTORS: ExtractorName[] = [...SINGLE_EXTRACTORS, "all"];

type Document = Record<string, unknown>;

function run(fixture: Fixture, extractor: ExtractorName): Document {
  return runExtractor({
    extractor,
    repo: fixture.dir,
    base: fixture.base,
    head: fixture.head,
  }).document;
}

function format(violations: Violation[]): string {
  return violations.map((v) => `  [${v.check}] ${v.extractor}: ${v.detail}`).join("\n");
}

describe.each(Object.keys(FIXTURES))("%s fixture — checked against git, not against ts-morph", (name) => {
  let fixture: Fixture;
  const documents = new Map<ExtractorName, Document>();

  beforeAll(() => {
    fixture = FIXTURES[name]();
    for (const extractor of ALL_EXTRACTORS) documents.set(extractor, run(fixture, extractor));
  });
  afterAll(() => fixture?.cleanup());

  it.each(ALL_EXTRACTORS)("`%s` produces zero self-consistency violations", (extractor) => {
    const violations = checkAll(fixture.dir, documents.get(extractor)!);
    expect(violations, `${extractor} on the ${name} fixture:\n${format(violations)}`).toEqual([]);
  });

  /**
   * Nothing pinned this before, and there are two plausible sources of churn:
   * `findReferencesAsNodes()` makes no ordering promise, and
   * `findLiteralOccurrences` walks the repo with `readdirSync`, whose order is
   * filesystem-defined. A document that differs between two runs of the same
   * commit makes every downstream comparison — model A vs model B, before vs
   * after a prompt change — measure the noise as well as the change.
   */
  it("runs twice over the same commit and produces an identical document", () => {
    const first = documents.get("all")!;
    const second = run(fixture, "all");
    for (const key of new Set([...Object.keys(first), ...Object.keys(second)])) {
      if (key === "generatedAt") continue;
      expect(
        JSON.stringify(second[key], null, 2),
        `\`${key}\` differs between two runs on the ${name} fixture`,
      ).toBe(JSON.stringify(first[key], null, 2));
    }
  });

  /**
   * `all` is documented as "one envelope, every payload", with `degraded[]` the
   * union across extractors and `coverage` the worst tier any of them reached.
   * Until now only its SCHEMA was checked, so a summary that quietly lost a
   * degraded entry — the one thing that keeps "clean" and "blind" apart — would
   * have passed.
   */
  it("`all` carries the worst coverage and the exact union of degraded[]", () => {
    const all = documents.get("all")!;

    const rank = { full: 0, degraded: 1, none: 2 } as const;
    const worst = SINGLE_EXTRACTORS.map((e) => documents.get(e)!.coverage as keyof typeof rank).reduce(
      (a, b) => (rank[a] >= rank[b] ? a : b),
      "full" as keyof typeof rank,
    );
    expect(all.coverage, "`all` must report the worst tier any extractor reached").toBe(worst);

    const key = (entry: unknown): string => JSON.stringify(entry);
    const union = new Set(
      SINGLE_EXTRACTORS.flatMap((e) => documents.get(e)!.degraded as unknown[]).map(key),
    );
    const fromAll = new Set((all.degraded as unknown[]).map(key));
    // Set equality: an extractor that needs the project pushes the SAME project
    // reason on every single run, and `all` loads the project once, so the
    // multiset differs while the set must not.
    expect([...fromAll].sort(), "`all` lost or invented a degraded entry").toEqual([...union].sort());
  });

  it("leaks no absolute host path in any document", () => {
    for (const extractor of ALL_EXTRACTORS) {
      const violations = checkAll(fixture.dir, documents.get(extractor)!).filter(
        (v) => v.check === "no-absolute-paths",
      );
      expect(violations, `${extractor} on the ${name} fixture:\n${format(violations)}`).toEqual([]);
    }
  });
});

/**
 * The load-bearing one. WP1 is explicit that the agent's checkout must not be
 * mutated: the review workspace is reused across runs (`PER_TARGET_REUSE_WORKFLOWS`)
 * and the agent reads it CONCURRENTLY, so a stray `git checkout` presents as
 * the reviewer quoting the wrong version of a file — a failure that would be
 * blamed on the model. `contracts` is the only extractor that touches git state
 * at all, and until now nothing compared the tree before and after.
 */
describe("contracts leaves the repository byte-identical", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeContractFixture();
  });
  afterAll(() => fixture?.cleanup());

  const snapshot = (dir: string): Record<string, string> => {
    const git = (args: string[]): string => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
    const worktreeDir = join(dir, ".git", "worktrees");
    return {
      status: git(["status", "--porcelain"]),
      worktrees: git(["worktree", "list", "--porcelain"]),
      head: git(["rev-parse", "HEAD"]),
      refs: git(["for-each-ref", "--format=%(refname) %(objectname)"]),
      worktreeDir: existsSync(worktreeDir) ? readdirSync(worktreeDir).sort().join(",") : "(absent)",
    };
  };

  it("does not mutate the working tree, the worktree list or .git/worktrees", () => {
    const before = snapshot(fixture.dir);
    const result = runExtractor({
      extractor: "contracts",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    });
    // The run must have actually done the worktree dance, or this proves nothing.
    expect((result.document as { contracts: unknown[] }).contracts.length).toBeGreaterThan(0);
    expect(snapshot(fixture.dir)).toEqual(before);
  });
});

/**
 * THE BUG THIS ORACLE FOUND, made into a fixture.
 *
 * Run against this monorepo's own Drizzle commit (`df645b6f`, 207 contract
 * deltas), `no-absolute-paths` fired twice: `stripImportPaths` matched
 * `import("…").Member` — the QUALIFIED form — and nothing else, so a module
 * namespace type (`typeof import("./schema/sqlite.js")`, which is what a
 * `typeof import(...)` parameter is) carried its specifier straight into the
 * emitted signature.
 *
 * Both halves of the dotted case's rationale apply to it unchanged: the text is
 * unreadable in an obligation, and an ABSOLUTE specifier — what a type outside
 * the tsconfig root prints as — differs between the head tree and the temp base
 * worktree, so the symbol reads as `changed` on every run for no reason.
 */
describe("a module-namespace type does not leak its specifier", () => {
  let fixture: Fixture;
  let document: Document;

  beforeAll(() => {
    fixture = makeFixture(
      "module-type",
      {
        message: "base",
        files: {
          "tsconfig.json": TSCONFIG,
          "package.json": JSON.stringify({ name: "fixture-module-type", version: "1.0.0" }),
          "src/schema.ts": `export const users = { id: "text" };\n`,
          "src/query.ts": `export function withSchema(schema: typeof import("./schema.js")): string {\n  return Object.keys(schema.users).join(",");\n}\n`,
        },
      },
      {
        message: "head",
        files: {
          "src/query.ts": `export function withSchema(schema: typeof import("./schema.js"), sep = ","): string {\n  return Object.keys(schema.users).join(sep);\n}\n`,
        },
      },
    );
    document = run(fixture, "contracts");
  });
  afterAll(() => fixture?.cleanup());

  it("emits the delta with the module collapsed to its name", () => {
    const delta = (document.contracts as { symbol: string; after: { parameters: { type: string }[] } }[]).find(
      (c) => c.symbol === "withSchema",
    );
    expect(delta, "the added parameter must still be reported as a delta").toBeDefined();
    expect(delta!.after.parameters[0].type).toBe("typeof schema");
  });

  it("produces zero self-consistency violations", () => {
    const violations = checkAll(fixture.dir, document);
    expect(violations, format(violations)).toEqual([]);
  });
});

/**
 * The oracle is only worth having if it FIRES. Each of these documents is a lie
 * of exactly the shape the real bugs took.
 */
describe("the self-check itself", () => {
  let fixture: Fixture;
  let document: Document;
  beforeAll(() => {
    fixture = makeContractFixture();
    document = run(fixture, "contracts");
  });
  afterAll(() => fixture?.cleanup());

  it("catches a phantom removal — the 65-deltas bug", () => {
    const lying = {
      ...document,
      contracts: [
        {
          symbol: "getUser",
          file: "src/user.ts",
          change: "removed",
          before: null,
          after: null,
          consumersOutsideDiff: [],
        },
      ],
    };
    const violations = checkAll(fixture.dir, lying);
    expect(violations.map((v) => v.check)).toContain("contracts-removed-absent-at-head");
  });

  it("catches a phantom addition", () => {
    const lying = {
      ...document,
      contracts: [
        {
          symbol: "getUser",
          file: "src/user.ts",
          change: "added",
          before: null,
          after: null,
          consumersOutsideDiff: [],
        },
      ],
    };
    expect(checkAll(fixture.dir, lying).map((v) => v.check)).toContain(
      "contracts-added-absent-at-base",
    );
  });

  /**
   * The one thing a presence-based version of this check accused on real
   * history, and it was WRONG to: `const FOO` becoming `export const FOO` is a
   * genuine addition to the export surface `contracts` describes, with the name
   * present on both sides. (`MAX_SECTION_CHARS`, `connectors/slack/mrkdwn.ts`.)
   */
  it("does not accuse a name that is present at base but was not exported there", () => {
    const lying = {
      ...document,
      contracts: [
        {
          // `id` is a parameter and a property at base — present, never exported.
          symbol: "id",
          file: "src/user.ts",
          change: "added",
          before: null,
          after: null,
          consumersOutsideDiff: [],
        },
      ],
    };
    expect(checkAll(fixture.dir, lying).map((v) => v.check)).not.toContain(
      "contracts-added-absent-at-base",
    );
  });

  it("catches a leaked host path and an unreadable location", () => {
    const lying = {
      ...document,
      contracts: [
        {
          symbol: "getUser",
          file: "src/user.ts",
          change: "changed",
          before: null,
          after: null,
          consumersOutsideDiff: ['import("/private/var/folders/x/src/user").User', "/etc/passwd:3"],
        },
      ],
    };
    const checks = checkAll(fixture.dir, lying).map((v) => v.check);
    expect(checks).toContain("no-absolute-paths");
    expect(checks).toContain("location-shape");
  });

  it("catches a `full` envelope that also carries a degraded entry", () => {
    const lying = { ...document, coverage: "full", degraded: [{ extractor: "x", reason: "y" }] };
    expect(checkAll(fixture.dir, lying).map((v) => v.check)).toContain("envelope-contract");
  });

  it("catches impossible reference arithmetic", () => {
    const lying = {
      ...document,
      extractor: "facts",
      files: [],
      symbols: [{ name: "getUser", references: [], referenceCount: 1, referencesInDiff: 4 }],
    };
    expect(checkAll(fixture.dir, lying).map((v) => v.check)).toContain("reference-arithmetic");
  });

  it("catches a hard-coded duplicate that is not on the line it names", () => {
    const lying = {
      ...document,
      extractor: "constants",
      sideDefinitions: {},
      constants: [
        {
          constant: "MAX_TOKEN_AGE",
          declaredAt: "src/user.ts:1",
          value: "31337",
          valueKind: "number",
          references: [],
          hardCodedDuplicates: ["src/user.ts:2"],
          sides: {},
        },
      ],
    };
    expect(checkAll(fixture.dir, lying).map((v) => v.check)).toContain("constants-duplicates-real");
  });

  it("returns a violation instead of throwing on a malformed document", () => {
    // An envelope-less object claims nothing, so the only thing wrong with it
    // is the missing envelope — and that is reported, not thrown.
    expect(checkAll(fixture.dir, {}).map((v) => v.check)).toEqual(["envelope-contract"]);
    for (const junk of [
      { extractor: "contracts", contracts: "not-an-array" },
      { extractor: "contracts", contracts: [null, 7, { change: "removed" }] },
      { extractor: "facts", coverage: 7, degraded: "no", symbols: [{ name: 1 }] },
      { extractors: { facts: "not-an-object" } },
    ]) {
      expect(() => checkAll(fixture.dir, junk as Document)).not.toThrow();
    }
  });

  it("returns a violation instead of throwing when the repo is not a git repo", () => {
    expect(() => checkAll("/nonexistent-repo-path", document)).not.toThrow();
  });
});

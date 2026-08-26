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
import {
  makeBrokenTsConfigFixture,
  makeBuildArtifactFixture,
  makeConstantFixture,
  makeIgnoredScopeFixture,
  makeLiteralKindsFixture,
  makeManyFilesFixture,
  makeNonGitDirectory,
  type Fixture,
} from "./helpers.js";
import { runExtractor } from "../src/run.js";
import {
  extractConstants,
  findLiteralOccurrences,
  literalOf,
  parseSides,
  DEFAULT_SIDES,
} from "../src/constants.js";
import { listFiles } from "../src/git.js";
import { astGrepLangFor, isIgnoredPath, isScannablePath, looksMinified } from "../src/project.js";
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
    expect(fact?.sides?.client).toBeGreaterThan(0);
    expect(fact?.sides?.server).toBe(0);
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
    expect(fact?.sides?.ui).toBeGreaterThan(0);
    expect(fact?.sides?.api).toBe(0);
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

/**
 * The other two literal kinds, END TO END.
 *
 * `literalOf` has a unit test for all three, and only the NUMBER case had ever
 * been through `runExtractor` — so the whole path from a string declaration to
 * an ast-grep `string` node and back into `hardCodedDuplicates` was untested,
 * as was the `.tsx` / `.jsx` / `.js` half of `astGrepLangFor`. A string constant
 * is the ordinary case (a route, a header name, a feature flag), not the exotic
 * one.
 */
describe("constants — string and boolean, and the language dispatch", () => {
  let fixture: Fixture;
  let document: ConstantsDocument;

  beforeAll(() => {
    fixture = makeLiteralKindsFixture();
    document = constants(fixture);
  });
  afterAll(() => fixture.cleanup());

  it("reports a changed STRING constant with its new value and kind", () => {
    const fact = document.constants.find((c) => c.constant === "FEATURE_NAME");
    expect(fact?.value).toBe("beta");
    expect(fact?.valueKind).toBe("string");
    expect(fact?.declaredAt).toBe("src/flags.ts:1");
  });

  it("reports a changed BOOLEAN constant, and does not confuse `false` with absence", () => {
    const fact = document.constants.find((c) => c.constant === "ENABLED");
    expect(fact?.value).toBe("false");
    expect(fact?.valueKind).toBe("boolean");
    // Nothing else in the tree hard-codes `false`, so this is a MEASURED empty
    // list — the tier-1 `[]` that `null` on tier 2 must never be mistaken for.
    expect(fact?.hardCodedDuplicates).toEqual([]);
    expect(fact?.references).toEqual([]);
    expect(fact?.sides).not.toBeNull();
  });

  /**
   * The three copies live in a `.tsx`, a `.jsx` and a `.js` file, are identical
   * in both commits and are therefore OUTSIDE the diff entirely — the only way
   * to reach them is the repo-wide literal scan, which has to pick an ast-grep
   * language per extension to parse them at all.
   */
  it("finds the same literal in a .tsx, a .jsx and a .js file", () => {
    const fact = document.constants.find((c) => c.constant === "FEATURE_NAME");
    expect(fact?.hardCodedDuplicates).toEqual([
      "src/legacy/label.ts:2",
      "src/widgets/legacy.jsx:1",
      "src/widgets/panel.tsx:1",
      "src/widgets/plain.js:1",
    ]);
  });

  it("maps every analysable extension onto an ast-grep language", () => {
    // The table the scan dispatches on. A `null` here is a file silently
    // contributing nothing to set B, in the extractor that makes absence claims.
    for (const path of ["a.ts", "a.mts", "a.cts", "a.tsx", "a.jsx", "a.js", "a.mjs", "a.cjs", "a.es6"]) {
      expect(astGrepLangFor(path), path).not.toBeNull();
    }
    expect(astGrepLangFor("a.py")).toBeNull();
    expect(astGrepLangFor("a.json")).toBeNull();
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

/**
 * WS6 stage 0 — the three measured bugs in `constants`, each pinned by the
 * number it would produce WITHOUT the fix (`CLAUDE.md`: "a bound is only a
 * guard if you also pin the number it would be without the fix").
 */
describe("constants — silent truncation (bug a)", () => {
  /**
   * `walk()` stopped at `limit` and returned with NO `degraded[]` entry, so
   * `findLiteralOccurrences` computed set B over an arbitrary traversal-order
   * PREFIX of the repository while the document looked complete. MEASURED
   * reachable on 20 of the 50 corpus cases — sentry has 7,255 analysable files
   * at head, grafana 7,000, against a 6000 default.
   *
   * This is the severe one because `constants` makes ABSENCE claims:
   * "referenced only client-side, zero server references" is the single gold
   * finding this investigation ever converted, and an absence claim over a
   * truncated file set is not weak, it is unsound.
   */
  it("names the ceiling in degraded[] when the literal scan truncates", () => {
    const many = makeManyFilesFixture(40);
    try {
      const result = runExtractor({
        extractor: "constants",
        repo: many.dir,
        base: many.base,
        head: many.head,
        maxFiles: 5,
      });
      const document = result.document as unknown as ConstantsDocument;
      const truncation = document.degraded.find((d) => /literal scan stopped at the 5-file/.test(d.reason));
      expect(truncation, "a truncated set B must not be reported as a complete one").toBeDefined();
      expect(truncation?.extractor).toBe("constants");
      expect(truncation?.reason).toMatch(/PREFIX of the repository/);
      // The ceiling is only actionable if the entry says how far past it the
      // repository actually was. 40 filler files + `src/config.ts`.
      expect(truncation?.reason).toMatch(/41 file\(s\) were eligible and 5 were read/);
      expect(document.coverage).toBe("degraded");
      expect(result.exitCode).toBe(3);
    } finally {
      many.cleanup();
    }
  });

  /**
   * The pin without the fix: the SAME fixture under a ceiling it fits inside
   * produces no truncation entry at all. Without this half the test above would
   * pass on an extractor that degraded unconditionally.
   */
  it("says nothing about truncation when the whole repo fits under the ceiling", () => {
    const many = makeManyFilesFixture(40);
    try {
      const document = runExtractor({
        extractor: "constants",
        repo: many.dir,
        base: many.base,
        head: many.head,
        maxFiles: 500,
      }).document as unknown as ConstantsDocument;
      expect(document.degraded.filter((d) => /literal scan stopped/.test(d.reason))).toEqual([]);
      expect(document.coverage).toBe("full");
    } finally {
      many.cleanup();
    }
  });
});

describe("constants — unfiltered scope (bug b)", () => {
  /**
   * `isIgnoredPath`'s `dist` pattern was an EXACT segment match and nothing
   * excluded a bundle by shape, so `apps/evals/dist-site/assets/index-*.js` and
   * the vendored checkouts under `apps/server/data/sandboxes/**` were both in
   * scope. Measured on this monorepo: **2,663 bogus "hard-coded duplicates" for
   * one constant**. Here the same three shapes are present and must contribute
   * nothing.
   */
  it("reports no hard-coded duplicate from a bundle, a build dir or a vendored checkout", () => {
    const fixture = makeBuildArtifactFixture();
    try {
      const document = runExtractor({
        extractor: "constants",
        repo: fixture.dir,
        base: fixture.base,
        head: fixture.head,
      }).document as unknown as ConstantsDocument;
      const fact = document.constants.find((c) => c.constant === "MAX_TOKEN_AGE");
      expect(fact, "the constant itself must still be found").toBeDefined();
      // Every one of these carries the literal 900 and none is a site a reviewer
      // could act on. Before the fix this list had three entries.
      expect(fact?.hardCodedDuplicates).toEqual([]);
    } finally {
      fixture.cleanup();
    }
  });

  it("widens the ignore set without swallowing ordinary source directories", () => {
    for (const ignored of [
      "apps/evals/dist-site/assets/index-a1b2.js",
      "build.out/gen/x.js",
      "apps/server/data/vendor/pkg/a.js",
      ".venv/lib/python3.12/site-packages/x.py",
      "venv/bin/a.js",
      "src/__pycache__/a.pyc",
      "target/classes/A.class",
      "vendor/bundle/gems/a.rb",
      ".bundle/config",
      ".gradle/caches/x",
      "tmp/cache/a.js",
      "node_modules/x/index.js",
      "dist/index.js",
    ]) {
      expect(isIgnoredPath(ignored), ignored).toBe(true);
    }
    // A prefix match on `dist`/`build` would swallow these, and this list must
    // never be the reason real source went unread.
    for (const kept of [
      "src/distributed/queue.ts",
      "packages/builders/index.ts",
      "src/outbound/a.ts",
      "src/targeting/a.ts",
      "src/tmpfile.ts",
    ]) {
      expect(isIgnoredPath(kept), kept).toBe(false);
    }
  });

  it("recognises a minified bundle by shape, wherever it sits", () => {
    expect(looksMinified(`${"const a=1;".repeat(400)}\n`)).toBe(true);
    expect(looksMinified("export const a = 1;\nexport const b = 2;\n")).toBe(false);
  });
});

/**
 * WS6 stage 1 — the file set comes from GIT, and `.gitignore` is honoured by
 * construction.
 *
 * Stage 0 widened a hand-maintained directory denylist and left the general fix
 * explicitly unbuilt. It could not have worked: a denylist is flat and global,
 * and the two worst offenders on this monorepo were a NESTED `.gitignore`
 * (`apps/evals/dist-site/`) and a directory whose name nobody would ever guess
 * (`apps/server/data/sandboxes/**` — cloned review workspaces).
 *
 * Measured on this repository at `HEAD~1..HEAD`, one `constants` run over ten
 * changed constants:
 *
 *   readdir walk    44,633 hard-coded duplicates (41,079 from data/sandboxes),
 *                   the 6000-file ceiling HIT, 2.24 GB peak RSS, 12.6 s
 *   git ls-tree      4,201 hard-coded duplicates, ceiling not reached,
 *                   0.82 GB peak RSS, 3.3 s
 */
describe("constants — the file set comes from git (bug d)", () => {
  let fixture: ReturnType<typeof makeIgnoredScopeFixture>;
  beforeAll(() => {
    fixture = makeIgnoredScopeFixture();
  });
  afterAll(() => fixture.cleanup());

  it("reports the ONE real duplicate and nothing that `.gitignore` covers", () => {
    const document = runExtractor({
      extractor: "constants",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    }).document as unknown as ConstantsDocument;
    const fact = document.constants.find((c) => c.constant === "MAX_TOKEN_AGE");
    expect(fact, "the constant itself must still be found").toBeDefined();
    expect(fact?.hardCodedDuplicates).toEqual([fixture.realDuplicate]);
  });

  /**
   * The pin WITHOUT the fix, on the same fixture: force the scan down the walk
   * tier and every one of the four invisible files comes back. Without this half
   * the test above would pass on an extractor that had simply stopped finding
   * duplicates at all.
   */
  it("pins what the directory walk WOULD have seen — four files, none of them source", () => {
    const values = new Map<string, "number">([["900", "number"]]);
    const walked = findLiteralOccurrences(fixture.dir, values, { ref: "no-such-ref" });
    expect(walked.source, "an unresolvable ref must fall back, not throw").toBe("walk");
    const walkedPaths = new Set((walked.occurrences.get("900") ?? []).map((hit) => hit.path));
    for (const path of fixture.invisible) {
      expect(walkedPaths.has(path), `the walk should have seen ${path}`).toBe(true);
    }

    const fromTree = findLiteralOccurrences(fixture.dir, values, { ref: fixture.head });
    expect(fromTree.source).toBe("tree");
    const treePaths = new Set((fromTree.occurrences.get("900") ?? []).map((hit) => hit.path));
    for (const path of fixture.invisible) {
      expect(treePaths.has(path), `${path} is not in the head tree`).toBe(false);
    }
    expect(treePaths.has("src/legacy/auth.ts")).toBe(true);
  });

  /**
   * `apps/web/snapshots/` is excluded by `apps/web/.gitignore`, two directories
   * below the root. No flat denylist can express that, and this is the half of
   * the argument that is about capability rather than about tidiness.
   */
  it("honours a NESTED .gitignore, which a denylist structurally cannot", () => {
    expect(isScannablePath("apps/web/snapshots/snap.js"), "not a denylist entry").toBe(true);
    const listed = listFiles({
      dir: fixture.dir,
      ref: fixture.head,
      accept: isScannablePath,
    });
    expect(listed.source).toBe("tree");
    const paths = listed.files.map((f) => f.path);
    expect(paths).not.toContain("apps/web/snapshots/snap.js");
    expect(paths).toContain("apps/web/app.ts");
  });

  /**
   * Set B is resolved at `headSha` — the sha the envelope stamps — not against
   * the working directory. `src/scratch.ts` is untracked and NOT ignored, so it
   * is on disk and in no tree: the shape of an agent's scratch file in a review
   * workspace that is reused across runs.
   */
  it("resolves set B at the head COMMIT, not at the working directory", () => {
    const values = new Map<string, "number">([["900", "number"]]);
    const scan = findLiteralOccurrences(fixture.dir, values, { ref: fixture.head });
    const paths = (scan.occurrences.get("900") ?? []).map((hit) => hit.path);
    expect(paths).not.toContain("src/scratch.ts");
    // …and the same file IS on disk, so this is a statement about which tree was
    // read rather than about the file's existence.
    const worktree = findLiteralOccurrences(fixture.dir, values, { ref: null });
    expect((worktree.occurrences.get("900") ?? []).map((h) => h.path)).toContain("src/scratch.ts");
  });
});

describe("constants — the walk fallback is NAMED", () => {
  /**
   * The package must not hard-require a git repository where it did not before.
   * `extractConstants` is callable on any directory; when git cannot enumerate
   * one, the walk still runs — and the document says so, because walk-tier
   * output honours no `.gitignore` and describes the checkout rather than a
   * commit.
   */
  it("degrades with a written reason on a directory that is not a git repo", () => {
    const plain = makeNonGitDirectory();
    try {
      const result = extractConstants({
        repo: plain.dir,
        project: null,
        hunkIndex: new Map([
          ["src/config.ts", { path: "src/config.ts", changedLines: new Set([1]), hunks: ["src/config.ts:1-1"] }],
        ]),
      });
      const fact = result.payload.constants.find((c) => c.constant === "MAX_TOKEN_AGE");
      expect(fact, "the walk tier still finds the declaration").toBeDefined();
      expect(fact?.hardCodedDuplicates).toEqual(["src/legacy/auth.ts:2"]);

      const fallback = result.degraded.find((d) => /DIRECTORY WALK/.test(d.reason));
      expect(fallback, "walk-tier output must not read as tree-tier output").toBeDefined();
      expect(fallback?.extractor).toBe("constants");
      expect(fallback?.reason).toMatch(/cannot honour \.gitignore/);
      expect(fallback?.reason).toMatch(/walk-tier evidence/);
    } finally {
      plain.cleanup();
    }
  });

  it("names the fallback in the listing itself, so every consumer can see it", () => {
    const plain = makeNonGitDirectory();
    try {
      const listed = listFiles({ dir: plain.dir, ref: "HEAD", accept: isScannablePath });
      expect(listed.source).toBe("walk");
      expect(listed.reason).toMatch(/not a repository/);
      expect(listed.files.map((f) => f.path).sort()).toEqual([
        "src/config.ts",
        "src/legacy/auth.ts",
      ]);
    } finally {
      plain.cleanup();
    }
  });
});

describe("constants — M6, nullability (bug c)", () => {
  /**
   * `declaration.references ?? []` collapsed `null` — "tier 2, there IS no set
   * A" — into `[]` — "the compiler looked and found none". That is the founding
   * distinction of this package, in the one field that carries it, and under
   * later work tier 2 becomes ~80% of the corpus.
   */
  it("reports references as NULL on tier 2, never as an empty array", () => {
    const broken = makeBrokenTsConfigFixture();
    try {
      const document = runExtractor({
        extractor: "constants",
        repo: broken.dir,
        base: broken.base,
        head: broken.head,
      }).document as unknown as ConstantsDocument;
      const fact = document.constants.find((c) => c.constant === "LIMIT");
      expect(fact).toBeDefined();
      expect(fact?.references, "null means NOBODY LOOKED; [] would mean looked and found none").toBeNull();
    } finally {
      broken.cleanup();
    }
  });

  it("still reports an ARRAY on tier 1, including a genuinely empty one", () => {
    const fixture = makeConstantFixture();
    try {
      const fact = constants(fixture).constants.find((c) => c.constant === "MAX_TOKEN_AGE");
      expect(Array.isArray(fact?.references)).toBe(true);
      expect(fact?.references?.length).toBeGreaterThan(0);
    } finally {
      fixture.cleanup();
    }
  });

  /**
   * `sides` had the identical flaw and was left alone by stage 0: it is a
   * partition OF `references`, and on tier 2 it emitted an all-zeros record
   * derived from a reference set that does not exist. `{server: 0}` from no data
   * is indistinguishable from `{server: 0}` measured — and "zero server-side
   * references" is the exact shape of the one gold finding this investigation
   * ever converted, so a false one is expensive.
   */
  it("reports sides as NULL on tier 2 — an all-zeros partition of no data is a false absence claim", () => {
    const broken = makeBrokenTsConfigFixture();
    try {
      const document = runExtractor({
        extractor: "constants",
        repo: broken.dir,
        base: broken.base,
        head: broken.head,
      }).document as unknown as ConstantsDocument;
      const fact = document.constants.find((c) => c.constant === "LIMIT");
      expect(fact?.references).toBeNull();
      expect(fact?.sides, "a partition of a set nobody computed").toBeNull();
      // The pin: before the fix this was `{client: 0, server: 0, shared: 0,
      // test: 0, other: 0}` — five measurements that were never made.
      expect(fact?.sides).not.toEqual({ client: 0, server: 0, shared: 0, test: 0, other: 0 });
      // …and the partition it WOULD have used still ships, so `null` is a
      // statement about the data rather than about the definitions.
      expect(document.sideDefinitions).toEqual(DEFAULT_SIDES);
    } finally {
      broken.cleanup();
    }
  });

  it("keeps sides a RECORD on tier 1, including a genuinely zero side", () => {
    const fixture = makeConstantFixture();
    try {
      const fact = constants(fixture).constants.find((c) => c.constant === "MAX_TOKEN_AGE");
      // `server: 0` here IS the finding: the compiler looked and found none.
      expect(fact?.sides).not.toBeNull();
      expect(fact?.sides?.server).toBe(0);
    } finally {
      fixture.cleanup();
    }
  });
});

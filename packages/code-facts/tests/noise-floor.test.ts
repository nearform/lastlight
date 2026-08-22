/**
 * THE NOISE FLOOR — and the proof that each fix holding it down is load-bearing.
 *
 * WP1 ran `contracts` against a real commit of this monorepo and got **227
 * contract deltas of which ONE was real**. Three fixes cut it to 19. Every unit
 * test in this package passed before, during and after all three — because no
 * fixture here was large enough to exhibit any of the causes.
 *
 * That is the failure this file exists to prevent, and the principle is:
 *
 *   **A bound is only a guard if you also pin the number it would be WITHOUT
 *   the fix.** `expect(contracts.length).toBeLessThanOrEqual(3)` passes
 *   trivially on a two-file fixture. So each `it` below that asserts a ceiling
 *   is paired with one that DISABLES the fix and asserts a floor.
 *
 * The floors are `toBeGreaterThan`, never exact values. An exact "without the
 * fix it is 16" is a snapshot: it breaks when the fixture grows and teaches
 * nobody anything when it does.
 *
 * Building it found a FOURTH cause the three fixes did not cover — see
 * "cause 3" below. That is what a fixture that can actually exhibit the bug is
 * for.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { makeMonorepoFixture, UNSTABLE_TYPE_FILES, type Fixture } from "./helpers.js";
import { runExtractor } from "../src/run.js";
import { canonicalType, extractContracts, shapeOf } from "../src/contracts.js";
import { changedPaths, withWorktree, type ChangedPath } from "../src/git.js";
import { loadProject, repoRelative } from "../src/project.js";
import type { ContractsDocument } from "../src/schema.js";

let fixture: Fixture;
let document: ContractsDocument;

beforeAll(() => {
  fixture = makeMonorepoFixture();
  document = runExtractor({
    extractor: "contracts",
    repo: fixture.dir,
    base: fixture.base,
    head: fixture.head,
  }).document as unknown as ContractsDocument;
});

afterAll(() => fixture?.cleanup());

describe("the phantom-delta noise floor", () => {
  it("names the ONE real delta", () => {
    const real = document.contracts.filter((c) => c.symbol === "resolveSession");
    expect(real).toHaveLength(1);
    expect(real[0].change).toBe("changed");
    expect(real[0].file).toBe("packages/a/src/session.ts");
    // The added parameter, and nothing else about the signature.
    expect(real[0].before?.parameters.map((p) => p.name)).toEqual(["id"]);
    expect(real[0].after?.parameters.map((p) => p.name)).toEqual(["id", "refresh"]);
    expect(real[0].after?.parameters[1].optional).toBe(true);
    // The half that makes it an obligation: two call sites the PR did not touch.
    expect(real[0].consumersOutsideDiff).toEqual([
      "packages/a/src/consumers/alpha.ts:3",
      "packages/a/src/consumers/beta.ts:4",
    ]);
  });

  /**
   * 35 changed files, 40-odd exports moving across two packages, an external
   * dependency and six files of deliberately-reordered type text — and exactly
   * one thing actually changed. 3 is headroom, not a target.
   */
  it("reports at most 3 deltas in total", () => {
    expect(
      document.contracts.length,
      `deltas: ${document.contracts.map((c) => `${c.change} ${c.file}#${c.symbol}`).join(", ")}`,
    ).toBeLessThanOrEqual(3);
  });

  it("reports ZERO removed exports, because nothing was removed", () => {
    // Not a taste judgement. `git diff --name-status` contains no `D` and no
    // `R`, so a `removed` delta here CANNOT be true, and a false one is the
    // shape IRIS measured at −3 — actively worse than seeding nothing.
    const statuses = new Set(
      changedPaths(fixture.dir, fixture.base, fixture.head).map((c) => c.status),
    );
    expect(statuses.has("deleted")).toBe(false);
    expect(statuses.has("renamed")).toBe(false);
    expect(document.contracts.filter((c) => c.change === "removed")).toEqual([]);
  });

  /**
   * This test used to assert the OPPOSITE — that fourteen `packages/b` files
   * were skipped and named — and it was right to, because with one program per
   * diff they were: the head commit adds `packages/b/tsconfig.json`, the loader
   * picked `packages/a`'s, and every `packages/b` file fell out of the head
   * program while the base glob still had it.
   *
   * One program per tsconfig closes that. `packages/b` is now compiled from its
   * own tsconfig, so the comparison HAPPENS instead of being suppressed, and
   * there is nothing left for the guard to report. The guard is still
   * load-bearing — the `cause 1` test below forces the asymmetry and measures
   * it — but on this fixture it no longer has anything to catch, which is the
   * point of the change.
   */
  it("compares BOTH packages, so nothing is left one-sided", () => {
    const oneSided = document.degraded.find((d) => /in only one of the two programs/.test(d.reason));
    expect(
      oneSided,
      `packages/b must be compiled from its own tsconfig, not suppressed: ${oneSided?.reason}`,
    ).toBeUndefined();
    expect(document.coverage).toBe("full");
  });

  it("analyses every changed file in both packages", () => {
    const loaded = loadProject({
      repo: fixture.dir,
      changedPaths: changedPaths(fixture.dir, fixture.base, fixture.head).map((c) => c.path),
    });
    expect(loaded.groups.length).toBe(2);
    // 34 source files across two packages — every one of them in a program.
    expect(loaded.analysedCount).toBe(
      changedPaths(fixture.dir, fixture.base, fixture.head).filter((c) => c.path.endsWith(".ts"))
        .length,
    );
    expect(loaded.degraded).toEqual([]);
  });
});

describe("the fixture is SENSITIVE — each fix is load-bearing", () => {
  let changed: ChangedPath[];
  /** Deltas the one-sided guard suppressed, and the ones it let through. */
  let guarded: number;
  let guardedReason: string;
  let unguardedRemovals: number;
  let oneSidedFiles: number;
  /** Exports whose printed signature differs between the two programs. */
  let rawTextDiffers: number;
  let canonicalAgrees: number;

  beforeAll(() => {
    changed = changedPaths(fixture.dir, fixture.base, fixture.head);
    const paths = changed.map((c) => c.path);
    /**
     * FORCED to one tsconfig, which is what makes this a measurement.
     *
     * The default loader now opens one program per tsconfig, so on this fixture
     * both packages are in the head program and the asymmetry the guard exists
     * for is gone. `--tsconfig` reproduces it exactly — one program for the
     * whole diff, which is what the loader did before and what a caller that
     * passes the flag still gets — so the guard's contribution stays a number
     * rather than a comment. The real-world shape is unchanged: a modified file
     * in exactly one of the two programs.
     */
    const head = loadProject({
      repo: fixture.dir,
      changedPaths: paths,
      tsConfigPath: join(fixture.dir, "packages/a/tsconfig.json"),
    });
    expect(head.project, "the head project must load, or none of this measures anything").toBeTruthy();

    withWorktree(fixture.dir, fixture.base, (baseDir) => {
      const base = loadProject({ repo: baseDir, changedPaths: paths });
      expect(base.project).toBeTruthy();

      const common = {
        repo: fixture.dir,
        headProject: head.projects,
        baseProject: base.projects,
        baseDir,
        hunkIndex: new Map(),
      };

      const withGuard = extractContracts({ ...common, changed });
      guarded = withGuard.payload.contracts.length;
      guardedReason = withGuard.degraded[0]?.reason ?? "";
      oneSidedFiles = Number(/^(\d+) changed file/.exec(guardedReason)?.[1]);

      /**
       * The guard covers `modified` and `renamed` — the two statuses for which
       * a file MUST be in both programs. Relabelling every change as `added`
       * runs the identical comparison down the branch the guard does not cover,
       * which is precisely the code path that emitted 65 phantom removals on
       * the real commit. Same projects, same files: the only variable removed
       * is the guard.
       */
      const withoutGuard = extractContracts({
        ...common,
        changed: changed.map((c) => ({ ...c, status: "added" as const })),
      });
      unguardedRemovals = withoutGuard.payload.contracts.filter(
        (c) => c.change === "removed",
      ).length;

      // Cause 3, measured on the same two programs.
      let differs = 0;
      let agrees = 0;
      for (const path of UNSTABLE_TYPE_FILES) {
        const headFile = head.project?.getSourceFile(
          (f) => repoRelative(fixture.dir, f.getFilePath()) === path,
        );
        const baseFile = base.project?.getSourceFile(
          (f) => repoRelative(baseDir, f.getFilePath()) === path,
        );
        expect(headFile && baseFile, `${path} must be in BOTH programs`).toBeTruthy();
        const byName = new Map(
          [...baseFile!.getExportedDeclarations()].map(([name, decls]) => [name, decls[0]]),
        );
        for (const [name, decls] of headFile!.getExportedDeclarations()) {
          const before = shapeOf(byName.get(name)!).signature;
          const after = shapeOf(decls[0]).signature;
          if (before !== after) differs++;
          if (canonicalType(before) === canonicalType(after)) agrees++;
        }
      }
      rawTextDiffers = differs;
      canonicalAgrees = agrees;
    });
  });

  /**
   * `mirrorNodeModules` symlinks the head tree's `node_modules` into the base
   * worktree, so both sides resolve `@fixture/ext`. Without it the base side
   * INFERS `any` everywhere the external type reaches, and every one of those
   * exports reads as changed.
   *
   * Note what the fixture had to do to exhibit this, because it is a trap: an
   * ANNOTATED `function f(x: Ext): Ext` prints as `(x: Ext) => Ext` on BOTH
   * sides even when the module does not resolve — the printer falls back to the
   * written name. Only INFERRED types move. A fixture full of annotations would
   * have "proved" the mirror buys nothing.
   */
  it("cause 2: WITHOUT the node_modules mirror the same commit yields >10 deltas", () => {
    const unmirrored = runExtractor({
      extractor: "contracts",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
      mirrorNodeModules: false,
    }).document as unknown as ContractsDocument;

    expect(unmirrored.contracts.length).toBeGreaterThan(10);
    expect(unmirrored.contracts.length).toBeGreaterThan(document.contracts.length);
    // …and they are phantoms, not findings: the same export, `any` on one side.
    const phantom = unmirrored.contracts.find((c) => c.symbol.startsWith("makeA"));
    expect(phantom?.before?.returns).toBe("any");
    expect(phantom?.after?.returns).toBe("Ext");
  });

  /**
   * Six files return object literals with unions nested inside members, written
   * in a different member/union order at head and semantically identical.
   *
   * This is also the guard on the FOURTH cause, which building this fixture
   * found: `splitTopLevel` counted the `>` of `=>` as a closing bracket, so the
   * depth went negative at the first arrow and every signature was split at a
   * union that was never top-level. `canonicalType` therefore did not
   * canonicalise a single FUNCTION — which is to say, nearly everything this
   * extractor compares. Measured on this fixture before the fix: 12 phantom
   * deltas, on a commit whose only real change is one added parameter.
   */
  it("cause 3: canonicalType collapses the fixture's unions; raw text does not", () => {
    expect(rawTextDiffers).toBeGreaterThan(10);
    expect(canonicalAgrees).toBe(rawTextDiffers);
    expect(document.contracts.some((c) => c.file.startsWith("packages/a/src/plan/"))).toBe(false);

    // The arrow-precedence half, stated directly: `(…) => A | B` is
    // `(…) => (A | B)`, so the arrow must be split off before the union is.
    expect(canonicalType('() => "n" | "s" | "e" | "w"')).toBe(
      canonicalType('() => "w" | "e" | "s" | "n"'),
    );
    expect(canonicalType('() => { via: A | B; then: "complete" | "fail" }')).toBe(
      canonicalType('() => { then: "fail" | "complete"; via: B | A }'),
    );
    // A single-member body needs its property name split off too.
    expect(canonicalType('() => { then: "complete" | "fail" }')).toBe(
      canonicalType('() => { then: "fail" | "complete" }'),
    );
    // And a real difference stays different.
    expect(canonicalType("(id: string) => Session")).not.toBe(
      canonicalType("(id: string, refresh?: boolean) => Session"),
    );
  });

  /**
   * With the head side forced to `packages/a/tsconfig.json` its program holds
   * packages/a alone, while BASE — where neither package tsconfig exists yet
   * and the root one is `references`-only — globs and holds both. Every
   * modified file in packages/b is therefore in exactly one of the two
   * programs, which is the 65-phantom-removals shape from the real commit.
   *
   * That asymmetry is no longer what the DEFAULT loader produces here (see
   * "compares BOTH packages" above), and it is still reachable in the field:
   * `--tsconfig`, a package whose tsconfig will not parse, a group dropped for
   * the file budget. The guard has to keep working for all three.
   */
  it("cause 1: the one-sided guard suppresses N phantom removals and NAMES them in degraded[]", () => {
    expect(unguardedRemovals).toBeGreaterThan(10);
    expect(guarded).toBeLessThanOrEqual(3);
    expect(unguardedRemovals).toBeGreaterThan(guarded);

    // Suppressed is not the same as hidden: the count is in the envelope and
    // the files are named.
    expect(oneSidedFiles).toBeGreaterThan(10);
    expect(guardedReason).toMatch(/would be phantom/);
    expect(guardedReason).toMatch(/head side not analysed/);
    expect(guardedReason).toMatch(/packages\/b\/src\//);
  });
});

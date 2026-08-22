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
import { canonicalType } from "../src/contracts.js";
import { changedPaths, type ChangedPath } from "../src/git.js";
import {
  collectBaseContracts,
  exportedDeclarations,
  extractContractsTsgo,
  shapeOfTsgo,
  tsgoViews,
} from "../src/tsgo-extractors.js";
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
    const changed = changedPaths(fixture.dir, fixture.base, fixture.head);
    const views = tsgoViews({ repo: fixture.dir, baseSha: fixture.base, changed });
    expect(views.targets.tsConfigPaths.length).toBe(2);
    const snapshot = views.open("head");
    try {
      // 34 source files across two packages — every one of them in a program.
      const wanted = changed.filter((c) => c.path.endsWith(".ts"));
      expect(wanted.filter((c) => snapshot.lookup(c.path) !== null).length).toBe(wanted.length);
      expect(snapshot.degraded).toEqual([]);
    } finally {
      snapshot.dispose();
    }
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
  /** Every export pair compared — the denominator `canonicalAgrees` must reach. */
  let comparedPairs: number;

  beforeAll(() => {
    changed = changedPaths(fixture.dir, fixture.base, fixture.head);
    const views = tsgoViews({ repo: fixture.dir, baseSha: fixture.base, changed });

    /**
     * THE HEAD VIEW, DELIBERATELY NARROWED — which is what makes this a
     * measurement rather than a comment.
     *
     * The default path opens ONE snapshot shape for both sides, so on this
     * fixture the asymmetry the guard exists for cannot arise at all: base and
     * head hold the same files by construction (`tsgoViews`, the symmetry
     * invariant). Forcing the head side to `packages/a/tsconfig.json` while the
     * base view discovers both packages reproduces the real-world shape exactly
     * — every modified file in `packages/b` present on the BASE side only,
     * which is the 65-phantom-removals shape from the real commit. It stays
     * reachable in the field through `--tsconfig`, through a tsconfig that will
     * not parse, and through a base blob git cannot serve.
     */
    const baseSnapshot = views.open("base");
    let base;
    try {
      base = collectBaseContracts(baseSnapshot, changed);
    } finally {
      baseSnapshot.dispose();
    }

    const narrowed = tsgoViews({
      repo: fixture.dir,
      baseSha: fixture.base,
      changed,
      tsConfigPath: join(fixture.dir, "packages/a/tsconfig.json"),
    });
    const head = narrowed.open("head");
    try {
      const common = { repo: fixture.dir, head, base, hunkIndex: new Map() };

      const withGuard = extractContractsTsgo({ ...common, changed });
      guarded = withGuard.payload.contracts.length;
      guardedReason = withGuard.degraded[0]?.reason ?? "";
      oneSidedFiles = Number(/^(\d+) changed file/.exec(guardedReason)?.[1]);

      /**
       * The guard covers `modified` and `renamed` — the two statuses for which
       * a file MUST be in both views. Relabelling every change as `added` runs
       * the identical comparison down the branch the guard does not cover,
       * which is precisely the code path that emitted 65 phantom removals on
       * the real commit. Same views, same files: the only variable removed is
       * the guard.
       */
      const withoutGuard = extractContractsTsgo({
        ...common,
        changed: changed.map((c) => ({ ...c, status: "added" as const })),
      });
      unguardedRemovals = withoutGuard.payload.contracts.filter(
        (c) => c.change === "removed",
      ).length;
    } finally {
      head.dispose();
    }

    // Cause 3, measured on the two views of the SAME tree.
    const baseForText = views.open("base");
    const headForText = views.open("head");
    try {
      let differs = 0;
      let agrees = 0;
      let pairs = 0;
      for (const path of UNSTABLE_TYPE_FILES) {
        const headFile = headForText.lookup(path);
        const baseFile = baseForText.lookup(path);
        expect(headFile && baseFile, `${path} must be in BOTH views`).toBeTruthy();
        const byName = new Map(
          exportedDeclarations(baseFile!.sourceFile, baseFile!.owner.project).map((d) => [
            d.name,
            d,
          ]),
        );
        for (const declaration of exportedDeclarations(
          headFile!.sourceFile,
          headFile!.owner.project,
        )) {
          const other = byName.get(declaration.name);
          if (!other) continue;
          pairs++;
          const before = shapeOfTsgo(other.node, baseFile!.owner.project).signature;
          const after = shapeOfTsgo(declaration.node, headFile!.owner.project).signature;
          if (before !== after) differs++;
          if (canonicalType(before) === canonicalType(after)) agrees++;
        }
      }
      rawTextDiffers = differs;
      canonicalAgrees = agrees;
      comparedPairs = pairs;
    } finally {
      headForText.dispose();
      baseForText.dispose();
    }
  });

  /**
   * ── CAUSE 2, RE-POINTED 2026-08-22 — AND WHAT IT USED TO MEASURE ───────────
   *
   * This case used to run the same commit with `mirrorNodeModules: false` and
   * assert the un-mirrored run was worse by a lower bound. Measured, it was 17
   * phantom deltas against the mirrored run's 1, with the phantom's `before`
   * literally `any`: `withWorktree` materialised the base tree in `$TMPDIR`,
   * that tree had no `node_modules`, `@fixture/ext` did not resolve there, and
   * every INFERRED external type collapsed to `any` on one side only. (Only
   * inferred types moved — an ANNOTATED `f(x: Ext): Ext` prints the written
   * name on both sides even unresolved, which is why the fixture had to infer.)
   *
   * **It stopped being measurable, and the mechanism it measured is gone.** The
   * base side is an OVERLAY over the head tree now, so there is exactly one
   * `node_modules` and the two sides cannot disagree about it — no second
   * worktree, nothing to mirror into, and `mirrorNodeModules: false` is not a
   * state a `contracts` run can be put in. Setting the ceiling beside a floor
   * that can no longer be reached would be a guard that cannot fail, which is
   * worse than no guard.
   *
   * So it is replaced by the sensitivity proof for the mechanism that took its
   * place: **without the overlay the base view IS the head view**, the one real
   * delta vanishes, and the run reports a clean PR that changed nothing. That
   * is the same failure class from the other direction — the earlier one
   * manufactured deltas, this one MASKS them — and it is the one a bug in
   * `buildBaseOverlay` or in `overlayFileSystem`'s two-spellings index would
   * actually produce.
   */
  it("cause 2: WITHOUT the base overlay the two views are identical and the real delta disappears", () => {
    const views = tsgoViews({ repo: fixture.dir, baseSha: fixture.base, changed });
    // `open("head")` twice: the same argument list, no overlay on either side —
    // which is precisely what an overlay that fails to serve its blobs degrades
    // to, silently.
    const pretendBase = views.open("head");
    let base;
    try {
      base = collectBaseContracts(pretendBase, changed);
    } finally {
      pretendBase.dispose();
    }
    const head = views.open("head");
    try {
      const blind = extractContractsTsgo({
        repo: fixture.dir,
        head,
        base,
        changed,
        hunkIndex: new Map(),
      });
      // The floor: the overlay is the ONLY thing making this a comparison.
      expect(blind.payload.contracts).toEqual([]);
      expect(document.contracts.length).toBeGreaterThan(0);
      expect(document.contracts.some((c) => c.symbol === "resolveSession")).toBe(true);
    } finally {
      head.dispose();
    }
  });

  /**
   * The other half, and the reason the case above is not just "an overlay does
   * something": with the overlay the external type resolves on BOTH sides, so
   * the 16 exports whose types are INFERRED from `@fixture/ext` are compared
   * resolved-against-resolved and contribute nothing.
   *
   * Under the previous engine this was the expensive half — an un-mirrored base
   * worktree printed `any` for every one of them — and it is now free, because
   * one tree has one `node_modules`.
   */
  it("cause 2: the external type resolves on BOTH sides, so no `any` reaches a delta", () => {
    for (const delta of document.contracts) {
      expect(delta.before?.returns, `${delta.symbol}`).not.toBe("any");
      expect(delta.after?.returns, `${delta.symbol}`).not.toBe("any");
    }
    expect(document.contracts.some((c) => c.symbol.startsWith("makeA"))).toBe(false);
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
    // WITHOUT `canonicalType` at least ten of these pairs read as changed;
    // WITH it, EVERY pair collapses. Stated as "agrees covers the whole
    // denominator" rather than as `agrees === differs`, because the two are only
    // equal while every single pair differs raw — which was true of the previous
    // printer and is not of this one (18 of 24 here). Tying the assertion to
    // that coincidence would make it a snapshot of a printer.
    expect(rawTextDiffers).toBeGreaterThan(10);
    expect(comparedPairs).toBeGreaterThan(rawTextDiffers);
    expect(canonicalAgrees).toBe(comparedPairs);
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

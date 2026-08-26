/**
 * EVERY TSCONFIG THE DIFF TOUCHES — the coverage gap, and the guard on the fix.
 *
 * The number that forced this file: over 50 real PRs (keycloak / grafana /
 * discourse / cal.com / sentry) the loader analysed **58 of 8,514 changed
 * files — 0.7%** — and reported **tier 1** while doing it. `grafana-90939`
 * analysed 1 file of 142; `cal-com-22532` analysed 0 of 17. Every one of those
 * runs carried the shortfall in `degraded[]`, so this was never a loudness bug:
 * the package was honest, and blind. One nearest tsconfig was picked for the
 * whole diff, and a monorepo diff (cal.com: 26 tsconfigs, 140 `package.json`s)
 * is not covered by any one of them.
 *
 * The principle from `tests/noise-floor.test.ts` applies unchanged: **a bound is
 * only a guard if you also pin the number it would be WITHOUT the fix.** So
 * every coverage assertion below is paired with the same measurement taken
 * against a FORCED single tsconfig — which is exactly what the old loader did —
 * and that pair is the whole point of the file.
 *
 * ── REWRITTEN 2026-08-22 (`docs/plans/fact-engine/02-migration.md`) ──────────
 *
 * Most of what used to be here measured the FILE BUDGET: `--max-files` shared
 * out between groups, `--max-projects`, `selectNeighbourhood`, a group narrowed
 * to fit its allowance and named as a lower bound. All of that managed the cost
 * of building N separate ts-morph `Project`s, each with its own copy of the
 * `node_modules` closure in the node heap — 2.4–3.0 GB peaks on the corpus.
 *
 * **There is no budget any more, so those cases are deleted rather than
 * adjusted.** One tsgo snapshot holds every tsconfig the diff touches; all eight
 * workspace tsconfigs together measure 10,078 program files, 320 ms and 98 MB,
 * because the closure lives in the Go child rather than in V8. A test that
 * asserted a group was narrowed would now be asserting a mechanism that does
 * not exist, which is worse than no test. `makeStarvedProjectsFixture`,
 * `STARVED_*` and `selectNeighbourhood` went with them.
 *
 * What survives is the part that was never about cost: does every changed file
 * end up in a program, in both packages and under no tsconfig at all — and does
 * a RELATIVE `--repo` name the same repository as an absolute one.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import { makeMultiProjectFixture, MULTI_PROJECT_CHANGED, type Fixture } from "./helpers.js";
import { runExtractor } from "../src/run.js";
import { discoverTsgoTargets, tsgoViews } from "../src/tsgo-extractors.js";
import { changedPaths } from "../src/git.js";
import type { AllDocument } from "../src/schema.js";

let fixture: Fixture;
let document: AllDocument;

beforeAll(() => {
  fixture = makeMultiProjectFixture();
  document = runExtractor({
    extractor: "all",
    repo: fixture.dir,
    base: fixture.base,
    head: fixture.head,
    env: { PATH: "" },
  }).document as unknown as AllDocument;
});

afterAll(() => fixture?.cleanup());

/** How many of `MULTI_PROJECT_CHANGED` a run with these options actually held. */
function analysedCount(options: { tsConfigPath?: string; repo?: string } = {}): number {
  const repo = options.repo ?? fixture.dir;
  const changed = changedPaths(repo, fixture.base, fixture.head);
  const views = tsgoViews({
    repo,
    baseSha: fixture.base,
    changed,
    ...(options.tsConfigPath ? { tsConfigPath: options.tsConfigPath } : {}),
  });
  const snapshot = views.open("head");
  try {
    return MULTI_PROJECT_CHANGED.filter((path) => snapshot.lookup(path) !== null).length;
  } finally {
    snapshot.dispose();
  }
}

describe("a diff that spans two packages is analysed in both", () => {
  it("opens one program per tsconfig the diff touches", () => {
    const targets = discoverTsgoTargets({
      repo: fixture.dir,
      changed: changedPaths(fixture.dir, fixture.base, fixture.head),
    });
    expect(targets.tsConfigPaths.sort()).toEqual([
      join(fixture.dir, "packages/a/tsconfig.json"),
      join(fixture.dir, "packages/b/tsconfig.json"),
    ]);
    // `scripts/release.ts` is under no tsconfig at all and is still opened —
    // that is what `openFiles` is for, and it is the structural repair of the
    // glob fallback rather than a smaller version of it.
    expect(targets.orphans).toEqual(["scripts/release.ts"]);
    // The claim that matters: EVERY changed file ended up in some program.
    expect(analysedCount()).toBe(MULTI_PROJECT_CHANGED.length);
  });

  /**
   * WITHOUT the fix. `--tsconfig` forces exactly one program AND disables the
   * orphan fallback, which is what the single-project loader did on every diff
   * — so this is the old behaviour, measured on the same fixture rather than
   * described in a comment.
   */
  it("WITHOUT the fix — one forced tsconfig sees a third of the same diff", () => {
    const single = analysedCount({
      tsConfigPath: join(fixture.dir, "packages/a/tsconfig.json"),
    });
    expect(single).toBe(1);
    expect(single).toBeLessThan(MULTI_PROJECT_CHANGED.length);
  });

  it("`facts` marks every changed file analysed, in both packages", () => {
    const analysed = new Map(
      (document.extractors.facts?.files ?? []).map((f) => [f.path, f.analysed]),
    );
    for (const path of MULTI_PROJECT_CHANGED) {
      expect(analysed.get(path), `${path} must be analysed`).toBe(true);
    }
    // A file appears ONCE, not once per program that happens to contain it.
    expect(document.extractors.facts?.files.length).toBe(MULTI_PROJECT_CHANGED.length);
  });

  it("`contracts` reports the delta from EACH package, not just the first", () => {
    const byFile = new Map(
      (document.extractors.contracts?.contracts ?? []).map((c) => [`${c.file}#${c.symbol}`, c]),
    );
    const a = byFile.get("packages/a/src/token.ts#mintToken");
    const b = byFile.get("packages/b/src/session.ts#openSession");
    expect(a?.change).toBe("changed");
    expect(a?.after?.parameters.map((p) => p.name)).toEqual(["value", "ttl"]);
    expect(b?.change, "the SECOND package's delta is the one the old loader lost").toBe("changed");
    expect(b?.after?.parameters.map((p) => p.name)).toEqual(["id", "warm"]);
  });

  it("`constants` finds the changed constant in a package the old loader would have missed", () => {
    const constants = document.extractors.constants?.constants ?? [];
    const token = constants.find((c) => c.constant === "MAX_TOKEN_AGE");
    expect(token?.value).toBe("900");
    // `null` would mean tier 2 — no set A at all. This is a real reference set.
    expect(token?.references).not.toBeNull();
    // And the unprojected script's constant, which only `openFiles` reaches.
    expect(constants.find((c) => c.constant === "CHANNEL")?.value).toBe("beta");
  });

  it("`languages[].parsedFiles` is the UNION across the programs", () => {
    const ts = document.languages.find((l) => l.id === "typescript");
    expect(ts?.changedFiles).toBe(MULTI_PROJECT_CHANGED.length);
    expect(ts?.parsedFiles).toBe(MULTI_PROJECT_CHANGED.length);
    expect(ts?.engine).toBe("tsgo");
  });

  /**
   * The reference query runs inside the program that owns the declaration, and
   * that is CORRECT rather than a limitation: a cross-project reference is not
   * resolvable without project references anyway, and over-claiming one would be
   * worse than under-claiming it — `constants` and `contracts` both make ABSENCE
   * claims off these sets.
   */
  it("finds the same-program consumer of a changed symbol", () => {
    const mint = (document.extractors.facts?.symbols ?? []).find((s) => s.name === "mintToken");
    expect(mint?.references.map((r) => r.at)).toContain("packages/a/src/consumer.ts:4");
    const open = (document.extractors.facts?.symbols ?? []).find((s) => s.name === "openSession");
    expect(open?.references.map((r) => r.at)).toContain("packages/b/src/consumer.ts:4");
  });
});

/**
 * A file under NO tsconfig — the structural repair of the old glob fallback.
 *
 * `openFiles` is LSP `didOpen`: a file an ancestor tsconfig genuinely contains
 * loads that CONFIGURED project, and only the remainder falls through to tsgo's
 * inferred project. So there is no glob, no package-root heuristic and no
 * second program holding a duplicate copy of everything — but the caveat is the
 * same one and it is still named, because an inferred project carries DEFAULT
 * compiler options and none of the repository's `paths`, `strict` or `jsx`.
 */
describe("a file under no tsconfig is opened anyway — and the fallback says so", () => {
  it("analyses it rather than dropping it", () => {
    const analysed = (document.extractors.facts?.files ?? []).find(
      (f) => f.path === "scripts/release.ts",
    );
    expect(analysed?.analysed, "a file no tsconfig covers must still be attempted").toBe(true);
    expect(
      (document.extractors.contracts?.contracts ?? []).some((c) => c.file === "scripts/release.ts"),
    ).toBe(true);
  });

  it("names the inferred project in degraded[], with the files it covered", () => {
    const reason =
      document.degraded.find((d) => /covered by no tsconfig/.test(d.reason))?.reason ?? "";
    expect(reason, "the inferred project must never be silent").not.toBe("");
    expect(reason).toMatch(/scripts\/release\.ts/);
    expect(reason).toMatch(/DEFAULT compiler options/);
    expect(document.coverage).toBe("degraded");
  });
});

/**
 * `--repo .` — the spelling in this package's own README example — used to
 * disable tsconfig discovery outright.
 *
 * The walk up from a changed file toward the repo root is guarded on
 * `dir.startsWith(repo) && dir.length >= repo.length`. With `repo === "."`,
 * `join(".", "packages/a/src/session.ts")` normalises the `./` away, so the
 * first `dir` is `packages/a/src` — which does not start with `"."` — and the
 * walk never ran. Every changed file was filed under "no tsconfig" and the whole
 * diff fell through to a program with none of the repo's compiler options behind
 * it (`strict`, `jsx`, `paths`).
 *
 * The principle this file is built on applies here too: the assertion is paired
 * with the number it would be without the fix. Measured on THIS monorepo at
 * `c8530b83`, `--repo .` reported *"31 changed file(s) are covered by no
 * tsconfig"* against four programs from three tsconfigs for the absolute
 * spelling.
 */
describe("a RELATIVE --repo names the same repository as an absolute one", () => {
  const withCwd = <T>(dir: string, fn: () => T): T => {
    const before = process.cwd();
    process.chdir(dir);
    try {
      return fn();
    } finally {
      process.chdir(before);
    }
  };

  it("discovers the same tsconfigs from `.` as from the absolute path", () => {
    const absolute = discoverTsgoTargets({
      repo: fixture.dir,
      changed: changedPaths(fixture.dir, fixture.base, fixture.head),
    });
    const relative = withCwd(fixture.dir, () =>
      discoverTsgoTargets({
        repo: ".",
        changed: changedPaths(".", fixture.base, fixture.head),
      }),
    );

    // WITHOUT the fix this was zero tsconfigs — the whole diff inferred. The
    // pairing is the point: a count alone would pass on a discovery that had
    // simply stopped finding anything.
    // Compared REPO-RELATIVE: on darwin `process.cwd()` resolves
    // `/var` → `/private/var`, so the absolute strings differ for a reason that
    // has nothing to do with what was compiled.
    const configs = (targets: typeof absolute): string[] =>
      targets.tsConfigPaths.map((p) => p.slice(p.indexOf("/packages/"))).sort();
    expect(configs(relative)).toEqual(configs(absolute));
    expect(configs(relative).length).toBeGreaterThan(0);
    expect(relative.orphans).toEqual(absolute.orphans);
  });

  it("runs the whole pipeline against `.` and produces the same document", () => {
    const relative = withCwd(fixture.dir, () =>
      runExtractor({
        extractor: "all",
        repo: ".",
        base: fixture.base,
        head: fixture.head,
        env: { PATH: "" },
      }),
    ).document as unknown as AllDocument;

    // `repo` is a slug and `generatedAt` is a clock; everything else is a claim
    // about the same two commits and must not depend on how the caller spelled
    // the directory.
    const strip = (d: AllDocument): string =>
      JSON.stringify({ ...d, generatedAt: undefined, toolchain: undefined });
    expect(strip(relative)).toBe(strip(document));
  });
});

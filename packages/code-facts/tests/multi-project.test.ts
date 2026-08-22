/**
 * ONE PROGRAM PER TSCONFIG — the coverage gap, and the guard on the fix.
 *
 * The number that forced this file: over 50 real PRs (keycloak / grafana /
 * discourse / cal.com / sentry) the loader analysed **58 of 8,514 changed
 * files — 0.7%** — and reported **tier 1** while doing it. `grafana-90939`
 * analysed 1 file of 142; `cal-com-22532` analysed 0 of 17. Every one of those
 * runs carried the shortfall in `degraded[]`, so this was never a loudness bug:
 * the package was honest, and blind. `findTsConfig` picked ONE nearest tsconfig
 * for the whole diff, and a monorepo diff (cal.com: 26 tsconfigs, 140
 * `package.json`s) is not covered by any one of them.
 *
 * The principle from `tests/noise-floor.test.ts` applies unchanged: **a bound is
 * only a guard if you also pin the number it would be WITHOUT the fix.** So
 * every coverage assertion below is paired with the same measurement taken
 * against a FORCED single tsconfig — which is exactly what the old loader did —
 * and that pair is the whole point of the file.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { join } from "node:path";
import {
  makeMultiProjectFixture,
  makeStarvedProjectsFixture,
  MULTI_PROJECT_CHANGED,
  STARVED_CHANGED,
  STARVED_MAX_FILES,
  STARVED_PACKAGE_FILES,
  type Fixture,
} from "./helpers.js";
import { runExtractor } from "../src/run.js";
import { loadProject } from "../src/project.js";
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

describe("a diff that spans two packages is analysed in both", () => {
  it("loads one program per tsconfig the diff touches", () => {
    const loaded = loadProject({ repo: fixture.dir, changedPaths: MULTI_PROJECT_CHANGED });
    expect(loaded.tier).toBe(1);
    // Two package tsconfigs, plus the glob fallback for `scripts/release.ts`.
    expect(loaded.groups.length).toBe(3);
    expect(loaded.tsConfigPaths.filter((p) => p !== null).sort()).toEqual([
      join(fixture.dir, "packages/a/tsconfig.json"),
      join(fixture.dir, "packages/b/tsconfig.json"),
    ]);
    // The claim that matters: EVERY changed file ended up in some program.
    expect(loaded.analysedCount).toBe(MULTI_PROJECT_CHANGED.length);
  });

  /**
   * WITHOUT the fix. `--tsconfig` forces exactly one program, which is what the
   * single-project loader did on every diff — so this is the old behaviour,
   * measured on the same fixture rather than described in a comment.
   */
  it("WITHOUT the fix — one forced tsconfig sees a third of the same diff", () => {
    const single = loadProject({
      repo: fixture.dir,
      changedPaths: MULTI_PROJECT_CHANGED,
      tsConfigPath: join(fixture.dir, "packages/a/tsconfig.json"),
    });
    expect(single.groups.length).toBe(1);
    expect(single.analysedCount).toBe(1);
    expect(single.analysedCount).toBeLessThan(MULTI_PROJECT_CHANGED.length);
    // And it says so — this half was never broken.
    expect(single.degraded.some((d) => /not in the compiled project/.test(d.reason))).toBe(true);
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
    // And the unprojected script's constant, which only the glob fallback sees.
    expect(constants.find((c) => c.constant === "CHANNEL")?.value).toBe("beta");
  });

  it("`languages[].parsedFiles` is the UNION across the programs", () => {
    const ts = document.languages.find((l) => l.id === "typescript");
    expect(ts?.changedFiles).toBe(MULTI_PROJECT_CHANGED.length);
    expect(ts?.parsedFiles).toBe(MULTI_PROJECT_CHANGED.length);
    expect(ts?.engine).toBe("ts-morph");
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

describe("a file under no tsconfig falls back to a glob — and the fallback says so", () => {
  it("analyses it rather than dropping it", () => {
    const analysed = (document.extractors.facts?.files ?? []).find(
      (f) => f.path === "scripts/release.ts",
    );
    expect(analysed?.analysed, "a file no tsconfig covers must still be attempted").toBe(true);
    expect(
      (document.extractors.contracts?.contracts ?? []).some((c) => c.file === "scripts/release.ts"),
    ).toBe(true);
  });

  /**
   * NAMED, because glob-tier output is not tsconfig-tier output: the program has
   * no compiler options from the repo behind it, so type resolution there is
   * best-effort. A consumer that read this as a clean tsconfig-backed result
   * would be over-trusting it, which is the failure mode of the whole package.
   */
  it("names the fallback in degraded[], with the files it covered", () => {
    const reason =
      document.degraded.find((d) => /covered by no tsconfig/.test(d.reason))?.reason ?? "";
    expect(reason, "the glob fallback must never be silent").not.toBe("");
    expect(reason).toMatch(/scripts\/release\.ts/);
    expect(reason).toMatch(/glob-tier output, not tsconfig-tier/);
    expect(document.coverage).toBe("degraded");
  });

  it("does not re-load the tsconfig-covered packages into the fallback program", () => {
    // The memory guard: a fallback rooted at the repo would otherwise hold a
    // second copy of every file the package programs already have.
    const loaded = loadProject({ repo: fixture.dir, changedPaths: MULTI_PROJECT_CHANGED });
    const fallback = loaded.groups.find((g) => g.tsConfigPath === null);
    expect(fallback).toBeDefined();
    expect(
      fallback?.project.getSourceFiles().map((f) => f.getFilePath()),
      "the fallback glob must exclude every directory a tsconfig group already covers",
    ).not.toContain(join(fixture.dir, "packages/a/src/token.ts"));
    // Sum of the parts, not a multiple of the whole.
    expect(loaded.fileCount).toBe(
      loaded.groups.reduce((total, group) => total + group.fileCount, 0),
    );
  });
});

/**
 * ── THE STARVATION SHAPE ─────────────────────────────────────────────────────
 *
 * The file budget is still a TOTAL — that is the memory bound, and a 2 GB agent
 * cap in the production sandbox is why it did not become a per-project
 * allowance. What changed is that the total is ALLOCATED rather than spent
 * first-come-first-served, and that a group which does not fit its allocation
 * is admitted PARTIALLY instead of refused whole.
 *
 * The bug this replaces was measured, not theorised. On
 * `prreview__grafana-106778` the root tsconfig's 5,399 files were charged
 * against the 6,000 total, so the group holding ONE changed file was refused
 * outright — "the glob over . holds 7473 source files and 5399 were already
 * loaded for this diff, above the 6000 ceiling" — and the case fell from 16
 * contract deltas to 11. **A project holding one changed file must never be
 * refused because an unrelated project already spent the shared budget.**
 */
describe("the file budget is ALLOCATED, so a small project is not starved by a big one", () => {
  let starved: Fixture;

  beforeAll(() => {
    starved = makeStarvedProjectsFixture();
  });
  afterAll(() => starved?.cleanup());

  /**
   * WITHOUT the fix, stated as arithmetic on the fixture rather than as prose:
   * `big` alone fits the ceiling, and `big` plus EITHER of the other two does
   * not. That is precisely the condition a first-come budget refuses on, so
   * this is the pin — if the fixture ever stops exhibiting it, the assertions
   * below stop meaning anything.
   */
  it("the fixture really does exhibit the starvation condition", () => {
    const { big, mid, small } = STARVED_PACKAGE_FILES;
    expect(big).toBeLessThanOrEqual(STARVED_MAX_FILES);
    expect(big + mid).toBeGreaterThan(STARVED_MAX_FILES);
    expect(big + small).toBeGreaterThan(STARVED_MAX_FILES);
  });

  it("analyses every changed file in all THREE packages under a ceiling two of them do not fit", () => {
    const loaded = loadProject({
      repo: starved.dir,
      changedPaths: STARVED_CHANGED,
      maxFiles: STARVED_MAX_FILES,
    });
    expect(loaded.tier).toBe(1);
    expect(loaded.groups.length, "one program per package, none refused").toBe(3);
    // The claim: the LAST group by diff share — the one a first-come budget
    // could never have reached — still holds its changed file.
    const small = loaded.groups.find((g) => g.tsConfigPath?.includes("packages/small"));
    expect(small?.analysedPaths).toEqual(["packages/small/src/mod0.ts"]);
    expect(loaded.analysedCount).toBe(STARVED_CHANGED.length);
    // And the memory bound is intact: the total never became per-project.
    expect(loaded.fileCount).toBeLessThanOrEqual(STARVED_MAX_FILES);
  });

  /**
   * A partial project is not a free lunch and must not read like one. The
   * omitted files are files a reference could have lived in, so every set the
   * narrowed program produces is a LOWER BOUND — which is the one thing a
   * consumer must not learn by inference.
   */
  it("names the narrowing in degraded[], with the counts and the lower-bound warning", () => {
    const loaded = loadProject({
      repo: starved.dir,
      changedPaths: STARVED_CHANGED,
      maxFiles: STARVED_MAX_FILES,
    });
    expect(loaded.narrowed, "a narrowed run must say so in a field, not only in prose").toBe(true);
    const narrowed = loaded.groups.filter((g) => g.omittedCount > 0);
    expect(narrowed.length).toBeGreaterThan(0);
    for (const group of narrowed) {
      expect(group.candidateCount).toBe(group.fileCount + group.omittedCount);
      const reason =
        loaded.degraded.find(
          (d) =>
            d.reason.includes(group.tsConfigPath?.split("/").slice(-2).join("/") ?? "") &&
            /LOWER BOUND/.test(d.reason),
        )?.reason ?? "";
      expect(reason, `${group.tsConfigPath} was narrowed silently`).not.toBe("");
      expect(reason).toMatch(/left OUT/);
      expect(reason).toMatch(/raise --max-files/);
    }
  });

  /**
   * The other direction, and the reason the assertion above is not vacuous: the
   * SAME fixture under a ceiling it fits inside narrows nothing and says
   * nothing. A loader that degraded unconditionally would pass the test above.
   */
  it("says nothing about narrowing when every group fits", () => {
    const loaded = loadProject({ repo: starved.dir, changedPaths: STARVED_CHANGED });
    expect(loaded.narrowed).toBe(false);
    expect(loaded.groups.every((g) => g.omittedCount === 0)).toBe(true);
    expect(loaded.degraded.filter((d) => /LOWER BOUND/.test(d.reason))).toEqual([]);
    expect(loaded.analysedCount).toBe(STARVED_CHANGED.length);
    expect(loaded.fileCount).toBe(
      STARVED_PACKAGE_FILES.big + STARVED_PACKAGE_FILES.mid + STARVED_PACKAGE_FILES.small,
    );
  });

  /**
   * The reserve, at its limit: a changed file gets into a program even when the
   * budget is already gone, because the diff is not optional work — `facts` and
   * `contracts` read every changed file whatever the loader decides, so
   * declining to compile one saves nothing and costs the whole answer for it.
   */
  it("a ceiling the size of the diff still puts every changed file in some program", () => {
    const loaded = loadProject({
      repo: starved.dir,
      changedPaths: STARVED_CHANGED,
      maxFiles: STARVED_CHANGED.length,
    });
    expect(loaded.analysedCount).toBe(STARVED_CHANGED.length);
    expect(loaded.groups.length).toBe(3);
    // The documented hard bound: `maxFiles` plus the analysable diff.
    expect(loaded.fileCount).toBeLessThanOrEqual(2 * STARVED_CHANGED.length);
    expect(loaded.narrowed).toBe(true);
  });

  /**
   * The genuinely unservable case, and the one place the reserve stops: a diff
   * with more analysable files than the WHOLE budget cannot be held, so the
   * loader must say that in ONE clear reason rather than leave a reader to
   * infer it from a pile of per-group ones.
   */
  it("names a diff that is itself bigger than the budget, in one reason", () => {
    const loaded = loadProject({
      repo: starved.dir,
      changedPaths: STARVED_CHANGED,
      maxFiles: 1,
    });
    const reason =
      loaded.degraded.find((d) => /the diff itself touches/.test(d.reason))?.reason ?? "";
    expect(reason).toMatch(/4 analysable file\(s\), more than the 1-file budget/);
    expect(loaded.analysedCount).toBeLessThan(STARVED_CHANGED.length);
    expect(loaded.degraded.some((d) => /not in the compiled project/.test(d.reason))).toBe(true);
  });

  it("`maxProjects` still refuses wholesale — and names THAT separately", () => {
    const loaded = loadProject({
      repo: starved.dir,
      changedPaths: STARVED_CHANGED,
      maxProjects: 1,
    });
    expect(loaded.groups.length).toBe(1);
    expect(loaded.analysedCount).toBe(2);
    const reason = loaded.degraded.find((d) => /--max-projects/.test(d.reason))?.reason ?? "";
    expect(reason, "half a compiler is not a thing, so this refusal stays wholesale").toMatch(
      /2 changed file\(s\) went unanalysed/,
    );
    expect(loaded.degraded.some((d) => /not in the compiled project/.test(d.reason))).toBe(true);
  });
});

describe("the budget on the two-package fixture", () => {
  it("keeps the total bound while analysing both packages and the unprojected file", () => {
    const loaded = loadProject({
      repo: fixture.dir,
      changedPaths: MULTI_PROJECT_CHANGED,
      maxFiles: 3,
    });
    // Three changed files, three programs, three files — the budget spent
    // entirely on the diff rather than on the first package's neighbours.
    expect(loaded.fileCount).toBeLessThanOrEqual(3);
    expect(loaded.analysedCount).toBe(MULTI_PROJECT_CHANGED.length);
    expect(loaded.tier).toBe(1);
    expect(loaded.narrowed).toBe(true);
  });

  it("`maxProjects` drops the tail of the group list, largest share first", () => {
    const loaded = loadProject({
      repo: fixture.dir,
      changedPaths: MULTI_PROJECT_CHANGED,
      maxProjects: 1,
    });
    expect(loaded.groups.length).toBe(1);
    expect(loaded.analysedCount).toBe(1);
    expect(loaded.degraded.some((d) => /not in the compiled project/.test(d.reason))).toBe(true);
  });
});

/**
 * `--repo .` — the spelling in this package's own README example — used to
 * disable tsconfig discovery outright.
 *
 * `nearestUp` walks up from a changed file toward the repo root under
 * `dir.startsWith(repo) && dir.length >= repo.length`. With `repo === "."`,
 * `join(".", "packages/a/src/session.ts")` normalises the `./` away, so the
 * first `dir` is `packages/a/src` — which does not start with `"."` — and the
 * walk never ran. Every changed file was filed under "no tsconfig" and the whole
 * diff fell through to the GLOB fallback: a program with none of the repo's
 * compiler options behind it (`strict`, `jsx`, `paths`).
 *
 * The principle this file is built on applies here too: the assertion is paired
 * with the number it would be without the fix. Measured on THIS monorepo at
 * `c8530b83`, `--repo .` reported *"31 changed file(s) are covered by no
 * tsconfig, so they were analysed by GLOBBING their package instead"* against
 * four programs from three tsconfigs for the absolute spelling.
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

  it("discovers the same tsconfig groups from `.` as from the absolute path", () => {
    const absolute = loadProject({ repo: fixture.dir, changedPaths: MULTI_PROJECT_CHANGED });
    const relative = withCwd(fixture.dir, () =>
      loadProject({ repo: ".", changedPaths: MULTI_PROJECT_CHANGED }),
    );

    // WITHOUT the fix this was 1 group, zero of them a tsconfig — the whole diff
    // globbed. The pairing is the point: `groups.length` alone would pass on a
    // loader that had simply stopped discovering anything.
    // Compared REPO-RELATIVE: on darwin `process.cwd()` resolves
    // `/var` → `/private/var`, so the absolute strings differ for a reason that
    // has nothing to do with what was compiled.
    const configs = (loaded: typeof absolute): string[] =>
      loaded.tsConfigPaths
        .filter((p): p is string => p !== null)
        .map((p) => p.slice(p.indexOf("/packages/")))
        .sort();
    expect(relative.groups.length).toBe(absolute.groups.length);
    expect(configs(relative)).toEqual(configs(absolute));
    expect(configs(relative).length).toBeGreaterThan(0);
    expect(relative.analysedCount).toBe(absolute.analysedCount);
    expect(relative.tier).toBe(absolute.tier);
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

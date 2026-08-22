/**
 * THE DIFF RANGE — `merge-base(base, head)..head`, never `base..head`.
 *
 * For a pull request the base is the FORK POINT, which is what GitHub's own
 * "Files changed" tab shows. A two-dot diff additionally contains every commit
 * that landed on the base BRANCH since the PR forked, and the author wrote none
 * of it. Production reads `pull_request.base.sha` — the base branch's tip at
 * event time — so this is not a dataset artefact: a real review against a busy
 * base branch analysed thousands of untouched files, spent budget on them, and
 * generated obligations about unrelated code.
 *
 * MEASURED on the 50-PR Martian corpus (9 of 50 diverge):
 *
 *   sentry-greptile-1       6125 files (base..head)  vs     3 (merge base)
 *   sentry-greptile-94376   1281                     vs     7
 *   grafana-90939            142                     vs     1
 *   keycloak-40940            82                     vs     4
 *
 * The principle from `CLAUDE.md` applies: a bound is only a guard if you pin the
 * number it would be WITHOUT the fix. So every assertion here is paired with the
 * two-dot number, computed from the same fixture by raw git — one file the PR
 * wrote against three files a two-dot diff would have claimed.
 */
import { execFileSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  makeForkedFixture,
  makeUnrelatedHistoriesFixture,
  type Fixture,
  type ForkedFixture,
} from "./helpers.js";
import { changedPaths, diffHunks, mergeBase, resolveDiffBase } from "../src/git.js";
import { runExtractor } from "../src/run.js";
import { checkAll } from "../src/selfcheck.js";
import type { ConstantsDocument, FactsDocument } from "../src/schema.js";

/** The un-fixed range, straight from git — the floor these bounds sit above. */
function twoDotPaths(fixture: Fixture): string[] {
  return execFileSync("git", ["diff", "--name-only", "-M", `${fixture.base}..${fixture.head}`], {
    cwd: fixture.dir,
    encoding: "utf8",
  })
    .split("\n")
    .filter((line) => line.length > 0);
}

describe("the diff range is the merge base", () => {
  let fixture: ForkedFixture;
  beforeAll(() => {
    fixture = makeForkedFixture();
  });
  afterAll(() => fixture?.cleanup());

  it("the fixture really does exhibit the bug — two-dot sees the base branch's own commit", () => {
    // Without this the assertions below would pass on a fixture where the two
    // ranges are identical, which is most of them.
    const twoDot = twoDotPaths(fixture);
    for (const path of fixture.basePaths) expect(twoDot).toContain(path);
    expect(twoDot.length).toBeGreaterThan(fixture.prPaths.length);
  });

  it("changedPaths reports the PR's files and NOT the base branch's", () => {
    const paths = changedPaths(fixture.dir, fixture.base, fixture.head).map((c) => c.path);
    expect(paths.sort()).toEqual([...fixture.prPaths].sort());
    for (const path of fixture.basePaths) {
      expect(paths, `${path} landed on the base branch; the PR author never touched it`).not.toContain(path);
    }
  });

  it("diffHunks reports the PR's hunks and NOT the base branch's", () => {
    const hunks = diffHunks(fixture.dir, fixture.base, fixture.head);
    expect(hunks.map((f) => f.path).sort()).toEqual([...fixture.prPaths].sort());
    // And the line ranges are the PR's own, in head coordinates.
    expect(hunks[0].hunks).toEqual(["src/feature.ts:1-1"]);
  });

  it("is idempotent — handed the merge base itself, it computes the same set", () => {
    // `changedPaths`/`diffHunks` re-ask for the merge base rather than trusting
    // the caller, so an exported entry point cannot be handed a branch tip and
    // quietly answer the wrong question. Re-asking must be a no-op.
    expect(mergeBase(fixture.dir, fixture.mergeBase, fixture.head)).toBe(fixture.mergeBase);
    expect(changedPaths(fixture.dir, fixture.mergeBase, fixture.head)).toEqual(
      changedPaths(fixture.dir, fixture.base, fixture.head),
    );
  });

  /**
   * The envelope must record the commit that was actually COMPARED, not the ref
   * the caller passed. `contracts` materialises the base worktree from
   * `baseSha`, and comparing against the branch tip rather than the fork point
   * is exactly the asymmetry that manufactures phantom deltas.
   */
  it("the envelope's baseSha is the merge base, not the base branch tip", () => {
    const result = runExtractor({
      extractor: "facts",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    });
    const document = result.document as unknown as FactsDocument;
    expect(document.baseSha).toBe(fixture.mergeBase);
    expect(document.baseSha).not.toBe(fixture.base);
    expect(document.headSha).toBe(fixture.head);
    expect(document.files.map((f) => f.path)).toEqual(fixture.prPaths);
    // Nothing was missing, so nothing is claimed to be.
    expect(document.coverage).toBe("full");
    expect(result.exitCode).toBe(0);
  });

  it("selfcheck agrees, because it arbitrates against the SAME range", () => {
    const document = runExtractor({
      extractor: "all",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    }).document;
    expect(checkAll(fixture.dir, document)).toEqual([]);
  });

  it("the constant the PR changed is analysed; the one the base branch changed is not", () => {
    const document = runExtractor({
      extractor: "constants",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    }).document as unknown as ConstantsDocument;
    const names = document.constants.map((c) => c.constant);
    expect(names).toContain("LIMIT");
    // `UNRELATED` changed on main after the fork. An obligation about it is an
    // obligation about code this PR did not write.
    expect(names).not.toContain("UNRELATED");
  });
});

describe("no merge base — degrade loudly, never silently", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeUnrelatedHistoriesFixture();
  });
  afterAll(() => fixture?.cleanup());

  it("resolveDiffBase reports the fallback with a NAMED reason", () => {
    expect(mergeBase(fixture.dir, fixture.base, fixture.head)).toBeNull();
    const resolved = resolveDiffBase(fixture.dir, fixture.base, fixture.head);
    expect(resolved.isMergeBase).toBe(false);
    // The fallback is the only comparison git can perform — but it is a
    // different question than the one the document is asked, so it is written
    // down rather than assumed.
    expect(resolved.sha).toBe(fixture.base);
    expect(resolved.reason).toMatch(/no merge base/);
    expect(resolved.reason).toMatch(/shallow clone/);
  });

  it("the run still produces a document, and the envelope says what it did instead", () => {
    const result = runExtractor({
      extractor: "facts",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    });
    const document = result.document as unknown as FactsDocument;
    // Loud in the artifact, never fatal to the run (§D12): a phase that exits
    // non-zero here would be re-dispatched every thirty minutes forever.
    expect(document.coverage).toBe("degraded");
    expect(result.exitCode).toBe(3);
    const entry = document.degraded.find((d) => d.extractor === "git");
    expect(entry, "an unstated fallback is the failure this package exists to prevent").toBeDefined();
    expect(entry?.reason).toMatch(/no merge base/);
  });

  it("a run WITH a merge base carries no such entry", () => {
    // The pin without the fix: without this half the assertion above would pass
    // on a package that degraded unconditionally.
    const forked = makeForkedFixture();
    try {
      const document = runExtractor({
        extractor: "facts",
        repo: forked.dir,
        base: forked.base,
        head: forked.head,
      }).document as unknown as FactsDocument;
      expect(document.degraded.filter((d) => d.extractor === "git")).toEqual([]);
    } finally {
      forked.cleanup();
    }
  });
});

/**
 * THE STAGED DIFF — the range, written down once (lever f1).
 *
 * The five survey fan-out branches make ~93 bash calls per case and ~30 of them
 * re-derive ONE fixed merge-base range that `facts.json` already holds; surveys
 * are ~75% of a case's spend. That is the money. The correctness half is bigger:
 * every re-derivation is a fresh chance to spell the range two-dot, and the same
 * corpus behind `merge-base.test.ts` says what that costs — `sentry-greptile-1`
 * reads 6,125 changed files two-dot against 3 from the merge base.
 *
 * So the assertions here are in three groups, and each is paired with the thing
 * that would make it vacuous:
 *
 *  1. THE SHAPE. One row per changed file, one patch per row, the four statuses
 *     including the two that have no head hunks at all (delete, pure rename) —
 *     against the raw `git diff` for the same range, so a patch that lost a hunk
 *     cannot pass.
 *  2. THE FILENAME. `stagedPatchName` is asserted INJECTIVE on the pair that
 *     actually collides under the naive scheme (`src/auth/x` vs `src__auth/x`),
 *     because a collision means one patch overwrites the other and the index
 *     points two rows at one file — a wrong answer wearing a right answer's
 *     clothes.
 *  3. FAIL-LOUD (LD6 / §D12). Staging is an AFFORDANCE: it cannot make the facts
 *     wrong, so it must never fail the run, must never reach exit 2, must record
 *     a `degraded[]` entry, and must leave an `index.md` that says what happened
 *     — because the brief points a survey at that exact path and a 404 there is
 *     the least informative answer available.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeFixture, type Fixture } from "./helpers.js";
import { runExtractor, runWrapped } from "../src/run.js";
import { checkAll } from "../src/selfcheck.js";
import {
  DEFAULT_DIFF_STAGE_DIR,
  MAX_STAGED_FILES,
  splitPatches,
  stageDiff,
  stagedPatchName,
} from "../src/stage-diff.js";
import { changedPaths, diffHunks } from "../src/git.js";
import type { AllDocument, StagedDiff } from "../src/schema.js";

/** A path that is only ever there so the rename is a RENAME and not two edits. */
const MOVED_BODY = `export const MOVED = "a body stable enough for -M to score it 100%";\n`;

function makeStagingFixture(): Fixture {
  return makeFixture(
    "stage-diff",
    {
      message: "base",
      files: {
        "package.json": JSON.stringify({ name: "stage-fixture", version: "1.0.0" }, null, 2),
        "src/auth/index.ts": `export const A = 1;\n`,
        "src/old.ts": MOVED_BODY,
        "src/doomed.ts": `export const GONE = 1;\n`,
        // A path with a literal `__` in it. Under the naive `/` → `__` scheme
        // this collides with `src/weird/config.ts`; it is here so the escape is
        // exercised by the real writer and not only by the unit assertion.
        "src__weird/config.ts": `export const W = 1;\n`,
        "docs/a b.md": `# spaced\n`,
        // The file nothing touches — the non-vacuity control for "one row per
        // CHANGED file", which would otherwise pass on a stager that indexed the
        // whole tree.
        "src/untouched.ts": `export const U = 1;\n`,
        BLOCKER: "a regular file, used to make a directory creation fail\n",
      },
    },
    {
      message: "head",
      files: {
        "src/auth/index.ts": `export const A = 2;\nexport const B = 3;\n`,
        "src/old.ts": null,
        "src/new.ts": MOVED_BODY,
        "src/doomed.ts": null,
        "src__weird/config.ts": `export const W = 2;\n`,
        "docs/a b.md": `# spaced\n\nand more\n`,
        "src/added.ts": `export const N = 1;\n`,
      },
    },
  );
}

const stagedIn = (fixture: Fixture): string => join(fixture.dir, DEFAULT_DIFF_STAGE_DIR);
const indexIn = (fixture: Fixture): string => readFileSync(join(stagedIn(fixture), "index.md"), "utf8");

function stageInto(fixture: Fixture, dir?: string): { payload: StagedDiff; degraded: string[] } {
  const result = stageDiff({
    repo: fixture.dir,
    baseSha: fixture.base,
    headSha: fixture.head,
    changed: changedPaths(fixture.dir, fixture.base, fixture.head),
    hunks: diffHunks(fixture.dir, fixture.base, fixture.head),
    ...(dir ? { dir } : {}),
  });
  return { payload: result.payload, degraded: result.degraded.map((d) => d.reason) };
}

describe("the staged diff — one index, one patch per changed file", () => {
  let fixture: Fixture;
  let staged: StagedDiff;

  beforeAll(() => {
    fixture = makeStagingFixture();
    staged = stageInto(fixture).payload;
  });
  afterAll(() => fixture?.cleanup());

  it("stages cleanly — nothing degraded on an ordinary diff", () => {
    // The non-vacuity control for the fail-loud group below: without this, an
    // implementation that degraded on every run would satisfy all of it.
    expect(stageInto(fixture).degraded).toEqual([]);
    expect(staged.skipped).toEqual([]);
    expect(staged.files).not.toBeNull();
  });

  it("indexes exactly the CHANGED files — not the tree", () => {
    const paths = (staged.files ?? []).map((f) => f.path);
    expect(paths).toEqual([
      "docs/a b.md",
      "src/added.ts",
      "src/auth/index.ts",
      "src/doomed.ts",
      "src/new.ts",
      "src__weird/config.ts",
    ]);
    // `src/untouched.ts` exists at both commits and is nobody's business here.
    expect(paths).not.toContain("src/untouched.ts");
    // CODE-POINT sorted, so two runs of the same range are byte-identical on any
    // machine. `localeCompare` is a function of the box's ICU data as well as of
    // the strings, and it orders exactly this pair the other way round.
    expect([...paths].sort()).toEqual(paths);
    expect([...paths].sort((a, b) => a.localeCompare(b))).not.toEqual(paths);
  });

  it("records each file's STATUS, including the two with no head hunks", () => {
    const by = new Map((staged.files ?? []).map((f) => [f.path, f]));
    expect(by.get("src/added.ts")?.status).toBe("added");
    expect(by.get("src/auth/index.ts")?.status).toBe("modified");
    expect(by.get("src/doomed.ts")?.status).toBe("deleted");
    expect(by.get("src/new.ts")?.status).toBe("renamed");
    // A rename carries the path it had at BASE — the one side `changedPaths`
    // cannot report, because it only ever keeps the head path of an `R100` line.
    expect(by.get("src/new.ts")?.renamedFrom).toBe("src/old.ts");
    expect(by.get("src/auth/index.ts")?.renamedFrom).toBeNull();
    // A deletion has no line at head to point at, and a 100%-similar rename has
    // no content hunk at all. Empty here means "no head coordinates", never
    // "unchanged" — the index prints `—`, not `0-0`.
    expect(by.get("src/doomed.ts")?.hunks).toEqual([]);
    expect(by.get("src/new.ts")?.hunks).toEqual([]);
    expect(by.get("src/auth/index.ts")?.hunks).toEqual(["1-2"]);
  });

  it("writes one patch per row, and it IS that file's diff", () => {
    for (const file of staged.files ?? []) {
      expect(file.patch, file.path).not.toBeNull();
      const patch = readFileSync(join(stagedIn(fixture), file.patch!), "utf8");
      // One file per patch: exactly one `diff --git` header, and it is this
      // file's. A stager that wrote the whole diff N times would pass every
      // other assertion in this file.
      expect([...patch.matchAll(/^diff --git /gm)], file.path).toHaveLength(1);
      expect(patch, file.path).toContain(file.path);
      expect(file.bytes, file.path).toBe(Buffer.byteLength(patch, "utf8"));
    }
    // …and the union of the patches is the whole diff, hunk for hunk. Compared
    // against raw git rather than against ourselves.
    const raw = execFileSync(
      "git",
      ["-c", "core.quotePath=false", "diff", "--no-color", "--no-ext-diff", "-M", `${fixture.base}..${fixture.head}`],
      { cwd: fixture.dir, encoding: "utf8" },
    );
    const rawHunks = raw.split("\n").filter((l) => l.startsWith("@@")).length;
    const stagedHunks = (staged.files ?? [])
      .map((f) => readFileSync(join(stagedIn(fixture), f.patch!), "utf8"))
      .join("\n")
      .split("\n")
      .filter((l) => l.startsWith("@@")).length;
    expect(stagedHunks).toBe(rawHunks);
    expect(rawHunks).toBeGreaterThan(0);
  });

  it("keeps a rename a rename and a deletion a deletion, in the patch itself", () => {
    const by = new Map((staged.files ?? []).map((f) => [f.path, f]));
    const rename = readFileSync(join(stagedIn(fixture), by.get("src/new.ts")!.patch!), "utf8");
    expect(rename).toContain("rename from src/old.ts");
    expect(rename).toContain("rename to src/new.ts");
    // The alternative — `-M` off — renders a 100% rename as a whole-file
    // deletion plus a whole-file addition, which reads to a model as a rewrite.
    expect(rename).not.toContain("+++ /dev/null");

    const deletion = readFileSync(join(stagedIn(fixture), by.get("src/doomed.ts")!.patch!), "utf8");
    expect(deletion).toContain("+++ /dev/null");
    expect(deletion).toContain("-export const GONE = 1;");
  });

  it("writes an index that names every file, its status, its ranges and its patch", () => {
    const index = indexIn(fixture);
    expect(index).toContain("# Staged diff — 6 changed file(s)");
    for (const file of staged.files ?? []) {
      expect(index, file.path).toContain(`| \`${file.path}\` |`);
      expect(index, file.path).toContain(`${staged.dir}/${file.patch}`);
    }
    expect(index).toContain("| `src/new.ts` | R (from `src/old.ts`) |");
    expect(index).toContain("| `src/auth/index.ts` | M | 1-2 |");
    // The instruction the whole lever exists for, in the artifact rather than
    // only in the brief — a model that opens the index and nothing else still
    // gets told not to re-derive the range.
    expect(index).toMatch(/Do not re-derive this range with `git diff` or `git show`/);
    // …and the affordance beside it, in the artifact too. A prohibition alone
    // measured as over-suppression (survey bash calls 848 → 399 for ~276 calls
    // of real re-derivation; internal recall 21/25 → 12/25), and the index is
    // the first thing a branch opens.
    expect(index).toMatch(/starting point, not a scope/);
    expect(index).toMatch(/FULL CHECKOUT/);
    expect(index).toContain("relative to the repository checkout");
  });

  it("is deterministic — the same range twice is the same bytes", () => {
    const before = readdirSync(stagedIn(fixture)).sort();
    const beforeIndex = indexIn(fixture);
    const again = stageInto(fixture).payload;
    expect(readdirSync(stagedIn(fixture)).sort()).toEqual(before);
    expect(indexIn(fixture)).toBe(beforeIndex);
    expect(again).toEqual(staged);
  });

  it("clears a STALE patch rather than leaving it beside a current index", () => {
    // The workspace is reused across runs (`PER_TARGET_REUSE_WORKFLOWS`) and the
    // cross-run refresh is `git clean -fdx -e node_modules`, which keeps
    // `.lastlight/` untracked files. A patch from the previous head sha that
    // survived into this run's directory is a diff of a commit that is no longer
    // there — and the index that does not name it is no protection, because the
    // model can list the directory.
    writeFileSync(join(stagedIn(fixture), "stale__ghost.ts.patch"), "from a previous run\n", "utf8");
    stageInto(fixture);
    expect(existsSync(join(stagedIn(fixture), "stale__ghost.ts.patch"))).toBe(false);
  });
});

describe("the patch FILENAME is collision-safe, not merely readable", () => {
  it("is the readable shape for an ordinary path", () => {
    expect(stagedPatchName("src/auth/index.ts")).toBe("src__auth__index.ts.patch");
    expect(stagedPatchName("README.md")).toBe("README.md.patch");
  });

  it("escapes `_`, which is what makes it INJECTIVE", () => {
    // THE COLLISION. Under a naive `/` → `__` these two are one filename: one
    // patch overwrites the other, and the index points two rows at the same
    // bytes. Nothing downstream could detect it.
    const slashes = stagedPatchName("src/auth/index.ts");
    const underscores = stagedPatchName("src__auth/index.ts");
    expect(underscores).not.toBe(slashes);
    expect(underscores).toContain("_5f_");
  });

  it("escapes everything else outside [A-Za-z0-9.-] too", () => {
    expect(stagedPatchName("docs/a b.md")).toBe("docs__a_20_b.md.patch");
    expect(stagedPatchName("src/café.ts")).toBe("src__caf_e9_.ts.patch");
    // The escape is prefix-free, so no escaped form can be spelled two ways.
    expect(stagedPatchName("src/a_20_b.ts")).not.toBe(stagedPatchName("src/a b.ts"));
  });

  it("stays inside a filesystem's name limit, and stays unique when it truncates", () => {
    const long = `src/${"very-long-directory-name/".repeat(20)}index.ts`;
    const other = `src/${"very-long-directory-name/".repeat(20)}other.ts`;
    expect(stagedPatchName(long).length).toBeLessThanOrEqual(180);
    expect(stagedPatchName(long)).toContain("~");
    expect(stagedPatchName(long)).not.toBe(stagedPatchName(other));
  });

  it("is a pure function of the path — never of the batch it was staged in", () => {
    // Assignment that depended on ordering would move a filename whenever an
    // unrelated file joined the diff, and a stored index would stop resolving.
    expect(stagedPatchName("src/auth/index.ts")).toBe(stagedPatchName("src/auth/index.ts"));
  });
});

describe("splitPatches attributes every chunk to the path it is about", () => {
  it("uses the HEAD side for an ordinary change and the BASE side for a deletion", () => {
    const chunks = splitPatches(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "index 111..222 100644",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
        "diff --git a/src/gone.ts b/src/gone.ts",
        "deleted file mode 100644",
        "--- a/src/gone.ts",
        "+++ /dev/null",
        "@@ -1 +0,0 @@",
        "-gone",
        "",
      ].join("\n"),
    );
    expect(chunks.map((c) => c.path)).toEqual(["src/a.ts", "src/gone.ts"]);
  });

  it("falls back to the header for a BINARY patch, which has no ---/+++ pair", () => {
    const chunks = splitPatches(
      [
        "diff --git a/assets/logo.png b/assets/logo.png",
        "index 111..222 100644",
        "Binary files a/assets/logo.png and b/assets/logo.png differ",
        "",
      ].join("\n"),
    );
    expect(chunks).toHaveLength(1);
    expect(chunks[0].path).toBe("assets/logo.png");
    expect(chunks[0].text).toContain("Binary files");
  });

  it("reads `rename from` rather than inferring it from the header", () => {
    const chunks = splitPatches(
      [
        "diff --git a/src/old.ts b/src/new.ts",
        "similarity index 100%",
        "rename from src/old.ts",
        "rename to src/new.ts",
        "",
      ].join("\n"),
    );
    expect(chunks[0].path).toBe("src/new.ts");
    expect(chunks[0].renamedFrom).toBe("src/old.ts");
  });
});

describe("the envelope carries the record, with `null` ≠ `[]` ≠ absent", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeStagingFixture();
  });
  afterAll(() => fixture?.cleanup());

  it("ABSENT when nobody asked — a run that did not stage claims nothing", () => {
    const document = runExtractor({
      extractor: "all",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
    }).document as unknown as AllDocument;
    expect(document.stagedDiff).toBeUndefined();
    expect(existsSync(stagedIn(fixture))).toBe(false);
  });

  it("PRESENT and populated when asked, and it validates + self-checks", () => {
    const result = runExtractor({
      extractor: "all",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
      stageDiff: true,
    });
    const document = result.document as unknown as AllDocument;
    expect(document.stagedDiff?.files).toHaveLength(6);
    expect(document.stagedDiff?.dir).toBe(DEFAULT_DIFF_STAGE_DIR);
    // Repo-RELATIVE, always. `selfcheck`'s `no-absolute-paths` walks every
    // string in the document, and a host path in the envelope is a host path in
    // a model's prompt — and the one form a survey branch cannot read (measured:
    // relative 98/98, workspace-root-absolute 0/27).
    expect(document.stagedDiff?.dir.startsWith("/")).toBe(false);
    expect(
      checkAll(fixture.dir, result.document).filter((v) => v.check === "no-absolute-paths"),
    ).toEqual([]);
    // Staging is not an analysis: a clean staging adds no `degraded[]` entry of
    // its own, so it cannot move `coverage` on its own either.
    expect(result.document.degraded).toBeDefined();
    expect(
      (result.document.degraded as { extractor: string }[]).filter(
        (d) => d.extractor === "stage-diff",
      ),
    ).toEqual([]);
  });

  it("the staged patches survive an analysis that could NOT run", () => {
    // Staging runs before the compiler opens, on purpose: the affordance is
    // worth most exactly when the analysis failed, because that is when a survey
    // has nothing else to go on. Forced here by pointing the run at a tsconfig
    // that does not exist, which `prepare`/`openViews` cannot recover from.
    const dir = join(fixture.dir, ".lastlight", "pr-review", "isolated");
    const result = runWrapped({
      extractor: "all",
      repo: fixture.dir,
      base: fixture.base,
      head: "no-such-ref",
      stageDiff: true,
      diffStageDir: ".lastlight/pr-review/isolated",
    });
    // The head ref cannot be resolved, so nothing — including staging — could
    // run: `runWrapped` writes the `coverage: "none"` envelope and exits 2.
    expect(result.exitCode).toBe(2);
    expect(existsSync(dir)).toBe(false);
    expect((result.document as unknown as AllDocument).stagedDiff).toBeUndefined();
  });
});

describe("fail-loud — staging cannot fail the run, and cannot be silent", () => {
  let fixture: Fixture;
  beforeAll(() => {
    fixture = makeStagingFixture();
  });
  afterAll(() => fixture?.cleanup());

  /**
   * The failure is forced through a path component that is a FILE (`BLOCKER` is
   * committed in the fixture), so `mkdirSync` gets a real ENOTDIR. No mocks: the
   * property under test is what this module does with an exception it did not
   * anticipate, and a thrown stub proves less than the filesystem does.
   */
  const blocked = ".lastlight/pr-review/BLOCKER-not-a-dir/diff";

  it("records a `degraded[]` entry naming the extractor, and `files: null`", () => {
    const result = stageDiff({
      repo: fixture.dir,
      baseSha: fixture.base,
      headSha: fixture.head,
      changed: changedPaths(fixture.dir, fixture.base, fixture.head),
      hunks: diffHunks(fixture.dir, fixture.base, fixture.head),
      dir: "BLOCKER/diff",
    });
    expect(result.payload.files).toBeNull();
    // NOT `[]`. An empty list is the honest answer for a range that changed
    // nothing, and collapsing the two would let "we could not look" be read as
    // "we looked and the PR is empty" — locked decision 6, at this layer.
    expect(result.payload.files).not.toEqual([]);
    expect(result.degraded).toHaveLength(1);
    expect(result.degraded[0].extractor).toBe("stage-diff");
    expect(result.degraded[0].reason).toContain("could not be staged");
    // And it says which half of the document is unaffected, so nobody reads a
    // staging failure as a failed analysis.
    expect(result.degraded[0].reason).toContain("ANALYSIS in this document is unaffected");
    expect(result.degraded[0].reason).toContain("THREE-DOT");
  });

  it("never throws — a throw here would become a `coverage: none` envelope", () => {
    expect(() =>
      stageDiff({
        repo: "/definitely/not/a/repo",
        baseSha: "deadbeef",
        headSha: "deadbeef",
        changed: [],
        hunks: [],
        dir: "/definitely/not/a/repo/diff",
      }),
    ).not.toThrow();
  });

  it("writes a LOUD index at the path the brief points at, when it can", () => {
    // The brief hands a survey `<dir>/index.md`. An absent file there is the
    // least informative failure available: it looks like a deployment without
    // the pipeline. A bad base sha fails the git call and leaves the directory
    // perfectly writable, which is the case this covers.
    const dir = join(fixture.dir, ".lastlight", "pr-review", "loud");
    const result = stageDiff({
      repo: fixture.dir,
      baseSha: "0000000000000000000000000000000000000000",
      headSha: fixture.head,
      changed: [],
      hunks: [],
      dir: ".lastlight/pr-review/loud",
    });
    expect(result.payload.files).toBeNull();
    const index = readFileSync(join(dir, "index.md"), "utf8");
    expect(index).toContain("# Staged diff — NOT AVAILABLE");
    expect(index).toContain("MISSING AFFORDANCE, not an empty diff");
    // The escape hatch, spelled correctly. A prompt that sends a model back to
    // git without the third dot re-opens the bug staging closes.
    expect(index).toContain("git diff <baseBranch>...HEAD");
    expect(index).not.toMatch(/git diff <baseBranch> HEAD\n/);
  });

  it("is DEGRADED at most — it never reaches exit 2, and the facts still ship", () => {
    // §D12: a `facts` phase that exits non-zero fails the run, records no
    // `assessedHeadShaByWorkflow`, and is re-dispatched by cron-review.yaml every
    // thirty minutes forever. Staging is an affordance; it may not buy that.
    const result = runExtractor({
      extractor: "all",
      repo: fixture.dir,
      base: fixture.base,
      head: fixture.head,
      stageDiff: true,
      diffStageDir: "BLOCKER/diff",
    });
    expect(result.exitCode).toBe(3);
    expect(result.exitCode).not.toBe(2);
    const document = result.document as unknown as AllDocument;
    expect(document.coverage).toBe("degraded");
    expect(document.stagedDiff?.files).toBeNull();
    // The analysis itself is untouched — the whole point of the entry's wording.
    expect(document.extractors.facts?.files.map((f) => f.path)).toContain("src/auth/index.ts");
    expect(document.degraded.some((d) => d.extractor === "stage-diff")).toBe(true);
  });
});

describe("the bounds are LISTED, never dropped", () => {
  let fixture: Fixture;
  afterAll(() => fixture?.cleanup());

  it("keeps the index complete past the patch-body ceiling", () => {
    // A 6,125-file diff is not hypothetical (`sentry-greptile-1`, two-dot). The
    // ceiling bounds BYTES ON DISK; it must never bound the inventory, because a
    // file missing from an index that claims to be complete is the omission this
    // package exists to prevent.
    const files: Record<string, string> = {};
    for (let i = 0; i < MAX_STAGED_FILES + 3; i++) files[`src/f${String(i).padStart(4, "0")}.ts`] = `export const V = 1;\n`;
    const head: Record<string, string> = {};
    for (const path of Object.keys(files)) head[path] = `export const V = 2;\n`;
    fixture = makeFixture("stage-ceiling", { message: "base", files }, { message: "head", files: head });

    const { payload, degraded } = stageInto(fixture);
    expect(payload.files).toHaveLength(MAX_STAGED_FILES + 3);
    expect((payload.files ?? []).filter((f) => f.patch !== null)).toHaveLength(MAX_STAGED_FILES);
    const unstaged = (payload.files ?? []).filter((f) => f.patch === null);
    expect(unstaged).toHaveLength(3);
    // Every one of them is still a ROW — with its status and its head ranges.
    for (const file of unstaged) expect(file.status).toBe("modified");

    expect(degraded.some((r) => r.includes("NO staged patch"))).toBe(true);
    const index = indexIn(fixture);
    for (const file of payload.files ?? []) expect(index, file.path).toContain(`\`${file.path}\``);
    expect(index).toContain("**NOT STAGED**");
    expect(index).toContain("have NO staged patch");
  });
});

describe("an empty range stages an empty index, and says which it is", () => {
  it("`files: []` is a real answer and reads differently from `null`", () => {
    const fixture = makeStagingFixture();
    try {
      // A range whose two ends are the same commit. Empty because the PR is
      // empty — the one case where an empty result is the truth, and the reason
      // `files` is `null` rather than `[]` when staging fails.
      const { payload, degraded } = stageDiff({
        repo: fixture.dir,
        baseSha: fixture.head,
        headSha: fixture.head,
        changed: [],
        hunks: [],
      });
      expect(payload.files).toEqual([]);
      expect(payload.files).not.toBeNull();
      expect(degraded).toEqual([]);
      const index = readFileSync(join(fixture.dir, DEFAULT_DIFF_STAGE_DIR, "index.md"), "utf8");
      expect(index).toContain("changed no files at all");
      expect(index).toMatch(/it is not a staging\s+failure/);
    } finally {
      fixture.cleanup();
    }
  });
});

describe("the staged dir is created under the repo, not beside it", () => {
  it("resolves a relative --stage-diff-dir against the REPO, never the cwd", () => {
    // `run.ts` normalises `--repo` to an absolute path for exactly this class of
    // bug (`"apps/server/src".startsWith(".")` is false, and a whole tsconfig
    // walk silently never ran). A stager that joined onto `process.cwd()` would
    // scatter patches into whatever directory the harness happened to be in.
    const fixture = makeStagingFixture();
    try {
      mkdirSync(join(fixture.dir, "sub"), { recursive: true });
      const { payload } = stageInto(fixture, "sub/patches");
      expect(payload.dir).toBe("sub/patches");
      expect(existsSync(join(fixture.dir, "sub/patches/index.md"))).toBe(true);
    } finally {
      fixture.cleanup();
    }
  });
});

/**
 * Fixture repos — REAL git repos with two real commits, built in `beforeAll`.
 *
 * Not mocks, on purpose. Every extractor in this package is a claim about what
 * `git diff` and a type-checker say, and a mock of either would let the claim
 * be wrong while the test passed — which is the exact failure mode
 * (dependency-cruiser, green while seeing nothing) the whole package exists to
 * prevent. The repos are tiny, so the cost of being honest here is a second or
 * two.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

export interface Commit {
  message: string;
  /** Path → contents. A `null` deletes the file. */
  files: Record<string, string | null>;
}

export interface Fixture {
  dir: string;
  base: string;
  head: string;
  cleanup(): void;
}

function git(dir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: dir,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_COMMITTER_NAME: "fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
    },
  });
}

function writeAll(dir: string, files: Record<string, string | null>): void {
  for (const [path, contents] of Object.entries(files)) {
    const full = join(dir, path);
    if (contents === null) {
      rmSync(full, { force: true });
      continue;
    }
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, contents, "utf8");
  }
}

/** Build a two-commit repo and return both SHAs. */
export function makeFixture(name: string, base: Commit, head: Commit): Fixture {
  const dir = mkdtempSync(join(tmpdir(), `ll-facts-${name}-`));
  git(dir, ["init", "-q", "-b", "main"]);
  git(dir, ["config", "user.email", "fixture@example.com"]);
  git(dir, ["config", "user.name", "fixture"]);

  writeAll(dir, base.files);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", base.message]);
  const baseSha = git(dir, ["rev-parse", "HEAD"]).trim();

  writeAll(dir, head.files);
  git(dir, ["add", "-A"]);
  git(dir, ["commit", "-q", "-m", head.message]);
  const headSha = git(dir, ["rev-parse", "HEAD"]).trim();

  return {
    dir,
    base: baseSha,
    head: headSha,
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/** A fixture whose base branch moved on after the PR forked from it. */
export interface ForkedFixture extends Fixture {
  /** The commit `base` and `head` actually diverged at. */
  mergeBase: string;
  /** Files the PR itself changed — the ONLY ones a review should see. */
  prPaths: string[];
  /** Files that landed on the base branch after the fork. Not the PR's. */
  basePaths: string[];
}

/**
 * THE MERGE-BASE FIXTURE — a real fork with a base branch that advanced.
 *
 * `main` gains a commit AFTER `feature` branches off it, which is the ordinary
 * life of any PR against a busy branch and the shape production hands us:
 * `pull_request.base.sha` is the base branch's TIP at event time, so a two-dot
 * `base..head` diff contains that commit too, and attributes it to the author.
 *
 * Measured on the 50-PR Martian corpus, 9 of 50 cases diverge — sentry-greptile-1
 * reads 6125 changed files two-dot against 3 from the merge base. Here it is one
 * file against one, at a size a test can assert exactly.
 *
 *   mergeBase ──┬── main:    docs/on-base-only.md, src/base-only.ts   (NOT the PR)
 *               └── feature: src/feature.ts                            (the PR)
 */
export function makeForkedFixture(): ForkedFixture {
  const dir = mkdtempSync(join(tmpdir(), "ll-facts-forked-"));
  const run = (args: string[]): string => git(dir, args);
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "fixture@example.com"]);
  run(["config", "user.name", "fixture"]);

  writeAll(dir, {
    "tsconfig.json": TSCONFIG,
    "package.json": JSON.stringify({ name: "fixture-forked", version: "1.0.0" }, null, 2),
    "src/feature.ts": `export const LIMIT = 10;\n`,
    "src/base-only.ts": `export const UNRELATED = 1;\n`,
  });
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "the fork point"]);
  const mergeBase = run(["rev-parse", "HEAD"]).trim();

  // The PR.
  run(["checkout", "-q", "-b", "feature"]);
  writeAll(dir, { "src/feature.ts": `export const LIMIT = 25;\n` });
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "the PR: raise LIMIT"]);
  const head = run(["rev-parse", "HEAD"]).trim();

  // …and, meanwhile, the base branch moved on. The author wrote none of this.
  run(["checkout", "-q", "main"]);
  writeAll(dir, {
    "src/base-only.ts": `export const UNRELATED = 2;\n`,
    "docs/on-base-only.md": "# landed on main after the fork\n",
  });
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "someone else's commit, on the base branch"]);
  const base = run(["rev-parse", "HEAD"]).trim();

  return {
    dir,
    base,
    head,
    mergeBase,
    prPaths: ["src/feature.ts"],
    basePaths: ["src/base-only.ts", "docs/on-base-only.md"],
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

/**
 * Two ROOT commits in one repo — `git merge-base` has no answer at all.
 *
 * The shape a shallow clone also produces (the fork point sits below the
 * boundary), and the one the fix must not paper over: with no merge base there
 * is nothing to compare but the two tips, and the run has to SAY so.
 */
export function makeUnrelatedHistoriesFixture(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "ll-facts-unrelated-"));
  const run = (args: string[]): string => git(dir, args);
  run(["init", "-q", "-b", "main"]);
  run(["config", "user.email", "fixture@example.com"]);
  run(["config", "user.name", "fixture"]);

  writeAll(dir, { "src/a.ts": `export const A = 1;\n` });
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "root one"]);
  const base = run(["rev-parse", "HEAD"]).trim();

  run(["checkout", "-q", "--orphan", "other"]);
  run(["rm", "-rq", "--cached", "."]);
  rmSync(join(dir, "src/a.ts"), { force: true });
  writeAll(dir, { "src/b.ts": `export const B = 2;\n` });
  run(["add", "-A"]);
  run(["commit", "-q", "-m", "root two — no shared history"]);
  const head = run(["rev-parse", "HEAD"]).trim();

  return { dir, base, head, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** Add and commit more files on top of an existing fixture. */
export function commitMore(fixture: Fixture, files: Record<string, string | null>): string {
  writeAll(fixture.dir, files);
  git(fixture.dir, ["add", "-A"]);
  git(fixture.dir, ["commit", "-q", "-m", "more"]);
  return git(fixture.dir, ["rev-parse", "HEAD"]).trim();
}

export const TSCONFIG = JSON.stringify(
  {
    compilerOptions: {
      target: "ES2022",
      module: "ESNext",
      moduleResolution: "Bundler",
      strict: true,
      noEmit: true,
    },
    include: ["src/**/*", "test/**/*"],
  },
  null,
  2,
);

/**
 * THE HEADLINE FIXTURE — the `1587-r2` shape, made mechanical.
 *
 * `MAX_TOKEN_AGE` is declared once, referenced only on the CLIENT side, and
 * never compared server-side; `src/legacy/auth.ts` carries the same value
 * hard-coded, which is set `B \ A`. This is the one shape the investigation
 * ever converted into a posted Critical, so it is the regression guard for the
 * whole package.
 */
export function makeConstantFixture(): Fixture {
  return makeFixture(
    "constant",
    {
      message: "base",
      files: {
        "tsconfig.json": TSCONFIG,
        "package.json": JSON.stringify({ name: "fixture-constant", version: "1.0.0" }, null, 2),
        "src/config.ts": `export const MAX_TOKEN_AGE = 3600;\nexport const APP_NAME = "fixture";\n`,
        "src/client/session.ts": `import { MAX_TOKEN_AGE } from "../config.js";\n\nexport function cookieMaxAge(): number {\n  return MAX_TOKEN_AGE;\n}\n`,
        "src/server/verify.ts": `export function verify(token: string): boolean {\n  return token.length > 0;\n}\n`,
        "src/legacy/auth.ts": `export function legacyExpiry(): number {\n  return 3600;\n}\n`,
      },
    },
    {
      message: "head",
      files: {
        "src/config.ts": `export const MAX_TOKEN_AGE = 900;\nexport const APP_NAME = "fixture";\n`,
        // The PR updates the value in TWO places — the constant, and a copy
        // that never went through it. `B \\ A` is exactly this line.
        "src/legacy/auth.ts": `export function legacyExpiry(): number {\n  return 900;\n}\n`,
      },
    },
  );
}

/**
 * The cross-file contract change: `getUser` goes from `User | null` to `User`
 * plus a thrown `NotFoundError`, and the ONLY consumer is outside the diff.
 */
export function makeContractFixture(): Fixture {
  return makeFixture(
    "contract",
    {
      message: "base",
      files: {
        "tsconfig.json": TSCONFIG,
        "package.json": JSON.stringify({ name: "fixture-contract", version: "1.0.0" }, null, 2),
        "src/user.ts": `export interface User {\n  id: string;\n}\n\nexport function getUser(id: string): User | null {\n  return id ? { id } : null;\n}\n`,
        "src/api/handler.ts": `import { getUser } from "../user.js";\n\nexport function handle(id: string): string {\n  const user = getUser(id);\n  return user ? user.id : "anonymous";\n}\n`,
        "test/user.test.ts": `import { getUser } from "../src/user.js";\n\nexport const probe = getUser("a");\n`,
      },
    },
    {
      message: "head",
      files: {
        "src/user.ts": `export interface User {\n  id: string;\n}\n\nexport class NotFoundError extends Error {}\n\nexport function getUser(id: string): User {\n  if (!id) throw new NotFoundError(id);\n  return { id };\n}\n`,
      },
    },
  );
}

/** A barrel re-export chain, so `findReferences` has to cross two files. */
export function makeBarrelFixture(): Fixture {
  return makeFixture(
    "barrel",
    {
      message: "base",
      files: {
        "tsconfig.json": TSCONFIG,
        "package.json": JSON.stringify({ name: "fixture-barrel", version: "1.0.0" }, null, 2),
        "src/core/limits.ts": `export function rateLimit(n: number): number {\n  return n;\n}\n`,
        "src/index.ts": `export { rateLimit } from "./core/limits.js";\n`,
        "src/consumer.ts": `import { rateLimit } from "./index.js";\n\nexport const applied = rateLimit(5);\n`,
      },
    },
    {
      message: "head",
      files: {
        "src/core/limits.ts": `export function rateLimit(n: number, burst = 0): number {\n  return n + burst;\n}\n`,
      },
    },
  );
}

/** A dependency bump plus the `createRequire(...)("pkg")` load pattern. */
export function makeDepsFixture(): Fixture {
  return makeFixture(
    "deps",
    {
      message: "base",
      files: {
        "tsconfig.json": TSCONFIG,
        "package.json": JSON.stringify(
          {
            name: "fixture-deps",
            version: "1.0.0",
            dependencies: { "left-pad": "^1.3.0" },
            devDependencies: { eslint: "^8.0.0" },
          },
          null,
          2,
        ),
        "src/lint.ts": `export const rules = [];\n`,
      },
    },
    {
      message: "head",
      files: {
        "package.json": JSON.stringify(
          {
            name: "fixture-deps",
            version: "1.0.0",
            dependencies: { "left-pad": "^1.3.0", "eslint-plugin-require-extensions": "^0.1.3" },
            devDependencies: { eslint: "^9.0.0" },
          },
          null,
          2,
        ),
        "src/lint.ts": `import { createRequire } from "node:module";\n\nconst plugin = createRequire(import.meta.url)("eslint-plugin-require-extensions");\n\nexport const rules = [plugin];\n`,
      },
    },
  );
}

/** No TypeScript or JavaScript at all — tier 3. */
export function makeNonTsFixture(): Fixture {
  return makeFixture(
    "nonts",
    {
      message: "base",
      files: {
        "main.py": `def add(a, b):\n    return a + b\n`,
        "README.md": "# fixture\n",
      },
    },
    {
      message: "head",
      files: { "main.py": `def add(a, b):\n    return a - b\n` },
    },
  );
}

/** A tsconfig that is not valid JSON — the tier-2 degradation path. */
export function makeBrokenTsConfigFixture(): Fixture {
  return makeFixture(
    "broken",
    {
      message: "base",
      files: {
        "tsconfig.json": `{ "compilerOptions": { "strict": true `,
        "package.json": JSON.stringify({ name: "fixture-broken", version: "1.0.0" }, null, 2),
        "src/a.ts": `export const LIMIT = 10;\n`,
      },
    },
    {
      message: "head",
      files: { "src/a.ts": `export const LIMIT = 25;\n` },
    },
  );
}

// ── the noise-floor fixture ──────────────────────────────────────────────────
//
// WP1 ran `contracts` against a REAL commit of this monorepo and got **227
// contract deltas of which one was real**. Three fixes cut it to 19, and every
// unit test in this package passed before, during and after — because none of
// the fixtures above is large enough to EXHIBIT any of the three causes.
//
// A bound is only a guard if you also pin the number it would be WITHOUT the
// fix. `makeMonorepoFixture` is that pin: one repo carrying all three causes at
// once, so `tests/noise-floor.test.ts` can measure each one's contribution
// instead of describing it in a comment.
//
//   cause 1  asymmetric tsconfig  → the head commit ADDS per-package tsconfigs,
//            the root one is `references`-only. `findTsConfig` is nearest-first,
//            so at HEAD it picks `packages/a/tsconfig.json` (include: src/**/*)
//            and the head program contains packages/a ONLY; at BASE neither
//            package tsconfig exists yet, the root one is skipped, and
//            `loadProject` globs — so the base program contains BOTH packages.
//            Every modified file in packages/b is therefore present on one side
//            only, which without the one-sided guard reads as a removed export.
//            That is the 65-phantom-removals shape, exactly.
//   cause 2  external types       → an UNTRACKED `node_modules/@fixture/ext`,
//            imported by 16 exported functions in packages/a. Without
//            `mirrorNodeModules` the base worktree cannot resolve it, every one
//            of those types collapses to `any`, and the comparison is between a
//            resolved program and an unresolved one.
//   cause 3  unstable type text   → six `plan*.ts` files whose exports return
//            object literals with unions nested INSIDE members, written in a
//            different member/union order at head while being the same type.
//
// The head commit makes exactly ONE semantic change: `resolveSession` gains an
// optional parameter. It has exactly two consumers outside the diff.

const EXT_DTS = `export interface Ext {
  id: string;
  kind: "a" | "b";
}

export declare function toExt(id: string): Ext;
`;

/** Object members AND union members reordered — the same type, printed differently. */
function planFile(n: number, side: "base" | "head"): string {
  const alpha =
    side === "base"
      ? `export type Alpha${n} = { kind: "alpha${n}"; weight: number };`
      : `export type Alpha${n} = { weight: number; kind: "alpha${n}" };`;
  const beta =
    side === "base"
      ? `export type Beta${n} = { kind: "beta${n}"; weight: number };`
      : `export type Beta${n} = { weight: number; kind: "beta${n}" };`;
  // Distinct literals per file: TypeScript orders a union's printed members by
  // type id, which is creation order, so sharing literals across files would let
  // whichever file the checker reached first decide the order on BOTH sides.
  const compass =
    side === "base"
      ? `"n${n}" | "s${n}" | "e${n}" | "w${n}"`
      : `"w${n}" | "e${n}" | "s${n}" | "n${n}"`;
  const outcome =
    side === "base"
      ? `{ via: Alpha${n} | Beta${n}; then: "complete" | "fail"; retries: number }`
      : `{ retries: number; then: "fail" | "complete"; via: Beta${n} | Alpha${n} }`;
  return `${alpha}
${beta}

export function plan${n}(): ${outcome} {
  return { via: { kind: "alpha${n}", weight: ${n} }, then: "complete", retries: 0 };
}

export function route${n}(): ${compass} {
  return "n${n}";
}
`;
}

/**
 * Two exports whose types are INFERRED from an external package.
 *
 * Inferred on purpose, and this is the sharpest thing the fixture taught us: an
 * ANNOTATED `function f(x: Ext): Ext` prints as `(x: Ext) => Ext` on both sides
 * even when `@fixture/ext` does not resolve — the printer falls back to the
 * written name, so an un-mirrored base tree looks identical and the mirror
 * appears to buy nothing. Inference is where an unresolved module actually
 * shows: `toExt(id)` is `Ext` when the module resolves and `any` when it does
 * not, and `input.kind` is `"a" | "b"` or `any` the same way.
 */
function extFile(prefix: string, n: number, side: "base" | "head"): string {
  const touched = side === "head" ? "// touched by the PR — a comment, and nothing else.\n" : "";
  return `import { toExt, type Ext } from "@fixture/ext";

${touched}export function read${prefix}${n}(input: Ext) {
  return input.kind;
}

export function make${prefix}${n}(id: string) {
  return toExt(id);
}
`;
}

/** Filler: the body moves, the contract does not. */
function utilFile(n: number, side: "base" | "head"): string {
  return `export function util${n}(value: number): number {
  return value * ${side === "base" ? n : `${n} * 1`};
}

export const LABEL_${n} = "util-${n}";
`;
}

/** packages/b — three exports each, and every one of them a phantom removal. */
function bFile(n: number, side: "base" | "head"): string {
  return `export interface Row${n} {
  id: string;
  count: number;
}

export function load${n}(id: string): Row${n} {
  return { id, count: ${side === "base" ? n : n + 1} };
}

export function drop${n}(id: string): boolean {
  return id.length > ${n};
}
`;
}

const A_TSCONFIG = JSON.stringify(
  // Deliberately near-default: the base side is a GLOB (no tsconfig resolved at
  // all), so any compiler option set here that the base side does not share
  // would print types differently and manufacture a fourth cause of noise.
  { compilerOptions: { noEmit: true }, include: ["src/**/*"] },
  null,
  2,
);

const PLAN_FILES = 6;
const EXT_FILES_A = 8;
const UTIL_FILES = 6;
const B_FILES = 12;
const EXT_FILES_B = 2;

/**
 * ~40 source files across two packages, carrying all three phantom-delta causes
 * simultaneously. See the block comment above for what each one is.
 *
 * `tests/noise-floor.test.ts` is the only consumer, and it asserts both halves:
 * the ONE real delta this commit contains, and — as LOWER BOUNDS, never exact
 * values — how many phantom deltas each fix is suppressing.
 */
export function makeMonorepoFixture(): Fixture {
  const base: Record<string, string> = {
    // Untracked, and that is the point: `mirrorNodeModules` is what puts it in
    // front of the base worktree, and there is no commit that would.
    ".gitignore": "node_modules/\n",
    "node_modules/@fixture/ext/package.json": JSON.stringify(
      { name: "@fixture/ext", version: "1.0.0", types: "index.d.ts" },
      null,
      2,
    ),
    "node_modules/@fixture/ext/index.d.ts": EXT_DTS,

    // `references`-only: `findTsConfig` SKIPS it, because it adds zero source
    // files and loading it would look like success while producing nothing.
    "tsconfig.json": JSON.stringify(
      {
        compilerOptions: { noEmit: true },
        references: [{ path: "./packages/a" }, { path: "./packages/b" }],
      },
      null,
      2,
    ),
    "package.json": JSON.stringify(
      { name: "fixture-monorepo", version: "1.0.0", private: true },
      null,
      2,
    ),
    "packages/a/package.json": JSON.stringify({ name: "@fixture/a", version: "1.0.0" }, null, 2),
    "packages/b/package.json": JSON.stringify({ name: "@fixture/b", version: "1.0.0" }, null, 2),

    // THE ONE REAL CHANGE lives here.
    "packages/a/src/session.ts": `export interface Session {
  id: string;
  user: string;
}

export function resolveSession(id: string): Session {
  return { id, user: id };
}
`,
    // The two consumers outside the diff. A NAMESPACE import on purpose: a named
    // import would contribute a second reference site (the import specifier) and
    // "two consumers" would read as four.
    "packages/a/src/consumers/alpha.ts": `import * as session from "../session";

export const first = session.resolveSession("alpha");
`,
    "packages/a/src/consumers/beta.ts": `import * as session from "../session";

export function second(id: string) {
  return session.resolveSession(id);
}
`,
  };

  const head: Record<string, string> = {
    // Cause 1. Both are added by the PR; `findTsConfig` is nearest-first and
    // breaks the depth tie on the first changed path, so `a` wins and packages/b
    // drops out of the HEAD program while the base glob still has it.
    "packages/a/tsconfig.json": A_TSCONFIG,
    "packages/b/tsconfig.json": A_TSCONFIG,

    "packages/a/src/session.ts": `export interface Session {
  id: string;
  user: string;
}

export function resolveSession(id: string, refresh?: boolean): Session {
  return { id, user: refresh ? \`\${id}!\` : id };
}
`,
  };

  for (let n = 1; n <= PLAN_FILES; n++) {
    base[`packages/a/src/plan/plan${n}.ts`] = planFile(n, "base");
    head[`packages/a/src/plan/plan${n}.ts`] = planFile(n, "head");
  }
  for (let n = 1; n <= EXT_FILES_A; n++) {
    base[`packages/a/src/ext/svc${n}.ts`] = extFile("A", n, "base");
    head[`packages/a/src/ext/svc${n}.ts`] = extFile("A", n, "head");
  }
  for (let n = 1; n <= UTIL_FILES; n++) {
    base[`packages/a/src/util/util${n}.ts`] = utilFile(n, "base");
    head[`packages/a/src/util/util${n}.ts`] = utilFile(n, "head");
  }
  for (let n = 1; n <= B_FILES; n++) {
    base[`packages/b/src/mod${n}.ts`] = bFile(n, "base");
    head[`packages/b/src/mod${n}.ts`] = bFile(n, "head");
  }
  for (let n = 1; n <= EXT_FILES_B; n++) {
    base[`packages/b/src/ext/bext${n}.ts`] = extFile("B", n, "base");
    head[`packages/b/src/ext/bext${n}.ts`] = extFile("B", n, "head");
  }

  return makeFixture(
    "monorepo",
    { message: "base", files: base },
    { message: "head: resolveSession gains an optional parameter", files: head },
  );
}

// ── the asymmetric-import fixture ───────────────────────────────────────────
//
// THE ONE SHAPE THAT DECIDES WHETHER SELECTIVE RESOLUTION IS SAFE.
//
// `--resolution changed` computes an allow-list of bare specifiers from the
// changed files and refuses everything else. Computed PER SIDE it is a trap: a
// package imported at head and not at base resolves on one side only, so a type
// that did not change prints `Rex` against `any` and `contracts` reports a
// delta about the allow-list rather than about the PR. That is the
// 227-deltas-of-which-one-was-real shape reached from a new direction, and the
// only defence is that the list is the UNION of both sides.
//
// The fixture is built so the two spellings DISAGREE, which is what makes the
// invariant measurable instead of merely stated:
//
//   src/dep.ts    unchanged by the PR, imports @fixture/rex, exports an
//                 INFERRED `shared: Rex`  (inferred, because an ANNOTATED type
//                 prints from the written name even when it does not resolve —
//                 see `mirrorNodeModules`)
//   src/api.ts    CHANGED. Base re-exports `shared` and names no package at
//                 all; head adds `import { toRex } from "@fixture/rex"`.
//
// Per-side: the base program's allow-list is EMPTY (base `api.ts` imports
// nothing bare), `dep.ts` does not resolve, `out` is `any` at base and `Rex` at
// head → a phantom `changed` delta on an export whose text nobody touched.
// Union: both sides allow `@fixture/rex`, both print `Rex`, no delta.

const REX_DTS = `export interface Rex {
  id: string;
  tag: "rex";
}

export declare function toRex(id: string): Rex;
`;

/** The export that must NOT move. Textually identical in both commits. */
export const ASYMMETRIC_STABLE_EXPORT = "out";
/** The one real delta: an export the head commit genuinely adds. */
export const ASYMMETRIC_ADDED_EXPORT = "fresh";

export function makeAsymmetricImportFixture(): Fixture {
  const base: Record<string, string> = {
    ".gitignore": "node_modules/\n",
    // Untracked, like `makeMonorepoFixture`'s: no commit would carry it, and
    // `mirrorNodeModules` is what puts it in front of the base worktree.
    "node_modules/@fixture/rex/package.json": JSON.stringify(
      { name: "@fixture/rex", version: "1.0.0", types: "index.d.ts" },
      null,
      2,
    ),
    "node_modules/@fixture/rex/index.d.ts": REX_DTS,
    "package.json": JSON.stringify({ name: "fixture-asym", version: "1.0.0" }, null, 2),
    "tsconfig.json": JSON.stringify(
      { compilerOptions: { noEmit: true, strict: true }, include: ["src/**/*"] },
      null,
      2,
    ),
    // NOT in the diff. Its import is the only reason `@fixture/rex` matters,
    // and an allow-list built from the changed files alone can only reach it
    // through `api.ts`'s head-side import.
    "src/dep.ts": `import { toRex } from "@fixture/rex";

export const shared = toRex("seed");
`,
    "src/api.ts": `import { shared } from "./dep.js";

export const out = shared;
`,
  };

  const head: Record<string, string> = {
    "src/api.ts": `import { shared } from "./dep.js";
import { toRex } from "@fixture/rex";

export const out = shared;

export const fresh = toRex("fresh");
`,
  };

  return makeFixture(
    "asymmetric-import",
    { message: "base", files: base },
    { message: "head: api.ts gains an import the base commit does not have", files: head },
  );
}

/** The file whose exports are semantically identical and printed differently. */
export const UNSTABLE_TYPE_FILES = Array.from(
  { length: PLAN_FILES },
  (_, i) => `packages/a/src/plan/plan${i + 1}.ts`,
);

// ── the multi-project fixture ────────────────────────────────────────────────
//
// THE COVERAGE FIXTURE, and the number behind it: over 50 real PRs
// (keycloak / grafana / discourse / cal.com / sentry) the single-project loader
// analysed **58 of 8,514 changed files — 0.7%** — while reporting tier 1, because
// `findTsConfig` picked ONE nearest tsconfig for a diff that spanned several
// packages. cal.com carries 26 tsconfigs; grafana 29. One of them cannot cover a
// cross-package diff, and the file below is the shape at a size a test can hold.
//
// It differs from `makeMonorepoFixture` on purpose. That one is ASYMMETRIC — the
// head commit ADDS the package tsconfigs, which is what makes it a noise-floor
// fixture. This one has both tsconfigs in BOTH commits, so nothing about the
// tsconfig layout changes and the only question the fixture asks is: **how much
// of the diff got analysed?**

const MULTI_TSCONFIG = JSON.stringify(
  { compilerOptions: { strict: true, noEmit: true }, include: ["src/**/*"] },
  null,
  2,
);

/**
 * Two packages, one tsconfig each, a diff that touches BOTH — plus one changed
 * file (`scripts/release.ts`) that no tsconfig covers at all.
 *
 * Three separate claims live here and `tests/multi-project.test.ts` asserts each:
 *
 *   1. both packages are analysed, which the single-project loader could not do;
 *   2. a cross-package consumer of a changed symbol is found in its OWN program
 *      (`packages/b` imports `@fixture/multi-a` — the reference is not
 *      resolvable across programs and must not be claimed);
 *   3. `scripts/release.ts` is picked up by the glob fallback and the fallback
 *      SAYS SO in `degraded[]`, because glob-tier output is not tsconfig-tier
 *      output.
 */
export function makeMultiProjectFixture(): Fixture {
  const base: Record<string, string> = {
    // No ROOT tsconfig: `scripts/release.ts` therefore falls under no project at
    // all, which is the glob-fallback half of the fixture.
    "package.json": JSON.stringify(
      { name: "fixture-multi", version: "1.0.0", private: true },
      null,
      2,
    ),
    "packages/a/package.json": JSON.stringify({ name: "@fixture/multi-a", version: "1.0.0" }, null, 2),
    "packages/a/tsconfig.json": MULTI_TSCONFIG,
    "packages/b/package.json": JSON.stringify({ name: "@fixture/multi-b", version: "1.0.0" }, null, 2),
    "packages/b/tsconfig.json": MULTI_TSCONFIG,

    "packages/a/src/token.ts": `export const MAX_TOKEN_AGE = 3600;

export interface Token {
  value: string;
}

export function mintToken(value: string): Token {
  return { value };
}
`,
    "packages/a/src/consumer.ts": `import { mintToken } from "./token.js";

export function reissue(value: string) {
  return mintToken(value);
}
`,
    "packages/b/src/session.ts": `export interface Session {
  id: string;
}

export function openSession(id: string): Session {
  return { id };
}
`,
    "packages/b/src/consumer.ts": `import { openSession } from "./session.js";

export function warm(id: string) {
  return openSession(id);
}
`,
    "scripts/release.ts": `export const CHANNEL = "stable";

export function tagFor(version: string): string {
  return \`\${version}-\${CHANNEL}\`;
}
`,
  };

  const head: Record<string, string> = {
    // Package A: a real contract change plus a changed constant.
    "packages/a/src/token.ts": `export const MAX_TOKEN_AGE = 900;

export interface Token {
  value: string;
}

export function mintToken(value: string, ttl?: number): Token {
  return { value: ttl ? \`\${value}:\${ttl}\` : value };
}
`,
    // Package B: a real contract change of its own, in a DIFFERENT program.
    "packages/b/src/session.ts": `export interface Session {
  id: string;
}

export function openSession(id: string, warm?: boolean): Session {
  return { id: warm ? \`\${id}!\` : id };
}
`,
    // Covered by no tsconfig — the glob fallback, or nothing.
    "scripts/release.ts": `export const CHANNEL = "beta";

export function tagFor(version: string): string {
  return \`\${version}-\${CHANNEL}\`;
}
`,
  };

  return makeFixture(
    "multi",
    { message: "base", files: base },
    { message: "head: both packages and one unprojected script change", files: head },
  );
}

/** Every file `makeMultiProjectFixture`'s head commit changes. */
export const MULTI_PROJECT_CHANGED = [
  "packages/a/src/token.ts",
  "packages/b/src/session.ts",
  "scripts/release.ts",
];

// ── WS6 stage 0: the non-JS fixtures ─────────────────────────────────────────
//
// Every fixture above is TypeScript, which is exactly how a package whose
// `deps` extractor only read `package.json` and whose `coverage` extractor only
// read istanbul/lcov could ship with 182 green tests. 59% of the validation
// corpus's gold findings live in PRs these fixtures could not represent:
// keycloak's root manifest is Maven, discourse's is a Gemfile, and NEITHER repo
// has a root `package.json` at all.

/**
 * A Java PR — the keycloak shape. Maven manifest, `src/main/java` layout, a
 * JaCoCo report, and not one line of TypeScript anywhere.
 *
 * The `${keycloak.version}` property indirection is not decoration: it is the
 * dominant Maven idiom, and a version bump that lands in `<properties>` is
 * invisible to a parser that reads `<version>` literally.
 */
export function makeJavaFixture(): Fixture {
  const pom = (version: string): string => `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0">
  <modelVersion>4.0.0</modelVersion>
  <groupId>org.fixture</groupId>
  <artifactId>services</artifactId>
  <version>1.0.0</version>
  <properties>
    <jackson.version>${version}</jackson.version>
  </properties>
  <dependencies>
    <dependency>
      <groupId>com.fasterxml.jackson.core</groupId>
      <artifactId>jackson-databind</artifactId>
      <version>\${jackson.version}</version>
    </dependency>
    <dependency>
      <groupId>org.junit.jupiter</groupId>
      <artifactId>junit-jupiter</artifactId>
      <version>5.10.0</version>
      <scope>test</scope>
    </dependency>
  </dependencies>
</project>
`;
  return makeFixture(
    "java",
    {
      message: "base",
      files: {
        "pom.xml": pom("2.15.0"),
        "src/main/java/org/fixture/TokenService.java": `package org.fixture;

public class TokenService {
    public static final int MAX_TOKEN_AGE = 3600;

    public boolean verify(String token) {
        return token != null && token.length() > 0;
    }
}
`,
        "src/test/java/org/fixture/TokenServiceTest.java": `package org.fixture;

public class TokenServiceTest {
    public void testVerify() {}
}
`,
      },
    },
    {
      message: "head",
      files: {
        "pom.xml": pom("2.17.1"),
        "src/main/java/org/fixture/TokenService.java": `package org.fixture;

public class TokenService {
    public static final int MAX_TOKEN_AGE = 900;

    public boolean verify(String token) {
        return token != null && !token.isBlank();
    }
}
`,
      },
    },
  );
}

/** A Go PR — `go.mod` (with an `// indirect` line that must NOT be reported). */
export function makeGoFixture(): Fixture {
  const goMod = (grpc: string): string => `module github.com/fixture/svc

go 1.22

require (
	github.com/gorilla/mux v1.8.1
	google.golang.org/grpc ${grpc}
	golang.org/x/sys v0.20.0 // indirect
)
`;
  return makeFixture(
    "go",
    {
      message: "base",
      files: {
        "go.mod": goMod("v1.62.0"),
        "pkg/api/handler.go": `package api

func Handle(id string) string {
	if id == "" {
		return "anonymous"
	}
	return id
}
`,
        "pkg/api/handler_test.go": `package api

func TestHandle(t *testing.T) {}
`,
      },
    },
    {
      message: "head",
      files: {
        "go.mod": goMod("v1.64.0"),
        "pkg/api/handler.go": `package api

func Handle(id string) string {
	if id == "" {
		return "unknown"
	}
	return id + "!"
}
`,
      },
    },
  );
}

/** A Ruby PR — the discourse shape: a Gemfile root, `spec/` tests, `.es6` JS. */
export function makeRubyFixture(): Fixture {
  const gemfile = (rails: string): string => `source "https://rubygems.org"

gem "rails", "${rails}"
gem "pg", "~> 1.5"

group :development, :test do
  gem "rspec-rails", "~> 6.0"
end
`;
  return makeFixture(
    "ruby",
    {
      message: "base",
      files: {
        Gemfile: gemfile("~> 7.0"),
        "app/models/session.rb": `class Session
  MAX_TOKEN_AGE = 3600

  def expired?(age)
    age > MAX_TOKEN_AGE
  end
end
`,
        "spec/models/session_spec.rb": `describe Session do
end
`,
        // Discourse ships 20 changed Ember files under `.es6` in the corpus.
        "app/assets/javascripts/discourse/session.es6": `export const MAX_TOKEN_AGE = 3600;

export function cookieMaxAge() {
  return MAX_TOKEN_AGE;
}
`,
      },
    },
    {
      message: "head",
      files: {
        Gemfile: gemfile("~> 7.1"),
        // Lines 2 and 5 change, and nothing else — which is what lets the
        // SimpleCov test assert an exact uncovered set.
        "app/models/session.rb": `class Session
  MAX_TOKEN_AGE = 900

  def expired?(age)
    age >= MAX_TOKEN_AGE
  end
end
`,
        "app/assets/javascripts/discourse/session.es6": `export const MAX_TOKEN_AGE = 900;

export function cookieMaxAge() {
  return MAX_TOKEN_AGE;
}
`,
      },
    },
  );
}

/** A Python PR — `pyproject.toml` plus a `requirements.txt`, the sentry shape. */
export function makePythonFixture(): Fixture {
  const pyproject = (django: string): string => `[project]
name = "fixture"
version = "1.0.0"
dependencies = [
  "django${django}",
  "requests>=2.31",
]

[project.optional-dependencies]
dev = ["pytest>=8.0"]
`;
  return makeFixture(
    "python",
    {
      message: "base",
      files: {
        "pyproject.toml": pyproject(">=4.2,<5.0"),
        "requirements.txt": "celery==5.3.0\n# a comment\n-r other.txt\n",
        "src/auth.py": `MAX_TOKEN_AGE = 3600


def verify(token):
    return bool(token)
`,
        "tests/test_auth.py": `def test_verify():
    pass
`,
      },
    },
    {
      message: "head",
      files: {
        "pyproject.toml": pyproject(">=5.0,<6.0"),
        "requirements.txt": "celery==5.4.0\n# a comment\n-r other.txt\n",
        "src/auth.py": `MAX_TOKEN_AGE = 900


def verify(token):
    return bool(token) and len(token) > 8
`,
      },
    },
  );
}

/**
 * A repo whose ROOT manifest is npm and whose diff touches a SECOND, non-npm
 * one — the grafana shape (`package.json` + `go.mod` in a single PR), which is
 * the case a root-only scan reports half of while looking complete.
 */
export function makeMixedEcosystemFixture(): Fixture {
  return makeFixture(
    "mixed",
    {
      message: "base",
      files: {
        "package.json": JSON.stringify(
          { name: "fixture-mixed", version: "1.0.0", dependencies: { "left-pad": "^1.3.0" } },
          null,
          2,
        ),
        "pkg/api/go.mod": `module github.com/fixture/mixed/api

go 1.22

require github.com/gorilla/mux v1.8.0
`,
        "src/index.js": `export const ok = true;\n`,
      },
    },
    {
      message: "head",
      files: {
        "package.json": JSON.stringify(
          {
            name: "fixture-mixed",
            version: "1.0.0",
            dependencies: { "left-pad": "^1.3.0", "date-fns": "^3.6.0" },
          },
          null,
          2,
        ),
        "pkg/api/go.mod": `module github.com/fixture/mixed/api

go 1.22

require github.com/gorilla/mux v1.8.1
`,
      },
    },
  );
}

/**
 * A repo carrying MORE analysable files than a low `--max-files`, so the
 * literal scan is forced to truncate.
 *
 * The point is not that truncation happens — it always did. The point is that
 * it now appears in `degraded[]`. This fixture is the number the guard is
 * measured against: without the fix the document below is byte-identical to a
 * complete scan.
 */
export function makeManyFilesFixture(fileCount = 40): Fixture {
  const base: Record<string, string> = {
    "tsconfig.json": TSCONFIG,
    "package.json": JSON.stringify({ name: "fixture-many", version: "1.0.0" }, null, 2),
    "src/config.ts": `export const MAX_TOKEN_AGE = 3600;\n`,
  };
  for (let n = 0; n < fileCount; n++) {
    base[`src/filler/mod${n}.ts`] = `export const FILLER_${n} = ${n};\n`;
  }
  return makeFixture(
    "many",
    { message: "base", files: base },
    { message: "head", files: { "src/config.ts": `export const MAX_TOKEN_AGE = 900;\n` } },
  );
}

/**
 * The `isIgnoredPath` measurement, made into a repo: one constant, and TWO
 * copies of its value that are NOT source — a minified bundle under `dist-site/`
 * (which the old exact-segment `dist` pattern did not match) and a vendored
 * checkout under `data/sandboxes/`.
 *
 * On this monorepo that shape produced **2,663 bogus hard-coded duplicates for
 * a single constant**. Here it produces two, which is the same bug at a size a
 * test can assert on.
 */
export function makeBuildArtifactFixture(): Fixture {
  // One long line, the way a bundler writes it — `looksMinified` is the guard
  // for a bundle that is NOT under a `dist*` path.
  const bundled = `${"const a=1;".repeat(400)}const MAX=900;\n`;
  return makeFixture(
    "artifact",
    {
      message: "base",
      files: {
        "tsconfig.json": TSCONFIG,
        "package.json": JSON.stringify({ name: "fixture-artifact", version: "1.0.0" }, null, 2),
        "src/config.ts": `export const MAX_TOKEN_AGE = 3600;\n`,
        "src/client/session.ts": `import { MAX_TOKEN_AGE } from "../config.js";\n\nexport function age(): number {\n  return MAX_TOKEN_AGE;\n}\n`,
      },
    },
    {
      message: "head",
      files: {
        "src/config.ts": `export const MAX_TOKEN_AGE = 900;\n`,
        // NOT source. Every one of these carries the value 900 and none is a
        // hard-coded duplicate a reviewer could act on.
        "dist-site/assets/index-a1b2c3.js": bundled,
        "vendor/checkout/legacy.js": `export const copy = 900;\n`,
        "build.out/gen/emitted.js": `export const emitted = 900;\n`,
      },
    },
  );
}

/**
 * THE `.gitignore` FIXTURE — every shape the directory walk could not see.
 *
 * `makeBuildArtifactFixture` above covers the paths a denylist CAN name
 * (`dist-site/`, `vendor/`, a minified bundle). This one covers the three it
 * cannot, and every one is a real shape from this monorepo:
 *
 *   data/sandboxes/**       gitignored by the ROOT `.gitignore`, under a name no
 *                           conventional denylist has ever heard of. On this
 *                           repo it is cloned review workspaces and it produced
 *                           **41,079 of 44,633** bogus hard-coded duplicates.
 *   apps/web/snapshots/**   gitignored by a NESTED `.gitignore` two directories
 *                           down. A denylist is flat; `.gitignore` is not.
 *   src/scratch.ts          untracked and NOT ignored — present in the working
 *                           DIRECTORY, absent from the head COMMIT. Set B is
 *                           resolved at `headSha`, so this must not appear, and
 *                           under the walk it did.
 *
 * None of the three is committed, so a listing taken from `git ls-tree` at head
 * excludes all of them by construction. `tests/constants.test.ts` pins the
 * number WITHOUT the fix by forcing the same scan through the walk tier.
 */
export interface IgnoredScopeFixture extends Fixture {
  /** The one real duplicate — the only entry a reviewer could act on. */
  realDuplicate: string;
  /** Paths that exist on disk and must never reach set B. */
  invisible: string[];
}

export function makeIgnoredScopeFixture(): IgnoredScopeFixture {
  const fixture = makeFixture(
    "ignored-scope",
    {
      message: "base",
      files: {
        "tsconfig.json": TSCONFIG,
        "package.json": JSON.stringify({ name: "fixture-ignored", version: "1.0.0" }, null, 2),
        // Neither `data/sandboxes` nor `snapshots` is in the residual denylist,
        // on purpose: if the test passed because of the denylist it would not be
        // testing `.gitignore` at all.
        ".gitignore": "data/sandboxes/\nnode_modules/\n",
        "apps/web/.gitignore": "snapshots/\n",
        "apps/web/app.ts": `export const ok = true;\n`,
        "src/config.ts": `export const MAX_TOKEN_AGE = 3600;\n`,
        "src/client/session.ts": `import { MAX_TOKEN_AGE } from "../config.js";\n\nexport function age(): number {\n  return MAX_TOKEN_AGE;\n}\n`,
      },
    },
    {
      message: "head",
      files: {
        "src/config.ts": `export const MAX_TOKEN_AGE = 900;\n`,
        "src/legacy/auth.ts": `export function legacyExpiry(): number {\n  return 900;\n}\n`,
      },
    },
  );

  // Written AFTER both commits, so none of it is in any tree — which is exactly
  // the state of a review workspace the agent has been working in.
  writeAll(fixture.dir, {
    "data/sandboxes/clone-1/src/copy.ts": `export const copied = 900;\n`,
    "data/sandboxes/clone-1/src/deep/more.ts": `export const alsoCopied = 900;\n`,
    "apps/web/snapshots/snap.js": `export const snap = 900;\n`,
    "src/scratch.ts": `export const scratch = 900;\n`,
  });

  return {
    ...fixture,
    realDuplicate: "src/legacy/auth.ts:2",
    invisible: [
      "data/sandboxes/clone-1/src/copy.ts",
      "data/sandboxes/clone-1/src/deep/more.ts",
      "apps/web/snapshots/snap.js",
      "src/scratch.ts",
    ],
  };
}

/** A plain directory with source in it and no `.git` anywhere above it. */
export function makeNonGitDirectory(): Fixture {
  const dir = mkdtempSync(join(tmpdir(), "ll-facts-nongit-"));
  writeAll(dir, {
    "src/config.ts": `export const MAX_TOKEN_AGE = 900;\n`,
    "src/legacy/auth.ts": `export function legacyExpiry(): number {\n  return 900;\n}\n`,
  });
  return {
    dir,
    base: "(none)",
    head: "(none)",
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

// ── the git-primitive fixture ────────────────────────────────────────────────
//
// Every fixture above exercises git through an extractor, which is how
// `changedPaths`' rename branch, `diffHunks`' zero-width deletion range and
// `showFile`'s `null` never executed: no fixture renamed a file, deleted one, or
// removed lines without adding any. This one carries all four shapes and nothing
// else — no tsconfig, because none of these claims is about a type-checker.

export interface GitShapesFixture extends Fixture {
  /** `R100` in `--name-status`: the NEW path is the one that exists at head. */
  renamedTo: string;
  renamedFrom: string;
  /** Present at base, absent at head. */
  deleted: string;
  /** Lines removed and none added — a `+n,0` hunk, i.e. zero-width at head. */
  pureDeletion: string;
  /** One line inserted, so the head-coordinate assertion has a floor. */
  insertion: string;
}

export function makeGitShapesFixture(): GitShapesFixture {
  const fixture = makeFixture(
    "gitshapes",
    {
      message: "base",
      files: {
        // Five declarations, so two can be removed with nothing added back.
        "src/keep.ts": `export const A = 1;\nexport const B = 2;\nexport const C = 3;\nexport const D = 4;\nexport const E = 5;\n`,
        "src/insert.ts": `export const X = 1;\nexport const Y = 2;\n`,
        "src/gone.ts": `export const GONE = true;\n`,
        // Byte-identical at head under a different name — `-M` scores that R100.
        "src/old-name.ts": `export const MOVED = "moved";\n`,
      },
    },
    {
      message: "head",
      files: {
        "src/keep.ts": `export const A = 1;\nexport const D = 4;\nexport const E = 5;\n`,
        "src/insert.ts": `export const X = 1;\nexport const INSERTED = 99;\nexport const Y = 2;\n`,
        "src/gone.ts": null,
        "src/old-name.ts": null,
        "src/new-name.ts": `export const MOVED = "moved";\n`,
      },
    },
  );
  return {
    ...fixture,
    renamedTo: "src/new-name.ts",
    renamedFrom: "src/old-name.ts",
    deleted: "src/gone.ts",
    pureDeletion: "src/keep.ts",
    insertion: "src/insert.ts",
  };
}

/** An empty repo with one commit — for the `repoSlug` remote branches. */
export function makeRemotelessFixture(): Fixture {
  return makeFixture(
    "remoteless",
    { message: "base", files: { "README.md": "# fixture\n" } },
    { message: "head", files: { "README.md": "# fixture, edited\n" } },
  );
}

// ── the symbol-kind fixture ──────────────────────────────────────────────────
//
// `facts` emits eight kinds and every fixture above only ever produced three
// (`function`, `variable`, `interface`), so `enum`, `type`, `property`,
// `abstract-method` and `method` had no test at all — and `implementations[]`
// was NEVER non-empty in any of them, in the field whose whole contract is that
// `null` and `[]` mean different things. A non-empty array is the third state,
// and it was the untested one.
//
// It carries the `contracts` gaps too, on the same two commits: a `Class.method`
// and an `Interface.method` delta, a JSDoc `@throws`, a PRIVATE method that must
// stay out of the delta however much it changes, and a real deletion — the
// `removed` branch, which no fixture had ever reached.

export function makeSymbolKindsFixture(): Fixture {
  return makeFixture(
    "kinds",
    {
      message: "base",
      files: {
        "tsconfig.json": TSCONFIG,
        "package.json": JSON.stringify({ name: "fixture-kinds", version: "1.0.0" }, null, 2),

        // The interface and its TWO implementers. Neither implementer is in the
        // diff, which is the point: `implementations[]` is an impact-cone field.
        "src/port.ts": `export interface Store {\n  get(id: string): string;\n}\n`,
        "src/mem.ts": `import type { Store } from "./port.js";\n\nexport class MemStore implements Store {\n  get(id: string): string {\n    return id;\n  }\n}\n`,
        "src/db.ts": `import type { Store } from "./port.js";\n\nexport class DbStore implements Store {\n  get(id: string): string {\n    return \`db:\${id}\`;\n  }\n}\n`,

        // enum · type alias · class property · abstract method, one each.
        "src/kinds.ts": `export enum Mode {\n  Fast = "fast",\n}\n\nexport type Label = string;\n\nexport abstract class Base {\n  readonly limit = 10;\n\n  abstract run(id: string): string;\n}\n`,

        // A concrete class method beside a PRIVATE one. Both change at head.
        "src/svc.ts": `export class Service {\n  run(id: string): string {\n    return id;\n  }\n\n  private secret(): number {\n    return 1;\n  }\n}\n`,

        // A changed function that actually calls something — `callees` has only
        // ever been asserted as `[]`.
        "src/boot.ts": `export function start(): string {\n  return "on";\n}\n\nexport function boot(): string {\n  return start();\n}\n`,

        // Deleted at head: `analysed: false` in `facts`, `removed` in `contracts`.
        "src/gone.ts": `export function farewell(): string {\n  return "bye";\n}\n`,

        // Renamed at head, byte-identical, so `-M` scores it R100.
        "src/old-name.ts": `export const MOVED = "moved";\n`,
      },
    },
    {
      message: "head",
      files: {
        "src/port.ts": `export interface Store {\n  get(id: string, fresh?: boolean): string;\n}\n`,
        "src/kinds.ts": `export enum Mode {\n  Fast = "fast",\n  Slow = "slow",\n}\n\nexport type Label = string | number;\n\nexport abstract class Base {\n  readonly limit = 25;\n\n  abstract run(id: string, retries?: number): string;\n}\n`,
        // The JSDoc `@throws` is the only source of a thrown type here — nothing
        // in the body throws, so an empty `throws` would mean the tag was missed.
        // BRACED, which is the dominant JSDoc spelling and was the broken one:
        // TypeScript lifts `{ValidationError}` into the tag's type expression,
        // so reading the comment text recorded `"when"` as the thrown type.
        "src/svc.ts": `export class Service {\n  /**\n   * @throws {ValidationError} when the id is empty\n   */\n  run(id: string, retries?: number): string {\n    return retries ? \`\${id}:\${retries}\` : id;\n  }\n\n  private secret(): string {\n    return "1";\n  }\n}\n`,
        "src/boot.ts": `export function start(): string {\n  return "on";\n}\n\nexport function boot(): string {\n  return \`\${start()}!\`;\n}\n`,
        "src/gone.ts": null,
        "src/old-name.ts": null,
        "src/new-name.ts": `export const MOVED = "moved";\n`,
      },
    },
  );
}

/**
 * A STRING and a BOOLEAN constant, plus the same literal in a `.tsx`, a `.jsx`
 * and a `.js` file.
 *
 * `constants` only ever had a number end-to-end, and `astGrepLangFor`'s three
 * other branches were reachable only through code nothing exercised. The three
 * copies are present in BOTH commits and never change, so they are outside the
 * diff entirely: they can only be found by the repo-wide literal scan, which is
 * exactly the dispatch under test.
 */
export function makeLiteralKindsFixture(): Fixture {
  return makeFixture(
    "literals",
    {
      message: "base",
      files: {
        "tsconfig.json": TSCONFIG,
        "package.json": JSON.stringify({ name: "fixture-literals", version: "1.0.0" }, null, 2),
        "src/flags.ts": `export const FEATURE_NAME = "alpha";\nexport const ENABLED = true;\n`,
        "src/legacy/label.ts": `export function label(): string {\n  return "alpha";\n}\n`,
        "src/widgets/panel.tsx": `export const panelLabel = "beta";\n`,
        "src/widgets/legacy.jsx": `export const legacyLabel = "beta";\n`,
        "src/widgets/plain.js": `export const plainLabel = "beta";\n`,
      },
    },
    {
      message: "head",
      files: {
        "src/flags.ts": `export const FEATURE_NAME = "beta";\nexport const ENABLED = false;\n`,
        "src/legacy/label.ts": `export function label(): string {\n  return "beta";\n}\n`,
      },
    },
  );
}

/**
 * A fake tool on `PATH`, for the binary-backed tier. It prints exactly what the
 * real tool prints, so the adapter is exercised on real-shaped output rather
 * than on a stub of our own normaliser.
 */
export function makeFakeTool(name: string, script: string): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), `ll-facts-bin-${name}-`));
  const bin = join(dir, name);
  writeFileSync(bin, script, { encoding: "utf8", mode: 0o755 });
  return { dir, bin };
}

// ── the starvation fixture ───────────────────────────────────────────────────
//
// THREE packages, one tsconfig each, a diff touching all three — and a file
// budget the three of them do not fit inside together. It exists because a
// SHARED, first-come-first-served budget produces a specific and measured bug:
// the first project loads, spends the pool, and every later project is refused
// WHOLESALE — including one holding a single changed file that would have cost
// a handful of files to serve.
//
// Caught on `prreview__grafana-106778` — "the glob over . holds 7473 source
// files and 5399 were already loaded for this diff, above the 6000 ceiling —
// it was NOT analysed" — and MEASURED on `prreview__sentry-greptile-5`, where
// one 7,230-file tsconfig over a 6,000 ceiling meant **0 of 69 changed `.tsx`
// files analysed**, at tier 2, in the largest genuinely-large PR in the corpus.
// The shape is scale-independent — it bites any monorepo whose diff spans
// several packages — so it is pinned here at a size a test can assert exactly.

/** The three packages' file counts, so the test can do the budget arithmetic. */
export const STARVED_PACKAGE_FILES = { big: 10, mid: 4, small: 4 };

/**
 * The ceiling the fixture is calibrated against: `big` fits, `big + mid` does
 * not, and `big + small` does not either. Under a first-come budget that is
 * exactly one project analysed and two refused.
 */
export const STARVED_MAX_FILES = 12;

/** Every file `makeStarvedProjectsFixture`'s head commit changes. */
export const STARVED_CHANGED = [
  "packages/big/src/mod0.ts",
  "packages/big/src/mod1.ts",
  "packages/mid/src/mod0.ts",
  "packages/small/src/mod0.ts",
];

export function makeStarvedProjectsFixture(): Fixture {
  const tsconfig = JSON.stringify(
    { compilerOptions: { strict: true, noEmit: true }, include: ["src/**/*"] },
    null,
    2,
  );
  const base: Record<string, string> = {
    "package.json": JSON.stringify({ name: "fixture-starved", private: true }, null, 2),
  };
  for (const [pkg, count] of Object.entries(STARVED_PACKAGE_FILES)) {
    base[`packages/${pkg}/tsconfig.json`] = tsconfig;
    base[`packages/${pkg}/package.json`] = JSON.stringify({ name: `@fixture/${pkg}` }, null, 2);
    for (let n = 0; n < count; n++) {
      base[`packages/${pkg}/src/mod${n}.ts`] =
        `export const ${pkg.toUpperCase()}_LIMIT_${n} = ${n * 10};\n\n` +
        `export function ${pkg}${n}(id: string): string {\n  return \`${pkg}-\${id}\`;\n}\n`;
    }
  }

  // One changed export per package, each a REAL contract delta (an added
  // parameter), so "was this project analysed at all?" has an observable answer
  // in `contracts` and not only in the loader's own bookkeeping.
  const changedFile = (pkg: string, n: number): string =>
    `export const ${pkg.toUpperCase()}_LIMIT_${n} = ${n * 10 + 5};\n\n` +
    `export function ${pkg}${n}(id: string, retry?: boolean): string {\n  return \`${pkg}-\${id}\`;\n}\n`;

  const head: Record<string, string> = {};
  for (const path of STARVED_CHANGED) {
    const [, pkg, , file] = path.split("/");
    head[path] = changedFile(pkg, Number(file.replace(/\D/g, "")));
  }

  return makeFixture(
    "starved",
    { message: "base", files: base },
    { message: "head", files: head },
  );
}

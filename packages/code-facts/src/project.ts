/**
 * Paths, languages and the `languages[]` census — **and no compiler at all.**
 *
 * This file used to be 1,247 lines of ts-morph `Project` construction plus the
 * cost management that made it survivable: a total file budget shared out
 * between groups, a project cap, a neighbourhood selector, a glob fallback, a
 * per-project source index. All of it is gone
 * (`docs/plans/fact-engine/02-migration.md`), because every number it managed
 * was a ts-morph number. `src/tsgo.ts` opens every tsconfig the diff touches in
 * ONE snapshot whose closure lives in the Go child, so there is no budget to
 * allocate and nothing to narrow.
 *
 * What survives is everything that was never about the compiler: which
 * extensions are analysable, which paths are tests, which are not worth
 * scanning, which language a file belongs to, and the envelope's `languages[]`
 * row. `compilerInfo()` survives too, re-pointed at the compiler that actually
 * runs — see `src/tsgo.ts`.
 *
 * **Rule 2 of the old TS 7 landmine is the one that did not expire: never
 * resolve `typescript` from the repo under review.** `tests/compiler-isolation.test.ts`
 * is the gate, and it now additionally asserts that the copy which DID resolve
 * is the exact-pinned one in this package's own dependency tree.
 */
import { readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { compilerPaths, compilerVersion } from "./tsgo.js";
import type { Engine, LanguageStat } from "./schema.js";

export const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
/**
 * `.es6` is not folklore: Discourse ships 20 changed Ember files under it in the
 * corpus, and the compiler parses the contents fine — the extension was the only
 * thing keeping them out of the program.
 */
export const JS_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs", ".es6"];
export const ANALYSABLE_EXTENSIONS = [...TS_EXTENSIONS, ...JS_EXTENSIONS];

/**
 * Which compiler this package uses, what version it is, and where it lives.
 *
 * The path is the load-bearing half: it must be inside THIS package's own
 * dependency tree, never inside the repo under review.
 * `tests/compiler-isolation.test.ts` asserts exactly that against a fixture repo
 * that pins a different TypeScript, mirroring
 * `apps/server/tests/state/driver-isolation.test.ts`, which pins an equivalent
 * rule for the Postgres drivers.
 *
 * Three fields rather than two, because with `tsgo` the compiler is not one
 * artifact. `typescript` ships the API as JavaScript and the compiler itself as
 * a per-platform npm sidecar (`@typescript/typescript-darwin-arm64` and
 * friends), and **only the matching one installs**. A linux image that does not
 * install its own gets a `typescript` that imports fine and an executable that
 * does not exist, so "which compiler produced this document?" is only answerable
 * if the envelope records the platform package and the binary as well as the
 * version.
 */
export function compilerInfo(): {
  version: string;
  /** `typescript/package.json`, resolved from this module. */
  modulePath: string;
  /** The `@typescript/typescript-<platform>-<arch>` root, or `null` if absent. */
  platformPackage: string | null;
  /** The executable that will be spawned, or `null` to let the API resolve one. */
  executable: string | null;
} {
  const paths = compilerPaths();
  return {
    version: compilerVersion(),
    modulePath: paths.modulePath ?? "(unresolved)",
    platformPackage: paths.platformPackage,
    executable: paths.executable,
  };
}

export function hasAnalysableExtension(path: string): boolean {
  return ANALYSABLE_EXTENSIONS.some((ext) => path.endsWith(ext));
}

/**
 * `.es6` KILLS THE COMPILER CHILD — measured, not guessed.
 *
 * Handing tsgo a `.es6` path through `openFiles` panics the Go process with
 * *"ScriptKind must be specified when parsing source file"*, and the panic takes
 * the WHOLE snapshot down: every project, every other file, one dead child and
 * an `Unexpected EOF while reading from child process` on the node side. Probed
 * across all nine analysable extensions in this checkout against
 * `typescript@7.0.2` — `.ts .tsx .mts .cts .js .jsx .mjs .cjs` all open and are
 * held by a program; `.es6` alone throws. The previous engine parsed it fine.
 *
 * So the extension stays ANALYSABLE — ast-grep reads it, `languages[]` counts
 * it, the tier-2 name-match engine indexes it, and Discourse's 20 changed Ember
 * files do not go back to being invisible — but it is never handed to the
 * compiler, and `degraded[]` says so. Degrading ONE file is the alternative to
 * losing the entire document to a process death `--never-fail` was never going
 * to catch.
 */
const COMPILER_HOSTILE_EXTENSIONS = [".es6"];

export function isCompilerParsable(path: string): boolean {
  return (
    hasAnalysableExtension(path) && !COMPILER_HOSTILE_EXTENSIONS.some((ext) => path.endsWith(ext))
  );
}

/**
 * Test-file heuristics, ONE PER LANGUAGE FAMILY.
 *
 * The JS/TS row was the only row, so `coverage`'s "which tests touch this" and
 * `constants`'s `test` side were blind on four of the corpus's five ecosystems:
 * Go puts tests in `foo_test.go`, Python in `test_foo.py`, Maven under
 * `src/test/java/`, RSpec under `spec/`. None of those matches
 * `(tests?|__tests__|spec|e2e)/` in the way the JS regex expects, and a test
 * file misread as production code is a reference site counted as a real
 * consumer.
 */
/** JS/TS — first, because it is the hot path. */
export const JS_TEST_PATH_RE =
  /(^|[/\\])(?:tests?|__tests__|spec|e2e)[/\\]|\.(?:test|spec)\.[cm]?[jt]sx?$/;
/** Go — `foo_test.go`, the only convention the toolchain accepts. */
export const GO_TEST_PATH_RE = /_test\.go$/;
/** Python — pytest finds both spellings. */
export const PYTHON_TEST_PATH_RE = /(^|[/\\])test_[^/\\]*\.py$|_test\.py$/;
/** Java — Maven/Gradle source-set layout, plus Surefire/Failsafe naming. */
export const JAVA_TEST_PATH_RE = /(^|[/\\])src[/\\]test[/\\]|(?:Test|Tests|IT|ITCase)\.java$/;
/** Ruby — RSpec's `spec/` tree and `*_spec.rb`, plus minitest's `*_test.rb`. */
export const RUBY_TEST_PATH_RE = /(^|[/\\])spec[/\\]|_spec\.rb$|_test\.rb$/;

/**
 * Each row is named and exported so a `LanguageDescriptor` can carry ITS OWN
 * row rather than the union — a Go descriptor asking "is this a test file?"
 * must not answer yes because the path matches Ruby's `spec/` convention. The
 * union below stays, because `isTestPath` is asked about paths whose language
 * nobody looked up.
 */
const TEST_PATH_RES: RegExp[] = [
  JS_TEST_PATH_RE,
  GO_TEST_PATH_RE,
  PYTHON_TEST_PATH_RE,
  JAVA_TEST_PATH_RE,
  RUBY_TEST_PATH_RE,
];

/** Test-file heuristic, shared by `facts` (the `tests` field) and `constants`. */
export function isTestPath(path: string): boolean {
  return TEST_PATH_RES.some((re) => re.test(path));
}

/**
 * The RESIDUAL denylist — no longer the mechanism, and that is the point.
 *
 * `.gitignore` is now honoured by construction, because the file set comes from
 * `git ls-tree` rather than from `readdirSync` (`git.listFiles`). Ignored and
 * untracked files are simply not in the tree, along with everything a nested
 * `.gitignore`, `.git/info/exclude` or a global exclude file covers — none of
 * which a hand-maintained list can see. What survives here is only the second
 * question: **what is legitimately TRACKED and still never worth scanning?**
 *
 * The number that made scope hygiene load-bearing: on this monorepo at
 * `HEAD~1..HEAD` the walk produced **44,633 "hard-coded duplicates" across ten
 * constants, 41,079 of them from `apps/server/data/sandboxes/**`** — cloned
 * review workspaces, gitignored, under a path no conventional denylist names.
 * That whole class is gone for free; this list is now for the committed `dist/`,
 * the vendored `third_party/`, and the checked-in bundle.
 *
 * The `dist`/`build` rows match a separator-delimited suffix (`dist-site`,
 * `dist.browser`, `build_out`) rather than a raw prefix — a raw `dist.*` prefix
 * would also swallow `distributed/` and `builders/`, which are ordinary source
 * directory names, and this list must never be the reason real source went
 * unread. It is also the ONLY filter the walk fallback has, so trimming it costs
 * nothing on the tree path and costs the fallback everything.
 */
const IGNORED_DIR_RE =
  /(^|[/\\])(?:node_modules|dist(?:[-._][^/\\]*)?|build(?:[-._][^/\\]*)?|out|coverage|\.git|\.next|\.nuxt|vendor|third_?party|\.venv|venv|__pycache__|target|\.bundle|\.gradle|tmp)([/\\]|$)/;

/**
 * A checked-in bundle, by NAME. `looksMinified` catches these too, but only
 * after the file has been read; the name is free and a committed `*.min.js` is
 * never a review site.
 */
const BUNDLE_FILE_RE = /(?:[.-]min|\.bundle|\.chunk)\.[cm]?jsx?$/i;

export function isIgnoredPath(path: string): boolean {
  return IGNORED_DIR_RE.test(path) || BUNDLE_FILE_RE.test(path);
}

/**
 * The path filter every enumeration in this package shares: an analysable
 * extension that the residual denylist does not reject.
 *
 * A trailing `/` marks a directory, which only the walk fallback ever asks
 * about — the tree lists files, so there are no directories to prune.
 */
export function isScannablePath(path: string): boolean {
  if (path.endsWith("/")) return !isIgnoredPath(path);
  return hasAnalysableExtension(path) && !isIgnoredPath(path);
}

/**
 * A file bigger than this is not source anybody reviews, and reading it costs
 * the literal scan its whole budget. Paired with `looksMinified` below: between
 * them they are what stops the scan ceiling being consumed by build output
 * before the walk ever reaches `src/`.
 */
export const MAX_SCANNED_FILE_BYTES = 512 * 1024;

/** The longest line a hand-written source file plausibly has. */
const MINIFIED_LINE_CHARS = 2000;

/**
 * A bundle, by shape rather than by path — `dist*` catches the conventional
 * locations and this catches the rest. One 400 KB line of transpiled JS
 * contributes every integer and string constant in a whole application to set
 * B, at a line number that means nothing to a reviewer.
 */
export function looksMinified(source: string): boolean {
  let lineStart = 0;
  for (let i = 0; i <= source.length; i++) {
    if (i === source.length || source[i] === "\n") {
      if (i - lineStart > MINIFIED_LINE_CHARS) return true;
      lineStart = i + 1;
    }
  }
  return false;
}

/**
 * The language a path belongs to, from its extension.
 *
 * Deliberately a small explicit table plus "the bare extension" as the
 * fallback, so a language nobody thought about still gets a row in the
 * envelope's `languages[]` instead of vanishing into it.
 */
const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  ts: "typescript",
  tsx: "typescript",
  mts: "typescript",
  cts: "typescript",
  js: "javascript",
  jsx: "javascript",
  mjs: "javascript",
  cjs: "javascript",
  es6: "javascript",
  java: "java",
  go: "go",
  py: "python",
  rb: "ruby",
  scss: "scss",
  properties: "properties",
  hbs: "handlebars",
  erb: "erb",
};

export function languageIdOf(path: string): string {
  const base = path.split(/[/\\]/).pop() ?? path;
  const dot = base.lastIndexOf(".");
  // A dotfile (`.gitignore`) has no extension; neither does `Dockerfile`.
  if (dot <= 0) return "(no-extension)";
  const extension = base.slice(dot + 1).toLowerCase();
  return LANGUAGE_BY_EXTENSION[extension] ?? extension;
}

/**
 * The ast-grep language for a path, or `null` when there is no binding for it.
 *
 * Lives here rather than in `constants.ts` because the envelope's
 * `languages[].parsedFiles` has to answer the same question on the tier-2 path,
 * and two copies of an extension table is how `.es6` came to be missing from
 * one of them.
 */
export function astGrepLangFor(path: string): Lang | null {
  if (path.endsWith(".tsx") || path.endsWith(".jsx")) return Lang.Tsx;
  if (path.endsWith(".ts") || path.endsWith(".mts") || path.endsWith(".cts")) return Lang.TypeScript;
  if (
    path.endsWith(".js") ||
    path.endsWith(".mjs") ||
    path.endsWith(".cjs") ||
    path.endsWith(".es6")
  ) {
    return Lang.JavaScript;
  }
  return null;
}

export interface LanguageBreakdownOptions {
  repo: string;
  /** Head-relative changed paths, deletions ALREADY REMOVED by the caller. */
  paths: string[];
  /** The engine the run as a whole reached. */
  engine: Engine;
  /**
   * TIER 1 ONLY: did this run obtain a compiled source file for `path`?
   *
   * Injected rather than derived, because the answer belongs to the compiler
   * snapshot (`EngineSnapshot.lookup`) and this module deliberately holds no
   * reference to one. Absent means "no compiled program ran", and `parsedFiles`
   * then falls back to an actual ast-grep parse when the engine is `ast-grep`.
   */
  parsed?: (path: string) => boolean;
}

/**
 * `languages[]` — the envelope row that makes a silent run impossible to
 * mistake for a clean one. See `LanguageStatSchema` for why it exists.
 *
 * `parsedFiles` means one thing in every tier: **this run obtained a syntax
 * tree for the file**. On tier 1 that is membership of the compiled program; on
 * tier 2 it is ast-grep actually parsing it, which costs one parse per CHANGED
 * file (tens, not thousands) and is the difference between a true number and a
 * declared-parsable one.
 */
export function languageBreakdown(options: LanguageBreakdownOptions): LanguageStat[] {
  const byLanguage = new Map<string, { changed: number; parsed: number; engine: Engine }>();

  for (const path of options.paths) {
    const id = languageIdOf(path);
    const analysable = hasAnalysableExtension(path);
    const engine: Engine = analysable ? options.engine : "none";
    const entry = byLanguage.get(id) ?? { changed: 0, parsed: 0, engine };
    entry.changed++;
    // A language's own engine is the run's engine only where the run's engine
    // can read it at all: a `.properties` file in a tier-1 TypeScript repo was
    // never going to be parsed by tsgo, and saying "tsgo, 0 parsed" would blame
    // the engine for a file it does not handle.
    if (engine !== "none") entry.engine = engine;
    if (parsedBy(options, path, analysable)) entry.parsed++;
    byLanguage.set(id, entry);
  }

  return [...byLanguage.entries()]
    .map(([id, entry]) => ({
      id,
      changedFiles: entry.changed,
      parsedFiles: entry.parsed,
      engine: entry.engine,
    }))
    .sort((a, b) => b.changedFiles - a.changedFiles || a.id.localeCompare(b.id));
}

function parsedBy(options: LanguageBreakdownOptions, path: string, analysable: boolean): boolean {
  if (!analysable) return false;
  if (options.parsed) return options.parsed(path);
  if (options.engine !== "ast-grep") return false;
  const lang = astGrepLangFor(path);
  if (!lang) return false;
  try {
    parse(lang, readFileSync(join(options.repo, path), "utf8")).root();
    return true;
  } catch {
    return false;
  }
}

export function repoRelative(repo: string, absolute: string): string {
  return relative(repo, absolute).split(sep).join("/");
}

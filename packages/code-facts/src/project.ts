/**
 * ts-morph `Project` construction — READ THE TS 7 LANDMINE BEFORE EDITING.
 *
 * **TypeScript 7 has no programmatic compiler API.** `tsgo` ships a CLI and an
 * LSP server; the API is explicitly "not ready". This workspace is on TS 7 and
 * so are the target repos. Three rules follow, and they are not negotiable:
 *
 *  1. **`ts-morph@28` is the primary engine**, because it vendors its own
 *     compiler and carries NO `typescript` dependency.
 *  2. **Never resolve `typescript` from the repo under review.** A
 *     `require.resolve("typescript", { paths: [repoDir] })` anywhere in this
 *     package is a bug, and `tests/compiler-isolation.test.ts` is the gate that
 *     says so. A toolchain that resolved the target repo's TS would break on
 *     every TS-7 repo, which is now most of them.
 *  3. **The `tsgo --lsp --stdio` fallback tier is a SEAM, not a build.**
 *     `loadProject` returns a tier and a reason instead of throwing, so tier 2
 *     is a place a later pass can plug an LSP-backed reference provider in.
 *     WP1 does not build it — do it when a tier-2 repo actually blocks a
 *     measurement.
 *
 * This is the same failure mode that already bit us: dependency-cruiser refused
 * to parse TS >= 7 and exited 0 anyway, so the import-boundary gate went green
 * while seeing nothing.
 */
import { createRequire } from "node:module";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { Lang, parse } from "@ast-grep/napi";
import { Project, ts } from "ts-morph";
import type { ResolutionHostFactory, SourceFile } from "ts-morph";
import { listFiles } from "./git.js";
import type { LoggerPort } from "./log.js";
import { noopLogger } from "./log.js";
import type { Engine, LanguageStat, Tier } from "./schema.js";

const require_ = createRequire(import.meta.url);

export const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
/**
 * `.es6` is not folklore: Discourse ships 20 changed Ember files under it in the
 * corpus, and ts-morph parses the contents fine — the extension was the only
 * thing keeping them out of the program.
 */
export const JS_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs", ".es6"];
export const ANALYSABLE_EXTENSIONS = [...TS_EXTENSIONS, ...JS_EXTENSIONS];

/**
 * Where the compiler this package uses actually lives, and what version it is.
 *
 * The path is the load-bearing half: it must be inside THIS package's own
 * dependency tree, never inside the repo under review. `tests/compiler-isolation.test.ts`
 * asserts exactly that against a fixture repo that pins a different TypeScript,
 * mirroring `apps/server/tests/state/driver-isolation.test.ts`, which pins an
 * equivalent rule for the Postgres drivers.
 */
export function compilerInfo(): { version: string; modulePath: string } {
  return { version: ts.version, modulePath: vendoredCompilerPath() };
}

/**
 * `@ts-morph/common` — where the vendored compiler actually lives — is a
 * transitive dependency, so under pnpm's strict layout it is NOT resolvable
 * from this package directly. Resolving it THROUGH `ts-morph` is what makes
 * the answer true rather than merely absent, and the fallback keeps
 * `--version` working on a flat `node_modules` too.
 */
function vendoredCompilerPath(): string {
  const tsMorph = require_.resolve("ts-morph/package.json");
  try {
    return createRequire(require_.resolve("ts-morph")).resolve("@ts-morph/common/package.json");
  } catch {
    return tsMorph;
  }
}

export function hasAnalysableExtension(path: string): boolean {
  return ANALYSABLE_EXTENSIONS.some((ext) => path.endsWith(ext));
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
 * them they are what stops a 6000-file ceiling being consumed by build output
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
 * ONE PROGRAM, and which changed files it was opened for.
 *
 * A monorepo diff does not have "a" tsconfig. cal.com carries 26 and grafana 29;
 * a PR that touches two packages is covered by two of them and by no single one.
 * See `loadProject` for the measurement that forced this shape.
 */
export interface ProjectGroup {
  /** The tsconfig this group compiled, or `null` for a glob-fallback group. */
  tsConfigPath: string | null;
  /** The directory a glob group covered; `null` for a tsconfig group. */
  globRoot: string | null;
  project: Project;
  /** Source files in the program. */
  fileCount: number;
  /**
   * Source files the group WANTED — `fileCount + omittedCount`. Equal to
   * `fileCount` on a whole group; larger on one the budget narrowed.
   */
  candidateCount: number;
  /**
   * Files left out because the group did not fit its allowance. **Non-zero
   * means every reference set from this program is a LOWER BOUND**, and
   * `loadProject` names that in `degraded[]`.
   */
  omittedCount: number;
  /** Changed files this group was opened for AND actually contains. */
  analysedPaths: string[];
}

export interface LoadedProject {
  tier: Tier;
  /**
   * The LARGEST group's project, or `null` on tier 2/3 — kept because most
   * call sites only ever wanted "a program to look a file up in", and because
   * a single-tsconfig repo (which is most fixtures, and every non-monorepo)
   * still has exactly one.
   */
  project: Project | null;
  /** Every program that loaded. Empty on tier 2/3. */
  groups: ProjectGroup[];
  /** `groups.map(g => g.project)` — what the extractors iterate. */
  projects: Project[];
  /** A populated entry whenever `tier !== 1`. Never silence. */
  degraded: { extractor: string; reason: string }[];
  /** The largest group's tsconfig. */
  tsConfigPath: string | null;
  /** Every tsconfig that compiled, largest group first. `null` = a glob group. */
  tsConfigPaths: (string | null)[];
  /** Source files across ALL groups — what `maxFiles` is charged against. */
  fileCount: number;
  /**
   * True when at least one group was NARROWED to fit its allowance.
   *
   * Reference sets out of a narrowed program are a lower bound: the query still
   * ran over the whole program it was given, but that program is not the whole
   * project. Named in `degraded[]` too — this field is the machine-checkable
   * half, for the same reason `languages[]` exists beside the prose.
   */
  narrowed: boolean;
  /** Analysable changed files at least one group contains. */
  analysedCount: number;
}

export interface LoadProjectOptions {
  repo: string;
  /** Head-relative paths the diff touched — decides tier 3 vs tier 2. */
  changedPaths: string[];
  /**
   * Force ONE tsconfig for the whole diff. This also disables the glob
   * fallback: the caller asked for a specific program, and quietly globbing
   * around the files it does not cover would defeat the flag — the point of
   * `--tsconfig` is to answer the "which files are in the program" question
   * yourself, and the envelope must keep telling you what it cost.
   */
  tsConfigPath?: string;
  /**
   * A ceiling on TOTAL source files across every group — the memory bound, and
   * deliberately still a TOTAL rather than a per-project allowance (see
   * `allocate` below for why a per-project budget was rejected).
   *
   * Exceeding it NARROWS the offending group and says so, rather than silently
   * eating the phase's wall-clock budget — a `facts` phase that times out fails
   * the run, and a failed run is re-dispatched every 30 minutes (§D12).
   */
  maxFiles?: number;
  /** A ceiling on how many programs one diff may open. See `DEFAULT_MAX_PROJECTS`. */
  maxProjects?: number;
  /**
   * Absent at THIS layer, but supplied on every real run: a ts-morph
   * `resolutionHost` that decides which bare specifiers the checker may follow
   * — the memory axis `maxFiles` cannot reach (CLAUDE.md, "WHERE THE MEMORY
   * GOES"). Absent means `full`, which is not the CLI default.
   *
   * It is passed in rather than built here on purpose. The policy has to be
   * the UNION of base and head to be safe, and only `run.ts` can see both
   * sides; a loader that computed its own would compute a DIFFERENT one per
   * worktree, which is the asymmetry that manufactures phantom deltas. See
   * `resolution.ts`.
   */
  resolutionHost?: ResolutionHostFactory;
  log?: LoggerPort;
}

export const DEFAULT_MAX_FILES = 6000;

/**
 * How many programs one diff may open.
 *
 * `maxFiles` already bounds the memory — it is charged against the TOTAL across
 * groups, so N programs holding 6000 files between them cost about what one
 * program holding 6000 files costs. This bounds the other axis: each `new
 * Project` is a compiler instance with its own load cost (~23 MB, ~90 ms), and
 * a diff scattered across thirty packages would pay it thirty times for the
 * last few files. The groups are loaded largest-diff-share first, so the cap
 * drops the tail — and unlike the file budget, THIS one is a wholesale refusal,
 * because half a compiler is not a thing. It is named in `degraded[]`.
 */
export const DEFAULT_MAX_PROJECTS = 12;

/**
 * A `references`-only root tsconfig has no `include`/`files` of its own and adds
 * zero source files. Loading it would look like success and produce an empty
 * symbol list — the exact silence we are engineering against.
 */
function isUsableTsConfig(candidate: string): boolean {
  if (!existsSync(candidate)) return false;
  try {
    const raw = readFileSync(candidate, "utf8");
    return !(/"references"\s*:/.test(raw) && !/"include"\s*:|"files"\s*:/.test(raw));
  } catch {
    return false;
  }
}

/** Walk up from `from` to `repo` looking for `name`. Memoised per directory. */
function nearestUp(
  repo: string,
  from: string,
  name: string,
  usable: (candidate: string) => boolean,
  cache: Map<string, string | null>,
): string | null {
  const chain: string[] = [];
  let dir = from;
  while (dir.startsWith(repo) && dir.length >= repo.length) {
    const cached = cache.get(dir);
    if (cached !== undefined) {
      for (const seen of chain) cache.set(seen, cached);
      return cached;
    }
    chain.push(dir);
    const candidate = join(dir, name);
    if (usable(candidate)) {
      for (const seen of chain) cache.set(seen, candidate);
      return candidate;
    }
    if (dir === repo) break;
    dir = dirname(dir);
  }
  for (const seen of chain) cache.set(seen, null);
  return null;
}

/**
 * Group the changed files by the tsconfig each is most plausibly covered by.
 *
 * The predecessor picked ONE nearest tsconfig for the whole diff (deepest among
 * the changed paths) and compiled that. On a monorepo that is a coverage
 * disaster and the corpus measured it: **58 of 8,514 changed files analysed,
 * 0.7%** across 50 real PRs — one case analysed 1 file of 142 and still
 * reported tier 1, because the tier describes the program that loaded, not the
 * diff it covers.
 */
function groupByTsConfig(repo: string, changedPaths: string[]): Map<string | null, string[]> {
  const cache = new Map<string, string | null>();
  const groups = new Map<string | null, string[]>();
  for (const path of changedPaths) {
    const found = nearestUp(repo, dirname(join(repo, path)), "tsconfig.json", isUsableTsConfig, cache);
    const bucket = groups.get(found);
    if (bucket) bucket.push(path);
    else groups.set(found, [path]);
  }
  return groups;
}

/**
 * The package a file belongs to — how far a glob-fallback group reaches.
 *
 * Globbing the whole repo for a handful of files no tsconfig covers is what
 * turns this fix into the memory regression it is guarding against, so a
 * fallback group reaches only as far as the nearest `package.json`. On a repo
 * with a root manifest and no tsconfig (which is most fixtures, and every
 * plain single-package project) that IS the whole repo, so the previous
 * behaviour is unchanged where it was already right.
 */
function nearestPackageRoot(repo: string, path: string, cache: Map<string, string | null>): string {
  const found = nearestUp(repo, dirname(join(repo, path)), "package.json", existsSync, cache);
  return found ? dirname(found) : repo;
}

/**
 * The files a glob-fallback group would compile — LISTED BEFORE ANY OF THEM IS
 * PARSED, which is the whole reason this is not one `addSourceFilesAtPaths`
 * call.
 *
 * MEASURED, and the number is the argument: letting ts-morph glob the repo root
 * and checking the count afterwards took `pnpm selfcheck` on this monorepo from
 * **774 MB to 4.5 GB of peak RSS** — for a program that was rejected on the
 * very next line for being over the file ceiling. Listing costs nothing;
 * parsing 9,296 files to then throw them away costs everything.
 *
 * The listing is `git ls-files` — the WORKING TREE, not a commit, because
 * ts-morph parses these off disk and a path from some other commit is a path
 * that is not there. It still honours `.gitignore`, which is the whole win: on
 * this monorepo the root glob went from 9,399 files (over the 6000 ceiling, so
 * the group was DROPPED and its changed files went unanalysed) to 731.
 *
 * `exclude` is the other half: a fallback rooted at the repo would otherwise
 * hold a second copy of every file the tsconfig groups already loaded.
 */
function globCandidates(root: string, exclude: string[]): string[] {
  const excluded = exclude.map((dir) => (dir.endsWith(sep) ? dir : `${dir}${sep}`));
  const listing = listFiles({ dir: root, ref: null, accept: isScannablePath });
  const out: string[] = [];
  for (const file of listing.files) {
    const full = join(root, file.path);
    if (excluded.some((dir) => full.startsWith(dir))) continue;
    out.push(full);
  }
  return out;
}

/**
 * The files a TSCONFIG would compile — also listed before any of them is
 * parsed, which is the half `globCandidates` used to have and this one did not.
 *
 * `ts.getParsedCommandLineOfConfigFile` does exactly what ts-morph does on the
 * way to building a `Project` (read the config, follow `extends`, run the
 * `include`/`exclude` globs) and stops one step short of parsing anything.
 * MEASURED on sentry's root tsconfig: **112 ms and 211 MB to list 7,230 files
 * against 3.6 s and 1.29 GB to compile them** — and the old loader compiled
 * them, counted them, found them over the ceiling and threw the whole program
 * away. Knowing the size first is what makes narrowing possible at all, and it
 * is a memory win even where the answer is still "too big".
 *
 * `errors` is NOT fatal here: grafana's root tsconfig extends a package that is
 * not installed in a bare worktree, reports that as a diagnostic, and still
 * resolves all 5,399 files. A config that is genuinely unreadable throws from
 * `new Project` a few lines later, which is the path that keeps a broken build
 * config at tier 2 instead of promoting it to a silently-empty tier 1.
 */
function tsConfigCandidates(tsConfigPath: string): string[] {
  const host: ts.ParseConfigFileHost = {
    ...(ts.sys as unknown as ts.ParseConfigFileHost),
    onUnRecoverableConfigFileDiagnostic: (diagnostic) => {
      throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, " "));
    },
  };
  const parsed = ts.getParsedCommandLineOfConfigFile(tsConfigPath, {}, host);
  if (!parsed) throw new Error(`tsconfig at ${tsConfigPath} could not be parsed`);
  return parsed.fileNames;
}

/**
 * Choose WHICH `limit` of `candidates` to compile when the whole group will not
 * fit: `mustHave` first, then the rest nearest-first.
 *
 * "Nearest" is the deepest shared directory with any changed file. That is a
 * crude proxy for "likely to reference one of them" and it is the right crude
 * proxy here, because the alternative proxies are worse: a random or
 * filesystem-order prefix is the `constants` set-B bug in a new place, and
 * anything import-graph-aware needs the files parsed, which is the cost being
 * budgeted. Inside one tsconfig, a symbol's consumers overwhelmingly live in
 * its own package subtree — a consumer further away than that is usually in a
 * DIFFERENT program anyway, where this group's reference query could never have
 * reached it.
 *
 * The ranking runs on repo-relative paths on purpose: `contracts` loads the
 * base tree in a temp worktree and compares the two programs, so head and base
 * must narrow to the SAME set wherever the trees agree. Absolute paths differ
 * by the worktree prefix and would have made the two selections diverge for no
 * reason, which is the recipe for a phantom delta.
 */
function selectNeighbourhood(
  root: string,
  candidates: string[],
  mustHave: Set<string>,
  limit: number,
): string[] {
  const byPath = (a: string, b: string): number => {
    const [x, y] = [repoRelative(root, a), repoRelative(root, b)];
    return x < y ? -1 : x > y ? 1 : 0;
  };
  const selected = candidates.filter((path) => mustHave.has(path)).sort(byPath);
  // A diff whose OWN files outrun the budget: keep a deterministic prefix
  // rather than an arbitrary one. `loadProject` names the shortfall.
  if (selected.length >= limit) return selected.slice(0, limit);

  // Every ancestor directory of a must-have file, with its depth. A candidate's
  // score is the depth of the DEEPEST such directory that contains it, so a
  // sibling beats a cousin beats a stranger.
  const depthByDir = new Map<string, number>();
  for (const path of selected) {
    const segments = repoRelative(root, path).split("/");
    for (let depth = segments.length - 1; depth > 0; depth--) {
      const dir = segments.slice(0, depth).join("/");
      const seen = depthByDir.get(dir);
      if (seen !== undefined && seen >= depth) break;
      depthByDir.set(dir, depth);
    }
  }

  const scored: { path: string; relative: string; score: number }[] = [];
  for (const path of candidates) {
    if (mustHave.has(path)) continue;
    const rel = repoRelative(root, path);
    const segments = rel.split("/");
    let score = 0;
    for (let depth = segments.length - 1; depth > 0; depth--) {
      const found = depthByDir.get(segments.slice(0, depth).join("/"));
      if (found !== undefined) {
        score = found;
        break;
      }
    }
    scored.push({ path, relative: rel, score });
  }
  // Deterministic to the last file: score, then the repo-relative path.
  scored.sort((a, b) => b.score - a.score || (a.relative < b.relative ? -1 : a.relative > b.relative ? 1 : 0));
  for (const entry of scored) {
    if (selected.length >= limit) break;
    selected.push(entry.path);
  }
  return selected;
}

/**
 * Add an explicit file list, never a glob pattern.
 *
 * `addSourceFilesAtPaths` treats its argument as a GLOB, so a real path
 * containing `[`, `(` or `{` — a Next.js `app/[slug]/page.tsx`, say — would be
 * read as a character class and silently match nothing.
 */
function addSourceFiles(project: Project, paths: string[]): void {
  for (const path of paths) {
    try {
      project.addSourceFileAtPath(path);
    } catch {
      // A file that vanished between the walk and here, or one the compiler
      // refuses. One unreadable file must not take the group down; it will show
      // up as an unanalysed changed file if it was one.
    }
  }
}

/**
 * The repo's `node_modules` is not REQUIRED — and it is not avoided.
 *
 * `skipFileDependencyResolution` keeps ts-morph from walking into it when
 * ADDING files, and `types: []` stops the compiler auto-including
 * `node_modules/@types/*`. Between them, nothing here needs an install:
 * `tests/no-node-modules.test.ts` deletes `node_modules` and the constant
 * fixture still produces its symbols, because relative specifiers resolve
 * against the file system and every repo source file is already in the program.
 *
 * **But neither option stops the type-checker following a BARE specifier.**
 * `import { z } from "zod"` is resolved by `ts.Program` on demand, and the
 * `.d.ts` it lands on drags its own transitive closure in with it. That is not
 * a footnote, it is where the memory goes — MEASURED on this monorepo at
 * `a63200ff` (a 3-file diff):
 *
 * ```
 * ts-morph source files ......   637      ← what `maxFiles` bounds
 * ts.Program source files ....  9647      ← what is actually parsed and bound
 *   of which node_modules ....  8947  (7374 .d.ts, 78 MB of text)
 * ```
 *
 * So `--max-files` is a ceiling on the ROOT list, not on the program: the same
 * case at `--max-files 200` still peaks at 3.27 GB against 3.68 GB at the 6000
 * default, because the 15x closure is unchanged. With no `node_modules` on disk
 * — which is what a review workspace looks like — the identical run costs
 * **817 MB and 5.4 s** against **3551 MB and 13.6 s**, for a byte-identical
 * document. The second axis is per PROGRAM: each group builds its own
 * `ts.Program` with its own copy of that closure, ~110 MB with no install and
 * ~350–500 MB with one, which is the cost `maxFiles` cannot see because it is
 * charged as a total.
 *
 * Two consequences a caller has to plan for, and one thing NOT to do:
 *
 *  - A phase that runs this in a 2 GB sandbox is safe only while the workspace
 *    has no install. A `prepare` step that runs `pnpm install` — to produce a
 *    coverage artifact, say — takes `all` on an ordinary PR of this repo from
 *    1.3 GB to over 4 GB, which is an OOM, which is exit 134 and NO envelope.
 *  - Lowering `--max-files` is not the mitigation. Lowering `--max-projects` is,
 *    and it costs coverage directly (this repo at `3b880cce`: 22 of 31 changed
 *    files analysed at 12 programs, 8 of 31 at one).
 *  - A `resolutionHost` that refuses to resolve into `node_modules` closes the
 *    whole gap (3.5 GB → 0.9–1.4 GB, measured), and it is NOT a free win: it
 *    collapses externally-typed contract signatures to `any`
 *    (`z.infer<typeof S>` → `z.infer<any>`) on ~36% of entries. It also deletes
 *    `mirrorNodeModules`'s reason to exist, which `tests/noise-floor.test.ts`
 *    pins at 17 phantom deltas. Do not take that trade without re-pinning both.
 */
function newProject(
  tsConfigPath: string | null,
  explicitFiles: boolean,
  resolutionHost?: ResolutionHostFactory,
): Project {
  return new Project({
    ...(tsConfigPath ? { tsConfigFilePath: tsConfigPath } : {}),
    // PROTOTYPE, off by default. `undefined` here is not "a host that allows
    // everything" — it is no host at all, so T0 is byte-identical to what
    // shipped rather than to a hook that happens to say yes. See
    // `resolution.ts`, and CLAUDE.md's "WHERE THE MEMORY GOES".
    ...(resolutionHost ? { resolutionHost } : {}),
    // A NARROWED tsconfig group keeps the repo's compiler options — `strict`,
    // `jsx`, `paths` — and supplies its own file list. Letting ts-morph add the
    // config's files and then removing some would have paid for the parse this
    // whole path exists to avoid.
    skipAddingFilesFromTsConfig: explicitFiles,
    skipFileDependencyResolution: true,
    compilerOptions: {
      allowJs: true,
      // `types: []` is not a nicety: without it the compiler reads
      // `node_modules/@types/*` off the repo, which is the affordance WP1
      // requires us NOT to depend on.
      types: [],
      noEmit: true,
      skipLibCheck: true,
    },
  });
}

interface PendingGroup {
  tsConfigPath: string | null;
  globRoot: string | null;
  paths: string[];
}

/**
 * Build one `Project` PER TSCONFIG the diff touches, or return the tier that
 * says why not.
 *
 * **The single-project version was the biggest coverage gap in this package**,
 * and it was invisible because the tier stayed 1. Measured over 50 real PRs
 * (keycloak / grafana / discourse / cal.com / sentry): 58 of 8,514 changed
 * files analysed — 0.7% — with `grafana-90939` reporting tier 1 on 1 file of
 * 142 and `cal-com-22532` reporting tier 1 on 0 of 17. The shortfall WAS in
 * `degraded[]` on every one of them, which is why this is a coverage fix and
 * not a loudness fix: the package was honest, it just could not see.
 *
 * The budget is what keeps that honest in the other direction — see `allocate`
 * for how it is shared out, and why "a project holding one changed file is
 * never refused because an unrelated project spent the budget" is an invariant
 * rather than an aspiration.
 *
 * Reference queries stay inside their own program. That is correct rather than
 * a limitation: a cross-project reference is not resolvable without project
 * references anyway, and over-claiming a reference set would be worse than
 * under-claiming it in the extractor (`constants`) whose whole output is an
 * absence claim.
 */
export function loadProject(raw: LoadProjectOptions): LoadedProject {
  // A RELATIVE `repo` used to defeat tsconfig discovery outright: `nearestUp`
  // guards its walk on `dir.startsWith(repo)`, and `"apps/server/src"` does not
  // start with `"."`. Every changed file was filed under "no tsconfig" and the
  // whole diff fell through to the glob fallback — glob-tier output, from the
  // spelling (`--repo .`) that reads most natural. `run.ts` normalises for the
  // pipeline; this is the same normalisation for a direct library caller.
  const options: LoadProjectOptions = {
    ...raw,
    repo: resolve(raw.repo),
    ...(raw.tsConfigPath ? { tsConfigPath: resolve(raw.tsConfigPath) } : {}),
  };
  const log = options.log ?? noopLogger;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const maxProjects = options.maxProjects ?? DEFAULT_MAX_PROJECTS;
  const analysable = options.changedPaths.filter(hasAnalysableExtension);

  const empty = (tier: Tier, reason: string, tsConfigPath: string | null = null, fileCount = 0) => ({
    tier,
    project: null,
    groups: [],
    projects: [],
    tsConfigPath,
    tsConfigPaths: [],
    fileCount,
    narrowed: false,
    analysedCount: 0,
    degraded: [{ extractor: "project", reason }],
  });

  if (analysable.length === 0) {
    return empty(
      3,
      "no TypeScript or JavaScript file in the diff — tier 3, only `deps` and `patterns` apply",
    );
  }

  const forced = options.tsConfigPath !== undefined;
  const byTsConfig = forced
    ? new Map<string | null, string[]>([[options.tsConfigPath as string, analysable]])
    : groupByTsConfig(options.repo, analysable);

  // Largest share of the diff first: the budget below is a prefix of this
  // order, so what gets dropped is always the tail nobody was reading.
  const pending: PendingGroup[] = [...byTsConfig]
    .filter(([tsConfigPath]) => tsConfigPath !== null)
    .map(([tsConfigPath, paths]) => ({ tsConfigPath, globRoot: null, paths }))
    .sort((a, b) => b.paths.length - a.paths.length || String(a.tsConfigPath).localeCompare(String(b.tsConfigPath)));

  const degraded: { extractor: string; reason: string }[] = [];
  const groups: ProjectGroup[] = [];
  /** Files whose OWN tsconfig blew up — never retried by glob. See below. */
  const abandoned = new Set<string>();
  let total = 0;
  /**
   * Changed files refused because the diff spans more programs than allowed.
   * A SET, not a counter: a file refused as part of its tsconfig group is
   * offered again to the glob fallback and refused again, and counting it twice
   * would put a number in `degraded[]` larger than the diff.
   */
  const capped = new Set<string>();

  /**
   * ── THE BUDGET, AND WHY IT IS SHARED OUT RATHER THAN SPENT ─────────────────
   *
   * `unserved` is every analysable changed file that is not yet inside some
   * program. It is the RESERVE: no group may spend budget that a later group
   * needs for its own changed files. That one line is the whole fix.
   *
   * The shape it fixes was caught on `prreview__grafana-106778`, whose envelope
   * read *"the glob over . holds 7473 source files and 5399 were already loaded
   * for this diff, above the 6000 ceiling — it was NOT analysed"*: the root
   * tsconfig went first, spent the pool, and a group holding ONE changed file
   * was refused outright. **A project holding one changed file must never be
   * refused because an unrelated project already spent the shared budget.**
   *
   * Be precise about what that case cost, because the honest number is not the
   * dramatic one: grafana's single "uncovered" file turns out to be a DELETION,
   * so the refused group could not have analysed it either and the refusal cost
   * nothing there — the envelope was blaming the budget for a deleted file (see
   * the `mustHave.size === 0` skip and the `absent` split below). The shape is
   * still a real defect, and where it BITES is `prreview__sentry-greptile-5`:
   * one tsconfig of 7,230 files over a 6,000 ceiling, refused whole, **0 of 69
   * changed `.tsx` files analysed at tier 2**. Narrowed instead, the same case
   * reads 69 of 69 at tier 1, 112 symbols and 20 contracts.
   *
   * Three things were considered and two rejected:
   *
   *  - A budget PER PROJECT (the obvious fix) multiplies the memory bound by
   *    `maxProjects`: 12 x 6,000 files is ~5 GB against a production sandbox
   *    with a **2 GB agent cap**. Rejected on that alone. `maxFiles` therefore
   *    stays a TOTAL and peak RSS is unchanged by this fix.
   *  - Counting QUERIED files rather than loaded files is the honest proxy for
   *    reference-query time, but it cannot bound memory, and it cannot be known
   *    before the program is built. Not this fix.
   *  - What ships: the total is ALLOCATED, and a group that does not fit its
   *    allocation is admitted PARTIALLY instead of refused whole. It keeps
   *    every changed file it covers plus as much of their neighbourhood as the
   *    budget allows (`selectNeighbourhood`), and the narrowing is named.
   *
   * A narrowed program answers `contracts` and `facts` for its changed files
   * and gives `constants` a reference set that is a LOWER BOUND — which is why
   * `degraded[]` says exactly that, and why `LoadedProject.narrowed` carries it
   * as a field a consumer can compare rather than parse.
   *
   * The one place the reserve can push past `maxFiles` is a group whose changed
   * files alone do not fit what is left, and that is deliberate: **the diff is
   * not optional work.** Every changed file is read by `facts` and `contracts`
   * whatever the loader decides, so declining to compile one saves nothing and
   * costs the whole answer for it. `reserveBudget` bounds the exception so it
   * stays an exception — the hard ceiling on files held at once is
   * `maxFiles + min(analysable diff, maxFiles)`, and a diff bigger than the
   * budget is named below rather than silently truncated.
   */
  const unserved = new Set(analysable);
  const reserveBudget = Math.min(analysable.length, maxFiles);
  let reserveSpent = 0;
  const allowanceFor = (want: number): number => {
    const reserve = Math.min(want, Math.max(reserveBudget - reserveSpent, 0));
    return Math.max(reserve, maxFiles - total - Math.max(unserved.size - want, 0));
  };

  const loadGroup = (group: PendingGroup): void => {
    const what = group.globRoot
      ? `the glob over ${repoRelative(options.repo, group.globRoot) || "."}`
      : `the project at ${repoRelative(options.repo, group.tsConfigPath as string)}`;

    if (groups.length >= maxProjects) {
      // Half a compiler is not a thing, so THIS refusal is wholesale — and it
      // is the only one left that is.
      for (const path of group.paths) {
        unserved.delete(path);
        capped.add(path);
      }
      return;
    }

    // EVERY group's size is known before a single file is parsed — the glob
    // from `git ls-files`, the tsconfig from the config parser. Finding a glob
    // group's size out afterwards was worth 3.7 GB of peak RSS on this monorepo
    // alone; finding a TSCONFIG group's out afterwards (which is what this used
    // to do, compiling the program and discarding it when it did not fit) is
    // worth 1.1 GB and 3.5 s on sentry.
    let candidates: string[];
    try {
      candidates = group.globRoot
        ? globCandidates(
            group.globRoot,
            groups
              .map((g) => (g.tsConfigPath ? dirname(g.tsConfigPath) : g.globRoot))
              .filter((dir): dir is string => dir !== null && dir !== group.globRoot),
          )
        : tsConfigCandidates(group.tsConfigPath as string);
    } catch (err) {
      brokenProject(group, err);
      return;
    }
    // A tsconfig that resolved and described nothing. Not fatal: its files fall
    // through to the glob fallback with everything else no program covers.
    if (candidates.length === 0) return;

    // The files this group MUST hold whatever the budget says: the changed
    // files it covers and nobody else has. Bounded by the diff, not the repo.
    const wanted = new Set(group.paths.map((path) => join(options.repo, path)));
    const mustHave = new Set(candidates.filter((path) => wanted.has(path)));
    // A group that holds NONE of the changed files it was opened for is all
    // cost and no answer: it can never own a declaration under review, so no
    // reference query will ever run in it. MEASURED on
    // `prreview__grafana-106778`, where the one "uncovered" changed file turns
    // out to be a DELETION — absent at head, so the repo-root glob could not
    // contain it — and compiling the glob's share of the budget for it cost
    // 600 files and 319 MB of peak RSS to analyse nothing at all.
    if (mustHave.size === 0) return;

    const allowance = allowanceFor(mustHave.size);
    const narrowed = candidates.length > allowance;
    const chosen = narrowed
      ? selectNeighbourhood(options.repo, candidates, mustHave, allowance)
      : candidates;

    let project: Project;
    try {
      // A whole tsconfig group is still built the way it always was — ts-morph
      // adds the config's own files — so the common path is unchanged. Only a
      // NARROWED group supplies its own list.
      project = newProject(
        group.tsConfigPath,
        narrowed || group.globRoot !== null,
        options.resolutionHost,
      );
    } catch (err) {
      brokenProject(group, err);
      return;
    }
    if (narrowed || group.globRoot) addSourceFiles(project, chosen);

    const fileCount = project.getSourceFiles().length;
    if (fileCount === 0) return;

    if (narrowed) {
      const omitted = candidates.length - fileCount;
      degraded.push({
        extractor: "project",
        reason: `${what} holds ${candidates.length} source files, above what the ${maxFiles}-file budget left it (${allowance}, with ${total} already loaded for this diff) — ${fileCount} were compiled: every changed file it covers plus the ${Math.max(fileCount - mustHave.size, 0)} nearest to them, and ${omitted} were left OUT. Reference sets from this program are therefore a LOWER BOUND — a reference that lives only in an omitted file is not counted — so an "appears nowhere else" reading is NOT available for these files (raise --max-files to compile it whole)`,
      });
    }

    total += fileCount;
    const analysedPaths = group.paths.filter(
      (path) => sourceFileAt(project, options.repo, path) !== undefined,
    );
    for (const path of analysedPaths) unserved.delete(path);
    reserveSpent += analysedPaths.length;
    groups.push({
      tsConfigPath: group.tsConfigPath,
      globRoot: group.globRoot,
      project,
      fileCount,
      candidateCount: candidates.length,
      omittedCount: Math.max(candidates.length - fileCount, 0),
      analysedPaths,
    });
  };

  /**
   * A tsconfig that will not parse is a BROKEN program, not an absent one, and
   * globbing around it would silently promote a repo whose build is wrong to
   * tier 1. Its files are abandoned, and named.
   */
  function brokenProject(group: PendingGroup, err: unknown): void {
    for (const path of group.paths) {
      abandoned.add(path);
      unserved.delete(path);
    }
    degraded.push({
      extractor: "project",
      reason: `ts-morph could not load the project${
        group.tsConfigPath ? ` from ${repoRelative(options.repo, group.tsConfigPath)}` : ""
      }: ${err instanceof Error ? err.message : String(err)}`,
    });
  }

  for (const group of pending) loadGroup(group);

  // ── the glob fallback ──────────────────────────────────────────────────────
  //
  // Everything no program covers: a file under no tsconfig at all, and a file
  // whose tsconfig loaded but whose `include` does not reach it. Both are
  // ordinary on a monorepo, and dropping them is the coverage gap this whole
  // function exists to close. NAMED in `degraded[]`, because glob-tier output
  // is not tsconfig-tier output — the files are in a program with no project
  // options behind it, so type resolution there is best-effort.
  const uncovered = forced
    ? []
    : analysable.filter(
        (path) =>
          !abandoned.has(path) &&
          sourceFileAt(groups.map((g) => g.project), options.repo, path) === undefined,
      );

  if (uncovered.length > 0) {
    const packageCache = new Map<string, string | null>();
    const byRoot = new Map<string, string[]>();
    for (const path of uncovered) {
      const root = nearestPackageRoot(options.repo, path, packageCache);
      const bucket = byRoot.get(root);
      if (bucket) bucket.push(path);
      else byRoot.set(root, [path]);
    }
    const fallbacks: PendingGroup[] = [...byRoot]
      .map(([globRoot, paths]) => ({ tsConfigPath: null, globRoot, paths }))
      .sort((a, b) => b.paths.length - a.paths.length || a.globRoot.localeCompare(b.globRoot));
    const before = groups.length;
    for (const group of fallbacks) {
      // One package root can nest inside another (a workspace package with no
      // tsconfig under a repo root with none either), so a later fallback may
      // already be covered by an earlier one's glob. Re-checking is what keeps
      // that from opening a second program over the same files.
      const still = group.paths.filter(
        (path) => sourceFileAt(groups.map((g) => g.project), options.repo, path) === undefined,
      );
      if (still.length === 0) continue;
      loadGroup({ ...group, paths: still });
    }
    const globbed = groups
      .slice(before)
      .flatMap((g) => g.analysedPaths);
    if (globbed.length > 0) {
      degraded.push({
        extractor: "project",
        reason: `${globbed.length} changed file(s) are covered by no tsconfig, so they were analysed by GLOBBING their package instead — this is glob-tier output, not tsconfig-tier: no compiler options from the repo were applied, so type resolution for these files is best-effort (${globbed
          .slice(0, 10)
          .join(", ")})`,
      });
    }
  }

  if (analysable.length > maxFiles) {
    degraded.push({
      extractor: "project",
      reason: `the diff itself touches ${analysable.length} analysable file(s), more than the ${maxFiles}-file budget (--max-files) — the changed files are what every group reserves before it spends anything, so a diff this size cannot be held whole and some of it was NOT compiled whatever the repository looks like`,
    });
  }

  if (capped.size > 0) {
    degraded.push({
      extractor: "project",
      reason: `the diff spans more programs than the ${maxProjects}-program ceiling allows (--max-projects), so the smallest by share of the diff were not opened and ${capped.size} changed file(s) went unanalysed — each program is a compiler instance costing ~23 MB and ~90 ms whatever its size, which is the axis --max-files does not bound`,
    });
  }

  if (groups.length === 0) {
    // Nothing loaded at all. Which of the two reasons it was is already in
    // `degraded`, unless every group was empty — say that rather than reporting
    // zero symbols.
    if (degraded.length === 0) {
      degraded.push({
        extractor: "project",
        reason:
          "the project loaded but contains zero source files — an empty symbol list here would be indistinguishable from a clean diff",
      });
    }
    return {
      tier: 2,
      project: null,
      groups: [],
      projects: [],
      tsConfigPath: pending[0]?.tsConfigPath ?? null,
      tsConfigPaths: [],
      fileCount: total,
      narrowed: false,
      analysedCount: 0,
      degraded,
    };
  }

  const projects = groups.map((g) => g.project);

  // A changed file no program contains cannot be reasoned about, and saying so
  // is the difference between "clean" and "blind".
  const missing = analysable.filter(
    (path) => sourceFileAt(projects, options.repo, path) === undefined,
  );
  if (missing.length > 0) {
    // A file the diff DELETED is absent at head, so no program can hold it and
    // none should be blamed for that. Counting it as a coverage gap manufactures
    // exactly the signal this entry exists to make trustworthy — the same
    // argument `languages[].changedFiles` already makes about deletions — and it
    // is not hypothetical: `prreview__grafana-106778`'s single "not in the
    // compiled project" file is a deletion.
    const absent = missing.filter((path) => !existsSync(join(options.repo, path)));
    const uncoveredAtHead = missing.filter((path) => existsSync(join(options.repo, path)));
    if (uncoveredAtHead.length > 0) {
      degraded.push({
        extractor: "project",
        reason: `${uncoveredAtHead.length} changed file(s) are not in the compiled project and were not analysed${
          capped.size > 0 ? ` (${capped.size} of them because of the ${maxProjects}-program ceiling)` : ""
        }: ${uncoveredAtHead.slice(0, 10).join(", ")}`,
      });
    }
    if (absent.length > 0) {
      degraded.push({
        extractor: "project",
        reason: `${absent.length} changed file(s) are absent at head — deleted by this diff — so no program contains them and nothing was extracted FROM them; their consumers are still analysed wherever those live (${absent.slice(0, 10).join(", ")})`,
      });
    }
  }

  const narrowedGroups = groups.filter((g) => g.omittedCount > 0);

  log.debug("code-facts project loaded", {
    tsConfigPath: groups[0].tsConfigPath,
    tsConfigPaths: groups.map((g) => g.tsConfigPath ?? `${repoRelative(options.repo, g.globRoot as string) || "."} (glob)`),
    groups: groups.length,
    narrowedGroups: narrowedGroups.length,
    fileCount: total,
    omittedFileCount: narrowedGroups.reduce((sum, g) => sum + g.omittedCount, 0),
    changedAnalysed: analysable.length - missing.length,
    changedNotInProject: missing.length,
  });

  return {
    tier: 1,
    project: groups[0].project,
    groups,
    projects,
    tsConfigPath: groups[0].tsConfigPath,
    tsConfigPaths: groups.map((g) => g.tsConfigPath),
    fileCount: total,
    narrowed: narrowedGroups.length > 0,
    analysedCount: analysable.length - missing.length,
    degraded,
  };
}

// ── looking a changed file up across N programs ──────────────────────────────

/**
 * The per-project `repo-relative path → SourceFile` index.
 *
 * The predicate form (`getSourceFile(f => repoRelative(...) === path)`) is a
 * LINEAR SCAN of the program, and every extractor ran one per changed file.
 * That was affordable against one program and 5 changed files; against a dozen
 * programs and 142 changed files it is the obvious way to spend the phase
 * budget on string comparison. Built once per program, on first use.
 *
 * Safe to cache because a `Project` here is constructed, filled, and then only
 * read — no extractor adds a source file after the fact.
 */
const SOURCE_INDEXES = new WeakMap<Project, { root: string; files: Map<string, SourceFile> }>();

function sourceIndexOf(project: Project, root: string): Map<string, SourceFile> {
  const cached = SOURCE_INDEXES.get(project);
  if (cached && cached.root === root) return cached.files;
  const files = new Map<string, SourceFile>();
  for (const file of project.getSourceFiles()) {
    files.set(repoRelative(root, file.getFilePath()), file);
  }
  SOURCE_INDEXES.set(project, { root, files });
  return files;
}

/** One program, several, or none — the shape every extractor now accepts. */
export type Programs = Project | Project[] | null | undefined;

export function toProjects(programs: Programs): Project[] {
  if (programs == null) return [];
  return Array.isArray(programs) ? programs : [programs];
}

/**
 * `root`-relative `path` in the FIRST program that contains it.
 *
 * First-wins rather than merged: a file in two overlapping programs is the same
 * file, and picking one keeps every downstream count (`files[]`, `parsedFiles`,
 * the contract delta) a count of files rather than of programs.
 */
export function sourceFileAt(programs: Programs, root: string, path: string): SourceFile | undefined {
  for (const project of toProjects(programs)) {
    const direct = project.getSourceFile(join(root, path));
    if (direct) return direct;
    const indexed = sourceIndexOf(project, root).get(path);
    if (indexed) return indexed;
  }
  return undefined;
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
  /**
   * The compiled programs, when there are any. `parsedFiles` is the UNION
   * across them — a monorepo diff is covered by one program per package, and
   * counting only the first would under-report the very number this field
   * exists to make trustworthy.
   */
  project: Programs;
  /** The engine the run as a whole reached. */
  engine: Engine;
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
    // never going to be parsed by ts-morph, and saying "ts-morph, 0 parsed"
    // would blame the engine for a file it does not handle.
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
  const projects = toProjects(options.project);
  if (projects.length > 0) {
    return sourceFileAt(projects, options.repo, path) !== undefined;
  }
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

/** `src/user.ts:14` — the location format every document uses. */
export function locationOf(repo: string, file: SourceFile, pos: number): string {
  const line = file.getLineAndColumnAtPos(pos).line;
  return `${relative(repo, file.getFilePath()).split(sep).join("/")}:${line}`;
}

export function repoRelative(repo: string, absolute: string): string {
  return relative(repo, absolute).split(sep).join("/");
}

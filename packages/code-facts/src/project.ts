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
import { dirname, join, relative, sep } from "node:path";
import { Project, ts } from "ts-morph";
import type { SourceFile } from "ts-morph";
import type { LoggerPort } from "./log.js";
import { noopLogger } from "./log.js";
import type { Tier } from "./schema.js";

const require_ = createRequire(import.meta.url);

export const TS_EXTENSIONS = [".ts", ".tsx", ".mts", ".cts"];
export const JS_EXTENSIONS = [".js", ".jsx", ".mjs", ".cjs"];
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

const TEST_PATH_RE = /(^|[/\\])(?:tests?|__tests__|spec|e2e)[/\\]|\.(?:test|spec)\.[cm]?[jt]sx?$/;

/** Test-file heuristic, shared by `facts` (the `tests` field) and `constants`. */
export function isTestPath(path: string): boolean {
  return TEST_PATH_RE.test(path);
}

const IGNORED_DIR_RE = /(^|[/\\])(?:node_modules|dist|build|out|coverage|\.git|\.next|vendor)([/\\]|$)/;

export function isIgnoredPath(path: string): boolean {
  return IGNORED_DIR_RE.test(path);
}

export interface LoadedProject {
  tier: Tier;
  /** `null` on tier 2/3 — the reason is in `degraded`. */
  project: Project | null;
  /** A populated entry whenever `tier !== 1`. Never silence. */
  degraded: { extractor: string; reason: string }[];
  tsConfigPath: string | null;
  fileCount: number;
}

export interface LoadProjectOptions {
  repo: string;
  /** Head-relative paths the diff touched — decides tier 3 vs tier 2. */
  changedPaths: string[];
  tsConfigPath?: string;
  /**
   * A ceiling on program size. Exceeding it DEGRADES LOUDLY rather than
   * silently eating the phase's wall-clock budget — a `facts` phase that times
   * out fails the run, and a failed run is re-dispatched every 30 minutes
   * (§D12).
   */
  maxFiles?: number;
  log?: LoggerPort;
}

export const DEFAULT_MAX_FILES = 6000;

/** The tsconfig a repo-relative changed file is most plausibly covered by. */
function findTsConfig(repo: string, changedPaths: string[]): string | null {
  const candidates = new Set<string>();
  for (const path of changedPaths) {
    let dir = dirname(join(repo, path));
    while (dir.startsWith(repo) && dir.length >= repo.length) {
      candidates.add(join(dir, "tsconfig.json"));
      if (dir === repo) break;
      dir = dirname(dir);
    }
  }
  candidates.add(join(repo, "tsconfig.json"));
  // Nearest-first: a package tsconfig describes its own sources far better than
  // a workspace root one that only holds `references`.
  const sorted = [...candidates].sort((a, b) => b.split(sep).length - a.split(sep).length);
  for (const candidate of sorted) {
    if (!existsSync(candidate)) continue;
    try {
      // A `references`-only root tsconfig has no `include`/`files` of its own
      // and adds zero source files. Loading it would look like success and
      // produce an empty symbol list — the exact silence we are engineering
      // against.
      const raw = readFileSync(candidate, "utf8");
      if (/"references"\s*:/.test(raw) && !/"include"\s*:|"files"\s*:/.test(raw)) continue;
    } catch {
      continue;
    }
    return candidate;
  }
  return null;
}

function globSourceFiles(project: Project, repo: string): void {
  project.addSourceFilesAtPaths([
    join(repo, "**/*.{ts,tsx,mts,cts,js,jsx,mjs,cjs}"),
    `!${join(repo, "**/node_modules/**")}`,
    `!${join(repo, "**/dist/**")}`,
    `!${join(repo, "**/build/**")}`,
    `!${join(repo, "**/coverage/**")}`,
  ]);
}

/**
 * Build a `Project` over `repo`, or return the tier that says why not.
 *
 * NOTE what is deliberately absent: any consultation of the repo's
 * `node_modules`. `skipFileDependencyResolution` keeps ts-morph from walking
 * into it when adding files, and `types: []` stops the compiler pulling
 * `@types/*` off disk. Cross-file references inside the repo still resolve,
 * because relative specifiers resolve against the file system and every repo
 * source file is already in the program. `tests/no-node-modules.test.ts` proves
 * it by deleting `node_modules` and asserting the constant fixture still
 * produces its symbols.
 */
export function loadProject(options: LoadProjectOptions): LoadedProject {
  const log = options.log ?? noopLogger;
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
  const analysable = options.changedPaths.filter(hasAnalysableExtension);

  if (analysable.length === 0) {
    return {
      tier: 3,
      project: null,
      tsConfigPath: null,
      fileCount: 0,
      degraded: [
        {
          extractor: "project",
          reason:
            "no TypeScript or JavaScript file in the diff — tier 3, only `deps` and `patterns` apply",
        },
      ],
    };
  }

  const tsConfigPath = options.tsConfigPath ?? findTsConfig(options.repo, analysable) ?? undefined;

  let project: Project;
  try {
    project = new Project({
      ...(tsConfigPath ? { tsConfigFilePath: tsConfigPath } : {}),
      skipAddingFilesFromTsConfig: false,
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
  } catch (err) {
    return {
      tier: 2,
      project: null,
      tsConfigPath: tsConfigPath ?? null,
      fileCount: 0,
      degraded: [
        {
          extractor: "project",
          reason: `ts-morph could not load the project${
            tsConfigPath ? ` from ${relative(options.repo, tsConfigPath)}` : ""
          }: ${err instanceof Error ? err.message : String(err)}`,
        },
      ],
    };
  }

  if (!tsConfigPath) globSourceFiles(project, options.repo);

  let sourceFiles = project.getSourceFiles();
  if (sourceFiles.length === 0) {
    // A tsconfig that loaded but described nothing. Glob as a second attempt —
    // and if THAT is empty too, degrade rather than report zero symbols.
    globSourceFiles(project, options.repo);
    sourceFiles = project.getSourceFiles();
  }

  if (sourceFiles.length === 0) {
    return {
      tier: 2,
      project: null,
      tsConfigPath: tsConfigPath ?? null,
      fileCount: 0,
      degraded: [
        {
          extractor: "project",
          reason:
            "the project loaded but contains zero source files — an empty symbol list here would be indistinguishable from a clean diff",
        },
      ],
    };
  }

  if (sourceFiles.length > maxFiles) {
    return {
      tier: 2,
      project: null,
      tsConfigPath: tsConfigPath ?? null,
      fileCount: sourceFiles.length,
      degraded: [
        {
          extractor: "project",
          reason: `the project has ${sourceFiles.length} source files, above the ${maxFiles} ceiling — reference queries would not finish inside the phase budget (raise --max-files to override)`,
        },
      ],
    };
  }

  // A changed file the program does not contain cannot be reasoned about, and
  // saying so is the difference between "clean" and "blind".
  const missing = analysable.filter(
    (path) => project.getSourceFile(join(options.repo, path)) === undefined,
  );

  log.debug("code-facts project loaded", {
    tsConfigPath: tsConfigPath ?? null,
    fileCount: sourceFiles.length,
    changedNotInProject: missing.length,
  });

  const degraded =
    missing.length > 0
      ? [
          {
            extractor: "project",
            reason: `${missing.length} changed file(s) are not in the compiled project and were not analysed: ${missing
              .slice(0, 10)
              .join(", ")}`,
          },
        ]
      : [];

  return {
    tier: 1,
    project,
    tsConfigPath: tsConfigPath ?? null,
    fileCount: sourceFiles.length,
    degraded,
  };
}

/** `src/user.ts:14` — the location format every document uses. */
export function locationOf(repo: string, file: SourceFile, pos: number): string {
  const line = file.getLineAndColumnAtPos(pos).line;
  return `${relative(repo, file.getFilePath()).split(sep).join("/")}:${line}`;
}

export function repoRelative(repo: string, absolute: string): string {
  return relative(repo, absolute).split(sep).join("/");
}

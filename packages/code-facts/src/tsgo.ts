/**
 * THE TSGO SEAM — the compiler LIFECYCLE, and the only module that spawns one.
 *
 * Everything type-aware in `code-facts` used to run on `ts-morph@28`, which
 * vendors the JavaScript TypeScript compiler. TypeScript 7 ships a real
 * programmatic API (`typescript/unstable/sync`) driven by the `tsgo` Go binary
 * over a synchronous pipe, and the difference is not a refinement — measured in
 * this checkout against `apps/server/tsconfig.json`:
 *
 * | engine   | build   | peak RSS |
 * |----------|---------|----------|
 * | ts-morph | 1902 ms | 1087 MB  |
 * | tsgo     |  247 ms |   79 MB  |
 *
 * All eight workspace tsconfigs in ONE snapshot: 10,078 program files, 320 ms,
 * 98 MB. That reframes three of this package's standing constraints at once —
 * `--max-files`, `--max-projects`, and the 2.4–3.0 GB peaks that make
 * `SANDBOX_MEMORY_LIMIT` a live risk (CLAUDE.md, "WHERE THE MEMORY GOES").
 *
 * Two capabilities matter more than the speed:
 *
 *  - **A VIRTUAL FS gives a genuine base-side program with no second worktree.**
 *    `contracts` used to run `git worktree add --detach` into `$TMPDIR`, which
 *    was the single most expensive thing this package did and the reason `all`
 *    peaked where it did. An overlay serving base blobs for the changed files
 *    produces a real, fully type-resolved base program in ~30 ms against the
 *    SAME tree. See `openSnapshot`'s `overlay`. `withWorktree` survives in
 *    `git.ts` with no runtime caller on the TS/JS path.
 *  - **A file under NO tsconfig still gets a working checker**, via
 *    `openFiles` → tsgo's inferred project. That is the claimed fix for the
 *    package's bug 4 — "1 of 31 analysable changed files; the package was
 *    honest, and blind". VERIFIED here, and pinned by `tests/tsgo.test.ts`.
 *
 * ## What this module is responsible for, and what it is not
 *
 * It owns the compiler LIFECYCLE: resolve the binary, spawn the API, open the
 * projects, index the files, hand back a checker, and tear the child process
 * down. It owns no POLICY — no file budget, no project cap, no neighbourhood
 * selection, no tier. `tsgo-extractors.discoverTsgoTargets` decides WHICH
 * tsconfigs and WHICH files are worth opening and `run.ts` decides the tier;
 * this module is told and obeys.
 *
 * ## The symmetry invariant
 *
 * This package's worst bug class is an asymmetry between the base and head
 * views: `contracts` once reported 227 deltas of which one was real, and every
 * unit test passed throughout. The defence here is structural rather than
 * advisory — **the base and head snapshots are the SAME call with the SAME
 * `tsConfigPaths` and `openFiles`, differing only in `overlay`.** Nothing about
 * the program's shape can drift between the two sides, because the shape is one
 * argument list used twice.
 *
 * ## Loudness
 *
 * Read `errors.ts` first. The failure this package is engineered against is a
 * tool that cannot see the sources and reports success anyway, and the tsgo API
 * hands you that shape twice, unprompted:
 *
 *  - **A tsconfig that will not parse does NOT throw.** `updateSnapshot` returns
 *    a project built from a recovered configuration, with the parse failure
 *    demoted to `program.getConfigFileParsingDiagnostics()` — measured: 20 error
 *    diagnostics against 0 for a healthy config. Left unchecked that is a
 *    broken build config silently promoted to tier 1, which is exactly what
 *    `makeBrokenTsConfigFixture` exists to prevent.
 *  - **A tsconfig that does not exist is dropped silently.** It simply does not
 *    appear in `getProjects()`, and `getProjects()` returning fewer projects
 *    than you asked for looks like nothing at all.
 *
 * Both are detected here, both exclude the project rather than degrade it, and
 * both land in `EngineSnapshot.degraded` with a named reason plus
 * `EngineSnapshot.failures[]` as the machine-checkable half — the `languages[]`
 * / `narrowed` precedent. A whole-snapshot failure (no binary, a dead child)
 * THROWS a `TsgoError`, because there is no snapshot to hand back and a caller
 * must not be able to mistake one for an empty one.
 *
 * ### The one hole that is a PROCESS death, not an exception
 *
 * `syncChannel.js` calls `spawn()` and attaches no `'error'` listener. A binary
 * that cannot be executed therefore emits an UNHANDLED `'error'` event on the
 * next tick and kills the node process outright — measured: a bogus
 * `tsserverPath` produces a catchable `EPIPE: broken pipe, write` from
 * `updateSnapshot` and then tears the process down anyway, with no stack a
 * `try`/`catch` can reach. That is the `tests/oom.test.ts` shape: `--never-fail`
 * is an in-process `try`/`catch` and provably cannot cover it, so the review
 * cron would re-dispatch the failed run every thirty minutes.
 *
 * `resolveTsgoBinary` closes it by PRE-FLIGHTING the executable and passing the
 * resolved path straight back in as `tsserverPath`, so the path this module
 * checks is the path that is spawned. It is a narrowing, not a guarantee: a
 * binary that passes `X_OK` and dies during exec still kills the process, and
 * the shell-level catch the CLAUDE.md describes stays mandatory.
 */
import {
  accessSync,
  constants as fsConstants,
  existsSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { FileSystem } from "typescript/unstable/fs";
import type { SourceFile } from "typescript/unstable/ast";
import { API, DiagnosticCategory, type Project } from "typescript/unstable/sync";
import { EXIT_UNAVAILABLE, FactsError, reasonOf } from "./errors.js";
import { type LoggerPort, noopLogger } from "./log.js";
import type { DegradedEntry } from "./schema.js";

/** The escape hatch, in `toolchain.json`'s `LASTLIGHT_<TOOL>_BIN` spelling (§D1). */
export const TSGO_BIN_ENV = "LASTLIGHT_TSGO_BIN";

/**
 * Every way this seam can come up short, as a value.
 *
 * A caller folds these into `degraded[]`; the string is written for a reader
 * deciding whether an empty result means "clean" or "blind", never as a bare
 * stack trace.
 */
export type TsgoFailureReason =
  /** No `tsgo` executable could be resolved for this platform. Fatal. */
  | "binary-unresolvable"
  /** A path was resolved but is not an executable file. Fatal. */
  | "binary-not-executable"
  /** The API spawned but the snapshot request failed or the child died. Fatal. */
  | "snapshot-failed"
  /** One requested tsconfig produced no project at all. Per-project. */
  | "tsconfig-absent"
  /** One requested tsconfig failed to parse; its files are abandoned. Per-project. */
  | "tsconfig-unparsable";

/**
 * A typed, named engine failure. `reason` is the branch a caller switches on;
 * `message` is the line that belongs in `degraded[]`.
 */
export class TsgoError extends FactsError {
  readonly reason: TsgoFailureReason;

  constructor(reason: TsgoFailureReason, message: string) {
    super("tsgo", message, EXIT_UNAVAILABLE);
    this.name = "TsgoError";
    this.reason = reason;
  }
}

/**
 * Base-side file contents, keyed by path.
 *
 * A `string` is served in place of what is on disk. **`null` means the file does
 * not exist on this side** — which is how a file the PR ADDED must present at
 * base, and getting it wrong is the difference between an `added` export and a
 * phantom `changed` one.
 *
 * Keys may be repo-relative or absolute; `openSnapshot` normalises them and
 * indexes each under BOTH spellings of the repo root (see `buildOverlayIndex`).
 */
export type Overlay = ReadonlyMap<string, string | null>;

export interface OpenSnapshotOptions {
  /** The repository root. Normalised to an absolute path on the way in. */
  repo: string;
  /**
   * The tsconfigs to open, in PRECEDENCE order — when a file belongs to more
   * than one program, the earlier project owns it in `lookup`. Absolute or
   * repo-relative.
   */
  tsConfigPaths?: readonly string[];
  /**
   * Files no tsconfig covers. Each is opened via LSP's `didOpen` semantics: if
   * an ancestor tsconfig turns out to contain it, that project is loaded and
   * becomes its default; otherwise it lands in tsgo's INFERRED project, which
   * carries default compiler options — no `paths`, no `strict`, nothing the
   * repository configured. Analysed is better than skipped, but it is not the
   * same answer, so it is named in `degraded`.
   */
  openFiles?: readonly string[];
  /**
   * The base-side view. Absent (or empty) builds the head view straight off the
   * working tree. The ONLY field that may differ between the two sides — see
   * "The symmetry invariant" above.
   */
  overlay?: Overlay | null;
  /**
   * Force a specific `tsgo` executable. Defaults to `$LASTLIGHT_TSGO_BIN`, then
   * to the binary in this package's own dependency tree. It is never resolved
   * from the repository under review — that is the TS 7 landmine
   * (`tests/compiler-isolation.test.ts`).
   */
  tsgoPath?: string;
  log?: LoggerPort;
}

/** One compiled program, and where it came from. */
export interface EngineProject {
  /**
   * The tsconfig this project compiled, REPO-RELATIVE, or `null` for tsgo's
   * inferred project. Repo-relative on purpose: the head and base views index
   * the same tree, and an absolute spelling would let two sides that are
   * otherwise identical compare unequal.
   */
  tsConfigPath: string | null;
  /** True for tsgo's synthetic inferred project (`configFileName` is not a real path). */
  inferred: boolean;
  /** The live project — `.program`, `.checker`, `.compilerOptions` are PROPERTIES. */
  project: Project;
  /** Source files in the program, including `lib.*.d.ts` and any external library. */
  fileCount: number;
  /** Files the configuration made ROOTS of this program. */
  rootFileCount: number;
}

/** A repo file, resolved to the program that owns it. */
export interface EngineFile {
  /** Repo-relative, forward-slashed — the spelling every other module here uses. */
  path: string;
  absolutePath: string;
  /** The program a reference query about this file must run in. */
  owner: EngineProject;
  sourceFile: SourceFile;
  /** True when the owning project's configuration made it a root, not a transitive import. */
  isRootFile: boolean;
}

/** One requested tsconfig that did not become a usable program. */
export interface TsgoProjectFailure {
  /** Repo-relative. */
  tsConfigPath: string;
  reason: TsgoFailureReason;
  /** The first compiler diagnostic, when there was one. */
  detail: string | null;
}

export interface EngineSnapshot {
  /** The absolute repo root, as given. */
  repo: string;
  /** Usable programs, caller order first, the inferred project (if any) last. */
  projects: readonly EngineProject[];
  /** True when this is a base-side view. */
  overlaid: boolean;
  /**
   * Why this snapshot sees less than it was asked to. Empty means every
   * requested tsconfig compiled — NOT that the analysis is complete, which is a
   * question about the file set and belongs to the caller.
   */
  degraded: readonly DegradedEntry[];
  /** The machine-checkable half of `degraded`, per tsconfig. */
  failures: readonly TsgoProjectFailure[];
  /**
   * The program that owns `path`, plus its source file.
   *
   * `null` means NO program in this snapshot holds that file — a looked-and-
   * found-none answer, not an absence of enquiry. The reason it is not held
   * (never opened, a tsconfig that would not parse, deleted by the overlay) is
   * the caller's to attribute, from `failures` and from what it asked for.
   *
   * Accepts a repo-relative or an absolute path.
   */
  lookup(path: string): EngineFile | null;
  /** Close the child process. Idempotent; safe to call from a `finally` twice. */
  dispose(): void;
}

// ── binary resolution ────────────────────────────────────────────────────────

/**
 * `X_OK` **and** a regular file, and the second half is not pedantry.
 *
 * `access(dir, X_OK)` succeeds for a DIRECTORY — that bit means "traversable"
 * — so a `$LASTLIGHT_TSGO_BIN` pointed at a directory passes a bare `X_OK`
 * check, reaches `spawn()`, and lands in the one hole this module cannot cover:
 * `EACCES` arrives as an UNHANDLED `'error'` event on the next tick and kills
 * the process (see the header, and `tests/oom.test.ts`). Rejecting it here turns
 * that into a named, catchable `TsgoError`.
 *
 * It is a narrowing and not a fix. A regular file that passes `X_OK` and still
 * cannot be exec'd — a wrong-architecture binary, a wrapper script whose
 * interpreter is missing — is measured to take the process down the same way,
 * and `tests/oom.test.ts` pins exactly that shape.
 */
function isExecutableFile(path: string): boolean {
  try {
    accessSync(path, fsConstants.X_OK);
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/**
 * The `tsgo` executable this process will spawn, or `null` to let the API
 * resolve its own.
 *
 * Order, matching §D1's `LASTLIGHT_<TOOL>_BIN` → PATH → baked-path convention as
 * far as it applies: an explicit path, then `$LASTLIGHT_TSGO_BIN`, then the
 * platform package inside THIS package's dependency tree. There is deliberately
 * no `PATH` step — a `tsgo` on `PATH` is an arbitrary version, and the whole
 * point of resolving from here is that the compiler is the one this package's
 * lockfile pinned rather than one the host or the repo under review supplied.
 *
 * An explicit path that is not executable THROWS: the operator asked for a
 * specific binary and silently using a different one is the class of surprise
 * that costs a day. An unresolvable default returns `null` instead, because the
 * API's own `getExePath()` may know a layout this does not, and it already
 * throws a clean, catchable error when it does not.
 */
export function resolveTsgoBinary(explicit?: string): string | null {
  const named = explicit ?? process.env[TSGO_BIN_ENV];
  if (named && named.trim() !== "") {
    const path = resolve(named);
    if (!existsSync(path)) {
      throw new TsgoError(
        "binary-unresolvable",
        `the tsgo binary named by ${explicit ? "the caller" : `$${TSGO_BIN_ENV}`} does not exist: ${path}`,
      );
    }
    if (!isExecutableFile(path)) {
      throw new TsgoError(
        "binary-not-executable",
        `the tsgo binary named by ${explicit ? "the caller" : `$${TSGO_BIN_ENV}`} is not executable: ${path}`,
      );
    }
    return path;
  }
  return bundledTsgoBinary();
}

/** Where the compiler actually is, in three parts. See `CompilerPaths`. */
export interface CompilerPaths {
  /**
   * `typescript/package.json`, resolved relative to THIS module. `null` only on
   * a broken install — and never a path inside the repository under review.
   */
  modulePath: string | null;
  /**
   * The `@typescript/typescript-<platform>-<arch>` package root, or `null` when
   * this platform's optional dependency was not installed. **`null` here with a
   * non-null `modulePath` is the shape a wrong-platform image produces**: the
   * API imports fine and there is no compiler behind it.
   */
  platformPackage: string | null;
  /** The executable that will be spawned, or `null` to let the API resolve one. */
  executable: string | null;
}

/**
 * The platform binary in this package's own tree, and the two packages it came
 * from.
 *
 * `typescript` ships the API as JavaScript and the compiler as a per-platform
 * sidecar package (`@typescript/typescript-darwin-arm64` and friends), whose
 * single executable is named after `typescript`'s own `bin` key — `tsc` for the
 * `typescript` distribution and `tsgo` for the native-preview one. Both
 * spellings are probed rather than derived, so a rename upstream degrades to
 * "let the API resolve it" instead of to a wrong path.
 *
 * Resolution starts from `typescript/package.json` located relative to THIS
 * module, never relative to the repository under review. That is the surviving
 * half of the old TS 7 landmine and `tests/compiler-isolation.test.ts` is its
 * gate — `getExePath()` resolves against the installed package's `__dirname`
 * and does not consult `cwd`, so `new API({ cwd: repo })` cannot reach a
 * compiler inside the repo; this function must not either.
 */
export function compilerPaths(): CompilerPaths {
  let modulePath: string | null = null;
  try {
    modulePath = createRequire(import.meta.url).resolve("typescript/package.json");
  } catch {
    return { modulePath: null, platformPackage: null, executable: null };
  }
  let platformPackage: string | null = null;
  try {
    const fromTypescript = createRequire(modulePath);
    platformPackage = dirname(
      fromTypescript.resolve(
        `@typescript/typescript-${process.platform}-${process.arch}/package.json`,
      ),
    );
  } catch {
    return { modulePath, platformPackage: null, executable: null };
  }
  const lib = join(platformPackage, "lib");
  for (const name of ["tsc", "tsgo", "tsc.exe", "tsgo.exe"]) {
    const candidate = join(lib, name);
    if (existsSync(candidate) && isExecutableFile(candidate)) {
      return { modulePath, platformPackage, executable: candidate };
    }
  }
  return { modulePath, platformPackage, executable: null };
}

/**
 * The `typescript` package's own version — the compiler that printed every type
 * in the document, stamped so the answer survives the run.
 */
export function compilerVersion(): string {
  const { modulePath } = compilerPaths();
  if (!modulePath) return "unknown";
  try {
    const pkg = JSON.parse(readFileSync(modulePath, "utf8")) as { version?: string };
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

function bundledTsgoBinary(): string | null {
  return compilerPaths().executable;
}

// ── the overlay ──────────────────────────────────────────────────────────────

/**
 * THE TWO SPELLINGS OF THE REPO ROOT, and why the overlay is indexed under both.
 *
 * tsgo canonicalises before it reads. Measured: a package reached through a
 * `node_modules` symlink is `realpath`'d first and then read under its canonical
 * name, so an intra-repo symlink is not a problem. The ROOT is: on macOS
 * `$TMPDIR` is `/var/folders/…`, a symlink to `/private/var/folders/…`, and tsgo
 * asks for BOTH spellings within a single program — the tsconfig's own files
 * under the given spelling, anything reached by module resolution under the
 * canonical one.
 *
 * An overlay indexed under one spelling therefore MISSES the other, falls
 * through to the real filesystem, and serves head content on the base side.
 * There is no error and no empty result: the base view silently becomes the head
 * view and the delta disappears. That is the 227-phantom-deltas failure class
 * reached from a new direction, and it was reproduced in this checkout before
 * this function existed.
 *
 * Indexing both prefixes is O(overlay entries) and costs no syscall per read,
 * which matters: the `readFile` callback is a synchronous round trip to the Go
 * child and fires ~5,500 times building `apps/server` (measured: 215 ms → 309 ms
 * with an overlay attached — the callback is affordable, a `realpath` inside it
 * would not be).
 */
function buildOverlayIndex(
  repo: string,
  realRepo: string,
  overlay: Overlay,
): Map<string, string | null> {
  const index = new Map<string, string | null>();
  for (const [key, contents] of overlay) {
    const absolute = isAbsolute(key) ? resolve(key) : resolve(repo, key);
    index.set(absolute, contents);
    if (realRepo !== repo && absolute.startsWith(repo)) {
      index.set(join(realRepo, relative(repo, absolute)), contents);
    }
    if (realRepo !== repo && absolute.startsWith(realRepo)) {
      index.set(join(repo, relative(realRepo, absolute)), contents);
    }
  }
  return index;
}

/**
 * `readFile` + `fileExists` only, deliberately.
 *
 * `getAccessibleEntries` is NOT overridden. A file the overlay deletes still
 * appears in the directory listing and therefore still appears in
 * `Project.rootFiles` — but a `readFile` of `null` is enough to keep it out of
 * the PROGRAM (measured: `rootFiles` contains it, `getSourceFile` does not
 * return it, with and without the `fileExists` hook), and membership of the
 * program is what `lookup` answers from. Implementing the directory hook would
 * mean a real `readdir` per directory over the pipe to subtract a handful of
 * names, for no change in any answer this module gives.
 *
 * `fileExists` is supplied anyway. It costs one extra callback branch, it keeps
 * module RESOLUTION from finding a base-side file that the PR added — which
 * `readFile` alone is not documented to cover — and a deleted file that some
 * future code path probes for existence must not answer yes.
 */
function overlayFileSystem(index: ReadonlyMap<string, string | null>): FileSystem {
  return {
    readFile: (fileName) => (index.has(fileName) ? (index.get(fileName) ?? null) : undefined),
    fileExists: (fileName) => (index.has(fileName) ? index.get(fileName) !== null : undefined),
  };
}

// ── opening a snapshot ───────────────────────────────────────────────────────

/**
 * tsgo's inferred project is reported under a sentinel `configFileName` that is
 * not a path on any filesystem. Matched rather than parsed, because a future
 * spelling should read as "an unrecognised configured project" (and be reported
 * as such) rather than be silently mistaken for a real tsconfig.
 */
const INFERRED_PROJECT_CONFIG = "/dev/null/inferred";

function toRepoRelative(repo: string, realRepo: string, absolute: string): string | null {
  for (const root of realRepo === repo ? [repo] : [repo, realRepo]) {
    const rel = relative(root, absolute);
    if (rel !== "" && !rel.startsWith("..") && !isAbsolute(rel)) return rel.split("\\").join("/");
  }
  return null;
}

/**
 * Open one compiler snapshot over `repo` and hand back the projects, a
 * path→program index, and the teardown.
 *
 * Call it twice with identical `tsConfigPaths` / `openFiles` and an `overlay` on
 * one of them to get a symmetric base/head pair. The two sides are two child
 * processes — the virtual filesystem is fixed at construction, so one API
 * instance cannot serve both views.
 *
 * @throws {TsgoError} `binary-unresolvable` / `binary-not-executable` before
 *   anything is spawned, and `snapshot-failed` if the child cannot answer. A
 *   per-tsconfig failure does NOT throw: it excludes that project and is named
 *   in `degraded` and `failures`.
 */
export function openSnapshot(options: OpenSnapshotOptions): EngineSnapshot {
  const log = options.log ?? noopLogger;
  const repo = resolve(options.repo);
  const realRepo = safeRealpath(repo);
  const overlay = options.overlay ?? null;
  const overlaid = overlay !== null && overlay.size > 0;

  const tsConfigPaths = (options.tsConfigPaths ?? []).map((p) =>
    isAbsolute(p) ? resolve(p) : resolve(repo, p),
  );
  const openFiles = (options.openFiles ?? []).map((p) =>
    isAbsolute(p) ? resolve(p) : resolve(repo, p),
  );

  const exe = resolveTsgoBinary(options.tsgoPath);
  let api: API;
  try {
    api = new API({
      cwd: repo,
      ...(exe ? { tsserverPath: exe } : {}),
      ...(overlaid ? { fs: overlayFileSystem(buildOverlayIndex(repo, realRepo, overlay)) } : {}),
    });
  } catch (err) {
    // Only the platform package matching the host installs, so a linux image
    // that did not install its own gets a `typescript` that imports fine and a
    // compiler that does not exist. `getExePath()` throws for that; without this
    // it would surface as a bare error rather than as a named engine failure.
    throw new TsgoError(
      "binary-unresolvable",
      `no tsgo executable is available for ${process.platform}-${process.arch}: ${reasonOf(err)}. The compiler ships as the optional dependency \`@typescript/typescript-${process.platform}-${process.arch}\`, and only the matching one installs — nothing type-aware can run without it`,
    );
  }

  let disposed = false;
  const dispose = (): void => {
    if (disposed) return;
    disposed = true;
    try {
      api.close();
    } catch (err) {
      // The child may already be gone. A teardown that throws would mask the
      // real failure the `finally` is unwinding.
      log.debug("tsgo api close failed", { err: reasonOf(err) });
    }
  };

  let projects: readonly Project[];
  try {
    const snapshot = api.updateSnapshot({
      ...(tsConfigPaths.length > 0 ? { openProjects: [...tsConfigPaths] } : {}),
      ...(openFiles.length > 0 ? { openFiles: [...openFiles] } : {}),
    });
    projects = snapshot.getProjects();
  } catch (err) {
    dispose();
    throw new TsgoError(
      "snapshot-failed",
      `the tsgo compiler could not build a snapshot of ${repo}: ${reasonOf(err)}`,
    );
  }

  const degraded: DegradedEntry[] = [];
  const failures: TsgoProjectFailure[] = [];
  /**
   * Keyed REPO-RELATIVE, not by the absolute string that was requested.
   *
   * `configFileName` comes back from the Go side, and matching it verbatim
   * would make the two spellings of the repo root (see `buildOverlayIndex`)
   * report a perfectly healthy tsconfig as `tsconfig-absent`. A wrong
   * `degraded[]` entry is worse than a missing one: it is loud, it is precise,
   * and it sends a reader after a coverage gap that is not there.
   */
  const byConfig = new Map<string, Project>();
  let inferred: Project | null = null;
  for (const project of projects) {
    if (project.configFileName === INFERRED_PROJECT_CONFIG) inferred = project;
    else {
      const rel = toRepoRelative(repo, realRepo, project.configFileName);
      byConfig.set(rel ?? project.configFileName, project);
    }
  }

  const usable: EngineProject[] = [];
  for (const tsConfigPath of tsConfigPaths) {
    const rel = toRepoRelative(repo, realRepo, tsConfigPath) ?? tsConfigPath;
    const project = byConfig.get(rel);
    if (!project) {
      // Silent by default: a tsconfig that does not exist simply never appears
      // in `getProjects()`, and a short list looks like nothing at all.
      failures.push({ tsConfigPath: rel, reason: "tsconfig-absent", detail: null });
      degraded.push({
        extractor: "tsgo",
        reason: `the tsconfig \`${rel}\` was opened but the compiler returned no project for it — the files it covers are NOT in this snapshot`,
      });
      continue;
    }
    const errors = project.program
      .getConfigFileParsingDiagnostics()
      .filter((d) => d.category === DiagnosticCategory.Error);
    if (errors.length > 0) {
      // A broken build config must NOT be silently promoted to tier 1. tsgo
      // recovers a usable-looking project from an unparseable tsconfig and
      // reports the failure only here, so the files are abandoned rather than
      // analysed under a configuration nobody wrote.
      const detail = errors[0]?.text ?? null;
      failures.push({ tsConfigPath: rel, reason: "tsconfig-unparsable", detail });
      degraded.push({
        extractor: "tsgo",
        reason: `the tsconfig \`${rel}\` produced ${errors.length} config parsing error${errors.length === 1 ? "" : "s"} (${detail ?? "no detail"}) — the files it covers were abandoned rather than analysed under a guessed configuration`,
      });
      continue;
    }
    usable.push({
      tsConfigPath: rel,
      inferred: false,
      project,
      fileCount: project.program.getSourceFileNames().length,
      rootFileCount: project.rootFiles.length,
    });
  }

  if (inferred) {
    usable.push({
      tsConfigPath: null,
      inferred: true,
      project: inferred,
      fileCount: inferred.program.getSourceFileNames().length,
      rootFileCount: inferred.rootFiles.length,
    });
  }

  /**
   * Each project's contents, REPO-RELATIVE, fetched once.
   *
   * `getSourceFileNames()` is a round trip to the Go child returning one entry
   * per program file — 9,388 of them across this monorepo's seven tsconfigs —
   * and both the `openFiles` audit below and the lookup index need it. Keying
   * repo-relative also sidesteps the two-spellings trap a third time: an
   * `openFiles` entry spelled through a symlinked root would not match the
   * canonical name the program reports, and the file would be reported as
   * landing nowhere while sitting happily in a program.
   */
  const contents = new Map<EngineProject, Map<string, string>>();
  /**
   * Repo-relative path → the ABSOLUTE spelling this program reported it under.
   *
   * Both halves are load-bearing. The key has to be repo-relative so the two
   * spellings of the root compare equal; the value has to be the program's own
   * spelling, because `program.getSourceFile()` is a lookup in that program's
   * file map and a path rebuilt from the other spelling misses it — silently,
   * returning `undefined`, which `lookup` would then report as "no program
   * holds this file".
   */
  const namesOf = (owner: EngineProject): Map<string, string> => {
    const cached = contents.get(owner);
    if (cached) return cached;
    const names = new Map<string, string>();
    for (const absolutePath of owner.project.program.getSourceFileNames()) {
      const rel = toRepoRelative(repo, realRepo, absolutePath);
      if (rel && !names.has(rel)) names.set(rel, absolutePath);
    }
    contents.set(owner, names);
    return names;
  };

  /**
   * WHICH `openFiles` actually landed where, counted rather than assumed.
   *
   * `openFiles` is not a request for an inferred project — it is LSP `didOpen`
   * semantics. A file an ancestor tsconfig turns out to contain loads that
   * CONFIGURED project instead, and only the remainder falls through. Reporting
   * `openFiles.length` as the inferred count would over-state the shortfall in
   * `degraded[]`, which is the same sin as under-stating it: an entry that is
   * populated on every run has stopped carrying signal.
   */
  if (openFiles.length > 0) {
    const inInferred: string[] = [];
    const nowhere: string[] = [];
    for (const file of openFiles) {
      const rel = toRepoRelative(repo, realRepo, file) ?? file;
      const holder = usable.find((owner) => namesOf(owner).has(rel));
      if (!holder) nowhere.push(rel);
      else if (holder.inferred) inInferred.push(rel);
    }
    if (inInferred.length > 0) {
      degraded.push({
        extractor: "tsgo",
        reason: `${inInferred.length} file${inInferred.length === 1 ? " is" : "s are"} covered by no tsconfig and ${inInferred.length === 1 ? "was" : "were"} analysed in tsgo's inferred project — DEFAULT compiler options, so none of this repository's \`paths\`, \`strict\` or \`jsx\` applied: ${inInferred.slice(0, 5).join(", ")}${inInferred.length > 5 ? ", …" : ""}`,
      });
    }
    if (nowhere.length > 0) {
      // Opened and then held by nothing. Reachable for a path that does not
      // exist, one the overlay deleted, and one no compiler will parse — and
      // without this line it reads exactly like a file with no findings.
      degraded.push({
        extractor: "tsgo",
        reason: `${nowhere.length} file${nowhere.length === 1 ? " was" : "s were"} opened but ended up in no program at all, so nothing type-aware was computed for ${nowhere.length === 1 ? "it" : "them"}: ${nowhere.slice(0, 5).join(", ")}${nowhere.length > 5 ? ", …" : ""}`,
      });
    }
  }

  log.debug("tsgo snapshot opened", {
    repo,
    overlaid,
    requested: tsConfigPaths.length,
    projects: usable.length,
    failures: failures.length,
  });

  let index: Map<string, { owner: EngineProject; absolutePath: string; isRootFile: boolean }> | null =
    null;

  /**
   * Built on first use, in two passes, so that ROOT membership beats transitive
   * membership: a file compiled as a root of `packages/a` is owned by
   * `packages/a` even when `packages/b` also pulled it in through an import.
   * That is the "reference queries stay inside their own program" rule made
   * mechanical — a query run in the importing program would see the importer's
   * references and none of the declaration's own.
   */
  const ensureIndex = (): Map<
    string,
    { owner: EngineProject; absolutePath: string; isRootFile: boolean }
  > => {
    if (index) return index;
    const built = new Map<
      string,
      { owner: EngineProject; absolutePath: string; isRootFile: boolean }
    >();
    const members = usable.map((owner) => {
      const names = namesOf(owner);
      // A root the overlay deleted is still listed in `rootFiles` but is NOT in
      // the program (measured), so root membership is intersected with the
      // program rather than trusted on its own.
      const roots: string[] = [];
      for (const rootFile of owner.project.rootFiles) {
        const rel = toRepoRelative(repo, realRepo, rootFile);
        if (rel && names.has(rel)) roots.push(rel);
      }
      return { owner, names, roots };
    });
    for (const { owner, names, roots } of members) {
      for (const rel of roots) {
        const absolutePath = names.get(rel);
        if (absolutePath && !built.has(rel))
          built.set(rel, { owner, absolutePath, isRootFile: true });
      }
    }
    for (const { owner, names } of members) {
      for (const [rel, absolutePath] of names) {
        if (!built.has(rel)) built.set(rel, { owner, absolutePath, isRootFile: false });
      }
    }
    index = built;
    return built;
  };

  return {
    repo,
    projects: usable,
    overlaid,
    degraded,
    failures,
    lookup(path: string): EngineFile | null {
      const absolute = isAbsolute(path) ? resolve(path) : resolve(repo, path);
      const rel = toRepoRelative(repo, realRepo, absolute);
      if (!rel) return null;
      const hit = ensureIndex().get(rel);
      if (!hit) return null;
      const sourceFile = hit.owner.project.program.getSourceFile(hit.absolutePath);
      if (!sourceFile) return null;
      return {
        path: rel,
        absolutePath: hit.absolutePath,
        owner: hit.owner,
        sourceFile,
        isRootFile: hit.isRootFile,
      };
    },
    dispose,
  };
}

function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * `deps` — manifest delta and staged source.
 *
 * **This is the affordance fix, not a nicety.** The review workspace has no
 * `node_modules`, so "open the library source" was STRUCTURALLY IMPOSSIBLE —
 * the model read the instruction, could not act on it, and moved on
 * (00-evidence §3). Staging the dependency at its locked version turns that
 * into a one-`read` action, and when v3 did it the model immediately started
 * quoting implementation lines.
 *
 * Two v3 bug fixes are carried forward here, and both are load-bearing:
 *
 *  1. **The tooling denylist must not use an `^eslint` PREFIX.** It swallowed
 *     `eslint-plugin-require-extensions` — the exact package the `1641-r2` gold
 *     lives in. Lint and format packages appear in added imports precisely when
 *     a config IS the diff, i.e. when they are the subject. So `tooling` is an
 *     EXACT-MATCH HINT that is emitted, never a filter that drops.
 *  2. **The import scan must recognise `createRequire(...)("pkg")`**, which is
 *     how the `1641-r2` plugin was actually loaded.
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DegradedEntry, DepChange, DepsPayload, Ecosystem, ManifestRef } from "./schema.js";
import { showFile } from "./git.js";
import type { ChangedFileIndex } from "./facts.js";
import type { DeclaredMap } from "./manifests.js";
import { ecosystemOf, parseManifest, ROOT_MANIFEST_NAMES } from "./manifests.js";
import type { LoggerPort } from "./log.js";
import { noopLogger } from "./log.js";

/**
 * Build/lint/format packages, by EXACT NAME. Never a prefix — see the header.
 * A package not on this list is not assumed interesting either; the flag is a
 * hint for ranking, and every changed dependency is emitted regardless.
 */
const TOOLING_PACKAGES = new Set([
  "eslint",
  "prettier",
  "tslint",
  "oxlint",
  "@biomejs/biome",
  "biome",
  "typescript",
  "tsx",
  "ts-node",
  "husky",
  "lint-staged",
  "nodemon",
  "rimraf",
  "npm-run-all",
  "concurrently",
  "turbo",
  "webpack",
  "vite",
  "rollup",
  "esbuild",
  "jest",
  "vitest",
  "mocha",
  "karma",
  "nyc",
  "c8",
  "stryker",
  "@stryker-mutator/core",
]);

export function isToolingPackage(name: string): boolean {
  return TOOLING_PACKAGES.has(name);
}

/**
 * Every module specifier in a source text, INCLUDING the two forms the v3
 * investigation found being missed. Regex rather than AST on purpose: `deps`
 * must work on tier 3, where there is no project and possibly no parser for
 * the language at all.
 */
const SPECIFIER_RES: RegExp[] = [
  /\bimport\s[\s\S]{0,400}?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*["']([^"']+)["']/g,
  /\bexport\s[\s\S]{0,400}?\bfrom\s*["']([^"']+)["']/g,
  /\bimport\s*\(\s*["']([^"']+)["']/g,
  /\brequire\s*\(\s*["']([^"']+)["']/g,
  // `createRequire(import.meta.url)("eslint-plugin-require-extensions")` — the
  // direct form. The two-step form (`const req = createRequire(...)`) is caught
  // by the `require(` pattern above.
  /\bcreateRequire\s*\([^)]*\)\s*\(\s*["']([^"']+)["']/g,
];

/** `@scope/pkg/sub` → `@scope/pkg`; `pkg/sub` → `pkg`; relative → `null`. */
export function packageNameOf(specifier: string): string | null {
  if (specifier.startsWith(".") || specifier.startsWith("/") || specifier.startsWith("node:")) {
    return null;
  }
  const parts = specifier.split("/");
  return specifier.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function scanImports(source: string): Map<string, number[]> {
  const out = new Map<string, number[]>();
  for (const regex of SPECIFIER_RES) {
    regex.lastIndex = 0;
    for (const match of source.matchAll(regex)) {
      const name = packageNameOf(match[1]);
      if (!name) continue;
      const line = source.slice(0, match.index).split("\n").length;
      const lines = out.get(name) ?? [];
      if (!lines.includes(line)) lines.push(line);
      out.set(name, lines);
    }
  }
  return out;
}

/**
 * The version actually installed / locked, preferred over the manifest range —
 * `npm pack pkg@^1.2.3` resolves to whatever is newest today, which is not what
 * the PR would run. Falls back to the range when nothing better is available.
 */
export function lockedVersion(repo: string, name: string, range: string | null): string | null {
  const installed = join(repo, "node_modules", name, "package.json");
  if (existsSync(installed)) {
    try {
      const pkg = JSON.parse(readFileSync(installed, "utf8")) as { version?: string };
      if (pkg.version) return pkg.version;
    } catch {
      /* fall through */
    }
  }
  const npmLock = join(repo, "package-lock.json");
  if (existsSync(npmLock)) {
    try {
      const lock = JSON.parse(readFileSync(npmLock, "utf8")) as {
        packages?: Record<string, { version?: string }>;
      };
      const entry = lock.packages?.[`node_modules/${name}`];
      if (entry?.version) return entry.version;
    } catch {
      /* fall through */
    }
  }
  const pnpmLock = join(repo, "pnpm-lock.yaml");
  if (existsSync(pnpmLock)) {
    try {
      const raw = readFileSync(pnpmLock, "utf8");
      const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      const match = new RegExp(`^\\s{2}${escaped}@(\\d[^:(\\s]*)`, "m").exec(raw);
      if (match) return match[1];
    } catch {
      /* fall through */
    }
  }
  return range ? range.replace(/^[\^~>=<\s]+/, "") || null : null;
}

export interface ExtractDepsOptions {
  repo: string;
  base: string;
  head: string;
  hunkIndex: Map<string, ChangedFileIndex>;
  /** Force ONE manifest instead of discovering them. */
  manifestPath?: string;
  /** Run `npm pack` and unpack the changed runtime deps. NETWORK. Opt-in. */
  stage?: boolean;
  stageDir?: string;
  log?: LoggerPort;
}

export interface ExtractDepsResult {
  payload: DepsPayload;
  degraded: DegradedEntry[];
}

export const DEFAULT_STAGE_DIR = ".lastlight/pr-review/deps";

/**
 * Which manifests this run reads: **the ones the diff touched, plus the root.**
 *
 * Not "every manifest in the repo" — cal.com has 140 `package.json` files, and
 * a delta computed across all of them is a delta about the monorepo rather than
 * about the PR. Not "the root" alone either, which is what it used to be:
 * grafana changes `package.json` and `go.mod` in a single PR, and a scan pinned
 * to one file reports half of it as though that were all of it.
 *
 * The root is always included even when untouched, because it is where a
 * single-module repo declares everything, and because its ABSENCE is how we
 * learn a repo is not npm at all.
 */
export function discoverManifests(
  repo: string,
  base: string,
  head: string,
  changedPaths: Iterable<string>,
): ManifestRef[] {
  const found = new Map<string, Ecosystem>();
  for (const path of changedPaths) {
    const ecosystem = ecosystemOf(path);
    if (ecosystem) found.set(path, ecosystem);
  }
  for (const name of ROOT_MANIFEST_NAMES) {
    if (found.has(name)) continue;
    const ecosystem = ecosystemOf(name);
    if (!ecosystem) continue;
    if (showFile(repo, head, name) !== null || showFile(repo, base, name) !== null) {
      found.set(name, ecosystem);
    }
  }
  return [...found.entries()]
    .map(([path, ecosystem]) => ({ path, ecosystem }))
    .sort((a, b) => a.path.localeCompare(b.path));
}

export function extractDeps(options: ExtractDepsOptions): ExtractDepsResult {
  const log = options.log ?? noopLogger;
  const degraded: DegradedEntry[] = [];

  const manifests = options.manifestPath
    ? [
        {
          path: options.manifestPath,
          ecosystem: ecosystemOf(options.manifestPath) ?? ("npm" as const),
        },
      ]
    : discoverManifests(options.repo, options.base, options.head, options.hunkIndex.keys());

  if (manifests.length === 0) {
    degraded.push({
      extractor: "deps",
      reason: `no dependency manifest at base or head — looked for ${ROOT_MANIFEST_NAMES.join(", ")} at the repository root and for any manifest the diff touched. The dependency delta was NOT computed, so an empty change list here means unknown, not unchanged`,
    });
    return { payload: { manifests: [], changes: [] }, degraded };
  }

  // Imports across the whole changed set, so a dependency added to the manifest
  // can be tied to the line that uses it. JS/TS specifiers only — a Java
  // `import org.foo.Bar` names a package, not an artifact, and guessing the
  // artifact from it would tie a dependency to a line that does not load it.
  const importsByPackage = new Map<string, string[]>();
  for (const path of options.hunkIndex.keys()) {
    const source = showFile(options.repo, options.head, path);
    if (!source) continue;
    for (const [name, lines] of scanImports(source)) {
      const sites = importsByPackage.get(name) ?? [];
      for (const line of lines) sites.push(`${path}:${line}`);
      importsByPackage.set(name, sites);
    }
  }

  const changes: DepChange[] = [];
  const read: ManifestRef[] = [];

  for (const manifest of manifests) {
    const before = parseManifest(
      manifest.ecosystem,
      showFile(options.repo, options.base, manifest.path),
      manifest.path,
    );
    const after = parseManifest(
      manifest.ecosystem,
      showFile(options.repo, options.head, manifest.path),
      manifest.path,
    );
    if (!before && !after) {
      degraded.push({
        extractor: "deps",
        reason: `${manifest.path} could not be read as ${manifest.ecosystem} at either base or head — its dependency delta is UNKNOWN, not empty`,
      });
      continue;
    }
    read.push(manifest);
    changes.push(...diffDeclared(manifest, before, after, importsByPackage));
  }

  changes.sort(
    (a, b) =>
      a.manifest.localeCompare(b.manifest) ||
      a.name.localeCompare(b.name) ||
      a.scope.localeCompare(b.scope),
  );

  if (options.stage) stage(options, changes, degraded, log);

  return { payload: { manifests: read, changes }, degraded };
}

function diffDeclared(
  manifest: ManifestRef,
  before: DeclaredMap | null,
  after: DeclaredMap | null,
  importsByPackage: Map<string, string[]>,
): DepChange[] {
  const out: DepChange[] = [];
  const names = new Set([...(before?.keys() ?? []), ...(after?.keys() ?? [])]);
  for (const name of names) {
    const from = before?.get(name) ?? null;
    const to = after?.get(name) ?? null;
    if (from && to && from.version === to.version && from.scope === to.scope) continue;
    out.push({
      name,
      scope: (to ?? from)!.scope,
      change: !from ? "added" : !to ? "removed" : "bumped",
      before: from?.version ?? null,
      after: to?.version ?? null,
      manifest: manifest.path,
      ecosystem: manifest.ecosystem,
      tooling: isToolingPackage(name),
      importedAt: (importsByPackage.get(name) ?? []).sort(),
      stagedAt: null,
    });
  }
  return out;
}

/**
 * `--stage` is **npm-only**, and every other ecosystem says so out loud.
 *
 * There is no `npm pack` for Maven or Bundler here: fetching a jar or a gem
 * needs that ecosystem's client, its credentials and its own egress allowlist
 * entry, none of which this package has. The affordance being missing is a
 * documented fact — one entry per ecosystem, not one per package, because a
 * degraded list with sixty identical lines in it is a list nobody reads.
 */
function stage(
  options: ExtractDepsOptions,
  changes: DepChange[],
  degraded: DegradedEntry[],
  log: LoggerPort,
): void {
  const stageDir = options.stageDir ?? join(options.repo, DEFAULT_STAGE_DIR);
  const unstageable = new Set<Ecosystem>();

  for (const change of changes) {
    if (change.scope !== "dependencies" || change.change === "removed") continue;
    if (change.ecosystem !== "npm") {
      unstageable.add(change.ecosystem);
      continue;
    }
    const version = lockedVersion(options.repo, change.name, change.after);
    if (!version) continue;
    const staged = stagePackage(stageDir, change.name, version);
    if (staged.path) {
      change.stagedAt = staged.path;
      log.debug("code-facts staged dependency", { name: change.name, version });
    } else if (staged.reason) {
      degraded.push({ extractor: "deps", reason: staged.reason });
    }
  }

  for (const ecosystem of [...unstageable].sort()) {
    degraded.push({
      extractor: "deps",
      reason: `--stage is npm-only: ${ecosystem} dependencies were NOT staged (stagedAt: null), so "open the library source" is still structurally impossible for them in the review workspace`,
    });
  }
}

/**
 * `npm pack <pkg>@<version>` into a temp dir, then unpack under `stageDir`.
 *
 * Registries are already on the sandbox's strict egress allowlist, so this
 * needs no firewall change. A failure degrades loudly and never throws — the
 * affordance being missing is a documented fact, not a reason to fail a run
 * that would then be re-dispatched every thirty minutes (§D12).
 */
function stagePackage(
  stageDir: string,
  name: string,
  version: string,
): { path: string | null; reason?: string } {
  const scratch = mkdtempSync(join(tmpdir(), "lastlight-facts-pack-"));
  try {
    const packed = spawnSync("npm", ["pack", `${name}@${version}`, "--pack-destination", scratch], {
      encoding: "utf8",
      timeout: 120_000,
    });
    if (packed.status !== 0) {
      return {
        path: null,
        reason: `npm pack ${name}@${version} failed: ${(packed.stderr || packed.error?.message || "unknown").trim().split("\n").slice(-1)[0]}`,
      };
    }
    const tarball = readdirSync(scratch).find((entry) => entry.endsWith(".tgz"));
    if (!tarball) return { path: null, reason: `npm pack ${name}@${version} produced no tarball` };

    const target = join(stageDir, name);
    mkdirSync(target, { recursive: true });
    const extracted = spawnSync(
      "tar",
      ["-xzf", join(scratch, tarball), "-C", target, "--strip-components=1"],
      { encoding: "utf8", timeout: 120_000 },
    );
    if (extracted.status !== 0) {
      return {
        path: null,
        reason: `unpacking ${name}@${version} failed: ${(extracted.stderr || "unknown").trim()}`,
      };
    }
    return { path: target };
  } catch (err) {
    return {
      path: null,
      reason: `staging ${name}@${version} failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

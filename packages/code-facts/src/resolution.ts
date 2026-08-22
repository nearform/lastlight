/**
 * SELECTIVE MODULE RESOLUTION — an allow-list computed before any program is
 * built, and the `resolutionHost` that enforces it.
 *
 * **`changed` is the DEFAULT.** It stopped being a prototype when a 50-run
 * sweep (5 commits × installed/bare × 5 tiers) made it strictly dominant. Read
 * CLAUDE.md's "WHERE THE MEMORY GOES" for the whole table; the three lines that
 * decided it, peak RSS in MB on an INSTALLED tree of this repo, on commits with
 * 3 / 22 / 22 / 46 / 158 analysable changed files:
 *
 * ```
 * full     3699 / 3902 / 4347-OOM / 3481 / 4430   over the 2 GB agent cap on
 *                                                 every one, and one exit 134
 * changed  1022 / 1274 / 1600     / 1387 / 2157   under it on four of five
 * none      818 /  926 / 1320     / 1215 / 1277
 * ```
 *
 * and it costs **nothing measurable in fidelity**: against the `full` baseline
 * over 499 contract entries on the two largest commits, `changed` reported the
 * same entry count, the IDENTICAL key set, zero entries whose type text
 * differed and zero that gained an `any`. `none` on the same two lost type text
 * on 78 and 56 entries respectively.
 *
 * ```
 * full     the escape hatch. Every bare specifier resolves.
 * changed  DEFAULT. Only what the CHANGED FILES import, base ∪ head.
 * none     the emergency brake. No bare specifier resolves at all.
 * ```
 *
 * Two intermediate tiers — `workspace` (changed + the repo's own package names
 * + anything landing outside `node_modules`) and `hop` (one transitive hop
 * through the allowed packages' type entry points) — were built, measured and
 * **cut**. They bought no memory over `changed` (1057–2182 and 1106–2349 MB on
 * the same five commits) while `hop` had to open hundreds of package manifests
 * to do it. A dominated option in a list is an invitation to pick it.
 *
 * ## The one invariant that makes any of this safe
 *
 * **The allow-list is the UNION of base and head, and the SAME object is handed
 * to both programs.** `contracts` compiles a head program and a base program in
 * a temp worktree and compares them; a per-side allow-list would make `foo`
 * resolve at head and collapse to `any` at base for no reason other than which
 * side happened to import it. That is precisely the asymmetry that produced
 * WP1's 227 deltas of which one was real, and it is the reason
 * `computeResolutionPolicy` reads BOTH blobs of every changed file rather than
 * the working tree's copy. `tests/resolution.test.ts` pins it with a fixture
 * whose head adds an import the base does not have.
 *
 * The second hazard is subtler and is NOT closed by the union: a package that
 * exists at head and not at base still resolves on one side only. That is what
 * `mirrorNodeModules` is for, and it stays load-bearing at the default —
 * `changed` still resolves, so the two sides can still disagree about what is
 * on disk. `none` is the only setting that makes both sides symmetrically
 * blind, which is exactly why it is also the only one that makes the mirror
 * redundant.
 *
 * ## What `changed` can still lose, stated precisely
 *
 * Not "lossless by construction" — that over-claims. A changed file's exported
 * type can be INFERRED through an unchanged neighbour that imports a package
 * the changed files never name (`export const out = shared`, where `shared`
 * comes from a file importing `zod`). Under this tier that renders `any`.
 *
 * What IS true by construction is that it renders `any` on **both** sides, so
 * it never manufactures a delta — it can only mask one between two external
 * types. `makeIndirectExternalFixture` is that shape, and
 * `tests/resolution.test.ts` pins both halves: the type text is lost, and the
 * untouched export does not move. On this repo the shape did not occur once in
 * 499 entries.
 */
import { resolve, sep } from "node:path";
import { ts, type ResolutionHostFactory } from "ts-morph";
import type { ChangedPath } from "./git.js";
import { showFile } from "./git.js";
import type { LoggerPort } from "./log.js";
import { noopLogger } from "./log.js";
import { hasAnalysableExtension } from "./project.js";
import type { DegradedEntry } from "./schema.js";
import { scanImportSpecifiers } from "./syntactic.js";

export const RESOLUTION_TIERS = ["full", "changed", "none"] as const;
export type ResolutionTier = (typeof RESOLUTION_TIERS)[number];

/**
 * The measured default. `full` OOMs on an installed tree and `changed` costs
 * nothing against it on this repo's contract entries — see the header.
 */
export const DEFAULT_RESOLUTION_TIER: ResolutionTier = "changed";

export function isResolutionTier(value: string): value is ResolutionTier {
  return (RESOLUTION_TIERS as readonly string[]).includes(value);
}

export interface ResolutionPolicy {
  tier: ResolutionTier;
  /**
   * Package names the checker may follow — `zod`, `@fixture/ext`, `fs`.
   * Never a path: the gate is on the SPECIFIER, so it reads the same from every
   * containing file and from both worktrees.
   */
  allow: ReadonlySet<string>;
  /**
   * Admit a resolution whose target is not under any `node_modules` directory,
   * whatever its specifier. This is the first-party clause: pnpm symlinks a
   * workspace package into `node_modules` and TypeScript realpaths it back out
   * (`preserveSymlinks` is off by default), so `lastlight-shared` lands in
   * `packages/shared/…` and costs the closure nothing.
   */
  allowFirstParty: boolean;
}

/** The escape hatch: resolve everything, and install no host at all. */
export const FULL_RESOLUTION: ResolutionPolicy = {
  tier: "full",
  allow: new Set(),
  allowFirstParty: true,
};

/**
 * The package a bare specifier names, or `null` when it is not bare.
 *
 * **Deliberately not `deps.packageNameOf`, and the difference is the point.**
 * That one returns `null` for `node:fs`, correctly: a builtin is not a
 * DEPENDENCY and has no manifest entry to diff. Here a builtin is very much a
 * resolution — it lands on `@types/node`, which is one of the largest `.d.ts`
 * trees any repo pulls in — so `node:fs` is normalised to `fs` and the two
 * spellings share one allow entry. Admitting one and refusing the other would
 * be a coin toss dressed as a policy.
 */
export function specifierPackage(specifier: string): string | null {
  if (specifier.length === 0) return null;
  if (specifier.startsWith(".")) return null;
  // An absolute specifier (rare, and a `paths` mapping can produce one) is not
  // a package name and never reaches a node_modules lookup.
  if (specifier.startsWith("/") || /^[a-zA-Z]:[\\/]/.test(specifier)) return null;
  const bare = specifier.startsWith("node:") ? specifier.slice(5) : specifier;
  const parts = bare.split("/");
  if (bare.startsWith("@")) return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : bare;
  return parts[0];
}

const NODE_MODULES = `${sep}node_modules${sep}`;

export function isUnderNodeModules(path: string): boolean {
  return path.includes(NODE_MODULES) || path.includes("/node_modules/");
}

export interface ComputePolicyOptions {
  repo: string;
  tier: ResolutionTier;
  baseSha: string;
  headSha: string;
  changed: ChangedPath[];
  log?: LoggerPort;
}

export interface ComputedPolicy {
  policy: ResolutionPolicy;
  degraded: DegradedEntry[];
  /** What the allow-list is made of, so a measurement can show the mechanism. */
  stats: {
    /** Changed-file BLOBS read — up to two per file, one per side. */
    changedFilesRead: number;
    changedFilesUnparsed: number;
    fromChanged: number;
  };
}

/**
 * Build the allow-list. **Reads git blobs, never the working tree** — the same
 * argument `listFiles` makes: a reused review workspace is not always at head,
 * and an allow-list derived from the wrong tree is an allow-list with holes in
 * it that nothing downstream can see.
 */
export function computeResolutionPolicy(options: ComputePolicyOptions): ComputedPolicy {
  const log = options.log ?? noopLogger;
  const repo = resolve(options.repo);
  const stats = {
    changedFilesRead: 0,
    changedFilesUnparsed: 0,
    fromChanged: 0,
  };

  if (options.tier === "full") {
    return { policy: FULL_RESOLUTION, degraded: [], stats };
  }
  if (options.tier === "none") {
    return {
      policy: { tier: "none", allow: new Set(), allowFirstParty: false },
      degraded: [
        {
          extractor: "project",
          reason:
            "module resolution is BLOCKED for every bare specifier (--resolution none) — an externally-typed signature renders as `any` on BOTH sides of the contract comparison, so a delta between two external types is masked rather than reported. Type text sourced from a dependency is not evidence in this document",
        },
      ],
      stats,
    };
  }

  // ── T1: what the changed files import, base ∪ head ────────────────────────
  const allow = new Set<string>();
  const analysable = options.changed.filter((change) => hasAnalysableExtension(change.path));
  for (const change of analysable) {
    // BOTH sides, always. A specifier present only at head would otherwise
    // resolve there and collapse to `any` in the base worktree, which is the
    // phantom-delta shape this whole package is engineered against.
    for (const sha of [options.baseSha, options.headSha]) {
      const source = showFile(repo, sha, change.path);
      if (source === null) continue; // added at head / deleted at head — normal
      stats.changedFilesRead++;
      const specifiers = scanImportSpecifiers(change.path, source);
      if (specifiers === null) {
        stats.changedFilesUnparsed++;
        continue;
      }
      for (const specifier of specifiers) {
        const name = specifierPackage(specifier);
        if (name !== null) allow.add(name);
      }
    }
  }
  stats.fromChanged = allow.size;

  const degraded: DegradedEntry[] = [];
  if (stats.changedFilesUnparsed > 0) {
    degraded.push({
      extractor: "project",
      reason: `the module allow-list (--resolution ${options.tier}) could not read the imports of ${stats.changedFilesUnparsed} changed file blob(s) — every bare specifier they name resolves to \`any\` in both programs, so a contract entry sourced from one is not evidence`,
    });
  }

  // NOT a `degraded[]` entry. `changed` is measurably lossless — 499 contract
  // entries across the two largest commits of this repo, same count, identical
  // key set, zero gaining an `any` — so degrading on it would claim we failed
  // to see something we saw. It is stamped on the envelope's `resolution`
  // instead. `none` degrades (it genuinely masks), and so does a run whose
  // allow-list could not be read: that is the `changedFilesUnparsed` entry
  // above, and it stays.
  return { policy: { tier: "changed", allow, allowFirstParty: false }, degraded, stats };
}


/**
 * The `resolutionHost` that enforces a policy, or `undefined` at `full` — which
 * is what keeps T0 byte-identical to what shipped rather than "T0 plus a hook
 * that happens to allow everything".
 *
 * `resolveTypeReferenceDirectives` is gated by the same list. Without it a
 * single `/// <reference types="node" />` inside an allowed `.d.ts` re-opens
 * the whole `@types` tree the `types: []` compiler option exists to keep out.
 */
export function resolutionHostFor(policy: ResolutionPolicy): ResolutionHostFactory | undefined {
  if (policy.tier === "full") return undefined;

  return (moduleResolutionHost, getCompilerOptions) => {
    const cwd = moduleResolutionHost.getCurrentDirectory?.() ?? process.cwd();
    const canonical = (fileName: string): string => fileName;
    const moduleCache = ts.createModuleResolutionCache(cwd, canonical, getCompilerOptions());
    const directiveCache = ts.createTypeReferenceDirectiveResolutionCache(
      cwd,
      canonical,
      getCompilerOptions(),
    );

    const admit = <T extends { resolvedFileName?: string }>(
      specifier: string,
      resolveIt: () => T | undefined,
    ): T | undefined => {
      const name = specifierPackage(specifier);
      // A relative or absolute specifier is repo source. It is never the cost
      // this whole mechanism exists to bound, and refusing one would delete the
      // program rather than trim it.
      if (name === null) return resolveIt();
      if (policy.allow.has(name)) return resolveIt();
      // `none` refuses without resolving at all — the cheapest possible answer,
      // and the shape the full-block prototype measured.
      if (!policy.allowFirstParty) return undefined;
      // THE FIRST-PARTY CLAUSE. Resolving to find out where it lands costs file
      // system probes (cached) and no parse; what it buys is a pnpm workspace
      // link, which TypeScript realpaths out of `node_modules` into the repo.
      const resolved = resolveIt();
      const file = resolved?.resolvedFileName;
      if (resolved && file !== undefined && !isUnderNodeModules(file)) return resolved;
      return undefined;
    };

    return {
      resolveModuleNames(moduleNames, containingFile, _reusedNames, redirectedReference, options) {
        return moduleNames.map((moduleName) =>
          admit(moduleName, () =>
            ts.resolveModuleName(
              moduleName,
              containingFile,
              options,
              moduleResolutionHost,
              moduleCache,
              redirectedReference,
            ).resolvedModule,
          ),
        );
      },
      resolveTypeReferenceDirectives(
        typeDirectiveNames,
        containingFile,
        redirectedReference,
        options,
      ) {
        return (typeDirectiveNames as readonly (string | ts.FileReference)[]).map((entry) => {
          const name = typeof entry === "string" ? entry : entry.fileName;
          return admit(name, () =>
            ts.resolveTypeReferenceDirective(
              name,
              containingFile,
              options,
              moduleResolutionHost,
              redirectedReference,
              directiveCache,
            ).resolvedTypeReferenceDirective,
          );
        });
      },
    };
  };
}

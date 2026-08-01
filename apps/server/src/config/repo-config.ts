/**
 * Per-repository configuration — the `repo` config layer (issue #180).
 *
 * A managed repo may commit a `.lastlight/` directory that overrides a BOUNDED
 * subset of Last Light's config for runs against that repo. The directory
 * mirrors a deployment overlay's on-disk shape exactly:
 *
 *   .lastlight/
 *     lastlight.yml                  # the config override
 *     workflows/prompts/*.md         # prompt overrides
 *     skills/<name>/SKILL.md         # skill overrides
 *     agent-context/*.md             # persona/rules additions
 *
 * so the unpacked cache directory can be handed to the same layer-aware asset
 * loader the instance overlay uses, with no second code path.
 *
 * ── The trust rule ────────────────────────────────────────────────────────
 * The layer is ALWAYS read from the repo's **default branch**, resolved live
 * from the repo metadata. Never a PR head. Never the sandbox checkout. This is
 * the entire security model: without it, a pull request could commit a
 * `.lastlight/lastlight.yml` that re-points the model, disables the review
 * workflow and drops the approval gates of the very agent reviewing it. The
 * default branch is the one ref that has already passed the repo's own review
 * and branch-protection rules.
 *
 * ── The failure rule ──────────────────────────────────────────────────────
 * Warn, drop the bad bits, run anyway. A repo's config file must never fail a
 * run. Invalid YAML drops the whole file; an unknown or out-of-bounds key drops
 * just that key; a fetch error falls back to the last good cached copy (or to
 * no layer at all). Every rejection becomes a structured `RepoConfigWarning`
 * so the dashboard/CLI can report it back to the repo's owners.
 *
 * ── Layout ────────────────────────────────────────────────────────────────
 * This module owns the IMPURE half: the GitHub round-trip, the on-disk unpack
 * and the TTL cache. The pure half — the schema, the operator bounds, and every
 * validator/merger that enforces them — lives in
 * `packages/shared/src/repo-config-schema.ts`, because the `lastlight` CLI
 * needs exactly the same answers offline (`lastlight repo config validate`)
 * and may never gain a dependency edge to core. It is **re-exported wholesale**
 * below, so `src/config/repo-config.js` remains the single import surface for
 * everything about the repo layer.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "fs";
import { dirname, join, resolve, sep } from "path";
import {
  DEFAULT_REPO_CONFIG_ALLOW_KEYS,
  REPO_CONFIG_FILE,
  REPO_CONFIG_MAX_BYTES,
  REPO_CONFIG_MAX_FILES,
  isConfigSource,
  isRepoWorkflowPath,
  parseRepoConfigYaml,
  repoLayerPathKind,
  sanitizeRepoFiles,
  type ConfigSource,
  type RepoConfigBase,
  type RepoConfigPolicy,
  type RepoConfigWarning,
  type RepoLayer,
} from "lastlight-shared/repo-config-schema";
import { GitHubClient, type RepoConfigFile } from "../engine/github/github.js";
import { getRuntimeConfig, type LastLightConfig } from "./config.js";
import { logger } from "../logging/logger.js";

const log = logger("repo-config");

/**
 * The pure half, re-exported so every existing `src/config/repo-config.js`
 * import (`resolveRepoConfig`, `sanitizeRepoFiles`, `RepoConfigWarning`, the
 * bounds constants, …) keeps resolving unchanged after the move to
 * `lastlight-shared`.
 */
export * from "lastlight-shared/repo-config-schema";

// ---------------------------------------------------------------------------
// Bounds (cache-only — the rest live with the schema in lastlight-shared)
// ---------------------------------------------------------------------------

/** How long a fetched layer is trusted before we re-check with a conditional request. */
export const REPO_CONFIG_TTL_MS = 60_000;

/** Options for {@link fetchRepoLayer}. */
export interface FetchRepoLayerOptions {
  /** GitHub client to fetch through. Defaults to the harness client from runtime config. */
  client?: GitHubClient;
  /** Operator bounds. Defaults to {@link repoConfigPolicy}. */
  policy?: RepoConfigPolicy;
  /** Skip the TTL and issue the conditional request now. */
  force?: boolean;
  /** Cache root override. Defaults to `<stateDir>/repo-config`. */
  cacheRoot?: string;
}

// ---------------------------------------------------------------------------
// Policy access
// ---------------------------------------------------------------------------

/**
 * The operator's bounds from runtime config, with the shipped defaults when
 * config isn't loaded (unit tests, pre-boot code paths). Never throws.
 */
export function repoConfigPolicy(): RepoConfigPolicy {
  return (
    getRuntimeConfig()?.repoConfig ?? {
      enabled: true,
      allowKeys: [...DEFAULT_REPO_CONFIG_ALLOW_KEYS],
      allowedModels: null,
      allowAssets: true,
    }
  );
}

/**
 * Project the boot config into the {@link RepoConfigBase} the pure resolver
 * takes. `publicConfig.sources` is the provenance tree `loadConfig` already
 * built, so a leaf the repo does NOT override keeps its real boot provenance
 * ("overlay", "env", …) rather than being flattened to "default".
 *
 * EVERY repo-settable block must appear in BOTH `value` and `sources`. A block
 * missing from `value` has no operator value to merge onto or clamp against at
 * resolve time (the clamps then fall back to the shipped defaults, silently
 * ignoring an operator's own overlay); one missing from `sources` loses its
 * provenance. Adding a key to `repoConfig.allowKeys` without adding it here is
 * the quiet half of that mistake.
 */
export function repoConfigBaseFromRuntime(config: LastLightConfig): RepoConfigBase {
  const bootSources = isPlainObject(config.publicConfig?.sources) ? config.publicConfig.sources : {};
  return {
    value: {
      models: { ...config.models },
      variants: { ...config.variants },
      disabled: { ...config.disabled },
      approval: { ...(config.approval ?? {}) },
      fix: { ...config.fix },
      dependencies: { ...config.dependencies },
      review: { ...config.review },
    },
    sources: {
      models: expandSourceNode(bootSources.models, Object.keys(config.models)),
      variants: expandSourceNode(bootSources.variants, Object.keys(config.variants)),
      disabled: expandSourceNode(bootSources.disabled, Object.keys(config.disabled)),
      approval: expandSourceNode(bootSources.approval, Object.keys(config.approval ?? {})),
      // `?? {}` guards the partially-built configs tests cast into place; a real
      // boot config always carries all three blocks.
      fix: expandSourceNode(bootSources.fix, Object.keys(config.fix ?? {})),
      dependencies: expandSourceNode(bootSources.dependencies, Object.keys(config.dependencies ?? {})),
      review: expandSourceNode(bootSources.review, Object.keys(config.review ?? {})),
    },
  };
}

/**
 * Normalize one provenance sub-tree. `loadConfig` collapses a node to a single
 * source string when env replaced it wholesale (APPROVAL_GATES does exactly
 * this) — expand that back to per-key leaves so the repo merge attributes
 * key-by-key like every other node.
 */
function expandSourceNode(node: unknown, keys: string[]): Record<string, ConfigSource> {
  const out: Record<string, ConfigSource> = {};
  const flat = isConfigSource(node) ? node : undefined;
  for (const key of keys) out[key] = flat ?? "default";
  if (!flat && isPlainObject(node)) {
    for (const [k, v] of Object.entries(node)) if (isConfigSource(v)) out[k] = v;
  }
  return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** True when `filePath` resolves inside `root`. The last gate before {@link unpack} writes. */
function isInside(filePath: string, root: string): boolean {
  const r = resolve(root);
  const f = resolve(filePath);
  return f === r || f.startsWith(r + sep);
}

// ---------------------------------------------------------------------------
// Fetch + cache (impure)
// ---------------------------------------------------------------------------

/**
 * One repo's cache slot. `layer` is `undefined` for a NEGATIVE entry — the repo
 * was checked and has no `.lastlight/`. Distinguishing that from "never
 * checked" is what keeps a dispatch-per-comment workload off the GitHub API.
 */
interface CacheEntry {
  layer?: RepoLayer;
  /** Epoch ms of the last CHECK (a 304 refreshes this without re-downloading). */
  checkedAt: number;
}

const memoryCache = new Map<string, CacheEntry>();

/** Sidecar persisted next to the unpacked tree so a restart can still send a conditional request. */
interface RepoLayerSidecar {
  repo: string;
  defaultBranch: string;
  treeSha: string;
  etag?: string;
  fetchedAt: string;
  assets: string[];
  warnings: RepoConfigWarning[];
}

/**
 * Fetch (or serve from cache) a repo's `.lastlight/` layer.
 *
 * Never throws and never rejects: a GitHub failure degrades to the last good
 * cached layer, or to `undefined`. `undefined` means "no repo layer applies" —
 * the feature is off, the repo has no `.lastlight/`, there's no GitHub auth, or
 * the fetch failed with nothing cached.
 *
 * Cache behaviour: within {@link REPO_CONFIG_TTL_MS} the cached answer is
 * returned untouched. After that a CONDITIONAL request goes out; a
 * "not modified" answer just refreshes the timestamp, so the steady-state cost
 * of a cron fanning out over N repos is N conditional requests and zero
 * downloads.
 */
export async function fetchRepoLayer(
  repo: string,
  options: FetchRepoLayerOptions = {},
): Promise<RepoLayer | undefined> {
  const policy = options.policy ?? repoConfigPolicy();
  if (!policy.enabled) return undefined;

  const slug = parseRepoSlug(repo);
  if (!slug) {
    log.warn("Ignoring malformed repo name", { repo });
    return undefined;
  }

  const now = Date.now();
  const cached = memoryCache.get(repo);
  if (cached && !options.force && now - cached.checkedAt < REPO_CONFIG_TTL_MS) return cached.layer;

  const dir = repoCacheDir(repo, options.cacheRoot);
  // On a cold process the in-memory cache is empty but the sidecar isn't — read
  // it so the first request after a restart is still conditional.
  const prior = cached?.layer ?? readSidecar(dir);

  // Chat-only mode (no App, no PAT): there's nothing to fetch through. Serve
  // whatever is already unpacked rather than silently dropping the layer.
  const client = options.client ?? resolveRepoConfigClient();
  if (!client) return hydrate(repo, dir, prior);

  let result;
  try {
    result = await client.fetchRepoConfigTree(slug.owner, slug.repo, {
      etag: prior?.etag,
      treeSha: prior?.treeSha,
      maxFiles: REPO_CONFIG_MAX_FILES,
      maxBytes: REPO_CONFIG_MAX_BYTES,
      // Don't spend the byte budget on build-handoff docs, which share
      // `.lastlight/` in `buildAssets.location: repo` mode. Workflow YAML is
      // pulled in deliberately: it's rejected with a warning, not ignored.
      includePath: (p) => repoLayerPathKind(p) !== null || isRepoWorkflowPath(p),
    });
  } catch (err: unknown) {
    // Warn, keep the last good layer, run anyway.
    const message = err instanceof Error ? err.message : String(err);
    log.warn(".lastlight/ fetch failed — using the cached layer if any", { repo, err });
    const fallback = hydrate(repo, dir, prior);
    if (fallback) {
      fallback.warnings = [
        ...fallback.warnings,
        {
          code: "fetch-failed",
          repo,
          path: ".lastlight",
          message: `Could not refresh .lastlight/ from the default branch (${message}); using the last cached copy.`,
        },
      ];
    }
    memoryCache.set(repo, { layer: fallback, checkedAt: now });
    return fallback;
  }

  if (result.status === "absent") {
    clearRepoCacheDir(dir);
    memoryCache.set(repo, { layer: undefined, checkedAt: now });
    return undefined;
  }

  if (result.status === "not-modified") {
    const layer = hydrate(repo, dir, prior);
    memoryCache.set(repo, { layer, checkedAt: now });
    return layer;
  }

  const { accepted, warnings } = sanitizeRepoFiles(result.files, policy, repo);
  if (result.truncated) {
    warnings.push({
      code: "size-cap",
      repo,
      path: ".lastlight",
      message:
        `.lastlight/ was truncated at ${REPO_CONFIG_MAX_FILES} files / ${REPO_CONFIG_MAX_BYTES} bytes — ` +
        `some of it was not read.`,
    });
  }

  const root = unpack(dir, accepted);
  const configFile = accepted.find((f) => f.path === REPO_CONFIG_FILE);
  const parsed: { config?: Record<string, unknown>; warnings: RepoConfigWarning[] } = configFile
    ? parseRepoConfigYaml(configFile.content.toString("utf-8"), repo)
    : { warnings: [] };
  warnings.push(...parsed.warnings);

  const layer: RepoLayer = {
    repo,
    defaultBranch: result.defaultBranch,
    treeSha: result.treeSha,
    etag: result.etag,
    fetchedAt: new Date().toISOString(),
    root,
    config: parsed.config,
    assets: accepted.filter((f) => f.path !== REPO_CONFIG_FILE).map((f) => f.path),
    warnings,
  };
  writeSidecar(dir, layer);
  memoryCache.set(repo, { layer, checkedAt: now });
  return layer;
}

/**
 * Force a refresh now, bypassing the TTL. `GET /admin/api/repos/:owner/:repo/config?refresh=1`
 * (and so `lastlight repo config show --refresh`) hangs off this — an operator
 * who has just merged a `.lastlight/` change shouldn't wait out the TTL.
 */
export function refreshRepoLayer(repo: string, options: FetchRepoLayerOptions = {}): Promise<RepoLayer | undefined> {
  return fetchRepoLayer(repo, { ...options, force: true });
}

/**
 * Drop a repo's cached layer (or every repo's, with no argument). The next
 * {@link fetchRepoLayer} re-checks. Cheap — the unpacked files and sidecar stay
 * on disk, so the re-check is still conditional.
 */
export function invalidateRepoLayer(repo?: string): void {
  if (repo) memoryCache.delete(repo);
  else memoryCache.clear();
}

/** The cached layer without touching the network — for read-only surfaces (dashboard, CLI). */
export function getCachedRepoLayer(repo: string): RepoLayer | undefined {
  return memoryCache.get(repo)?.layer;
}

/** Test-only: clear the in-memory cache. Matches the `resetXForTests()` convention. */
export function resetRepoConfigForTests(): void {
  memoryCache.clear();
}

// ---------------------------------------------------------------------------
// Fetch/cache internals
// ---------------------------------------------------------------------------

/**
 * The harness GitHub client, or `undefined` in chat-only mode. Config-first
 * (never live `process.env`) for the same reason `resolveReviewGitHubClient` is:
 * boot config can't be raced by anything mutating the env mid-run.
 */
function resolveRepoConfigClient(): GitHubClient | undefined {
  const cfg = getRuntimeConfig();
  if (cfg?.githubApp) return new GitHubClient(cfg.githubApp);
  if (cfg?.githubToken) return GitHubClient.withToken(cfg.githubToken);
  return undefined;
}

/** Split `owner/repo`, rejecting anything that couldn't be a path segment. */
function parseRepoSlug(repo: string): { owner: string; repo: string } | undefined {
  const parts = repo.split("/");
  if (parts.length !== 2) return undefined;
  const [owner, name] = parts as [string, string];
  const safe = /^[A-Za-z0-9._-]+$/;
  if (!safe.test(owner) || !safe.test(name) || owner === "." || owner === ".." || name === "." || name === "..") {
    return undefined;
  }
  return { owner, repo: name };
}

/**
 * On-disk cache root. `<stateDir>/repo-config/<owner>/<repo>/` holds
 * `meta.json` (the sidecar) beside `files/` (the unpacked `.lastlight/` tree).
 * Keeping the sidecar OUT of `files/` means a repo can't shadow it by
 * committing its own `meta.json`.
 */
function repoCacheDir(repo: string, cacheRoot?: string): string {
  const root = cacheRoot ?? join(getRuntimeConfig()?.stateDir ?? resolve(process.env.STATE_DIR || "./data"), "repo-config");
  return join(root, repo);
}

function readSidecar(dir: string): RepoLayerSidecar | undefined {
  const file = join(dir, "meta.json");
  try {
    if (!existsSync(file)) return undefined;
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as RepoLayerSidecar;
    return typeof parsed?.treeSha === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function writeSidecar(dir: string, layer: RepoLayer): void {
  const sidecar: RepoLayerSidecar = {
    repo: layer.repo,
    defaultBranch: layer.defaultBranch,
    treeSha: layer.treeSha,
    etag: layer.etag,
    fetchedAt: layer.fetchedAt,
    assets: layer.assets,
    warnings: layer.warnings,
  };
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "meta.json"), JSON.stringify(sidecar, null, 2));
  } catch (err: unknown) {
    log.warn("Could not persist cache sidecar", { repo: layer.repo, err });
  }
}

/**
 * Rebuild a {@link RepoLayer} from the on-disk cache — the "not modified" path,
 * and the path a restarted process takes before anything has changed upstream.
 * Re-parses `lastlight.yml` from disk rather than trusting a serialized copy, so
 * the cache holds bytes, not decisions.
 */
function hydrate(repo: string, dir: string, sidecar: RepoLayerSidecar | undefined): RepoLayer | undefined {
  if (!sidecar) return undefined;
  const root = join(dir, "files");
  if (!existsSync(root)) return undefined;
  const configPath = join(root, REPO_CONFIG_FILE);
  let config: Record<string, unknown> | undefined;
  const warnings = [...(sidecar.warnings ?? [])];
  if (existsSync(configPath)) {
    const parsed = parseRepoConfigYaml(readFileSync(configPath, "utf-8"), repo);
    config = parsed.config;
    // The sidecar already carries the parse warning from the original fetch —
    // don't double-report it.
    if (!warnings.some((w) => w.code === "invalid-yaml" || w.code === "not-a-mapping")) {
      warnings.push(...parsed.warnings);
    }
  }
  return {
    repo,
    defaultBranch: sidecar.defaultBranch,
    treeSha: sidecar.treeSha,
    etag: sidecar.etag,
    fetchedAt: sidecar.fetchedAt,
    root,
    config,
    assets: sidecar.assets ?? [],
    warnings,
  };
}

/**
 * Materialize the accepted files under `<dir>/files/`, replacing whatever was
 * there. Built in a sibling `files.tmp` and renamed into place so a crash
 * mid-unpack can never leave a half-written layer that a run would then read.
 * Every write is re-checked against the root — the belt to `sanitizeRepoFiles`'s
 * braces, since this is the moment a bad path would actually escape.
 */
function unpack(dir: string, files: readonly RepoConfigFile[]): string {
  const root = join(dir, "files");
  const tmp = join(dir, "files.tmp");
  try {
    mkdirSync(dir, { recursive: true });
    rmSync(tmp, { recursive: true, force: true });
    mkdirSync(tmp, { recursive: true });
    for (const file of files) {
      const target = join(tmp, file.path);
      if (!isInside(target, tmp)) continue;
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, file.content);
    }
    rmSync(root, { recursive: true, force: true });
    renameSync(tmp, root);
  } catch (err: unknown) {
    log.warn("Could not unpack repo config cache dir", { dir, err });
  }
  return root;
}

function clearRepoCacheDir(dir: string): void {
  try {
    if (existsSync(dir) && statSync(dir).isDirectory()) rmSync(dir, { recursive: true, force: true });
  } catch {
    // Best-effort — a stale cache dir is harmless once the memory entry is negative.
  }
}

/**
 * List the unpacked layer's asset paths (relative to `root`). Handy for the
 * admin/CLI views that show what a repo actually contributed.
 */
export function listRepoLayerAssets(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      // Never follow a symlink out of the cache, even one we didn't write.
      if (entry.isSymbolicLink()) continue;
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(join(dir, entry.name), rel);
      else if (entry.isFile() && rel !== REPO_CONFIG_FILE) out.push(rel);
    }
  };
  walk(root, "");
  return out.sort();
}

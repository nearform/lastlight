/**
 * The PURE half of the per-repository config layer (issue #180) — the schema,
 * the operator bounds, and the validators/merger that enforce them.
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
 * ── Why this lives in `lastlight-shared` ──────────────────────────────────
 * Two consumers need exactly the same answers about a `.lastlight/` tree:
 *   - `lastlight-core` at runtime, after fetching the layer from GitHub
 *     (`apps/server/src/config/repo-config.ts`, which owns the impure half —
 *     the fetch, the TTL cache, the on-disk unpack — and re-exports everything
 *     here so its import surface is unchanged); and
 *   - the `lastlight` CLI, offline, inside a user's own code repo
 *     (`lastlight repo config validate`).
 * The CLI must never gain a dependency edge to core, so the bounds logic sits
 * here — the one package both already depend on. Nothing in this file touches
 * the filesystem, the network, or runtime config: it is a function of its
 * arguments, which is also what makes it directly unit-testable.
 *
 * ── The trust rule ────────────────────────────────────────────────────────
 * The layer is ALWAYS read from the repo's **default branch**. Never a PR head.
 * Never the sandbox checkout. That rule is enforced by the fetcher in core;
 * this module only describes what may appear in the layer once it arrives.
 *
 * ── The failure rule ──────────────────────────────────────────────────────
 * Warn, drop the bad bits, run anyway. A repo's config file must never fail a
 * run. Invalid YAML drops the whole file; an unknown or out-of-bounds key drops
 * just that key. Every rejection becomes a structured {@link RepoConfigWarning}
 * so the dashboard/CLI can report it back to the repo's owners.
 */

import { join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import { providerByPrefix, oauthProviderByModelPrefix } from "./providers.js";
import {
  DIAGNOSIS_CLASSES,
  defaultDependenciesConfig,
  defaultFixConfig,
  defaultNotificationsConfig,
  defaultReviewConfig,
  dependencyImpactRank,
  isDependencyImpact,
  isDiagnosisClass,
  isReviewTrigger,
  reviewTriggerRank,
  type DependenciesConfig,
  type DisabledConfig,
  type FixConfig,
  type NotificationsConfig,
  type ReviewConfig,
} from "./config-types.js";

// ---------------------------------------------------------------------------
// Bounds
// ---------------------------------------------------------------------------

/** Hard cap on the unpacked `.lastlight/` layer, in bytes. */
export const REPO_CONFIG_MAX_BYTES = 2 * 1024 * 1024;

/** Hard cap on the number of files in the unpacked layer. */
export const REPO_CONFIG_MAX_FILES = 200;

/** The config file inside `.lastlight/`. Exactly this name — no `.yaml` variant. */
export const REPO_CONFIG_FILE = "lastlight.yml";

/** Git filemode for a symlink blob. Rejected on sight — see {@link sanitizeRepoFiles}. */
const GIT_MODE_SYMLINK = "120000";

// ---------------------------------------------------------------------------
// Operator bounds
// ---------------------------------------------------------------------------

/**
 * The operator's bounds on the per-repo config layer (issue #180). A repo may
 * narrow its own behaviour within these bounds; it can never widen them, and
 * violating them drops the offending key with a warning rather than failing
 * the run.
 *
 * Trust note: the layer this policy bounds is always fetched from the repo's
 * DEFAULT BRANCH. A PR head can't reach it, so a PR can't reconfigure the agent
 * that reviews it. That rule lives in `apps/server/src/config/repo-config.ts`;
 * this type only describes the bounds.
 */
export interface RepoConfigPolicy {
  /** Master switch. `false` ignores every repo's `.lastlight/` entirely (no fetch). */
  enabled: boolean;
  /**
   * Config keys a repo may set, as dotted paths (`models`, `disabled.workflows`,
   * …). A repo leaf is kept when some entry is that leaf's path or a prefix of
   * it — so `models` admits `models.architect`, while `disabled.workflows` does
   * NOT admit `disabled.prompts`. Everything else is dropped with a warning.
   */
  allowKeys: string[];
  /**
   * Model specs a repo may select. `null` (the default) means "any model whose
   * `provider/` prefix is a provider Last Light knows how to wire" — the repo
   * still can't invent a provider. A list restricts to exactly those specs.
   */
  allowedModels: string[] | null;
  /**
   * Whether the repo's asset overrides (`workflows/prompts/*.md`,
   * `skills/<name>/SKILL.md`, `agent-context/*.md`) are unpacked and used.
   * `false` keeps `lastlight.yml` only.
   */
  allowAssets: boolean;
}

/**
 * The allow-list a deployment gets when it says nothing. Kept as a constant so
 * the normaliser, the docs, `config/default.yaml` and the CLI's offline
 * validator can't drift apart.
 *
 * It MUST stay identical to `repoConfig.allowKeys` in
 * `apps/server/config/default.yaml`: this list is what a deployment falls back
 * to when config isn't in reach (`repoConfigPolicy()`'s no-config path, and the
 * CLI's offline `lastlight repo config validate`), so a divergence tells repo
 * owners their file is out of bounds when it isn't. Pinned by the
 * `default allow-list` block in `apps/server/tests/config/repo-config-shared.test.ts`
 * — the two drifted apart once already, silently.
 */
export const DEFAULT_REPO_CONFIG_ALLOW_KEYS: readonly string[] = [
  "models",
  "variants",
  "crons",
  "disabled.workflows",
  "disabled.crons",
  "approval",
  "fix",
  "dependencies",
  "review",
  "notifications",
];

/**
 * The bounds to assume when no deployment config is in reach — the shipped
 * defaults. The offline CLI validator (`lastlight repo config validate`) uses
 * this: it can't know the operator's narrowing, so it validates against the
 * widest shipped policy and says so.
 */
export function defaultRepoConfigPolicy(): RepoConfigPolicy {
  return {
    enabled: true,
    allowKeys: [...DEFAULT_REPO_CONFIG_ALLOW_KEYS],
    allowedModels: null,
    allowAssets: true,
  };
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Which config layer supplied a resolved leaf. Mirrors core's `ConfigSource`. */
export type ConfigSource = "default" | "overlay" | "env" | "repo";

/** Why a piece of a repo's `.lastlight/` was dropped. */
export type RepoConfigWarningCode =
  /** `lastlight.yml` did not parse as YAML — the whole file is ignored. */
  | "invalid-yaml"
  /** `lastlight.yml` parsed to something that isn't a mapping. */
  | "not-a-mapping"
  /** The key isn't in the operator's `repoConfig.allowKeys`. */
  | "key-not-allowed"
  /** The key is allowed but the value has the wrong type/shape. */
  | "invalid-value"
  /** A model spec outside `repoConfig.allowedModels`. */
  | "model-not-allowed"
  /** A model spec whose `provider/` prefix isn't a provider we can wire. */
  | "unknown-provider"
  /** An `approval` entry that would clear a gate — the layer is add-only. */
  | "approval-downgrade"
  /**
   * A `fix` / `dependencies` / `review` entry that would make the repo LESS
   * conservative than the operator (issues #251/#252). Clamped to the operator's
   * value — the repo keeps running, it just doesn't get the looser setting.
   */
  | "policy-downgrade"
  /** A file path that escapes the layer root. */
  | "path-escape"
  /** A symlink (or other non-regular blob) in the layer. */
  | "symlink"
  /** The layer exceeded {@link REPO_CONFIG_MAX_BYTES}. */
  | "size-cap"
  /** The layer exceeded {@link REPO_CONFIG_MAX_FILES}. */
  | "file-count-cap"
  /** A workflow YAML under `workflows/` — repos may contribute prompts, not workflows. */
  | "workflow-not-allowed"
  /** Asset files present but `repoConfig.allowAssets` is false. */
  | "assets-not-allowed"
  /** Files in a layer directory that don't match its expected shape. */
  | "unrecognised-asset"
  /** The GitHub fetch failed; the previous cached layer (if any) still stands. */
  | "fetch-failed";

/**
 * One structured, reportable rejection. Deliberately a plain data object (not
 * an Error): these are collected, persisted in the cache sidecar and rendered
 * by the dashboard/CLI, never thrown.
 */
export interface RepoConfigWarning {
  code: RepoConfigWarningCode;
  /** `owner/repo` this warning belongs to, when known. */
  repo?: string;
  /** The config path (`models.architect`) or file path (`workflows/x.yaml`) at fault. */
  path: string;
  /** One-line human-readable explanation, safe to post back to the repo. */
  message: string;
}

/**
 * One blob of a `.lastlight/` tree, as handed to {@link sanitizeRepoFiles}.
 * Structurally the same shape core's GitHub client produces (`RepoConfigFile`
 * in `apps/server/src/engine/github/github.ts`) and the CLI reads off disk —
 * declared here so the bounds logic needs no GitHub types.
 */
export interface RepoLayerFile {
  /** Path relative to `.lastlight/`. */
  path: string;
  /** Git filemode (`100644`, `100755`, `120000`, …). */
  mode: string;
  size: number;
  content: Buffer;
}

/** A repo's fetched-and-unpacked `.lastlight/` layer. */
export interface RepoLayer {
  /** `owner/repo`. */
  repo: string;
  /** The ref this layer was read from — always the repo's default branch. */
  defaultBranch: string;
  /** Git tree SHA of `.lastlight/` — the content identity used for conditional refetch. */
  treeSha: string;
  /** ETag of the default branch's root tree, for the cheap 304 path. */
  etag?: string;
  /** ISO timestamp of the last successful download (not of the last check). */
  fetchedAt: string;
  /**
   * Absolute path of the unpacked tree. Mirrors an overlay root
   * (`workflows/`, `skills/`, `agent-context/`), so it can be handed to the
   * layer-aware asset loader directly.
   */
  root: string;
  /** Parsed `lastlight.yml` — raw and UNVALIDATED; bounds are applied at resolve time. */
  config?: Record<string, unknown>;
  /** Accepted asset paths relative to {@link root}. Empty when `allowAssets` is false. */
  assets: string[];
  /** Everything dropped while fetching/unpacking this layer. */
  warnings: RepoConfigWarning[];
}

/**
 * The boot-resolved config the repo layer is applied on top of: the merged
 * (default→overlay→env) values plus the matching provenance tree from
 * `resolveConfigLayers`. Core builds one with `repoConfigBaseFromRuntime`.
 */
export interface RepoConfigBase {
  value: Record<string, unknown>;
  sources: Record<string, unknown>;
}

/** The effective, repo-specific values for the keys a repo is allowed to touch. */
export interface RepoMergedConfig {
  models: Record<string, string>;
  variants: Record<string, string>;
  /**
   * Full disabled shape. Only `workflows` and `crons` are repo-settable by
   * default; the rest always come from the operator's layers.
   */
  disabled: DisabledConfig;
  approval: Record<string, boolean>;
  /**
   * Retry policy for the PR_FIX_SHAPED workflows (issue #251) and major-bump
   * auto-merge policy (issue #252), each already clamped so the repo is never
   * looser than the operator. Always present: a base that carries no `fix:` /
   * `dependencies:` / `review:` node (an older boot config, or the CLI's offline
   * validator) falls back leaf-by-leaf to the shipped defaults, so consumers
   * never have to reason about a partially-populated block.
   */
  fix: FixConfig;
  dependencies: DependenciesConfig;
  review: ReviewConfig;
  /**
   * Where this repo's outbound notifications go (the weekly Slack digest).
   * Routing, not policy — see {@link NotificationsConfig} for why the one-way
   * clamp the three blocks above share does not apply here.
   */
  notifications: NotificationsConfig;
}

/** Provenance mirror of {@link RepoMergedConfig} — each leaf tagged with its winning layer. */
export interface RepoConfigSources {
  models: Record<string, ConfigSource>;
  variants: Record<string, ConfigSource>;
  disabled: Record<keyof DisabledConfig, ConfigSource>;
  approval: Record<string, ConfigSource>;
  fix: Record<string, ConfigSource>;
  dependencies: Record<string, ConfigSource>;
  review: Record<string, ConfigSource>;
  notifications: Record<string, ConfigSource>;
}

/** Result of {@link resolveRepoConfig}. */
export interface ResolvedRepoConfig {
  merged: RepoMergedConfig;
  sources: RepoConfigSources;
  /** Fetch/unpack warnings from the layer PLUS everything this resolve dropped. */
  warnings: RepoConfigWarning[];
}

// ---------------------------------------------------------------------------
// Path classification
// ---------------------------------------------------------------------------

/** What role a path inside `.lastlight/` plays in the repo layer. */
export type RepoLayerPathKind = "config" | "prompt" | "skill" | "agent-context";

/**
 * Classify a path relative to `.lastlight/`, or `null` when it is not part of
 * the layer at all.
 *
 * `null` is a routine answer, not an error: `.lastlight/` is shared real
 * estate. With `buildAssets.location: repo` the build workflow commits its
 * handoff docs to `.lastlight/<issueKey>/*.md`, and repos are free to keep
 * other things there. Those are simply outside the layer — the warning path is
 * reserved for files that LOOK like layer assets but have the wrong shape
 * (see {@link sanitizeRepoFiles}).
 */
export function repoLayerPathKind(path: string): RepoLayerPathKind | null {
  if (path === REPO_CONFIG_FILE) return "config";
  if (/^workflows\/prompts\/(?:[^/]+\/)*[^/]+\.md$/.test(path)) return "prompt";
  if (/^skills\/[^/]+\/(?:[^/]+\/)*[^/]+$/.test(path)) return "skill";
  if (/^agent-context\/[^/]+\.md$/.test(path)) return "agent-context";
  return null;
}

/** True when a path is a workflow DEFINITION — the one thing a repo may never contribute. */
export function isRepoWorkflowPath(path: string): boolean {
  return /^workflows\/[^/]+\.ya?ml$/.test(path);
}

/** Top-level directories inside `.lastlight/` that the layer claims. */
const LAYER_DIRS = ["workflows/", "skills/", "agent-context/"];

// ---------------------------------------------------------------------------
// File-level guards
// ---------------------------------------------------------------------------

/**
 * Reject a relative path that can't be safely joined onto a root. Modelled on
 * `assertSafeRelative` in `./workflow-loader.ts`, but returning a reason
 * instead of throwing — a hostile repo must not be able to abort a run by
 * committing a bad filename.
 */
function unsafeRelativeReason(path: string): string | null {
  if (!path) return "path is empty";
  if (path.startsWith("/") || /^[A-Za-z]:/.test(path)) return "path is absolute";
  if (path.includes("\0")) return "path contains a NUL byte";
  if (path.includes("\\")) return "path contains a backslash";
  const segments = path.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) return "path contains a traversal segment";
  return null;
}

/** True when `filePath` resolves inside `root`. Same check as the workflow loader's `isInside`. */
function isInside(filePath: string, root: string): boolean {
  const r = resolve(root);
  const f = resolve(filePath);
  return f === r || f.startsWith(r + sep);
}

/**
 * Apply every file-level bound to a `.lastlight/` subtree.
 *
 * Pure — takes the blobs, returns the ones that may be written to disk plus a
 * warning per rejection. The caps are enforced here as well as at fetch time
 * (the client stops downloading at its own limits) because this function is the
 * last gate before anything touches the filesystem, and defence in depth is
 * cheap.
 *
 * Generic in the file type so a caller carrying a richer blob shape (core's
 * `RepoConfigFile`) gets its own type back rather than a widened one.
 */
export function sanitizeRepoFiles<T extends RepoLayerFile>(
  files: readonly T[],
  policy: RepoConfigPolicy,
  repo?: string,
): { accepted: T[]; warnings: RepoConfigWarning[] } {
  const warnings: RepoConfigWarning[] = [];
  const accepted: T[] = [];
  const warn = (code: RepoConfigWarningCode, path: string, message: string) =>
    warnings.push({ code, repo, path, message });

  let bytes = 0;
  let unrecognised = 0;
  let assetsDropped = 0;

  for (const file of files) {
    const path = file.path;

    const unsafe = unsafeRelativeReason(path);
    if (unsafe) {
      warn("path-escape", path, `Ignored .lastlight/${path}: ${unsafe}.`);
      continue;
    }
    // Second, independent check: even a segment-clean path must land under the
    // layer root once joined. Cheap, and catches anything the string checks miss.
    if (!isInside(join("/layer-root", path), "/layer-root")) {
      warn("path-escape", path, `Ignored .lastlight/${path}: it escapes the layer directory.`);
      continue;
    }
    // Symlinks are the classic unpack escape — a `skills/x/SKILL.md` symlink
    // pointing at /etc/passwd or at the harness's own secrets would otherwise be
    // read as layer content. Only regular files are ever materialized.
    if (file.mode === GIT_MODE_SYMLINK) {
      warn("symlink", path, `Ignored .lastlight/${path}: symlinks are not allowed in a repo config layer.`);
      continue;
    }
    if (file.mode !== "100644" && file.mode !== "100755") {
      warn("symlink", path, `Ignored .lastlight/${path}: only regular files are allowed (mode ${file.mode}).`);
      continue;
    }
    // Repos may contribute PROMPTS, never workflows: a workflow YAML defines
    // phases, skills and permission profiles, which is the operator's call.
    if (isRepoWorkflowPath(path)) {
      warn(
        "workflow-not-allowed",
        path,
        `Ignored .lastlight/${path}: a repo may override prompts (workflows/prompts/*.md), not workflow definitions.`,
      );
      continue;
    }

    const kind = repoLayerPathKind(path);
    if (!kind) {
      // Inside a layer directory but the wrong shape → the repo probably meant
      // it as an asset. Counted and reported once, so a big stray directory
      // can't flood the warning list.
      if (LAYER_DIRS.some((d) => path.startsWith(d))) unrecognised++;
      continue;
    }
    if (kind !== "config" && !policy.allowAssets) {
      assetsDropped++;
      continue;
    }

    if (accepted.length >= REPO_CONFIG_MAX_FILES) {
      warn(
        "file-count-cap",
        path,
        `Ignored .lastlight/${path}: the repo config layer is capped at ${REPO_CONFIG_MAX_FILES} files.`,
      );
      continue;
    }
    if (bytes + file.content.length > REPO_CONFIG_MAX_BYTES) {
      warn(
        "size-cap",
        path,
        `Ignored .lastlight/${path}: the repo config layer is capped at ${REPO_CONFIG_MAX_BYTES} bytes.`,
      );
      continue;
    }

    bytes += file.content.length;
    accepted.push(file);
  }

  if (unrecognised > 0) {
    warn(
      "unrecognised-asset",
      ".lastlight",
      `Ignored ${unrecognised} file(s) under .lastlight/: a repo layer may contain ${REPO_CONFIG_FILE}, ` +
        `workflows/prompts/*.md, skills/<name>/SKILL.md and agent-context/*.md.`,
    );
  }
  if (assetsDropped > 0) {
    warn(
      "assets-not-allowed",
      ".lastlight",
      `Ignored ${assetsDropped} asset file(s) under .lastlight/: this deployment sets repoConfig.allowAssets: false.`,
    );
  }

  return { accepted, warnings };
}

// ---------------------------------------------------------------------------
// Config-level bounds
// ---------------------------------------------------------------------------

/**
 * Parse a repo's `lastlight.yml`. Malformed YAML, or YAML that isn't a mapping,
 * drops the WHOLE file — a half-understood config file is more dangerous than
 * none, and the repo gets a warning either way.
 */
export function parseRepoConfigYaml(
  raw: string,
  repo?: string,
): { config?: Record<string, unknown>; warnings: RepoConfigWarning[] } {
  let parsed: unknown;
  try {
    parsed = parseYaml(raw);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      warnings: [
        {
          code: "invalid-yaml",
          repo,
          path: REPO_CONFIG_FILE,
          message: `Ignored .lastlight/${REPO_CONFIG_FILE}: it is not valid YAML (${message}).`,
        },
      ],
    };
  }
  // An empty file parses to null — legal, just carries nothing.
  if (parsed === null || parsed === undefined) return { warnings: [] };
  if (!isPlainObject(parsed)) {
    return {
      warnings: [
        {
          code: "not-a-mapping",
          repo,
          path: REPO_CONFIG_FILE,
          message: `Ignored .lastlight/${REPO_CONFIG_FILE}: the top level must be a mapping.`,
        },
      ],
    };
  }
  return { config: parsed, warnings: [] };
}

/**
 * True when `path` (a dotted config path) is admitted by the allow-list. An
 * entry admits itself and everything beneath it — `models` admits
 * `models.architect`; `disabled.workflows` does NOT admit `disabled.prompts`.
 */
function isAllowedKey(path: string, allowKeys: readonly string[]): boolean {
  return allowKeys.some((allowed) => path === allowed || path.startsWith(`${allowed}.`));
}

/**
 * True when a dotted path is a PREFIX of some allow-list entry — i.e. the repo
 * must be allowed to descend into it even though the container itself isn't
 * directly settable (`disabled` for `disabled.workflows`).
 */
function isAllowedPrefix(path: string, allowKeys: readonly string[]): boolean {
  return allowKeys.some((allowed) => allowed.startsWith(`${path}.`));
}

/**
 * Reduce a repo's raw `lastlight.yml` to the sub-tree it is actually allowed to
 * contribute. Pure. Everything dropped produces a warning.
 *
 * `base` supplies the operator's current values, which the `approval` add-only
 * rule needs: a repo may raise a gate, never lower one.
 */
export function sanitizeRepoConfigLayer(
  raw: Record<string, unknown> | undefined,
  policy: RepoConfigPolicy,
  base: RepoConfigBase,
  repo?: string,
): { layer: Record<string, unknown>; warnings: RepoConfigWarning[] } {
  const warnings: RepoConfigWarning[] = [];
  const layer: Record<string, unknown> = {};
  if (!raw) return { layer, warnings };
  const warn = (code: RepoConfigWarningCode, path: string, message: string) =>
    warnings.push({ code, repo, path, message });

  for (const [key, value] of Object.entries(raw)) {
    const allowed = isAllowedKey(key, policy.allowKeys);
    const descendable = isAllowedPrefix(key, policy.allowKeys);
    if (!allowed && !descendable) {
      warn("key-not-allowed", key, `Ignored "${key}" in .lastlight/${REPO_CONFIG_FILE}: a repo may not set this key.`);
      continue;
    }
    switch (key) {
      case "models":
        assignIfAny(layer, "models", sanitizeModels(value, policy, warn));
        break;
      case "variants":
        assignIfAny(layer, "variants", sanitizeStringMap(value, "variants", policy, warn));
        break;
      case "crons":
        // Accepted and deliberately NOT merged. Cron participation
        // (`crons: {enable, disable}`) is read straight off the RAW layer by
        // the scheduler at tick time — `repoCronPrefs` in
        // `apps/server/src/cron/repo-crons.ts` — because it decides WHICH repos
        // a cron fans out over, which happens before any run (and therefore
        // before any merged per-run config) exists. So it is not part of
        // {@link RepoMergedConfig} and has no merged-shape validator here; the
        // `case` exists only to stop the `default:` branch reporting a
        // "no repo-layer validator" warning for a block that is fully
        // supported. Do NOT "fix" this by adding `crons` to the merged shape:
        // that would give one block two owners with two bounds checks.
        break;
      case "disabled":
        assignIfAny(layer, "disabled", sanitizeDisabled(value, policy, warn));
        break;
      case "approval":
        assignIfAny(layer, "approval", sanitizeApproval(value, policy, base, warn));
        break;
      case "fix":
        assignIfAny(layer, "fix", sanitizeFix(value, policy, base, warn));
        break;
      case "dependencies":
        assignIfAny(layer, "dependencies", sanitizeDependencies(value, policy, base, warn));
        break;
      case "review":
        assignIfAny(layer, "review", sanitizeReview(value, policy, base, warn));
        break;
      case "notifications":
        assignIfAny(layer, "notifications", sanitizeNotifications(value, policy, warn));
        break;
      default:
        // Allow-listed by the operator but not a key this module knows how to
        // bound. Refusing is the safe direction: an unbounded pass-through
        // would let an operator widen the layer past what's been reviewed.
        warn(
          "key-not-allowed",
          key,
          `Ignored "${key}" in .lastlight/${REPO_CONFIG_FILE}: it has no repo-layer validator.`,
        );
    }
  }
  return { layer, warnings };
}

type Warn = (code: RepoConfigWarningCode, path: string, message: string) => void;

/** Drop empty sub-trees so the merge never records a `repo` provenance for nothing. */
function assignIfAny(target: Record<string, unknown>, key: string, value: Record<string, unknown> | undefined): void {
  if (value && Object.keys(value).length > 0) target[key] = value;
}

function sanitizeModels(raw: unknown, policy: RepoConfigPolicy, warn: Warn): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) {
    warn("invalid-value", "models", `Ignored "models" in .lastlight/${REPO_CONFIG_FILE}: it must be a mapping.`);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [task, spec] of Object.entries(raw)) {
    const path = `models.${task}`;
    // Re-checked per leaf, not just on the `models` container: an operator can
    // narrow the allow-list to a single task (`models.triage`), and the leaf is
    // the only place that distinction exists.
    if (!isAllowedKey(path, policy.allowKeys)) {
      warn("key-not-allowed", path, `Ignored "${path}": a repo may not set this key.`);
      continue;
    }
    if (typeof spec !== "string" || !spec.trim()) {
      warn("invalid-value", path, `Ignored "${path}": a model must be a non-empty "provider/model" string.`);
      continue;
    }
    const model = spec.trim();
    const prefix = model.split("/")[0] ?? "";
    if (!prefix || !model.includes("/") || (!providerByPrefix(prefix) && !oauthProviderByModelPrefix(prefix))) {
      warn("unknown-provider", path, `Ignored "${path}": "${model}" is not a "provider/model" spec Last Light can wire.`);
      continue;
    }
    // A non-null allowedModels is the operator saying "exactly these" — an
    // exact-match list, never a prefix rule, so it can't be widened by a repo
    // appending to a model id.
    if (policy.allowedModels !== null && !policy.allowedModels.includes(model)) {
      warn("model-not-allowed", path, `Ignored "${path}": "${model}" is not in this deployment's repoConfig.allowedModels.`);
      continue;
    }
    out[task] = model;
  }
  return out;
}

function sanitizeStringMap(
  raw: unknown,
  path: string,
  policy: RepoConfigPolicy,
  warn: Warn,
): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) {
    warn("invalid-value", path, `Ignored "${path}" in .lastlight/${REPO_CONFIG_FILE}: it must be a mapping.`);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const leaf = `${path}.${key}`;
    if (!isAllowedKey(leaf, policy.allowKeys)) {
      warn("key-not-allowed", leaf, `Ignored "${leaf}": a repo may not set this key.`);
      continue;
    }
    if (typeof value !== "string" || !value.trim()) {
      warn("invalid-value", leaf, `Ignored "${leaf}": it must be a non-empty string.`);
      continue;
    }
    out[key] = value.trim();
  }
  return out;
}

function sanitizeDisabled(raw: unknown, policy: RepoConfigPolicy, warn: Warn): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) {
    warn("invalid-value", "disabled", `Ignored "disabled" in .lastlight/${REPO_CONFIG_FILE}: it must be a mapping.`);
    return undefined;
  }
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    const path = `disabled.${key}`;
    if (!isAllowedKey(path, policy.allowKeys)) {
      warn("key-not-allowed", path, `Ignored "${path}": a repo may not set this key.`);
      continue;
    }
    if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
      warn("invalid-value", path, `Ignored "${path}": it must be an array of non-empty strings.`);
      continue;
    }
    // Same unsafe-name check `validateAssets` applies to the operator's own
    // disabled lists — a name is a logical workflow/cron name, never a path.
    const names = (value as string[]).map((v) => v.trim());
    const bad = names.find((n) => n.includes("/") || n.includes(".."));
    if (bad) {
      warn("invalid-value", path, `Ignored "${path}": "${bad}" is not a valid workflow/cron name.`);
      continue;
    }
    out[key] = names;
  }
  return out;
}

function sanitizeApproval(
  raw: unknown,
  policy: RepoConfigPolicy,
  base: RepoConfigBase,
  warn: Warn,
): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) {
    warn("invalid-value", "approval", `Ignored "approval" in .lastlight/${REPO_CONFIG_FILE}: it must be a mapping.`);
    return undefined;
  }
  const baseApproval = isPlainObject(base.value.approval) ? base.value.approval : {};
  const out: Record<string, unknown> = {};
  for (const [gate, value] of Object.entries(raw)) {
    const path = `approval.${gate}`;
    if (!isAllowedKey(path, policy.allowKeys)) {
      warn("key-not-allowed", path, `Ignored "${path}": a repo may not set this key.`);
      continue;
    }
    if (typeof value !== "boolean") {
      warn("invalid-value", path, `Ignored "${path}": an approval gate must be true or false.`);
      continue;
    }
    // ADD-ONLY. A repo may demand more human oversight of runs against itself;
    // it may never remove oversight the operator asked for. Clearing a gate the
    // operator never set is a no-op, so every `false` is simply dropped — with a
    // warning, so the repo learns why nothing happened.
    if (value === false) {
      const code = baseApproval[gate] === true ? "approval-downgrade" : "invalid-value";
      warn(
        code,
        path,
        `Ignored "${path}: false": the repo approval layer is add-only — a repo can raise an approval gate, never clear one.`,
      );
      continue;
    }
    out[gate] = true;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Policy blocks: fix / dependencies / review (issues #251, #252)
// ---------------------------------------------------------------------------
//
// One rule governs all three: **a repo may only ever be MORE conservative than
// the operator.** Structurally this is `sanitizeApproval` again — validate the
// leaf, compare it with the operator's effective value, and DROP anything that
// loosens (with a `policy-downgrade` warning so the repo learns why nothing
// happened). Dropping IS the clamp: the base already carries the operator's
// value, so a dropped leaf resolves to exactly it.
//
// A handful of leaves are operator-only rather than clamped — they control spend
// (`fix.escalateModelAfterAttempt`), a shared resource (`fix.gateTimeoutSeconds`)
// or an escape hatch that a `max()` clamp would weld shut for CI-less repos
// (`dependencies.minSettledChecks`). Those are reported as `key-not-allowed`,
// the same code an operator narrowing `allowKeys` produces, because from the
// repo's point of view it is the same answer: this key is not yours to set.

/**
 * The operator's effective value for one policy block — the boot config's node
 * over the shipped defaults, leaf by leaf.
 *
 * Falling back per leaf (rather than only when the whole node is missing) is
 * what lets the CLI's offline validator work: it merges against an empty base
 * and still clamps against the shipped values, which is the widest policy any
 * deployment can have.
 */
function operatorBlockNode(base: RepoConfigBase, key: string): Record<string, unknown> {
  return isPlainObject(base.value[key]) ? base.value[key] : {};
}

/** A positive-integer leaf, or `undefined` when the value isn't one. */
function positiveInt(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && Number.isInteger(value) && value >= 0
    ? value
    : undefined;
}

function sanitizeFix(
  raw: unknown,
  policy: RepoConfigPolicy,
  base: RepoConfigBase,
  warn: Warn,
): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) {
    warn("invalid-value", "fix", `Ignored "fix" in .lastlight/${REPO_CONFIG_FILE}: it must be a mapping.`);
    return undefined;
  }
  const defaults = defaultFixConfig();
  const operatorRaw = operatorBlockNode(base, "fix");
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    const path = `fix.${key}`;
    if (!isAllowedKey(path, policy.allowKeys)) {
      warn("key-not-allowed", path, `Ignored "${path}": a repo may not set this key.`);
      continue;
    }
    switch (key) {
      // Budget caps. `min(repo, operator)`: a repo may buy itself fewer
      // attempts/iterations against its own PRs, never more.
      case "maxAttempts":
      case "localIterations":
      case "maxFlakyDeferrals": {
        const n = positiveInt(value);
        if (n === undefined) {
          warn("invalid-value", path, `Ignored "${path}": it must be a non-negative whole number.`);
          continue;
        }
        const operator = positiveInt(operatorRaw[key]) ?? (defaults[key] as number);
        if (n > operator) {
          warn(
            "policy-downgrade",
            path,
            `Ignored "${path}: ${n}": a repo may only lower this — this deployment allows at most ${operator}.`,
          );
          continue;
        }
        out[key] = n;
        break;
      }
      // The cumulative cost brake. `null` means unbounded, so it is the LOOSEST
      // value there is: a repo may only ever propose a real number, and only one
      // at or below the operator's own ceiling.
      case "maxCostUsd": {
        const operator =
          typeof operatorRaw.maxCostUsd === "number" || operatorRaw.maxCostUsd === null
            ? (operatorRaw.maxCostUsd as number | null)
            : defaults.maxCostUsd;
        if (value === null) {
          if (operator === null) {
            warn("invalid-value", path, `Ignored "${path}: null": this deployment already sets no cost ceiling.`);
          } else {
            warn(
              "policy-downgrade",
              path,
              `Ignored "${path}: null": null means "no ceiling", which is looser than this deployment's ${operator}.`,
            );
          }
          continue;
        }
        if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
          warn("invalid-value", path, `Ignored "${path}": it must be a non-negative number (or null for no ceiling).`);
          continue;
        }
        if (operator !== null && value > operator) {
          warn(
            "policy-downgrade",
            path,
            `Ignored "${path}: ${value}": a repo may only lower this — this deployment's ceiling is ${operator}.`,
          );
          continue;
        }
        out.maxCostUsd = value;
        break;
      }
      // Subset only. Naming a class the operator doesn't retry would ADD a
      // retryable failure mode, which is the loosening direction; the remaining
      // (possibly empty) subset stands, because retrying less is always allowed.
      case "retryableClasses": {
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
          warn("invalid-value", path, `Ignored "${path}": it must be an array of non-empty strings.`);
          continue;
        }
        const operator = Array.isArray(operatorRaw.retryableClasses)
          ? (operatorRaw.retryableClasses as unknown[]).filter((v): v is string => typeof v === "string")
          : defaults.retryableClasses;
        const raw = (value as string[]).map((v) => v.trim());
        // Against the closed enum FIRST, and reported separately from the
        // subset clamp: "you spelled it wrong" and "the operator doesn't retry
        // that" are different problems with different fixes, and a typo would
        // otherwise be reported as a policy decision (#256).
        const misspelt = raw.filter((n) => !isDiagnosisClass(n));
        if (misspelt.length > 0) {
          warn(
            "invalid-value",
            path,
            `Dropped ${misspelt.map((n) => `"${n}"`).join(", ")} from "${path}": not a diagnosis class. ` +
              `The five are: ${DIAGNOSIS_CLASSES.join(", ")}.`,
          );
        }
        const names = raw.filter(isDiagnosisClass) as string[];
        const added = names.filter((n) => !operator.includes(n));
        if (added.length > 0) {
          warn(
            "policy-downgrade",
            path,
            `Dropped ${added.map((n) => `"${n}"`).join(", ")} from "${path}": a repo may only narrow the retryable ` +
              `classes — this deployment retries ${operator.join(", ") || "(none)"}.`,
          );
        }
        out.retryableClasses = names.filter((n) => operator.includes(n));
        break;
      }
      case "escalateModelAfterAttempt":
      case "gateTimeoutSeconds":
        // Operator-only: one is spend control, the other is a shared-resource
        // budget. Neither is a "how careful is this repo" dial.
        warn(
          "key-not-allowed",
          path,
          `Ignored "${path}": this key is set by the deployment operator only.`,
        );
        break;
      default:
        warn("invalid-value", path, `Ignored "${path}": it is not a key of the fix policy.`);
    }
  }
  return out;
}

function sanitizeDependencies(
  raw: unknown,
  policy: RepoConfigPolicy,
  base: RepoConfigBase,
  warn: Warn,
): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) {
    warn(
      "invalid-value",
      "dependencies",
      `Ignored "dependencies" in .lastlight/${REPO_CONFIG_FILE}: it must be a mapping.`,
    );
    return undefined;
  }
  const defaults = defaultDependenciesConfig();
  const operatorRaw = operatorBlockNode(base, "dependencies");
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    const path = `dependencies.${key}`;
    if (!isAllowedKey(path, policy.allowKeys)) {
      warn("key-not-allowed", path, `Ignored "${path}": a repo may not set this key.`);
      continue;
    }
    switch (key) {
      // The lower tier on `none < low < medium < high` wins, so a repo can pull
      // its own auto-merge ceiling down (all the way to `none`) but never up.
      case "autoMergeMaxImpact": {
        if (!isDependencyImpact(value)) {
          warn("invalid-value", path, `Ignored "${path}": it must be one of none, low, medium, high.`);
          continue;
        }
        const operator = isDependencyImpact(operatorRaw.autoMergeMaxImpact)
          ? operatorRaw.autoMergeMaxImpact
          : defaults.autoMergeMaxImpact;
        if (dependencyImpactRank(value) > dependencyImpactRank(operator)) {
          warn(
            "policy-downgrade",
            path,
            `Ignored "${path}: ${value}": a repo may only lower this — this deployment auto-merges majors up to ` +
              `"${operator}".`,
          );
          continue;
        }
        out.autoMergeMaxImpact = value;
        break;
      }
      // Add-only `true`, exactly like an approval gate: a repo may demand that
      // checks have settled before anything merges; it may not waive the
      // operator's requirement.
      case "requireSettledChecks": {
        if (typeof value !== "boolean") {
          warn("invalid-value", path, `Ignored "${path}": it must be true or false.`);
          continue;
        }
        if (value === false) {
          const code = operatorRaw.requireSettledChecks === true ? "policy-downgrade" : "invalid-value";
          warn(
            code,
            path,
            `Ignored "${path}: false": this key is add-only — a repo can require settled checks, never waive them.`,
          );
          continue;
        }
        out.requireSettledChecks = true;
        break;
      }
      case "auditComment": {
        // Add-only `true`, like `requireSettledChecks` above.
        //
        // This was `free` on the reasoning that the comment is cosmetic. It is
        // not: it is the AUDIT RECORD of a major version this deployment
        // auto-merged into that repo, and the party it silences is the party
        // being audited (#256). Turning it ON when the operator has it off is
        // the conservative direction and stays allowed; turning it off is the
        // one thing a repo may not do.
        if (typeof value !== "boolean") {
          warn("invalid-value", path, `Ignored "${path}": it must be true or false.`);
          continue;
        }
        const operator =
          typeof operatorRaw.auditComment === "boolean"
            ? operatorRaw.auditComment
            : defaults.auditComment;
        if (!value && operator) {
          warn(
            "policy-downgrade",
            path,
            `Ignored "${path}: false": this key is add-only — a repo may ask for the auto-merge ` +
              `audit comment, never silence one this deployment requires.`,
          );
          continue;
        }
        out.auditComment = value;
        break;
      }
      case "minSettledChecks":
        // Operator-only (09 locked decision 18). §6.2 originally proposed
        // `max(repo, operator)`, but that direction welds the escape hatch shut:
        // a repo with no CI at all could only ever RAISE the number of settled
        // checks an auto-merge needs, never lower it to 0.
        warn(
          "key-not-allowed",
          path,
          `Ignored "${path}": this key is set by the deployment operator only.`,
        );
        break;
      default:
        warn("invalid-value", path, `Ignored "${path}": it is not a key of the dependencies policy.`);
    }
  }
  return out;
}

function sanitizeReview(
  raw: unknown,
  policy: RepoConfigPolicy,
  base: RepoConfigBase,
  warn: Warn,
): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) {
    warn("invalid-value", "review", `Ignored "review" in .lastlight/${REPO_CONFIG_FILE}: it must be a mapping.`);
    return undefined;
  }
  const defaults = defaultReviewConfig();
  const operatorRaw = operatorBlockNode(base, "review");
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    const path = `review.${key}`;
    if (!isAllowedKey(path, policy.allowKeys)) {
      warn("key-not-allowed", path, `Ignored "${path}": a repo may not set this key.`);
      continue;
    }
    switch (key) {
      case "trigger": {
        // The LOWER automation tier wins (`on-request < after-checks < eager`),
        // the same direction `dependencies.autoMergeMaxImpact` is clamped in.
        //
        // This was `free` on the reasoning that all three modes are equally
        // "safe". They are not equally EXPENSIVE (#256): a repo committing
        // `eager` against an `on-request` deployment buys itself a full agent
        // run per push, on the operator's budget. Opting DOWN is still entirely
        // its call.
        if (!isReviewTrigger(value)) {
          warn("invalid-value", path, `Ignored "${path}": it must be one of eager, after-checks, on-request.`);
          continue;
        }
        const operator = isReviewTrigger(operatorRaw.trigger) ? operatorRaw.trigger : defaults.trigger;
        if (reviewTriggerRank(value) > reviewTriggerRank(operator)) {
          warn(
            "policy-downgrade",
            path,
            `Ignored "${path}: ${value}": a repo may only ask for LESS review automation — ` +
              `this deployment runs "${operator}".`,
          );
          continue;
        }
        out.trigger = value;
        break;
      }
      case "requestLabel": {
        // Free, but it is a LABEL name, never a path — same guard
        // `sanitizeDisabled` applies to workflow/cron names.
        if (value === null) {
          out.requestLabel = null;
          break;
        }
        if (typeof value !== "string" || !value.trim()) {
          warn("invalid-value", path, `Ignored "${path}": it must be a non-empty label name (or null).`);
          continue;
        }
        const label = value.trim();
        if (label.includes("/") || label.includes("..")) {
          warn("invalid-value", path, `Ignored "${path}": "${label}" is not a valid label name.`);
          continue;
        }
        out.requestLabel = label;
        break;
      }
      // Both add-only `true`: a repo may skip drafts and may ask for the check
      // run; it may not force reviews onto drafts or suppress an operator's
      // check (which a branch-protection rule may be requiring).
      case "skipDraft":
      case "postsCheck": {
        if (typeof value !== "boolean") {
          warn("invalid-value", path, `Ignored "${path}": it must be true or false.`);
          continue;
        }
        if (value === false) {
          const code = operatorRaw[key] === true ? "policy-downgrade" : "invalid-value";
          warn(code, path, `Ignored "${path}: false": this key is add-only — a repo may only turn it on.`);
          continue;
        }
        out[key] = true;
        break;
      }
      case "generatedPaths": {
        // SUPERSET-only — the mirror image of `fix.retryableClasses` (#271).
        // A longer list suppresses MORE re-reviews, which is the conservative
        // direction; DROPPING one of the operator's entries buys the repo an
        // extra agent run per lock-file bump on the operator's budget. Arrays
        // replace wholesale on merge, so the clamp is "keep the union" rather
        // than "drop the leaf" — dropping it would silently restore the
        // operator's list, which is the same answer but a confusing one to read
        // back off the provenance view.
        if (!Array.isArray(value) || value.some((v) => typeof v !== "string" || !v.trim())) {
          warn("invalid-value", path, `Ignored "${path}": it must be an array of non-empty path patterns.`);
          continue;
        }
        const operator = Array.isArray(operatorRaw.generatedPaths)
          ? (operatorRaw.generatedPaths as unknown[]).filter((v): v is string => typeof v === "string")
          : defaults.generatedPaths;
        const names = (value as string[]).map((v) => v.trim());
        const dropped = operator.filter((p) => !names.includes(p));
        if (dropped.length > 0) {
          warn(
            "policy-downgrade",
            path,
            `Restored ${dropped.map((p) => `"${p}"`).join(", ")} to "${path}": a repo may only ADD generated-path ` +
              `patterns — removing one asks for MORE review runs than this deployment allows.`,
          );
        }
        out.generatedPaths = [...operator, ...names.filter((p) => !operator.includes(p))];
        break;
      }
      default:
        warn("invalid-value", path, `Ignored "${path}": it is not a key of the review policy.`);
    }
  }
  return out;
}

/**
 * `notifications:` — the only repo-settable block with NO clamp direction.
 *
 * Every other block here answers "is the repo asking to be looser than the
 * operator?". A Slack channel has no such ordering: it is routing, and the
 * repo's answer simply wins. What bounds it instead is the layer's trust rule
 * (default branch only, never a PR head) plus Slack itself — the bot can only
 * post where it has been invited. So the validation here is purely about
 * SHAPE: reject anything that isn't a plausible channel reference, so a typo
 * surfaces as a warning on the run row rather than as a silent `channel_not_found`
 * once a week.
 *
 * `channel: null` is meaningful and preserved: it says "I explicitly want no
 * digest", which must beat the operator's `repoChannels` entry rather than
 * falling through to it.
 */
function sanitizeNotifications(
  raw: unknown,
  policy: RepoConfigPolicy,
  warn: Warn,
): Record<string, unknown> | undefined {
  if (!isPlainObject(raw)) {
    warn(
      "invalid-value",
      "notifications",
      `Ignored "notifications" in .lastlight/${REPO_CONFIG_FILE}: it must be a mapping.`,
    );
    return undefined;
  }
  const out: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(raw)) {
    const path = `notifications.${key}`;
    if (!isAllowedKey(path, policy.allowKeys)) {
      warn("key-not-allowed", path, `Ignored "${path}": a repo may not set this key.`);
      continue;
    }
    if (key !== "slack") {
      warn("invalid-value", path, `Ignored "${path}": the only notification target is "slack".`);
      continue;
    }
    if (!isPlainObject(value)) {
      warn("invalid-value", path, `Ignored "${path}": it must be a mapping.`);
      continue;
    }
    const slack: Record<string, unknown> = {};
    for (const [leafKey, leafValue] of Object.entries(value)) {
      const leaf = `${path}.${leafKey}`;
      if (!isAllowedKey(leaf, policy.allowKeys)) {
        warn("key-not-allowed", leaf, `Ignored "${leaf}": a repo may not set this key.`);
        continue;
      }
      if (leafKey !== "channel") {
        warn("invalid-value", leaf, `Ignored "${leaf}": it is not a key of the slack notification target.`);
        continue;
      }
      if (leafValue === null) {
        slack.channel = null;
        continue;
      }
      if (typeof leafValue !== "string" || !isChannelRef(leafValue.trim())) {
        warn(
          "invalid-value",
          leaf,
          `Ignored "${leaf}": it must be a Slack channel id (e.g. "C01ABCDEFGH"), a "#channel-name", or null.`,
        );
        continue;
      }
      slack.channel = leafValue.trim();
    }
    // `{ channel: null }` survives `assignIfAny` (one key, not an empty
    // sub-tree) — which is what makes an explicit null distinguishable from an
    // absent key downstream: the merge tags the leaf `repo`, and the channel
    // resolver reads that provenance to honour "this repo wants no digest".
    assignIfAny(out, "slack", slack);
  }
  return out;
}

/** A Slack channel id (`C…`/`G…`/`D…`) or a `#channel-name`. Bounded to Slack's 80-char limit. */
function isChannelRef(value: string): boolean {
  if (!value || value.length > 80) return false;
  return /^#?[A-Za-z0-9._-]+$/.test(value);
}

// ---------------------------------------------------------------------------
// Resolution
// ---------------------------------------------------------------------------

/**
 * Apply a repo's layer on top of the boot config and report what happened.
 *
 * PURE — no fs, no network, no runtime-config reads. Plain objects deep-merge
 * key-by-key while arrays and scalars replace wholesale — byte-for-byte the
 * semantics of the boot layers (see {@link mergeLayer}), so the repo layer can
 * never acquire semantics the operator's layers don't have.
 *
 * Note on `disabled.*`: those are arrays, so a repo's list REPLACES the
 * operator's rather than adding to it (locked precedence). Operators who don't
 * want that remove `disabled.workflows` / `disabled.crons` from
 * `repoConfig.allowKeys`.
 *
 * Passing `undefined` for `repoLayer` (no `.lastlight/`, fetch failed, feature
 * disabled) returns the base unchanged with no warnings — the inert path.
 */
export function resolveRepoConfig(
  base: RepoConfigBase,
  policy: RepoConfigPolicy,
  repoLayer?: RepoLayer,
): ResolvedRepoConfig {
  const warnings: RepoConfigWarning[] = repoLayer ? [...repoLayer.warnings] : [];

  let layer: Record<string, unknown> = {};
  if (repoLayer && policy.enabled) {
    const sanitized = sanitizeRepoConfigLayer(repoLayer.config, policy, base, repoLayer.repo);
    layer = sanitized.layer;
    warnings.push(...sanitized.warnings);
  }

  const value = structuredClone(base.value);
  const sources = structuredClone(base.sources);
  mergeLayer(value, sources, layer, "repo");
  return {
    merged: shapeMerged(value),
    sources: shapeSources(sources),
    warnings,
  };
}

/**
 * Merge one layer INTO `value`/`sources` in place, tagging every leaf it
 * supplies with `source`.
 *
 * THE single definition of Last Light's config-merge semantics: plain objects
 * deep-merge key-by-key so each leaf resolves (and is attributed) on its own;
 * arrays and scalars replace wholesale. Core's boot-layer resolver
 * (`apps/server/src/config/config-resolve.ts`) re-exports this rather than
 * carrying its own — the repo layer must merge exactly the way default/overlay/
 * env do, or a repo could acquire precedence the operator's own layers don't
 * have, and two implementations is exactly how that drift starts.
 *
 * It lives HERE, in the leaf package, because the direction of the dependency
 * edge only permits it here: `lastlight-shared` may never depend on core.
 */
export function mergeLayer(
  value: Record<string, unknown>,
  sources: Record<string, unknown>,
  layer: Record<string, unknown>,
  source: ConfigSource,
): void {
  for (const [key, incoming] of Object.entries(layer)) {
    if (isPlainObject(incoming)) {
      const childValue = isPlainObject(value[key]) ? (value[key] as Record<string, unknown>) : {};
      const childSources = isPlainObject(sources[key]) ? (sources[key] as Record<string, unknown>) : {};
      mergeLayer(childValue, childSources, incoming, source);
      value[key] = childValue;
      sources[key] = childSources;
    } else {
      value[key] = incoming;
      sources[key] = source;
    }
  }
}

function shapeMerged(value: Record<string, unknown>): RepoMergedConfig {
  const disabled = isPlainObject(value.disabled) ? value.disabled : {};
  return {
    models: stringMap(value.models),
    variants: stringMap(value.variants),
    disabled: {
      workflows: stringList(disabled.workflows),
      crons: stringList(disabled.crons),
      prompts: stringList(disabled.prompts),
      skills: stringList(disabled.skills),
      agentContext: stringList(disabled.agentContext),
    },
    approval: boolMap(value.approval),
    fix: shapeFix(value.fix),
    dependencies: shapeDependencies(value.dependencies),
    review: shapeReview(value.review),
    notifications: shapeNotifications(value.notifications),
  };
}

/** Total over `notifications:`, same contract as {@link shapeFix} and friends. */
function shapeNotifications(raw: unknown): NotificationsConfig {
  const d = defaultNotificationsConfig();
  const node = isPlainObject(raw) ? raw : {};
  const slack = isPlainObject(node.slack) ? node.slack : {};
  return {
    slack: {
      channel: typeof slack.channel === "string" && slack.channel.trim() ? slack.channel.trim() : d.slack.channel,
    },
  };
}

/**
 * Project a merged `fix:` / `dependencies:` / `review:` node onto its full
 * shape, falling back leaf-by-leaf to the shipped default.
 *
 * Total by design: a base built before these blocks existed (or the CLI's empty
 * offline base) still yields a complete, usable policy, so no consumer has to
 * carry its own "if undefined then" branch.
 */
function shapeFix(raw: unknown): FixConfig {
  const d = defaultFixConfig();
  const node = isPlainObject(raw) ? raw : {};
  return {
    maxAttempts: num(node.maxAttempts, d.maxAttempts),
    localIterations: num(node.localIterations, d.localIterations),
    gateTimeoutSeconds: num(node.gateTimeoutSeconds, d.gateTimeoutSeconds),
    escalateModelAfterAttempt: num(node.escalateModelAfterAttempt, d.escalateModelAfterAttempt),
    maxCostUsd: node.maxCostUsd === null ? null : num(node.maxCostUsd, d.maxCostUsd ?? 0),
    maxFlakyDeferrals: num(node.maxFlakyDeferrals, d.maxFlakyDeferrals),
    retryableClasses: Array.isArray(node.retryableClasses) ? stringList(node.retryableClasses) : d.retryableClasses,
  };
}

function shapeDependencies(raw: unknown): DependenciesConfig {
  const d = defaultDependenciesConfig();
  const node = isPlainObject(raw) ? raw : {};
  return {
    autoMergeMaxImpact: isDependencyImpact(node.autoMergeMaxImpact) ? node.autoMergeMaxImpact : d.autoMergeMaxImpact,
    requireSettledChecks: typeof node.requireSettledChecks === "boolean" ? node.requireSettledChecks : d.requireSettledChecks,
    minSettledChecks: num(node.minSettledChecks, d.minSettledChecks),
    auditComment: typeof node.auditComment === "boolean" ? node.auditComment : d.auditComment,
  };
}

function shapeReview(raw: unknown): ReviewConfig {
  const d = defaultReviewConfig();
  const node = isPlainObject(raw) ? raw : {};
  return {
    postsCheck: typeof node.postsCheck === "boolean" ? node.postsCheck : d.postsCheck,
    trigger: isReviewTrigger(node.trigger) ? node.trigger : d.trigger,
    requestLabel: typeof node.requestLabel === "string" && node.requestLabel.trim() ? node.requestLabel.trim() : null,
    skipDraft: typeof node.skipDraft === "boolean" ? node.skipDraft : d.skipDraft,
    generatedPaths: Array.isArray(node.generatedPaths)
      ? node.generatedPaths.filter((p): p is string => typeof p === "string" && !!p.trim()).map((p) => p.trim())
      : d.generatedPaths,
  };
}

function num(raw: unknown, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
}

function shapeSources(sources: Record<string, unknown>): RepoConfigSources {
  const disabled = isPlainObject(sources.disabled) ? sources.disabled : {};
  const pick = (key: string): ConfigSource => (isConfigSource(disabled[key]) ? disabled[key] : "default");
  return {
    models: sourceMap(sources.models),
    variants: sourceMap(sources.variants),
    disabled: {
      workflows: pick("workflows"),
      crons: pick("crons"),
      prompts: pick("prompts"),
      skills: pick("skills"),
      agentContext: pick("agentContext"),
    },
    approval: sourceMap(sources.approval),
    fix: sourceMap(sources.fix),
    dependencies: sourceMap(sources.dependencies),
    review: sourceMap(sources.review),
    // Flattened to a dotted leaf ("slack.channel") because `notifications:` is
    // the one block that nests, and `RepoConfigSources` is deliberately flat —
    // the dashboard renders provenance as a leaf→layer table, not a tree.
    notifications: nestedSourceMap(sources.notifications),
  };
}

/** Like {@link sourceMap}, but descends one level and joins with a dot. */
function nestedSourceMap(raw: unknown): Record<string, ConfigSource> {
  const out: Record<string, ConfigSource> = {};
  if (!isPlainObject(raw)) return out;
  for (const [group, node] of Object.entries(raw)) {
    if (isConfigSource(node)) {
      out[group] = node;
      continue;
    }
    if (isPlainObject(node)) {
      for (const [leaf, source] of Object.entries(node)) {
        if (isConfigSource(source)) out[`${group}.${leaf}`] = source;
      }
    }
  }
  return out;
}

/** Narrow an unknown provenance leaf to a {@link ConfigSource}. */
export function isConfigSource(value: unknown): value is ConfigSource {
  return value === "default" || value === "overlay" || value === "env" || value === "repo";
}

function stringMap(raw: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (isPlainObject(raw)) for (const [k, v] of Object.entries(raw)) if (typeof v === "string") out[k] = v;
  return out;
}

function boolMap(raw: unknown): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  if (isPlainObject(raw)) for (const [k, v] of Object.entries(raw)) out[k] = v === true;
  return out;
}

function sourceMap(raw: unknown): Record<string, ConfigSource> {
  const out: Record<string, ConfigSource> = {};
  if (isConfigSource(raw)) return out;
  if (isPlainObject(raw)) for (const [k, v] of Object.entries(raw)) if (isConfigSource(v)) out[k] = v;
  return out;
}

function stringList(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((v): v is string => typeof v === "string") : [];
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

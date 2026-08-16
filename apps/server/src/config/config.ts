import { readFileSync, existsSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { normalizeAllowlistHost } from "../sandbox/egress-allowlist.js";
import { HOLD_LABEL } from "../cron/dependabot-discovery.js";
import { resolveConfigLayers } from "./config-resolve.js";
import {
  DEFAULT_REPO_CONFIG_ALLOW_KEYS,
  type RepoConfigPolicy,
} from "lastlight-shared/repo-config-schema";
import type { SandboxBackend, BuildAssetsLocation, OtelConfig } from "lastlight-workflow-engine";
import { logger } from "../logging/logger.js";

const log = logger("config");

/**
 * Load .env file into process.env (simple, no dependency).
 * Does not overwrite existing env vars.
 */
function loadDotEnv(path: string): void {
  if (!existsSync(path)) return;
  const content = readFileSync(path, "utf-8");
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let value = trimmed.slice(eqIdx + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!(key in process.env)) {
      process.env[key] = value;
    }
  }
}

/** How the Slack connector receives events. */
export type SlackMode = "webhook" | "socket";

export interface SlackConfig {
  botToken: string;
  /**
   * `webhook` — HTTP Events API (default, reliable at-least-once delivery,
   * needs `signingSecret` + the shared HTTP server). `socket` — Socket Mode
   * (dev fallback, needs `appToken`, at-most-once so it can drop messages).
   */
  mode: SlackMode;
  /** Socket Mode app-level token (xapp-…). Required only when mode === "socket". */
  appToken?: string;
  /** Events API signing secret. Required only when mode === "webhook". */
  signingSecret?: string;
  allowedUsers: string[];
  /**
   * The LAST-RESORT channel for anything the harness sends that isn't a reply
   * to a thread — today, a repo digest whose repo named no channel of its own.
   * From `SLACK_DELIVERY_CHANNEL` (or the `SLACK_HOME_CHANNEL` alias).
   */
  deliveryChannel?: string;
  /**
   * Operator-side per-repo channel routing: `"owner/repo"` → channel id. Sits
   * between a repo's own `notifications.slack.channel` and `deliveryChannel`.
   * From the overlay's `slack.repoChannels` — a map is impractical in env, and
   * this is deployment config rather than a secret.
   */
  repoChannels: Record<string, string>;
}

/** The weekly Slack repo digest. Operator-only — see {@link RuntimeConfig.digest}. */
export interface DigestConfig {
  /** How far back a digest looks, in days. */
  windowDays: number;
  /** Spend one cheap model call on a plain-English summary sentence. */
  narrative: boolean;
  /** Cap on each enumerated list (unreviewed PRs, escalations). */
  maxItems: number;
}

export interface ModelConfig {
  default: string;
  [taskType: string]: string;
}

export interface VariantConfig {
  default?: string;
  [taskType: string]: string | undefined;
}

// SandboxBackend / BuildAssetsLocation / OtelConfig moved into the workflow
// engine's own vocabulary (`workflow-engine/core/types.ts`) so ExecutorConfig
// (which lives there now) has no back-edge to the config layer. Imported for
// in-file use and re-exported so every existing `../config/config.js` import
// keeps resolving unchanged.
export type { SandboxBackend, BuildAssetsLocation, OtelConfig } from "lastlight-workflow-engine";

// DisabledConfig / RouteConfig moved into `lastlight-shared` (the workflow
// loader — which lives there now — needs them, and shared must never depend
// back on core; locked decision 11). Imported for in-file use and re-exported
// so every existing `../config/config.js` importer keeps resolving unchanged.
import type { DisabledConfig, RouteConfig } from "lastlight-shared/config-types";
export type { DisabledConfig, RouteConfig } from "lastlight-shared/config-types";

// The `fix:` / `dependencies:` / `review:` policy blocks (issues #251/#252).
// They live in `lastlight-shared` for the same reason as the two above PLUS one
// more: they are repo-settable, so the repo-layer sanitizer — which the CLI also
// compiles — has to name their shape and their shipped defaults. Imported for
// in-file use and re-exported so `../config/config.js` stays the one import
// surface for the runtime config shape.
import {
  DIAGNOSIS_CLASSES,
  defaultDependenciesConfig,
  defaultFixConfig,
  defaultNotificationsConfig,
  defaultReviewConfig,
  isDependencyImpact,
  isDiagnosisClass,
  isReviewTrigger,
  type DependenciesConfig,
  type FixConfig,
  type NotificationsConfig,
  type ReviewConfig,
} from "lastlight-shared/config-types";
export type {
  DependenciesConfig,
  DependencyImpact,
  FixConfig,
  NotificationsConfig,
  ReviewConfig,
  ReviewTrigger,
} from "lastlight-shared/config-types";
export {
  defaultDependenciesConfig,
  defaultFixConfig,
  defaultNotificationsConfig,
  defaultReviewConfig,
} from "lastlight-shared/config-types";

export interface PublicConfigBundle {
  default: Record<string, unknown>;
  overlay: Record<string, unknown> | null;
  merged: Record<string, unknown>;
  /**
   * Provenance tree mirroring `merged`: object nodes stay nested, each leaf is
   * the layer that supplied the effective value ("default" | "overlay" | "env").
   * The Default/Overlay/Merged dashboard view is derived from this rather than
   * hand-maintained (issue #99).
   */
  sources: Record<string, unknown>;
}

export interface LastLightConfig {
  port: number;
  webhookSecret: string;
  /**
   * The GitHub App slug (no `[bot]` suffix) — e.g. `last-light` or
   * `nearform-lastlight`. Single source of truth for the bot's identity:
   * derives the incoming `@mention` handle (router), `botLogin`
   * (`${botName}[bot]`, self-comment/self-review filter), and the git commit
   * author. Overridable via overlay `config.yaml` `botName` or the
   * `GITHUB_APP_BOT_NAME` env var; defaults to `last-light`.
   */
  botName: string;
  botLogin: string;
  dbPath: string;
  overlayDir?: string;
  builtInRoot: string;
  stateDir: string;
  sandboxDir: string;
  sessionsDir: string;
  model: string;
  models: ModelConfig;
  variants: VariantConfig;
  maxTurns: number;
  sandbox: SandboxBackend;
  /**
   * The `kubernetes` backend's own config block (namespace/image/PVC/security
   * context), normalized from `sandbox.kubernetes` in the YAML config. Kept as
   * a separate field rather than reshaping `sandbox` above, which many call
   * sites read as the plain backend string. `undefined` when the block is
   * absent from config — {@link resolveKubernetesConfig} applies env
   * overrides and defaults on top.
   */
  kubernetes?: Partial<KubernetesConfig>;
  /** Where build handoff docs live: "repo" (committed) | "server" (externalized). */
  buildAssets: BuildAssetsLocation;
  /** Filesystem root for server-mode build assets (default $STATE_DIR/build-assets). */
  buildAssetsDir: string;
  /**
   * Core-version pin the overlay declares (`deploy.version` in config.yaml, or
   * the `LASTLIGHT_CORE_VERSION` env override). A git tag/ref (e.g. `v0.10.6`)
   * that `lastlight server update|setup` checks core out at; `null` means track
   * `main`. Read raw from the overlay by `readCorePin()` — this field mirrors it
   * for the dashboard `/config` view. See src/config/core-pin.ts.
   */
  deploy: { version: string | null };
  managedRepos: string[];
  routes: RouteConfig;
  disabled: DisabledConfig;
  /**
   * Which crons participate, per layer (issue #180). Normalized here from the
   * `crons:` block; the legacy `disabled.crons` list is unioned into
   * {@link CronsConfig.disable} so both spellings mean the same thing. Read by
   * `src/cron/jobs.ts` (global on/off) and `src/cron/repo-crons.ts` (per-repo
   * fan-out). Always present — an empty pair is the "everything runs" default.
   */
  crons: CronsConfig;
  otel: OtelConfig;
  publicConfig: PublicConfigBundle;
  githubApp?: {
    appId: string;
    privateKeyPath: string;
    /**
     * LEGACY seed only. Installations are discovered from the App JWT and
     * resolved per repo OWNER (`engine/github/installations.ts`), because an App
     * installed on several accounts has one id per account and a token minted
     * against the wrong one is rejected. Kept because an existing deployment
     * still sets `GITHUB_APP_INSTALLATION_ID`: it is the last-resort answer when
     * the JWT lookup itself fails, so such a deployment degrades to exactly its
     * old single-installation behaviour rather than to none.
     */
    installationId?: string;
  };
  /**
   * Fallback GitHub auth: a raw Personal Access Token, used ONLY when no GitHub
   * App is configured. Enables read-only GitHub in chat + CLI-driven read-only
   * workflows without the full App + webhook setup. Secret / env-only — never
   * surfaced by the public-config endpoint. A PAT is static (no per-run
   * downscoping), so a read-only fine-grained PAT is the safe default.
   */
  githubToken?: string;
  slack?: SlackConfig;
  approval?: Record<string, boolean>;
  bootstrapLabel: string;
  /**
   * The HOLD label (`hold.label`, env `LASTLIGHT_HOLD_LABEL`) — a maintainer
   * applies it to an issue or PR to stop Last Light acting on that subject at
   * all. Read at the dispatch gate (`resolveDispatchDisposition`) and in the
   * router's issue path; see {@link HOLD_LABEL} for the packaged default and
   * why it is a live precondition rather than a stored record.
   *
   * Operator-only on purpose: it is not in `repoConfig.allowKeys`, because the
   * label is the affordance a repo's own maintainers already have — a repo that
   * could RENAME it could also rename it to something nobody applies.
   */
  holdLabel: string;
  exploreDefaultRepo?: string;
  publicUrl?: string;
  /**
   * `review.postsCheck`, flattened. Predates the `review:` block below and is
   * still what `src/index.ts` hands the dispatcher; kept as the same value read
   * two ways rather than a second source of truth.
   */
  reviewPostsCheck: boolean;
  /**
   * When `pr-review` runs, plus the draft/label rules (Phase 7 of the
   * dependency-PR-resilience plan). Repo-settable and add-only where it matters
   * — see `packages/shared/src/repo-config-schema.ts`.
   */
  review: ReviewConfig;
  /**
   * Retry/escalation budgets for the PR_FIX_SHAPED workflows (issue #251) and
   * the major-bump auto-merge policy (issue #252). Both blocks resolve through
   * all four layers (default → overlay → env → repo) and are clamped so a repo
   * can only ever be more conservative than the operator.
   */
  fix: FixConfig;
  dependencies: DependenciesConfig;
  concurrency: { maxWorkflows: number; maxQueueWaitMs: number };
  /**
   * Sandbox-workspace reaping (issue #106). The harness owns cleanup of the
   * on-disk clones under `$STATE_DIR/sandboxes/<taskId>/`: `reapOnCompletion`
   * removes an ephemeral run's workspace on terminal success; the TTL sweep
   * (`enabled`, `sweepSchedule`) is the backstop for failed/crashed leftovers
   * and bounds the reusable per-PR cache via age (`retentionHours`) + an LRU
   * dir cap (`maxDirs`). Replaces the out-of-band host cron.
   */
  cleanup: { sandbox: SandboxCleanupConfig };
  /**
   * Reaction-derived eval signals (issue #255) — a 👍/👎 on something the bot
   * wrote, scored against the run that wrote it.
   *
   * Operator-only, deliberately: it governs API spend and telemetry export, and
   * a target repo has no business tuning either. It is absent from
   * `repoConfig.allowKeys`, and the repo-layer sanitizer drops unknown keys
   * anyway — so no clamp is needed for it to stay ours.
   */
  feedback: FeedbackConfig;
  /**
   * The weekly Slack repo digest (`workflows/cron-digest.yaml`). Operator-only:
   * a repo chooses WHERE its digest goes (`notifications.slack.channel`), never
   * how far back it looks or whether it spends a model call.
   */
  digest: DigestConfig;
  /**
   * GitHub team-based per-repo dashboard visibility (issue #169). Operator-only
   * for the same reason as `feedback`: it governs API spend and who sees what,
   * neither of which a target repo has any business tuning.
   */
  teamVisibility: TeamVisibilityConfig;
  /**
   * Operator bounds on the per-repository config layer (issue #180) — what a
   * managed repo's committed `.lastlight/lastlight.yml` is allowed to override
   * for runs against that repo. Always normalized (never undefined) and inert
   * by default: it only starts mattering once a repo commits `.lastlight/`.
   */
  repoConfig: RepoConfigPolicy;
}

/**
 * Which crons a config layer opts in / out of (issue #180). Valid in
 * `config/default.yaml`, in an overlay's `config.yaml`, and in a managed repo's
 * `.lastlight/lastlight.yml` — the SAME block at every layer, read with a
 * layer-specific meaning:
 *
 *   operator (default + overlay)  disable → the cron is off globally
 *                                 enable  → a no-op re-affirmation of the default
 *   repo (`.lastlight/`)          disable → this repo drops out of that cron's fan-out
 *                                 enable  → this repo opts IN even when it's off globally
 *
 * A name listed in BOTH wins as `disable` at every layer — a cron that doesn't
 * run is always the safe reading of a contradictory config.
 *
 * "Off globally" now means "off by default", not "structurally removed": the
 * tick is still registered so a repo's opt-in can be resolved at fan-out time
 * (see `src/cron/jobs.ts`). An operator who wants a kill switch repos can NOT
 * override drops `crons` from `repoConfig.allowKeys` instead.
 */
export interface CronsConfig {
  /** Cron names turned ON at this layer. */
  enable: string[];
  /**
   * Cron names turned OFF at this layer. The legacy `disabled.crons` list is
   * unioned in here by the normaliser, so existing deployments keep working
   * unchanged and both spellings are read from one place.
   */
  disable: string[];
}

/**
 * The per-repo config layer's bounds, re-exported from `lastlight-shared` so
 * `src/config/config.js` stays the single import surface for the runtime config
 * shape — but with exactly ONE definition, in the leaf package. The CLI
 * validates a `.lastlight/` offline against the same type and constant and may
 * never gain an edge to core, so shared is the only place both can reach; a
 * structural copy here would be free to drift from the bounds actually enforced
 * at resolve time. {@link DEFAULT_REPO_CONFIG_ALLOW_KEYS} must also stay in step
 * with `repoConfig.allowKeys` in `config/default.yaml` (pinned by
 * `tests/config/repo-config-shared.test.ts`).
 */
export type { RepoConfigPolicy } from "lastlight-shared/repo-config-schema";
export { DEFAULT_REPO_CONFIG_ALLOW_KEYS } from "lastlight-shared/repo-config-schema";

/** The `kubernetes` sandbox backend's own config surface — namespace, image,
 *  and the PVC/security-context knobs later Plan-2 tasks wire into the
 *  adapter. Resolved by {@link resolveKubernetesConfig}, never read directly
 *  off `LastLightConfig` (kept off the `sandbox` field, which many call sites
 *  read as the plain `SandboxBackend` string). */
export interface KubernetesConfig {
  namespace: string;
  image: string;
  storageClassName: string;
  workspaceSize: string;
  runAsUser: number;
  /** Base URL the sandbox's skills initContainer fetches the bundle from
   *  (the harness Service, cross-namespace). */
  harnessEndpoint: string;
  /** The harness Pod's namespace — the `toEndpoints` egress selector. */
  harnessNamespace: string;
  /** The harness Pod's Cilium selector labels — the `toEndpoints` egress rule. */
  harnessPodLabels: Record<string, string>;
}

export interface SandboxCleanupConfig {
  /** Master switch for the in-harness TTL/LRU sweep. */
  enabled: boolean;
  /** Reap an ephemeral run's workspace on terminal success. */
  reapOnCompletion: boolean;
  /** Cron schedule for the backstop sweep (default hourly). */
  sweepSchedule: string;
  /** Sweep removes non-live dirs older than this many hours. */
  retentionHours: number;
  /** LRU cap on dir count — bounds the reusable per-PR cache. */
  maxDirs: number;
}

/**
 * Feedback signals (issue #255).
 *
 * The two switches are separate because the two surfaces cost different things.
 * **Slack is free and live** — `reaction_added` is a real event, so `enabled`
 * turns on a webhook handler and nothing else. **GitHub has to be polled**:
 * GitHub delivers no webhook for reactions at all, so `github` opts into a cron
 * that batches reaction reads over the GraphQL API. That one is off by default
 * — an operator should switch it on knowingly and watch the numbers, even
 * though the bound below makes them small.
 *
 * The spend is a property of the DATA, not the schedule: we poll *anchors*
 * (individual bot comments a run produced), never issues, each anchor retires
 * after `windowDays`, and `maxAnchorsPerTick / 100` is the exact number of
 * GraphQL requests a tick can issue — each costing one rate-limit point.
 */
export interface FeedbackConfig {
  /** Master switch. Off means no anchors are registered and no signals recorded. */
  enabled: boolean;
  /** Opt into the GitHub reaction poller. Slack is unaffected by this. */
  github: boolean;
  /** Cron schedule for the GitHub poller. Ignored when `github` is false. */
  pollSchedule: string;
  /** How long after posting an anchor stays pollable. Reactions arrive in hours. */
  windowDays: number;
  /** Hard per-tick bound. 100 anchors = one GraphQL request = one rate-limit point. */
  maxAnchorsPerTick: number;
  /** Anchors are pruned past this; the signals themselves are kept forever. */
  retentionDays: number;
  /** Export each signal as an OTel span + metric (no-op when telemetry is off). */
  otel: boolean;
}

/**
 * GitHub team-based per-repo visibility in the admin dashboard (issue #169).
 *
 * **UI declutter, not access control.** Every list endpoint keeps returning
 * global data; this only tells the dashboard which repos to show a given person
 * by default. That is what makes the whole design safe to bound so aggressively
 * — every budget below, when blown, simply shows more than strictly necessary.
 *
 * **Off by default**, because it needs the GitHub App's org `Members: read`
 * permission, which existing installations have not consented to. Turning it on
 * without that consent is harmless (resolution errors → everyone sees
 * everything, as today) but pointless, so it must be asked for.
 */
export interface TeamVisibilityConfig {
  /** Master switch. Off ⇒ `/me/repos` always returns the fail-open sentinel. */
  enabled: boolean;
  /** How long a resolved (or failed) answer is reused before re-resolving. */
  ttlMinutes: number;
  /**
   * Cap on teams considered per login. Somebody in more teams than this fails
   * open rather than costing a page-per-team walk on every cache miss.
   */
  maxTeamsPerUser: number;
  /**
   * Cap on 100-repo pages fetched per team. A team granted more repos than this
   * is marked truncated, and its members fail open — a partial repo list would
   * HIDE repos they can really see, which is worse than not filtering.
   */
  maxPagesPerTeam: number;
  /** Absolute ceiling on GraphQL requests one resolution may issue. */
  maxRequestsPerResolve: number;
}

let currentConfig: LastLightConfig | undefined;
let currentPublicConfig: PublicConfigBundle | undefined;

export function setRuntimeConfig(config: LastLightConfig): void {
  currentConfig = config;
  currentPublicConfig = config.publicConfig;
}

export function getRuntimeConfig(): LastLightConfig | undefined {
  return currentConfig;
}

export function resetRuntimeConfigForTests(): void {
  currentConfig = undefined;
  currentPublicConfig = undefined;
}

export function getPublicConfig(): PublicConfigBundle {
  if (!currentPublicConfig) {
    loadConfig();
  }
  return currentPublicConfig!;
}

export function getRoutes(): RouteConfig {
  return currentConfig?.routes || defaultRouteConfig();
}

/**
 * The configured bot slug (no `[bot]` suffix), e.g. `last-light` or
 * `nearform-lastlight`. Returns the `last-light` default when config isn't
 * loaded yet (unit tests). Drives the router's `@mention` handle plus the
 * derived `botLogin` and git commit author.
 */
export function getBotName(): string {
  return currentConfig?.botName || "last-light";
}

/**
 * The OPERATOR's `review:` block, with the packaged defaults when config isn't
 * loaded yet (unit tests).
 *
 * The router uses it for exactly one thing — dropping a `pr.labeled` whose
 * label is not `review.requestLabel` — because that is a hard ROUTER-level
 * ignore, not a mode decision: a label nobody configured is not an event about
 * us at all, and resolving a whole `PrState` to discover that would make
 * routine labelling cost a handful of GitHub calls per label per PR. Every
 * actual trigger-mode decision stays in `resolveReviewTrigger`, at the dispatch
 * gate, where the repo layer has been folded in.
 */
export function getReviewConfig(): ReviewConfig {
  return currentConfig?.review || defaultReviewConfig();
}

/**
 * The configured HOLD label, with the packaged default when config isn't loaded
 * yet (unit tests) — see {@link LastLightConfig.holdLabel} and {@link HOLD_LABEL}.
 *
 * Read in exactly two places, both of which are choke points rather than
 * policies: `resolveDispatchDisposition` (every PR-scoped route) and the
 * router's subject-level ignore (every other workflow, PRs and issues alike).
 * Nothing else may branch on it — a hold that some routes honour and others do
 * not is worse than no hold at all.
 */
export function getHoldLabel(): string {
  return currentConfig?.holdLabel || HOLD_LABEL;
}

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

function defaultConfigPath(): string {
  const cwdPath = resolve("config/default.yaml");
  if (existsSync(cwdPath)) return cwdPath;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../../config/default.yaml");
}

function readYamlFile(path: string, required: boolean): Record<string, unknown> | null {
  if (!existsSync(path)) {
    if (required) throw new Error(`Config file not found: ${path}`);
    return null;
  }
  try {
    const parsed = parseYaml(readFileSync(path, "utf-8"));
    if (!isPlainObject(parsed)) throw new Error("top-level config must be a mapping");
    return parsed as Record<string, unknown>;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Invalid config file ${path}: ${msg}`);
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function clonePublic(obj: Record<string, unknown> | null): Record<string, unknown> | null {
  return obj ? JSON.parse(JSON.stringify(obj)) as Record<string, unknown> : null;
}

/**
 * Keys whose name looks secret-bearing. Real secrets are env-only and never
 * read from YAML, so the public config bundle should never legitimately
 * contain these — but an operator could paste one into config.yaml by mistake.
 * Redact defensively so the dashboard /config view can't echo it back.
 *
 * SINGLE SOURCE — do not copy this rule. It guards every surface that echoes
 * YAML back to the dashboard: the global bundle here, and the admin routes'
 * `GET /config` + `GET /repos/:owner/:repo/config` (the latter echoes a repo's
 * UNTRUSTED, pre-validation `.lastlight/lastlight.yml`, so it is the one place a
 * pasted credential could round-trip out). A second copy that fell behind this
 * one would be a leak, not a style problem, so both are exported and imported
 * rather than mirrored by hand.
 */
export const SENSITIVE_KEY_RE =
  /secret|token|password|passwd|credential|private[-_]?key|signing[-_]?key|api[-_]?key|key[-_]?path|\bpem\b/i;

/**
 * Recursively redact secret-looking keys from a public (non-secret) config tree.
 * Exported alongside {@link SENSITIVE_KEY_RE} for the admin routes — same rule,
 * same walk, one definition.
 */
export function redactPublic<T>(value: T): T {
  if (Array.isArray(value)) return value.map((v) => redactPublic(v)) as unknown as T;
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      out[k] = SENSITIVE_KEY_RE.test(k) ? "[redacted]" : redactPublic(v);
    }
    return out as unknown as T;
  }
  return value;
}

/**
 * Load configuration from config/default.yaml, optional LASTLIGHT_OVERLAY_DIR/config.yaml,
 * then legacy environment variables. Secrets remain env-only.
 */
export function loadConfig(): LastLightConfig {
  loadDotEnv(resolve(".env"));

  const builtInConfigPath = defaultConfigPath();
  const builtInRoot = resolve(dirname(builtInConfigPath), "..");
  const defaultRaw = readYamlFile(builtInConfigPath, true)!;
  const overlayDirRaw = process.env.LASTLIGHT_OVERLAY_DIR?.trim();
  const overlayDir = overlayDirRaw ? resolve(overlayDirRaw) : undefined;
  let overlayRaw: Record<string, unknown> | null = null;
  if (overlayDir) {
    if (!existsSync(overlayDir) || !statSync(overlayDir).isDirectory()) {
      throw new Error(
        `LASTLIGHT_OVERLAY_DIR overlay directory does not exist or is not a directory: ${overlayDir}. ` +
          `Create or clone your deployment overlay there (e.g. the instance/ folder), or unset LASTLIGHT_OVERLAY_DIR.`,
      );
    }
    // Fast-exit on an unpopulated overlay. The common docker footgun is a bind
    // mount auto-creating an empty instance/ when the operator forgot to clone
    // or populate it — better to fail loudly at startup than silently boot a
    // no-op instance with no managed repos and no secrets.
    const OVERLAY_MARKERS = ["config.yaml", "secrets", "workflows", "skills", "agent-context"];
    if (!OVERLAY_MARKERS.some((m) => existsSync(join(overlayDir, m)))) {
      throw new Error(
        `LASTLIGHT_OVERLAY_DIR is set to ${overlayDir} but the overlay is empty — ` +
          `expected at least one of: ${OVERLAY_MARKERS.join(", ")}. ` +
          `Clone or create your deployment overlay (instance/), or unset LASTLIGHT_OVERLAY_DIR.`,
      );
    }
    overlayRaw = readYamlFile(join(overlayDir, "config.yaml"), false);
  }

  // Build the env layer once: a partial config tree in the same shape as the
  // YAML layers. This is the single place that maps env vars onto config paths
  // (LASTLIGHT_MODELS → models.*, legacy OPENCODE_* aliases, …). Once built,
  // one uniform precedence pass (env > overlay > default) produces the merged
  // tree and its provenance — no field re-parses an env var after the merge.
  const envLayer = buildEnvConfigLayer(process.env);
  const { value: mergedRaw, sources: mergedSources } = resolveConfigLayers({
    default: defaultRaw,
    overlay: overlayRaw,
    env: envLayer,
  });
  const fileCfg = normalizeFileConfig(mergedRaw);

  const stateDir = resolve(stringEnv("STATE_DIR", "./data"));
  const models = fileCfg.models;
  const model = models.default;
  const variants = fileCfg.variants;
  const sandbox = fileCfg.sandbox.backend;
  const maxTurns = fileCfg.sandbox.maxTurns;
  const buildAssets = fileCfg.buildAssets;
  const buildAssetsDir = resolve(
    stringEnv("BUILD_ASSETS_DIR", join(stateDir, "build-assets")),
  );

  // Two documented exceptions to plain key-by-key precedence, preserved for
  // backward compatibility (and kept out of the generic env layer so the file
  // layers survive):
  //  - approval: APPROVAL_GATES replaces the file map wholesale (not a merge).
  //  - otel.collectorHosts: env hosts are unioned with file hosts (not replaced),
  //    so an OTEL endpoint env var adds to, rather than drops, overlay hosts.
  const approval = process.env.APPROVAL_GATES !== undefined
    ? parseApprovalGates()
    : fileCfg.approval;
  const envCollectorHosts = [
    ...parseCollectorHosts(process.env.LASTLIGHT_OTEL_COLLECTOR_HOSTS, "LASTLIGHT_OTEL_COLLECTOR_HOSTS"),
    ...parseOtelCollectorHostsFromEnv(process.env),
  ];
  const otel: OtelConfig = {
    ...fileCfg.otel,
    collectorHosts: Array.from(new Set([...fileCfg.otel.collectorHosts, ...envCollectorHosts])),
  };

  // Derive the merged public surface from the single resolution, folding the
  // two exceptions above back in so it reflects effective values. The
  // provenance tree is patched to attribute env-driven exceptions to env.
  const mergedPublic: Record<string, unknown> = { ...mergedRaw, approval, otel };
  if (process.env.APPROVAL_GATES !== undefined) {
    (mergedSources as Record<string, unknown>).approval = "env";
  }
  if (envCollectorHosts.length) {
    const otelSources = isPlainObject(mergedSources.otel)
      ? (mergedSources.otel as Record<string, unknown>)
      : ((mergedSources as Record<string, unknown>).otel = {});
    otelSources.collectorHosts = "env";
  }

  const githubApp = process.env.GITHUB_APP_ID
    ? {
        appId: process.env.GITHUB_APP_ID,
        privateKeyPath: requireEnv("GITHUB_APP_PRIVATE_KEY_PATH"),
        // Optional — see the type. Discovery is the real mechanism.
        installationId: process.env.GITHUB_APP_INSTALLATION_ID || undefined,
      }
    : undefined;

  // PAT fallback: only when no App is configured. App always wins.
  const githubToken = !githubApp && process.env.GITHUB_TOKEN
    ? process.env.GITHUB_TOKEN
    : undefined;

  const slack = process.env.SLACK_BOT_TOKEN
    ? ((): SlackConfig => {
        // Mode resolution: an explicit SLACK_MODE always wins. Otherwise
        // auto-detect — prefer webhook (the reliable path) the moment a signing
        // secret is configured, else fall back to socket. This keeps a plain
        // SLACK_APP_TOKEN deployment on Socket Mode until the operator opts into
        // webhooks by adding SLACK_SIGNING_SECRET, so simply shipping this code
        // never breaks an existing Socket-Mode instance.
        const explicit = (process.env.SLACK_MODE || "").trim().toLowerCase();
        const mode: SlackMode =
          explicit === "socket" ? "socket"
          : explicit === "webhook" ? "webhook"
          : process.env.SLACK_SIGNING_SECRET ? "webhook" : "socket";
        if (mode === "webhook" && !process.env.SLACK_SIGNING_SECRET) {
          throw new Error("SLACK_MODE=webhook requires SLACK_SIGNING_SECRET");
        }
        if (mode === "socket" && !process.env.SLACK_APP_TOKEN) {
          throw new Error("SLACK_MODE=socket requires SLACK_APP_TOKEN (or set SLACK_SIGNING_SECRET to use webhook mode)");
        }
        return {
          botToken: process.env.SLACK_BOT_TOKEN!,
          mode,
          appToken: process.env.SLACK_APP_TOKEN || undefined,
          signingSecret: process.env.SLACK_SIGNING_SECRET || undefined,
          allowedUsers: (process.env.SLACK_ALLOWED_USERS || "").split(",").filter(Boolean),
          deliveryChannel: process.env.SLACK_DELIVERY_CHANNEL || process.env.SLACK_HOME_CHANNEL || undefined,
          // The one Slack key that is NOT a credential, so it comes from the
          // layered YAML rather than env — see `SlackConfig.repoChannels`.
          repoChannels: fileCfg.slack.repoChannels,
        };
      })()
    : undefined;

  const config: LastLightConfig = {
    port: parseInt(process.env.WEBHOOK_PORT || process.env.PORT || "8644", 10),
    webhookSecret: process.env.WEBHOOK_SECRET || "",
    botName: fileCfg.botName,
    botLogin: process.env.BOT_LOGIN || `${fileCfg.botName}[bot]`,
    stateDir,
    sandboxDir: join(stateDir, "sandboxes"),
    sessionsDir: resolve(process.env.LASTLIGHT_SESSIONS_DIR || join(stateDir, "agent-sessions")),
    dbPath: process.env.DB_PATH || join(stateDir, "lastlight.db"),
    builtInRoot,
    overlayDir,
    model,
    models,
    variants,
    maxTurns,
    sandbox,
    kubernetes: fileCfg.kubernetes,
    buildAssets,
    buildAssetsDir,
    deploy: fileCfg.deploy,
    managedRepos: fileCfg.managedRepos,
    routes: fileCfg.routes,
    disabled: fileCfg.disabled,
    crons: fileCfg.crons,
    otel,
    publicConfig: {
      default: redactPublic(clonePublic(defaultRaw)!),
      overlay: redactPublic(clonePublic(overlayRaw)),
      merged: redactPublic(clonePublic(mergedPublic)!),
      sources: redactPublic(clonePublic(mergedSources)!),
    },
    githubApp,
    githubToken,
    slack,
    approval,
    bootstrapLabel: fileCfg.bootstrapLabel,
    holdLabel: fileCfg.holdLabel,
    exploreDefaultRepo: fileCfg.exploreDefaultRepo,
    publicUrl: resolvePublicUrl(),
    reviewPostsCheck: fileCfg.review.postsCheck,
    review: fileCfg.review,
    fix: fileCfg.fix,
    dependencies: fileCfg.dependencies,
    concurrency: fileCfg.concurrency,
    cleanup: fileCfg.cleanup,
    feedback: fileCfg.feedback,
    digest: fileCfg.digest,
    teamVisibility: fileCfg.teamVisibility,
    repoConfig: fileCfg.repoConfig,
  };
  setRuntimeConfig(config);
  return config;
}

function stringEnv(name: string, fallback: string): string {
  const v = process.env[name];
  return v && v.length > 0 ? v : fallback;
}

function normalizeFileConfig(raw: Record<string, unknown>): {
  managedRepos: string[];
  botName: string;
  routes: RouteConfig;
  disabled: DisabledConfig;
  crons: CronsConfig;
  models: ModelConfig;
  variants: VariantConfig;
  sandbox: { backend: SandboxBackend; maxTurns: number };
  kubernetes?: Partial<KubernetesConfig>;
  buildAssets: BuildAssetsLocation;
  deploy: { version: string | null };
  approval: Record<string, boolean>;
  bootstrapLabel: string;
  holdLabel: string;
  exploreDefaultRepo?: string;
  review: ReviewConfig;
  fix: FixConfig;
  dependencies: DependenciesConfig;
  otel: OtelConfig;
  concurrency: { maxWorkflows: number; maxQueueWaitMs: number };
  cleanup: { sandbox: SandboxCleanupConfig };
  feedback: FeedbackConfig;
  digest: DigestConfig;
  /**
   * The non-secret half of the Slack config. Everything else about Slack is a
   * credential and stays env-only; this map is deployment routing, and a map is
   * impractical to express in an env var.
   */
  slack: { repoChannels: Record<string, string> };
  teamVisibility: TeamVisibilityConfig;
  repoConfig: RepoConfigPolicy;
} {
  const managedRepos = stringArray(raw.managedRepos, "managedRepos");
  const botName = typeof raw.botName === "string" && raw.botName.trim() ? raw.botName.trim() : "last-light";
  const routes = normalizeRoutes(raw.routes);
  const disabledRaw = isPlainObject(raw.disabled) ? raw.disabled : {};
  const modelsRaw = isPlainObject(raw.models) ? raw.models : {};
  const variantsRaw = isPlainObject(raw.variants) ? raw.variants : {};
  const sandboxRaw = isPlainObject(raw.sandbox) ? raw.sandbox : {};
  const kubernetesRaw = isPlainObject(sandboxRaw.kubernetes) ? sandboxRaw.kubernetes : undefined;
  const buildAssetsRaw = isPlainObject(raw.buildAssets) ? raw.buildAssets : {};
  const deployRaw = isPlainObject(raw.deploy) ? raw.deploy : {};
  const bootstrapRaw = isPlainObject(raw.bootstrap) ? raw.bootstrap : {};
  const holdRaw = isPlainObject(raw.hold) ? raw.hold : {};
  const exploreRaw = isPlainObject(raw.explore) ? raw.explore : {};
  const reviewRaw = isPlainObject(raw.review) ? raw.review : {};
  const fixRaw = isPlainObject(raw.fix) ? raw.fix : {};
  const dependenciesRaw = isPlainObject(raw.dependencies) ? raw.dependencies : {};
  const approvalRaw = isPlainObject(raw.approval) ? raw.approval : {};
  const otelRaw = isPlainObject(raw.otel) ? raw.otel : {};
  const cronsRaw = isPlainObject(raw.crons) ? raw.crons : {};
  const concurrencyRaw = isPlainObject(raw.concurrency) ? raw.concurrency : {};
  const feedbackRaw = isPlainObject(raw.feedback) ? raw.feedback : {};
  const cleanupRaw = isPlainObject(raw.cleanup) ? raw.cleanup : {};
  const sandboxCleanupRaw = isPlainObject(cleanupRaw.sandbox) ? cleanupRaw.sandbox : {};
  const repoConfigRaw = isPlainObject(raw.repoConfig) ? raw.repoConfig : {};

  const models: ModelConfig = { default: typeof modelsRaw.default === "string" ? modelsRaw.default : DEFAULT_MODEL };
  for (const [k, v] of Object.entries(modelsRaw)) if (typeof v === "string") models[k] = v;
  const variants: VariantConfig = {};
  for (const [k, v] of Object.entries(variantsRaw)) if (typeof v === "string") variants[k] = v;
  const approval: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(approvalRaw)) approval[k] = v === true;

  const backend = sandboxBackend(sandboxRaw.backend, "sandbox.backend");
  const maxTurns = typeof sandboxRaw.maxTurns === "number" ? sandboxRaw.maxTurns : 200;
  const kubernetes = kubernetesRaw ? normalizeKubernetesFileConfig(kubernetesRaw) : undefined;
  const buildAssets = buildAssetsLocation(buildAssetsRaw.location, "buildAssets.location");
  const deployVersion = typeof deployRaw.version === "string" && deployRaw.version.trim() ? deployRaw.version.trim() : null;
  const bootstrapLabel = typeof bootstrapRaw.label === "string" ? bootstrapRaw.label : "lastlight:bootstrap";
  // Lenient like every other leaf here, and with one extra rule: an EMPTY
  // string falls back to the packaged default rather than disabling the hold.
  // `labels.includes("")` is never true, so an operator who wrote `hold.label:
  // ""` would silently get a bot that can no longer be told to stay off
  // anything — a failure mode with no symptom until it matters.
  const holdLabel =
    typeof holdRaw.label === "string" && holdRaw.label.trim() ? holdRaw.label.trim() : HOLD_LABEL;
  const exploreDefaultRepo = typeof exploreRaw.defaultRepo === "string" ? exploreRaw.defaultRepo : undefined;
  // ── The fix / dependencies / review policy blocks (issues #251, #252) ──────
  //
  // Lenient, like `crons` and `repoConfig.allowKeys` above and for the same
  // reason: the SAME blocks are also read out of an untrusted repo layer, so a
  // malformed leaf must degrade to the documented default rather than take the
  // harness down at boot — and the two paths must not disagree about shape. The
  // shipped defaults come from `lastlight-shared` so `config/default.yaml`,
  // this normaliser and the repo-layer clamps can't drift apart.
  const fixDefaults = defaultFixConfig();
  const fix: FixConfig = {
    // Whole numbers, matching the repo-layer clamp in `repo-config-schema.ts`
    // (`positiveInt`). They used to accept any positive number here while the
    // clamp required an integer, so an operator writing `maxAttempts: 2.5` got
    // the REPO layer silently falling back to the shipped default while the
    // operator layer kept 2.5 — two layers disagreeing about the same leaf
    // (#256). `gateTimeoutSeconds` is a duration, not a count, so it stays a
    // plain positive number.
    maxAttempts: positiveInt(fixRaw.maxAttempts, "fix.maxAttempts") ?? fixDefaults.maxAttempts,
    localIterations:
      positiveInt(fixRaw.localIterations, "fix.localIterations") ?? fixDefaults.localIterations,
    gateTimeoutSeconds: positiveNumber(fixRaw.gateTimeoutSeconds) ?? fixDefaults.gateTimeoutSeconds,
    // 0 is meaningful here ("escalate the model from the first retry"), so this
    // one accepts zero where the budgets above require a positive number.
    escalateModelAfterAttempt:
      nonNegativeNumber(fixRaw.escalateModelAfterAttempt) ?? fixDefaults.escalateModelAfterAttempt,
    // An explicit `null` is the documented "no ceiling" value, distinct from an
    // absent/typo'd key which falls back to the shipped ceiling.
    maxCostUsd:
      fixRaw.maxCostUsd === null ? null : nonNegativeNumber(fixRaw.maxCostUsd) ?? fixDefaults.maxCostUsd,
    maxFlakyDeferrals:
      positiveInt(fixRaw.maxFlakyDeferrals, "fix.maxFlakyDeferrals") ?? fixDefaults.maxFlakyDeferrals,
    retryableClasses: diagnosisClassList(fixRaw.retryableClasses) ?? fixDefaults.retryableClasses,
  };

  const dependenciesDefaults = defaultDependenciesConfig();
  const dependencies: DependenciesConfig = {
    autoMergeMaxImpact: isDependencyImpact(dependenciesRaw.autoMergeMaxImpact)
      ? dependenciesRaw.autoMergeMaxImpact
      : dependenciesDefaults.autoMergeMaxImpact,
    requireSettledChecks:
      typeof dependenciesRaw.requireSettledChecks === "boolean"
        ? dependenciesRaw.requireSettledChecks
        : dependenciesDefaults.requireSettledChecks,
    minSettledChecks: nonNegativeNumber(dependenciesRaw.minSettledChecks) ?? dependenciesDefaults.minSettledChecks,
    auditComment:
      typeof dependenciesRaw.auditComment === "boolean"
        ? dependenciesRaw.auditComment
        : dependenciesDefaults.auditComment,
  };

  const reviewDefaults = defaultReviewConfig();
  const review: ReviewConfig = {
    // Historically `review.postsCheck` defaulted OFF for anything that wasn't
    // literally `true`; keep that exact reading.
    postsCheck: reviewRaw.postsCheck === true,
    trigger: isReviewTrigger(reviewRaw.trigger) ? reviewRaw.trigger : reviewDefaults.trigger,
    requestLabel:
      typeof reviewRaw.requestLabel === "string" && reviewRaw.requestLabel.trim()
        ? reviewRaw.requestLabel.trim()
        : null,
    skipDraft: typeof reviewRaw.skipDraft === "boolean" ? reviewRaw.skipDraft : reviewDefaults.skipDraft,
    // An explicit `[]` is meaningful — it turns the generated-only re-review
    // gate OFF — so only a non-array falls back to the packaged list.
    generatedPaths: Array.isArray(reviewRaw.generatedPaths)
      ? reviewRaw.generatedPaths.filter((p): p is string => typeof p === "string" && !!p.trim()).map((p) => p.trim())
      : reviewDefaults.generatedPaths,
  };

  const maxWorkflows =
    typeof concurrencyRaw.maxWorkflows === "number" && concurrencyRaw.maxWorkflows > 0
      ? concurrencyRaw.maxWorkflows
      : 4;
  const maxQueueWaitMs =
    typeof concurrencyRaw.maxQueueWaitMs === "number" && concurrencyRaw.maxQueueWaitMs > 0
      ? concurrencyRaw.maxQueueWaitMs
      : 3_600_000;

  const sandboxCleanup: SandboxCleanupConfig = {
    enabled: sandboxCleanupRaw.enabled !== false,
    reapOnCompletion: sandboxCleanupRaw.reapOnCompletion !== false,
    sweepSchedule:
      typeof sandboxCleanupRaw.sweepSchedule === "string" && sandboxCleanupRaw.sweepSchedule.trim()
        ? sandboxCleanupRaw.sweepSchedule.trim()
        : "0 * * * *",
    retentionHours:
      typeof sandboxCleanupRaw.retentionHours === "number" && sandboxCleanupRaw.retentionHours > 0
        ? sandboxCleanupRaw.retentionHours
        : 12,
    maxDirs:
      typeof sandboxCleanupRaw.maxDirs === "number" && sandboxCleanupRaw.maxDirs > 0
        ? sandboxCleanupRaw.maxDirs
        : 40,
  };

  // Feedback signals (issue #255). Lenient, like every block above: a mistyped
  // key degrades to the shipped default rather than failing boot. `github`
  // defaults to FALSE — the poller is the only part with a recurring cost, so
  // it must be asked for, while `enabled` (Slack, event-driven, free) is on.
  const feedback: FeedbackConfig = {
    enabled: feedbackRaw.enabled !== false,
    github: feedbackRaw.github === true,
    pollSchedule:
      typeof feedbackRaw.pollSchedule === "string" && feedbackRaw.pollSchedule.trim()
        ? feedbackRaw.pollSchedule.trim()
        : "*/30 * * * *",
    windowDays:
      typeof feedbackRaw.windowDays === "number" && feedbackRaw.windowDays > 0
        ? feedbackRaw.windowDays
        : 14,
    maxAnchorsPerTick:
      typeof feedbackRaw.maxAnchorsPerTick === "number" && feedbackRaw.maxAnchorsPerTick > 0
        ? feedbackRaw.maxAnchorsPerTick
        : 500,
    retentionDays:
      typeof feedbackRaw.retentionDays === "number" && feedbackRaw.retentionDays > 0
        ? feedbackRaw.retentionDays
        : 90,
    otel: feedbackRaw.otel !== false,
  };

  // The weekly repo digest. Lenient like every block above. There is no
  // `enabled` flag on purpose: the digest is gated on a CHANNEL resolving for a
  // repo, so a deployment that configured no channel already gets nothing, and
  // a second switch would just be a way to have the cron on and the feature off.
  // `crons.disable: [repo-digest]` is the off switch.
  // Operator channel routing, `"owner/repo"` → channel id. Silently drops a
  // malformed entry rather than failing boot, like every block here: a typo'd
  // repo key costs that repo its digest, which the admin `/config` view shows.
  const slackRaw = isPlainObject(raw.slack) ? raw.slack : {};
  const repoChannelsRaw = isPlainObject(slackRaw.repoChannels) ? slackRaw.repoChannels : {};
  const slackRepoChannels: Record<string, string> = {};
  for (const [repo, channel] of Object.entries(repoChannelsRaw)) {
    if (typeof channel === "string" && channel.trim()) slackRepoChannels[repo.trim()] = channel.trim();
  }

  const digestRaw = isPlainObject(raw.digest) ? raw.digest : {};
  const digest: DigestConfig = {
    windowDays: positiveNumber(digestRaw.windowDays) ?? 7,
    narrative: digestRaw.narrative !== false,
    maxItems: positiveNumber(digestRaw.maxItems) ?? 5,
  };

  // Team-based dashboard visibility (issue #169). Lenient like every block
  // above. `enabled` defaults to FALSE: it needs the App's org `Members: read`
  // permission, so it must be asked for after that re-consent. The budgets are
  // the scaling contract — they bound what ONE cache miss can cost in an org
  // with thousands of repos and hundreds of teams, and blowing any of them
  // fails open rather than showing a partial list.
  const teamVisibilityRaw = isPlainObject(raw.teamVisibility) ? raw.teamVisibility : {};
  const teamVisibility: TeamVisibilityConfig = {
    enabled: teamVisibilityRaw.enabled === true,
    ttlMinutes: positiveNumber(teamVisibilityRaw.ttlMinutes) ?? 60,
    maxTeamsPerUser: positiveNumber(teamVisibilityRaw.maxTeamsPerUser) ?? 50,
    maxPagesPerTeam: positiveNumber(teamVisibilityRaw.maxPagesPerTeam) ?? 20,
    maxRequestsPerResolve: positiveNumber(teamVisibilityRaw.maxRequestsPerResolve) ?? 60,
  };

  // Cron participation (issue #180). Lenient like the blocks above — a
  // mistyped `crons.disable` degrades to "nothing listed" rather than taking
  // the harness down at boot, because the same block is also read out of an
  // untrusted repo layer and the two paths must not disagree about shape.
  //
  // The legacy `disabled.crons` list is UNIONED into `crons.disable` rather
  // than replaced by it: existing deployments (and the asset loader, which
  // still drops a `disabled.crons` cron at load time) are unaffected, and
  // downstream code only has to read one list. `crons.enable` at the operator
  // layer is accepted and kept for provenance/symmetry with the repo layer,
  // but changes nothing — a cron is on unless something disables it.
  const disabledCrons = optionalStringArray(disabledRaw.crons, "disabled.crons");
  const crons: CronsConfig = {
    enable: nonEmptyStringList(cronsRaw.enable) ?? [],
    disable: uniqueNames([...(nonEmptyStringList(cronsRaw.disable) ?? []), ...disabledCrons]),
  };

  // Per-repo config bounds (issue #180). Defaults are deliberately inert: an
  // upgrading deployment that says nothing gets exactly the shipped allow-list
  // and no behaviour change until a repo commits `.lastlight/`. A malformed
  // `allowKeys` / `allowedModels` falls back to the default rather than
  // throwing — this block bounds an untrusted layer, so failing closed on a
  // typo would be worse than the documented default.
  const repoConfig: RepoConfigPolicy = {
    enabled: repoConfigRaw.enabled !== false,
    allowKeys: nonEmptyStringList(repoConfigRaw.allowKeys) ?? [...DEFAULT_REPO_CONFIG_ALLOW_KEYS],
    allowedModels: nonEmptyStringList(repoConfigRaw.allowedModels) ?? null,
    allowAssets: repoConfigRaw.allowAssets !== false,
    // Deny-all default, the INVERSE of allowedModels above. The shipped `[]`, an absent
    // key and a malformed value all collapse to ONE representation — null — so no
    // consumer has to treat "empty list" and "not set" as different states. Both mean
    // "permit nothing" to `ImageAllowlist`; a typo must never widen the grant, because
    // a service image is arbitrary code pulled onto this host.
    allowedImages: emptyToNull(nonEmptyStringList(repoConfigRaw.allowedImages)),
    maxServices: positiveInt(repoConfigRaw.maxServices, "repoConfig.maxServices") ?? 2,
  };

  return {
    managedRepos,
    botName,
    routes,
    disabled: {
      workflows: optionalStringArray(disabledRaw.workflows, "disabled.workflows"),
      crons: disabledCrons,
      prompts: optionalStringArray(disabledRaw.prompts, "disabled.prompts"),
      skills: optionalStringArray(disabledRaw.skills, "disabled.skills"),
      agentContext: optionalStringArray(disabledRaw.agentContext, "disabled.agentContext"),
    },
    crons,
    models,
    variants,
    sandbox: { backend, maxTurns },
    kubernetes,
    buildAssets,
    deploy: { version: deployVersion },
    approval,
    bootstrapLabel,
    holdLabel,
    exploreDefaultRepo,
    review,
    fix,
    dependencies,
    otel: normalizeOtelFileConfig(otelRaw),
    concurrency: { maxWorkflows, maxQueueWaitMs },
    cleanup: { sandbox: sandboxCleanup },
    feedback,
    digest,
    slack: { repoChannels: slackRepoChannels },
    teamVisibility,
    repoConfig,
  };
}

/**
 * The trimmed non-empty strings of an array value, or `undefined` when the
 * value isn't an array at all (absent / null / scalar) — so the caller can
 * apply its own default. An explicitly empty array stays empty rather than
 * falling back, so `allowKeys: []` means "a repo may set nothing".
 *
 * Deliberately lenient (unlike {@link stringArray}, which throws): this backs
 * config blocks whose job is to BOUND untrusted input, where a typo should
 * degrade to the documented default rather than take the harness down at boot.
 */
function nonEmptyStringList(raw: unknown): string[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .filter((v): v is string => typeof v === "string" && v.trim().length > 0)
    .map((v) => v.trim());
}

/**
 * `fix.retryableClasses`, validated against the closed {@link DIAGNOSIS_CLASSES}
 * enum: unknown members are DROPPED with a warning rather than kept or fatal.
 *
 * Dropping is the only correct direction — a class we do not recognise cannot
 * be retried — but doing it silently is what made this worth fixing. A typo
 * (`reproducable`) leaves a list that looks configured and behaves as if every
 * diagnosis were terminal: the second dispatch escalates `not-retryable`, the
 * PR gets `requires-human`, and nothing anywhere names the cause (#256).
 *
 * An explicitly EMPTY result is legal and stays empty (retries off for every
 * class), but says so once — it is a big behaviour change to reach by accident.
 * An absent/scalar key returns `undefined` so the caller applies the default.
 */
function diagnosisClassList(raw: unknown): string[] | undefined {
  const names = nonEmptyStringList(raw);
  if (names === undefined) return undefined;
  const unknown = names.filter((n) => !isDiagnosisClass(n));
  if (unknown.length) {
    log.warn("Ignoring unrecognised diagnosis classes in fix.retryableClasses", {
      unknown,
      allowed: DIAGNOSIS_CLASSES,
    });
  }
  const kept = names.filter(isDiagnosisClass);
  if (!kept.length) {
    log.warn(
      "fix.retryableClasses is empty — every diagnosis will escalate " +
        "not-retryable on the second dispatch, and no PR will be retried",
    );
  }
  return kept;
}

/**
 * A finite number > 0, or `undefined` so the caller can apply its own default.
 * Lenient sibling of {@link nonEmptyStringList} for the numeric policy leaves.
 */
function positiveNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw > 0 ? raw : undefined;
}

/** As {@link positiveNumber}, but 0 is a legal value rather than a fallback trigger. */
function nonNegativeNumber(raw: unknown): number | undefined {
  return typeof raw === "number" && Number.isFinite(raw) && raw >= 0 ? raw : undefined;
}

/**
 * A whole number >= 0, or `undefined` so the caller can apply its own default —
 * the same predicate the repo-layer clamp applies (`positiveInt` in
 * `packages/shared/src/repo-config-schema.ts`).
 *
 * Unlike its lenient siblings above this one WARNS on rejection, because the
 * two paths are not symmetric: a repo's bad leaf is reported back through a
 * structured `RepoConfigWarning` the dashboard and CLI render, while an
 * operator's is only ever seen if we say something. `fix.maxAttempts: 2.5`
 * silently becoming the shipped default is the failure this closes (#256).
 */
/** Collapse "absent" and "empty list" to one value, so callers test one state not two. */
function emptyToNull(list: string[] | undefined): string[] | null {
  return list && list.length > 0 ? list : null;
}

function positiveInt(raw: unknown, path: string): number | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "number" && Number.isInteger(raw) && raw >= 0) return raw;
  log.warn("Ignoring invalid config value — must be a whole number >= 0; falling back to default", {
    path,
    value: raw,
  });
  return undefined;
}

/** De-duplicate a name list, preserving first-seen order (used for unioned lists). */
function uniqueNames(names: string[]): string[] {
  return [...new Set(names)];
}

/**
 * Guard the `sandbox.kubernetes` YAML block field-by-field, keeping only the
 * present, correctly-typed fields — never fills in defaults (that's
 * {@link resolveKubernetesConfig}'s job, so env can still override a value
 * this block leaves unset).
 */
function normalizeKubernetesFileConfig(raw: Record<string, unknown>): Partial<KubernetesConfig> {
  const out: Partial<KubernetesConfig> = {};
  if (typeof raw.namespace === "string" && raw.namespace.trim()) out.namespace = raw.namespace.trim();
  if (typeof raw.image === "string" && raw.image.trim()) out.image = raw.image.trim();
  if (typeof raw.storageClassName === "string" && raw.storageClassName.trim()) {
    out.storageClassName = raw.storageClassName.trim();
  }
  if (typeof raw.workspaceSize === "string" && raw.workspaceSize.trim()) out.workspaceSize = raw.workspaceSize.trim();
  if (typeof raw.runAsUser === "number" && Number.isFinite(raw.runAsUser)) out.runAsUser = raw.runAsUser;
  if (typeof raw.harnessEndpoint === "string" && raw.harnessEndpoint.trim()) {
    out.harnessEndpoint = raw.harnessEndpoint.trim();
  }
  if (typeof raw.harnessNamespace === "string" && raw.harnessNamespace.trim()) {
    out.harnessNamespace = raw.harnessNamespace.trim();
  }
  if (isPlainObject(raw.harnessPodLabels)) {
    out.harnessPodLabels = stringRecord(raw.harnessPodLabels, "kubernetes.harnessPodLabels");
  }
  return out;
}

function normalizeRoutes(raw: unknown): RouteConfig {
  const defaults = defaultRouteConfig();
  if (!isPlainObject(raw)) return defaults;
  return {
    github: { ...defaults.github, ...(isPlainObject(raw.github) ? stringRecord(raw.github, "routes.github") : {}) },
    slack: { ...defaults.slack, ...(isPlainObject(raw.slack) ? stringRecord(raw.slack, "routes.slack") : {}) },
  };
}

/**
 * The in-code route table used when no config has been loaded yet (tests, and
 * any read before `loadConfig`). It MIRRORS the `routes:` block of
 * `config/default.yaml` and must stay identical to it — the two drifted once
 * (verify / qa_test / demo were added to the YAML only), which silently removed
 * those workflows' `@bot` mention triggers from the dashboard's trigger table.
 * `tests/config.test.ts` pins the two together.
 */
export function defaultRouteConfig(): RouteConfig {
  return {
    github: {
      issue_opened: "issue-triage",
      issue_answer: "answer",
      issue_reopened: "issue-triage",
      pr_opened: "pr-review",
      pr_synchronize: "pr-review",
      pr_reopened: "pr-review",
      // Phase 7's three new PR-review routes. Each falls back to `pr_review`
      // when unset, so an overlay that pins only `pr_review` still redirects
      // all of them.
      pr_checks_settled: "pr-review",
      pr_labeled: "pr-review",
      pr_review_requested: "pr-review",
      approval_response: "approval-response",
      security_review: "security-review",
      verify: "verify",
      qa_test: "qa-test",
      demo: "demo",
      pr_fix: "pr-fix",
      pr_review: "pr-review",
      pr_comment: "pr-comment",
      issue_build: "build",
      issue_explore: "explore",
      issue_comment: "issue-comment",
      security_feedback: "security-feedback",
      explore_reply: "explore-reply",
    },
    slack: {
      reset: "chat-reset",
      status: "status-report",
      approve: "approval-response",
      reject: "approval-response",
      build: "build",
      triage: "issue-triage",
      review: "pr-review",
      security: "security-review",
      verify: "verify",
      qa_test: "qa-test",
      demo: "demo",
      explore: "explore",
      answer: "answer",
      chat: "chat",
      explore_reply: "explore-reply",
    },
  };
}

function stringRecord(raw: Record<string, unknown>, path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v !== "string" || !v) throw new Error(`${path}.${k} must be a non-empty string`);
    out[k] = v;
  }
  return out;
}

function stringArray(raw: unknown, path: string): string[] {
  if (!Array.isArray(raw) || raw.some((v) => typeof v !== "string" || !v)) {
    throw new Error(`${path} must be an array of non-empty strings`);
  }
  return raw as string[];
}

function optionalStringArray(raw: unknown, path: string): string[] {
  if (raw === undefined || raw === null) return [];
  return stringArray(raw, path);
}

function sandboxBackend(raw: unknown, path: string): SandboxBackend {
  if (raw === "gondolin" || raw === "docker" || raw === "smol" || raw === "none" || raw === "kubernetes") return raw;
  throw new Error(`${path} must be one of gondolin, docker, smol, none, kubernetes`);
}

function buildAssetsLocation(raw: unknown, path: string): BuildAssetsLocation {
  // Absent → default to repo mode (current behaviour). An explicit bad value
  // is a config error worth surfacing loudly.
  if (raw === undefined || raw === null) return "repo";
  if (raw === "repo" || raw === "server") return raw;
  throw new Error(`${path} must be one of repo, server`);
}

function parseBool(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Materialize all env-var config overrides into one partial tree shaped like
 * the YAML layers, so the precedence resolver can apply them uniformly. This is
 * the single home for env→path knowledge (legacy OPENCODE_* aliases included).
 * `otel.collectorHosts` (union) and `approval` (wholesale replace) are handled
 * separately in loadConfig because their merge semantics differ from the
 * resolver's key-by-key precedence.
 */
function buildEnvConfigLayer(env: NodeJS.ProcessEnv): Record<string, unknown> {
  const layer: Record<string, unknown> = {};

  // models: scalar default first, then the JSON map applied on top — so an
  // explicit `default` key in LASTLIGHT_MODELS wins over LASTLIGHT_MODEL, with
  // no post-merge re-parse.
  const models: Record<string, string> = {};
  const modelDefault = env.LASTLIGHT_MODEL || env.OPENCODE_MODEL;
  if (modelDefault) models.default = modelDefault;
  applyJsonStringMap(models, env.LASTLIGHT_MODELS || env.OPENCODE_MODELS, "LASTLIGHT_MODELS");
  if (Object.keys(models).length) layer.models = models;

  // variants: catch-all default, then per-task JSON map (non-empty values only).
  const variants: Record<string, string> = {};
  const variantDefault = (env.LASTLIGHT_THINKING || env.OPENCODE_VARIANT || "").trim();
  if (variantDefault) variants.default = variantDefault;
  applyJsonStringMap(variants, env.LASTLIGHT_THINKINGS || env.OPENCODE_VARIANTS, "LASTLIGHT_THINKINGS", true);
  if (Object.keys(variants).length) layer.variants = variants;

  const sandbox: Record<string, unknown> = {};
  const backend = (env.LASTLIGHT_SANDBOX || "").trim().toLowerCase();
  if (
    backend === "gondolin" ||
    backend === "docker" ||
    backend === "smol" ||
    backend === "none" ||
    backend === "kubernetes"
  ) {
    sandbox.backend = backend;
  } else if (backend) {
    log.warn("Unknown LASTLIGHT_SANDBOX value — using the file/default backend", { value: backend });
  }
  if (env.MAX_TURNS) sandbox.maxTurns = parseInt(env.MAX_TURNS, 10);
  if (Object.keys(sandbox).length) layer.sandbox = sandbox;

  const buildAssetsLoc = (env.LASTLIGHT_BUILD_ASSETS || "").trim().toLowerCase();
  if (buildAssetsLoc === "repo" || buildAssetsLoc === "server") {
    layer.buildAssets = { location: buildAssetsLoc };
  } else if (buildAssetsLoc) {
    log.warn("Unknown LASTLIGHT_BUILD_ASSETS value — using the file/default location", { value: buildAssetsLoc });
  }

  // Core-version pin override (CI can set this instead of editing config.yaml).
  const coreVersion = (env.LASTLIGHT_CORE_VERSION || "").trim();
  if (coreVersion) layer.deploy = { version: coreVersion };

  const otel: Record<string, unknown> = {};
  setBoolEnv(otel, "enabled", env.LASTLIGHT_OTEL_ENABLED);
  const serviceName = env.LASTLIGHT_OTEL_SERVICE_NAME?.trim() || env.OTEL_SERVICE_NAME?.trim();
  if (serviceName) otel.serviceName = serviceName;
  setBoolEnv(otel, "includeContent", env.LASTLIGHT_OTEL_INCLUDE_CONTENT);
  setBoolEnv(otel, "forwardToSandbox", env.LASTLIGHT_OTEL_FORWARD_TO_SANDBOX);
  setBoolEnv(otel, "strict", env.LASTLIGHT_OTEL_STRICT);
  setBoolEnv(otel, "metrics", env.LASTLIGHT_OTEL_METRICS_ENABLED);
  if (Object.keys(otel).length) layer.otel = otel;

  // Feedback signals (issue #255). The two switches are separate on purpose —
  // `LASTLIGHT_FEEDBACK_GITHUB` turns on the poller (the part that costs API
  // calls) without touching the free, event-driven Slack half.
  const feedback: Record<string, unknown> = {};
  setBoolEnv(feedback, "enabled", env.LASTLIGHT_FEEDBACK_ENABLED);
  setBoolEnv(feedback, "github", env.LASTLIGHT_FEEDBACK_GITHUB);
  setBoolEnv(feedback, "otel", env.LASTLIGHT_FEEDBACK_OTEL);
  if (env.LASTLIGHT_FEEDBACK_WINDOW_DAYS) {
    feedback.windowDays = parseInt(env.LASTLIGHT_FEEDBACK_WINDOW_DAYS, 10);
  }
  if (Object.keys(feedback).length) layer.feedback = feedback;

  const concurrency: Record<string, unknown> = {};
  if (env.MAX_CONCURRENT_WORKFLOWS) concurrency.maxWorkflows = parseInt(env.MAX_CONCURRENT_WORKFLOWS, 10);
  if (env.MAX_QUEUE_WAIT_MS) concurrency.maxQueueWaitMs = parseInt(env.MAX_QUEUE_WAIT_MS, 10);
  if (Object.keys(concurrency).length) layer.concurrency = concurrency;

  if (env.GITHUB_APP_BOT_NAME) layer.botName = env.GITHUB_APP_BOT_NAME;
  if (env.BOOTSTRAP_LABEL) layer.bootstrap = { label: env.BOOTSTRAP_LABEL };
  if (env.LASTLIGHT_HOLD_LABEL) layer.hold = { label: env.LASTLIGHT_HOLD_LABEL };
  if (env.EXPLORE_DEFAULT_REPO) layer.explore = { defaultRepo: env.EXPLORE_DEFAULT_REPO };
  if (env.REVIEW_POSTS_CHECK !== undefined && env.REVIEW_POSTS_CHECK !== "") {
    layer.review = { postsCheck: parseBool(env.REVIEW_POSTS_CHECK) };
  }

  return layer;
}

/** Set a boolean key only when the env var is present and non-empty. */
function setBoolEnv(target: Record<string, unknown>, key: string, raw: string | undefined): void {
  if (raw !== undefined && raw !== "") target[key] = parseBool(raw);
}

/** Merge a JSON object env var's string entries into a target map. */
function applyJsonStringMap(
  target: Record<string, string>,
  raw: string | undefined,
  label: string,
  requireNonEmpty = false,
): void {
  if (!raw) return;
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === "object") {
      for (const [key, value] of Object.entries(parsed)) {
        if (typeof value === "string" && (!requireNonEmpty || value.length > 0)) target[key] = value;
      }
    }
  } catch (err: any) {
    log.warn("Invalid JSON env var", { label, err });
  }
}

function normalizeOtelFileConfig(raw: Record<string, unknown>): OtelConfig {
  return {
    enabled: raw.enabled === true,
    serviceName: typeof raw.serviceName === "string" && raw.serviceName.trim() ? raw.serviceName.trim() : "lastlight",
    includeContent: raw.includeContent === true,
    forwardToSandbox: raw.forwardToSandbox === false ? false : true,
    strict: raw.strict === true,
    metrics: raw.metrics === false ? false : true,
    collectorHosts: parseCollectorHosts(raw.collectorHosts, "otel.collectorHosts"),
  };
}

function parseCollectorHosts(raw: unknown, path: string): string[] {
  if (raw === undefined || raw === null || raw === "") return [];
  const values = Array.isArray(raw) ? raw : String(raw).split(",");
  const out: string[] = [];
  for (const value of values) {
    if (typeof value !== "string") throw new Error(`${path} must contain only strings`);
    const host = normalizeAllowlistHost(value);
    if (host) out.push(host);
  }
  return Array.from(new Set(out));
}

export function parseOtelCollectorHostsFromEnv(env: NodeJS.ProcessEnv = process.env): string[] {
  return parseCollectorHosts([
    env.OTEL_EXPORTER_OTLP_ENDPOINT,
    env.OTEL_EXPORTER_OTLP_TRACES_ENDPOINT,
    env.OTEL_EXPORTER_OTLP_METRICS_ENDPOINT,
    env.OTEL_EXPORTER_OTLP_LOGS_ENDPOINT,
  ].filter(Boolean), "OTEL_EXPORTER_OTLP_*_ENDPOINT");
}

function resolvePublicUrl(): string | undefined {
  const explicit = process.env.PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const domain = process.env.DOMAIN?.trim();
  if (domain) return `https://${domain.replace(/\/+$/, "")}`;
  return undefined;
}

function parseApprovalGates(): Record<string, boolean> {
  const raw = process.env.APPROVAL_GATES || "";
  const map: Record<string, boolean> = {};
  for (const name of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    map[name] = true;
  }
  return map;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable not set: ${name}`);
  return value;
}

export function resolveModel(models: ModelConfig, taskType: string): string {
  return models[taskType] || models.default;
}

export function resolveVariant(variants: VariantConfig, taskType: string): string | undefined {
  return variants[taskType] || variants.default;
}

/** Hardcoded fallback for every {@link KubernetesConfig} field, used only when
 *  neither an env override nor the runtime `sandbox.kubernetes` block supplies
 *  a value. The image is registry-qualified (nearform's `publish.yml` pushes
 *  it to GHCR) — the `kubernetes` backend runs on a real cluster, which can't
 *  resolve the docker-local `lastlight-sandbox:latest` tag the other backends
 *  use. `storageClassName` defaults to `""`, which {@link buildPvcManifest}
 *  (`sandbox/k8s/pvc.ts`) omits from the PVC spec so k8s falls back to the
 *  cluster's annotated default StorageClass — any cluster-specific class
 *  (e.g. a fork's `truenas-iscsi`) is set via `LASTLIGHT_K8S_STORAGE_CLASS`
 *  or the `sandbox.kubernetes.storageClassName` overlay key. */
const K8S_DEFAULTS: KubernetesConfig = {
  namespace: "lastlight-sandboxes",
  image: "ghcr.io/nearform/lastlight-sandbox:latest",
  storageClassName: "",
  workspaceSize: "5Gi",
  runAsUser: 10001,
  harnessEndpoint: "http://lastlight.lastlight.svc.cluster.local:8644",
  harnessNamespace: "lastlight",
  harnessPodLabels: { "app.kubernetes.io/name": "lastlight" },
};

/** Parse a `k=v,k=v` env string into a label map; empty/malformed → `undefined`
 *  so callers fall through to the runtime block, then {@link K8S_DEFAULTS}. */
function parseLabels(raw: string | undefined): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [k, v] = pair.split("=").map((s) => s.trim());
    if (k && v) out[k] = v;
  }
  return Object.keys(out).length ? out : undefined;
}

/**
 * Resolve the `kubernetes` sandbox backend's config: env override → the
 * runtime `sandbox.kubernetes` block (if config has been loaded) → hardcoded
 * defaults. `getRuntimeConfig()` returns `undefined` rather than throwing
 * when no config is loaded, so this is safe to call from tests or any code
 * path that runs before `loadConfig()`.
 */
export function resolveKubernetesConfig(): KubernetesConfig {
  const k = getRuntimeConfig()?.kubernetes ?? {};
  const runAsUserEnv = parseInt(process.env.LASTLIGHT_K8S_RUN_AS_USER ?? "", 10);
  return {
    namespace: process.env.LASTLIGHT_K8S_NAMESPACE ?? k.namespace ?? K8S_DEFAULTS.namespace,
    image: process.env.K8S_SANDBOX_IMAGE ?? k.image ?? K8S_DEFAULTS.image,
    storageClassName:
      process.env.LASTLIGHT_K8S_STORAGE_CLASS ?? k.storageClassName ?? K8S_DEFAULTS.storageClassName,
    workspaceSize:
      process.env.LASTLIGHT_K8S_WORKSPACE_SIZE ?? k.workspaceSize ?? K8S_DEFAULTS.workspaceSize,
    runAsUser: Number.isFinite(runAsUserEnv) ? runAsUserEnv : (k.runAsUser ?? K8S_DEFAULTS.runAsUser),
    harnessEndpoint:
      process.env.LASTLIGHT_K8S_HARNESS_ENDPOINT ??
      k.harnessEndpoint ??
      K8S_DEFAULTS.harnessEndpoint,
    harnessNamespace:
      process.env.LASTLIGHT_K8S_HARNESS_NAMESPACE ??
      k.harnessNamespace ??
      K8S_DEFAULTS.harnessNamespace,
    harnessPodLabels:
      parseLabels(process.env.LASTLIGHT_K8S_HARNESS_POD_LABELS) ??
      k.harnessPodLabels ??
      K8S_DEFAULTS.harnessPodLabels,
  };
}

/**
 * Resolved GitHub auth, discriminated by mechanism. GitHub App wins when
 * configured; the PAT is a fallback. `undefined` means no GitHub auth at all
 * (chat-only mode). Keeps the App-vs-token precedence in one place so every
 * construction site (chat tools, harness client) branches identically.
 */
export type ResolvedGithubAuth =
  | { kind: "app"; appId: string; privateKeyPath: string; installationId?: string }
  | { kind: "token"; token: string };

export function resolveGithubAuth(
  config: Pick<LastLightConfig, "githubApp" | "githubToken">,
): ResolvedGithubAuth | undefined {
  if (config.githubApp) return { kind: "app", ...config.githubApp };
  if (config.githubToken) return { kind: "token", token: config.githubToken };
  return undefined;
}

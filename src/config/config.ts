import { readFileSync, existsSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";
import { normalizeAllowlistHost } from "../sandbox/egress-allowlist.js";
import { resolveConfigLayers } from "./config-resolve.js";

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
  deliveryChannel?: string;
}

export interface ModelConfig {
  default: string;
  [taskType: string]: string;
}

export interface VariantConfig {
  default?: string;
  [taskType: string]: string | undefined;
}

export type SandboxBackend = "gondolin" | "docker" | "smol" | "none";

export type BuildAssetsLocation = "repo" | "server";

export interface DisabledConfig {
  workflows: string[];
  crons: string[];
  prompts: string[];
  skills: string[];
  agentContext: string[];
}

export interface OtelConfig {
  enabled: boolean;
  serviceName: string;
  includeContent: boolean;
  forwardToSandbox: boolean;
  strict: boolean;
  collectorHosts: string[];
}

export interface RouteConfig {
  github: Record<string, string>;
  slack: Record<string, string>;
}

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
  otel: OtelConfig;
  publicConfig: PublicConfigBundle;
  githubApp?: {
    appId: string;
    privateKeyPath: string;
    installationId: string;
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
  exploreDefaultRepo?: string;
  publicUrl?: string;
  reviewPostsCheck: boolean;
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
 */
const SENSITIVE_KEY_RE =
  /secret|token|password|passwd|credential|private[-_]?key|signing[-_]?key|api[-_]?key|key[-_]?path|\bpem\b/i;

/** Recursively redact secret-looking keys from a public (non-secret) config tree. */
function redactPublic<T>(value: T): T {
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
        installationId: requireEnv("GITHUB_APP_INSTALLATION_ID"),
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
    buildAssets,
    buildAssetsDir,
    deploy: fileCfg.deploy,
    managedRepos: fileCfg.managedRepos,
    routes: fileCfg.routes,
    disabled: fileCfg.disabled,
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
    exploreDefaultRepo: fileCfg.exploreDefaultRepo,
    publicUrl: resolvePublicUrl(),
    reviewPostsCheck: fileCfg.reviewPostsCheck,
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
  models: ModelConfig;
  variants: VariantConfig;
  sandbox: { backend: SandboxBackend; maxTurns: number };
  buildAssets: BuildAssetsLocation;
  deploy: { version: string | null };
  approval: Record<string, boolean>;
  bootstrapLabel: string;
  exploreDefaultRepo?: string;
  reviewPostsCheck: boolean;
  otel: OtelConfig;
} {
  const managedRepos = stringArray(raw.managedRepos, "managedRepos");
  const botName = typeof raw.botName === "string" && raw.botName.trim() ? raw.botName.trim() : "last-light";
  const routes = normalizeRoutes(raw.routes);
  const disabledRaw = isPlainObject(raw.disabled) ? raw.disabled : {};
  const modelsRaw = isPlainObject(raw.models) ? raw.models : {};
  const variantsRaw = isPlainObject(raw.variants) ? raw.variants : {};
  const sandboxRaw = isPlainObject(raw.sandbox) ? raw.sandbox : {};
  const buildAssetsRaw = isPlainObject(raw.buildAssets) ? raw.buildAssets : {};
  const deployRaw = isPlainObject(raw.deploy) ? raw.deploy : {};
  const bootstrapRaw = isPlainObject(raw.bootstrap) ? raw.bootstrap : {};
  const exploreRaw = isPlainObject(raw.explore) ? raw.explore : {};
  const reviewRaw = isPlainObject(raw.review) ? raw.review : {};
  const approvalRaw = isPlainObject(raw.approval) ? raw.approval : {};
  const otelRaw = isPlainObject(raw.otel) ? raw.otel : {};

  const models: ModelConfig = { default: typeof modelsRaw.default === "string" ? modelsRaw.default : DEFAULT_MODEL };
  for (const [k, v] of Object.entries(modelsRaw)) if (typeof v === "string") models[k] = v;
  const variants: VariantConfig = {};
  for (const [k, v] of Object.entries(variantsRaw)) if (typeof v === "string") variants[k] = v;
  const approval: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(approvalRaw)) approval[k] = v === true;

  const backend = sandboxBackend(sandboxRaw.backend, "sandbox.backend");
  const maxTurns = typeof sandboxRaw.maxTurns === "number" ? sandboxRaw.maxTurns : 200;
  const buildAssets = buildAssetsLocation(buildAssetsRaw.location, "buildAssets.location");
  const deployVersion = typeof deployRaw.version === "string" && deployRaw.version.trim() ? deployRaw.version.trim() : null;
  const bootstrapLabel = typeof bootstrapRaw.label === "string" ? bootstrapRaw.label : "lastlight:bootstrap";
  const exploreDefaultRepo = typeof exploreRaw.defaultRepo === "string" ? exploreRaw.defaultRepo : undefined;
  const reviewPostsCheck = reviewRaw.postsCheck === true;

  return {
    managedRepos,
    botName,
    routes,
    disabled: {
      workflows: optionalStringArray(disabledRaw.workflows, "disabled.workflows"),
      crons: optionalStringArray(disabledRaw.crons, "disabled.crons"),
      prompts: optionalStringArray(disabledRaw.prompts, "disabled.prompts"),
      skills: optionalStringArray(disabledRaw.skills, "disabled.skills"),
      agentContext: optionalStringArray(disabledRaw.agentContext, "disabled.agentContext"),
    },
    models,
    variants,
    sandbox: { backend, maxTurns },
    buildAssets,
    deploy: { version: deployVersion },
    approval,
    bootstrapLabel,
    exploreDefaultRepo,
    reviewPostsCheck,
    otel: normalizeOtelFileConfig(otelRaw),
  };
}

function normalizeRoutes(raw: unknown): RouteConfig {
  const defaults = defaultRouteConfig();
  if (!isPlainObject(raw)) return defaults;
  return {
    github: { ...defaults.github, ...(isPlainObject(raw.github) ? stringRecord(raw.github, "routes.github") : {}) },
    slack: { ...defaults.slack, ...(isPlainObject(raw.slack) ? stringRecord(raw.slack, "routes.slack") : {}) },
  };
}

function defaultRouteConfig(): RouteConfig {
  return {
    github: {
      issue_opened: "issue-triage",
      issue_answer: "answer",
      issue_reopened: "issue-triage",
      pr_opened: "pr-review",
      pr_synchronize: "pr-review",
      pr_reopened: "pr-review",
      approval_response: "approval-response",
      security_review: "security-review",
      pr_fix: "pr-fix",
      pr_review: "pr-review",
      pr_comment: "pr-comment",
      issue_build: "github-orchestrator",
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
      build: "github-orchestrator",
      triage: "issue-triage",
      review: "pr-review",
      security: "security-review",
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
  if (raw === "gondolin" || raw === "docker" || raw === "smol" || raw === "none") return raw;
  throw new Error(`${path} must be one of gondolin, docker, smol, none`);
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
  if (backend === "gondolin" || backend === "docker" || backend === "smol" || backend === "none") {
    sandbox.backend = backend;
  } else if (backend) {
    console.warn(`[config] Unknown LASTLIGHT_SANDBOX value "${backend}" — using the file/default backend`);
  }
  if (env.MAX_TURNS) sandbox.maxTurns = parseInt(env.MAX_TURNS, 10);
  if (Object.keys(sandbox).length) layer.sandbox = sandbox;

  const buildAssetsLoc = (env.LASTLIGHT_BUILD_ASSETS || "").trim().toLowerCase();
  if (buildAssetsLoc === "repo" || buildAssetsLoc === "server") {
    layer.buildAssets = { location: buildAssetsLoc };
  } else if (buildAssetsLoc) {
    console.warn(`[config] Unknown LASTLIGHT_BUILD_ASSETS value "${buildAssetsLoc}" — using the file/default location`);
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
  if (Object.keys(otel).length) layer.otel = otel;

  if (env.GITHUB_APP_BOT_NAME) layer.botName = env.GITHUB_APP_BOT_NAME;
  if (env.BOOTSTRAP_LABEL) layer.bootstrap = { label: env.BOOTSTRAP_LABEL };
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
    console.warn(`[config] Invalid ${label} JSON: ${err.message}`);
  }
}

function normalizeOtelFileConfig(raw: Record<string, unknown>): OtelConfig {
  return {
    enabled: raw.enabled === true,
    serviceName: typeof raw.serviceName === "string" && raw.serviceName.trim() ? raw.serviceName.trim() : "lastlight",
    includeContent: raw.includeContent === true,
    forwardToSandbox: raw.forwardToSandbox === false ? false : true,
    strict: raw.strict === true,
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

/**
 * Resolved GitHub auth, discriminated by mechanism. GitHub App wins when
 * configured; the PAT is a fallback. `undefined` means no GitHub auth at all
 * (chat-only mode). Keeps the App-vs-token precedence in one place so every
 * construction site (chat tools, harness client) branches identically.
 */
export type ResolvedGithubAuth =
  | { kind: "app"; appId: string; privateKeyPath: string; installationId: string }
  | { kind: "token"; token: string };

export function resolveGithubAuth(
  config: Pick<LastLightConfig, "githubApp" | "githubToken">,
): ResolvedGithubAuth | undefined {
  if (config.githubApp) return { kind: "app", ...config.githubApp };
  if (config.githubToken) return { kind: "token", token: config.githubToken };
  return undefined;
}

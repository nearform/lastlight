import { readFileSync, existsSync, statSync } from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { parse as parseYaml } from "yaml";

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

export interface SlackConfig {
  botToken: string;
  appToken: string;
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

export type SandboxBackend = "gondolin" | "docker" | "none";

export interface DisabledConfig {
  workflows: string[];
  crons: string[];
  prompts: string[];
  skills: string[];
  agentContext: string[];
}

export interface RouteConfig {
  github: Record<string, string>;
  slack: Record<string, string>;
}

export interface PublicConfigBundle {
  default: Record<string, unknown>;
  overlay: Record<string, unknown> | null;
  merged: Record<string, unknown>;
}

export interface LastLightConfig {
  port: number;
  webhookSecret: string;
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
  managedRepos: string[];
  routes: RouteConfig;
  disabled: DisabledConfig;
  publicConfig: PublicConfigBundle;
  githubApp?: {
    appId: string;
    privateKeyPath: string;
    installationId: string;
  };
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

const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

function defaultConfigPath(): string {
  const cwdPath = resolve("config/default.yaml");
  if (existsSync(cwdPath)) return cwdPath;
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "../config/default.yaml");
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

function deepMerge(base: Record<string, unknown>, overlay: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(overlay)) {
    if (isPlainObject(value) && isPlainObject(out[key])) {
      out[key] = deepMerge(out[key] as Record<string, unknown>, value);
    } else {
      out[key] = value;
    }
  }
  return out;
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

  const mergedRaw = overlayRaw ? deepMerge(defaultRaw, overlayRaw) : { ...defaultRaw };
  const fileCfg = normalizeFileConfig(mergedRaw);

  const stateDir = resolve(stringEnv("STATE_DIR", "./data"));
  const model = process.env.LASTLIGHT_MODEL || process.env.OPENCODE_MODEL || fileCfg.models.default;
  const models = parseModelConfig({ ...fileCfg.models, default: model });
  const variants = parseVariantConfig({ ...fileCfg.variants });
  const sandbox = parseSandbox(fileCfg.sandbox.backend);
  const approval = process.env.APPROVAL_GATES !== undefined
    ? parseApprovalGates()
    : fileCfg.approval;

  const githubApp = process.env.GITHUB_APP_ID
    ? {
        appId: process.env.GITHUB_APP_ID,
        privateKeyPath: requireEnv("GITHUB_APP_PRIVATE_KEY_PATH"),
        installationId: requireEnv("GITHUB_APP_INSTALLATION_ID"),
      }
    : undefined;

  const slack = process.env.SLACK_BOT_TOKEN
    ? {
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: requireEnv("SLACK_APP_TOKEN"),
        allowedUsers: (process.env.SLACK_ALLOWED_USERS || "").split(",").filter(Boolean),
        deliveryChannel: process.env.SLACK_DELIVERY_CHANNEL || process.env.SLACK_HOME_CHANNEL || undefined,
      }
    : undefined;

  const effectivePublic = deepMerge(mergedRaw, {
    models,
    variants,
    sandbox: { backend: sandbox, maxTurns: parseInt(process.env.MAX_TURNS || String(fileCfg.sandbox.maxTurns), 10) },
    approval,
    managedRepos: fileCfg.managedRepos,
    routes: fileCfg.routes,
    disabled: fileCfg.disabled,
    bootstrap: { label: process.env.BOOTSTRAP_LABEL || fileCfg.bootstrapLabel },
    explore: { defaultRepo: process.env.EXPLORE_DEFAULT_REPO || fileCfg.exploreDefaultRepo || null },
    review: { postsCheck: parseBoolWithDefault(process.env.REVIEW_POSTS_CHECK, fileCfg.reviewPostsCheck) },
  });

  const config: LastLightConfig = {
    port: parseInt(process.env.WEBHOOK_PORT || process.env.PORT || "8644", 10),
    webhookSecret: process.env.WEBHOOK_SECRET || "",
    botLogin: process.env.BOT_LOGIN || "last-light[bot]",
    stateDir,
    sandboxDir: join(stateDir, "sandboxes"),
    sessionsDir: resolve(process.env.LASTLIGHT_SESSIONS_DIR || join(stateDir, "agent-sessions")),
    dbPath: process.env.DB_PATH || join(stateDir, "lastlight.db"),
    builtInRoot,
    overlayDir,
    model,
    models,
    variants,
    maxTurns: parseInt(process.env.MAX_TURNS || String(fileCfg.sandbox.maxTurns), 10),
    sandbox,
    managedRepos: fileCfg.managedRepos,
    routes: fileCfg.routes,
    disabled: fileCfg.disabled,
    publicConfig: {
      default: redactPublic(clonePublic(defaultRaw)!),
      overlay: redactPublic(clonePublic(overlayRaw)),
      merged: redactPublic(effectivePublic),
    },
    githubApp,
    slack,
    approval,
    bootstrapLabel: process.env.BOOTSTRAP_LABEL || fileCfg.bootstrapLabel,
    exploreDefaultRepo: process.env.EXPLORE_DEFAULT_REPO || fileCfg.exploreDefaultRepo,
    publicUrl: resolvePublicUrl(),
    reviewPostsCheck: parseBoolWithDefault(process.env.REVIEW_POSTS_CHECK, fileCfg.reviewPostsCheck),
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
  routes: RouteConfig;
  disabled: DisabledConfig;
  models: ModelConfig;
  variants: VariantConfig;
  sandbox: { backend: SandboxBackend; maxTurns: number };
  approval: Record<string, boolean>;
  bootstrapLabel: string;
  exploreDefaultRepo?: string;
  reviewPostsCheck: boolean;
} {
  const managedRepos = stringArray(raw.managedRepos, "managedRepos");
  const routes = normalizeRoutes(raw.routes);
  const disabledRaw = isPlainObject(raw.disabled) ? raw.disabled : {};
  const modelsRaw = isPlainObject(raw.models) ? raw.models : {};
  const variantsRaw = isPlainObject(raw.variants) ? raw.variants : {};
  const sandboxRaw = isPlainObject(raw.sandbox) ? raw.sandbox : {};
  const bootstrapRaw = isPlainObject(raw.bootstrap) ? raw.bootstrap : {};
  const exploreRaw = isPlainObject(raw.explore) ? raw.explore : {};
  const reviewRaw = isPlainObject(raw.review) ? raw.review : {};
  const approvalRaw = isPlainObject(raw.approval) ? raw.approval : {};

  const models: ModelConfig = { default: typeof modelsRaw.default === "string" ? modelsRaw.default : DEFAULT_MODEL };
  for (const [k, v] of Object.entries(modelsRaw)) if (typeof v === "string") models[k] = v;
  const variants: VariantConfig = {};
  for (const [k, v] of Object.entries(variantsRaw)) if (typeof v === "string") variants[k] = v;
  const approval: Record<string, boolean> = {};
  for (const [k, v] of Object.entries(approvalRaw)) approval[k] = v === true;

  const backend = sandboxBackend(sandboxRaw.backend, "sandbox.backend");
  const maxTurns = typeof sandboxRaw.maxTurns === "number" ? sandboxRaw.maxTurns : 200;
  const bootstrapLabel = typeof bootstrapRaw.label === "string" ? bootstrapRaw.label : "lastlight:bootstrap";
  const exploreDefaultRepo = typeof exploreRaw.defaultRepo === "string" ? exploreRaw.defaultRepo : undefined;
  const reviewPostsCheck = reviewRaw.postsCheck === true;

  return {
    managedRepos,
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
    approval,
    bootstrapLabel,
    exploreDefaultRepo,
    reviewPostsCheck,
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
      issue_reopened: "issue-triage",
      pr_opened: "pr-review",
      pr_synchronize: "pr-review",
      pr_reopened: "pr-review",
      approval_response: "approval-response",
      security_review: "security-review",
      pr_fix: "pr-fix",
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
  if (raw === "gondolin" || raw === "docker" || raw === "none") return raw;
  throw new Error(`${path} must be one of gondolin, docker, none`);
}

function parseSandbox(fallback: SandboxBackend): SandboxBackend {
  const raw = (process.env.LASTLIGHT_SANDBOX || "").trim().toLowerCase();
  if (raw === "gondolin" || raw === "docker" || raw === "none") return raw;
  if (raw) {
    console.warn(`[config] Unknown LASTLIGHT_SANDBOX value "${raw}" — falling back to ${fallback}`);
  }
  return fallback;
}

function parseBool(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

function parseBoolWithDefault(raw: string | undefined, fallback: boolean): boolean {
  return raw === undefined || raw === "" ? fallback : parseBool(raw);
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

function parseModelConfig(base?: ModelConfig): ModelConfig {
  const config: ModelConfig = base ? { ...base } : { default: process.env.LASTLIGHT_MODEL || process.env.OPENCODE_MODEL || DEFAULT_MODEL };
  const modelsEnv = process.env.LASTLIGHT_MODELS || process.env.OPENCODE_MODELS;
  if (modelsEnv) {
    try {
      const parsed = JSON.parse(modelsEnv);
      if (typeof parsed === "object" && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") config[key] = value;
        }
      }
    } catch (err: any) {
      console.warn(`[config] Invalid LASTLIGHT_MODELS JSON: ${err.message}`);
    }
  }
  return config;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`Required environment variable not set: ${name}`);
  return value;
}

export function resolveModel(models: ModelConfig, taskType: string): string {
  return models[taskType] || models.default;
}

function parseVariantConfig(base?: VariantConfig): VariantConfig {
  const config: VariantConfig = base ? { ...base } : {};
  const defaultVariant = (process.env.LASTLIGHT_THINKING || process.env.OPENCODE_VARIANT || "").trim();
  if (defaultVariant) config.default = defaultVariant;
  const raw = process.env.LASTLIGHT_THINKINGS || process.env.OPENCODE_VARIANTS;
  if (raw) {
    try {
      const parsed = JSON.parse(raw);
      if (typeof parsed === "object" && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string" && value.length > 0) config[key] = value;
        }
      }
    } catch (err: any) {
      console.warn(`[config] Invalid LASTLIGHT_THINKINGS JSON: ${err.message}`);
    }
  }
  return config;
}

export function resolveVariant(variants: VariantConfig, taskType: string): string | undefined {
  return variants[taskType] || variants.default;
}

import { readFileSync, existsSync } from "fs";
import { resolve, join } from "path";

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
    // Strip surrounding quotes (single or double)
    if ((value.startsWith('"') && value.endsWith('"')) ||
        (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (!process.env[key]) {
      process.env[key] = value;
    }
  }
}

export interface SlackConfig {
  /** Bot User OAuth Token (xoxb-...) */
  botToken: string;
  /** App-Level Token for Socket Mode (xapp-...) */
  appToken: string;
  /** Comma-separated Slack user IDs allowed to interact */
  allowedUsers: string[];
  /** Channel ID for cron report delivery */
  deliveryChannel?: string;
}

/**
 * Per-task-type model configuration.
 * Keys are session types (matching admin dashboard labels).
 * Values are Claude model IDs.
 */
export interface ModelConfig {
  /** Default model for all tasks */
  default: string;
  /** Per-type overrides */
  [taskType: string]: string;
}

export interface LastLightConfig {
  /** Webhook listener port */
  port: number;
  /** GitHub webhook secret for signature verification */
  webhookSecret: string;
  /** Bot login name (for filtering self-events) */
  botLogin: string;
  /** Path to MCP server config */
  mcpConfigPath: string;
  /** SQLite database path */
  dbPath: string;
  /** Directory containing YAML workflow definitions (default: ./workflows) */
  workflowDir: string;
  /** Directory for all persistent state (sessions, logs, db) — mount this as a Docker volume */
  stateDir: string;
  /** Directory for agent sandboxes (cloned repos per task) */
  sandboxDir: string;
  /** Default Claude model (used when no per-type override exists) */
  model: string;
  /** Per-task-type model overrides */
  models: ModelConfig;
  /** Max agent turns */
  maxTurns: number;
  /** GitHub App config (optional — not needed for messaging-only mode) */
  githubApp?: {
    appId: string;
    privateKeyPath: string;
    installationId: string;
  };
  /** Slack connector config (present when SLACK_BOT_TOKEN is set) */
  slack?: SlackConfig;
  /**
   * Approval gate configuration. Keys are arbitrary gate names declared in
   * YAML (`phase.approval_gate` / `phase.loop.approval_gate`); a gate pauses
   * the runner only if the corresponding key is `true` here. Populated from
   * the `APPROVAL_GATES` env var (comma-separated list of gate names).
   */
  approval?: Record<string, boolean>;
  /** Label applied to issues that exist solely to set up missing guardrails. */
  bootstrapLabel: string;
  /**
   * Destination for Slack-initiated socratic explore runs. `owner/name` of
   * the repo that should receive the synthesized spec as a new issue.
   * Optional — only required when a Slack explore run reaches the publish
   * phase without a target repo identified earlier in the flow.
   */
  exploreDefaultRepo?: string;
  /**
   * Publicly-reachable base URL of the harness (no trailing slash), used
   * when embedding links back to the admin dashboard in outbound messages
   * (e.g. the Slack "starting workflow" reply). Read from `PUBLIC_URL`,
   * falling back to `https://<DOMAIN>` when `DOMAIN` is set. Links are
   * omitted when neither is configured.
   */
  publicUrl?: string;
  /**
   * When true, the pr-review workflow posts a `last-light/review` Check Run
   * on the PR's head SHA — `in_progress` at workflow start, then completed
   * with `success` (APPROVE), `failure` (REQUEST_CHANGES) or `neutral`
   * (COMMENT) when the agent submits its review. Repos that add this check
   * to "Required status checks" in branch protection will block merges on
   * the conclusion. Requires the GitHub App to have Checks: Read and write.
   * Defaults off so a permission-less rollout is unchanged behaviour.
   */
  reviewPostsCheck: boolean;
}

/**
 * Load configuration from environment variables and optional config file.
 * Environment variables take precedence over config file values.
 */
export function loadConfig(): LastLightConfig {
  // Load .env for local dev (does not overwrite existing env vars)
  loadDotEnv(resolve(".env"));

  const stateDir = resolve(process.env.STATE_DIR || "./data");

  // GitHub App config is optional — allows messaging-only mode
  const githubApp = process.env.GITHUB_APP_ID
    ? {
        appId: process.env.GITHUB_APP_ID,
        privateKeyPath: requireEnv("GITHUB_APP_PRIVATE_KEY_PATH"),
        installationId: requireEnv("GITHUB_APP_INSTALLATION_ID"),
      }
    : undefined;

  // Slack config is optional — only if SLACK_BOT_TOKEN is set
  const slack = process.env.SLACK_BOT_TOKEN
    ? {
        botToken: process.env.SLACK_BOT_TOKEN,
        appToken: requireEnv("SLACK_APP_TOKEN"),
        allowedUsers: (process.env.SLACK_ALLOWED_USERS || "").split(",").filter(Boolean),
        deliveryChannel: process.env.SLACK_DELIVERY_CHANNEL || process.env.SLACK_HOME_CHANNEL || undefined,
      }
    : undefined;

  return {
    port: parseInt(process.env.WEBHOOK_PORT || process.env.PORT || "8644", 10),
    webhookSecret: process.env.WEBHOOK_SECRET || "",
    botLogin: process.env.BOT_LOGIN || "last-light[bot]",
    mcpConfigPath: process.env.MCP_CONFIG_PATH || resolve("mcp-config.json"),
    stateDir,
    sandboxDir: join(stateDir, "sandboxes"),
    dbPath: process.env.DB_PATH || join(stateDir, "lastlight.db"),
    workflowDir: resolve(process.env.WORKFLOW_DIR || "./workflows"),
    model: process.env.CLAUDE_MODEL || "openai/gpt-5.3-codex",
    models: parseModelConfig(),
    maxTurns: parseInt(process.env.MAX_TURNS || "200", 10),
    githubApp,
    slack,
    approval: parseApprovalGates(),
    bootstrapLabel: process.env.BOOTSTRAP_LABEL || "lastlight:bootstrap",
    exploreDefaultRepo: process.env.EXPLORE_DEFAULT_REPO || undefined,
    publicUrl: resolvePublicUrl(),
    reviewPostsCheck: parseBool(process.env.REVIEW_POSTS_CHECK),
  };
}

function parseBool(raw: string | undefined): boolean {
  if (!raw) return false;
  const v = raw.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Prefer an explicit PUBLIC_URL (e.g. behind a reverse proxy where DOMAIN
 * isn't the externally-visible host). Fall back to https://<DOMAIN> — the
 * same DOMAIN Caddy uses for TLS. Trailing slashes are stripped so callers
 * can append paths unconditionally.
 */
function resolvePublicUrl(): string | undefined {
  const explicit = process.env.PUBLIC_URL?.trim();
  if (explicit) return explicit.replace(/\/+$/, "");
  const domain = process.env.DOMAIN?.trim();
  if (domain) return `https://${domain.replace(/\/+$/, "")}`;
  return undefined;
}

/**
 * Parse `APPROVAL_GATES` into a map of gate-name → true. The env var is a
 * comma-separated list of gate names (matching `approval_gate` fields in
 * workflow YAML). Any gate not present in the list is implicitly disabled.
 */
function parseApprovalGates(): Record<string, boolean> {
  const raw = process.env.APPROVAL_GATES || "";
  const map: Record<string, boolean> = {};
  for (const name of raw.split(",").map((s) => s.trim()).filter(Boolean)) {
    map[name] = true;
  }
  return map;
}

/**
 * Parse per-task-type model config from CLAUDE_MODELS env var.
 *
 * Format: JSON object mapping session types to OpenCode model IDs (provider/model).
 * Example: {"architect":"openai/gpt-5.4","chat":"openai/gpt-5.4-mini"}
 *
 * Session types are arbitrary — they match the `name:` of any phase in your
 * workflows (or any key referenced by `resolveModel`). Use `default` as the
 * catch-all when no per-type override matches.
 *
 * The env var names (CLAUDE_MODEL / CLAUDE_MODELS) are kept on the fork branch
 * for compatibility; they get renamed to OPENCODE_MODEL(S) in Phase 7.
 */
function parseModelConfig(): ModelConfig {
  const defaultModel = process.env.CLAUDE_MODEL || "openai/gpt-5.3-codex";
  const config: ModelConfig = { default: defaultModel };

  const modelsEnv = process.env.CLAUDE_MODELS;
  if (modelsEnv) {
    try {
      const parsed = JSON.parse(modelsEnv);
      if (typeof parsed === "object" && parsed !== null) {
        for (const [key, value] of Object.entries(parsed)) {
          if (typeof value === "string") {
            config[key] = value;
          }
        }
      }
    } catch (err: any) {
      console.warn(`[config] Invalid CLAUDE_MODELS JSON: ${err.message}`);
    }
  }

  return config;
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Required environment variable not set: ${name}`);
  }
  return value;
}

/**
 * Resolve the model to use for a given task type.
 * Checks per-type overrides first, then falls back to default.
 */
export function resolveModel(models: ModelConfig, taskType: string): string {
  return models[taskType] || models.default;
}

/**
 * Generate MCP config file for the Agent SDK from the GitHub App config.
 */
export function generateMcpConfig(config: LastLightConfig): object {
  const mcpServers: Record<string, unknown> = {};

  if (config.githubApp) {
    mcpServers.github = {
      command: "node",
      args: [resolve("mcp-github-app/src/index.js")],
      env: {
        GITHUB_APP_ID: config.githubApp.appId,
        GITHUB_APP_PRIVATE_KEY_PATH: resolve(config.githubApp.privateKeyPath),
        GITHUB_APP_INSTALLATION_ID: config.githubApp.installationId,
      },
    };
  }

  return { mcpServers };
}

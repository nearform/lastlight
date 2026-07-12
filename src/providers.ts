/**
 * Provider registry — single source of truth for the LLM providers Last Light
 * knows how to wire end-to-end.
 *
 * pi-ai (`@earendil-works/pi-ai`) is provider-agnostic and supports 15+
 * providers out of the box. Of those, only a subset is "wizard-able" here:
 * they authenticate with a single API-key env var and expose a stable
 * endpoint reachable from the sandbox egress firewall. Excluded are the
 * OAuth-only providers (`openai-codex`, `github-copilot`), the multi-env
 * Ambient-cred ones (`amazon-bedrock`, `google-vertex`, `azure-openai-*`,
 * `cloudflare-*`), and the regional-CN variants.
 *
 * This registry is consumed by:
 *   - `src/engine/llm.ts` — the cheap one-shot helper used by the
 *     prompt screener + intent classifier. It builds requests for the
 *     `openai-completions` family (which is most wizard-able providers —
 *     Google and Mistral are routed through their OpenAI-compatible
 *     endpoints) and the `anthropic-messages` family (Kimi for Coding,
 *     MiniMax, Anthropic itself).
 *   - `src/engine/agent-executor.ts` — forwards each provider's env var
 *     into the sandbox so agentic-pi can auth.
 *   - `src/sandbox/egress-allowlist.ts` — the SNI/firewall allowlist is
 *     seeded from each provider's `host`.
 *   - `src/cli/setup.ts` — the install wizard's step-4 provider picker.
 *
 * Keep this list aligned with pi-ai's provider registry. When pi-ai adds a
 * new provider that we want to surface, add an entry here and everything
 * else (forwarding, egress, wizard UI) follows automatically.
 */

/** API request/response family pi-ai uses to talk to a provider. */
export type ApiType =
  /** Anthropic Messages API — `system` field, content-block response. */
  | "anthropic-messages"
  /** OpenAI Chat Completions API — `messages`, `choices[0].message.content`. */
  | "openai-completions";

/**
 * Metadata for one wizard-able provider. The request-building differences
 * between OpenAI-completions-family providers (maxTokensField name,
 * extra headers, nested-model-id quirk) are small, so they live as optional
 * fields here rather than separate adapter objects.
 */
export interface ProviderSpec {
  /** pi-ai model-spec prefix — the part before `/` in `provider/model`. */
  readonly prefix: string;
  /** Display name (shown in the wizard). */
  readonly displayName: string;
  /** Env var that carries the API key (also the env var forwarded into the sandbox). */
  readonly envKey: string;
  /** API base URL — `chat/completions` or `messages` is appended per `api`. */
  readonly baseUrl: string;
  /** API request/response family. */
  readonly api: ApiType;
  /** Egress allowlist host — apex (matches all subdomains) or specific host. */
  readonly host: string;
  /** Small/fast model id used by the screener + classifier cheap helper. */
  readonly fastModel: string;
  /** Canonical primary model id (used as the wizard placeholder). */
  readonly sampleModel: string;
  /** OpenAI-completions only: body field for the token cap. Default `max_tokens`. */
  readonly maxTokensField?: "max_tokens" | "max_completion_tokens";
  /** OpenAI-completions only: keep the nested `vendor/model` tail verbatim (OpenRouter). */
  readonly preserveNestedModelId?: boolean;
  /** OpenAI-completions only: extra request headers (OpenRouter's referer/title). */
  readonly extraHeaders?: Readonly<Record<string, string>>;
  /** Optional wizard hint for the API-key prefix (used in placeholder + loose validation). */
  readonly keyPrefix?: string;
}

/**
 * The registry. Order matters — `defaultFastModel()` in `llm.ts` selects
 * a fast model by iterating this list and picking the first provider
 * whose env var is present. Always keep Anthropic first (best raw-latency
 * cheap helper) then OpenAI then OpenRouter, then the rest grouped by
 * families so the array is easy to scan.
 */
export const PROVIDERS: readonly ProviderSpec[] = [
  // ── Anthropic-messages family ───────────────────────────────────────
  {
    prefix: "anthropic",
    displayName: "Anthropic",
    envKey: "ANTHROPIC_API_KEY",
    baseUrl: "https://api.anthropic.com/v1",
    api: "anthropic-messages",
    host: "anthropic.com",
    fastModel: "claude-haiku-4-5-20251001",
    sampleModel: "claude-sonnet-4-6",
    keyPrefix: "sk-ant-",
  },
  {
    prefix: "kimi-coding",
    displayName: "Kimi for Coding (Moonshot)",
    envKey: "KIMI_API_KEY",
    baseUrl: "https://api.kimi.com/coding",
    api: "anthropic-messages",
    host: "kimi.com",
    fastModel: "kimi-latest",
    sampleModel: "kimi-latest",
  },
  {
    prefix: "minimax",
    displayName: "MiniMax",
    envKey: "MINIMAX_API_KEY",
    baseUrl: "https://api.minimax.io/anthropic",
    api: "anthropic-messages",
    host: "minimax.io",
    fastModel: "MiniMax-M1",
    sampleModel: "MiniMax-M2",
  },
  // ── OpenAI-completions family — first-party OpenAI ──────────────────
  {
    prefix: "openai",
    displayName: "OpenAI",
    envKey: "OPENAI_API_KEY",
    baseUrl: "https://api.openai.com/v1",
    api: "openai-completions",
    host: "openai.com",
    fastModel: "gpt-5.4-mini",
    sampleModel: "gpt-5.5",
    maxTokensField: "max_completion_tokens",
    keyPrefix: "sk-",
  },
  // ── Google Gemini — routed through Google's OpenAI-compatible endpoint ──
  {
    prefix: "google",
    displayName: "Google AI Studio (Gemini)",
    envKey: "GEMINI_API_KEY",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta/openai",
    api: "openai-completions",
    host: "generativelanguage.googleapis.com",
    fastModel: "gemini-2.5-flash",
    sampleModel: "gemini-2.5-pro",
    keyPrefix: "AIza",
  },
  // ── Mistral — Mistral exposes an OpenAI-compatible path ──────────────
  {
    prefix: "mistral",
    displayName: "Mistral",
    envKey: "MISTRAL_API_KEY",
    baseUrl: "https://api.mistral.ai/v1",
    api: "openai-completions",
    host: "mistral.ai",
    fastModel: "mistral-small-latest",
    sampleModel: "mistral-large-latest",
  },
  // ── OpenAI-compatible inference specialists ──────────────────────────
  {
    prefix: "groq",
    displayName: "Groq",
    envKey: "GROQ_API_KEY",
    baseUrl: "https://api.groq.com/openai/v1",
    api: "openai-completions",
    host: "groq.com",
    fastModel: "llama-3.3-70b-versatile",
    sampleModel: "llama-3.3-70b-versatile",
  },
  {
    prefix: "cerebras",
    displayName: "Cerebras",
    envKey: "CEREBRAS_API_KEY",
    baseUrl: "https://api.cerebras.ai/v1",
    api: "openai-completions",
    host: "cerebras.ai",
    fastModel: "llama-3.3-70b",
    sampleModel: "llama-3.3-70b",
  },
  {
    prefix: "xai",
    displayName: "xAI (Grok)",
    envKey: "XAI_API_KEY",
    baseUrl: "https://api.x.ai/v1",
    api: "openai-completions",
    host: "x.ai",
    fastModel: "grok-3-mini",
    sampleModel: "grok-4",
  },
  {
    prefix: "huggingface",
    displayName: "Hugging Face",
    envKey: "HF_TOKEN",
    baseUrl: "https://router.huggingface.co/v1",
    api: "openai-completions",
    host: "huggingface.co",
    fastModel: "meta-llama/Llama-3.3-70B-Instruct",
    sampleModel: "meta-llama/Llama-3.3-70B-Instruct",
    keyPrefix: "hf_",
  },
  {
    prefix: "moonshotai",
    displayName: "Moonshot AI",
    envKey: "MOONSHOT_API_KEY",
    baseUrl: "https://api.moonshot.ai/v1",
    api: "openai-completions",
    host: "moonshot.ai",
    fastModel: "kimi-k2",
    sampleModel: "kimi-k2",
  },
  {
    prefix: "nvidia",
    displayName: "NVIDIA NIM",
    envKey: "NVIDIA_API_KEY",
    baseUrl: "https://integrate.api.nvidia.com/v1",
    api: "openai-completions",
    host: "integrate.api.nvidia.com",
    fastModel: "meta/llama-3.3-70b-instruct",
    sampleModel: "meta/llama-3.3-70b-instruct",
  },
  {
    prefix: "fireworks",
    displayName: "Fireworks",
    envKey: "FIREWORKS_API_KEY",
    baseUrl: "https://api.fireworks.ai/inference/v1",
    api: "openai-completions",
    host: "fireworks.ai",
    fastModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
    sampleModel: "accounts/fireworks/models/llama-v3p3-70b-instruct",
  },
  {
    prefix: "together",
    displayName: "Together",
    envKey: "TOGETHER_API_KEY",
    baseUrl: "https://api.together.ai/v1",
    api: "openai-completions",
    host: "together.ai",
    fastModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    sampleModel: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  },
  {
    prefix: "deepseek",
    displayName: "DeepSeek",
    envKey: "DEEPSEEK_API_KEY",
    baseUrl: "https://api.deepseek.com/v1",
    api: "openai-completions",
    host: "deepseek.com",
    fastModel: "deepseek-chat",
    sampleModel: "deepseek-chat",
  },
  {
    prefix: "zai",
    displayName: "Z.AI (GLM)",
    envKey: "ZAI_API_KEY",
    baseUrl: "https://api.z.ai/api/coding/paas/v4",
    api: "openai-completions",
    host: "z.ai",
    fastModel: "glm-4.6",
    sampleModel: "glm-4.6",
  },
  // ── OpenRouter — aggregator (take any pi.dev-listed model via one key) ──
  {
    prefix: "openrouter",
    displayName: "OpenRouter (aggregator — Anthropic, Google, xAI, …)",
    envKey: "OPENROUTER_API_KEY",
    baseUrl: "https://openrouter.ai/api/v1",
    api: "openai-completions",
    host: "openrouter.ai",
    fastModel: "google/gemini-2.5-flash",
    sampleModel: "anthropic/claude-sonnet-4.5",
    preserveNestedModelId: true,
    extraHeaders: {
      "HTTP-Referer": "https://github.com/nearform/lastlight",
      "X-Title": "Last Light",
    },
    keyPrefix: "sk-or-",
  },
];

const PREFIX_INDEX = new Map<string, ProviderSpec>(
  PROVIDERS.map((p) => [p.prefix, p]),
);

const ENV_INDEX = new Map<string, ProviderSpec>(
  PROVIDERS.map((p) => [p.envKey, p]),
);

export function providerByPrefix(prefix: string): ProviderSpec | undefined {
  return PREFIX_INDEX.get(prefix.toLowerCase());
}

export function providerByEnvKey(envKey: string): ProviderSpec | undefined {
  return ENV_INDEX.get(envKey);
}

/** All the env var names a harness must forward to reach every registered provider. */
export const PROVIDER_ENV_KEYS: readonly string[] = PROVIDERS.map((p) => p.envKey);

/** All the hosts the sandbox egress firewall must allowlist to reach these providers. */
export const PROVIDER_HOSTS: readonly string[] = PROVIDERS.map((p) => p.host);

/**
 * Default model spec shipped with the harness. Keep aligned with the
 * `OPENCODE_MODEL` default in `config/default.yaml` and the wizard's
 * initial provider selection.
 */
export const DEFAULT_PROVIDER = "anthropic";
export const DEFAULT_MODEL = "anthropic/claude-sonnet-4-6";

/**
 * OAuth (subscription-login) providers — the ones the API-key registry above
 * deliberately excludes. These don't authenticate with a static key env var;
 * a user logs in once (`lastlight oauth login <id>`) and pi-ai manages the
 * token. Two consumption seams with different reach:
 *
 *   - **chat** (in-process pi-ai) supports ALL of these — the chat runner
 *     passes the resolved token as the per-call `apiKey`.
 *   - **sandbox** (agentic-pi) resolves creds from ENV only, so a provider is
 *     sandbox-usable ONLY if `sandboxEnvVar` is set (the env var pi-ai reads
 *     inside the sandbox). Codex has none → chat-only.
 *
 * Egress note: chat is in-process (not behind the sandbox firewall), and the
 * one sandbox-capable OAuth provider whose models we ship (`anthropic`) reuses
 * the `anthropic.com` host already in the API-key registry — so no OAuth host
 * is added to the sandbox allowlist here.
 */
export interface OAuthProviderSpec {
  /** pi-ai OAuth provider id — also `lastlight oauth login <id>`. */
  readonly id: string;
  /** Display name (wizard + CLI). */
  readonly displayName: string;
  /** pi-ai model-spec prefix (`provider` in `provider/model`) for its models. */
  readonly modelPrefix: string;
  /** Representative model spec — wizard placeholder / docs hint. */
  readonly sampleModel: string;
  /**
   * Env var pi-ai reads for this provider's OAuth token inside a sandbox, or
   * `null` when there's no env route (⇒ chat-only; cannot run sandbox phases).
   */
  readonly sandboxEnvVar: string | null;
  /** True when login is mandatory (no API-key fallback). */
  readonly oauthOnly: boolean;
}

export const OAUTH_PROVIDERS: readonly OAuthProviderSpec[] = [
  {
    id: "openai-codex",
    displayName: "ChatGPT Plus/Pro (Codex)",
    modelPrefix: "openai-codex",
    sampleModel: "openai-codex/gpt-5.4",
    sandboxEnvVar: null, // chatgpt.com backend — no env route, chat-only
    oauthOnly: true,
  },
  {
    id: "anthropic",
    displayName: "Anthropic (Claude Pro/Max)",
    modelPrefix: "anthropic",
    sampleModel: "anthropic/claude-sonnet-4-6",
    sandboxEnvVar: "ANTHROPIC_OAUTH_TOKEN",
    oauthOnly: false, // falls back to ANTHROPIC_API_KEY
  },
  {
    id: "github-copilot",
    displayName: "GitHub Copilot",
    modelPrefix: "github-copilot",
    sampleModel: "github-copilot/gpt-4o",
    sandboxEnvVar: "COPILOT_GITHUB_TOKEN",
    oauthOnly: true,
  },
];

const OAUTH_PREFIX_INDEX = new Map<string, OAuthProviderSpec>(
  OAUTH_PROVIDERS.map((p) => [p.modelPrefix, p]),
);
const OAUTH_ID_INDEX = new Map<string, OAuthProviderSpec>(
  OAUTH_PROVIDERS.map((p) => [p.id, p]),
);

export function oauthProviderByModelPrefix(prefix: string): OAuthProviderSpec | undefined {
  return OAUTH_PREFIX_INDEX.get(prefix);
}

export function oauthProviderById(id: string): OAuthProviderSpec | undefined {
  return OAUTH_ID_INDEX.get(id);
}
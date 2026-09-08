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

// ── Endpoint overrides — pointing a provider at a gateway ────────────────────

/**
 * A deployment's override for ONE provider entry (issue #373).
 *
 * Two shapes, distinguished only by whether `prefix` names a registry entry:
 *
 *   - **override** — `{ baseUrl }` on top of a built-in (`anthropic`,
 *     `openai`, …). Everything else (api family, env key, models) is
 *     inherited, so a gateway that speaks the provider's own dialect needs
 *     one line.
 *   - **custom** — a prefix the registry has never heard of. `baseUrl` is
 *     required and `api` decides the request shape; `envKey`, `host` and
 *     `displayName` are derived from the prefix / URL when omitted.
 *
 * A gateway URL is deployment routing, not a secret — it belongs in
 * `config.yaml`. The API key stays in `secrets/.env` under `envKey`, exactly
 * as for a first-party provider.
 */
export interface ProviderOverride {
  /** Replacement API base URL. Required for a custom (unregistered) prefix. */
  readonly baseUrl?: string;
  /**
   * Request family. Custom prefixes only (default `openai-completions`) — see
   * {@link resolveProviderRegistry} for why a built-in's dialect cannot be
   * changed in place.
   */
  readonly api?: ApiType;
  /**
   * Env var carrying the API key. Defaults to the built-in's, or
   * `<PREFIX>_API_KEY` for a custom prefix. Overriding it on a built-in is how a
   * gateway keeps custody of its own credential (`GATEWAY_API_KEY` rather than
   * the vendor's `ANTHROPIC_API_KEY`).
   */
  readonly envKey?: string;
  /** Egress allowlist host. Defaults to the hostname of `baseUrl`. */
  readonly host?: string;
  /** Display name (wizard / logs). Defaults to the built-in's, or the prefix. */
  readonly displayName?: string;
  /** Small/fast model for the cheap in-process helpers. Defaults to the built-in's. */
  readonly fastModel?: string;
  /** Canonical model id (wizard placeholder). Defaults to `fastModel`. */
  readonly sampleModel?: string;
  /** Custom providers only: context window advertised to the agent. Default 128000. */
  readonly contextWindow?: number;
  /** Custom providers only: output-token ceiling advertised to the agent. Default 16384. */
  readonly maxTokens?: number;
}

export type ProviderOverrides = Readonly<Record<string, ProviderOverride>>;

/** One provider whose endpoint a deployment moved — the payload the sandbox needs. */
export interface ProviderEndpoint {
  readonly prefix: string;
  readonly baseUrl: string;
  readonly api: ApiType;
  readonly envKey: string;
  /** True when the prefix is not in {@link PROVIDERS} (nothing to inherit from). */
  readonly custom: boolean;
  /**
   * True when this deployment NAMED the key env var — always for a custom
   * provider, and for a built-in only when the override supplied a different
   * one. It is the difference between "hand the model call this key explicitly"
   * and "let the provider SDK resolve its own credential", and the latter is
   * what keeps an OAuth subscription login working on `anthropic`.
   */
  readonly envKeyOverridden: boolean;
  readonly contextWindow?: number;
  readonly maxTokens?: number;
}

/**
 * The provider list a deployment actually runs with: {@link PROVIDERS} with any
 * `baseUrl` (etc.) overrides applied, plus its custom entries appended.
 *
 * Resolved ONCE at config load and read everywhere the built-in constants used
 * to be. Custom entries go last so registry order — which is what
 * `defaultFastModel()` walks to pick a cheap helper — keeps preferring the
 * first-party providers a deployment already had keys for.
 */
export interface ProviderRegistry {
  readonly providers: readonly ProviderSpec[];
  byPrefix(prefix: string): ProviderSpec | undefined;
  byEnvKey(envKey: string): ProviderSpec | undefined;
  /** Every env var a harness must forward to reach every provider. */
  readonly envKeys: readonly string[];
  /** Every host the sandbox egress firewall must allow. */
  readonly hosts: readonly string[];
  /** Only the moved/custom endpoints — empty on a deployment that overrode nothing. */
  readonly endpoints: readonly ProviderEndpoint[];
}

/**
 * Env var carrying a per-provider base-URL override, derived from the prefix:
 * `anthropic` → `ANTHROPIC_BASE_URL`, `kimi-coding` → `KIMI_CODING_BASE_URL`.
 * The two that matter most (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`) are the
 * names the official SDKs already use, which is the point of deriving rather
 * than hand-listing.
 */
export function providerBaseUrlEnvVar(prefix: string): string {
  return `${prefix.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_BASE_URL`;
}

/** Default env var for a custom provider's API key: `acme` → `ACME_API_KEY`. */
export function defaultProviderEnvKey(prefix: string): string {
  return `${prefix.toUpperCase().replace(/[^A-Z0-9]+/g, "_")}_API_KEY`;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

/**
 * Validate + normalize a provider base URL (trailing slashes stripped, which
 * is what both URL builders in `llm.ts` assume).
 *
 * `https` is required, because a base URL override moves every prompt and every
 * API key onto that endpoint. The one exception is a loopback host — the
 * reported case is a gateway on `http://localhost:4000`, and there is no
 * network to eavesdrop on. `allowInsecure` (LASTLIGHT_ALLOW_INSECURE_PROVIDER_URLS)
 * opens it up for an operator who genuinely has a plaintext gateway on a
 * trusted network and has decided that is fine.
 */
export function normalizeProviderBaseUrl(
  raw: string,
  ctx: { prefix: string; allowInsecure?: boolean },
): string {
  const trimmed = raw.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error(
      `providers.${ctx.prefix}.baseUrl is not a valid URL: ${JSON.stringify(raw)} ` +
        `(expected something like https://gateway.internal/v1)`,
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error(`providers.${ctx.prefix}.baseUrl must be http(s), got ${url.protocol}`);
  }
  if (url.protocol === "http:" && !ctx.allowInsecure && !LOOPBACK_HOSTS.has(url.hostname)) {
    throw new Error(
      `providers.${ctx.prefix}.baseUrl uses http:// on a non-loopback host (${url.hostname}). ` +
        `API keys and prompts would cross the network in plaintext. Use https://, or set ` +
        `LASTLIGHT_ALLOW_INSECURE_PROVIDER_URLS=1 if that endpoint is genuinely trusted.`,
    );
  }
  return trimmed.replace(/\/+$/, "");
}

function isValidPrefix(prefix: string): boolean {
  return /^[a-z0-9][a-z0-9._-]*$/.test(prefix);
}

/**
 * Apply a deployment's `providers:` block to {@link PROVIDERS}.
 *
 * Pure and total: an empty/absent override map returns a registry that is
 * byte-for-byte the built-in one, which is what keeps every deployment that
 * has never heard of this feature behaving exactly as before.
 *
 * @throws on a malformed override (bad prefix, unusable URL, custom entry with
 * no `baseUrl`). Config errors are startup errors here — silently ignoring a
 * gateway the operator asked for would send their traffic to the vendor.
 */
export function resolveProviderRegistry(
  overrides: ProviderOverrides = {},
  opts: { allowInsecure?: boolean } = {},
): ProviderRegistry {
  const entries = Object.entries(overrides).filter(([, v]) => v && typeof v === "object");
  if (entries.length === 0) return buildRegistry(PROVIDERS, []);

  const providers: ProviderSpec[] = [];
  const endpoints: ProviderEndpoint[] = [];
  const custom: ProviderSpec[] = [];
  const seen = new Map<string, ProviderOverride>();
  for (const [rawPrefix, override] of entries) {
    const prefix = rawPrefix.trim().toLowerCase();
    if (!isValidPrefix(prefix)) {
      throw new Error(
        `providers.${rawPrefix}: not a usable model-spec prefix ` +
          `(lowercase letters, digits, ".", "-" and "_" only)`,
      );
    }
    seen.set(prefix, override);
  }

  // Built-ins first, in registry order, each patched by its override (if any).
  for (const spec of PROVIDERS) {
    const override = seen.get(spec.prefix);
    if (!override) {
      providers.push(spec);
      continue;
    }
    seen.delete(spec.prefix);
    // A built-in's DIALECT cannot be changed in place, and half-honouring it is
    // worse than refusing: the in-process helper would switch request shape
    // while the sandbox did not. pi composes an endpoint override over the
    // built-in catalog, and its `applyExtension` re-points those models' baseUrl
    // only — expressing "these models, different API family" requires
    // enumerating every model, which is exactly what a custom provider entry is.
    // So an operator whose gateway speaks a different dialect declares their own
    // prefix, and every path agrees by construction.
    if (override.api && override.api !== spec.api) {
      throw new Error(
        `providers.${spec.prefix}.api cannot be changed: "${spec.prefix}" is a built-in provider that ` +
          `speaks ${spec.api}. If your gateway proxies it but speaks ${override.api}, declare a provider ` +
          `of your own instead (a new prefix with baseUrl + api + envKey) and use it in models:.`,
      );
    }
    const baseUrl = override.baseUrl
      ? normalizeProviderBaseUrl(override.baseUrl, { prefix: spec.prefix, allowInsecure: opts.allowInsecure })
      : spec.baseUrl;
    const envKeyOverridden = !!override.envKey && override.envKey !== spec.envKey;
    const patched: ProviderSpec = {
      ...spec,
      baseUrl,
      envKey: override.envKey ?? spec.envKey,
      host: override.host ?? hostOf(baseUrl),
      displayName: override.displayName ?? spec.displayName,
      fastModel: override.fastModel ?? spec.fastModel,
      sampleModel: override.sampleModel ?? override.fastModel ?? spec.sampleModel,
    };
    providers.push(patched);
    if (baseUrl !== spec.baseUrl || envKeyOverridden) {
      endpoints.push({
        prefix: patched.prefix,
        baseUrl: patched.baseUrl,
        api: patched.api,
        envKey: patched.envKey,
        custom: false,
        envKeyOverridden,
      });
    }
  }

  // Whatever is left names no registry entry — a custom provider.
  for (const [prefix, override] of seen) {
    if (!override.baseUrl) {
      throw new Error(
        `providers.${prefix}.baseUrl is required — "${prefix}" is not a built-in provider, ` +
          `so there is no endpoint to inherit. Registered: ${PROVIDERS.map((p) => p.prefix).join(", ")}`,
      );
    }
    const baseUrl = normalizeProviderBaseUrl(override.baseUrl, { prefix, allowInsecure: opts.allowInsecure });
    const api = override.api ?? "openai-completions";
    const envKey = override.envKey ?? defaultProviderEnvKey(prefix);
    const fastModel = override.fastModel ?? "";
    custom.push({
      prefix,
      displayName: override.displayName ?? prefix,
      envKey,
      baseUrl,
      api,
      host: override.host ?? hostOf(baseUrl),
      fastModel,
      sampleModel: override.sampleModel ?? fastModel,
    });
    endpoints.push({
      prefix,
      baseUrl,
      api,
      envKey,
      custom: true,
      // Nothing else knows this provider, so nothing else can find its key.
      envKeyOverridden: true,
      contextWindow: override.contextWindow,
      maxTokens: override.maxTokens,
    });
  }

  return buildRegistry([...providers, ...custom], endpoints);
}

function hostOf(baseUrl: string): string {
  try {
    return new URL(baseUrl).hostname;
  } catch {
    return "";
  }
}

function buildRegistry(
  providers: readonly ProviderSpec[],
  endpoints: readonly ProviderEndpoint[],
): ProviderRegistry {
  const byPrefix = new Map(providers.map((p) => [p.prefix, p]));
  const byEnvKey = new Map(providers.map((p) => [p.envKey, p]));
  return {
    providers,
    byPrefix: (prefix: string) => byPrefix.get(prefix.toLowerCase()),
    byEnvKey: (envKey: string) => byEnvKey.get(envKey),
    envKeys: Array.from(new Set(providers.map((p) => p.envKey))),
    hosts: Array.from(new Set(providers.map((p) => p.host).filter(Boolean))),
    endpoints,
  };
}

/** The registry as shipped — the fallback for any context with no runtime config. */
export const BUILTIN_PROVIDER_REGISTRY: ProviderRegistry = buildRegistry(PROVIDERS, []);

/**
 * Read per-provider base-URL overrides out of the environment
 * (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, … — see
 * {@link providerBaseUrlEnvVar}). Only registry prefixes are scanned; a
 * *custom* provider is a config-shaped thing (it needs an api family and an env
 * key), so it comes from `providers:` in config.yaml or the `LASTLIGHT_PROVIDERS`
 * JSON map, not from a bare `_BASE_URL` var.
 */
export function providerOverridesFromEnv(env: NodeJS.ProcessEnv): ProviderOverrides {
  const out: Record<string, ProviderOverride> = {};
  for (const spec of PROVIDERS) {
    const value = env[providerBaseUrlEnvVar(spec.prefix)];
    if (value && value.trim()) out[spec.prefix] = { baseUrl: value.trim() };
  }
  return out;
}

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
   * `null` when there's no env route.
   *
   * `null` does NOT mean chat-only. It only bites on the **container** backends
   * (docker / smol), where the model call happens in-guest and cannot read the
   * host credential store. On the in-process backends (`gondolin`, the default,
   * and `none`) the orchestrator passes agentic-pi `authFile` and pi's
   * AuthStorage resolves every OAuth provider from it, Codex included. See the
   * OAuth block in `apps/server/src/engine/agent-executor.ts`.
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
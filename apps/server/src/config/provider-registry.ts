/**
 * The process-wide, override-resolved {@link ProviderRegistry} (issue #373).
 *
 * `lastlight-shared/providers` ships the DEFAULTS; a deployment may move any
 * provider's endpoint to its own gateway (`providers:` in config.yaml, or
 * `ANTHROPIC_BASE_URL`-style env vars) and may add providers the registry has
 * never heard of. `loadConfig()` resolves that once and installs it here.
 *
 * Why a module-level holder rather than a field read off `getRuntimeConfig()`:
 * the egress allowlist (`src/sandbox/egress-allowlist.ts`) is one of the
 * consumers, and `config.ts` imports IT (for `normalizeAllowlistHost`) — going
 * the other way would close an import cycle. This module depends on nothing but
 * `lastlight-shared`, so both sides can read it.
 *
 * Until `loadConfig()` runs (CLI paths, unit tests) the getter returns the
 * built-in registry, which is exactly the pre-#373 behaviour.
 */

import {
  BUILTIN_PROVIDER_REGISTRY,
  resolveProviderRegistry,
  type ProviderOverrides,
  type ProviderRegistry,
} from "lastlight-shared/providers";
// The deep path, not the "agentic-pi" barrel, on purpose: this module loads at
// config time in EVERY process, and importing that barrel transitively replaces
// the global undici dispatcher (see the lazy import in `src/sandbox/sandbox.ts`).
// `dist/providers.js` imports nothing at all.
import { PROVIDER_OVERRIDES_ENV } from "agentic-pi/dist/providers.js";

let current: ProviderRegistry = BUILTIN_PROVIDER_REGISTRY;

/** The registry this deployment runs with. Never null — defaults to the built-ins. */
export function providerRegistry(): ProviderRegistry {
  return current;
}

/** Install the resolved registry. Called by `loadConfig()`; exported for tests. */
export function setProviderRegistry(registry: ProviderRegistry): void {
  current = registry;
}

/** Resolve + install in one step. Throws (loudly, at startup) on a bad override. */
export function installProviderOverrides(
  overrides: ProviderOverrides,
  opts: { allowInsecure?: boolean } = {},
): ProviderRegistry {
  const resolved = resolveProviderRegistry(overrides, opts);
  current = resolved;
  return resolved;
}

/** Restore the shipped defaults (test teardown). */
export function resetProviderRegistry(): void {
  current = BUILTIN_PROVIDER_REGISTRY;
}

/**
 * Env var carrying the endpoint overrides into a sandbox — re-exported from
 * agentic-pi, which owns the name (it is that CLI's `--providers` fallback).
 * The container backends run the model call in-guest from a binary we hand only
 * an environment, so this is the one channel that reaches every backend, and a
 * writer/reader disagreement about the name would silently route every run back
 * to the vendor.
 */
export { PROVIDER_OVERRIDES_ENV };

/** One endpoint override in agentic-pi's wire shape. */
interface WireEndpoint {
  baseUrl: string;
  api: string;
  /**
   * Present ONLY when this deployment named the key env var. Its absence tells
   * agentic-pi to leave credential resolution to pi — which is what keeps an
   * OAuth subscription login working on a provider whose endpoint merely moved.
   */
  apiKeyEnv?: string;
  contextWindow?: number;
  maxTokens?: number;
}

/**
 * The endpoint overrides in agentic-pi's wire shape, or `undefined` when this
 * deployment overrode nothing — which is the common case, and the reason
 * nothing is forwarded at all then.
 */
export function providerEndpointOverrides(): Record<string, WireEndpoint> | undefined {
  const { endpoints } = current;
  if (endpoints.length === 0) return undefined;
  const out: Record<string, WireEndpoint> = {};
  for (const e of endpoints) {
    out[e.prefix] = {
      baseUrl: e.baseUrl,
      api: e.api,
      ...(e.envKeyOverridden ? { apiKeyEnv: e.envKey } : {}),
      ...(e.contextWindow ? { contextWindow: e.contextWindow } : {}),
      ...(e.maxTokens ? { maxTokens: e.maxTokens } : {}),
    };
  }
  return out;
}

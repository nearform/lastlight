/**
 * Point a provider at a different endpoint (lastlight#373).
 *
 * A deployment may run its models through a gateway — for central spend
 * accounting, key custody, rate limiting or audit — or through a self-hosted /
 * Azure-fronted endpoint that no built-in catalog entry names. Two shapes,
 * distinguished by whether pi knows the provider id:
 *
 *   - **known provider** (`anthropic`, `openai`, …) — `{ baseUrl }` is enough;
 *     the models, auth and request shape are inherited.
 *   - **unknown provider** — also needs `api` (the request family) and, in
 *     practice, `apiKeyEnv` (which env var holds the key). The model being run
 *     is registered on the fly, since a gateway has no catalog to enumerate.
 *
 * Applied through pi's own `ModelRuntime.registerProvider` seam, so the
 * override composes with the built-in provider rather than shadowing it.
 */
export interface ProviderEndpointOverride {
  /** Replacement API base URL (no trailing slash needed). */
  baseUrl: string;
  /** Request family. Required for a provider pi has no built-in entry for. */
  api?: string;
  /** Env var carrying the API key. Defaults to pi's own resolution for known providers. */
  apiKeyEnv?: string;
  /** Unknown providers only: context window to advertise. Default 128000. */
  contextWindow?: number;
  /** Unknown providers only: output-token ceiling to advertise. Default 16384. */
  maxTokens?: number;
  /** Literal headers sent on every call to this provider (never credentials). */
  headers?: Record<string, string>;
}

/** Prefix → endpoint override, as `--providers` / `AGENTIC_PI_PROVIDERS` carry it. */
export type ProviderEndpointOverrides = Record<string, ProviderEndpointOverride>;

/**
 * Env var carrying {@link ProviderEndpointOverrides} — the fallback for the
 * `--providers` flag, and the ONLY channel into a run that executes inside a
 * container the caller can hand nothing but an environment.
 *
 * Exported because it is a contract between two processes, and an orchestrator
 * that writes the name while this parser reads a different one fails silently:
 * every run would quietly reach the vendor instead of the operator's gateway.
 * Last Light imports this rather than repeating the literal
 * (`apps/server/src/config/provider-registry.ts`).
 *
 * This module is deliberately dependency-free so a host can import it without
 * pulling the agent runtime in (importing agentic-pi's barrel transitively
 * replaces the global undici dispatcher).
 */
export const PROVIDER_OVERRIDES_ENV = "AGENTIC_PI_PROVIDERS";

/**
 * Parse the `--providers` flag / `AGENTIC_PI_PROVIDERS` env value: a JSON object
 * of `{ "<prefix>": { "baseUrl": "…" } }`.
 *
 * Throws rather than warning. A bad override means the run would silently reach
 * the vendor with the operator's key instead of the gateway they configured —
 * exactly the failure this feature exists to prevent.
 */
export function parseProviderOverrides(raw: string, label: string): ProviderEndpointOverrides {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`${label} must be JSON: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${label} must be a JSON object of provider → { baseUrl, … }`);
  }
  const out: ProviderEndpointOverrides = {};
  for (const [prefix, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${label}.${prefix} must be an object with a baseUrl`);
    }
    const entry = value as Record<string, unknown>;
    if (typeof entry.baseUrl !== "string" || !entry.baseUrl.trim()) {
      throw new Error(`${label}.${prefix}.baseUrl is required`);
    }
    out[prefix] = {
      baseUrl: entry.baseUrl.trim().replace(/\/+$/, ""),
      ...(typeof entry.api === "string" ? { api: entry.api } : {}),
      ...(typeof entry.apiKeyEnv === "string" ? { apiKeyEnv: entry.apiKeyEnv } : {}),
      ...(typeof entry.contextWindow === "number" ? { contextWindow: entry.contextWindow } : {}),
      ...(typeof entry.maxTokens === "number" ? { maxTokens: entry.maxTokens } : {}),
      ...(entry.headers !== undefined ? { headers: parseHeaders(entry.headers, `${label}.${prefix}.headers`) } : {}),
    };
  }
  return out;
}

/**
 * Header values reach pi's `registerProvider`, which resolves them at request
 * time: a leading `!` runs a shell command and `$NAME` expands an env var. Only
 * literals are accepted, so an override can carry a flag but never a command
 * or a secret pulled from this process's environment.
 */
function parseHeaders(raw: unknown, label: string): Record<string, string> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${label} must be an object of header name → value`);
  }
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "string") {
      throw new Error(`${label}.${name} must be a string`);
    }
    if (value.startsWith("!") || value.includes("$")) {
      throw new Error(`${label}.${name} must be a literal value (no leading "!", no "$")`);
    }
    out[name] = value;
  }
  return out;
}

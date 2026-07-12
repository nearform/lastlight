/**
 * OAuth credential management for LLM providers that authenticate with a
 * subscription login instead of a static API key — ChatGPT Plus/Pro (Codex),
 * Claude Pro/Max, and GitHub Copilot.
 *
 * pi-ai (`@earendil-works/pi-ai/oauth`) owns the actual OAuth flows, token
 * refresh, and credential→apiKey conversion; this module is the thin Last
 * Light layer on top:
 *   - a single on-disk credential store (`auth.json`, same JSON shape pi-ai's
 *     own CLI writes) resolved under `$STATE_DIR` so the CLI (writer) and the
 *     running harness (reader) agree on one path,
 *   - `resolveOAuthApiKey()` — refresh-if-expired + persist rotated creds +
 *     return a usable key, used by the in-process chat path,
 *   - the model-prefix → provider-id map and the sandbox env-var route so the
 *     chat and sandbox executors can both find the right credential.
 *
 * Two consumption seams with different reach:
 *   - **chat** (in-process pi-ai) — passes `apiKey` in the stream options, so
 *     ALL three OAuth providers work, Codex included.
 *   - **sandbox** (agentic-pi) — has no apiKey option; it reads provider creds
 *     from env only. pi-ai honours `ANTHROPIC_OAUTH_TOKEN` and
 *     `COPILOT_GITHUB_TOKEN`, but Codex (chatgpt.com backend) has no env route,
 *     so a Codex model cannot run in the sandbox. See `oauthEnvVarForProvider`.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import {
  getOAuthApiKey,
  getOAuthProvider,
  getOAuthProviders,
  type OAuthCredentials,
} from "@earendil-works/pi-ai/oauth";
import { OAUTH_PROVIDERS, oauthProviderByModelPrefix, oauthProviderById } from "../providers.js";

/** Stored form — pi-ai's CLI tags each entry with `type: "oauth"`; we match it. */
export type StoredCredentials = OAuthCredentials & { type?: string };
export type AuthMap = Record<string, StoredCredentials>;

/** OAuth providers that CANNOT fall back to an API key — login is mandatory. */
export const OAUTH_ONLY_PROVIDERS: ReadonlySet<string> = new Set(
  OAUTH_PROVIDERS.filter((p) => p.oauthOnly).map((p) => p.id),
);

/** OAuth provider id backing a model spec, or undefined if it's API-key based. */
export function oauthProviderIdForModel(spec: string): string | undefined {
  const prefix = spec.includes("/") ? spec.slice(0, spec.indexOf("/")) : spec;
  return oauthProviderByModelPrefix(prefix)?.id;
}

/**
 * The env var pi-ai reads inside a sandbox for a provider's OAuth token, when
 * one exists. Returns undefined for providers with no env-var route (Codex),
 * which therefore cannot authenticate in the agentic-pi sandbox.
 */
export function oauthEnvVarForProvider(id: string): string | undefined {
  return oauthProviderById(id)?.sandboxEnvVar ?? undefined;
}

/**
 * Resolve the credential-store path. Precedence:
 *   1. explicit argument (a caller-computed path),
 *   2. `LASTLIGHT_AUTH_FILE` (hard override),
 *   3. `<stateDir | $STATE_DIR | ./data>/auth.json`.
 * The CLI writes here and the harness reads here, so both must agree; passing
 * the harness's resolved `stateDir` keeps them aligned even if the process cwd
 * differs.
 */
export function resolveAuthFile(explicit?: string, stateDir?: string): string {
  if (explicit) return resolve(explicit);
  if (process.env.LASTLIGHT_AUTH_FILE) return resolve(process.env.LASTLIGHT_AUTH_FILE);
  return resolve(stateDir || process.env.STATE_DIR || "data", "auth.json");
}

export function loadAuthMap(file?: string, stateDir?: string): AuthMap {
  const path = resolveAuthFile(file, stateDir);
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8"));
    return parsed && typeof parsed === "object" ? (parsed as AuthMap) : {};
  } catch {
    return {};
  }
}

export function saveAuthMap(map: AuthMap, file?: string, stateDir?: string): void {
  const path = resolveAuthFile(file, stateDir);
  mkdirSync(dirname(path), { recursive: true });
  // Mode 0600 — the file holds long-lived refresh tokens.
  writeFileSync(path, JSON.stringify(map, null, 2), { mode: 0o600 });
}

export function hasOAuthCredentials(id: string, file?: string, stateDir?: string): boolean {
  return !!loadAuthMap(file, stateDir)[id];
}

export interface OAuthKeyResult {
  apiKey: string;
  credentials: OAuthCredentials;
}

/**
 * Resolve a usable API key for an OAuth provider from stored credentials,
 * refreshing an expired token and persisting the rotated credentials back to
 * the store. Returns null when nothing is stored for `id`. Throws only if a
 * refresh actually fails (expired refresh token, revoked grant) — callers
 * should surface that as "re-run login".
 */
export async function resolveOAuthApiKey(
  id: string,
  file?: string,
  stateDir?: string,
): Promise<OAuthKeyResult | null> {
  const map = loadAuthMap(file, stateDir);
  if (!map[id]) return null;
  const res = await getOAuthApiKey(id, map);
  if (!res) return null;
  // Persist the rotated credentials so the next refresh chains from the new
  // token rather than re-using a spent one.
  map[id] = { type: "oauth", ...res.newCredentials };
  saveAuthMap(map, file, stateDir);
  return { apiKey: res.apiKey, credentials: res.newCredentials };
}

/** Re-exported so callers depend on this module, not pi-ai's oauth entry directly. */
export { getOAuthProvider, getOAuthProviders };

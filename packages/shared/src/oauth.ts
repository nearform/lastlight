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
import type {
  AuthInteraction,
  ProviderAuthInteraction,
  OAuthAuth,
  OAuthCredential,
  OAuthCredentials,
} from "@earendil-works/pi-ai";
import type { OAuthLoginCallbacks } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";
import { githubCopilotProvider } from "@earendil-works/pi-ai/providers/github-copilot";
import { openaiCodexProvider } from "@earendil-works/pi-ai/providers/openai-codex";
import { OAUTH_PROVIDERS, oauthProviderByModelPrefix, oauthProviderById } from "./providers.js";

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
  const res = await resolveOAuthApiKeyInternal(id, map);
  if (!res) return null;
  // Persist the rotated credentials so the next refresh chains from the new
  // token rather than re-using a spent one.
  map[id] = { type: "oauth", ...res.newCredentials };
  saveAuthMap(map, file, stateDir);
  return { apiKey: res.apiKey, credentials: res.newCredentials };
}

// ---------------------------------------------------------------------------
// Adapters for the removed pi-ai `getOAuthApiKey` / `getOAuthProvider` /
// `getOAuthProviders` functions. pi-ai@0.80.10 replaced the old callback-based
// OAuth surface with a new `OAuthAuth` / `AuthInteraction` interface. We
// implement the old shape here so callers in this repo keep working unchanged.
// ---------------------------------------------------------------------------

/** Map a pi-ai provider id to its OAuthAuth implementation (lazily instantiated). */
function resolveOAuthAuth(id: string): OAuthAuth | undefined {
  switch (id) {
    case "anthropic":
      return anthropicProvider().auth.oauth;
    case "github-copilot":
      return githubCopilotProvider().auth.oauth;
    case "openai-codex":
      return openaiCodexProvider().auth.oauth;
    default:
      return undefined;
  }
}

/**
 * Adapt the old `OAuthLoginCallbacks` shape to the new `AuthInteraction`
 * interface expected by `OAuthAuth.login()`.
 */
function adaptToAuthInteraction(callbacks: OAuthLoginCallbacks): ProviderAuthInteraction {
  return {
    // pi-ai 0.83 made `signal` REQUIRED on the provider-facing interaction (and
    // on `refresh`). The old callback surface leaves it optional, so fall back
    // to a controller nobody aborts — that is exactly the previous behaviour
    // (no cancellation), rather than inventing a timeout the caller never asked
    // for.
    signal: callbacks.signal ?? new AbortController().signal,
    notify(event) {
      if (event.type === "auth_url") {
        callbacks.onAuth({ url: event.url, instructions: event.instructions });
      } else if (event.type === "device_code") {
        callbacks.onDeviceCode({
          userCode: event.userCode,
          verificationUri: event.verificationUri,
          intervalSeconds: event.intervalSeconds,
          expiresInSeconds: event.expiresInSeconds,
        });
      } else if (event.type === "progress") {
        callbacks.onProgress?.(event.message);
      }
      // "info" events have no old-API equivalent — silently drop.
    },
    async prompt(p) {
      if (p.type === "select") {
        const result = await callbacks.onSelect({
          message: p.message,
          options: [...p.options],
        });
        return result ?? "";
      }
      if (p.type === "manual_code" && callbacks.onManualCodeInput) {
        return await callbacks.onManualCodeInput();
      }
      return await callbacks.onPrompt({
        message: p.message,
        placeholder: p.placeholder,
      });
    },
  };
}

/** Shape of the provider object the old `getOAuthProvider` API returned. */
export interface LegacyOAuthProvider {
  readonly id: string;
  readonly name: string;
  login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials>;
}

/** Returns all OAuth providers in the old callback-surface shape. */
export function getOAuthProviders(): LegacyOAuthProvider[] {
  return OAUTH_PROVIDERS.map((spec) => ({
    id: spec.id,
    name: spec.displayName,
    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      const oauthAuth = resolveOAuthAuth(spec.id);
      if (!oauthAuth) throw new Error(`OAuth flow not available for provider: ${spec.id}`);
      return oauthAuth.login(adaptToAuthInteraction(callbacks));
    },
  }));
}

/** Returns the named OAuth provider, or undefined when unknown. */
export function getOAuthProvider(id: string): LegacyOAuthProvider | undefined {
  const spec = OAUTH_PROVIDERS.find((p) => p.id === id);
  if (!spec) return undefined;
  return {
    id: spec.id,
    name: spec.displayName,
    async login(callbacks: OAuthLoginCallbacks): Promise<OAuthCredentials> {
      const oauthAuth = resolveOAuthAuth(spec.id);
      if (!oauthAuth) throw new Error(`OAuth flow not available for provider: ${spec.id}`);
      return oauthAuth.login(adaptToAuthInteraction(callbacks));
    },
  };
}

/** Internal: resolve + refresh an OAuth credential, return the API key. */
async function resolveOAuthApiKeyInternal(
  id: string,
  map: AuthMap,
): Promise<{ apiKey: string; newCredentials: OAuthCredentials } | null> {
  const stored = map[id];
  if (!stored) return null;
  const oauthAuth = resolveOAuthAuth(id);
  if (!oauthAuth) return null;

  // Cast: stored credentials match OAuthCredential shape (type: "oauth" + refresh/access/expires).
  let credential = stored as OAuthCredential;

  // Refresh if expired (60 s buffer to pre-empt clock skew).
  if (typeof credential.expires === "number" && credential.expires < Date.now() + 60_000) {
    credential = await oauthAuth.refresh(credential, new AbortController().signal);
  }

  const auth = await oauthAuth.toAuth(credential);
  if (!auth.apiKey) return null;
  return { apiKey: auth.apiKey, newCredentials: credential };
}

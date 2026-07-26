/**
 * GitHub App authentication.
 *
 * Ported from lastlight/mcp-github-app/src/auth.js with minimal changes:
 * - TypeScript types
 * - Static-token fallback wrapped into a shared GitHubAuth interface
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import jwt from "jsonwebtoken";

export interface GitHubAuth {
  /** Returns a currently-valid GitHub installation token (or the static token). */
  getToken(): Promise<string>;
  /** When the cached App token expires (null for static-token mode). */
  readonly expiresAt: Date | null;
  /**
   * Whether this auth can mint a NEW token. App auth can (re-mint from the
   * installation); a static injected `GITHUB_TOKEN` cannot — it's fixed for the
   * life of the process. Consumers use this to report honestly from
   * `github_refresh_git_auth` (which otherwise claims success while changing
   * nothing) and to avoid advising a refresh that can't help — e.g. a sandbox
   * run, where the harness injects a scoped token and clears the App key.
   */
  readonly canRefresh: boolean;
}

export interface GitHubAppAuthOptions {
  appId: string;
  privateKeyPath: string;
  installationId: string;
}

export class GitHubAppAuth implements GitHubAuth {
  private readonly appId: string;
  private readonly installationId: string;
  private readonly privateKey: string;
  private _token: string | null = null;
  private _expiresAt: Date | null = null;

  constructor({ appId, privateKeyPath, installationId }: GitHubAppAuthOptions) {
    this.appId = appId;
    this.installationId = installationId;
    try {
      this.privateKey = readFileSync(resolve(privateKeyPath), "utf8");
    } catch (err) {
      throw new Error(
        `GitHubAppAuth: cannot read private key at '${privateKeyPath}': ${(err as Error).message}`,
      );
    }
  }

  private generateJwt(): string {
    const now = Math.floor(Date.now() / 1000);
    return jwt.sign({ iat: now - 60, exp: now + 600, iss: this.appId }, this.privateKey, {
      algorithm: "RS256",
    });
  }

  async getToken(): Promise<string> {
    if (this._token && this._expiresAt) {
      const bufferMs = 5 * 60 * 1000;
      if (Date.now() + bufferMs < this._expiresAt.getTime()) {
        return this._token;
      }
    }

    const jwtToken = this.generateJwt();
    const res = await fetch(
      `https://api.github.com/app/installations/${this.installationId}/access_tokens`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${jwtToken}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to get installation token (${res.status}): ${body}`);
    }
    const data = (await res.json()) as { token: string; expires_at: string };
    this._token = data.token;
    this._expiresAt = new Date(data.expires_at);
    return this._token;
  }

  get expiresAt(): Date | null {
    return this._expiresAt;
  }

  /** App auth re-mints installation tokens from the private key on demand. */
  get canRefresh(): boolean {
    return true;
  }
}

class StaticTokenAuth implements GitHubAuth {
  constructor(private readonly token: string) {}
  async getToken(): Promise<string> {
    return this.token;
  }
  get expiresAt(): Date | null {
    return null;
  }
  /** A fixed injected token has no private key to re-mint from — it's stuck. */
  get canRefresh(): boolean {
    return false;
  }
}

export interface GitHubAuthEnv {
  GITHUB_APP_ID?: string;
  GITHUB_APP_PRIVATE_KEY_PATH?: string;
  GITHUB_APP_INSTALLATION_ID?: string;
  GITHUB_TOKEN?: string;
}

/** Why auth could not be built. Consumers can distinguish silent skips from misconfiguration. */
export type AuthFailureReason =
  | "no-credentials" // no GITHUB_APP_* and no GITHUB_TOKEN — silent skip
  | "pem-unreadable" // App creds set but the PEM file isn't readable
  | "invalid-config"; // partial App creds (e.g. APP_ID set, INSTALLATION_ID missing)

export interface BuildAuthResult {
  auth: GitHubAuth | null;
  reason?: AuthFailureReason;
  message?: string;
}

/**
 * Construct the appropriate auth backend from env vars.
 *
 * Prefer GitHub App credentials when all three are present. Static-token mode
 * is the fallback for low-trust sandboxes that intentionally clear the App env
 * vars — this stops a stale host-side GITHUB_TOKEN PAT from silently
 * downgrading the agent's auth. Mirrors mcp-github-app's behaviour.
 *
 * Returns a structured result so the caller can decide whether to warn or
 * just silently skip GitHub-tool registration.
 */
export function buildAuthFromEnv(env: GitHubAuthEnv = process.env): BuildAuthResult {
  const { GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_INSTALLATION_ID, GITHUB_TOKEN } =
    env;
  const appParts = [GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_INSTALLATION_ID];
  const appPartsSet = appParts.filter(Boolean).length;

  if (appPartsSet === 3) {
    try {
      const auth = new GitHubAppAuth({
        appId: GITHUB_APP_ID!,
        privateKeyPath: GITHUB_APP_PRIVATE_KEY_PATH!,
        installationId: GITHUB_APP_INSTALLATION_ID!,
      });
      return { auth };
    } catch (err) {
      return {
        auth: null,
        reason: "pem-unreadable",
        message: (err as Error).message,
      };
    }
  }

  if (appPartsSet > 0 && appPartsSet < 3) {
    return {
      auth: null,
      reason: "invalid-config",
      message:
        `Partial GitHub App credentials: ${appPartsSet}/3 of GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_INSTALLATION_ID are set. ` +
        `Set all three to use App auth, or unset all three to fall back to GITHUB_TOKEN.`,
    };
  }

  if (GITHUB_TOKEN) {
    return { auth: new StaticTokenAuth(GITHUB_TOKEN) };
  }

  return { auth: null, reason: "no-credentials" };
}

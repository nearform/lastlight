import crypto from "node:crypto";
import type { Context, Next } from "hono";

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30; // 30 days

/**
 * Grace window past `exp` in which a token can still be *refreshed* (but not
 * used to authenticate a normal request). Lets an active user whose token
 * lapsed briefly slide their session forward via the refresh route instead of
 * being bounced back through a full login. Beyond this, they must re-login.
 */
export const REFRESH_GRACE_SECONDS = 60 * 60 * 24 * 7; // 7 days

export function createToken(secret: string, method?: "password" | "slack" | "github"): string {
  const payload: { exp: number; method?: string } = { exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS };
  if (method) payload.method = method;
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const sig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  return `${payloadB64}.${sig}`;
}

/**
 * Verify the HMAC signature and return the decoded payload, or null if the
 * signature is invalid / the payload is unparseable. Does NOT check expiry —
 * that's the caller's job (strict for auth, lenient for refresh).
 */
function verifySignature(token: string, secret: string): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [payloadB64, sig] = parts as [string, string];
  const expectedSig = crypto.createHmac("sha256", secret).update(payloadB64).digest("base64url");
  if (
    expectedSig.length !== sig.length ||
    !crypto.timingSafeEqual(Buffer.from(expectedSig), Buffer.from(sig))
  ) {
    return null;
  }
  return decodeToken(token);
}

export function verifyToken(token: string, secret: string): boolean {
  const payload = verifySignature(token, secret);
  if (!payload) return false;
  return Math.floor(Date.now() / 1000) < payload.exp;
}

/**
 * Like `verifyToken`, but also accepts a token that expired within the last
 * `REFRESH_GRACE_SECONDS`. Used ONLY by the refresh route so a briefly-lapsed
 * session can be renewed. The signature must still be valid (we minted it), so
 * this can't be forged.
 */
export function verifyTokenForRefresh(token: string, secret: string): boolean {
  const payload = verifySignature(token, secret);
  if (!payload) return false;
  return Math.floor(Date.now() / 1000) < payload.exp + REFRESH_GRACE_SECONDS;
}

export interface TokenPayload {
  exp: number;
  method?: "password" | "slack" | "github";
}

/**
 * Decode a token's payload WITHOUT verifying its signature or expiry — used to
 * carry the login `method` across a refresh. Callers that need authenticity
 * must still gate on `verifyToken` (the refresh route runs behind
 * `authMiddleware`, which does exactly that). Returns null if unparseable.
 */
export function decodeToken(token: string): TokenPayload | null {
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  try {
    const payload = JSON.parse(Buffer.from(parts[0]!, "base64url").toString("utf8"));
    if (typeof payload.exp !== "number") return null;
    const method = payload.method;
    return {
      exp: payload.exp,
      method:
        method === "password" || method === "slack" || method === "github" ? method : undefined,
    };
  } catch {
    return null;
  }
}

/**
 * Whether any login method is configured — an admin password OR a working OAuth
 * provider. The single source of truth for "is auth on", shared by the admin
 * dashboard and the `/api/*` trigger routes so they can't drift. The GitHub
 * gate, like the OAuth route, also requires an allowed-org to be set.
 */
export function authIsEnabled(opts: {
  adminPassword?: string;
  slackOAuthClientId?: string;
  slackOAuthClientSecret?: string;
  githubOAuthClientId?: string;
  githubOAuthClientSecret?: string;
  githubAllowedOrg?: string;
}): boolean {
  const slack = Boolean(opts.slackOAuthClientId && opts.slackOAuthClientSecret);
  const github = Boolean(opts.githubOAuthClientId && opts.githubOAuthClientSecret && opts.githubAllowedOrg);
  return Boolean(opts.adminPassword) || slack || github;
}

/**
 * Gate the admin API. `enabled` should be true when ANY login method is
 * configured — an admin password OR a working OAuth provider. Gating only on
 * the password (the old behaviour) left the dashboard fully open whenever the
 * password was cleared, even with Slack/GitHub OAuth set up.
 */
export function authMiddleware(enabled: boolean, secret: string) {
  return async (c: Context, next: Next) => {
    if (!enabled) return next();

    const path = new URL(c.req.url).pathname;
    // Let login + health + OAuth routes through
    if (
      path.endsWith("/login") ||
      path.endsWith("/token/refresh") ||
      path.endsWith("/health") ||
      path.endsWith("/auth-required") ||
      path.endsWith("/oauth/slack/authorize") ||
      path.endsWith("/oauth/slack/callback") ||
      path.endsWith("/oauth/github/authorize") ||
      path.endsWith("/oauth/github/callback")
    ) {
      return next();
    }

    const header = c.req.header("Authorization");
    let token = header?.startsWith("Bearer ") ? header.slice(7) : undefined;
    // EventSource can't set headers — allow token via query param
    if (!token) token = c.req.query("token") ?? undefined;

    if (!token || !verifyToken(token, secret)) {
      return c.json({ error: "unauthorized" }, 401);
    }
    return next();
  };
}

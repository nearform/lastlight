import { execFileSync } from "child_process";
import { createSign } from "crypto";
import { readFileSync } from "fs";
import { resolve } from "path";
import { GITHUB_EXTRAHEADER_KEY, githubExtraheaderValue } from "../../sandbox/git-http-auth.js";

export type GitHubPermissionLevel = "read" | "write";

/**
 * Subset of GitHub App installation-token permissions supported by Last Light.
 * A profile's `permissions` object scopes the minted token to exactly its keys.
 */
export type GitHubTokenPermissions = Partial<{
  contents: GitHubPermissionLevel;
  issues: GitHubPermissionLevel;
  pull_requests: GitHubPermissionLevel;
  workflows: GitHubPermissionLevel;
  metadata: GitHubPermissionLevel;
}>;

/**
 * Whether to write the bot identity + `http.extraheader` auth to the user's
 * GLOBAL git config (`~/.gitconfig`). Defaults to **false** — the harness
 * still mints installation tokens and forwards them to sandboxes via the
 * `GIT_TOKEN` env var, where the harness sets a github.com-scoped
 * `http.extraheader` through `GIT_CONFIG_*` (see `agentGitIdentityEnv` /
 * `src/sandbox/git-http-auth.ts`). The host's `~/.gitconfig` is left
 * untouched.
 *
 * Set `LASTLIGHT_WRITE_GLOBAL_GIT=1` only when the harness itself runs git
 * commands against your real filesystem (e.g. a non-sandboxed direct
 * execution path). Production Docker doesn't need this — the sandbox git
 * picks up the extraheader from the ambient env.
 *
 * `LASTLIGHT_LOCAL_DEV=1` is accepted as a compat alias for the inverse
 * (legacy meaning: "skip global writes") and silently ignored; that is
 * now the default. The flag is harmless if left in place but the
 * intentional opt-in is `LASTLIGHT_WRITE_GLOBAL_GIT=1`.
 */
function shouldWriteGlobalGitConfig(): boolean {
  return process.env.LASTLIGHT_WRITE_GLOBAL_GIT === "1";
}

/**
 * Mint a GitHub App installation token; OPTIONALLY also write the bot
 * identity + a github.com-scoped `http.extraheader` to the user's global git
 * config.
 *
 * The default is to leave `~/.gitconfig` alone — every agent run happens
 * inside a Docker sandbox where the harness sets a github.com-scoped
 * `http.extraheader` via `GIT_CONFIG_*` env. The harness process itself does
 * not need git credentials for normal operation.
 *
 * Set `LASTLIGHT_WRITE_GLOBAL_GIT=1` only if you have a non-sandboxed
 * code path that needs the harness user to be able to push as the bot.
 */
export async function configureGitAuth(config: {
  appId: string;
  privateKeyPath: string;
  installationId: string;
  /** Resolved bot login incl. the `[bot]` suffix (e.g. `last-light[bot]`). */
  botLogin?: string;
  /**
   * Optional repository-name allowlist for the minted installation token.
   * Names are repo names within the installation owner (e.g. ["lastlight"]).
   */
  repositories?: string[];
  /** Optional per-token permission downscoping. */
  permissions?: GitHubTokenPermissions;
}): Promise<{ token: string; expiresAt: string }> {
  const token = await getInstallationToken(config);

  if (!shouldWriteGlobalGitConfig()) {
    console.log(`[git-auth] Minted GitHub App token (expires: ${token.expiresAt}). ` +
      `Global git config left untouched; sandboxes receive the token via GIT_TOKEN + ` +
      `a GIT_CONFIG_* http.extraheader. Set LASTLIGHT_WRITE_GLOBAL_GIT=1 to also write ~/.gitconfig.`);
    return token;
  }

  // Opt-in path: set a github.com-scoped `http.extraheader` in the global git
  // config so the harness user's git can push as the bot. No token in a URL,
  // no credentials file — the value is a Basic auth header, argv-passed (no
  // shell interpolation).
  execGit(["config", "--global", GITHUB_EXTRAHEADER_KEY, githubExtraheaderValue(token.token)]);

  const botLogin = config.botLogin || "last-light[bot]";
  execGit(["config", "--global", "user.name", botLogin]);
  execGit(["config", "--global", "user.email", `${botLogin}@users.noreply.github.com`]);

  console.log(`[git-auth] Configured GLOBAL git with GitHub App token via http.extraheader (expires: ${token.expiresAt})`);

  return token;
}

/**
 * Mint a fresh installation token. Same opt-in rule as configureGitAuth:
 * `LASTLIGHT_WRITE_GLOBAL_GIT=1` is required before this rotates the
 * credential helper in the user's `~/.gitconfig`. Otherwise the token is
 * just returned (executor.ts forwards it to the sandbox via env).
 */
export async function refreshGitAuth(config: {
  appId: string;
  privateKeyPath: string;
  installationId: string;
  /**
   * Optional repository-name allowlist for the minted installation token.
   * Names are repo names within the installation owner (e.g. ["lastlight"]).
   */
  repositories?: string[];
  /** Optional per-token permission downscoping. */
  permissions?: GitHubTokenPermissions;
}): Promise<{ token: string; expiresAt: string }> {
  const token = await getInstallationToken(config);

  if (!shouldWriteGlobalGitConfig()) {
    return token;
  }

  // Rewrite the github.com-scoped extraheader with the fresh token
  // (idempotent — safe to call standalone).
  execGit(["config", "--global", GITHUB_EXTRAHEADER_KEY, githubExtraheaderValue(token.token)]);

  console.log(`[git-auth] Refreshed token in GLOBAL git config via http.extraheader (expires: ${token.expiresAt})`);
  return token;
}

// ── Internal ────────────────────────────────────────────────────────

async function getInstallationToken(config: {
  appId: string;
  privateKeyPath: string;
  installationId: string;
  repositories?: string[];
  permissions?: GitHubTokenPermissions;
}): Promise<{ token: string; expiresAt: string }> {
  const privateKey = readFileSync(resolve(config.privateKeyPath), "utf-8");

  // Generate JWT (RS256, no external dependency)
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({ iat: now - 60, exp: now + 600, iss: config.appId })).toString("base64url");
  const signer = createSign("RSA-SHA256");
  signer.update(`${header}.${payload}`);
  const signature = signer.sign(privateKey, "base64url");
  const jwtToken = `${header}.${payload}.${signature}`;

  // Exchange for installation token
  const requestBody: Record<string, unknown> = {};
  if (config.repositories && config.repositories.length > 0) {
    requestBody.repositories = config.repositories;
  }
  if (config.permissions && Object.keys(config.permissions).length > 0) {
    requestBody.permissions = config.permissions;
  }
  const hasRequestBody = Object.keys(requestBody).length > 0;

  const res = await fetch(
    `https://api.github.com/app/installations/${config.installationId}/access_tokens`,
    {
      method: "POST",
      headers: {
        Authorization: `Bearer ${jwtToken}`,
        Accept: "application/vnd.github+json",
        ...(hasRequestBody ? { "Content-Type": "application/json" } : {}),
      },
      body: hasRequestBody ? JSON.stringify(requestBody) : undefined,
    }
  );

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`GitHub App token request failed (${res.status}): ${body}`);
  }

  const data = await res.json();
  return { token: data.token, expiresAt: data.expires_at };
}

function execGit(args: string[]): void {
  execFileSync("git", args, { stdio: "pipe" });
}

import { execFileSync } from "child_process";
import { createSign } from "crypto";
import { mkdirSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { dirname, join, resolve } from "path";

export type GitHubPermissionLevel = "read" | "write";

/**
 * Subset of GitHub App installation-token permissions supported by Last Light.
 * Any omitted permission inherits the app's installation defaults.
 */
export type GitHubTokenPermissions = Partial<{
  contents: GitHubPermissionLevel;
  issues: GitHubPermissionLevel;
  pull_requests: GitHubPermissionLevel;
  metadata: GitHubPermissionLevel;
}>;

/**
 * Whether to write the bot identity + credential helper to the user's
 * GLOBAL git config (`~/.gitconfig`). Defaults to **false** — the harness
 * still mints installation tokens and forwards them to sandboxes via the
 * `GIT_TOKEN` env var, where `sandbox-entrypoint.sh` configures git at the
 * container's `--system` scope. The host's `~/.gitconfig` is left
 * untouched.
 *
 * Set `LASTLIGHT_WRITE_GLOBAL_GIT=1` only when the harness itself runs git
 * commands against your real filesystem (e.g. a non-sandboxed direct
 * execution path). Production Docker doesn't need this — the entrypoint
 * sets `--system` config inside the container.
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
 * Conservative shape check on a GitHub installation token. The credentials
 * file we write contains a single URL of the form
 * `https://x-access-token:${token}@github.com` — any `@`, `:`, `/`, or
 * newline in the token would break URL parsing or inject extra entries.
 * Real GitHub tokens are alphanumeric (plus `_`); this assertion catches
 * any future format change before we write a malformed credentials file.
 */
function assertSafeToken(token: string): void {
  if (!/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Refusing to embed a token containing characters outside [A-Za-z0-9_-] into git credentials file");
  }
}

/**
 * Resolve the path of the shared credentials file used by `credential.helper
 * store`. Honors `LASTLIGHT_GIT_CREDENTIALS` so the sandbox entrypoint and
 * the MCP server can agree on a path; falls back to `~/.config/lastlight/
 * git-credentials` for the opt-in host write.
 *
 * Whitespace in the path would break git's helper-arg splitting (the
 * `store --file=<path>` value is shell-split on spaces, not exec'd), so
 * reject any whitespace defensively.
 */
function credentialsFilePath(): string {
  const fromEnv = process.env.LASTLIGHT_GIT_CREDENTIALS?.trim();
  const path = fromEnv || join(homedir(), ".config", "lastlight", "git-credentials");
  if (/\s/.test(path)) {
    throw new Error(`LASTLIGHT_GIT_CREDENTIALS contains whitespace; git's helper-arg parsing would break: ${path}`);
  }
  return path;
}

/**
 * Write the credentials file consumed by `credential.helper store`. One
 * line: `https://x-access-token:${token}@github.com`. File is mode 600,
 * parent dir mode 700. Returns the absolute path.
 */
function writeCredentialsFile(token: string): string {
  assertSafeToken(token);
  const credPath = credentialsFilePath();
  mkdirSync(dirname(credPath), { recursive: true, mode: 0o700 });
  writeFileSync(credPath, `https://x-access-token:${token}@github.com\n`, { mode: 0o600 });
  return credPath;
}

/**
 * Mint a GitHub App installation token; OPTIONALLY also write the bot
 * identity + credential helper to the user's global git config.
 *
 * The default is to leave `~/.gitconfig` alone — every agent run happens
 * inside a Docker sandbox where `sandbox-entrypoint.sh` configures git at
 * the container's `--system` scope using the `GIT_TOKEN` env var the
 * harness forwards. The harness process itself does not need git
 * credentials for normal operation.
 *
 * Set `LASTLIGHT_WRITE_GLOBAL_GIT=1` only if you have a non-sandboxed
 * code path that needs the harness user to be able to push as the bot.
 */
export async function configureGitAuth(config: {
  appId: string;
  privateKeyPath: string;
  installationId: string;
  botName?: string;
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
      `Global git config left untouched; sandboxes receive the token via GIT_TOKEN. ` +
      `Set LASTLIGHT_WRITE_GLOBAL_GIT=1 to also write ~/.gitconfig.`);
    return token;
  }

  // Opt-in path: write the token to a 600-mode credentials file and point
  // git's built-in `store` helper at it. No shell interpolation anywhere
  // along the way — git invokes `credential-store --file=<path>` as
  // argv-array, not through a shell.
  const credPath = writeCredentialsFile(token.token);
  execGit(["config", "--global", "credential.helper", `store --file=${credPath}`]);

  const botName = config.botName || "last-light";
  execGit(["config", "--global", "user.name", `${botName}[bot]`]);
  execGit(["config", "--global", "user.email", `${botName}[bot]@users.noreply.github.com`]);

  console.log(`[git-auth] Configured GLOBAL git with GitHub App token (file: ${credPath}, expires: ${token.expiresAt})`);

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

  const credPath = writeCredentialsFile(token.token);
  // The credential.helper config already points at this path from the
  // initial configureGitAuth call, but set it again so refreshGitAuth is
  // safe to call standalone (idempotent).
  execGit(["config", "--global", "credential.helper", `store --file=${credPath}`]);

  console.log(`[git-auth] Refreshed token in GLOBAL git config (file: ${credPath}, expires: ${token.expiresAt})`);
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

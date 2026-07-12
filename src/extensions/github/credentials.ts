/**
 * git credential-store credentials file management.
 *
 * Ported from mcp-github-app/src/index.js. Same shape, same guards.
 * The credentials file is shared with the sandbox entrypoint and any agent
 * git clone — we just rewrite the file with a fresh token when called.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Conservative shape check on a GitHub installation token. The credentials
 * file contains `https://x-access-token:${token}@github.com`, so any `@`,
 * `:`, `/`, or newline in the token would break URL parsing or inject extra
 * entries. Real tokens are alphanumeric (plus `_-`); this catches any future
 * format change before we write a malformed file.
 */
export function assertSafeToken(token: unknown): asserts token is string {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error(
      "Refusing to embed a token containing characters outside [A-Za-z0-9_-] into git credentials file",
    );
  }
}

/**
 * Resolve the credentials-file path. Mirrors lastlight's LASTLIGHT_GIT_CREDENTIALS
 * convention but accepts an explicit override too.
 */
export function credentialsFilePath(envVar = "LASTLIGHT_GIT_CREDENTIALS"): string {
  const raw =
    (process.env[envVar] || "").trim() ||
    join(process.env.HOME || "/tmp", ".lastlight-git-credentials");
  if (/\s/.test(raw)) {
    throw new Error(`${envVar} contains whitespace; git's helper-arg parsing would break: ${raw}`);
  }
  return raw;
}

/**
 * Write the credentials file. Mode 600, single line, no shell anywhere.
 */
export function writeCredentialsFile(token: string): string {
  assertSafeToken(token);
  const credPath = credentialsFilePath();
  mkdirSync(dirname(credPath), { recursive: true, mode: 0o700 });
  writeFileSync(credPath, `https://x-access-token:${token}@github.com\n`, { mode: 0o600 });
  return credPath;
}

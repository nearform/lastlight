/**
 * GitHub HTTP auth via git's `http.<url>.extraheader` config.
 *
 * Replaces the old credentials-file approach. Instead of writing
 * `https://x-access-token:${token}@github.com` to a mode-600 file and pointing
 * `credential.helper store` at it — which needed a charset guard because the
 * token was interpolated into a URL, and left a secret on disk — we inject a
 * github.com-scoped `Authorization: Basic` header via `GIT_CONFIG_*` env on the
 * git children we spawn. Nothing touches disk, and the token can carry any
 * character GitHub returns (`.`/`/`/`+`/`=`) because it rides base64 inside an
 * env value, never a URL.
 *
 * In the Last Light sandbox this is redundant — the harness already sets the
 * same extraheader in the ambient env — but it makes a standalone-on-host run
 * self-sufficient with nothing on disk. `git config --get-urlmatch` scopes the
 * header to github.com only, so the token never leaks to other hosts.
 */

/** Git config key carrying the github.com-scoped Authorization header. */
export const GITHUB_EXTRAHEADER_KEY = "http.https://github.com/.extraheader";

/** Base64 of `x-access-token:<token>` — the Basic-auth credential payload. */
export function githubBasicAuthB64(token: string): string {
  return Buffer.from(`x-access-token:${token}`).toString("base64");
}

/** Full `http.extraheader` value: `AUTHORIZATION: basic <b64>`. */
export function githubExtraheaderValue(token: string): string {
  return `AUTHORIZATION: basic ${githubBasicAuthB64(token)}`;
}

/**
 * `GIT_CONFIG_*` env fragment that authenticates github.com git operations for
 * any child spawned with it. Also re-asserts `safe.directory=*` so it composes
 * cleanly over the harness's ambient `GIT_CONFIG_*` (a naive merge would
 * otherwise clobber `GIT_CONFIG_COUNT` and drop that entry) — the values match
 * what the sandbox already sets, so overwriting is a no-op there and correct
 * standalone. Merge over `process.env` for the child, never into it.
 */
export function gitAuthEnv(token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: "2",
    GIT_CONFIG_KEY_0: "safe.directory",
    GIT_CONFIG_VALUE_0: "*",
    GIT_CONFIG_KEY_1: GITHUB_EXTRAHEADER_KEY,
    GIT_CONFIG_VALUE_1: githubExtraheaderValue(token),
  };
}

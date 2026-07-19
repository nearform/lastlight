/**
 * GitHub HTTP auth via git's `http.<url>.extraheader` config.
 *
 * The single auth mechanism for every git operation the harness or the agent
 * runs against github.com. Instead of embedding `x-access-token:<token>` into a
 * clone URL (which needs a charset guard because the token is interpolated into
 * a URL — GitHub intermittently returns tokens with `.`/`/`/`+`/`=`) or writing
 * a credentials file to disk, we inject an `Authorization: Basic` header scoped
 * to `https://github.com/` via `GIT_CONFIG_*` env (see `agentGitIdentityEnv`)
 * or a one-shot `-c` flag (discrete host git calls).
 *
 * The header value is `AUTHORIZATION: basic <base64("x-access-token:"+token)>`
 * (lowercase `basic` matches actions/checkout; the scheme is case-insensitive).
 * The secret lives only in the process env / a single argv element — never on
 * disk, never in host/system/repo git config. Verified with git 2.50: the URL
 * subsection resolves via `git config --get-urlmatch` and is scoped to
 * github.com only, so the token is never sent to package registries or other
 * egress (important for `unrestricted_egress` phases).
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
 * One-shot `-c <key>=<value>` args for a discrete `git` invocation (nothing
 * persisted). Precede the subcommand (after any `-C <dir>`).
 */
export function githubExtraheaderArgs(token: string): string[] {
  return ["-c", `${GITHUB_EXTRAHEADER_KEY}=${githubExtraheaderValue(token)}`];
}

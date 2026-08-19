/**
 * State-database URL vocabulary — the small pure things both `lastlight-core`
 * and the `lastlight` CLI have to agree about.
 *
 * It lives in `shared` for the same reason `repo-config-schema.ts` does: core
 * needs it at runtime (`StateDb.open()` picks a driver, `/config` redacts a
 * credential) and the CLI needs it offline (the setup wizard validates the URL
 * the operator types and reports the driver it implies), and the CLI may never
 * gain an edge to core. Nothing here imports a database driver — a `pg` import
 * anywhere in this file would put node-postgres in the CLI's dependency graph.
 */

/** Which Postgres driver carries the `"postgres"` dialect. */
export type PgDriver = "pg" | "neon";

export const PG_DRIVERS: readonly PgDriver[] = ["pg", "neon"];

/** Case-insensitive, because URL schemes are and `POSTGRES://` is a real typo. */
const POSTGRES_URL_RE = /^postgres(ql)?:\/\//i;

/** Does this DB URL name Postgres (rather than a libsql `file:` / `:memory:`)? */
export function isPostgresUrl(input: string | undefined | null): boolean {
  return !!input && POSTGRES_URL_RE.test(input.trim());
}

export function isPgDriver(value: unknown): value is PgDriver {
  return value === "pg" || value === "neon";
}

/**
 * Hosts served by Neon's WebSocket pooler. An explicit `database.driver` always
 * beats this, so the list only has to cover the common case.
 */
const NEON_HOST_RE = /(^|\.)neon\.tech$/i;

/**
 * Which driver to run a `postgres://` URL over.
 *
 * `configured` (from `database.driver` / `DATABASE_DRIVER`) always wins — a Neon
 * database fronted by a custom domain, or node-postgres pointed at Neon's TCP
 * endpoint, both need to be expressible. Unset falls back to the host
 * heuristic, which answers `"neon"` only for `*.neon.tech`.
 *
 * An unparseable URL resolves to `"pg"`: the driver builder is about to fail on
 * it anyway, and node-postgres produces the better message.
 */
export function resolvePgDriver(url: string, configured?: PgDriver | null): PgDriver {
  if (isPgDriver(configured)) return configured;
  return NEON_HOST_RE.test(dbUrlHost(url) ?? "") ? "neon" : "pg";
}

/**
 * Splits `scheme://` + userinfo + the rest without `new URL()`, which rejects a
 * password containing an unencoded `@` — exactly the case where getting
 * redaction right matters most. The userinfo group is GREEDY so it runs to the
 * LAST `@` in the authority: a lazy match would leave the tail of such a
 * password in the "safe" remainder.
 */
const USERINFO_RE = /^([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^/?#]*@)(.*)$/s;

/**
 * A DB URL safe to log or echo from the dashboard's `/config` view.
 *
 * Masks the userinfo and any `password=` query parameter, keeping the host,
 * port and database name — those are not secrets, and they are the whole reason
 * the provenance view exists. `file:` URLs and `:memory:` pass through
 * untouched; there is nothing in them to leak.
 *
 * Anything that carries a `@` but does not parse is masked WHOLESALE rather
 * than returned — a redactor that fails open is not a redactor.
 */
export function redactDbUrl(url: string): string {
  const trimmed = url.trim();
  if (!trimmed || trimmed === ":memory:" || /^file:/i.test(trimmed)) return url;
  const match = USERINFO_RE.exec(trimmed);
  if (!match) {
    // No userinfo at all (`postgres://host/db`) — nothing to mask beyond the
    // query string. A string with an `@` that reached here is unparseable, so
    // it gets the blunt treatment.
    if (trimmed.includes("@")) return "[redacted]";
    return maskPasswordParam(trimmed);
  }
  const [, scheme, , rest] = match;
  // Fail CLOSED. A surviving `@` means the authority did not end where the
  // regex thought (an unencoded `/` in the password, say), so what looks like
  // the safe remainder may still be part of the credential.
  if (rest.includes("@")) return "[redacted]";
  return `${scheme}***:***@${maskPasswordParam(rest)}`;
}

function maskPasswordParam(input: string): string {
  return input.replace(/([?&](?:password|pgpassword)=)[^&]*/gi, "$1***");
}

/** The host of a DB URL, or undefined if it has none / does not parse. */
export function dbUrlHost(url: string): string | undefined {
  return parsePgEndpoint(url)?.host;
}

/**
 * Host + port for a `postgres://` URL, for a reachability probe that must not
 * import a driver (the setup wizard opens a bare TCP socket).
 *
 * Hand-parsed for the same reason {@link redactDbUrl} is: `new URL()` throws on
 * an unencoded `@` in the password, and a wizard that rejects a working URL
 * because of its punctuation is worse than no check at all.
 */
export function parsePgEndpoint(url: string): { host: string; port: number } | undefined {
  const trimmed = url.trim();
  const afterScheme = trimmed.replace(/^[A-Za-z][A-Za-z0-9+.-]*:\/\//, "");
  if (afterScheme === trimmed) return undefined; // no scheme → not a URL
  // Authority ends at the first `/`, `?` or `#`; userinfo ends at the LAST `@`
  // inside it, so a password containing `@` does not steal the host.
  const authority = afterScheme.split(/[/?#]/, 1)[0] ?? "";
  const hostPort = authority.slice(authority.lastIndexOf("@") + 1);
  if (!hostPort) return undefined;
  // IPv6 literal: `[::1]:5432`.
  const v6 = /^\[([^\]]+)\](?::(\d+))?$/.exec(hostPort);
  if (v6) return { host: v6[1], port: v6[2] ? Number(v6[2]) : 5432 };
  const [host, port] = hostPort.split(":");
  if (!host) return undefined;
  return { host, port: port && /^\d+$/.test(port) ? Number(port) : 5432 };
}

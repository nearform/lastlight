/**
 * The pure DB-URL vocabulary (`lastlight-shared/database-url`).
 *
 * Two of these are security assertions rather than style: `redactDbUrl` is the
 * only thing between a `postgres://user:pass@host/db` and the dashboard's
 * `/config` provenance view, and `resolvePgDriver` picking `neon-http` instead
 * of the WebSocket driver would silently lose every transaction. Both are
 * tested here rather than through the config layer so the table stays readable.
 */
import { describe, it, expect } from "vitest";
import {
  isPostgresUrl,
  parsePgEndpoint,
  redactDbUrl,
  resolvePgDriver,
} from "lastlight-shared/database-url";

describe("isPostgresUrl", () => {
  it.each([
    ["postgres://host/db", true],
    ["postgresql://user:pw@host:5432/db", true],
    // Case-insensitive: a `POSTGRES://` typo reaching the libsql client
    // produces an opaque ConnectionFailed instead of the postgres branch.
    ["POSTGRES://host/db", true],
    ["file:/app/data/lastlight.db", false],
    [":memory:", false],
    ["/var/lib/lastlight.db", false],
    ["", false],
  ])("%s → %s", (url, expected) => {
    expect(isPostgresUrl(url)).toBe(expected);
  });
});

describe("resolvePgDriver", () => {
  it.each([
    ["postgres://u:p@ep-cool-name-123.eu-central-1.aws.neon.tech/db", "neon"],
    ["postgres://u:p@neon.tech/db", "neon"],
    // Not Neon: a lookalike host must not select the WebSocket driver.
    ["postgres://u:p@neon.tech.evil.example.com/db", "pg"],
    ["postgres://u:p@db.internal:5432/lastlight", "pg"],
    ["postgres://localhost/lastlight", "pg"],
    ["postgres://u:p@aws-0-eu-west-2.pooler.supabase.com:6543/postgres", "pg"],
  ] as const)("%s → %s", (url, expected) => {
    expect(resolvePgDriver(url)).toBe(expected);
  });

  it("an explicit driver always beats the heuristic, both ways", () => {
    // A Neon database behind a custom domain…
    expect(resolvePgDriver("postgres://db.acme.dev/lastlight", "neon")).toBe("neon");
    // …and node-postgres forced against Neon's TCP endpoint.
    expect(resolvePgDriver("postgres://ep-x.neon.tech/db", "pg")).toBe("pg");
  });

  it("falls back to pg for a URL it cannot parse", () => {
    expect(resolvePgDriver("not a url")).toBe("pg");
  });
});

describe("redactDbUrl", () => {
  it("masks the userinfo but keeps host, port and database", () => {
    expect(redactDbUrl("postgres://lastlight:hunter2@db.internal:5432/lastlight")).toBe(
      "postgres://***:***@db.internal:5432/lastlight",
    );
  });

  it("masks a password query parameter too", () => {
    expect(redactDbUrl("postgres://host/db?sslmode=require&password=hunter2")).toBe(
      "postgres://host/db?sslmode=require&password=***",
    );
  });

  it("leaves non-secret forms visible — they are the whole point of /config", () => {
    expect(redactDbUrl("file:/app/data/lastlight.db")).toBe("file:/app/data/lastlight.db");
    expect(redactDbUrl(":memory:")).toBe(":memory:");
    expect(redactDbUrl("postgres://db.internal:5432/lastlight")).toBe(
      "postgres://db.internal:5432/lastlight",
    );
  });

  it("handles a password containing @, which new URL() rejects", () => {
    expect(redactDbUrl("postgres://u:p@ss@host:5432/db")).toBe("postgres://***:***@host:5432/db");
  });

  it("masks wholesale rather than failing open on something it cannot parse", () => {
    expect(redactDbUrl("u:p@host/db")).toBe("[redacted]");
    // An unencoded `/` inside the password leaves the authority boundary
    // ambiguous, so the remainder is not provably credential-free.
    expect(redactDbUrl("postgres://u:p@ss/word@host:5432/db")).toBe("[redacted]");
  });
});

describe("parsePgEndpoint", () => {
  it.each([
    ["postgres://u:p@db.internal:5432/lastlight", { host: "db.internal", port: 5432 }],
    // No port → Postgres's default, which is what a probe should dial.
    ["postgres://db.internal/lastlight", { host: "db.internal", port: 5432 }],
    ["postgres://u:p@host:6543/db?sslmode=require", { host: "host", port: 6543 }],
    // The LAST `@` ends the userinfo, so an `@` in the password can't steal the host.
    ["postgres://u:p@ss@host:5432/db", { host: "host", port: 5432 }],
    ["postgres://[::1]:5433/db", { host: "::1", port: 5433 }],
  ] as const)("%s", (url, expected) => {
    expect(parsePgEndpoint(url)).toEqual(expected);
  });

  it("returns undefined for a non-URL", () => {
    expect(parsePgEndpoint("/var/lib/lastlight.db")).toBeUndefined();
  });
});

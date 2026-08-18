import { describe, it, expect } from "vitest";
import {
  CONTAINER_DB_PATH,
  STATE_CLI_PATH,
  dbCheckArgv,
  dbMigrateArgv,
} from "../src/cli-server.js";

/**
 * `lastlight server db` runs the state tools INSIDE the agent image, because
 * that is where `pg`, `@libsql/client` and the two Drizzle schemas live and the
 * CLI may never gain an edge to `lastlight-core` (a dep-cruiser gate). So the
 * only thing the CLI owns is the argv — and each flag below is load-bearing in
 * a way that fails silently if it is dropped.
 */
describe("dbMigrateArgv", () => {
  it("runs the state CLI in a throwaway container with no sidecars", () => {
    expect(dbMigrateArgv({})).toEqual([
      "run",
      // No container left behind after a one-shot tool.
      "--rm",
      // Without this, compose starts the egress sidecars (and anything else
      // `agent` depends on) as a side effect of a data migration.
      "--no-deps",
      // The image's normal entrypoint boots the harness — which would open the
      // database this command is about to copy.
      "--entrypoint",
      "node",
      "agent",
      STATE_CLI_PATH,
      "migrate",
      "--from",
      CONTAINER_DB_PATH,
    ]);
  });

  it("omits --to by default so the credential never reaches the host's process list", () => {
    // The recommended flow is DATABASE_URL in instance/secrets/.env, which the
    // container already has: nothing to type, nothing in shell history.
    expect(dbMigrateArgv({}).join(" ")).not.toContain("--to");
    expect(dbMigrateArgv({ to: "postgres://u:p@host/db" })).toContain("--to");
  });

  it("passes the optional flags through verbatim", () => {
    const argv = dbMigrateArgv({
      from: "/app/data/old.db",
      to: "postgres://host/db",
      driver: "neon",
      batch: "1000",
      dryRun: true,
      truncate: true,
      json: true,
    });
    expect(argv).toContain("/app/data/old.db");
    expect(argv.slice(argv.indexOf("--driver"))).toContain("neon");
    expect(argv).toContain("--dry-run");
    expect(argv).toContain("--truncate");
    expect(argv).toContain("--json");
    // `--from` still points at the override, not the default.
    expect(argv).not.toContain(CONTAINER_DB_PATH);
  });
});

describe("dbCheckArgv", () => {
  it("probes without a URL, so it reads the container's own DATABASE_URL", () => {
    expect(dbCheckArgv()).toEqual([
      "run",
      "--rm",
      "--no-deps",
      "--entrypoint",
      "node",
      "agent",
      STATE_CLI_PATH,
      "check",
    ]);
  });

  it("accepts an explicit URL for probing a server before committing to it", () => {
    expect(dbCheckArgv("postgres://host/db").slice(-2)).toEqual(["--url", "postgres://host/db"]);
  });
});

#!/usr/bin/env node
/**
 * `lastlight-state` — the state-database tool, shipped inside the agent image.
 *
 * Two commands an operator needs when moving a deployment onto Postgres:
 *
 * ```
 * lastlight-state check   --url postgres://…
 * lastlight-state migrate --from /app/data/lastlight.db --to postgres://…
 * ```
 *
 * **Why it lives in `lastlight-core` rather than the `lastlight` CLI.** The CLI
 * is deliberately dependency-light and may never gain an edge to core (a
 * dep-cruiser gate); `pg`, `@libsql/client` and the two Drizzle schemas all
 * live here. So the CLI drives this binary *inside the agent container* —
 * `lastlight server db migrate` is a thin wrapper around
 * `docker compose run --rm --entrypoint node agent … state-cli.js`, which also
 * means the probe runs from the network the harness will actually run on
 * rather than from the operator's laptop.
 *
 * Output goes to `process.stdout` directly rather than through the logger: this
 * is a foreground tool a human is watching, not a service writing to a sink.
 * (The "stdout is reserved for the sandbox NDJSON protocol" rule is about the
 * harness process — this is a separate, short-lived entry point.)
 */
import {
  StateMigrationError,
  describeError,
  migrateStateData,
  type MigrateProgress,
} from "./data-migrate.js";
import {
  isPgDriver,
  isPostgresUrl,
  redactDbUrl,
  resolvePgDriver,
  type PgDriver,
} from "lastlight-shared/database-url";

const USAGE = `lastlight-state — Last Light state database tools

Usage:
  lastlight-state check   --url <url>
  lastlight-state migrate --from <sqlite path|file: url> --to <postgres:// url> [options]

Options (migrate):
  --driver pg|neon   Postgres driver. Default: auto-detected from the host.
  --batch <n>        Rows per round trip (default 500).
  --dry-run          Count and report; write nothing.
  --truncate         Delete existing target rows first (default: refuse a non-empty target).
  --json             Emit the result as one JSON object instead of a report.

Migrating an existing deployment:
  1. Stop the agent           (lastlight server stop agent)
  2. Copy the data            (this command)
  3. Point DATABASE_URL at Postgres in instance/secrets/.env
  4. Start it again           (lastlight server start agent)

The source is opened exactly as the harness opens it, which applies its pending
migrations — a WRITE. Never point this at a database a running Last Light owns.
`;

function out(line = ""): void {
  process.stdout.write(`${line}\n`);
}

interface Args {
  command?: string;
  flags: Map<string, string | true>;
}

export function parseArgs(argv: string[]): Args {
  const flags = new Map<string, string | true>();
  let command: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (!arg.startsWith("--")) {
      command ??= arg;
      continue;
    }
    const [name, inline] = arg.slice(2).split(/=(.*)/s);
    if (inline !== undefined) {
      flags.set(name, inline);
    } else if (argv[i + 1] && !argv[i + 1].startsWith("--")) {
      flags.set(name, argv[++i]);
    } else {
      flags.set(name, true);
    }
  }
  return { command, flags };
}

function str(flags: Args["flags"], name: string): string | undefined {
  const value = flags.get(name);
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/**
 * Reachability + credentials, with no schema side effects.
 *
 * Deliberately NOT `StateDb.open()`: that runs the migrator, and "can I reach
 * this server" is a question an operator asks BEFORE deciding to migrate onto
 * it. `select 1` answers exactly that — host, port, TLS, user, password and
 * database name — and nothing more.
 */
async function checkCommand(url: string): Promise<number> {
  if (!isPostgresUrl(url)) {
    out(`✓ ${redactDbUrl(url)} — SQLite/libsql target; nothing to reach.`);
    return 0;
  }
  const driver = resolvePgDriver(url);
  const { makePgClient } = await import("./pg-client.js");
  const started = Date.now();
  let handle: Awaited<ReturnType<typeof makePgClient>> | undefined;
  try {
    handle = await makePgClient(url, driver, { poolMax: 1 });
    const { sql } = await import("drizzle-orm");
    const { rows } = await import("./dialect.js");
    await rows(handle.client, sql`select 1`);
    out(`✓ Connected to ${redactDbUrl(url)} (driver: ${driver}, ${Date.now() - started}ms)`);
    return 0;
  } catch (err) {
    out(`✗ Could not connect to ${redactDbUrl(url)} (driver: ${driver})`);
    // The reason lives down the cause chain — Drizzle's own message is just
    // the SQL, so "password authentication failed" would otherwise read as
    // "Failed query: select 1".
    out(`  ${describeError(err)}`);
    return 1;
  } finally {
    await handle?.close().catch(() => {});
  }
}

/**
 * A one-line-per-table progress report that stays readable in a docker log.
 *
 * Stateful because a line is opened at `table-start` and closed at
 * `table-done`: the "…" has to be terminated by whatever comes next, or a dry
 * run (which copies nothing) runs every table together on one line.
 */
function makeProgressRenderer(): (event: MigrateProgress) => void {
  let open = false;
  return (event) => {
    if (event.type === "table-start" && event.rows > 0) {
      process.stdout.write(`  ${event.table.padEnd(24)} ${String(event.rows).padStart(8)} rows … `);
      open = true;
    } else if (event.type === "table-done" && open) {
      out(event.copied > 0 ? "copied" : "counted");
      open = false;
    }
  };
}

async function migrateCommand(flags: Args["flags"]): Promise<number> {
  const from = str(flags, "from");
  const to = str(flags, "to");
  if (!from || !to) {
    out("Both --from and --to are required.\n");
    out(USAGE);
    return 2;
  }
  if (!isPostgresUrl(to)) {
    out(`--to must be a postgres:// URL (got "${redactDbUrl(to)}").`);
    return 2;
  }
  const driverFlag = str(flags, "driver");
  let driver: PgDriver | undefined;
  if (driverFlag) {
    if (!isPgDriver(driverFlag)) {
      out(`--driver must be "pg" or "neon" (got "${driverFlag}").`);
      return 2;
    }
    driver = driverFlag;
  }
  const json = flags.get("json") === true;
  const dryRun = flags.get("dry-run") === true;

  if (!json) {
    out(`${dryRun ? "Dry run" : "Migrating"}: ${from} → ${redactDbUrl(to)}`);
    out(`Driver: ${resolvePgDriver(to, driver)}`);
    out("");
  }

  try {
    const result = await migrateStateData({
      from,
      to,
      driver,
      batchSize: str(flags, "batch") ? Number(str(flags, "batch")) : undefined,
      dryRun,
      truncate: flags.get("truncate") === true,
      onProgress: json ? undefined : makeProgressRenderer(),
    });
    if (json) {
      out(JSON.stringify(result));
      return 0;
    }
    out("");
    for (const table of result.tables) {
      const suffix = dryRun ? "" : ` → ${table.target} in target`;
      out(`  ${table.table.padEnd(24)} ${String(table.source).padStart(8)} rows${suffix}`);
    }
    out("");
    out(
      dryRun
        ? `Dry run complete — ${result.tables.reduce((n, t) => n + t.source, 0)} rows would be copied.`
        : `Copied ${result.totalRows} rows in ${(result.durationMs / 1000).toFixed(1)}s. ` +
            "Row counts verified against the source.",
    );
    if (!dryRun) {
      out("");
      out("Next: set DATABASE_URL in instance/secrets/.env and restart the agent.");
    }
    return 0;
  } catch (err) {
    out("");
    out(`✗ Migration failed: ${describeError(err)}`);
    // Only suggest --truncate when rows may actually have landed. Telling
    // someone to wipe a database this run never touched is worse than silence.
    if (!(err instanceof StateMigrationError) || err.wrote) {
      out("  The target may be partially filled. Re-run with --truncate to start clean.");
    }
    return 1;
  }
}

export async function runStateCli(argv: string[]): Promise<number> {
  const { command, flags } = parseArgs(argv);
  switch (command) {
    case "check": {
      const url = str(flags, "url") ?? process.env.DATABASE_URL;
      if (!url) {
        out("check needs --url (or DATABASE_URL in the environment).");
        return 2;
      }
      return checkCommand(url);
    }
    case "migrate":
      return migrateCommand(flags);
    case "help":
    case undefined:
      out(USAGE);
      return command ? 0 : 2;
    default:
      out(`Unknown command "${command}".\n`);
      out(USAGE);
      return 2;
  }
}

// Only when executed as a program — importing this module (tests) must not exit.
if (process.argv[1] && import.meta.url === `file://${process.argv[1]}`) {
  process.exitCode = await runStateCli(process.argv.slice(2));
}

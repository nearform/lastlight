/**
 * Pre-migrator compatibility step for databases that predate Drizzle.
 *
 * Runs on every boot, BEFORE the migrator, against the raw `@libsql/client`
 * handle (Drizzle isn't constructed yet). SQLite-only and idempotent.
 *
 * It exists because `CREATE TABLE IF NOT EXISTS` no-ops on a table that already
 * exists — including one missing columns a later release added by `ALTER`. The
 * baseline migration therefore cannot bring an old database up to the current
 * column set on its own; this does, guarded by column presence rather than
 * try/catch (libsql errors are async, and swallowing them would hide real
 * failures).
 */
import type { Client } from "@libsql/client";
import { logger } from "../logging/logger.js";

const log = logger("state");

/**
 * Every column the old `migrate.ts` added by `ALTER TABLE ADD COLUMN`, in the
 * order it added them. A database created by the Drizzle baseline has them all
 * already and this whole step is a handful of `PRAGMA table_info` reads.
 */
const LEGACY_COLUMNS: Record<string, string[]> = {
  workflow_runs: [
    "triggered_by TEXT", // issue #205
    "trigger_actor_type TEXT", // issue #205
    "scratch TEXT",
    "restart_count INTEGER NOT NULL DEFAULT 0",
    "owner TEXT", // issue #205 — carries a data backfill, below
    "trace_id TEXT", // issue #255
    "span_id TEXT", // issue #255
  ],
  workflow_approvals: [
    "kind TEXT NOT NULL DEFAULT 'approve'",
    "artifact TEXT",
  ],
  executions: [
    "triggered_by TEXT", // issue #205
    "trigger_actor_type TEXT", // issue #205
    "owner TEXT", // issue #279
    "session_id TEXT",
    "cost_usd REAL",
    "input_tokens INTEGER",
    "cache_creation_input_tokens INTEGER",
    "cache_read_input_tokens INTEGER",
    "output_tokens INTEGER",
    "api_duration_ms INTEGER",
    "stop_reason TEXT",
    "workflow_run_id TEXT",
    "output_text TEXT",
    "extension_status TEXT",
    "skills_status TEXT",
  ],
};

async function tableColumns(client: Client, table: string): Promise<Set<string>> {
  const res = await client.execute(`PRAGMA table_info(${table})`);
  return new Set(res.rows.map((r) => String(r.name)));
}

export async function applyLegacySqliteCompat(client: Client): Promise<void> {
  for (const [table, defs] of Object.entries(LEGACY_COLUMNS)) {
    const cols = await tableColumns(client, table);
    // Table absent entirely — the baseline will create it complete.
    if (cols.size === 0) continue;
    for (const def of defs) {
      const name = def.split(" ")[0];
      if (cols.has(name)) continue;
      await client.execute(`ALTER TABLE ${table} ADD COLUMN ${def}`);
      log.info("legacy compat: added missing column", { table, column: name });
      if (table === "workflow_runs" && name === "owner") {
        // The one-time backfill that shipped alongside this column: the owner
        // used to live only inside the context JSON blob. `json_extract` is
        // sqlite-only, which is fine — this whole step is. Idempotent via the
        // IS NULL guard, and it only ever runs on the boot that adds the column.
        await client.execute(
          `UPDATE workflow_runs SET owner = json_extract(context, '$.owner')
            WHERE owner IS NULL AND context IS NOT NULL`,
        );
      }
    }
  }
  await rebuildMessagingIfLegacyUnique(client);
}

/**
 * One-shot rebuild for databases still carrying the unconditional
 * `UNIQUE(platform, channel_id, thread_id, user_id)` on `messaging_sessions`.
 *
 * That constraint broke get-or-create: a deactivated session still occupied the
 * key, so a returning user could never start a new one. The partial unique
 * index in the baseline (`WHERE active = 1`) is its replacement; this strips
 * the old constraint. Follows SQLite's official table-rebuild recipe — toggle
 * `foreign_keys` OFF *outside* the transaction, copy → drop → rename, then
 * `foreign_key_check` BEFORE COMMIT.
 *
 * TODO(remove after v0.12): ships in v0.11, needed for exactly one release after.
 */
async function rebuildMessagingIfLegacyUnique(client: Client): Promise<void> {
  const master = await client.execute(
    `SELECT sql FROM sqlite_master WHERE type='table' AND name='messaging_sessions'`,
  );
  const tableSql = String(master.rows[0]?.sql ?? "");
  if (!tableSql.includes("UNIQUE(platform")) return;

  log.info("legacy compat: rebuilding messaging_sessions without the table-level UNIQUE");

  // Pre-check: if existing data is already inconsistent, fail loud before modifying schema.
  // A direct INSERT INTO ... SELECT copy cannot introduce violations the source didn't have,
  // so this is equivalent to the in-transaction check the original code ran.
  const preCheck = await client.execute("PRAGMA foreign_key_check(messaging_sessions)");
  if (preCheck.rows.length > 0) {
    throw new Error(
      `FK check failed before messaging rebuild: ${JSON.stringify(preCheck.rows)}`,
    );
  }

  // client.migrate() executes all statements on a single pooled connection with
  // PRAGMA foreign_keys=OFF before a DEFERRED transaction and foreign_keys=ON
  // after commit. This is the correct replacement for the manual BEGIN/COMMIT
  // sequence, which broke in @libsql/client 0.18.0: execute() now
  // acquires-then-releases a connection per call, and release() rolls back any
  // open transaction, so BEGIN → execute(DDL…) → COMMIT always failed with
  // "cannot commit - no transaction is active".
  await client.migrate([
    `CREATE TABLE messaging_sessions__new (
        id TEXT PRIMARY KEY, platform TEXT NOT NULL, channel_id TEXT NOT NULL,
        thread_id TEXT, user_id TEXT NOT NULL, agent_session_id TEXT,
        created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL,
        message_count INTEGER DEFAULT 0, active INTEGER DEFAULT 1
      )`,
    `INSERT INTO messaging_sessions__new
        SELECT id, platform, channel_id, thread_id, user_id, agent_session_id,
               created_at, last_activity_at, message_count, active
        FROM messaging_sessions`,
    "DROP TABLE messaging_sessions",
    "ALTER TABLE messaging_sessions__new RENAME TO messaging_sessions",
    `CREATE INDEX IF NOT EXISTS idx_msg_sessions_lookup
        ON messaging_sessions(platform, channel_id, thread_id, user_id)`,
  ]);
  // The partial unique index is deliberately NOT recreated here — the baseline
  // migrator runs immediately after, same boot, before any writes.
}

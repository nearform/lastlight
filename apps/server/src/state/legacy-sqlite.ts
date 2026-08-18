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
  const fkRow = await client.execute("PRAGMA foreign_keys");
  const fkWasOn = Number(fkRow.rows[0]?.foreign_keys ?? 0) === 1;
  await client.execute("PRAGMA foreign_keys = OFF");
  try {
    // One execute() per statement — executeMultiple() force-rolls-back any open
    // transaction in its `finally`, so BEGIN → executeMultiple → COMMIT
    // silently undoes the rebuild and then throws "no transaction is active".
    // Boot would fail on exactly the legacy databases this exists for.
    await client.execute("BEGIN");
    try {
      await client.execute(`CREATE TABLE messaging_sessions__new (
        id TEXT PRIMARY KEY, platform TEXT NOT NULL, channel_id TEXT NOT NULL,
        thread_id TEXT, user_id TEXT NOT NULL, agent_session_id TEXT,
        created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL,
        message_count INTEGER DEFAULT 0, active INTEGER DEFAULT 1
      )`);
      await client.execute(`INSERT INTO messaging_sessions__new
        SELECT id, platform, channel_id, thread_id, user_id, agent_session_id,
               created_at, last_activity_at, message_count, active
        FROM messaging_sessions`);
      await client.execute("DROP TABLE messaging_sessions");
      await client.execute("ALTER TABLE messaging_sessions__new RENAME TO messaging_sessions");
      await client.execute(`CREATE INDEX IF NOT EXISTS idx_msg_sessions_lookup
        ON messaging_sessions(platform, channel_id, thread_id, user_id)`);
      // Belt-and-braces: if the copy missed rows the messages reference, fail
      // the migration loudly rather than commit a half-broken schema.
      const violations = await client.execute("PRAGMA foreign_key_check");
      if (violations.rows.length > 0) {
        throw new Error(
          `FK check failed after messaging rebuild: ${JSON.stringify(violations.rows)}`,
        );
      }
      await client.execute("COMMIT");
    } catch (err) {
      await client.execute("ROLLBACK").catch(() => {});
      throw err;
    }
  } finally {
    if (fkWasOn) await client.execute("PRAGMA foreign_keys = ON");
  }
  // The partial unique index is deliberately NOT recreated here — the baseline
  // migrator runs immediately after, same boot, before any writes.
}

/**
 * The proof that the Drizzle baseline is safe on the real production database.
 *
 * Production was migrated by the pre-Drizzle `src/state/migrate.ts` +
 * `SessionManager`'s inline DDL and has no `__drizzle_migrations` table. This
 * test reconstructs that exact shape from `fixtures/legacy-schema.sql` — a
 * mechanical dump taken on the commit that deleted both — then runs the real
 * boot path over it (`applyLegacySqliteCompat()` + the migrator) and asserts
 * every statement no-ops.
 *
 * Phase 1 could compare against the live legacy code, because both drivers
 * coexisted for one phase. They no longer do, so the fixture is how that proof
 * stays alive. Delete this only if production is known to be gone.
 */
import { describe, it, expect } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate as drizzleMigrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "url";
import { mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { applyLegacySqliteCompat } from "#src/state/legacy-sqlite.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle/sqlite", import.meta.url));
/**
 * Migrations in `drizzle/sqlite`: the baseline plus the #279 repo-ref backfill.
 * Bump it when one is added — deliberately not derived from the journal, so a
 * migration that fails to record itself shows up here as a diff rather than
 * agreeing with whatever happened.
 */
const MIGRATION_COUNT = 2;

const LEGACY_SCHEMA = readFileSync(
  fileURLToPath(new URL("./fixtures/legacy-schema.sql", import.meta.url)),
  "utf8",
);

/** The 15 tables both paths must produce, and nothing else. */
const EXPECTED_TABLES = [
  "cron_overrides",
  "cron_runs",
  "executions",
  "feedback_anchors",
  "feedback_signals",
  "github_team_members",
  "github_team_repos",
  "github_teams",
  "github_visibility_sync",
  "messaging_messages",
  "messaging_sessions",
  "users",
  "workflow_approvals",
  "workflow_overrides",
  "workflow_runs",
];

/**
 * The five indexes the Drizzle baseline has that the legacy DDL does not.
 *
 * NOT a divergence in what the database enforces — a divergence in how the same
 * rule is spelled. drizzle-kit renders both column-level `.unique()` and
 * table-level `unique().on(...)` as standalone `CREATE UNIQUE INDEX`; the
 * legacy DDL used inline `UNIQUE` constraints, which SQLite implements as
 * `sqlite_autoindex_*` entries whose `sql` is NULL and which are therefore
 * invisible to a `sqlite_master` comparison.
 *
 * `uniqueKeyTuples()` is the assertion that matters: it compares what is
 * ENFORCED, however spelled. Creating these five over production is safe by
 * construction — the inline constraint already guarantees no violating row, so
 * the index build cannot fail.
 */
const DRIZZLE_ONLY_UNIQUE_INDEXES = [
  "feedback_anchors_source_channel_external_id_unique",
  "feedback_signals_anchor_id_reactor_emoji_unique",
  "users_github_id_unique",
  "users_login_unique",
  "users_slack_user_id_unique",
];

type Row = Record<string, unknown>;
type Query = (sql: string) => Promise<Row[]>;

const queryOn = (client: Client): Query => async (sql) =>
  (await client.execute(sql)).rows as unknown as Row[];

function normalizeDefault(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value).trim();
  const bare = text.toLowerCase();
  if (bare === "true") return "1";
  if (bare === "false") return "0";
  if (bare === "null" || bare === "current_timestamp") return bare;
  return text;
}

/**
 * Compare index DDL by meaning, not formatting: drizzle-kit quotes identifiers
 * with backticks and pads its parens, the legacy DDL does neither. Whitespace
 * next to `(`, `)` and `,` is stripped, not merely collapsed.
 */
function normalizeIndexSql(sql: string): string {
  return sql
    .toLowerCase()
    .replace(/[`"[\]]/g, "")
    .replace(/\s+/g, " ")
    .replace(/if not exists /g, "")
    .replace(/\s*([(),])\s*/g, "$1")
    .trim();
}

async function tables(q: Query): Promise<string[]> {
  const rows = await q(
    `SELECT name FROM sqlite_master
      WHERE type = 'table'
        AND name NOT LIKE 'sqlite_%'
        AND name != '__drizzle_migrations'
      ORDER BY name`,
  );
  return rows.map((r) => String(r.name));
}

async function columns(q: Query, table: string) {
  const rows = await q(`PRAGMA table_info(${table})`);
  return rows.map((r) => ({
    name: String(r.name),
    type: String(r.type).toUpperCase(),
    // `id TEXT PRIMARY KEY` reports notnull=0 (SQLite's nullable-PK quirk)
    // while drizzle emits `PRIMARY KEY NOT NULL`. A tightening we accept.
    notNull: r.notnull === 1 || Number(r.pk) > 0,
    dflt: normalizeDefault(r.dflt_value),
    pk: Number(r.pk) > 0,
  }));
}

/** Columns keyed by NAME — physical order is not a correctness property. */
async function columnsByName(q: Query, table: string) {
  const out: Record<string, unknown> = {};
  for (const col of await columns(q, table)) out[col.name] = col;
  return out;
}

/** PK columns in KEY order — the three `github_*` tables have composite PKs. */
async function pkColumns(q: Query, table: string): Promise<string[]> {
  const rows = await q(`PRAGMA table_info(${table})`);
  return rows
    .filter((r) => Number(r.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((r) => String(r.name));
}

async function namedIndexes(q: Query): Promise<Record<string, string>> {
  const rows = await q(
    `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL`,
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[String(r.name)] = normalizeIndexSql(String(r.sql));
  return out;
}

/**
 * Every uniqueness rule the database actually enforces, as
 * `table:col,col[:partial]` — whether spelled as an inline constraint (legacy)
 * or a standalone unique index (drizzle).
 */
async function uniqueKeyTuples(q: Query, tableNames: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const table of tableNames) {
    for (const idx of await q(`PRAGMA index_list(${table})`)) {
      if (Number(idx.unique) !== 1) continue;
      const cols = await q(`PRAGMA index_info(${String(idx.name)})`);
      const names = cols
        .sort((a, b) => Number(a.seqno) - Number(b.seqno))
        .map((c) => String(c.name));
      out.push(`${table}:${names.join(",")}${Number(idx.partial) === 1 ? ":partial" : ""}`);
    }
  }
  return out.sort();
}

async function foreignKeys(q: Query, tableNames: string[]): Promise<string[]> {
  const out: string[] = [];
  for (const table of tableNames) {
    for (const fk of await q(`PRAGMA foreign_key_list(${table})`)) {
      out.push(
        `${table}.${String(fk.from)} -> ${String(fk.table)}.${String(fk.to)} ` +
          `[update=${String(fk.on_update)} delete=${String(fk.on_delete)}]`,
      );
    }
  }
  return out.sort();
}

async function extract(q: Query) {
  const tableNames = await tables(q);
  const cols: Record<string, unknown> = {};
  const pks: Record<string, string[]> = {};
  for (const table of tableNames) {
    cols[table] = await columnsByName(q, table);
    pks[table] = await pkColumns(q, table);
  }
  return {
    tables: tableNames,
    columns: cols,
    pks,
    indexes: await namedIndexes(q),
    uniques: await uniqueKeyTuples(q, tableNames),
    fks: await foreignKeys(q, tableNames),
  };
}

/** A database in the pre-Drizzle production shape. */
async function legacyShapedDb(url: string): Promise<Client> {
  const client = createClient({ url });
  // executeMultiple is safe here: its force-rollback-in-finally hazard only
  // bites after an explicit BEGIN, and there is none.
  await client.executeMultiple(LEGACY_SCHEMA);
  return client;
}

/** The real boot path: compat pre-step, then the migrator. */
async function bootStateLayer(client: Client): Promise<void> {
  await applyLegacySqliteCompat(client);
  await drizzleMigrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
}

describe("the Drizzle baseline over a legacy (production-shaped) database", () => {
  it("no-ops: the schema is unchanged and the journal records one migration", async () => {
    const client = await legacyShapedDb(":memory:");
    try {
      const q = queryOn(client);
      const before = await extract(q);
      expect(before.tables).toEqual(EXPECTED_TABLES);
      expect(Object.keys(before.indexes)).toHaveLength(25);

      await bootStateLayer(client);

      const after = await extract(q);
      expect(after.tables).toEqual(EXPECTED_TABLES);
      expect(after.columns).toEqual(before.columns);
      expect(after.pks).toEqual(before.pks);
      expect(after.fks).toEqual(before.fks);
      expect(after.fks).toEqual([
        "messaging_messages.session_id -> messaging_sessions.id [update=NO ACTION delete=NO ACTION]",
      ]);

      // Every legacy index survives byte-identical; the only additions are the
      // five redundant unique indexes, whose rules were already enforced.
      for (const name of Object.keys(before.indexes)) {
        expect(after.indexes[name]).toBe(before.indexes[name]);
      }
      const added = Object.keys(after.indexes).filter((n) => !(n in before.indexes));
      expect(added.sort()).toEqual(DRIZZLE_ONLY_UNIQUE_INDEXES);

      // The SET of enforced rules is unchanged; the multiset is not — those
      // five tuples are now doubly indexed. That is the whole cost.
      expect([...new Set(after.uniques)].sort()).toEqual([...new Set(before.uniques)].sort());
      const duplicated = after.uniques.filter((t, i) => after.uniques.indexOf(t) !== i);
      expect(duplicated.sort()).toEqual([
        "feedback_anchors:source,channel,external_id",
        "feedback_signals:anchor_id,reactor,emoji",
        "users:github_id",
        "users:login",
        "users:slack_user_id",
      ]);

      const journal = await client.execute(
        "SELECT count(*) AS n FROM __drizzle_migrations",
      );
      expect(Number(journal.rows[0].n)).toBe(MIGRATION_COUNT);
    } finally {
      client.close();
    }
  });

  it("preserves existing rows and stays idempotent across a second boot", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lastlight-schema-eq-"));
    const path = join(dir, "legacy.db");
    let client: Client | undefined;
    try {
      client = await legacyShapedDb(`file:${path}`);
      await client.execute(
        `INSERT INTO executions (id, trigger_type, trigger_id, skill, started_at, success)
         VALUES ('exec-1', 'issue_comment', 'acme/widgets#7', 'triage', '2026-08-18T09:00:00Z', 1)`,
      );
      await client.execute(
        `INSERT INTO messaging_sessions
           (id, platform, channel_id, user_id, created_at, last_activity_at)
         VALUES ('sess-1', 'slack', 'C123', 'U456', '2026-08-18T09:00:00Z', '2026-08-18T09:00:00Z')`,
      );

      await bootStateLayer(client);
      const firstBoot = await extract(queryOn(client));

      // Booting twice is the thing an operator actually does. Both the compat
      // pre-step and the migrator must be no-ops the second time.
      await bootStateLayer(client);
      expect(await extract(queryOn(client))).toEqual(firstBoot);

      const exec = await client.execute("SELECT id, success FROM executions");
      expect(exec.rows).toHaveLength(1);
      expect(exec.rows[0].id).toBe("exec-1");
      expect(Number(exec.rows[0].success)).toBe(1);
      const sess = await client.execute("SELECT id FROM messaging_sessions");
      expect(sess.rows.map((r) => r.id)).toEqual(["sess-1"]);

      // Both migrations recorded exactly once: the baseline, and the #279
      // repo-ref backfill. The second boot above must not re-apply either.
      const journal = await client.execute(
        "SELECT count(*) AS n FROM __drizzle_migrations",
      );
      expect(Number(journal.rows[0].n)).toBe(MIGRATION_COUNT);

      const integrity = await client.execute("PRAGMA integrity_check");
      expect(String(integrity.rows[0].integrity_check)).toBe("ok");
    } finally {
      client?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("the legacy compat pre-step", () => {
  /**
   * A database older than the current column set — the case the baseline alone
   * cannot fix, because `CREATE TABLE IF NOT EXISTS` no-ops on a table that
   * exists but is missing columns a later release added by ALTER.
   */
  const ANCIENT_DDL = `
    CREATE TABLE workflow_runs (
      id TEXT PRIMARY KEY,
      workflow_name TEXT NOT NULL,
      trigger_id TEXT NOT NULL,
      repo TEXT,
      issue_number INTEGER,
      current_phase TEXT NOT NULL,
      phase_history TEXT NOT NULL DEFAULT '[]',
      status TEXT NOT NULL DEFAULT 'running',
      context TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      finished_at TEXT
    );
  `;

  it("adds every missing ALTER-era column and backfills owner from the context blob", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      await client.executeMultiple(ANCIENT_DDL);
      await client.execute(
        `INSERT INTO workflow_runs
           (id, workflow_name, trigger_id, repo, current_phase, started_at, updated_at, context)
         VALUES ('run-1', 'build', 'acme/widgets#1', 'widgets', 'architect',
                 '2026-08-18T09:00:00Z', '2026-08-18T09:00:00Z', '{"owner":"acme"}')`,
      );

      await applyLegacySqliteCompat(client);

      const cols = await columnsByName(queryOn(client), "workflow_runs");
      for (const added of [
        "triggered_by",
        "trigger_actor_type",
        "scratch",
        "restart_count",
        "owner",
        "trace_id",
        "span_id",
      ]) {
        expect(cols).toHaveProperty(added);
      }

      // The one-time data backfill that shipped with the `owner` column: it
      // used to live only inside the context JSON blob.
      const run = await client.execute("SELECT owner FROM workflow_runs WHERE id = 'run-1'");
      expect(run.rows[0].owner).toBe("acme");

      // Idempotent: a second pass must not throw or re-backfill.
      await applyLegacySqliteCompat(client);
      const again = await client.execute("SELECT owner FROM workflow_runs WHERE id = 'run-1'");
      expect(again.rows[0].owner).toBe("acme");
    } finally {
      client.close();
    }
  });

  it("rebuilds messaging_sessions when the legacy table-level UNIQUE is present", async () => {
    const client = createClient({ url: ":memory:" });
    try {
      // The constraint that broke get-or-create: a deactivated session still
      // occupied the key, so a returning user could never start a new one.
      await client.executeMultiple(`
        CREATE TABLE messaging_sessions (
          id TEXT PRIMARY KEY, platform TEXT NOT NULL, channel_id TEXT NOT NULL,
          thread_id TEXT, user_id TEXT NOT NULL, agent_session_id TEXT,
          created_at TEXT NOT NULL, last_activity_at TEXT NOT NULL,
          message_count INTEGER DEFAULT 0, active INTEGER DEFAULT 1,
          UNIQUE(platform, channel_id, thread_id, user_id)
        );
        CREATE TABLE messaging_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id TEXT NOT NULL REFERENCES messaging_sessions(id),
          role TEXT NOT NULL, content TEXT NOT NULL, timestamp TEXT NOT NULL,
          platform_message_id TEXT
        );
        INSERT INTO messaging_sessions
          (id, platform, channel_id, user_id, created_at, last_activity_at, active)
          VALUES ('old', 'slack', 'C1', 'U1', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 0);
        INSERT INTO messaging_messages (session_id, role, content, timestamp)
          VALUES ('old', 'user', 'hello', '2026-01-01T00:00:00Z');
      `);

      await applyLegacySqliteCompat(client);

      // The constraint is gone…
      const master = await client.execute(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='messaging_sessions'`,
      );
      expect(String(master.rows[0].sql)).not.toContain("UNIQUE(platform");

      // …the rows survived the rebuild, messages included (the FK to the
      // dropped table is why this needs the pragma dance at all)…
      const kept = await client.execute("SELECT id, active FROM messaging_sessions");
      expect(kept.rows.map((r) => r.id)).toEqual(["old"]);
      const msgs = await client.execute("SELECT session_id FROM messaging_messages");
      expect(msgs.rows.map((r) => r.session_id)).toEqual(["old"]);

      // …and the key the deactivated row used to occupy is now free.
      await client.execute(
        `INSERT INTO messaging_sessions
           (id, platform, channel_id, user_id, created_at, last_activity_at, active)
         VALUES ('new', 'slack', 'C1', 'U1', '2026-02-01T00:00:00Z', '2026-02-01T00:00:00Z', 1)`,
      );
      const both = await client.execute("SELECT id FROM messaging_sessions ORDER BY id");
      expect(both.rows.map((r) => r.id)).toEqual(["new", "old"]);
    } finally {
      client.close();
    }
  });
});

/**
 * The proof artifact for the Drizzle migration's Phase 1.
 *
 * This is the only window in which both drivers coexist with the legacy DDL
 * still live, so this test is what makes the Phase 2 engine swap safe: it
 * asserts, mechanically, that the schema `drizzle/sqlite/0000_baseline.sql`
 * produces is equivalent to the one `src/state/migrate.ts` + `SessionManager`
 * produce today — and that the baseline is a strict no-op over a
 * production-shaped database with rows already in it.
 *
 * Delete it only when `migrate.ts` itself is deleted.
 */
import { describe, it, expect } from "vitest";
import Database from "better-sqlite3";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate as drizzleMigrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "url";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { migrate as legacyMigrate } from "#src/state/migrate.js";
import { SessionManager } from "#src/connectors/messaging/session-manager.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle/sqlite", import.meta.url));

/** The 15 tables the two legs must both produce, and nothing else. */
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
 * The five indexes the drizzle leg has and the legacy leg does not.
 *
 * NOT a divergence in what the database enforces — it is a divergence in how
 * the same rule is spelled. drizzle-kit renders both column-level `.unique()`
 * and table-level `unique().on(...)` as standalone `CREATE UNIQUE INDEX`
 * statements; the legacy DDL used inline `UNIQUE` constraints, which SQLite
 * implements as `sqlite_autoindex_*` entries whose `sql` is NULL and which are
 * therefore invisible to a `sqlite_master` comparison.
 *
 * `uniqueKeyTuples()` below is the assertion that actually matters: it compares
 * what is enforced (the unique column tuples, however expressed) and must match
 * exactly on both legs. This list only explains the name-level difference.
 *
 * Consequence for production: the baseline creates five redundant unique
 * indexes over a DB that already has the equivalent inline constraints. Safe by
 * construction — the constraint guarantees no violating row exists, so the
 * index build cannot fail.
 */
const DRIZZLE_ONLY_UNIQUE_INDEXES = [
  "feedback_anchors_source_channel_external_id_unique",
  "feedback_signals_anchor_id_reactor_emoji_unique",
  "users_github_id_unique",
  "users_login_unique",
  "users_slack_user_id_unique",
];

type Row = Record<string, unknown>;
/** Uniform async query surface over the two drivers (libsql is async-only). */
type Query = (sql: string) => Promise<Row[]>;

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
 * Compare index DDL by meaning, not by formatting: drizzle-kit quotes
 * identifiers with backticks and pads its parens, the legacy DDL does neither.
 * Whitespace adjacent to `(`, `)` and `,` is therefore stripped, not merely
 * collapsed.
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

/** Columns in cid order — the shape a fresh DB of either leg must agree on. */
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

/** Same columns, keyed by name — for the leg where cid order legitimately differs. */
async function columnsByName(q: Query, table: string) {
  const out: Record<string, unknown> = {};
  for (const col of await columns(q, table)) out[col.name] = col;
  return out;
}

/**
 * PK columns in KEY order, not a boolean flag — the three `github_*` tables
 * have composite PKs, and a flag would pass while the key order diverged.
 */
async function pkColumns(q: Query, table: string): Promise<string[]> {
  const rows = await q(`PRAGMA table_info(${table})`);
  return rows
    .filter((r) => Number(r.pk) > 0)
    .sort((a, b) => Number(a.pk) - Number(b.pk))
    .map((r) => String(r.name));
}

async function namedIndexes(q: Query): Promise<Record<string, string>> {
  // Autoindexes (PK + inline UNIQUE) have NULL sql and drop out on both legs.
  const rows = await q(
    `SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'index' AND sql IS NOT NULL`,
  );
  const out: Record<string, string> = {};
  for (const r of rows) out[String(r.name)] = normalizeIndexSql(String(r.sql));
  return out;
}

/**
 * Every uniqueness rule the database actually enforces, as
 * `table:col,col[:partial]` — regardless of whether it is spelled as an inline
 * constraint (legacy) or a standalone unique index (drizzle).
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
    cols[table] = await columns(q, table);
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

/** Leg A — the legacy DDL: `migrate()` plus SessionManager's second schema owner. */
function legacyLeg(path = ":memory:") {
  const db = new Database(path);
  legacyMigrate(db);
  new SessionManager(db);
  const q: Query = async (sql) => db.prepare(sql).all() as Row[];
  return { db, q };
}

/** Leg B — the Drizzle baseline applied by the real runtime migrator. */
async function drizzleLeg(url = ":memory:") {
  const client = createClient({ url });
  await drizzleMigrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
  const q: Query = async (sql) => (await client.execute(sql)).rows as unknown as Row[];
  return { client, q };
}

describe("drizzle baseline is equivalent to the legacy DDL", () => {
  it("produces the same 15 tables, columns, indexes, keys and FKs on a fresh DB", async () => {
    const legacy = legacyLeg();
    const { client, q: drizzleQ } = await drizzleLeg();
    try {
      const a = await extract(legacy.q);
      const b = await extract(drizzleQ);

      expect(a.tables).toEqual(EXPECTED_TABLES);
      expect(b.tables).toEqual(EXPECTED_TABLES);

      // Column shape AND cid order — both legs are fresh, so order is
      // comparable here (it is not on the production-shaped leg below).
      expect(b.columns).toEqual(a.columns);
      expect(b.pks).toEqual(a.pks);

      // What is enforced, however it is spelled.
      expect(b.uniques).toEqual(a.uniques);

      // The one declared FK in the whole schema.
      expect(a.fks).toEqual([
        "messaging_messages.session_id -> messaging_sessions.id [update=NO ACTION delete=NO ACTION]",
      ]);
      expect(b.fks).toEqual(a.fks);

      // Named indexes, sql compared verbatim after normalization — this is
      // what pins the five DESC keys and the partial index's WHERE clause.
      const extras = Object.keys(b.indexes).filter((n) => !(n in a.indexes));
      expect(extras.sort()).toEqual(DRIZZLE_ONLY_UNIQUE_INDEXES);
      for (const name of extras) delete b.indexes[name];
      expect(Object.keys(b.indexes).sort()).toEqual(Object.keys(a.indexes).sort());
      expect(b.indexes).toEqual(a.indexes);
      expect(Object.keys(a.indexes)).toHaveLength(25);
    } finally {
      legacy.db.close();
      client.close();
    }
  });

  it("carries DESC keys and the partial unique index through generation", async () => {
    const { client, q } = await drizzleLeg();
    try {
      const idx = await namedIndexes(q);
      // sqlite-core has no `.desc()` on index columns, so these come from the
      // `sql` expression form — a silent drop would be a full-table sort on
      // the dashboard's 5s poll.
      expect(idx.idx_workflow_runs_started_at).toContain("started_at desc");
      expect(idx.idx_workflow_runs_name_started).toContain("workflow_name,started_at desc");
      expect(idx.idx_cron_runs_name_started).toContain("cron_name,started_at desc");
      expect(idx.idx_feedback_signals_observed).toContain("observed_at desc");
      expect(idx.idx_feedback_signals_workflow).toContain("workflow_name,observed_at desc");
      expect(idx.idx_msg_sessions_unique_active).toContain("where active = 1");
    } finally {
      client.close();
    }
  });

  it("is a no-op when the migrator runs a second time", async () => {
    const { client, q } = await drizzleLeg();
    try {
      const before = await extract(q);
      await drizzleMigrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
      expect(await extract(q)).toEqual(before);

      const journal = await client.execute("SELECT count(*) AS n FROM __drizzle_migrations");
      expect(Number(journal.rows[0].n)).toBe(1);
    } finally {
      client.close();
    }
  });
});

describe("drizzle baseline over a production-shaped database", () => {
  it("applies as a no-op, preserves rows, and records the journal", async () => {
    const dir = mkdtempSync(join(tmpdir(), "lastlight-schema-eq-"));
    const path = join(dir, "legacy.db");
    let client: Client | undefined;
    try {
      // Build the legacy shape on disk and seed it, exactly as prod is.
      const legacy = legacyLeg(path);
      legacy.db
        .prepare(
          `INSERT INTO executions (id, trigger_type, trigger_id, skill, started_at, success)
           VALUES ('exec-1', 'issue_comment', 'acme/widgets#7', 'triage', '2026-08-18T09:00:00Z', 1)`,
        )
        .run();
      legacy.db
        .prepare(
          `INSERT INTO messaging_sessions
             (id, platform, channel_id, user_id, created_at, last_activity_at)
           VALUES ('sess-1', 'slack', 'C123', 'U456', '2026-08-18T09:00:00Z', '2026-08-18T09:00:00Z')`,
        )
        .run();
      const legacySchema = await extract(legacy.q);
      const legacyColumns: Record<string, unknown> = {};
      for (const table of EXPECTED_TABLES) {
        legacyColumns[table] = await columnsByName(legacy.q, table);
      }
      legacy.db.close();

      client = createClient({ url: `file:${path}` });
      const q: Query = async (sql) => (await client!.execute(sql)).rows as unknown as Row[];
      await drizzleMigrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });

      // The seeded rows survive.
      const exec = await client.execute("SELECT id, success FROM executions");
      expect(exec.rows).toHaveLength(1);
      expect(exec.rows[0].id).toBe("exec-1");
      expect(Number(exec.rows[0].success)).toBe(1);
      const sess = await client.execute("SELECT id FROM messaging_sessions");
      expect(sess.rows.map((r) => r.id)).toEqual(["sess-1"]);

      const journal = await client.execute("SELECT count(*) AS n FROM __drizzle_migrations");
      expect(Number(journal.rows[0].n)).toBe(1);

      // Compare columns BY NAME, never by cid position. A real production DB
      // reached its shape through ALTERs whose order no schema file can
      // reproduce — `owner` is in both a CREATE body and an ALTER, so it sits
      // mid-table on a fresh DB and at the tail on an upgraded one. Asserting
      // positions here would fail against the very shape this test protects.
      const after = await extract(q);
      expect(after.tables).toEqual(EXPECTED_TABLES);
      for (const table of EXPECTED_TABLES) {
        expect(await columnsByName(q, table)).toEqual(legacyColumns[table]);
      }
      expect(after.pks).toEqual(legacySchema.pks);
      expect(after.fks).toEqual(legacySchema.fks);

      // The baseline adds its five redundant unique indexes here too, and
      // nothing else: every other statement found its object already present.
      const added = Object.keys(after.indexes).filter((n) => !(n in legacySchema.indexes));
      expect(added.sort()).toEqual(DRIZZLE_ONLY_UNIQUE_INDEXES);
      for (const name of Object.keys(legacySchema.indexes)) {
        expect(after.indexes[name]).toBe(legacySchema.indexes[name]);
      }
      // The SET of enforced rules is unchanged. The multiset is not: each of
      // the five redundant indexes now enforces a rule the legacy inline
      // constraint already enforced, so those five tuples appear twice. That
      // is the cost of the divergence — a duplicate index, never a changed
      // rule — and pinning it here is what proves it stays only that.
      expect([...new Set(after.uniques)].sort()).toEqual([...new Set(legacySchema.uniques)].sort());
      const duplicated = after.uniques.filter(
        (tuple, i) => after.uniques.indexOf(tuple) !== i,
      );
      expect(duplicated.sort()).toEqual([
        "feedback_anchors:source,channel,external_id",
        "feedback_signals:anchor_id,reactor,emoji",
        "users:github_id",
        "users:login",
        "users:slack_user_id",
      ]);
    } finally {
      client?.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

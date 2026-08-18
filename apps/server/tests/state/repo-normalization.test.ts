import { describe, it, expect } from "vitest";
import { createClient, type Client } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate as drizzleMigrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "url";
import { readFileSync } from "fs";
import { applyLegacySqliteCompat } from "#src/state/legacy-sqlite.js";

/**
 * The #279 backfill: converge both repo-bearing tables on (owner, BARE repo).
 *
 * Rows are inserted with raw SQL on purpose — the stores now normalize at their
 * write choke points, so going through them would seed the shape we are trying
 * to prove the migration fixes.
 *
 * The old `migrate()` carried this as a per-boot statement; the Drizzle port
 * moves it into a journaled one-shot migration (README locked decision 14), so
 * the subject under test is now the real boot path — the legacy compat pre-step
 * followed by the migrator — run over a production-shaped database.
 */
const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../drizzle/sqlite", import.meta.url));
const LEGACY_SCHEMA = readFileSync(
  fileURLToPath(new URL("./fixtures/legacy-schema.sql", import.meta.url)),
  "utf8",
);

/** The real boot path over an existing database: compat pre-step, then migrator. */
async function migrateDb(client: Client): Promise<void> {
  await applyLegacySqliteCompat(client);
  await drizzleMigrate(drizzle(client), { migrationsFolder: MIGRATIONS_FOLDER });
}

describe("the repo-normalization backfill (issue #279)", () => {
  async function seed(): Promise<Client> {
    const raw = createClient({ url: ":memory:" });
    // executeMultiple is safe outside an explicit BEGIN — see legacy-sqlite.ts.
    await raw.executeMultiple(LEGACY_SCHEMA);

    const run = (id: string, triggerId: string, owner: string | null, repo: string) =>
      raw.execute({
        sql: `INSERT INTO workflow_runs (id, workflow_name, trigger_id, owner, repo, current_phase, status, started_at, updated_at)
              VALUES (?, 'build', ?, ?, ?, 'phase_0', 'succeeded', '2026-01-01', '2026-01-01')`,
        args: [id, triggerId, owner, repo],
      });
    // Legacy: the qualified string in `repo`, no owner column value.
    await run("r-legacy", "nearform/lastlight#1", null, "nearform/lastlight");
    // Legacy + an owner that was already backfilled from context.owner.
    await run("r-both", "nearform/lastlight#2", "nearform", "nearform/lastlight");
    // Already the stored shape.
    await run("r-modern", "nearform/lastlight#3", "nearform", "lastlight");
    // Bare repo, no owner column, no qualified string — but the trigger id
    // still names the account. This is the whole pre-owner-column population
    // on the drizby instance (8 rows).
    await run("r-from-trigger", "cliftonc/lastlight#19", null, "lastlight");
    // Genuinely un-backfillable: nothing anywhere records the account.
    await run("r-orphan", "42", null, "lastlight");
    // Slack-originated: the trigger id carries no repo to read.
    await run("r-slack", "slack:T1:C1:1.0", null, "lastlight");

    const exec = (
      id: string,
      triggerId: string,
      skill: string,
      repo: string | null,
      workflowRunId: string | null,
    ) =>
      raw.execute({
        sql: `INSERT INTO executions (id, trigger_type, trigger_id, skill, owner, repo, started_at, workflow_run_id)
              VALUES (?, 'webhook', ?, ?, NULL, ?, '2026-01-01', ?)`,
        args: [id, triggerId, skill, repo, workflowRunId],
      });
    // Dispatcher-written build-cycle row: qualified repo, no owning run.
    await exec("e-qualified", "3", "build-cycle", "nearform/lastlight", null);
    // Phase row: bare repo, owner recoverable from the owning run.
    await exec("e-phase", "nearform/lastlight#3", "build:architect", "lastlight", "r-modern");
    // Phase row whose run is itself legacy — depends on workflow_runs going first.
    await exec("e-legacy-run", "nearform/lastlight#1", "build:architect", "lastlight", "r-legacy");
    // Un-backfillable: bare repo, no run, no account.
    await exec("e-orphan", "42", "build:architect", "lastlight", null);
    // Chat turn: no repo at all.
    await exec("e-chat", "slack:T1:C1:1.0", "chat", null, null);

    return raw;
  }

  async function runs(db: Client) {
    const res = await db.execute(`SELECT id, owner, repo FROM workflow_runs ORDER BY id`);
    return Object.fromEntries(res.rows.map((r) => [String(r.id), [r.owner, r.repo]]));
  }

  async function execs(db: Client) {
    const res = await db.execute(`SELECT id, owner, repo FROM executions ORDER BY id`);
    return Object.fromEntries(res.rows.map((r) => [String(r.id), [r.owner, r.repo]]));
  }

  it("splits legacy qualified rows and rescues the account first", async () => {
    const db = await seed();
    await migrateDb(db);

    expect(await runs(db)).toEqual({
      "r-legacy": ["nearform", "lastlight"],
      // An owner already on the row wins; only `repo` is de-qualified.
      "r-both": ["nearform", "lastlight"],
      "r-modern": ["nearform", "lastlight"],
      // Last resort: the trigger id, which is built from the same pair at
      // dispatch and which the resume paths already prefer over the columns.
      "r-from-trigger": ["cliftonc", "lastlight"],
      // Nothing on these rows records the account. Left alone rather than
      // guessed — a filter reads a null owner as "always visible".
      "r-orphan": [null, "lastlight"],
      "r-slack": [null, "lastlight"],
    });

    expect(await execs(db)).toEqual({
      // Owner off the qualified string it already carried.
      "e-qualified": ["nearform", "lastlight"],
      // Owner off the owning run.
      "e-phase": ["nearform", "lastlight"],
      // …including a run that only just got its own owner in this same pass,
      // which is why workflow_runs is normalized first.
      "e-legacy-run": ["nearform", "lastlight"],
      "e-orphan": [null, "lastlight"],
      "e-chat": [null, null],
    });

    db.close();
  });

  // Note: the backfill is journaled now, so passes 2 and 3 are no-ops by
  // construction rather than by the statements being individually re-runnable.
  // The assertion is unchanged — "a second and third boot moves nothing" is
  // still exactly what an operator needs to be true.
  it("is idempotent — a second and third pass move nothing", async () => {
    const db = await seed();
    await migrateDb(db);
    const afterFirst = { runs: await runs(db), execs: await execs(db) };

    await migrateDb(db);
    await migrateDb(db);

    expect({ runs: await runs(db), execs: await execs(db) }).toEqual(afterFirst);
    db.close();
  });

  it("adds executions.owner to a DB that predates the column", async () => {
    const db = await seed();
    await db.execute(`ALTER TABLE executions DROP COLUMN owner`);
    await expect(db.execute(`SELECT owner FROM executions`)).rejects.toThrow();

    await migrateDb(db);

    expect((await execs(db))["e-phase"]).toEqual(["nearform", "lastlight"]);
    db.close();
  });

  it("leaves no slash behind in either table", async () => {
    const db = await seed();
    await migrateDb(db);

    const stray = await db.execute(
      `SELECT COUNT(*) AS c FROM (
         SELECT repo FROM workflow_runs WHERE instr(repo, '/') > 0
         UNION ALL
         SELECT repo FROM executions WHERE instr(repo, '/') > 0
       )`,
    );
    expect(Number(stray.rows[0].c)).toBe(0);
    db.close();
  });
});

/**
 * `migrate()` is gone; the pre-Drizzle ALTER-era columns (and the one data
 * backfill that shipped with `workflow_runs.owner`) now live in
 * `applyLegacySqliteCompat`, which runs against the raw libsql handle before
 * the migrator. Same assertion, new home — moved here from
 * `tests/state/workflow-run-store.test.ts` in Phase 3, since it drives the
 * sqlite-only compat pre-step rather than any store.
 *
 * `:memory:` is safe HERE only because nothing in this test transacts —
 * the compat step's messaging rebuild is skipped when the table is absent.
 */
describe("the boot compat step's owner backfill", () => {
  const PRE_OWNER_DDL = `
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

  it("backfills owner from context.owner for pre-migration rows", async () => {
    // Simulate an old DB: a row whose owner lives only in the context JSON.
    const raw = createClient({ url: ":memory:" });
    await raw.executeMultiple(PRE_OWNER_DDL);
    await raw.execute({
      sql: `INSERT INTO workflow_runs (id, workflow_name, trigger_id, repo, current_phase, status, context, started_at, updated_at)
         VALUES ('r1', 'build', 'nearform/lastlight#1', 'lastlight', 'phase_0', 'succeeded', ?, '2026-01-01', '2026-01-01')`,
      args: [JSON.stringify({ owner: "nearform" })],
    });

    // The boot compat step adds the column and backfills from context.owner.
    await applyLegacySqliteCompat(raw);
    const res = await raw.execute(`SELECT owner FROM workflow_runs WHERE id = 'r1'`);
    expect(res.rows[0].owner).toBe("nearform");
    raw.close();
  });
});

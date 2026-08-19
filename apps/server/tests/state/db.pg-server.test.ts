/**
 * The real-Postgres leg — the whole state suite over node-postgres, a TCP
 * connection pool and a real server.
 *
 * PGlite (`db.pg.test.ts`) proves the **dialect**: it is real Postgres compiled
 * to WASM, so a query that is wrong there is wrong everywhere. What it cannot
 * prove is the **driver**, and the gap is not theoretical:
 *
 * - PGlite parses int8 to a number by default; node-postgres hands `COUNT(*)`
 *   and `SUM(<integer>)` back as STRINGS unless `setTypeParser(20, …)` ran.
 *   Every stats rollup would concatenate instead of adding, silently.
 * - PGlite is single-connection, so it cannot exercise the connection pool the
 *   nine transaction sites and the op serializer actually run over.
 * - `changes()` reads `.rowCount` and `isUniqueViolation()` reads SQLSTATE
 *   23505 off a node-postgres error shape neither PGlite nor libsql produces.
 *
 * **Opt-in.** Needs a Postgres server, so it skips cleanly unless
 * `PG_INTEGRATION=1`, keeping `pnpm --filter lastlight-core test` hermetic for
 * contributors and for CI's default job. Point it somewhere with
 * `PG_TEST_URL` / `DATABASE_URL`:
 *
 * ```bash
 * docker run -d --name pg-test -e POSTGRES_PASSWORD=postgres -p 5432:5432 postgres:16
 * PG_INTEGRATION=1 PG_TEST_URL=postgres://postgres:postgres@localhost:5432/postgres \
 *   pnpm --filter lastlight-core exec vitest run tests/state/db.pg-server.test.ts
 * ```
 *
 * Every assertion body is shared verbatim with the sqlite and PGlite legs
 * (`store-suite.ts`) — loosening one to make this file green weakens all three.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// Same mock the other two runners carry. `vi.mock` is hoisted per test FILE and
// does nothing from an imported suite module.
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

import { migrate } from "drizzle-orm/node-postgres/migrator";
import { sql } from "drizzle-orm";
// Raw SQL goes through the dialect seam, not `client.execute` — `StateClient`
// is typed as the libsql instance (`.run`/`.all`), and reaching around it is
// exactly the portability bug `dialect.ts` exists to prevent.
import { rows, run } from "#src/state/dialect.js";
import { fileURLToPath } from "node:url";
import { StateDb } from "#src/state/db.js";
import { makePgClient } from "#src/state/pg-client.js";
import type { StateClient } from "#src/state/client.js";
import { runStateDbSuite } from "./store-suite.js";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle/pg", import.meta.url));

const enabled = process.env.PG_INTEGRATION === "1";
const BASE_URL =
  process.env.PG_TEST_URL?.trim() ||
  process.env.DATABASE_URL?.trim() ||
  "postgres://postgres:postgres@localhost:5432/postgres";

/** `BASE_URL` with its database name swapped — everything else (auth, params) kept. */
function urlForDatabase(name: string): string {
  return BASE_URL.replace(/\/[^/?]*(\?|$)/, `/${name}$1`);
}

/**
 * One fresh DATABASE per test, cloned from a migrated TEMPLATE.
 *
 * **Not a fresh schema**, which is the obvious cheaper move and is what the
 * phase doc suggested. It does not work: drizzle-kit hardcodes `public` into
 * the one foreign key in the schema —
 * `REFERENCES "public"."messaging_sessions"("id")` — so tables created under a
 * `search_path`-redirected schema get an FK pointing at a table in `public`
 * instead of at their own. On a database where `public` happens to be
 * populated (a laptop that ran a smoke test earlier) that SILENTLY SUCCEEDS
 * and wires every test's FK to the wrong table; on a clean one it fails 185
 * tests with `relation "public.messaging_sessions" does not exist`. The second
 * is how CI found it.
 *
 * `CREATE DATABASE … TEMPLATE` is a file-level copy, so it costs about what a
 * migrator pass did while giving a genuinely pristine database — its own
 * sequences, its own `__drizzle_migrations`, its own `public`.
 */
let dbSeq = 0;
const TEMPLATE_DB = `ll_tpl_${process.pid}`;
const createdDbs: string[] = [];
const openHandles: Array<{ close(): Promise<void> }> = [];
/** Long-lived connection to the SERVER (not to any test database) for DDL. */
let admin: { client: StateClient; close(): Promise<void> } | undefined;

async function adminExec(statement: string): Promise<void> {
  await run(admin!.client, sql.raw(statement));
}

beforeAll(async () => {
  if (!enabled) return;
  admin = await makePgClient(BASE_URL, "pg", { poolMax: 1 });
  // Migrate ONCE into the template; every test copies it.
  await adminExec(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`);
  await adminExec(`CREATE DATABASE "${TEMPLATE_DB}"`);
  const seed = await makePgClient(urlForDatabase(TEMPLATE_DB), "pg", { poolMax: 1 });
  try {
    await migrate(seed.client as never, { migrationsFolder: MIGRATIONS });
  } finally {
    // MUST be closed: CREATE DATABASE … TEMPLATE refuses while any other
    // session is connected to the template.
    await seed.close();
  }
});

async function makePgServerDb(): Promise<StateDb> {
  const name = `ll_t_${process.pid}_${++dbSeq}`;
  await adminExec(`CREATE DATABASE "${name}" TEMPLATE "${TEMPLATE_DB}"`);
  createdDbs.push(name);
  const handle = await makePgClient(urlForDatabase(name), "pg", { poolMax: 4 });
  openHandles.push(handle);
  return StateDb.fromClient(handle.client, "postgres", { close: handle.close });
}

/**
 * Teardown is BEST-EFFORT, and that is deliberate.
 *
 * Dropping a database can fail for reasons that have nothing to do with
 * whether the suite passed — a socket the pool has not finished closing. A
 * throw here fails the whole run with 187 green tests and no "Failed Tests"
 * section to explain it, which is worse than a leftover database on a
 * throwaway CI server. Leftovers are pid-namespaced and swept by the next run.
 */
async function bestEffort(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(`[pg-server] ${label} failed (ignored): ${(err as Error).message}`);
  }
}

afterEach(async () => {
  // The suite never closes what `makeDb` hands it, so the pools are ours to
  // drain — and a leaked pool keeps vitest's process alive after the run.
  for (const handle of openHandles.splice(0)) await handle.close();
  for (const name of createdDbs.splice(0)) {
    // Deliberately NOT `WITH (FORCE)` here. The pools above are already
    // drained, so a plain DROP succeeds — whereas FORCE sends SIGTERM to any
    // backend that has not quite finished closing, and node-postgres surfaces
    // that as an UNHANDLED error ("terminating connection due to administrator
    // command") that vitest reports as a run-level failure. Anything a plain
    // drop cannot take is left for afterAll's sweep, which can force safely
    // because nothing is running by then.
    await bestEffort(`dropping ${name}`, () => adminExec(`DROP DATABASE IF EXISTS "${name}"`));
  }
});

afterAll(async () => {
  if (!enabled || !admin) return;
  await bestEffort("template + leftover cleanup", async () => {
    // Every run's leftovers, not just this pid's: a run killed mid-flight never
    // reaches this hook, and nothing else would ever collect them.
    const leftovers = await rows<{ datname: string }>(
      admin!.client,
      sql`SELECT datname FROM pg_database WHERE datname LIKE 'll\_t\_%' OR datname LIKE 'll\_tpl\_%'`,
    );
    for (const row of leftovers) {
      await adminExec(`DROP DATABASE IF EXISTS "${row.datname}" WITH (FORCE)`);
    }
  });
  await admin.close();
});

describe.skipIf(!enabled)("real Postgres (node-postgres)", () => {
  runStateDbSuite(makePgServerDb, { dialect: "postgres" });

  /**
   * The int8 trap, asserted directly rather than inferred from a green suite.
   * `COUNT(*)` and `SUM(<integer>)` arrive as strings without the OID-20 parser
   * `makePgClient` registers, and JS would then answer `"0" + "1" === "01"`
   * instead of 1 — with every aggregate assertion in the suite still passing on
   * PGlite, which parses int8 itself.
   */
  it("parses int8 aggregates as numbers, not strings", async () => {
    const db = await makePgServerDb();
    await db.executions.recordStart({
      id: "int8-1",
      triggerType: "webhook",
      triggerId: "o/r#1",
      skill: "build",
      owner: "o",
      repo: "r",
      issueNumber: 1,
      startedAt: new Date().toISOString(),
    });
    await db.executions.recordFinish("int8-1", {
      success: true,
      inputTokens: 10,
      outputTokens: 5,
      costUsd: 0.25,
    });

    const [today] = (await db.executions.dailyStats(1)).slice(-1);
    expect(typeof today.executions).toBe("number");
    expect(typeof today.succeeded).toBe("number");
    expect(typeof today.inputTokens).toBe("number");
    // The failure mode this guards is arithmetic, not typeof: string
    // concatenation would make this 1 + "10" rather than a sum.
    expect(today.executions + 1).toBe(2);
    expect(today.inputTokens).toBe(10);
  });

  /**
   * The production entry point, end to end: its own database (so the migrator
   * writes its real, default `drizzle.__drizzle_migrations` journal rather than
   * a per-test one), a second open proving idempotency, and a `close()` that
   * actually drains the pool.
   */
  describe("StateDb.open(postgres://…)", () => {
    const dbName = `ll_open_${process.pid}`;
    let url: string;

    beforeAll(async () => {
      url = urlForDatabase(dbName);
      const admin = await makePgClient(BASE_URL, "pg", { poolMax: 1 });
      try {
        // CREATE DATABASE cannot run inside a transaction block; `run` issues a
        // bare statement, so this is fine.
        await run(admin.client, sql.raw(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`));
        await run(admin.client, sql.raw(`CREATE DATABASE "${dbName}"`));
      } finally {
        await admin.close();
      }
    });

    afterAll(async () => {
      await bestEffort(`dropping ${dbName}`, async () => {
        const admin = await makePgClient(BASE_URL, "pg", { poolMax: 1 });
        try {
          // WITH (FORCE) because a pool socket may not have finished closing —
          // plain DROP DATABASE fails with "is being accessed by other users".
          await run(admin.client, sql.raw(`DROP DATABASE IF EXISTS "${dbName}" WITH (FORCE)`));
        } finally {
          await admin.close();
        }
      });
    });

    it("migrates, round-trips a run, and is idempotent on a second open", async () => {
      const db = await StateDb.open(url);
      expect(db.dialect).toBe("postgres");

      await db.runs.createRun({
        id: "open-1",
        workflowName: "build",
        triggerId: "o/r#1",
        owner: "o",
        repo: "r",
        issueNumber: 1,
        currentPhase: "architect",
        startedAt: new Date().toISOString(),
        context: { nested: { deep: true }, list: [1, 2, 3] },
      } as never);
      const run = await db.runs.getRun("open-1");
      // jsonb round-trip: a `text({mode:'json'})` column driven by a pg client
      // would JSON.parse an already-parsed object and throw.
      expect(run?.context).toEqual({ nested: { deep: true }, list: [1, 2, 3] });
      // boolean round-trip: sqlite's mapper would have sent `1` into a boolean.
      await db.setWorkflowEnabled("build", false, "test");
      expect(await db.isWorkflowEnabled("build")).toBe(false);

      const journal = await rows<{ count: number }>(
        db.client,
        sql`SELECT count(*)::int AS count FROM drizzle."__drizzle_migrations"`,
      );
      expect(journal[0].count).toBeGreaterThan(0);
      await db.close();

      // Second open over the same database: the migrator no-ops, the row
      // survives, and the journal has not grown.
      const again = await StateDb.open(url);
      expect((await again.runs.getRun("open-1"))?.id).toBe("open-1");
      const journal2 = await rows<{ count: number }>(
        again.client,
        sql`SELECT count(*)::int AS count FROM drizzle."__drizzle_migrations"`,
      );
      expect(journal2[0].count).toBe(journal[0].count);
      await again.close();
    });

    it("close() drains the pool", async () => {
      const db = await StateDb.open(url);
      await db.executions.recentExecutions("build", 1);
      await db.close();
      // A drained node-postgres pool rejects further queries outright; a
      // `close()` that forgot `pool.end()` would happily answer this and leave
      // the process (and vitest) hanging on an open socket. The driver's own
      // message is one level down — Drizzle wraps it in a DrizzleQueryError
      // whose text is just the SQL, so asserting on `.message` alone would pass
      // against almost any failure.
      const err = await db.executions.recentExecutions("build", 1).then(
        () => null,
        (e: unknown) => e as { message?: string; cause?: { message?: string } },
      );
      expect(err?.cause?.message).toMatch(/after calling end on the pool/i);
    });
  });
});

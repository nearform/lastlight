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
import { runStateDbSuite } from "./store-suite.js";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle/pg", import.meta.url));

const enabled = process.env.PG_INTEGRATION === "1";
const BASE_URL =
  process.env.PG_TEST_URL?.trim() ||
  process.env.DATABASE_URL?.trim() ||
  "postgres://postgres:postgres@localhost:5432/postgres";

/** `postgres://…/db` + a per-test `search_path`, without touching the factory's API. */
function urlWithSchema(schema: string): string {
  const sep = BASE_URL.includes("?") ? "&" : "?";
  return `${BASE_URL}${sep}options=${encodeURIComponent(`-c search_path=${schema}`)}`;
}

/**
 * One server, one SCHEMA per test.
 *
 * `runStateDbSuite` demands a pristine database per call. A container (or
 * database) per test would cost minutes; a schema costs one `CREATE SCHEMA` and
 * one migrator pass. The migrator's own journal has to move with it
 * (`migrationsSchema`) — sharing the default `drizzle.__drizzle_migrations`
 * would make the second test's migration a no-op and leave it with no tables.
 */
let schemaSeq = 0;
const openHandles: Array<{ close(): Promise<void> }> = [];

async function makePgServerDb(): Promise<StateDb> {
  const schema = `ll_test_${process.pid}_${++schemaSeq}`;
  // The bootstrap connection is deliberately its own short-lived pool: it must
  // NOT inherit the search_path of a schema that does not exist yet.
  const bootstrap = await makePgClient(BASE_URL, "pg", { poolMax: 1 });
  try {
    await run(bootstrap.client, sql.raw(`CREATE SCHEMA IF NOT EXISTS "${schema}"`));
  } finally {
    await bootstrap.close();
  }
  const handle = await makePgClient(urlWithSchema(schema), "pg", { poolMax: 4 });
  openHandles.push(handle);
  await migrate(handle.client as never, {
    migrationsFolder: MIGRATIONS,
    migrationsSchema: schema,
  });
  return StateDb.fromClient(handle.client, "postgres", { close: handle.close });
}

afterEach(async () => {
  // The suite never closes what `makeDb` hands it, so the pools are ours to
  // drain — and a leaked pool keeps vitest's process alive after the run.
  for (const handle of openHandles.splice(0)) await handle.close();
});

/**
 * Teardown is BEST-EFFORT, and that is deliberate.
 *
 * Dropping a schema (or a database) can fail for reasons that have nothing to
 * do with whether the suite passed — a socket the pool has not finished
 * closing, another session still attached. A throw here fails the whole run
 * with 187 green tests and no "Failed Tests" section to explain it, which is a
 * worse outcome than a leftover schema on a throwaway CI server. Leftovers are
 * namespaced by pid and swept by the next run's LIKE anyway.
 */
async function bestEffort(label: string, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    console.warn(`[pg-server] ${label} failed (ignored): ${(err as Error).message}`);
  }
}

afterAll(async () => {
  if (!enabled) return;
  await bestEffort("schema cleanup", async () => {
    const admin = await makePgClient(BASE_URL, "pg", { poolMax: 1 });
    try {
      // Every run's leftovers, not just this pid's — a run killed mid-flight
      // never reaches this hook, and nothing else would ever collect them.
      const leftovers = await rows<{ nspname: string }>(
        admin.client,
        sql`SELECT nspname FROM pg_namespace WHERE nspname LIKE 'll\_test\_%'`,
      );
      for (const row of leftovers) {
        await run(admin.client, sql.raw(`DROP SCHEMA IF EXISTS "${row.nspname}" CASCADE`));
      }
    } finally {
      await admin.close();
    }
  });
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
      url = BASE_URL.replace(/\/[^/?]*(\?|$)/, `/${dbName}$1`);
      const admin = await makePgClient(BASE_URL, "pg", { poolMax: 1 });
      try {
        // CREATE DATABASE cannot run inside a transaction block; `execute` is a
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

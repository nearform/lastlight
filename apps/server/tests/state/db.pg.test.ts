/**
 * The Postgres leg of the state-store suite — the behavioural half of the
 * dual-dialect proof.
 *
 * PGlite is real Postgres compiled to WASM, not an emulation, so a failure here
 * is a genuine dialect bug in a query or in the `dialect.ts` seam. Do not fix a
 * red test by loosening an assertion: every assertion body lives in
 * `store-suite.ts` and is shared verbatim with the sqlite leg
 * (`tests/state/db.test.ts`), so loosening one weakens both.
 *
 * No pipeline change buys this: the file is an ordinary `tests/**‍/*.test.ts`
 * picked up by the existing `pnpm --filter lastlight-core test` glob, and PGlite
 * needs no postgres service, no docker and no opt-in env var.
 */
import { afterEach, describe, expect, it, vi } from "vitest";

// Same mock the sqlite runner carries. `vi.mock` is hoisted per test FILE and
// does nothing from an imported suite module, so each runner owns its own copy
// or the run's stderr fills with real pino JSON from the throwing-observer test.
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

import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { asStateClient } from "#src/state/client.js";
import { StateDb } from "#src/state/db.js";
import * as pgSchema from "#src/state/schema/pg.js";
import { runStateDbSuite } from "./store-suite.js";
import { makeTestDb } from "../helpers/state-db.js";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle/pg", import.meta.url));

/**
 * `runStateDbSuite` calls `makeDb()` per test and never closes what it gets —
 * the sqlite leg's `makeTestDb()` registers its own cleanup, and so must this,
 * or every test leaks a PGlite instance.
 */
const open: PGlite[] = [];
afterEach(async () => {
  for (const p of open.splice(0)) await p.close();
});

/**
 * A pristine, migrated Postgres `StateDb`.
 *
 * Fresh PGlite per test, matching the sqlite leg's per-test temp file: reusing
 * one instance would carry identity-sequence positions, `__drizzle_migrations`
 * rows and test data across tests, silently weakening the suite. The WASM module
 * is compiled once per worker and cached, so only the first instance pays the
 * real init cost.
 */
async function makePgStateDb(): Promise<StateDb> {
  // int8 (OID 20) → number. Postgres returns COUNT(*)/SUM(...) as int8, which
  // node-postgres hands back as a STRING. PGlite ≥0.5 already parses it to a
  // number by default (verified on 0.5.x) — this parser is kept as a PIN
  // against that default changing, and as the executable statement of
  // `asStateClient()`'s contract: any future real PG client must normalize int8
  // itself, because the cast cannot.
  const pglite = new PGlite({ parsers: { 20: (v: string) => Number(v) } });
  open.push(pglite);
  // The schema must be passed here: `tablesOf()` reads it back off the client,
  // which is what makes the stores address pg columns (real boolean, real
  // jsonb) instead of the sqlite ones they are typed against.
  const client = asStateClient(drizzle(pglite, { schema: pgSchema }));
  await migrate(client as never, { migrationsFolder: MIGRATIONS });
  return StateDb.fromClient(client, "postgres");
}

// No wrapping describe: runStateDbSuite already opens its own
// `describe("state stores [postgres]")`.
runStateDbSuite(makePgStateDb, { dialect: "postgres" });

/**
 * The stats rollups bucket by `substr()` over an ISO-8601 TEXT timestamp
 * (`dialect.ts`'s `dayBucket`/`hourBucket`) precisely so the two dialects
 * produce the same keys from the same rows. Feed both legs identical fixtures
 * and deep-equal the results: if anyone reintroduces `date()` / `strftime` /
 * `date_trunc`, this test names the divergence instead of leaving it to show up
 * as a dashboard chart that disagrees with itself.
 */
describe("cross-dialect stats bucketing", () => {
  /** Fixed offsets from now, so the rows land inside both rollups' windows. */
  function fixtures() {
    const now = Date.now();
    const at = (hoursAgo: number) => new Date(now - hoursAgo * 3_600_000).toISOString();
    return [
      { id: "x-1", startedAt: at(25), success: true }, // previous UTC day
      { id: "x-2", startedAt: at(3), success: true },
      { id: "x-3", startedAt: at(2), success: false },
      { id: "x-4", startedAt: at(2), success: undefined }, // still running
    ];
  }

  async function seed(db: StateDb, rows: ReturnType<typeof fixtures>) {
    for (const row of rows) {
      await db.executions.recordStart({
        id: row.id,
        triggerType: "webhook",
        triggerId: "owner/repo#1",
        skill: "build",
        owner: "owner",
        repo: "repo",
        issueNumber: 1,
        startedAt: row.startedAt,
      });
      if (row.success !== undefined) {
        await db.executions.recordFinish(row.id, {
          success: row.success,
          inputTokens: 10,
          outputTokens: 5,
          cacheReadInputTokens: 2,
          costUsd: 0.25,
        });
      }
    }
  }

  it("produces identical daily and hourly buckets on both dialects", async () => {
    const rows = fixtures();
    const sqlite = await makeTestDb();
    const pg = await makePgStateDb();
    await seed(sqlite, rows);
    await seed(pg, rows);

    const sqliteDaily = await sqlite.executions.dailyStats(3);
    const pgDaily = await pg.executions.dailyStats(3);
    expect(pgDaily).toEqual(sqliteDaily);

    const sqliteHourly = await sqlite.executions.hourlyStats(6);
    const pgHourly = await pg.executions.hourlyStats(6);
    expect(pgHourly).toEqual(sqliteHourly);

    // Guard against the whole comparison being vacuously true — and pin the
    // tri-state tally: the still-running row counts in neither column.
    const busiest = pgDaily.filter((d) => d.executions > 0);
    expect(busiest.length).toBeGreaterThan(0);
    expect(busiest.reduce((n, d) => n + d.executions, 0)).toBe(4);
    expect(busiest.reduce((n, d) => n + d.succeeded, 0)).toBe(2);
    expect(busiest.reduce((n, d) => n + d.failed, 0)).toBe(1);
  });
});

/**
 * Through Phase 5 Postgres is TEST-ONLY: the only entry point is
 * `StateDb.fromClient()` above. `open()` refusing a `postgres://` URL is what
 * keeps a PG driver out of the runtime dependency graph and turns a
 * misconfigured `DATABASE_URL` into a loud boot failure instead of a
 * half-working server. Phase 6 replaces the throw with a real node-postgres
 * branch — until then, this is the contract.
 */
describe("StateDb.open with a postgres URL", () => {
  it.each(["postgres://user:pw@host:5432/db", "postgresql://host/db", "POSTGRES://host/db"])(
    "refuses %s",
    async (url) => {
      await expect(StateDb.open(url)).rejects.toThrow(/PG runtime not enabled/);
    },
  );
});

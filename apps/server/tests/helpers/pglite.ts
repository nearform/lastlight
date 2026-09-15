/**
 * A migrated PGlite in a pristine state, per test — without a new instance per
 * test.
 *
 * Every Postgres-leg test wants a database with no rows and fresh identity
 * sequences. They used to get one by building a new PGlite and running the full
 * Drizzle migration, ~0.4 s each — `db.pg.test.ts` does it ~200 times, 80 s,
 * the slowest file in the workspace. Worse, a closed PGlite does not hand its
 * WASM memory back: that one file peaked at ~3.8 GB in a single worker (a forced
 * GC barely moved it), which is an OOM kill in a memory-capped sandbox (issue #388).
 *
 * So each test FILE migrates ONE instance, and every request for a database
 * resets it first: any table in `public` the migration did not create (a test's
 * own scratch table) is dropped, then `TRUNCATE … RESTART IDENTITY CASCADE` runs
 * over the migrated ones. That is exactly the state a fresh migration leaves —
 * its tables, no rows, sequences back at 1 — and `drizzle.__drizzle_migrations`
 * is not in `public`, so its rows are the ones a fresh migration writes too.
 * Memory stays flat.
 *
 * The one thing a shared instance cannot give is two independent databases in
 * the same test, so that throws rather than silently aliasing them.
 */
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate } from "drizzle-orm/pglite/migrator";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach } from "vitest";

const MIGRATIONS = fileURLToPath(new URL("../../drizzle/pg", import.meta.url));

/**
 * int8 (OID 20) → number. Postgres returns COUNT(*)/SUM(...) as int8, which
 * node-postgres hands back as a STRING. PGlite ≥0.5 already parses it to a
 * number by default — this parser is a PIN against that default changing, and
 * the executable statement of `asStateClient()`'s contract: any real PG client
 * must normalize int8 itself, because the cast cannot.
 */
const PARSERS = { 20: (v: string) => Number(v) };

let instance: Promise<{ pglite: PGlite; migratedTables: Set<string> }> | undefined;
let handedOutThisTest = false;

beforeEach(() => {
  handedOutThisTest = false;
});

afterAll(async () => {
  if (instance) await (await instance).pglite.close();
  instance = undefined;
});

async function publicTables(pglite: PGlite): Promise<string[]> {
  const { rows } = await pglite.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  return rows.map((r) => r.tablename);
}

function migrated(): Promise<{ pglite: PGlite; migratedTables: Set<string> }> {
  instance ??= (async () => {
    const pglite = new PGlite({ parsers: PARSERS });
    await migrate(drizzle(pglite) as never, { migrationsFolder: MIGRATIONS });
    return { pglite, migratedTables: new Set(await publicTables(pglite)) };
  })();
  return instance;
}

const quoted = (table: string): string => `"public"."${table.replaceAll('"', '""')}"`;

/** The file's migrated PGlite, emptied and with its identity sequences restarted. */
export async function migratedPglite(): Promise<PGlite> {
  if (handedOutThisTest) {
    throw new Error(
      "migratedPglite() was called twice in one test — the Postgres leg shares one instance per file, so a second call would alias the first database",
    );
  }
  handedOutThisTest = true;
  const { pglite, migratedTables } = await migrated();
  const scratch = (await publicTables(pglite)).filter((table) => !migratedTables.has(table));
  if (scratch.length > 0) await pglite.exec(`DROP TABLE ${scratch.map(quoted).join(", ")} CASCADE`);
  if (migratedTables.size > 0) {
    await pglite.exec(`TRUNCATE ${[...migratedTables].map(quoted).join(", ")} RESTART IDENTITY CASCADE`);
  }
  return pglite;
}

/**
 * The production Postgres client factory.
 *
 * Imported ONLY from `StateDb.open()`'s postgres branch, and dynamically — so a
 * SQLite deployment never pulls a Postgres driver into its runtime graph. Each
 * builder below then dynamically imports its OWN driver, so a node-postgres
 * deployment never loads `@neondatabase/serverless` either (or vice-versa).
 * A static `import "pg"` anywhere in this file undoes both properties; the
 * isolation grep in the phase doc's verification is the tripwire.
 *
 * PGlite (the hermetic test leg, `tests/state/db.pg.test.ts`) builds its own
 * client — this file is the real-server path.
 *
 * **This is the one module under `src/` that imports `schema/pg.ts`**, and it
 * has to: `tablesOf()` reads the schema back off the Drizzle instance, so a
 * client built without `{ schema }` throws on first use, and one built with the
 * *sqlite* schema would send `1` into a `boolean` column and `JSON.parse` an
 * already-parsed jsonb value. The rule the other 200-odd modules follow ("never
 * import schema/pg.ts") is intact — this file is only ever reached through a
 * dynamic import on the postgres branch.
 */
import { asStateClient, type StateClient } from "./client.js";
import * as pgSchema from "./schema/pg.js";
import { type PgDriver } from "lastlight-shared/database-url";

export type { PgDriver };
export { resolvePgDriver } from "lastlight-shared/database-url";

/** Default pool ceiling. Last Light is a single-writer process (see §7). */
export const DEFAULT_POOL_MAX = 10;

export interface PgClientHandle {
  client: StateClient;
  /** Drains the pool. `StateDb.close()` awaits this. */
  close(): Promise<void>;
}

export interface PgClientOptions {
  poolMax?: number;
}

/**
 * int8 (OID 20). Postgres returns `COUNT(*)` / `SUM(<integer>)` as int8, which
 * BOTH real drivers hand back as a **string** to avoid losing precision past
 * 2^53. Every store expects a number, and the stats rollups would silently
 * start concatenating instead of adding.
 *
 * PGlite already parses int8 to a number, which is exactly why the hermetic
 * test leg cannot catch this — it is the one behaviour that is driver-specific
 * rather than dialect-specific. Registration happens before the pool is
 * constructed so it cannot lose a race with the first query.
 */
const INT8_OID = 20;
const parseInt8 = (v: string): number => Number(v);

/** node-postgres — a standard TCP pool. Self-hosted PG and most managed services. */
async function makeNodePgClient(url: string, poolMax: number): Promise<PgClientHandle> {
  const pg = (await import("pg")).default;
  const { drizzle } = await import("drizzle-orm/node-postgres");
  pg.types.setTypeParser(INT8_OID, parseInt8);
  const pool = new pg.Pool({ connectionString: url, max: poolMax });
  return {
    client: asStateClient(drizzle(pool, { schema: pgSchema })),
    close: () => pool.end(),
  };
}

/**
 * Neon serverless — a WebSocket pool.
 *
 * MUST be the serverless (WebSocket) driver, never `neon-http`: the HTTP driver
 * cannot run interactive transactions, so the five named atomic ops and the
 * four `TeamStore` writes would type-check, pass a smoke test, and quietly stop
 * being atomic.
 */
async function makeNeonClient(url: string, poolMax: number): Promise<PgClientHandle> {
  const { Pool, types } = await import("@neondatabase/serverless");
  const { drizzle } = await import("drizzle-orm/neon-serverless");
  types.setTypeParser(INT8_OID, parseInt8);
  const pool = new Pool({ connectionString: url, max: poolMax });
  return {
    client: asStateClient(drizzle(pool, { schema: pgSchema })),
    close: () => pool.end(),
  };
}

/**
 * Build a Postgres client for `url` over the named driver.
 *
 * Both produce the identical Drizzle `PgDatabase` query surface behind the one
 * `"postgres"` dialect, so no store and no `dialect.ts` helper branches on the
 * driver — only construction differs. Adding a third (Hyperdrive, another
 * WebSocket-pooled PG) is another builder here and one more `PgDriver` value.
 */
export function makePgClient(
  url: string,
  driver: PgDriver,
  opts?: PgClientOptions,
): Promise<PgClientHandle> {
  const poolMax = opts?.poolMax ?? DEFAULT_POOL_MAX;
  return driver === "neon" ? makeNeonClient(url, poolMax) : makeNodePgClient(url, poolMax);
}

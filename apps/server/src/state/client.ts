/**
 * The Drizzle client seam.
 *
 * Store code is written ONCE, typed against the sqlite Drizzle instance — the
 * production path. A Postgres instance (Phase 4, PGlite in tests) is adapted
 * through the `asStateClient()` cast below. That is sound because the
 * query-builder surface the stores use (`select` / `insert` / `update` /
 * `delete` / `transaction`) is structurally identical across drivers; the two
 * genuinely divergent surfaces — raw SQL execution and rows-affected shape —
 * are funneled through `rows()` / `run()` / `changes()` in `dialect.ts`.
 *
 * Backend selection is construction-time injection (`StateDb.open` /
 * `StateDb.fromClient`), never a module-load env global, so both dialects can
 * be constructed in one test process.
 */
import type { LibSQLDatabase } from "drizzle-orm/libsql";
import * as sqliteSchema from "./schema/sqlite.js";

/** Runtime discriminator carried by StateDb. Branches `dialect.ts` helpers only. */
export type Dialect = "sqlite" | "postgres";

export type StateClient = LibSQLDatabase<typeof sqliteSchema>;

/** The transaction handle `client.transaction()` passes to its callback. */
export type StateTx = Parameters<Parameters<StateClient["transaction"]>[0]>[0];

/**
 * Anything a store method can run queries against: the root client, or an
 * enclosing transaction. Methods that participate in a cross-store atomic op
 * take this as a trailing `dbc` parameter defaulting to `this.client`.
 */
export type StateDbc = StateClient | StateTx;

/**
 * The ONE documented cast that lets a non-libsql Drizzle instance (PGlite in
 * Phase 4 tests) drive the sqlite-typed stores. Do not add a second cast site.
 */
export function asStateClient(db: unknown): StateClient {
  return db as StateClient;
}

/**
 * Serializes the operations that open a transaction (README locked decision 8).
 *
 * ONE per CONNECTION, shared by every store that transacts — not one per store.
 * `WorkflowRunStore` owns five transacting ops and `TeamStore` four, all on the
 * same libsql client; a store-scoped chain would leave run-op-vs-team-op races
 * completely unguarded. Overlapping libsql interactive transactions fail in
 * ways beyond SQLITE_BUSY (nested BEGIN, shared-handle interleaving), and
 * `busy_timeout` cannot help because it is connection-scoped and the client
 * swaps connections after each transaction. So this mutex, not the pragma, is
 * the load-bearing defense — and it is semantically free in a single-writer
 * process.
 */
export type OpSerializer = <T>(fn: () => Promise<T>) => Promise<T>;

export function makeOpSerializer(): OpSerializer {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    // Run regardless of how the previous op settled…
    const next = chain.then(fn, fn);
    // …and never let a rejection poison the chain for everyone behind it.
    chain = next.catch(() => {});
    return next;
  };
}

/** `{ a: string | null }` → `{ a: string | undefined }`, leaving the rest alone. */
export type NullsToUndefined<T> = {
  [K in keyof T]: null extends T[K] ? Exclude<T[K], null> | undefined : T[K];
};

/**
 * Drizzle returns `null` for a nullable column; the record types spell those
 * fields as optionals (`foo?: string`). Strip the nulls at the store boundary
 * so `record.foo === undefined` behaves as it always has.
 *
 * The return type is transformed too, not just the value — otherwise every
 * caller needs an `as unknown as Record` double cast to hand the result back as
 * its public record type, which would defeat the point of having one helper.
 */
export function nullsToUndefined<T extends Record<string, unknown>>(row: T): NullsToUndefined<T> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(row)) out[key] = value === null ? undefined : value;
  return out as NullsToUndefined<T>;
}

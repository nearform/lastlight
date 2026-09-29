/**
 * The in-process single-writer lock for the libsql LOCAL client.
 *
 * The libsql local client is not one connection, it is a relay of them:
 * `client.transaction()` hands the client's current connection to the
 * transaction and lazily opens a NEW one for everything issued afterwards. So a
 * plain write (`mergeScratch`, `finishRun`, …) racing an open transaction is
 * two connections in one process contending for SQLite's write lock:
 *
 * 1. the plain write fails at once with `SQLITE_BUSY: database is locked` —
 *    the fresh connection never got `busy_timeout`, and even if it had, the
 *    native call blocks the event loop so the lock holder could never commit;
 * 2. libsql does not reset a statement that failed with BUSY, so that
 *    connection now carries an "active" statement — and the NEXT transaction
 *    to be handed it fails its COMMIT with `SQLITE_BUSY: cannot commit
 *    transaction - SQL statements in progress`.
 *
 * Seen on nearform at boot, when the resume sweep re-dispatched two orphaned
 * runs at once (`tests/state/sqlite-write-lock.test.ts` reproduces both).
 *
 * The fix is the single-writer discipline the stores always assumed: every
 * write — a transaction from BEGIN to COMMIT/ROLLBACK, or one plain statement —
 * holds this lock. Reads skip it; WAL lets readers run beside a writer.
 *
 * **Consequence for store code:** inside a transaction callback, write through
 * the `tx` handle, never the root client. A root-client write there waits for
 * the lock its own enclosing transaction holds, forever. (Before this lock that
 * same write failed with "database is locked", so it was already a bug.)
 */
import type {
  Client,
  InArgs,
  InStatement,
  ResultSet,
  Transaction,
  TransactionMode,
} from "@libsql/client";
import { makeOpSerializer } from "./client.js";

/** Applied to every connection the client opens, not just the first. */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * Plain reads skip the lock. Anything else — including `WITH …` (a CTE may
 * front an INSERT) and PRAGMAs — takes it; a read that locks costs only a
 * little concurrency, a write that doesn't reopens the bug.
 */
export function isReadOnlySql(sql: string): boolean {
  return /^\s*(?:(?:--[^\n]*\n|\/\*[\s\S]*?\*\/)\s*)*(?:select|explain)\b/i.test(sql);
}

function sqlOf(stmt: InStatement): string {
  return typeof stmt === "string" ? stmt : stmt.sql;
}

function isBusy(err: unknown): boolean {
  return (err as { code?: unknown } | null)?.code === "SQLITE_BUSY";
}

/**
 * Wrap a libsql local client so all writes are serialized in-process. Returns
 * a `Client` the Drizzle instance is built over; the raw client stays the
 * caller's to close (closing either closes the same connections).
 */
export function withSqliteWriteLock(
  raw: Client,
  opts: { busyTimeoutMs?: number } = {},
): Client {
  const busyTimeoutMs = opts.busyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS;
  // A lock is a serializer whose op is "hold until released", not "run fn".
  const serialize = makeOpSerializer();
  const acquire = (): Promise<() => void> =>
    new Promise((granted) => {
      void serialize(
        () =>
          new Promise<void>((release) => {
            let released = false;
            granted(() => {
              if (!released) {
                released = true;
                release();
              }
            });
          }),
      );
    });

  // `busy_timeout` is connection-scoped and libsql swaps connections after
  // every transaction, so re-arm it before the next statement reaches the new
  // one. In-process contention is now impossible; this is for OTHER processes
  // (the `lastlight state` CLI, a backup) briefly holding the write lock.
  let freshConnection = true;
  const arm = async (): Promise<void> => {
    if (!freshConnection) return;
    freshConnection = false;
    await raw.execute(`PRAGMA busy_timeout = ${busyTimeoutMs}`);
  };

  /**
   * A BUSY failure leaves the statement un-reset on the connection, which
   * poisons the next transaction handed it (see module comment, step 2).
   * Throw the connection away rather than let that happen.
   */
  const discardIfBusy = (err: unknown): never => {
    if (isBusy(err)) {
      raw.reconnect();
      freshConnection = true;
    }
    throw err;
  };

  const locked = async <T>(fn: () => Promise<T>): Promise<T> => {
    const release = await acquire();
    try {
      await arm();
      return await fn().catch(discardIfBusy);
    } finally {
      release();
    }
  };

  const wrapTransaction = (tx: Transaction, release: () => void): Transaction => ({
    execute: (stmt) => tx.execute(stmt),
    batch: (stmts) => tx.batch(stmts),
    executeMultiple: (sql) => tx.executeMultiple(sql),
    // Release on success AND failure: Drizzle follows a failed commit with a
    // rollback, but a raw caller might not, and a held lock stalls every write.
    commit: async () => {
      try {
        await tx.commit();
      } finally {
        release();
      }
    },
    rollback: async () => {
      try {
        await tx.rollback();
      } finally {
        release();
      }
    },
    close: () => {
      try {
        tx.close();
      } finally {
        release();
      }
    },
    get closed() {
      return tx.closed;
    },
  });

  function execute(stmt: InStatement): Promise<ResultSet>;
  function execute(sql: string, args?: InArgs): Promise<ResultSet>;
  function execute(stmtOrSql: InStatement, args?: InArgs): Promise<ResultSet> {
    const stmt: InStatement =
      typeof stmtOrSql === "string" && args !== undefined ? { sql: stmtOrSql, args } : stmtOrSql;
    if (isReadOnlySql(sqlOf(stmt))) {
      return arm().then(() => raw.execute(stmt));
    }
    return locked(() => raw.execute(stmt));
  }

  return {
    execute,
    batch: (stmts, mode) => locked(() => raw.batch(stmts, mode)),
    migrate: (stmts) => locked(() => raw.migrate(stmts)),
    executeMultiple: (sql) => locked(() => raw.executeMultiple(sql)),
    transaction: async (mode?: TransactionMode) => {
      const release = await acquire();
      try {
        await arm();
        const tx = await raw.transaction(mode).catch(discardIfBusy);
        // The client just gave this connection away; the next one is new.
        freshConnection = true;
        return wrapTransaction(tx, release);
      } catch (err) {
        release();
        throw err;
      }
    },
    sync: () => raw.sync(),
    close: () => raw.close(),
    reconnect: () => {
      raw.reconnect();
      freshConnection = true;
    },
    get closed() {
      return raw.closed;
    },
    get protocol() {
      return raw.protocol;
    },
  };
}

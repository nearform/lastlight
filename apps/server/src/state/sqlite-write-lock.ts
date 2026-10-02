/**
 * The in-process single-writer lock for the libsql LOCAL client.
 *
 * The libsql local client is a pool of connections (up to `concurrency`, 20 by
 * default): every `execute()` / `batch()` borrows one for the call, and
 * `client.transaction()` borrows one for the transaction's lifetime. So a
 * plain write (`mergeScratch`, `finishRun`, …) racing an open transaction is
 * two connections in one process contending for SQLite's write lock:
 *
 * 1. the plain write waits out `busy_timeout` and then fails with
 *    `SQLITE_BUSY: database is locked` — it can never succeed, because the
 *    native busy wait blocks the event loop, so the lock holder can't commit;
 * 2. libsql does not reset a statement that failed with BUSY, so that
 *    connection now carries an "active" statement — and the NEXT transaction
 *    to be handed it fails its COMMIT with `SQLITE_BUSY: cannot commit
 *    transaction - SQL statements in progress`.
 *
 * Seen on nearform at boot (on @libsql/client 0.17, whose connection relay
 * failed the same way), when the resume sweep re-dispatched two orphaned runs
 * at once (`tests/state/sqlite-write-lock.test.ts` reproduces both).
 *
 * The fix is the single-writer discipline the stores always assumed: every
 * write — a transaction from BEGIN to COMMIT/ROLLBACK, or one plain statement —
 * holds this lock. Reads skip it; WAL lets readers run beside a writer.
 *
 * **Consequence for store code:** inside a transaction callback, write through
 * the `tx` handle, never the root client. A root-client write there waits for
 * the lock its own enclosing transaction holds, forever. (Before this lock that
 * same write failed with "database is locked", so it was already a bug.)
 *
 * **Open the raw client with {@link openSqliteClient}.** `busy_timeout` is
 * connection-scoped and the pool opens connections lazily, so a PRAGMA reaches
 * only whichever connection served it; the `timeout` option is applied to
 * every connection as the pool opens it.
 */
import {
  createClient,
  type Client,
  type InArgs,
  type InStatement,
  type ResultSet,
  type Transaction,
  type TransactionMode,
} from "@libsql/client";
import { makeOpSerializer } from "./client.js";

/**
 * How long a write waits on ANOTHER process's write lock (the `lastlight
 * state` CLI, a backup) before failing. In-process contention never reaches
 * it — the lock below serializes that.
 */
export const SQLITE_BUSY_TIMEOUT_MS = 5000;

/**
 * The libsql local client every SQLite `StateDb` runs on, with `busy_timeout`
 * set on every connection its pool opens.
 */
export function openSqliteClient(
  url: string,
  opts: { busyTimeoutMs?: number } = {},
): Client {
  return createClient({ url, timeout: opts.busyTimeoutMs ?? SQLITE_BUSY_TIMEOUT_MS });
}

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
export function withSqliteWriteLock(raw: Client): Client {
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

  /**
   * A BUSY failure leaves the statement un-reset on the connection, which
   * poisons the next transaction handed it (see module comment, step 2).
   * Throw the pool's connections away rather than let that happen. Safe under
   * the lock: no transaction can be holding one, and a read borrows its
   * connection only for a synchronous call.
   */
  const discardIfBusy = (err: unknown): never => {
    if (isBusy(err)) raw.reconnect();
    throw err;
  };

  const locked = async <T>(fn: () => Promise<T>): Promise<T> => {
    const release = await acquire();
    try {
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
    if (isReadOnlySql(sqlOf(stmt))) return raw.execute(stmt);
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
        const tx = await raw.transaction(mode).catch(discardIfBusy);
        return wrapTransaction(tx, release);
      } catch (err) {
        release();
        throw err;
      }
    },
    sync: () => raw.sync(),
    close: () => raw.close(),
    reconnect: () => raw.reconnect(),
    get closed() {
      return raw.closed;
    },
    get protocol() {
      return raw.protocol;
    },
  };
}

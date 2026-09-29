/**
 * The in-process SQLite write lock (`src/state/sqlite-write-lock.ts`).
 *
 * The failure it closes, seen on nearform when the boot resume sweep
 * re-dispatched two orphaned runs at once: a plain write racing an open
 * transaction failed `SQLITE_BUSY: database is locked`, and the statement it
 * left un-reset made the next transaction's COMMIT fail `cannot commit
 * transaction - SQL statements in progress`.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createClient, type Client } from "@libsql/client";
import { isReadOnlySql, withSqliteWriteLock } from "#src/state/sqlite-write-lock.js";
import { makeTestDb } from "../helpers/state-db.js";

const dirs: string[] = [];
const clients: Client[] = [];

async function tempDb(): Promise<{ url: string; raw: Client }> {
  const dir = mkdtempSync(join(tmpdir(), "lastlight-write-lock-"));
  dirs.push(dir);
  const url = `file:${join(dir, "t.db")}`;
  const raw = createClient({ url });
  clients.push(raw);
  await raw.execute("PRAGMA journal_mode = WAL");
  await raw.execute("CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)");
  await raw.execute("INSERT INTO t VALUES (1, 'init')");
  return { url, raw };
}

afterEach(() => {
  for (const c of clients.splice(0)) c.close();
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const valueOf = async (c: Client): Promise<unknown> =>
  (await c.execute("SELECT v FROM t WHERE id = 1")).rows[0]?.v;

describe("withSqliteWriteLock", () => {
  it("a plain write racing an open transaction waits for it, and the next transaction commits", async () => {
    const { raw } = await tempDb();
    const client = withSqliteWriteLock(raw);

    const t1 = await client.transaction("write");
    await t1.execute("UPDATE t SET v = 't1' WHERE id = 1");
    // Unlocked, this fails at once with `database is locked` (the new
    // connection libsql opened for it has no busy_timeout).
    const plain = client.execute("UPDATE t SET v = 'plain' WHERE id = 1");
    await t1.commit();
    await plain;

    // Unlocked, this COMMIT fails `SQL statements in progress`.
    const t2 = await client.transaction("write");
    await t2.execute("UPDATE t SET v = 't2' WHERE id = 1");
    await t2.commit();

    expect(await valueOf(client)).toBe("t2");
  });

  it("reads do not wait for an open transaction", async () => {
    const { raw } = await tempDb();
    const client = withSqliteWriteLock(raw);

    const tx = await client.transaction("write");
    await tx.execute("UPDATE t SET v = 'uncommitted' WHERE id = 1");
    // WAL: the reader sees the last committed value and returns while the
    // writer still holds the lock.
    expect(await valueOf(client)).toBe("init");
    await tx.commit();
    expect(await valueOf(client)).toBe("uncommitted");
  });

  it("releases the lock when a transaction rolls back, closes, or fails to commit", async () => {
    const { raw } = await tempDb();
    const client = withSqliteWriteLock(raw);

    const rolledBack = await client.transaction("write");
    await rolledBack.rollback();

    const closed = await client.transaction("write");
    closed.close();

    const failed = await client.transaction("write");
    await failed.rollback();
    // Committing an already-closed transaction throws; the lock must not leak.
    await expect(failed.commit()).rejects.toThrow();

    await client.execute("UPDATE t SET v = 'after' WHERE id = 1");
    expect(await valueOf(client)).toBe("after");
  });

  it("re-arms busy_timeout on the connection libsql swaps in after a transaction", async () => {
    const { raw } = await tempDb();
    const client = withSqliteWriteLock(raw, { busyTimeoutMs: 1234 });

    const tx = await client.transaction("write");
    await tx.commit();
    const rows = (await client.execute("PRAGMA busy_timeout")).rows;
    expect(Object.values(rows[0] ?? {})[0]).toBe(1234);
  });

  it("drops a connection a cross-process BUSY failure left poisoned", async () => {
    const { url, raw } = await tempDb();
    const client = withSqliteWriteLock(raw, { busyTimeoutMs: 20 });

    // Another process holds the write lock.
    const other = createClient({ url });
    clients.push(other);
    const held = await other.transaction("write");
    await held.execute("UPDATE t SET v = 'other' WHERE id = 1");
    await expect(client.execute("UPDATE t SET v = 'blocked' WHERE id = 1")).rejects.toMatchObject({
      code: "SQLITE_BUSY",
    });
    await held.commit();

    // Without the reconnect this transaction inherits the un-reset statement
    // and its COMMIT fails `SQL statements in progress`.
    const tx = await client.transaction("write");
    await tx.execute("UPDATE t SET v = 'recovered' WHERE id = 1");
    await tx.commit();
    expect(await valueOf(client)).toBe("recovered");
  });
});

describe("isReadOnlySql", () => {
  it.each([
    ["select 1", true],
    ["  SELECT * FROM t", true],
    ["-- note\nselect 1", true],
    ["/* c */ explain query plan select 1", true],
    ["update t set v = 1", false],
    ["insert into t values (1)", false],
    ["with x as (select 1) insert into t select * from x", false],
    ["PRAGMA busy_timeout = 5", false],
    ["BEGIN", false],
  ])("%s → %s", (sql, expected) => {
    expect(isReadOnlySql(sql)).toBe(expected);
  });
});

describe("StateDb under concurrent writes", () => {
  it("transactional and plain run writes interleaved from many callers all land", async () => {
    const db = await makeTestDb();
    const ids = Array.from({ length: 8 }, (_, i) => `run-${i}`);
    for (const id of ids) {
      await db.runs.createRun({
        id,
        workflowName: "pr-review",
        triggerId: `acme/widgets#${id}`,
        currentPhase: "review",
        status: "running",
        startedAt: new Date().toISOString(),
      });
    }

    // The boot-resume shape: several runs finishing (a transaction, because
    // `error` is set) while others merge scratch (a plain write).
    await Promise.all(
      ids.map((id, i) =>
        i % 2 === 0
          ? db.runs.finishRun(id, "failed", { error: "boom" })
          : db.runs.mergeScratch(id, { reviewCheck: null }),
      ),
    );

    for (const [i, id] of ids.entries()) {
      const run = await db.runs.getRun(id);
      if (i % 2 === 0) expect(run?.status).toBe("failed");
      else expect(run?.scratch).toMatchObject({ reviewCheck: null });
    }
  });
});

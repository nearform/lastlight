/**
 * The one way a test gets a real `StateDb`.
 *
 * **Why not `:memory:`.** The libsql client lazily opens a NEW connection after
 * every `client.transaction()`, and for `:memory:` a new connection is a new,
 * EMPTY database. So the first committed transaction silently discards the
 * schema and every subsequent query fails with `no such table` — verified on
 * @libsql/client 0.17. `WorkflowRunStore`'s five named ops and all four
 * `TeamStore` writes transact, so any suite touching them detonates on
 * `:memory:`, and it detonates *after* the write it was testing appeared to
 * succeed.
 *
 * Rather than ask every suite to know which store methods transact, this hands
 * out a per-test temp FILE and registers its own cleanup. One seam, so the
 * hazard has exactly one place to be handled.
 */
import { afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { StateDb } from "#src/state/db.js";

const open: StateDb[] = [];
const dirs: string[] = [];

/** A fresh, migrated, file-backed StateDb. Closed and deleted after the test. */
export async function makeTestDb(): Promise<StateDb> {
  const dir = mkdtempSync(join(tmpdir(), "lastlight-test-db-"));
  dirs.push(dir);
  const db = await StateDb.open(join(dir, "state.db"));
  open.push(db);
  return db;
}

/**
 * A second StateDb over the SAME file — for tests that need a second set of
 * stores on one database (e.g. building a store with an injected collaborator
 * while the first handle keeps the normal wiring).
 */
export async function makeTestDbAt(path: string): Promise<StateDb> {
  const db = await StateDb.open(path);
  open.push(db);
  return db;
}

/** The directory a {@link makeTestDb} database lives in, for a second handle. */
export function lastTestDbDir(): string {
  return dirs[dirs.length - 1];
}

afterEach(async () => {
  for (const db of open.splice(0)) await db.close();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

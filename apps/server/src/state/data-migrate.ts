/**
 * SQLite → Postgres state migration.
 *
 * The move that makes "choose your database" true for an EXISTING deployment
 * rather than only a fresh one: it copies every row of a live `lastlight.db`
 * into a Postgres server, table by table, through the two Drizzle schemas.
 *
 * **Why this is a read-and-insert loop and not a dump/restore.** Both schemas
 * carry the same `$type<T>()` on every column, and Drizzle maps values at the
 * driver boundary in both directions — so a `boolean` column arrives from
 * SQLite as a JS `true` and goes into Postgres as a real `true`, and a
 * `text({mode:'json'})` column arrives as a parsed object and goes into `jsonb`
 * as one. The JS value in the middle is dialect-neutral, which is exactly what
 * `pg_dump`-style text transport is not: it would have to know that `success`
 * is `0/1` here and `false` there, and that `context` is a string here and a
 * document there.
 *
 * Direction is deliberately one-way. Postgres → SQLite is not supported and is
 * not a symmetric problem (identity columns, jsonb key order, wider integers).
 *
 * ## Invariants
 *
 * - **Both ends are migrated first.** Each side is opened through
 *   `StateDb.open()`, so the source gets the legacy-compat pre-step + its
 *   journalled migrations and the target gets `drizzle/pg`. Copying between two
 *   different schema versions is the failure this prevents.
 * - **FK order is load-bearing** for exactly one pair —
 *   `messaging_sessions` → `messaging_messages`, the only declared foreign key
 *   in the 15-table schema. {@link TABLE_ORDER} encodes it.
 * - **The target must be empty**, unless `truncate` is passed. Copying into a
 *   populated database would half-succeed on primary-key collisions and leave
 *   an interleaved mess that is worse than either input.
 * - **Every table is covered or the migration refuses to start.** The coverage
 *   check against the schema's own exports is what stops a 16th table added
 *   later from being silently left behind — the failure mode of a hand-kept
 *   list, and one nobody would notice until the data was already gone.
 */
import { is, Table, asc, sql, type Column } from "drizzle-orm";
import { StateDb } from "./db.js";
import { tablesOf, type StateClient, type StateTables } from "./client.js";
import * as sqliteSchema from "./schema/sqlite.js";
import { type PgDriver } from "lastlight-shared/database-url";

/** The schema export names, in an order no foreign key can object to. */
type TableKey = keyof StateTables;

interface TableSpec {
  key: TableKey;
  /** Property names forming a stable total order, so batched reads cannot skip or repeat a row. */
  orderBy: string[];
  /**
   * Columns the TARGET generates and an insert must not supply. Only
   * `messaging_messages.id`, which is `AUTOINCREMENT` on SQLite and
   * `GENERATED ALWAYS AS IDENTITY` on Postgres — the latter rejects an explicit
   * value outright. Nothing references that id, so letting Postgres re-assign
   * it loses nothing; reading in id order keeps the message sequence intact.
   */
  omit?: string[];
}

export const TABLE_ORDER: readonly TableSpec[] = [
  { key: "executions", orderBy: ["id"] },
  { key: "workflowRuns", orderBy: ["id"] },
  { key: "workflowApprovals", orderBy: ["id"] },
  { key: "cronOverrides", orderBy: ["name"] },
  { key: "cronRuns", orderBy: ["id"] },
  { key: "workflowOverrides", orderBy: ["name"] },
  { key: "users", orderBy: ["id"] },
  { key: "feedbackAnchors", orderBy: ["id"] },
  { key: "feedbackSignals", orderBy: ["id"] },
  { key: "githubTeams", orderBy: ["org", "slug"] },
  { key: "githubTeamRepos", orderBy: ["org", "teamSlug", "repo"] },
  { key: "githubTeamMembers", orderBy: ["org", "teamSlug", "login"] },
  { key: "githubVisibilitySync", orderBy: ["login"] },
  // ── The one foreign key in the schema: sessions before their messages. ──
  { key: "messagingSessions", orderBy: ["id"] },
  { key: "messagingMessages", orderBy: ["id"], omit: ["id"] },
];

export interface MigrateStateDataOptions {
  /** Source: a SQLite path, `file:` URL or `:memory:` — anything `StateDb.open` takes. */
  from: string;
  /** Target: a `postgres://` URL. */
  to: string;
  /** Postgres driver override; unset auto-detects from the target host. */
  driver?: PgDriver;
  /** Rows per read/insert round trip. */
  batchSize?: number;
  /** Count and report without writing anything. */
  dryRun?: boolean;
  /** Delete existing target rows first. Without it a non-empty target aborts. */
  truncate?: boolean;
  /** Progress sink. The CLI renders these; callers that don't care omit it. */
  onProgress?: (event: MigrateProgress) => void;
}

export type MigrateProgress =
  | { type: "start"; tables: number }
  | { type: "table-start"; table: string; rows: number }
  | { type: "batch"; table: string; copied: number; rows: number }
  | { type: "table-done"; table: string; copied: number }
  | { type: "done"; totalRows: number; durationMs: number };

export interface TableResult {
  table: string;
  /** Rows read from the source. */
  source: number;
  /** Rows inserted into the target. */
  copied: number;
  /** Rows counted in the target afterwards — the verification pass. */
  target: number;
}

/**
 * A migration failure that knows whether anything was written yet.
 *
 * The distinction is the whole difference between two operator actions: a
 * refusal *before* the first insert (wrong direction, occupied target) leaves
 * the target exactly as it was and wants the input fixed; a failure *after*
 * leaves a partially-filled database that must be truncated before a retry.
 * Telling someone to truncate a database this run never touched is how they
 * end up deleting the wrong one.
 */
export class StateMigrationError extends Error {
  constructor(
    message: string,
    /** True if at least one row may have been inserted before the failure. */
    readonly wrote: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "StateMigrationError";
  }
}

export interface MigrateStateDataResult {
  tables: TableResult[];
  totalRows: number;
  durationMs: number;
  dryRun: boolean;
}

/**
 * Copy every row from a SQLite state database into a Postgres one.
 *
 * Not transactional as a whole, and cannot be: 15 tables and potentially
 * hundreds of thousands of rows in one Postgres transaction is a recipe for a
 * bloated WAL and a lock held for minutes. The design point that makes that
 * acceptable is the empty-target precondition — a failed run leaves a
 * partially-filled database that is safe to `--truncate` and retry, and the
 * verification pass names exactly where it stopped.
 *
 * **Take a snapshot of the source first.** Opening it runs the source's own
 * migrations (that is the point — both ends must be at the same schema
 * version), which is a write. The harness should be stopped, or the source
 * should be a copy: never point this at a database a running Last Light is
 * writing to.
 */
export async function migrateStateData(
  opts: MigrateStateDataOptions,
): Promise<MigrateStateDataResult> {
  const source = await StateDb.open(opts.from);
  let target: StateDb | undefined;
  try {
    target = await StateDb.open(opts.to, { driver: opts.driver });
    return await copyStateData(source, target, opts);
  } finally {
    await source.close();
    await target?.close();
  }
}

/**
 * The copy itself, over two already-open databases.
 *
 * Separate from {@link migrateStateData} so it can be driven against a PGlite
 * target in the hermetic test suite: PGlite has no URL, so a function that owns
 * its own `open()` calls could only ever be tested against a real server, and
 * the whole value-mapping contract would go unexercised in CI.
 */
export async function copyStateData(
  source: StateDb,
  target: StateDb,
  opts: Omit<MigrateStateDataOptions, "from" | "to" | "driver">,
): Promise<MigrateStateDataResult> {
  const batchSize = opts.batchSize && opts.batchSize > 0 ? Math.floor(opts.batchSize) : 500;
  const started = Date.now();
  const report = opts.onProgress ?? (() => {});

  assertCoversEveryTable();

  if (source.dialect !== "sqlite") {
    throw new StateMigrationError(
      `Source must be a SQLite database (got dialect "${source.dialect}"). ` +
        "Postgres → SQLite is not supported.",
      false,
    );
  }
  if (target.dialect !== "postgres") {
    throw new StateMigrationError(
      `Target must be a Postgres database (got dialect "${target.dialect}").`,
      false,
    );
  }

  const srcTables = tablesOf(source.client);
  const dstTables = tablesOf(target.client);

  // Preflight EVERY table before writing any of them: discovering table 12 is
  // occupied after 11 have been copied is the worst possible time to find out.
  await preflightTarget(target.client, dstTables, opts);

  report({ type: "start", tables: TABLE_ORDER.length });
  const results: TableResult[] = [];
  for (const spec of TABLE_ORDER) {
    try {
      results.push(
        await copyTable(spec, source.client, target.client, srcTables, dstTables, {
          batchSize,
          dryRun: !!opts.dryRun,
          report,
        }),
      );
    } catch (err) {
      // Past the preflight, so earlier tables are already in the target.
      throw new StateMigrationError(
        `Copying ${String(spec.key)} failed: ${describeError(err)}`,
        !opts.dryRun,
        { cause: err },
      );
    }
  }

  const totalRows = results.reduce((n, r) => n + r.copied, 0);
  const durationMs = Date.now() - started;
  report({ type: "done", totalRows, durationMs });

  // The verification pass is not decoration: an insert that silently dropped
  // rows (a partial batch, a swallowed conflict) is invisible otherwise.
  const mismatched = results.filter((r) => !opts.dryRun && r.target !== r.source);
  if (mismatched.length) {
    throw new StateMigrationError(
      "Row-count verification failed after copying — the target does not match the source: " +
        mismatched.map((r) => `${r.table} (${r.source} → ${r.target})`).join(", "),
      true,
    );
  }

  return { tables: results, totalRows, durationMs, dryRun: !!opts.dryRun };
}

/**
 * A hand-maintained table list silently skips whatever is added after it was
 * written, and a state migration that skips a table destroys data without
 * erroring. So the list is checked against the schema's own exports on every
 * run — `schema/sqlite.ts` is the source of truth, and adding a table there
 * fails this loudly until it is placed in {@link TABLE_ORDER} at an
 * FK-respecting position.
 */
export function assertCoversEveryTable(): void {
  const declared = new Set<string>(TABLE_ORDER.map((s) => s.key as string));
  const actual = Object.entries(sqliteSchema)
    .filter(([, value]) => is(value, Table))
    .map(([name]) => name);
  const missing = actual.filter((name) => !declared.has(name));
  const stale = [...declared].filter((name) => !actual.includes(name));
  if (missing.length || stale.length) {
    throw new Error(
      "data-migrate's TABLE_ORDER is out of sync with schema/sqlite.ts" +
        (missing.length ? ` — not copied: ${missing.join(", ")}` : "") +
        (stale.length ? ` — no longer in the schema: ${stale.join(", ")}` : "") +
        ". Add each new table in an order its foreign keys allow.",
    );
  }
}

/**
 * The empty-target rule (or the `--truncate` escape hatch).
 *
 * Deletes in REVERSE {@link TABLE_ORDER}, so `messaging_messages` goes before
 * the `messaging_sessions` rows it references.
 */
async function preflightTarget(
  client: StateClient,
  dstTables: StateTables,
  opts: Pick<MigrateStateDataOptions, "dryRun" | "truncate">,
): Promise<void> {
  if (opts.dryRun) return;
  if (opts.truncate) {
    for (const spec of [...TABLE_ORDER].reverse()) {
      await client.delete(tableOf(dstTables, spec.key) as never);
    }
    return;
  }
  const occupied: string[] = [];
  for (const spec of TABLE_ORDER) {
    const table = tableOf(dstTables, spec.key);
    if ((await countRows(client, table)) > 0) occupied.push(tableName(table));
  }
  if (occupied.length) {
    throw new StateMigrationError(
      `Target database is not empty (${occupied.join(", ")}). ` +
        "Migrate into a fresh database, or pass --truncate to delete the existing rows first.",
      false,
    );
  }
}

interface CopyOpts {
  batchSize: number;
  dryRun: boolean;
  report: (event: MigrateProgress) => void;
}

async function copyTable(
  spec: TableSpec,
  srcClient: StateClient,
  dstClient: StateClient,
  srcTables: StateTables,
  dstTables: StateTables,
  { batchSize, dryRun, report }: CopyOpts,
): Promise<TableResult> {
  const srcTable = tableOf(srcTables, spec.key);
  const dstTable = tableOf(dstTables, spec.key);
  const name = tableName(srcTable);
  const sourceRows = await countRows(srcClient, srcTable);
  report({ type: "table-start", table: name, rows: sourceRows });

  let copied = 0;
  if (!dryRun && sourceRows > 0) {
    const order = spec.orderBy.map((prop) => asc(columnOf(srcTable, prop)));
    for (let offset = 0; offset < sourceRows; offset += batchSize) {
      // Keyset pagination would be faster, but the order columns differ per
      // table (three of them are composite) and these are one-shot migrations
      // over tens of thousands of rows. LIMIT/OFFSET over a stable total order
      // is correct, and correctness is what matters here.
      const batch = (await srcClient
        .select()
        .from(srcTable as never)
        .orderBy(...order)
        .limit(batchSize)
        .offset(offset)) as Record<string, unknown>[];
      if (!batch.length) break;
      const values = spec.omit
        ? batch.map((row) => omitKeys(row, spec.omit!))
        : batch;
      await dstClient.insert(dstTable as never).values(values as never);
      copied += batch.length;
      report({ type: "batch", table: name, copied, rows: sourceRows });
    }
  }

  report({ type: "table-done", table: name, copied });
  return {
    table: name,
    source: sourceRows,
    copied,
    target: dryRun ? 0 : await countRows(dstClient, dstTable),
  };
}

/**
 * The message a human can act on, from anywhere in the cause chain.
 *
 * Drizzle wraps every driver error in a `DrizzleQueryError` whose message is
 * just the SQL it was running, so the actual reason — "password authentication
 * failed", "no such table" — is one or two levels down. Reporting only the top
 * of the chain turns every failure into "Failed query: select 1".
 */
export function describeError(error: unknown): string {
  const parts: string[] = [];
  for (let e: unknown = error, depth = 0; e != null && depth < 6; depth++) {
    const message = (e as { message?: string }).message;
    if (message && !parts.includes(message)) parts.push(message);
    e = (e as { cause?: unknown }).cause;
  }
  if (!parts.length) return String(error);
  if (parts.length === 1) return parts[0];
  // The innermost cause is the reason; the outermost is which query was
  // running, worth keeping but only its first line — Drizzle appends the full
  // statement and a `params:` dump, which buries the reason it wraps.
  return `${parts.at(-1)} (while running: ${parts[0].split("\n")[0]})`;
}

function omitKeys(row: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) if (!keys.includes(k)) out[k] = v;
  return out;
}

async function countRows(client: StateClient, table: Table): Promise<number> {
  const [row] = (await client
    .select({ n: sql<number>`count(*)` })
    .from(table as never)) as { n: number | string }[];
  // int8 arrives as a string from a real pg driver without the OID-20 parser;
  // `makePgClient` registers it, but this must not depend on that to be right.
  return Number(row?.n ?? 0);
}

/**
 * The schema objects are resolved per dialect off the client (`tablesOf`), so
 * they are only weakly typed at this level — the two schemas mirror each other
 * export-for-export (`schema-parity.test.ts` is the guard), which is what makes
 * indexing one with the other's key sound.
 */
function tableOf(tables: StateTables, key: TableKey): Table {
  const table = tables[key] as unknown as Table | undefined;
  if (!table || !is(table, Table)) {
    throw new Error(`Schema has no table export "${String(key)}" — schemas out of sync.`);
  }
  return table;
}

function columnOf(table: Table, prop: string): Column {
  const column = (table as unknown as Record<string, Column>)[prop];
  if (!column) {
    throw new Error(`Table ${tableName(table)} has no column property "${prop}".`);
  }
  return column;
}

function tableName(table: Table): string {
  return (table as unknown as { [k: symbol]: unknown })[
    (Table as unknown as { Symbol: { Name: symbol } }).Symbol.Name
  ] as string;
}

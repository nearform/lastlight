/**
 * Portability seam.
 *
 * Raw-SQL execution, rows-affected shape, unique-violation detection and a
 * handful of SQL functions are the only surfaces that differ between
 * `drizzle-orm/libsql` and a Postgres driver. Everything else the stores do
 * goes through the shared query-builder API, which is identical.
 *
 * IMPORTANT — `rows()` results are NOT column-mapped by Drizzle. No boolean
 * conversion, no JSON parsing, no camelCase renaming: a raw query must alias
 * its own columns and treat booleans as 0/1 integers. Only builder queries
 * (`client.select()…`) return mapped rows. Mixing the two up is the #1
 * regression class in this migration.
 */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";
import type { StateDbc } from "./client.js";

type RawCapable = {
  all?: (q: SQL) => Promise<unknown>;
  run?: (q: SQL) => Promise<unknown>;
  execute?: (q: SQL) => Promise<unknown>;
};

/** Run a raw query and return all rows. libsql: `.all(sql)`. pg: `.execute(sql)` → `{rows}`. */
export async function rows<T = Record<string, unknown>>(
  dbc: StateDbc,
  query: SQL,
): Promise<T[]> {
  const d = dbc as unknown as RawCapable;
  if (typeof d.all === "function") return (await d.all(query)) as T[];
  const res = (await d.execute!(query)) as { rows?: T[] } | T[];
  return (Array.isArray(res) ? res : (res.rows ?? [])) as T[];
}

/** Run a raw statement for its side effect. Feed the result to {@link changes}. */
export async function run(dbc: StateDbc, query: SQL): Promise<unknown> {
  const d = dbc as unknown as RawCapable;
  if (typeof d.run === "function") return d.run(query);
  return d.execute!(query);
}

/**
 * Rows-affected from an awaited builder mutation (or {@link run}).
 *
 * libsql `ResultSet` → `.rowsAffected`; node-postgres `QueryResult` →
 * `.rowCount`; PGlite → `.affectedRows`; better-sqlite3 → `.changes`. Replaces
 * every `result.changes` read in the old code — the compare-and-set guards
 * behind the approval/reply-gate lifecycle depend on this being exact.
 */
export function changes(result: unknown): number {
  const r = result as {
    rowsAffected?: number;
    rowCount?: number | null;
    affectedRows?: number;
    changes?: number | bigint;
  } | null;
  return Number(r?.rowsAffected ?? r?.rowCount ?? r?.affectedRows ?? r?.changes ?? 0);
}

/**
 * UNIQUE-violation detection across drivers: Postgres reports SQLSTATE 23505 on
 * a `code` property somewhere down the cause chain (Drizzle wraps driver errors
 * in `DrizzleQueryError`), SQLite says so in the message.
 */
export function isUniqueViolation(error: unknown): boolean {
  for (
    let e: unknown = error, depth = 0;
    e != null && depth < 6;
    e = (e as { cause?: unknown }).cause, depth++
  ) {
    if ((e as { code?: string }).code === "23505") return true;
    if (e instanceof Error && /UNIQUE|unique constraint/i.test(e.message)) return true;
  }
  return false;
}

/** Escape `%`, `_` and `\` for a `LIKE … ESCAPE '\'` pattern. */
export function likeEscape(input: string): string {
  return input.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/**
 * UTC day bucket over an ISO-8601 TEXT column — replaces sqlite `date(col)`.
 * Timestamps are ISO text in both dialects, so `substr` yields identical
 * `YYYY-MM-DD` keys and the JS side's bucket keys keep matching.
 */
export function dayBucket(col: SQLWrapper): SQL {
  return sql`substr(${col}, 1, 10)`;
}

/** UTC hour bucket (`YYYY-MM-DDTHH`) — replaces `strftime('%Y-%m-%dT%H', col)`. */
export function hourBucket(col: SQLWrapper): SQL {
  return sql`substr(${col}, 1, 13)`;
}

/**
 * Position of `needle` within `haystack`, 1-based, 0 when absent.
 *
 * sqlite spells this `instr(h, n)`; Postgres has no `instr` at all and spells
 * it `strpos(h, n)`. This is the single widest-reaching fragment in the
 * codebase — `repo-ref.ts`'s qualified-repo split fans out to 13 call sites
 * across the execution and run stores.
 */
export function strposExpr(haystack: SQLWrapper, needle: SQLWrapper | string): SQL {
  const n = typeof needle === "string" ? sql`${needle}` : needle;
  return sql`instr(${haystack}, ${n})`;
}

/**
 * `SUM(CASE WHEN <col> THEN 1 ELSE 0 END)` — count of TRUE.
 *
 * Truthiness works on both sqlite 0/1 and pg boolean, and NULL falls to ELSE,
 * which is what keeps a still-running execution (`success IS NULL`) out of both
 * the success and the failure tally.
 */
export function sumTrue(col: SQLWrapper): SQL {
  return sql`SUM(CASE WHEN ${col} THEN 1 ELSE 0 END)`;
}

/**
 * `SUM(CASE WHEN <col> = false THEN 1 ELSE 0 END)` — count of FALSE.
 *
 * Deliberately an explicit comparison against a BOUND `false` param, not
 * `WHEN NOT <col>`: `NOT NULL` is NULL, which would be correct here by
 * accident, but the bound parameter is also what keeps this portable — libsql
 * binds `false` as 0 and pg as a real boolean. A literal `= 0` makes Postgres
 * throw `operator does not exist: boolean = integer`.
 */
export function sumFalse(col: SQLWrapper): SQL {
  return sql`SUM(CASE WHEN ${col} = ${false} THEN 1 ELSE 0 END)`;
}

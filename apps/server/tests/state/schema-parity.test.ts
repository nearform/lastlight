/**
 * Structural drift guard between the two schemas.
 *
 * Add a column or an index to `schema/sqlite.ts` and forget `schema/pg.ts` (or
 * the reverse) and this fails, naming the table, the side and the column —
 * before the PGlite leg fails somewhere far less legible. Technique from
 * finius's `tests/schema-cross-parity.test.ts`: `getTableConfig` from BOTH
 * cores, normalized to a dialect-independent shape, deep-equalled.
 *
 * ## What this test deliberately does NOT compare
 *
 * - **Column TYPES.** jsonb-vs-text, boolean-vs-integer, doublePrecision-vs-real
 *   and identity-vs-autoincrement divergence is the entire point of the pg
 *   schema. A type mistake surfaces instead as a store compile error or a
 *   PG-leg behavioural failure.
 * - **Index column ORDER MODIFIERS.** pg-core has a real `.desc()`; sqlite-core
 *   has no such API, so its twin spells the same thing as a `sql` expression
 *   from which the direction cannot be read back. Column NAMES are compared;
 *   the direction is not.
 * - **Partial-index WHERE text.** sqlite says `active = 1`, pg says `active`.
 *   Only the PRESENCE of a WHERE clause is compared.
 * - **Default VALUES.** `'[]'` vs `'[]'::jsonb` is the same value in two
 *   dialects' spellings. Whether a column HAS a default is compared.
 *
 * Do not "fix" any of those into the comparison.
 */
import { describe, expect, it } from "vitest";
import { is, Table } from "drizzle-orm";
import { getTableConfig as pgTableConfig } from "drizzle-orm/pg-core";
import { getTableConfig as sqliteTableConfig } from "drizzle-orm/sqlite-core";
import * as pgSchema from "#src/state/schema/pg.js";
import * as sqliteSchema from "#src/state/schema/sqlite.js";

/**
 * The export names that are Tables, DERIVED rather than hand-listed — a
 * hardcoded array silently stops covering a table the day someone adds one to
 * both schemas and forgets this file, which is exactly the drift this exists to
 * catch.
 */
function tableExports(schema: Record<string, unknown>): string[] {
  return Object.entries(schema)
    .filter(([, v]) => is(v, Table))
    .map(([k]) => k)
    .sort();
}

/**
 * An index/PK key column's name. pg-core hands back a column (or an
 * `IndexedColumn` from `.desc()`), both of which carry `.name`; sqlite-core's
 * DESC keys are `sql` expressions instead, so dig the column out of the
 * template's chunks.
 */
function colName(c: unknown): string {
  const direct = (c as { name?: unknown }).name;
  if (typeof direct === "string") return direct;
  const chunks = (c as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(chunks)) {
    const names = chunks
      .map((k) => (k as { name?: unknown }).name)
      .filter((n): n is string => typeof n === "string");
    if (names.length > 0) return names.join(",");
  }
  return String(c);
}

type NormalizedColumn = {
  name: string;
  notNull: boolean;
  primary: boolean;
  /**
   * COLUMN-level `UNIQUE` (`users.github_id` / `login` / `slack_user_id`).
   * Neither core reports these under `uniqueConstraints` — that list holds only
   * the table-level `unique().on(...)` form — so without this the three on
   * `users` would be compared by nothing at all.
   */
  unique: boolean;
  hasDefault: boolean;
};

type NormalizedTable = {
  name: string;
  columns: NormalizedColumn[];
  primaryKeys: string[][];
  indexes: { name: string; unique: boolean; partial: boolean; columns: string[] }[];
  uniqueConstraints: { columns: string[] }[];
  foreignKeys: { columns: string[]; foreignColumns: string[] }[];
};

type AnyTableConfig = {
  name: string;
  columns: {
    name: string;
    notNull: boolean;
    primary: boolean;
    isUnique?: boolean;
    hasDefault?: boolean;
  }[];
  primaryKeys: { columns: unknown[] }[];
  indexes: { config: { name?: string; unique?: boolean; where?: unknown; columns: unknown[] } }[];
  uniqueConstraints: { columns: { name: string }[] }[];
  foreignKeys: { reference: () => { columns: { name: string }[]; foreignColumns: { name: string }[] } }[];
};

function normalize(cfg: AnyTableConfig): NormalizedTable {
  return {
    name: cfg.name,
    columns: cfg.columns
      .map((c) => ({
        name: c.name,
        notNull: c.notNull,
        primary: c.primary,
        unique: Boolean(c.isUnique),
        hasDefault: Boolean(c.hasDefault),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    // Composite PK membership AND order — order is load-bearing for the three
    // github_team* tables' index prefixes.
    primaryKeys: cfg.primaryKeys.map((pk) => pk.columns.map(colName)),
    indexes: cfg.indexes
      .map((i) => ({
        name: i.config.name ?? "",
        unique: Boolean(i.config.unique),
        partial: Boolean(i.config.where),
        columns: i.config.columns.map(colName),
      }))
      .sort((a, b) => a.name.localeCompare(b.name)),
    // Compared by COLUMNS, not name: drizzle auto-names these and the two
    // cores' generated names are not guaranteed to agree.
    uniqueConstraints: cfg.uniqueConstraints
      .map((u) => ({ columns: u.columns.map((c) => c.name) }))
      .sort((a, b) => a.columns.join().localeCompare(b.columns.join())),
    foreignKeys: cfg.foreignKeys
      .map((fk) => {
        const ref = fk.reference();
        return {
          columns: ref.columns.map((c) => c.name),
          foreignColumns: ref.foreignColumns.map((c) => c.name),
        };
      })
      .sort((a, b) => a.columns.join().localeCompare(b.columns.join())),
  };
}

describe("schema parity: sqlite ↔ pg", () => {
  const sqliteNames = tableExports(sqliteSchema as Record<string, unknown>);
  const pgNames = tableExports(pgSchema as Record<string, unknown>);

  it("exports the same set of tables from both schema modules", () => {
    expect(
      sqliteNames.filter((n) => !pgNames.includes(n)),
      "tables exported by schema/sqlite.ts but not schema/pg.ts",
    ).toEqual([]);
    expect(
      pgNames.filter((n) => !sqliteNames.includes(n)),
      "tables exported by schema/pg.ts but not schema/sqlite.ts",
    ).toEqual([]);
  });

  it("covers all 16 tables", () => {
    expect(sqliteNames).toHaveLength(16);
    expect(pgNames).toHaveLength(16);
  });

  for (const name of tableExports(sqliteSchema as Record<string, unknown>)) {
    describe(name, () => {
      const sqliteTable = (sqliteSchema as unknown as Record<string, never>)[name];
      const pgTable = (pgSchema as unknown as Record<string, never>)[name];
      const sqliteCfg = normalize(sqliteTableConfig(sqliteTable) as unknown as AnyTableConfig);
      const pgCfg = normalize(pgTableConfig(pgTable) as unknown as AnyTableConfig);

      it("has the same columns, with the same nullability, PK, unique and default flags", () => {
        const sqliteCols = sqliteCfg.columns.map((c) => c.name);
        const pgCols = pgCfg.columns.map((c) => c.name);
        expect(
          sqliteCols.filter((c) => !pgCols.includes(c)),
          `${name}: columns in sqlite but not pg`,
        ).toEqual([]);
        expect(
          pgCols.filter((c) => !sqliteCols.includes(c)),
          `${name}: columns in pg but not sqlite`,
        ).toEqual([]);
        expect(pgCfg.columns).toEqual(sqliteCfg.columns);
      });

      it("has the same table name, PKs, indexes, unique constraints and FKs", () => {
        expect(pgCfg.name).toBe(sqliteCfg.name);
        expect(pgCfg.primaryKeys).toEqual(sqliteCfg.primaryKeys);
        expect(pgCfg.indexes).toEqual(sqliteCfg.indexes);
        expect(pgCfg.uniqueConstraints).toEqual(sqliteCfg.uniqueConstraints);
        expect(pgCfg.foreignKeys).toEqual(sqliteCfg.foreignKeys);
      });
    });
  }
});

import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config for the Postgres dialect.
 *
 * Sibling of `drizzle-sqlite.config.ts`, and lives at the package root for the
 * same reason: outside `tsconfig.json`'s `src/**` include, so
 * `pnpm --filter lastlight-core build` never compiles it.
 *
 * Unlike the sqlite baseline — hand-edited to be idempotent over a
 * journal-less legacy production database, the one sanctioned exception —
 * `drizzle/pg/` targets FRESH databases only (a PGlite instance per test).
 * There is no legacy story here, so its generated output is committed exactly
 * as generated and hand-editing it is forbidden.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/state/schema/pg.ts",
  out: "./drizzle/pg",
});

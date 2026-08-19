import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config for the Postgres dialect.
 *
 * Sibling of `drizzle-sqlite.config.ts`, and lives at the package root for the
 * same reason: outside `tsconfig.json`'s `src/**` include, so
 * `pnpm --filter lastlight-core build` never compiles it.
 *
 * Its generated output is committed exactly as generated, and hand-editing it
 * is forbidden. The sqlite baseline's `IF NOT EXISTS` edit was a one-off
 * concession to a journal-less legacy production database; there is no such
 * legacy here, so the exception does not carry over.
 *
 * `drizzle/pg/` was test-only when it was written (a PGlite instance per test,
 * always fresh). It is NOT any more — #352 made Postgres a production runtime.
 * So `0000_init.sql` is immutable exactly like the sqlite baseline the moment a
 * real deployment records it in `__drizzle_migrations`: a schema change is a
 * NEW numbered migration from `db:generate:pg`, never a regenerated init file.
 *
 * See `src/state/CLAUDE.md` for the full change procedure.
 */
export default defineConfig({
  dialect: "postgresql",
  schema: "./src/state/schema/pg.ts",
  out: "./drizzle/pg",
});

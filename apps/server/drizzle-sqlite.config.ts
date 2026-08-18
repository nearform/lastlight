import { defineConfig } from "drizzle-kit";

/**
 * drizzle-kit config for the SQLite (production) dialect.
 *
 * Lives at the package root, outside `tsconfig.json`'s `src/**` include — so
 * `pnpm --filter lastlight-core build` never compiles it; drizzle-kit loads it
 * with its own loader.
 */
export default defineConfig({
  dialect: "sqlite",
  schema: "./src/state/schema/sqlite.ts",
  out: "./drizzle/sqlite",
});

/**
 * The SQLite leg of the `SessionManager` suite.
 *
 * Keep exactly ONE runner per factory — a second file calling
 * `runSessionManagerSuite` would double-run it.
 */
import { vi } from "vitest";

// The legacy compat pre-step logs via the pino LoggerPort — mock the logger
// module so the suite's stderr stays free of real pino JSON (no assertions
// here depend on the logged content).
vi.mock("#src/logging/logger.js", () => {
  const noopLogger = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: () => noopLogger,
  };
  return { logger: () => noopLogger };
});

import { createClient } from "@libsql/client";
import { drizzle } from "drizzle-orm/libsql";
import { migrate as drizzleMigrate } from "drizzle-orm/libsql/migrator";
import { fileURLToPath } from "url";
import { SessionManager } from "#src/connectors/messaging/session-manager.js";
import { applyLegacySqliteCompat } from "#src/state/legacy-sqlite.js";
import * as sqliteSchema from "#src/state/schema/sqlite.js";
import { runSessionManagerSuite, type SessionSuiteCtx } from "./session-manager-suite.js";

const MIGRATIONS_FOLDER = fileURLToPath(new URL("../../../drizzle/sqlite", import.meta.url));

/**
 * The same construction path `src/index.ts` uses — raw client → compat pre-step
 * → migrator → `new SessionManager(client, dialect)` — rather than a `StateDb`,
 * because `SessionManager` is not reachable through one. Phase 4's PGlite
 * `makeCtx` has the identical shape.
 *
 * `:memory:` is correct here (locked decision 12 applies only to transacting
 * suites): `SessionManager` never opens a `client.transaction()`.
 */
async function makeCtx(): Promise<SessionSuiteCtx> {
  const raw = createClient({ url: ":memory:" });
  await applyLegacySqliteCompat(raw);
  const client = drizzle(raw, { schema: sqliteSchema });
  await drizzleMigrate(client, { migrationsFolder: MIGRATIONS_FOLDER });
  return {
    manager: new SessionManager(client, "sqlite"),
    client,
    close: async () => raw.close(),
  };
}

runSessionManagerSuite(makeCtx, { dialect: "sqlite" });

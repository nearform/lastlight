/**
 * The Postgres leg of the `SessionManager` suite — the SECOND factory.
 *
 * `SessionManager` is not reachable through `StateDb` (it is built from a
 * `StateClient` + dialect, wired in `src/index.ts`), so it has its own context
 * factory and its own runner per dialect. Easy to forget: without this file the
 * PG leg would cover the seven stores and none of the messaging tables — which
 * are where the partial unique index, the null-safe `thread_id IS ?` compare and
 * the identity PK live.
 *
 * There is deliberately no PG analogue of `session-manager.legacy.test.ts`: it
 * drives `applyLegacySqliteCompat` over a raw libsql handle and is correctly
 * sqlite-only.
 */
import { vi } from "vitest";

// `vi.mock` is hoisted per test FILE and does nothing from an imported suite
// module, so each runner carries its own copy.
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

import { drizzle } from "drizzle-orm/pglite";
import { SessionManager } from "#src/connectors/messaging/session-manager.js";
import { asStateClient } from "#src/state/client.js";
import * as pgSchema from "#src/state/schema/pg.js";
import { runSessionManagerSuite, type SessionSuiteCtx } from "./session-manager-suite.js";
import { migratedPglite } from "../../helpers/pglite.js";

/**
 * Mirrors the sqlite runner's `makeCtx`, swapping the raw libsql client for a
 * reset, migrated PGlite (`../../helpers/pglite.ts`) and skipping the legacy
 * compat pre-step (there is no legacy Postgres database to repair —
 * `drizzle/pg/` is fresh-DB only).
 *
 * `close` is a no-op: `runSessionManagerSuite` calls `ctx.close()` in its own
 * `afterEach`, but the instance is shared by the whole file and the helper
 * closes it once, after the last test.
 */
async function makeCtx(): Promise<SessionSuiteCtx> {
  // `{ schema }` is required: `tablesOf()` reads it back off the client to give
  // `SessionManager` the pg table objects rather than the sqlite ones.
  const client = asStateClient(drizzle(await migratedPglite(), { schema: pgSchema }));
  return {
    manager: new SessionManager(client, "postgres"),
    client,
    close: async () => {},
  };
}

runSessionManagerSuite(makeCtx, { dialect: "postgres" });

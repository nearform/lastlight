/**
 * The SQLite leg of the state-store suite.
 *
 * Every assertion lives in `store-suite.ts` (and `suites/`), so the Postgres
 * leg runs the identical bodies. Keep exactly ONE runner per factory — a second
 * file calling `runStateDbSuite` would double-run the whole suite.
 */
import { vi } from "vitest";

// Several of the moved suites drive code paths that log through the pino
// LoggerPort (the throwing terminal observer, StateDb's siblings). `vi.mock` is
// hoisted per test FILE and cannot live in an imported suite module, so the
// runner owns it — it keeps the run's stderr free of real pino JSON, and no
// assertion anywhere in the suite depends on logged content.
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

import { runStateDbSuite } from "./store-suite.js";
import { makeTestDb } from "../helpers/state-db.js";

// `makeTestDb` is file-backed per test and registers its own cleanup — locked
// decision 12: the suite exercises the five named atomic ops, and the libsql
// client opens a NEW connection after every transaction, so a fresh `:memory:`
// connection would be an empty database.
runStateDbSuite(makeTestDb, { dialect: "sqlite" });

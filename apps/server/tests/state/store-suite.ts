/**
 * The dialect-parameterized state-layer test suite.
 *
 * Every behavioural assertion about a store lives under here rather than in a
 * `*.test.ts` of its own, so the Postgres leg (Phase 4) runs the *identical*
 * test bodies instead of a hand-maintained subset that silently diverges. The
 * sqlite leg is `tests/state/db.test.ts`; a PGlite leg calls the same export
 * with its own `makeDb`.
 *
 * Deliberately NOT named `*.test.ts` — vitest's include pattern is
 * `tests/**\/*.test.ts` (`vitest.config.ts`), so this module and everything
 * under `suites/` are imported, never collected.
 *
 * **All mutable state is function-scoped.** Two invocations may share one
 * process (a co-located dual-dialect file), so nothing may live at module
 * scope. Each sub-suite opens its own database per test via `makeDb`.
 */
import { describe } from "vitest";
import type { StateDb } from "#src/state/db.js";

import { runActivitySuite } from "./suites/activity-suite.js";
import { runApprovalsSuite } from "./suites/approvals-suite.js";
import { runConcurrencySuite } from "./suites/concurrency-suite.js";
import { runCronRunsSuite } from "./suites/cron-runs-suite.js";
import { runExecutionsSuite } from "./suites/executions-suite.js";
import { runFeedbackSuite } from "./suites/feedback-suite.js";
import { runRepoRefSuite } from "./suites/repo-ref-suite.js";
import { runTeamsSuite } from "./suites/teams-suite.js";
import { runUsersSuite } from "./suites/users-suite.js";
import { runWorkflowRunsSuite } from "./suites/workflow-runs-suite.js";

export type Dialect = "sqlite" | "postgres";

/** A pristine, migrated `StateDb` per call. The sqlite leg hands out a temp FILE. */
export type MakeDb = () => Promise<StateDb>;

export interface SuiteOpts {
  dialect: Dialect;
}

/**
 * Run the whole state-store suite against one dialect.
 *
 * `makeDb` must return a *pristine* database on every call — it is invoked once
 * per test. It must also register its own teardown (the sqlite leg's
 * `makeTestDb()` does), so the suite never closes a database it did not open;
 * closing twice is a double-free.
 */
export function runStateDbSuite(makeDb: MakeDb, opts: SuiteOpts): void {
  describe(`state stores [${opts.dialect}]`, () => {
    runWorkflowRunsSuite(makeDb, opts);
    runApprovalsSuite(makeDb, opts);
    runExecutionsSuite(makeDb, opts);
    runUsersSuite(makeDb, opts);
    runTeamsSuite(makeDb, opts);
    runFeedbackSuite(makeDb, opts);
    runCronRunsSuite(makeDb, opts);
    runActivitySuite(makeDb, opts);
    runRepoRefSuite(makeDb, opts);
    runConcurrencySuite(makeDb, opts);
  });
}

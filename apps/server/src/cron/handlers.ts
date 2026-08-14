/**
 * The host-side cron handler registry — what a cron YAML's `handler:` key may
 * name (see `CronWorkflowSchema` in the workflow engine for why that key
 * exists).
 *
 * A handler is plain code in the harness process: no sandbox, no agent, no
 * `workflow_runs` row. It receives the same tick context a workflow dispatch
 * would have — `repos`, the YAML's own `context:` keys, and the two control
 * keys (`_cronName`, `_cronGloballyEnabled`) — so it can and MUST narrow the
 * repo list through `resolveCronRepos` itself, exactly as the discovery crons
 * do. Nothing upstream does it for a handler: `dispatchCronWorkflow` is the
 * workflow path only.
 *
 * The registry is BUILT, not imported as a constant, because every handler
 * needs collaborators that only exist once the server has booted (the DB, the
 * GitHub client, the Slack connector). `index.ts` calls this after those are
 * constructed and hands the result to `getJobs`.
 *
 * ## Every invocation is recorded in the ledger
 *
 * A handler cron has no `workflow_runs` row, so without this it would be
 * invisible: the scheduler's consecutive-failure alerting had nothing to count,
 * and the admin `/crons` view reported a healthy-looking `recentFailures: 0`
 * beside a cron that might have been failing for weeks. For a **weekly** cron
 * that is the difference between noticing a revoked Slack token on Monday and
 * noticing it next month.
 *
 * So `withLedger` wraps every registered handler in a `cron_runs` row, keyed by
 * the cron's name — the same ledger, keyed the same way, that a workflow cron's
 * fire writes via `makeCronRunner` (`./runner.ts`). One row per fire whatever
 * kind of cron it is, so `GET /crons` and the scheduler's consecutive-failure
 * alert read one table and never branch on the kind.
 *
 * (These rows lived in `executions` until issues #341/#327. That table has no
 * column for a fan-out's counts, its `success` flag is binary so a `partial`
 * fire has nowhere to live, and #327 measured its `success` column as unusable
 * for cron health — 251 quota-deferral and cascade-skip rows in a day against
 * zero real failures.)
 *
 * The wrap lives HERE rather than in the scheduler because the admin "Run now"
 * route invokes the registry directly, and a manual fire that skipped the
 * ledger would leave exactly the gap this closes.
 */

import type { StateDb } from "../state/db.js";
import { runRepoDigest, type RepoDigestDeps } from "./repo-digest.js";
import { logger } from "../logging/logger.js";

const log = logger("cron-handlers");

/** A handler takes the tick context and does its own work. */
export type CronHandler = (context: Record<string, unknown>) => Promise<void>;

/** Name → handler. `jobs.ts` drops (and warns about) a cron naming a key not in here. */
export type CronHandlerRegistry = Record<string, CronHandler>;

export interface CronHandlerDeps {
  db: StateDb;
  /**
   * Everything the digest needs. `undefined` when the deployment can't run it
   * at all (no GitHub client — chat-only mode; or no Slack connector), in which
   * case `repo-digest` is simply absent from the registry and `jobs.ts` drops
   * the cron with a warning naming it. That warning is the point: silently
   * registering a cron that can never do anything is how the old delivery path
   * stayed broken.
   */
  digest?: RepoDigestDeps;
}

export function buildCronHandlers(deps: CronHandlerDeps): CronHandlerRegistry {
  const registry: CronHandlerRegistry = {};
  if (deps.digest) {
    const digestDeps = deps.digest;
    registry["repo-digest"] = withLedger(deps.db, "repo-digest", (context) =>
      runRepoDigest(digestDeps, context),
    );
  }
  return registry;
}

/**
 * Wrap a handler so each invocation writes one `cron_runs` row.
 *
 * Re-throws on failure: the row is a record, not a swallow. The scheduler still
 * logs and counts, and the admin "Run now" route still surfaces the error to
 * whoever pressed the button.
 */
export function withLedger(db: StateDb, cronName: string, handler: CronHandler): CronHandler {
  return async (context) => {
    const source = context._cronSource === "manual" ? "manual" : "schedule";
    const actor =
      typeof context._cronActor === "string"
        ? context._cronActor
        : typeof context.sender === "string"
          ? context.sender
          : null;

    // Keyed by the CRON's name, exactly as a workflow cron's row is — that is
    // what lets `GET /crons` and the scheduler's alert read ONE ledger and stop
    // branching on which kind of cron they are looking at.
    const id = db.cronRuns.start({ cronName, handler: cronName, source, actor });

    try {
      await handler(context);
      // `workflow`, `dispatched`, `failures` and the repo counts stay null: a
      // handler dispatches nothing, and it narrows its own repo list INSIDE
      // itself (`repo-digest.ts`), which a `Promise<void>` handler cannot report
      // back. Widening `CronHandler` to return counts is a follow-up for when a
      // second handler cron exists to justify it.
      db.cronRuns.finish(id, { status: "ok" });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      db.cronRuns.finish(id, { status: "failed", error: message });
      log.error("Handler cron failed", { cron: cronName, err });
      throw err;
    }
  };
}

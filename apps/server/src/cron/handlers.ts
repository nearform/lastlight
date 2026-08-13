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
 */

import { runRepoDigest, type RepoDigestDeps } from "./repo-digest.js";

/** A handler takes the tick context and does its own work. */
export type CronHandler = (context: Record<string, unknown>) => Promise<void>;

/** Name → handler. `jobs.ts` drops (and warns about) a cron naming a key not in here. */
export type CronHandlerRegistry = Record<string, CronHandler>;

export interface CronHandlerDeps {
  /**
   * Everything the digest needs. `undefined` when the deployment can't run it
   * at all (no GitHub client — chat-only mode), in which case `repo-digest` is
   * simply absent from the registry and `jobs.ts` drops the cron with a warning
   * naming it. That warning is the point: silently registering a cron that can
   * never do anything is how the old delivery path stayed broken for a year.
   */
  digest?: RepoDigestDeps;
}

export function buildCronHandlers(deps: CronHandlerDeps): CronHandlerRegistry {
  const registry: CronHandlerRegistry = {};
  if (deps.digest) {
    const digestDeps = deps.digest;
    registry["repo-digest"] = (context) => runRepoDigest(digestDeps, context);
  }
  return registry;
}

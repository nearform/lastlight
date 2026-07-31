import type { CronJob } from "./scheduler.js";
import { getAccessibleManagedRepos } from "../managed-repos.js";
import { getCronWorkflows } from "../workflows/loader.js";
import { CRON_GLOBALLY_ENABLED_KEY, CRON_NAME_KEY, operatorCrons } from "./repo-crons.js";
import type { CronsConfig } from "../config/config.js";
import type { StateDb } from "../state/db.js";

/**
 * Get cron jobs based on configuration.
 *
 * Cron job definitions are loaded from workflows/cron-*.yaml files. Each
 * cron YAML references an agent workflow by name (workflows/<name>.yaml)
 * which is invoked on each tick. When webhooks are enabled
 * (WEBHOOK_SECRET is set), jobs with `condition.unless: webhooksEnabled`
 * are filtered out — those are handled in real-time via webhook events.
 *
 * When `db` is supplied, cron_overrides rows applied: a schedule override
 * replaces the YAML schedule, and a disabled row turns the cron off globally.
 *
 * "Off globally" is NOT "unregistered" (issue #180). A globally-off cron still
 * gets a tick, marked `_cronGloballyEnabled: false`, because a managed repo may
 * opt itself back in via its `.lastlight/lastlight.yml`. Resolving that at TICK
 * time (see `fanout.ts` → `resolveCronRepos`) is what lets a repo's edit take
 * effect without dynamically re-registering croner jobs; a tick whose repo list
 * comes back empty is a cheap no-op — no dispatch, no run, no error.
 */
export function getJobs(opts?: {
  webhooksEnabled?: boolean;
  db?: StateDb;
  /** Operator cron block. Defaults to runtime config — injectable for tests. */
  crons?: CronsConfig;
}): CronJob[] {
  const jobs: CronJob[] = [];

  let cronDefs = getCronWorkflows();

  // Apply conditions
  if (opts?.webhooksEnabled) {
    cronDefs = cronDefs.filter((def) => def.condition?.unless !== "webhooksEnabled");
  }

  const overrides = opts?.db?.getAllCronOverrides() ?? new Map();
  // Already includes the legacy `disabled.crons` names (unioned by the config
  // normaliser). Those are additionally dropped by the asset loader before we
  // ever see them here, so this is belt-and-braces for anything that reaches us.
  const crons = opts?.crons ?? operatorCrons();

  for (const def of cronDefs) {
    const override = overrides.get(def.name);
    // The dashboard toggle and the operator's `crons.disable` are the same
    // lever spelled two ways — both mean "off by default", both leave the tick
    // registered so a repo opt-in can still be honoured.
    const globallyEnabled = (override ? override.enabled : true) && !crons.disable.includes(def.name);
    jobs.push({
      name: def.name,
      schedule: override?.schedule || def.schedule,
      workflow: def.workflow,
      // Merge managed repos into the context the workflow receives. Use the
      // installation-filtered list so a stale managedRepos entry (repo deleted /
      // transferred / access revoked) doesn't fan out into a doomed scan run
      // whose scoped-token mint 422s.
      context: {
        repos: getAccessibleManagedRepos(),
        // Control keys for the fan-out; stripped there, never reaching a run.
        [CRON_NAME_KEY]: def.name,
        [CRON_GLOBALLY_ENABLED_KEY]: globallyEnabled,
        ...def.context,
      },
    });
  }

  return jobs;
}

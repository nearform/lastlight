import type { CronJob } from "./scheduler.js";
import { getManagedRepos } from "../managed-repos.js";
import { getCronWorkflows } from "../workflows/loader.js";
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
 * When `db` is supplied, cron_overrides rows applied: disabled jobs are
 * dropped and schedule overrides replace the YAML schedule.
 */
export function getJobs(opts?: { webhooksEnabled?: boolean; db?: StateDb }): CronJob[] {
  const jobs: CronJob[] = [];

  let cronDefs = getCronWorkflows();

  // Apply conditions
  if (opts?.webhooksEnabled) {
    cronDefs = cronDefs.filter((def) => def.condition?.unless !== "webhooksEnabled");
  }

  const overrides = opts?.db?.getAllCronOverrides() ?? new Map();

  for (const def of cronDefs) {
    const override = overrides.get(def.name);
    if (override && !override.enabled) continue;
    jobs.push({
      name: def.name,
      schedule: override?.schedule || def.schedule,
      workflow: def.workflow,
      // Merge managed repos into the context the workflow receives
      context: { repos: getManagedRepos(), ...def.context },
    });
  }

  return jobs;
}

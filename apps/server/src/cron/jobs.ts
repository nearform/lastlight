import type { CronJob } from "./scheduler.js";
import type { CronHandlerRegistry } from "./handlers.js";
import { getAccessibleManagedRepos } from "../managed-repos.js";
import { getCronWorkflows } from "../workflows/loader.js";
import { CRON_GLOBALLY_ENABLED_KEY, CRON_NAME_KEY, operatorCrons } from "./repo-crons.js";
import type { CronsConfig } from "../config/config.js";
import type { StateDb } from "../state/db.js";
import { logger } from "../logging/logger.js";

const log = logger("cron");

/** What a `condition.unless` predicate is evaluated against. */
export interface CronConditionContext {
  webhooksEnabled: boolean;
}

/**
 * `condition.unless: <name>` → the predicate that name means.
 *
 * `jobs.ts` used to compare the field against the literal string
 * `"webhooksEnabled"`, so a cron YAML could express exactly one condition and
 * any other value was silently ignored — a typo turned a conditional cron into
 * an unconditional one with no error. 07-review-triggers.md §7.4b asked for this
 * generalisation and Phase 8 briefly made it moot by deleting the only consumer;
 * 09-state-machine.md → S5 keeps the crons, so it is live again.
 *
 * **An unknown name keeps the cron.** Registration is the safe direction: a
 * globally-off cron still ticks (a repo may opt back in), whereas a silently
 * dropped one produces no ticks, no rows and no error — the exact failure the
 * literal comparison already had.
 */
const CRON_CONDITION_PREDICATES: Record<string, (ctx: CronConditionContext) => boolean> = {
  webhooksEnabled: (ctx) => ctx.webhooksEnabled,
};

/** Names already warned about, so a bad `condition.unless` logs once per boot. */
const warnedConditions = new Set<string>();

/** Should this cron be REGISTERED, given its `condition.unless`? */
function conditionAllows(unless: string | undefined, ctx: CronConditionContext): boolean {
  if (!unless) return true;
  const predicate = CRON_CONDITION_PREDICATES[unless];
  if (!predicate) {
    if (!warnedConditions.has(unless)) {
      warnedConditions.add(unless);
      log.warn("Unknown condition.unless — registering the cron anyway", {
        unless,
        known: Object.keys(CRON_CONDITION_PREDICATES),
      });
    }
    return true;
  }
  return !predicate(ctx);
}

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
  /**
   * Host-side handlers a cron YAML's `handler:` key may name (see
   * `handlers.ts`). Injected rather than imported so `getJobs` stays a pure
   * function of its inputs and the tests need no harness.
   */
  handlers?: CronHandlerRegistry;
}): CronJob[] {
  const jobs: CronJob[] = [];

  let cronDefs = getCronWorkflows();

  // Apply conditions through the predicate map, not a literal string compare.
  const conditionCtx: CronConditionContext = { webhooksEnabled: !!opts?.webhooksEnabled };
  cronDefs = cronDefs.filter((def) => conditionAllows(def.condition?.unless, conditionCtx));

  const overrides = opts?.db?.getAllCronOverrides() ?? new Map();
  // Already includes the legacy `disabled.crons` names (unioned by the config
  // normaliser). Those are additionally dropped by the asset loader before we
  // ever see them here, so this is belt-and-braces for anything that reaches us.
  const crons = opts?.crons ?? operatorCrons();

  for (const def of cronDefs) {
    // Resolve a `handler:` cron against the registry BEFORE anything else. An
    // unresolvable name DROPS the cron — the opposite of `condition.unless`,
    // where registering is the safe direction because there is still a workflow
    // to run. Here there is nothing to run, so a registered tick would just
    // throw once a week; the boot-time warning is the useful signal.
    let handler: CronJob["handler"];
    if (def.handler) {
      handler = opts?.handlers?.[def.handler];
      if (!handler) {
        log.warn("Unknown cron handler — cron not registered", {
          cron: def.name,
          handler: def.handler,
          known: Object.keys(opts?.handlers ?? {}),
        });
        continue;
      }
    }

    const override = overrides.get(def.name);
    // The dashboard toggle and the operator's `crons.disable` are the same
    // lever spelled two ways — both mean "off by default", both leave the tick
    // registered so a repo opt-in can still be honoured.
    const globallyEnabled = (override ? override.enabled : true) && !crons.disable.includes(def.name);
    jobs.push({
      name: def.name,
      schedule: override?.schedule || def.schedule,
      workflow: def.workflow,
      handler,
      // Merge managed repos into the context the workflow receives. Use the
      // installation-filtered list so a stale managedRepos entry (repo deleted /
      // transferred / access revoked) doesn't fan out into a doomed scan run
      // whose scoped-token mint 422s.
      context: {
        repos: getAccessibleManagedRepos(),
        // Spread ahead of the control keys, deliberately: a cron YAML MAY pin
        // its own `context.repos` and override the managed-repo list.
        ...def.context,
        // Control keys for the fan-out; stripped there, never reaching a run.
        // Injected LAST so operator YAML can't spoof them — a `_cronName` from
        // `context:` would make `resolveCronRepos` apply another cron's per-repo
        // opt-in/opt-out rules to this tick, and a `_cronGloballyEnabled` would
        // let a disabled cron fan out as enabled.
        [CRON_NAME_KEY]: def.name,
        [CRON_GLOBALLY_ENABLED_KEY]: globallyEnabled,
      },
    });
  }

  return jobs;
}

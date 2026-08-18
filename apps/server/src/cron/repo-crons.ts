/**
 * Per-repository cron participation (issue #180).
 *
 * A cron is scheduled ONCE globally but fans out into one run per managed repo
 * (`src/cron/fanout.ts`). This module decides, at tick time, WHICH repos that
 * fan-out covers — reading the `crons:` block each repo may commit to its
 * `.lastlight/lastlight.yml`:
 *
 *   crons:
 *     enable:  [security-scan]   # run this cron against me even when it's off globally
 *     disable: [repo-health]     # skip me on this cron
 *
 * ── Why at tick time ──────────────────────────────────────────────────────
 * The alternative — resolving participation when jobs are registered — would
 * mean a repo editing its `lastlight.yml` needs the croner jobs re-registered
 * to take effect (a config-change watcher, or a restart). Resolving here
 * instead makes a repo's edit take effect on the next tick with no scheduler
 * churn, at the cost of a cheap no-op tick when nothing resolves.
 *
 * ── Cost ──────────────────────────────────────────────────────────────────
 * A fan-out over N repos must not become N blocking network calls. The cached
 * layer is used when one is in memory; only cache misses go through
 * {@link fetchRepoLayer}, concurrently, and that call is itself TTL'd +
 * conditional (see `src/config/repo-config.ts`). One repo's failure never
 * aborts the tick: an unreadable config falls back to the repo's inherited
 * (global) behaviour.
 *
 * ── Bounds ────────────────────────────────────────────────────────────────
 * The repo layer only gets a vote when the operator's `repoConfig.allowKeys`
 * admits `crons` (or the legacy `disabled.crons`). Removing it is the operator's
 * kill switch: `crons.disable` in the operator's config then cannot be
 * overridden by any repo, and this module short-circuits with zero fetches.
 */

import { getRuntimeConfig, type CronsConfig, type RepoConfigPolicy } from "../config/config.js";
import { fetchRepoLayer, getCachedRepoLayer, repoConfigPolicy, type RepoLayer } from "../config/repo-config.js";
import { logger } from "../logging/logger.js";

const log = logger("cron");

/**
 * Context keys the cron tick carries from {@link import("./jobs.js").getJobs}
 * to the fan-out. Underscore-prefixed like `_triggerType`, and stripped by the
 * fan-out before dispatch so a workflow run's context looks exactly as it did
 * before this feature existed.
 *
 * They travel in the context because that's the only channel the scheduler
 * gives a job (`runner(job.workflow, job.context)`) — the cron's own NAME isn't
 * otherwise recoverable from the workflow name (several crons may share one
 * workflow).
 */
export const CRON_NAME_KEY = "_cronName";
export const CRON_GLOBALLY_ENABLED_KEY = "_cronGloballyEnabled";

/** How a repo's resolved fan-out list was reached — used by the tick's log line. */
export interface CronRepoResolution {
  repos: string[];
  /** Repos dropped because they disabled this cron. */
  optedOut: string[];
  /** Repos kept only because they opted in to a globally-off cron. */
  optedIn: string[];
}

export interface ResolveCronReposOptions {
  /** The cron's name, as declared in its `cron-*.yaml` — the key repos list. */
  cron: string;
  /** The candidate repos (the cron context's `repos[]`). */
  repos: readonly string[];
  /** False when the operator has this cron off — repos may still opt in. */
  globallyEnabled: boolean;
  /** Operator bounds. Defaults to the runtime {@link repoConfigPolicy}. */
  policy?: RepoConfigPolicy;
  /**
   * Layer lookup seam. Defaults to "cached if present, else fetch" — tests
   * inject a map instead of touching the network.
   */
  layerFor?: (repo: string) => RepoLayer | undefined | Promise<RepoLayer | undefined>;
}

/**
 * The repos a cron tick should actually fan out over.
 *
 * Never throws: every per-repo failure degrades to that repo's inherited
 * behaviour. An empty result is a legitimate answer (a globally-off cron no
 * repo opted into) and the caller treats it as a no-op tick.
 */
export async function resolveCronRepos(options: ResolveCronReposOptions): Promise<CronRepoResolution> {
  const { cron, repos, globallyEnabled } = options;
  const policy = options.policy ?? repoConfigPolicy();
  const inherited = globallyEnabled ? [...repos] : [];

  // Fast path: the repo layer has no say here (feature off, or the operator
  // narrowed `allowKeys`). Zero fetches, and the operator's word is final.
  if (!repoLayerMayVote(policy)) return { repos: inherited, optedOut: [], optedIn: [] };

  const lookup = options.layerFor ?? defaultLayerFor;
  const decisions = await Promise.all(
    repos.map(async (repo): Promise<readonly [string, CronVote]> => {
      try {
        const layer = await lookup(repo);
        return [repo, cronVote(cron, repoCronPrefs(layer?.config, policy))] as const;
      } catch (err: unknown) {
        // `fetchRepoLayer` doesn't reject, but a caller-supplied lookup might —
        // and one repo's bad day must never cost the other repos their tick.
        log.warn("Could not read repo's .lastlight/ config — using the global setting", {
          cron,
          repo,
          err,
        });
        return [repo, undefined] as const;
      }
    }),
  );

  const out: CronRepoResolution = { repos: [], optedOut: [], optedIn: [] };
  for (const [repo, vote] of decisions) {
    if (vote === "disable") {
      if (globallyEnabled) out.optedOut.push(repo);
      continue;
    }
    if (vote === "enable" && !globallyEnabled) out.optedIn.push(repo);
    if (vote === "enable" || globallyEnabled) out.repos.push(repo);
  }
  return out;
}

/** A repo's vote on one cron. `undefined` = no opinion, inherit the global setting. */
export type CronVote = "enable" | "disable" | undefined;

/**
 * Apply one layer's {@link CronsConfig} to one cron name. DISABLE WINS: a name
 * in both lists doesn't run. Fail safe — a repo that contradicts itself gets
 * the outcome that can't surprise anybody.
 */
export function cronVote(cron: string, prefs: CronsConfig): CronVote {
  if (prefs.disable.includes(cron)) return "disable";
  if (prefs.enable.includes(cron)) return "enable";
  return undefined;
}

/**
 * Read the `crons:` block (plus the legacy `disabled.crons` alias) out of a
 * repo's RAW, unvalidated `lastlight.yml`, keeping only what the operator's
 * `allowKeys` admits.
 *
 * Bounded here rather than by `resolveRepoConfig`'s sanitizer because cron
 * participation isn't part of the merged per-run config shape — it's consumed
 * by the scheduler, before any run exists. Same house rules as that sanitizer:
 * pure, lenient, drop what doesn't fit and carry on.
 */
export function repoCronPrefs(raw: unknown, policy: RepoConfigPolicy): CronsConfig {
  const empty: CronsConfig = { enable: [], disable: [] };
  if (!isPlainObject(raw)) return empty;

  const block = isPlainObject(raw.crons) ? raw.crons : {};
  const enable = allows(policy, "crons.enable") ? cronNames(block.enable) : [];
  const disable = allows(policy, "crons.disable") ? cronNames(block.disable) : [];

  // Legacy alias, unioned in exactly as it is at the operator layer.
  const legacyRaw = isPlainObject(raw.disabled) ? raw.disabled.crons : undefined;
  const legacy = allows(policy, "disabled.crons") ? cronNames(legacyRaw) : [];

  return { enable, disable: [...new Set([...disable, ...legacy])] };
}

/**
 * Whether any repo could influence cron participation at all. `false` short-
 * circuits the whole resolution — no cache reads, no fetches, operator's word
 * final. This is the documented kill switch: drop `crons` from
 * `repoConfig.allowKeys`.
 */
export function repoLayerMayVote(policy: RepoConfigPolicy): boolean {
  return (
    policy.enabled &&
    (allows(policy, "crons.enable") || allows(policy, "crons.disable") || allows(policy, "disabled.crons"))
  );
}

/**
 * The operator's cron block from runtime config, or an inert one when config
 * isn't loaded (unit tests, pre-boot paths). Mirrors `repoConfigPolicy()`.
 */
export function operatorCrons(): CronsConfig {
  return getRuntimeConfig()?.crons ?? { enable: [], disable: [] };
}

/**
 * Cached-first layer lookup. `getCachedRepoLayer` can't distinguish "checked,
 * has no `.lastlight/`" from "never checked", so a miss falls through to
 * `fetchRepoLayer` — which is TTL-guarded (a warm negative entry answers from
 * memory) and never throws.
 */
function defaultLayerFor(repo: string): RepoLayer | undefined | Promise<RepoLayer | undefined> {
  return getCachedRepoLayer(repo) ?? fetchRepoLayer(repo);
}

/**
 * Same admit rule as the repo-config sanitizer's: an allow-list entry admits
 * itself and everything beneath it, so `crons` admits `crons.enable` while
 * `disabled.workflows` admits neither.
 */
function allows(policy: RepoConfigPolicy, path: string): boolean {
  return policy.allowKeys.some((allowed) => path === allowed || path.startsWith(`${allowed}.`));
}

/** Trimmed non-empty names from a YAML list; anything else contributes nothing. */
function cronNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim());
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

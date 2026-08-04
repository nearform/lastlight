import { getRuntimeConfig } from "./config/config.js";

/**
 * Fallback list used only before runtime config is loaded (e.g. tests).
 * The real list lives in config/default.yaml (empty) and is overridden by the
 * private overlay at $LASTLIGHT_OVERLAY_DIR/config.yaml. Kept empty so no
 * deployment-specific repos are baked into the public source.
 */
export const DEFAULT_MANAGED_REPOS: string[] = [];

/** Compatibility export for legacy callers/tests; prefer getManagedRepos(). */
export const MANAGED_REPOS = DEFAULT_MANAGED_REPOS;

/**
 * Repositories the GitHub App can access, **keyed by installation id** —
 * discovered at boot (`GitHubClient.listAllInstallationRepos()`) and kept live
 * by `installation` / `installation_repositories` webhooks. Only used when the
 * overlay's `managedRepos` is empty — see `getManagedRepos()`.
 *
 * Keyed rather than flat because an App installed on several accounts gets one
 * `installation` event stream per account: `created` carries only that
 * account's repos and `deleted` means only that account went away. Against a
 * single flat set those two would reset and clear the WHOLE list, so installing
 * the App on a second org silently unmanaged every repo in the first.
 */
const installationRepos = new Map<string, Set<string>>();
let installationReposRefreshedAt: string | null = null;

function touch(): void {
  installationReposRefreshedAt = new Date().toISOString();
}

/** Replace ONE installation's repo set (boot fetch, initial install). */
export function setInstallationRepos(installationId: string, repos: string[]): void {
  installationRepos.set(String(installationId), new Set(repos));
  touch();
}

/** Add repos to one installation's set (installation_repositories → added). */
export function addInstallationRepos(installationId: string, repos: string[]): void {
  const key = String(installationId);
  const next = installationRepos.get(key) ?? new Set<string>();
  for (const r of repos) next.add(r);
  installationRepos.set(key, next);
  touch();
}

/** Remove repos from one installation's set (installation_repositories → removed). */
export function removeInstallationRepos(installationId: string, repos: string[]): void {
  const set = installationRepos.get(String(installationId));
  if (!set) return;
  for (const r of repos) set.delete(r);
  touch();
}

/** Drop an installation entirely — the App was uninstalled from that account. */
export function removeInstallation(installationId: string): void {
  installationRepos.delete(String(installationId));
  touch();
}

/** Union of every installation's repos (empty before the first discovery). */
export function getInstallationRepos(): string[] {
  const all = new Set<string>();
  for (const set of installationRepos.values()) for (const r of set) all.add(r);
  return [...all];
}

/** Per-installation breakdown, for the admin/ops surface. */
export function getInstallationRepoBreakdown(): Array<{ installationId: string; repos: string[] }> {
  return [...installationRepos].map(([installationId, repos]) => ({
    installationId,
    repos: [...repos],
  }));
}

/** ISO timestamp of the last installation-repo cache update, or null if never. */
export function getInstallationReposRefreshedAt(): string | null {
  return installationReposRefreshedAt;
}

/** Test-only: clear the discovered installation-repo cache. */
export function resetInstallationReposForTests(): void {
  installationRepos.clear();
  installationReposRefreshedAt = null;
}

/**
 * The effective managed-repo list. A non-empty configured list (overlay
 * `managedRepos`) wins and restricts to exactly those repos; when it's empty we
 * fall back to the repos the GitHub App installation can access (discovered at
 * boot + kept live by installation webhooks). So an org install that limits the
 * App to a subset of repos need not maintain a second copy in config.
 */
export function getManagedRepos(): string[] {
  const configured = getRuntimeConfig()?.managedRepos ?? DEFAULT_MANAGED_REPOS;
  if (configured.length > 0) return configured;
  return getInstallationRepos();
}

export function isManagedRepo(repo: string | undefined | null): boolean {
  if (!repo) return false;
  return getManagedRepos().includes(repo);
}

/**
 * The repos referenced by a dispatch context (`repo` and/or `repos[]`) that are
 * NOT in the managed allowlist. Empty ⇒ safe to act on (or no repo at all, e.g.
 * a Slack-triggered run). Used to gate CLI/API triggers and as the choke-point
 * guard in dispatchWorkflow, so every path that acts on a repo — webhooks,
 * router, cron, and the direct `/api/*` triggers — respects `managedRepos`.
 */
export function unmanagedReposInContext(
  context: { repo?: unknown; repos?: unknown },
): string[] {
  const refs: string[] = [];
  if (typeof context.repo === "string" && context.repo) refs.push(context.repo);
  if (Array.isArray(context.repos)) {
    for (const r of context.repos) if (typeof r === "string" && r) refs.push(r);
  }
  return refs.filter((r) => !isManagedRepo(r));
}

/**
 * The managed repos the GitHub App installation can actually access right now.
 *
 * Filters the configured `managedRepos` down to the discovered installation set
 * when that set is known, so a stale config entry — a repo that was deleted,
 * transferred to another org, or had App access revoked — doesn't spawn doomed
 * cron scan runs whose per-repo scoped-token mint 422s (which silently disables
 * the agent's github_* tools). When installation discovery hasn't populated yet
 * (empty set — e.g. before the boot fetch, or a fetch failure) this returns the
 * configured list unfiltered rather than dropping every repo. Webhook routing
 * still uses the raw configured list via {@link isManagedRepo}; only the cron
 * fan-out (a best-effort backstop) narrows to what's reachable.
 */
export function getAccessibleManagedRepos(): string[] {
  const configured = getManagedRepos();
  const installed = getInstallationRepos();
  if (installed.length === 0) return configured;
  const accessible = new Set(installed);
  return configured.filter((r) => accessible.has(r));
}

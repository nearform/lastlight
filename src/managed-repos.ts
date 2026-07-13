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
 * In-memory list of repositories the GitHub App installation can access,
 * discovered at boot (`GitHubClient.listInstallationRepos()`) and kept live by
 * `installation` / `installation_repositories` webhooks. `null` means "not yet
 * discovered" (distinct from "discovered, empty"). Only used when the overlay's
 * `managedRepos` is empty — see `getManagedRepos()`.
 */
let installationRepos: Set<string> | null = null;
let installationReposRefreshedAt: string | null = null;

/** Replace the discovered installation-repo list wholesale (boot fetch, initial install, uninstall). */
export function setInstallationRepos(repos: string[]): void {
  installationRepos = new Set(repos);
  installationReposRefreshedAt = new Date().toISOString();
}

/** Add repos to the discovered list (installation_repositories → added). */
export function addInstallationRepos(repos: string[]): void {
  const next = installationRepos ?? new Set<string>();
  for (const r of repos) next.add(r);
  installationRepos = next;
  installationReposRefreshedAt = new Date().toISOString();
}

/** Remove repos from the discovered list (installation_repositories → removed). */
export function removeInstallationRepos(repos: string[]): void {
  if (!installationRepos) return;
  for (const r of repos) installationRepos.delete(r);
  installationReposRefreshedAt = new Date().toISOString();
}

/** Snapshot of the discovered installation-repo list (empty before boot fetch). */
export function getInstallationRepos(): string[] {
  return installationRepos ? [...installationRepos] : [];
}

/** ISO timestamp of the last installation-repo cache update, or null if never. */
export function getInstallationReposRefreshedAt(): string | null {
  return installationReposRefreshedAt;
}

/** Test-only: clear the discovered installation-repo cache. */
export function resetInstallationReposForTests(): void {
  installationRepos = null;
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

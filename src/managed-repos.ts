import { getRuntimeConfig } from "./config.js";

export const DEFAULT_MANAGED_REPOS = [
  "cliftonc/drizzle-cube",
  "cliftonc/drizby",
  "cliftonc/lastlight",
];

/** Compatibility export for legacy callers/tests; prefer getManagedRepos(). */
export const MANAGED_REPOS = DEFAULT_MANAGED_REPOS;

export function getManagedRepos(): string[] {
  return getRuntimeConfig()?.managedRepos ?? DEFAULT_MANAGED_REPOS;
}

export function isManagedRepo(repo: string | undefined | null): boolean {
  if (!repo) return false;
  return getManagedRepos().includes(repo);
}

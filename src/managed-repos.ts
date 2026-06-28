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

export function getManagedRepos(): string[] {
  return getRuntimeConfig()?.managedRepos ?? DEFAULT_MANAGED_REPOS;
}

export function isManagedRepo(repo: string | undefined | null): boolean {
  if (!repo) return false;
  return getManagedRepos().includes(repo);
}

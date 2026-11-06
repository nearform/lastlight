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
  storedRepoApproval = null;
  installationReposRefreshedAt = null;
}

/**
 * The operator's approval state: which repos are approved, and whether a repo
 * must be approved before it gets work. Stored as one `harness_settings` row
 * (key {@link REPO_APPROVAL_SETTING_KEY}) once the dashboard changes it; until
 * then it is the YAML `managedRepos` / `requireRepoApproval`.
 */
export interface RepoApprovalState {
  requireApproval: boolean;
  approved: string[];
}

export const REPO_APPROVAL_SETTING_KEY = "managed-repos";

/** The stored row, or null when none was loaded (⇒ YAML values). */
let storedRepoApproval: RepoApprovalState | null = null;

/** Cache setter: the loaded or just-written row; null = no row. */
export function setStoredRepoApproval(state: RepoApprovalState | null): void {
  storedRepoApproval = state ? { requireApproval: state.requireApproval, approved: [...state.approved] } : null;
}

/** The approval state in effect, and whether it came from the stored row. */
export function getRepoApprovalState(): { state: RepoApprovalState; stored: boolean } {
  if (storedRepoApproval) {
    return { state: { ...storedRepoApproval, approved: [...storedRepoApproval.approved] }, stored: true };
  }
  const cfg = getRuntimeConfig();
  return {
    state: {
      requireApproval: cfg?.requireRepoApproval ?? false,
      approved: [...(cfg?.managedRepos ?? DEFAULT_MANAGED_REPOS)],
    },
    stored: false,
  };
}

/**
 * Re-read the stored row into the in-memory copy. Called at boot and on a
 * timer, so a second process sharing the database picks up dashboard changes;
 * the process that made a change updates its copy directly.
 */
export async function refreshRepoApproval(
  db: { getSetting<T>(key: string): Promise<{ value: T } | null> },
): Promise<void> {
  const row = await db.getSetting<RepoApprovalState>(REPO_APPROVAL_SETTING_KEY);
  setStoredRepoApproval(row ? normalizeApprovalState(row.value) : null);
}

function normalizeApprovalState(raw: unknown): RepoApprovalState {
  const v = (raw ?? {}) as Partial<RepoApprovalState>;
  return {
    requireApproval: v.requireApproval === true,
    approved: Array.isArray(v.approved) ? v.approved.filter((r): r is string => typeof r === "string" && !!r) : [],
  };
}

/**
 * The effective list for an approval state: the approved list when it is
 * non-empty or approval is required, otherwise the App grant (the default).
 */
export function effectiveRepos(state: RepoApprovalState, installation: string[]): string[] {
  if (state.requireApproval || state.approved.length > 0) return [...state.approved];
  return [...installation];
}

/**
 * The effective managed-repo list. Approved repos (stored row, else the
 * overlay's `managedRepos`) win and restrict to exactly those repos; with none
 * approved and approval not required we fall back to the repos the GitHub App
 * installation can access (discovered at boot + kept live by installation
 * webhooks). So an org install that limits the App to a subset of repos need
 * not maintain a second copy in config.
 */
export function getManagedRepos(): string[] {
  return effectiveRepos(getRepoApprovalState().state, getInstallationRepos());
}

/** Repo names compare case-insensitively, as GitHub treats them. */
export function sameRepo(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

export function isManagedRepo(repo: string | undefined | null): boolean {
  if (!repo) return false;
  return getManagedRepos().some((r) => sameRepo(r, repo));
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
  const accessible = new Set(installed.map((r) => r.toLowerCase()));
  return configured.filter((r) => accessible.has(r.toLowerCase()));
}

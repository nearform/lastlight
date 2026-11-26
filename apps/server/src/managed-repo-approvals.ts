import type { StateDb } from "./state/db.js";
import {
  AUTONOMY_REPOS_SETTING_KEY,
  normalizeAutonomyRepos,
  setStoredAutonomyRepos,
  yamlAutonomyRepos,
} from "./autonomy-repos.js";
import {
  REPO_APPROVAL_SETTING_KEY,
  getInstallationDiscoveryFailures,
  getInstallationRepos,
  getInstallationReposRefreshedAt,
  getManagedRepos,
  normalizeApprovalState,
  sameRepo,
  setStoredRepoApproval,
  yamlRepoApprovalState,
  type RepoApprovalState,
} from "./managed-repos.js";

/**
 * The rules behind Config → Managed repos' write actions. Each one reads the
 * approval state in effect (stored row, else YAML), applies the change,
 * persists the WHOLE state as one `harness_settings` row, and updates the
 * in-memory copy so the change gates events immediately.
 *
 * The first write therefore copies the YAML values into the row; from then on
 * the row wins (see `getRepoApprovalState`).
 *
 * The autonomy allow-list (which repos the board shows and a `ready-for-agent`
 * label may build) is a second row, `autonomy-repos`, written the same way and
 * through the same write queue: removing an approved repo drops it from both,
 * so approving it again later does not quietly turn its builds back on.
 */

/** What to do when a removal would leave no approved repo with the flag off. */
export type WhenEmpty = "follow-app" | "require-approval";

export type ApprovalResult =
  | { ok: true; state: RepoApprovalState }
  | { ok: false; status: 400 | 409; error: string; installationCount?: number };

type SettingsDb = Pick<StateDb, "getSetting" | "setSetting">;

async function save(db: SettingsDb, state: RepoApprovalState, actor?: string): Promise<ApprovalResult> {
  await db.setSetting(REPO_APPROVAL_SETTING_KEY, state, actor);
  setStoredRepoApproval(state);
  return { ok: true, state };
}

/**
 * The state a write starts from: the STORED row, not the in-memory copy (so a
 * write always builds on the latest stored state), else the YAML values.
 * Last Light runs as one instance; `serialized()` is the only write guard.
 */
async function current(db: SettingsDb): Promise<RepoApprovalState> {
  const row = await db.getSetting<unknown>(REPO_APPROVAL_SETTING_KEY);
  return row ? normalizeApprovalState(row.value) : yamlRepoApprovalState();
}

/** The autonomy list a write starts from: the STORED row, else YAML `autonomy.repos`. */
async function currentAutonomy(db: SettingsDb): Promise<string[]> {
  const row = await db.getSetting<unknown>(AUTONOMY_REPOS_SETTING_KEY);
  return row ? normalizeAutonomyRepos(row.value).repos : yamlAutonomyRepos();
}

async function saveAutonomy(db: SettingsDb, repos: string[], actor?: string): Promise<void> {
  await db.setSetting(AUTONOMY_REPOS_SETTING_KEY, { repos }, actor);
  setStoredAutonomyRepos({ repos });
}

/** Drop autonomy entries `keep` rejects; writes the row only when something was dropped. */
async function pruneAutonomy(db: SettingsDb, keep: (repo: string) => boolean, actor?: string): Promise<void> {
  const autonomy = await currentAutonomy(db);
  const kept = autonomy.filter(keep);
  if (kept.length !== autonomy.length) await saveAutonomy(db, kept, actor);
}

/** Writes run one at a time in this process, so two requests cannot interleave a read-modify-write. */
let queue: Promise<unknown> = Promise.resolve();
function serialized<T>(fn: () => Promise<T>): Promise<T> {
  const next = queue.then(fn, fn);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * Approve repos the App can see. Refused before installation discovery has run
 * (we cannot tell a typo from a real repo yet) and for any repo outside the
 * grant. Stored as the grant spells the name; already-approved repos are kept.
 */
export function approveRepos(db: SettingsDb, repos: string[], actor?: string): Promise<ApprovalResult> {
  return serialized(() => approveNow(db, repos, actor));
}

async function approveNow(db: SettingsDb, repos: string[], actor?: string): Promise<ApprovalResult> {
  if (getInstallationReposRefreshedAt() === null) {
    return { ok: false, status: 409, error: "installation list not loaded yet" };
  }
  const grant = getInstallationRepos();
  const unknown = repos.filter((r) => !grant.some((g) => sameRepo(g, r)));
  if (unknown.length > 0) {
    const failed = getInstallationDiscoveryFailures();
    const hint = failed.length
      ? ` (the repo list for ${failed.join(", ")} failed to load; it reloads on restart or the next installation event)`
      : "";
    return { ok: false, status: 400, error: `not in the GitHub App's repo grant: ${unknown.join(", ")}${hint}` };
  }
  const state = await current(db);
  const approved = [...state.approved];
  for (const r of repos) {
    if (approved.some((a) => sameRepo(a, r))) continue;
    approved.push(grant.find((g) => sameRepo(g, r))!);
  }
  return save(db, { ...state, approved }, actor);
}

/**
 * Remove repos from the approved list. With the flag off, an empty list means
 * "follow the App grant", so a removal that empties it must say which way to
 * go (`whenEmpty`); without that it is refused with `would-empty`, carrying the
 * grant size the confirm dialog shows. `require-approval` also turns the flag on.
 */
export function removeRepos(
  db: SettingsDb,
  repos: string[],
  opts: { whenEmpty?: WhenEmpty },
  actor?: string,
): Promise<ApprovalResult> {
  return serialized(() => removeNow(db, repos, opts, actor));
}

async function removeNow(
  db: SettingsDb,
  repos: string[],
  opts: { whenEmpty?: WhenEmpty },
  actor?: string,
): Promise<ApprovalResult> {
  const state = await current(db);
  const approved = state.approved.filter((a) => !repos.some((r) => sameRepo(a, r)));
  let requireApproval = state.requireApproval;
  if (approved.length === 0 && !requireApproval && state.approved.length > 0) {
    if (!opts.whenEmpty) {
      return { ok: false, status: 409, error: "would-empty", installationCount: getInstallationRepos().length };
    }
    requireApproval = opts.whenEmpty === "require-approval";
  }
  const res = await save(db, { requireApproval, approved }, actor);
  await pruneAutonomy(db, (a) => !repos.some((r) => sameRepo(a, r)), actor);
  return res;
}

/**
 * Turn "require repo approval" on or off; the approved list is unchanged.
 * Turning it OFF with nothing approved makes the bot follow the whole App grant,
 * so that needs `confirm` — the same no-silent-widening rule `removeRepos`
 * enforces, held on the server so a stale dashboard or an API caller cannot skip it.
 */
export function setRequireApproval(
  db: SettingsDb,
  enabled: boolean,
  actor?: string,
  opts: { confirm?: boolean } = {},
): Promise<ApprovalResult> {
  return serialized(async () => {
    const state = await current(db);
    if (!enabled && state.requireApproval && state.approved.length === 0 && !opts.confirm) {
      return { ok: false, status: 409, error: "would-follow-app", installationCount: getInstallationRepos().length };
    }
    // A no-op click must not store a row: that would detach the deployment
    // from its YAML values for nothing.
    if (state.requireApproval === enabled) return { ok: true, state };
    const res = await save(db, { ...state, requireApproval: enabled }, actor);
    // Turning approval on can un-manage repos (those the bot followed through
    // the App grant). Drop them from the autonomy list too, so approving one
    // later does not quietly turn its builds back on.
    if (enabled) {
      const managed = getManagedRepos();
      await pruneAutonomy(db, (a) => managed.some((m) => sameRepo(m, a)), actor);
    }
    return res;
  });
}

export type AutonomyResult = { ok: true; repos: string[] } | { ok: false; status: 400; error: string };

/**
 * Turn autonomous builds on or off for one managed repo. `isAutonomousRepo` is
 * an exact match against the webhook's `owner/repo`, so the entry is stored as
 * GitHub spells it: the App grant's spelling when known, else the managed
 * list's. Turning it on also rewrites an entry that differs only in case. A
 * change that changes nothing stores no row, so the deployment stays on its
 * YAML list.
 */
export function setRepoAutonomy(
  db: SettingsDb,
  repo: string,
  enabled: boolean,
  actor?: string,
): Promise<AutonomyResult> {
  return serialized(async () => {
    const repos = await currentAutonomy(db);
    const has = repos.some((a) => sameRepo(a, repo));
    if (enabled) {
      const managed = getManagedRepos().find((m) => sameRepo(m, repo));
      if (!managed) return { ok: false, status: 400, error: `not a managed repo: ${repo}` };
      const canonical = getInstallationRepos().find((g) => sameRepo(g, repo)) ?? managed;
      if (repos.includes(canonical)) return { ok: true, repos };
      const next = [...repos.filter((a) => !sameRepo(a, repo)), canonical];
      await saveAutonomy(db, next, actor);
      return { ok: true, repos: next };
    }
    if (!has) return { ok: true, repos };
    const next = repos.filter((a) => !sameRepo(a, repo));
    await saveAutonomy(db, next, actor);
    return { ok: true, repos: next };
  });
}

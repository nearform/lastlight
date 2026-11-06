import type { StateDb } from "./state/db.js";
import {
  REPO_APPROVAL_SETTING_KEY,
  getInstallationRepos,
  getInstallationReposRefreshedAt,
  getRepoApprovalState,
  sameRepo,
  setStoredRepoApproval,
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
 */

/** What to do when a removal would leave no approved repo with the flag off. */
export type WhenEmpty = "follow-app" | "require-approval";

export type ApprovalResult =
  | { ok: true; state: RepoApprovalState }
  | { ok: false; status: 400 | 409; error: string; installationCount?: number };

type SettingsDb = Pick<StateDb, "setSetting">;

async function save(db: SettingsDb, state: RepoApprovalState, actor?: string): Promise<ApprovalResult> {
  await db.setSetting(REPO_APPROVAL_SETTING_KEY, state, actor);
  setStoredRepoApproval(state);
  return { ok: true, state };
}

/**
 * Approve repos the App can see. Refused before installation discovery has run
 * (we cannot tell a typo from a real repo yet) and for any repo outside the
 * grant. Stored as the grant spells the name; already-approved repos are kept.
 */
export async function approveRepos(db: SettingsDb, repos: string[], actor?: string): Promise<ApprovalResult> {
  if (getInstallationReposRefreshedAt() === null) {
    return { ok: false, status: 409, error: "installation list not loaded yet" };
  }
  const grant = getInstallationRepos();
  const unknown = repos.filter((r) => !grant.some((g) => sameRepo(g, r)));
  if (unknown.length > 0) {
    return { ok: false, status: 400, error: `not in the GitHub App's repo grant: ${unknown.join(", ")}` };
  }
  const { state } = getRepoApprovalState();
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
export async function removeRepos(
  db: SettingsDb,
  repos: string[],
  opts: { whenEmpty?: WhenEmpty },
  actor?: string,
): Promise<ApprovalResult> {
  const { state } = getRepoApprovalState();
  const approved = state.approved.filter((a) => !repos.some((r) => sameRepo(a, r)));
  let requireApproval = state.requireApproval;
  if (approved.length === 0 && !requireApproval && state.approved.length > 0) {
    if (!opts.whenEmpty) {
      return { ok: false, status: 409, error: "would-empty", installationCount: getInstallationRepos().length };
    }
    requireApproval = opts.whenEmpty === "require-approval";
  }
  return save(db, { requireApproval, approved }, actor);
}

/** Turn "require repo approval" on or off; the approved list is unchanged. */
export async function setRequireApproval(db: SettingsDb, enabled: boolean, actor?: string): Promise<ApprovalResult> {
  const { state } = getRepoApprovalState();
  return save(db, { ...state, requireApproval: enabled }, actor);
}

/**
 * Turn Last Light's bare `owner/repo` + issue/PR number into github.com links.
 *
 * Runs only carry a bare `owner/repo` string and a single `issueNumber` (used
 * for both issues and PRs — there's no separate `prNumber`). Only emit a link
 * when the repo string actually looks like `owner/repo`; some runs store just
 * the bare repo name (the owner then lives in `run.context.owner`), which we
 * can't turn into a URL on its own.
 */

const GITHUB = "https://github.com";

const OWNER_REPO = /^[^/\s]+\/[^/\s]+$/;

/** `owner/repo` → `https://github.com/owner/repo`, else `null`. */
export function repoUrl(repo: string | null | undefined): string | null {
  const full = repo?.trim();
  if (!full || !OWNER_REPO.test(full)) return null;
  return `${GITHUB}/${full}`;
}

/**
 * Resolve a run's qualified `owner/repo` for linking, else `null`.
 *
 * The client-side twin of `state/repo-ref.ts`'s `qualifyRepo` — hand-mirrored
 * because the dashboard has no import edge to core, the same way `api.ts`
 * mirrors the row types. Runs store the pair: a BARE `repo`
 * (`drizzle-cube-help`) plus a separate `owner` column, in both the list and
 * detail payloads. So `repoUrl(run.repo)` alone never links a run.
 *
 * Two fallbacks, for rows the #279 backfill couldn't reach: the owner may live
 * only in `context.owner` (detail payload), or embedded in the `owner/repo#N` /
 * `owner/repo::workflow` `triggerId`.
 */
export function runRepoPath(run: {
  repo?: string | null;
  owner?: string | null;
  triggerId?: string | null;
  context?: Record<string, unknown> | null;
}): string | null {
  const bare = run.repo?.trim();
  const owner =
    run.owner?.trim() ||
    (typeof run.context?.owner === "string" ? run.context.owner.trim() : "");
  if (bare && owner && !bare.includes("/")) return `${owner}/${bare}`;
  // Legacy: a row written before the backfill put the qualified string in
  // `repo` itself. Never re-qualify one of those.
  if (bare && OWNER_REPO.test(bare)) return bare;
  // Legacy: pull the LEADING `owner/repo` from the trigger id, stopping at the
  // `#` or `:` suffix so `owner/repo::repo-health` can't slip through.
  const fromTrigger = run.triggerId?.match(/^([^/\s#:]+\/[^/\s#:]+)(?:$|[#:])/)?.[1];
  if (fromTrigger) return fromTrigger;
  return null;
}

/**
 * `owner/repo` + number → the issue/PR URL, else `null`.
 *
 * GitHub shares one number space between issues and PRs and redirects between
 * `/issues/N` and `/pull/N`, so the path only affects which tab loads first.
 * We pick `pull` for PR-oriented workflows (name contains "pr") and `issues`
 * otherwise — either lands on the right page regardless.
 */
export function issueUrl(
  repo: string | null | undefined,
  issueNumber: number | null | undefined,
  workflowName?: string,
): string | null {
  const base = repoUrl(repo);
  if (!base || !issueNumber) return null;
  const isPr = workflowName ? /(^|[-_])pr([-_]|$)/i.test(workflowName) : false;
  return `${base}/${isPr ? "pull" : "issues"}/${issueNumber}`;
}

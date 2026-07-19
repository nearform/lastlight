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
 * Runs store `repo` as a BARE name (`drizzle-cube-help`) and the owner in a
 * separate `owner` column (both in the list + detail payloads), so
 * `repoUrl(run.repo)` alone never links a run — compose owner + repo. Older
 * rows may carry the owner only in `context.owner` (detail) or embedded in the
 * `owner/repo#N` / `owner/repo::workflow` `triggerId`; both are fallbacks.
 */
export function runRepoPath(run: {
  repo?: string | null;
  owner?: string | null;
  triggerId?: string | null;
  context?: Record<string, unknown> | null;
}): string | null {
  const bare = run.repo?.trim();
  if (bare && OWNER_REPO.test(bare)) return bare;
  // Explicit `owner` column (+ `context.owner` for pre-migration rows).
  const owner =
    run.owner?.trim() ||
    (typeof run.context?.owner === "string" ? run.context.owner.trim() : "");
  if (bare && owner && !bare.includes("/")) return `${owner}/${bare}`;
  // Legacy fallback: pull the LEADING `owner/repo` from the trigger id, stopping
  // at the `#` or `:` suffix so `owner/repo::repo-health` can't slip through.
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

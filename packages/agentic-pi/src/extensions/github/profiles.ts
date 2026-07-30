/**
 * GitHub tool profiles — registration-time gate.
 *
 * Maps the 4 lastlight profile names to the set of Pi tool names allowed
 * in that profile. Tools NOT in the active profile are never registered, so
 * the LLM cannot call them. Combined with the token-scope downscoping
 * lastlight does on the host side, this gives defense-in-depth.
 *
 * Mirrors lastlight's `GITHUB_PERMISSION_PROFILES` token scopes:
 *   read         → contents:r, issues:r, pull_requests:r, metadata:r
 *   issues-write → ditto + issues:w + pull_requests:w
 *   review-write → same scopes as issues-write
 *   repo-write   → ditto + contents:w + workflows:w
 *
 * `issues-write` and `review-write` carry the same TOKEN scopes: commenting or
 * labelling on a pull request requires `pull_requests: write` (GitHub checks
 * the target's type, not the endpoint's path — lastlight issue #239), and
 * that is also the coarsest grain GitHub offers. The profiles diverge here, in
 * the tool sets: only `review-write`+ registers `github_create_pull_request` /
 * `github_create_pull_request_review`. This gate — not the token — is what
 * keeps a comment workflow from submitting a formal review.
 */

export type GitAccessProfile = "read" | "issues-write" | "review-write" | "repo-write";

const READ_TOOLS = [
  // git auth (refresh is read-only — just rotates the token in the file)
  "github_refresh_git_auth",
  // repo read
  "github_get_repository",
  "github_get_file_contents",
  "github_list_branches",
  "github_list_commits",
  // issue read
  "github_list_issues",
  "github_get_issue",
  "github_list_issue_comments",
  "github_list_labels",
  // PR read
  "github_list_pull_requests",
  "github_get_pull_request",
  "github_list_pull_request_files",
  "github_get_pull_request_diff",
  "github_list_pull_request_reviews",
  "github_list_pull_request_review_comments",
  // search
  "github_search_repositories",
  "github_search_issues",
  "github_search_code",
] as const;

const ISSUES_WRITE_TOOLS = [
  ...READ_TOOLS,
  "github_create_issue",
  "github_update_issue",
  "github_add_issue_comment",
  "github_add_labels",
  "github_remove_label",
  "github_create_label",
  "github_ensure_labels",
] as const;

const REVIEW_WRITE_TOOLS = [
  ...ISSUES_WRITE_TOOLS,
  "github_create_pull_request",
  "github_create_pull_request_review",
] as const;

const REPO_WRITE_TOOLS = [
  ...REVIEW_WRITE_TOOLS,
  "github_clone_repo",
  "github_create_or_update_file",
  "github_push_files",
  "github_create_branch",
  "github_merge_pull_request",
  "github_enable_auto_merge",
] as const;

export const PROFILE_TOOLS: Record<GitAccessProfile, readonly string[]> = {
  read: READ_TOOLS,
  "issues-write": ISSUES_WRITE_TOOLS,
  "review-write": REVIEW_WRITE_TOOLS,
  "repo-write": REPO_WRITE_TOOLS,
};

export function isGitAccessProfile(s: string): s is GitAccessProfile {
  return s in PROFILE_TOOLS;
}

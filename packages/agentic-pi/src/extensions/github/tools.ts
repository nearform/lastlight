/**
 * GitHub tools as Pi defineTool() registrations.
 *
 * 1:1 with lastlight/mcp-github-app/src/index.js. Tool names are prefixed
 * with `github_` to match opencode's MCP-server-name prefix convention
 * (lastlight's dashboard shim already maps `github_<tool>` → display name).
 *
 * Each tool returns its JSON payload as a single text content block —
 * matching the MCP server's `jsonResult` helper. Errors are surfaced the
 * same way (an object with `error` / `status` / `transient` / `hint` keys)
 * instead of being thrown, so the agent can recover.
 */

import { execFileSync } from "node:child_process";
import { isAbsolute, join } from "node:path";

import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { defineTool } from "@earendil-works/pi-coding-agent";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import type { GitHubAuth } from "./auth.js";
import { GitHubClient, type GitHubClientOptions } from "./client.js";
import { gitAuthEnv } from "./credentials.js";

interface MaybeHttpError extends Error {
  status?: number;
  response?: { status?: number };
  stderr?: Buffer | string;
}

function jsonContent(data: unknown) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }],
    details: {},
  };
}

/**
 * Wrap a handler so errors become structured JSON results instead of throws.
 * Matches mcp-github-app's `run()` helper exactly.
 */
async function safeRun<T>(fn: () => Promise<T>, canRefresh = true) {
  try {
    return jsonContent(await fn());
  } catch (err) {
    const e = err as MaybeHttpError;
    const status = e.status || e.response?.status;
    const transientStatuses = [408, 429, 500, 502, 503, 504];
    const isTransient = status !== undefined && transientStatuses.includes(status);
    return jsonContent({
      error: e.message,
      status: status ?? null,
      transient: isTransient,
      hint: isTransient
        ? "This is a transient error. The request was retried automatically but still failed. Wait and try again."
        : status === 401
          ? canRefresh
            ? "Authentication failed. Call github_refresh_git_auth to get a fresh token."
            : "Authentication failed and the token CANNOT be refreshed here — a fixed GITHUB_TOKEN was injected for this run, so github_refresh_git_auth can't re-mint it. Do not retry in a loop; report the auth failure."
          : null,
    });
  }
}

/**
 * Build the entire GitHub tool set. Caller filters by profile.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function buildGitHubTools(
  auth: GitHubAuth,
  opts: GitHubClientOptions = {},
): ToolDefinition<any>[] {
  const gh = new GitHubClient(auth, opts);

  // Helper to keep the defineTool boilerplate tight.
  const tool = <P extends TSchema>(
    name: string,
    description: string,
    parameters: P,
    handler: (params: Static<P>) => Promise<unknown>,
  ): ToolDefinition<P> =>
    defineTool({
      name,
      label: name,
      description,
      parameters,
      async execute(_id, params) {
        return safeRun(() => handler(params), auth.canRefresh);
      },
    });

  return [
    // ── Git Auth ──────────────────────────────────────────────────────

    tool(
      "github_clone_repo",
      "Clone a repository with GitHub App authentication. Sets up the credential helper automatically; commit identity comes from the ambient git config/environment. git push/pull/fetch will just work after cloning.",
      Type.Object({
        owner: Type.String({ description: "Repository owner" }),
        repo: Type.String({ description: "Repository name" }),
        branch: Type.Optional(
          Type.String({ description: "Branch to checkout (default: repo default branch)" }),
        ),
        path: Type.Optional(
          Type.String({ description: "Local path to clone into (default: repo name)" }),
        ),
      }),
      async ({ owner, repo, branch, path: clonePath }) => {
        const token = await auth.getToken();
        const baseDir = process.env.LASTLIGHT_WORKSPACE || process.cwd();
        const requested = clonePath || repo;
        const dest = isAbsolute(requested) ? requested : join(baseDir, requested);
        // Auth via a github.com-scoped http.extraheader on the child's env — no
        // token in the URL, no credentials file on disk. Subsequent push/pull
        // from the agent's bash pick up the same header from the sandbox's
        // ambient GIT_CONFIG_* env (or, standalone, the operator's git config).
        const url = `https://github.com/${owner}/${repo}.git`;
        const branchArgs = branch ? ["--branch", branch] : [];
        execFileSync("git", ["clone", ...branchArgs, url, dest], {
          stdio: "pipe",
          timeout: 120_000,
          env: { ...process.env, ...gitAuthEnv(token), GIT_TERMINAL_PROMPT: "0" },
        });
        // Deliberately do NOT write a repo-local user.name/user.email. Commit
        // identity comes from whatever is configured in the environment — the
        // ambient GIT_AUTHOR_*/GIT_COMMITTER_* env the harness injects (so
        // commits are attributed to the configured bot login), or the operator's
        // own global git config for standalone use. No hardcoded default.
        return {
          cloned: `${owner}/${repo}`,
          path: dest,
          branch: branch || "(default)",
          expires_at: auth.expiresAt?.toISOString(),
        };
      },
    ),

    tool(
      "github_refresh_git_auth",
      "Refresh the GitHub App token for an existing git clone. Call this if git push/pull fails with auth errors. Re-mints the installation token used by the github.com http.extraheader.",
      Type.Object({
        path: Type.String({ description: "Path to the git repository" }),
      }),
      async ({ path }) => {
        // A static injected token has no private key to re-mint from — calling
        // getToken() would hand back the SAME value. Report that honestly rather
        // than a misleading `refreshed: true`, so the agent stops looping on a
        // credential that can't change (the sandbox case).
        if (!auth.canRefresh) {
          return {
            refreshed: false,
            path,
            reason:
              "This run uses a fixed GITHUB_TOKEN that cannot be re-minted here; the credential is unchanged. If calls keep 401-ing the token is stuck — report the failure rather than retrying.",
          };
        }
        // App auth: refresh-if-expired; the (possibly new) token flows into every
        // subsequent git child via gitAuthEnv (and the harness's ambient env in
        // the sandbox). No file to rewrite.
        await auth.getToken();
        return {
          refreshed: true,
          path,
          expires_at: auth.expiresAt?.toISOString(),
        };
      },
    ),

    // ── Repository ────────────────────────────────────────────────────

    tool(
      "github_get_repository",
      "Get repository metadata",
      Type.Object({ owner: Type.String(), repo: Type.String() }),
      ({ owner, repo }) => gh.getRepository(owner, repo),
    ),

    tool(
      "github_get_file_contents",
      "Get contents of a file or directory from a repository",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        path: Type.String(),
        branch: Type.Optional(Type.String()),
      }),
      ({ owner, repo, path, branch }) => gh.getFileContents(owner, repo, path, branch),
    ),

    tool(
      "github_create_or_update_file",
      "Create or update a single file in a repository",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        path: Type.String(),
        content: Type.String({ description: "File content" }),
        message: Type.String({ description: "Commit message" }),
        branch: Type.Optional(Type.String()),
        sha: Type.Optional(
          Type.String({ description: "SHA of file being replaced (for updates)" }),
        ),
      }),
      ({ owner, repo, path, content, message, branch, sha }) =>
        gh.createOrUpdateFile(owner, repo, path, content, message, branch, sha),
    ),

    tool(
      "github_push_files",
      "Push multiple files in a single commit",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        branch: Type.String(),
        files: Type.Array(Type.Object({ path: Type.String(), content: Type.String() })),
        message: Type.String(),
      }),
      ({ owner, repo, branch, files, message }) =>
        gh.pushFiles(owner, repo, branch, files, message),
    ),

    tool(
      "github_list_branches",
      "List branches in a repository",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        page: Type.Optional(Type.Number()),
        per_page: Type.Optional(Type.Number()),
      }),
      ({ owner, repo, page, per_page }) => gh.listBranches(owner, repo, page, per_page),
    ),

    tool(
      "github_create_branch",
      "Create a new branch from an existing branch",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        branch: Type.String({ description: "New branch name" }),
        from_branch: Type.String({ description: "Source branch" }),
      }),
      ({ owner, repo, branch, from_branch }) => gh.createBranch(owner, repo, branch, from_branch),
    ),

    // ── Issues ────────────────────────────────────────────────────────

    tool(
      "github_list_issues",
      "List open issues in a repository",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        state: Type.Optional(
          Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")]),
        ),
        labels: Type.Optional(Type.String({ description: "Comma-separated label names" })),
        sort: Type.Optional(
          Type.Union([Type.Literal("created"), Type.Literal("updated"), Type.Literal("comments")]),
        ),
        direction: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
        page: Type.Optional(Type.Number()),
        per_page: Type.Optional(Type.Number()),
      }),
      ({ owner, repo, ...opts }) => gh.listIssues(owner, repo, opts),
    ),

    tool(
      "github_get_issue",
      "Get a specific issue by number",
      Type.Object({ owner: Type.String(), repo: Type.String(), issue_number: Type.Number() }),
      ({ owner, repo, issue_number }) => gh.getIssue(owner, repo, issue_number),
    ),

    tool(
      "github_create_issue",
      "Create a new issue. Only `owner`, `repo`, and `title` are required; `body` and `labels` are optional. The agent should NOT set milestone or assignees — humans manage those.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        title: Type.String(),
        body: Type.Optional(Type.String()),
        labels: Type.Optional(Type.Array(Type.String())),
      }),
      ({ owner, repo, title, body, ...opts }) => gh.createIssue(owner, repo, title, body, opts),
    ),

    tool(
      "github_update_issue",
      "Update an existing issue (title, body, state, labels, assignees)",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        issue_number: Type.Number(),
        title: Type.Optional(Type.String()),
        body: Type.Optional(Type.String()),
        state: Type.Optional(Type.Union([Type.Literal("open"), Type.Literal("closed")])),
        labels: Type.Optional(Type.Array(Type.String())),
        assignees: Type.Optional(Type.Array(Type.String())),
      }),
      ({ owner, repo, issue_number, ...updates }) =>
        gh.updateIssue(owner, repo, issue_number, updates),
    ),

    tool(
      "github_add_issue_comment",
      "Add a comment to an issue or pull request",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        issue_number: Type.Number(),
        body: Type.String(),
      }),
      ({ owner, repo, issue_number, body }) => gh.addIssueComment(owner, repo, issue_number, body),
    ),

    tool(
      "github_list_issue_comments",
      "List comments on an issue",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        issue_number: Type.Number(),
        page: Type.Optional(Type.Number()),
        per_page: Type.Optional(Type.Number()),
      }),
      ({ owner, repo, issue_number, ...opts }) =>
        gh.listIssueComments(owner, repo, issue_number, opts),
    ),

    tool(
      "github_add_labels",
      "Add labels to an issue or PR",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        issue_number: Type.Number(),
        labels: Type.Array(Type.String()),
      }),
      ({ owner, repo, issue_number, labels }) => gh.addLabels(owner, repo, issue_number, labels),
    ),

    tool(
      "github_remove_label",
      "Remove a label from an issue or PR",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        issue_number: Type.Number(),
        name: Type.String(),
      }),
      ({ owner, repo, issue_number, name }) => gh.removeLabel(owner, repo, issue_number, name),
    ),

    tool(
      "github_list_labels",
      "List all labels in a repository",
      Type.Object({ owner: Type.String(), repo: Type.String() }),
      ({ owner, repo }) => gh.listLabels(owner, repo),
    ),

    tool(
      "github_create_label",
      "Create a new label in a repository",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        name: Type.String(),
        color: Type.String({ description: "Hex color without #, e.g. 'ff0000'" }),
        description: Type.Optional(Type.String()),
      }),
      ({ owner, repo, name, color, description }) =>
        gh.createLabel(owner, repo, name, color, description),
    ),

    tool(
      "github_ensure_labels",
      "Idempotently ensure a set of labels exists in a repository. Lists labels once, then creates only the missing ones (bulk). Prefer this over calling github_create_label per label — it never errors on labels that already exist. Returns { created, existed }.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        labels: Type.Array(
          Type.Object({
            name: Type.String(),
            color: Type.Optional(
              Type.String({ description: "Hex color without #, e.g. 'ff0000'" }),
            ),
            description: Type.Optional(Type.String()),
          }),
        ),
      }),
      ({ owner, repo, labels }) => gh.ensureLabels(owner, repo, labels),
    ),

    // ── Pull Requests ─────────────────────────────────────────────────

    tool(
      "github_list_pull_requests",
      "List pull requests in a repository",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        state: Type.Optional(
          Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")]),
        ),
        sort: Type.Optional(
          Type.Union([
            Type.Literal("created"),
            Type.Literal("updated"),
            Type.Literal("popularity"),
            Type.Literal("long-running"),
          ]),
        ),
        direction: Type.Optional(Type.Union([Type.Literal("asc"), Type.Literal("desc")])),
        head: Type.Optional(Type.String({ description: "Filter by head branch (user:branch)" })),
        base: Type.Optional(Type.String({ description: "Filter by base branch" })),
        page: Type.Optional(Type.Number()),
        per_page: Type.Optional(Type.Number()),
      }),
      ({ owner, repo, ...opts }) => gh.listPullRequests(owner, repo, opts),
    ),

    tool(
      "github_get_pull_request",
      "Get a specific pull request by number",
      Type.Object({ owner: Type.String(), repo: Type.String(), pull_number: Type.Number() }),
      ({ owner, repo, pull_number }) => gh.getPullRequest(owner, repo, pull_number),
    ),

    tool(
      "github_create_pull_request",
      "Create a new pull request",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        title: Type.String(),
        body: Type.Optional(Type.String()),
        head: Type.String({ description: "Branch with changes" }),
        base: Type.String({ description: "Branch to merge into" }),
      }),
      ({ owner, repo, title, body, head, base }) =>
        gh.createPullRequest(owner, repo, title, body, head, base),
    ),

    tool(
      "github_list_pull_request_files",
      "List files changed in a pull request",
      Type.Object({ owner: Type.String(), repo: Type.String(), pull_number: Type.Number() }),
      ({ owner, repo, pull_number }) => gh.listPullRequestFiles(owner, repo, pull_number),
    ),

    tool(
      "github_get_pull_request_diff",
      "Get the diff of a pull request",
      Type.Object({ owner: Type.String(), repo: Type.String(), pull_number: Type.Number() }),
      ({ owner, repo, pull_number }) => gh.getPullRequestDiff(owner, repo, pull_number),
    ),

    tool(
      "github_list_pull_request_reviews",
      "List submitted reviews on a pull request (each with state APPROVED/CHANGES_REQUESTED/COMMENTED, reviewer login, body, and commit SHA). Use to check whether the bot has already reviewed this PR.",
      Type.Object({ owner: Type.String(), repo: Type.String(), pull_number: Type.Number() }),
      ({ owner, repo, pull_number }) => gh.listPullRequestReviews(owner, repo, pull_number),
    ),

    tool(
      "github_list_pull_request_review_comments",
      "List line-level review comments on a pull request (each with path, line, body, commit_id, reviewer login). Distinct from issue comments — these are anchored to specific diff lines.",
      Type.Object({ owner: Type.String(), repo: Type.String(), pull_number: Type.Number() }),
      ({ owner, repo, pull_number }) => gh.listPullRequestReviewComments(owner, repo, pull_number),
    ),

    tool(
      "github_create_pull_request_review",
      "Create a review on a pull request",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        pull_number: Type.Number(),
        body: Type.String({ description: "Review summary" }),
        event: Type.Union([
          Type.Literal("APPROVE"),
          Type.Literal("REQUEST_CHANGES"),
          Type.Literal("COMMENT"),
        ]),
        comments: Type.Optional(
          Type.Array(
            Type.Object({
              path: Type.String(),
              position: Type.Optional(Type.Number()),
              line: Type.Optional(Type.Number()),
              body: Type.String(),
            }),
          ),
        ),
      }),
      ({ owner, repo, pull_number, body, event, comments }) =>
        gh.createPullRequestReview(owner, repo, pull_number, body, event, comments || []),
    ),

    tool(
      "github_merge_pull_request",
      "Merge a pull request",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        pull_number: Type.Number(),
        commit_title: Type.Optional(Type.String()),
        commit_message: Type.Optional(Type.String()),
        merge_method: Type.Optional(
          Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")]),
        ),
      }),
      ({ owner, repo, pull_number, ...opts }) =>
        gh.mergePullRequest(owner, repo, pull_number, opts),
    ),

    tool(
      "github_enable_auto_merge",
      "Enable auto-merge on a pull request: GitHub merges it automatically once the required status checks pass (it will NOT merge a PR whose checks are failing or still running). Use this instead of github_merge_pull_request when you want the merge gated on green CI. Returns { ok: false, reason } if the repository does not allow auto-merge.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        pull_number: Type.Number(),
        merge_method: Type.Optional(
          Type.Union([Type.Literal("merge"), Type.Literal("squash"), Type.Literal("rebase")]),
        ),
      }),
      ({ owner, repo, pull_number, merge_method }) =>
        gh.enablePullRequestAutoMerge(owner, repo, pull_number, merge_method),
    ),

    // ── Commits ───────────────────────────────────────────────────────

    tool(
      "github_list_commits",
      "List commits on a repository or branch",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        sha: Type.Optional(Type.String({ description: "Branch name or commit SHA" })),
        path: Type.Optional(Type.String({ description: "Only commits touching this path" })),
        page: Type.Optional(Type.Number()),
        per_page: Type.Optional(Type.Number()),
      }),
      ({ owner, repo, ...opts }) => gh.listCommits(owner, repo, opts),
    ),

    // ── Search ────────────────────────────────────────────────────────

    tool(
      "github_search_repositories",
      "Search for GitHub repositories",
      Type.Object({
        query: Type.String(),
        page: Type.Optional(Type.Number()),
        per_page: Type.Optional(Type.Number()),
      }),
      ({ query, page, per_page }) => gh.searchRepositories(query, page, per_page),
    ),

    tool(
      "github_search_issues",
      "Search issues and pull requests across repositories",
      Type.Object({
        query: Type.String({
          description: "GitHub search query (e.g. 'repo:owner/name is:open label:bug')",
        }),
        page: Type.Optional(Type.Number()),
        per_page: Type.Optional(Type.Number()),
      }),
      ({ query, page, per_page }) => gh.searchIssues(query, page, per_page),
    ),

    tool(
      "github_search_code",
      "Search code across repositories",
      Type.Object({
        query: Type.String({ description: "GitHub code search query" }),
        page: Type.Optional(Type.Number()),
        per_page: Type.Optional(Type.Number()),
      }),
      ({ query, page, per_page }) => gh.searchCode(query, page, per_page),
    ),
  ];
}

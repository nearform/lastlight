#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { execFileSync } from "child_process";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, isAbsolute, join } from "path";
import { GitHubAppAuth } from "./auth.js";
import { GitHubClient } from "./github.js";

/**
 * Conservative shape check on a GitHub installation token. The credentials
 * file contains a URL of the form `https://x-access-token:${token}@github.com`,
 * so any `@`, `:`, `/`, or newline in the token would break URL parsing or
 * inject extra entries. Real tokens are alphanumeric (plus `_`); this catches
 * any future format change before we write a malformed file. Mirrors the
 * assertion in `src/engine/git-auth.ts` and `deploy/sandbox-entrypoint.sh`.
 */
function assertSafeToken(token) {
  if (typeof token !== "string" || !/^[A-Za-z0-9_-]+$/.test(token)) {
    throw new Error("Refusing to embed a token containing characters outside [A-Za-z0-9_-] into git credentials file");
  }
}

/**
 * Path of the shared `git credential-store` credentials file. The sandbox
 * entrypoint creates and owns this file; we rewrite it here when refreshing
 * the token. Falls back to a per-process file when the env var isn't set
 * (e.g. running outside the sandbox during tests). Whitespace in the path
 * would break git's helper-arg splitting — assert defensively.
 */
function credentialsFilePath() {
  const p = (process.env.LASTLIGHT_GIT_CREDENTIALS || "").trim()
    || join(process.env.HOME || "/tmp", ".lastlight-git-credentials");
  if (/\s/.test(p)) {
    throw new Error(`LASTLIGHT_GIT_CREDENTIALS contains whitespace; git's helper-arg parsing would break: ${p}`);
  }
  return p;
}

/**
 * Write the credentials file. Mode 600, single line, no shell anywhere.
 */
function writeCredentialsFile(token) {
  assertSafeToken(token);
  const credPath = credentialsFilePath();
  mkdirSync(dirname(credPath), { recursive: true, mode: 0o700 });
  writeFileSync(credPath, `https://x-access-token:${token}@github.com\n`, { mode: 0o600 });
  return credPath;
}

// ── Config from environment ─────────────────────────────────────────

const appId = process.env.GITHUB_APP_ID;
const privateKeyPath = process.env.GITHUB_APP_PRIVATE_KEY_PATH;
const installationId = process.env.GITHUB_APP_INSTALLATION_ID;
const staticToken = process.env.GITHUB_TOKEN;

const hasAppCreds = Boolean(appId && privateKeyPath && installationId);

if (!staticToken && !hasAppCreds) {
  console.error(
    "Required auth env vars: either GITHUB_TOKEN or all of GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY_PATH, GITHUB_APP_INSTALLATION_ID"
  );
  process.exit(1);
}

// Prefer GitHub App credentials when both are present. Static-token mode is
// the fallback for low-trust sandboxes that intentionally clear the App env
// vars (see executor.ts: GITHUB_APP_ID="" + ALLOW_APP_PEM=0). This ordering
// stops a stale host-side GITHUB_TOKEN PAT from silently downgrading the
// agent's auth — which surfaced as a 403 "Resource not accessible by
// personal access token" when the chat skill tried to create an issue.
const auth = hasAppCreds
  ? new GitHubAppAuth({ appId, privateKeyPath, installationId })
  : {
      async getToken() {
        return staticToken;
      },
      get expiresAt() {
        return null;
      },
    };
const gh = new GitHubClient(auth);

// ── MCP Server ──────────────────────────────────────────────────────

const server = new McpServer({
  name: "github-app",
  version: "1.0.0",
});

// Helper to run a tool handler and return JSON result
function jsonResult(data) {
  return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
}

async function run(fn) {
  try {
    const result = await fn();
    return jsonResult(result);
  } catch (e) {
    const status = e.status || e.response?.status;
    const isTransient = [408, 429, 500, 502, 503, 504].includes(status);
    return jsonResult({
      error: e.message,
      status: status || null,
      transient: isTransient,
      hint: isTransient
        ? "This is a transient error. The request was retried automatically but still failed. Wait and try again."
        : status === 401
          ? "Authentication failed. Call refresh_git_auth to get a fresh token."
          : null,
    });
  }
}

// ── Git Auth Tools ──────────────────────────────────────────────────

server.tool(
  "clone_repo",
  "Clone a repository with GitHub App authentication. Sets up credential helper and bot identity automatically. git push/pull/fetch will just work after cloning.",
  {
    owner: z.string().describe("Repository owner"),
    repo: z.string().describe("Repository name"),
    branch: z.string().optional().describe("Branch to checkout (default: repo default branch)"),
    path: z.string().optional().describe("Local path to clone into (default: repo name)"),
  },
  async ({ owner, repo, branch, path: clonePath }) => {
    try {
      const token = await auth.getToken();
      // Resolve relative paths against the sandbox workspace, not the
      // MCP server's inherited cwd. OpenCode spawns MCP tools with cwd
      // `/tmp/opencode/<scratch>` which isn't writable by the agent user,
      // so a bare `lastlight-pr51` would fail with EACCES.
      const baseDir = process.env.LASTLIGHT_WORKSPACE || process.cwd();
      const requested = clonePath || repo;
      const dest = isAbsolute(requested) ? requested : join(baseDir, requested);

      // Refresh the shared credentials file with the freshly-minted token,
      // and point this clone's repo-local helper at the same file. No shell
      // interp anywhere — `store --file=<path>` is argv-split by git, and
      // the path has no whitespace (asserted in credentialsFilePath).
      const credPath = writeCredentialsFile(token);
      const url = `https://github.com/${owner}/${repo}.git`;

      const branchArgs = branch ? ["--branch", branch] : [];
      execFileSync("git", ["clone", ...branchArgs, url, dest], {
        stdio: "pipe",
        timeout: 120_000,
        // System-level credential.helper from sandbox-entrypoint already
        // covers this clone, but pass GIT_TERMINAL_PROMPT=0 so a missing
        // helper fails fast instead of hanging on a TTY prompt.
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
      });

      // Pin a repo-local helper too, so this clone keeps working even if a
      // later process clears the system config (e.g. CI scripts that
      // `git config --system --unset-all`).
      execFileSync("git", ["-C", dest, "config", "credential.helper", `store --file=${credPath}`], { stdio: "pipe" });

      // Set bot identity for commits
      execFileSync("git", ["-C", dest, "config", "user.name", "last-light[bot]"], { stdio: "pipe" });
      execFileSync("git", ["-C", dest, "config", "user.email", "last-light[bot]@users.noreply.github.com"], { stdio: "pipe" });

      return jsonResult({
        cloned: `${owner}/${repo}`,
        path: dest,
        credentials_file: credPath,
        branch: branch || "(default)",
        expires_at: auth.expiresAt?.toISOString(),
      });
    } catch (e) {
      return jsonResult({ error: e.message, stderr: e.stderr?.toString() });
    }
  }
);

server.tool(
  "refresh_git_auth",
  "Refresh the GitHub App token for an existing git clone. Call this if git push/pull fails with auth errors. Updates the credential helper with a fresh token.",
  {
    path: z.string().describe("Path to the git repository"),
  },
  async ({ path: repoPath }) => {
    try {
      const token = await auth.getToken();
      // Re-write the shared credentials file with the fresh token. The
      // existing credential.helper config (system-wide from
      // sandbox-entrypoint, plus repo-local from clone_repo) already
      // points at this path, so updating the file body is enough — no
      // git config changes required.
      const credPath = writeCredentialsFile(token);
      return jsonResult({
        refreshed: true,
        path: repoPath,
        credentials_file: credPath,
        expires_at: auth.expiresAt?.toISOString(),
      });
    } catch (e) {
      return jsonResult({ error: e.message });
    }
  }
);

// DEPRECATED: Use clone_repo + refresh_git_auth instead.
// Kept for backward compatibility with Hermes-based workflows.
server.tool(
  "setup_git_auth",
  "[DEPRECATED — use clone_repo instead] Refresh the GitHub App token and write it to the credential file for Hermes sandbox sync.",
  { owner: z.string().describe("Repository owner"), repo: z.string().describe("Repository name") },
  async ({ owner, repo }) => {
    try {
      const token = await auth.getToken();
      const fs = await import("fs");
      const nodePath = await import("path");

      const hermesHome = process.env.HERMES_HOME || (process.env.HOME + "/.hermes");
      const tokenPath = nodePath.join(hermesHome, ".gh-token");
      fs.writeFileSync(tokenPath, token, { mode: 0o600 });

      return jsonResult({
        deprecated: "Use clone_repo instead — it handles auth, clone, and identity in one step.",
        expires_at: auth.expiresAt?.toISOString(),
        token_file: tokenPath,
        configure_git: `git config --global include.path ${hermesHome}/.gitconfig-bot`,
        clone_with: `git clone https://github.com/${owner}/${repo}.git`,
      });
    } catch (e) {
      return jsonResult({ error: e.message });
    }
  }
);

// ── Repository Tools ────────────────────────────────────────────────

server.tool(
  "get_repository",
  "Get repository metadata",
  { owner: z.string(), repo: z.string() },
  async ({ owner, repo }) => run(() => gh.getRepository(owner, repo))
);

server.tool(
  "get_file_contents",
  "Get contents of a file or directory from a repository",
  {
    owner: z.string(),
    repo: z.string(),
    path: z.string(),
    branch: z.string().optional(),
  },
  async ({ owner, repo, path, branch }) =>
    run(() => gh.getFileContents(owner, repo, path, branch))
);

server.tool(
  "create_or_update_file",
  "Create or update a single file in a repository",
  {
    owner: z.string(),
    repo: z.string(),
    path: z.string(),
    content: z.string().describe("File content"),
    message: z.string().describe("Commit message"),
    branch: z.string().optional(),
    sha: z.string().optional().describe("SHA of file being replaced (for updates)"),
  },
  async ({ owner, repo, path, content, message, branch, sha }) =>
    run(() => gh.createOrUpdateFile(owner, repo, path, content, message, branch, sha))
);

server.tool(
  "push_files",
  "Push multiple files in a single commit",
  {
    owner: z.string(),
    repo: z.string(),
    branch: z.string(),
    files: z.array(z.object({ path: z.string(), content: z.string() })),
    message: z.string(),
  },
  async ({ owner, repo, branch, files, message }) =>
    run(() => gh.pushFiles(owner, repo, branch, files, message))
);

server.tool(
  "list_branches",
  "List branches in a repository",
  {
    owner: z.string(),
    repo: z.string(),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async ({ owner, repo, page, per_page }) =>
    run(() => gh.listBranches(owner, repo, page, per_page))
);

server.tool(
  "create_branch",
  "Create a new branch from an existing branch",
  {
    owner: z.string(),
    repo: z.string(),
    branch: z.string().describe("New branch name"),
    from_branch: z.string().describe("Source branch"),
  },
  async ({ owner, repo, branch, from_branch }) =>
    run(() => gh.createBranch(owner, repo, branch, from_branch))
);

// ── Issue Tools ─────────────────────────────────────────────────────

server.tool(
  "list_issues",
  "List open issues in a repository",
  {
    owner: z.string(),
    repo: z.string(),
    state: z.enum(["open", "closed", "all"]).optional(),
    labels: z.string().optional().describe("Comma-separated label names"),
    sort: z.enum(["created", "updated", "comments"]).optional(),
    direction: z.enum(["asc", "desc"]).optional(),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async ({ owner, repo, ...opts }) => run(() => gh.listIssues(owner, repo, opts))
);

server.tool(
  "get_issue",
  "Get a specific issue by number",
  { owner: z.string(), repo: z.string(), issue_number: z.number() },
  async ({ owner, repo, issue_number }) => run(() => gh.getIssue(owner, repo, issue_number))
);

server.tool(
  "create_issue",
  "Create a new issue",
  {
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
    body: z.string().optional(),
    labels: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional(),
    milestone: z.number().optional(),
  },
  async ({ owner, repo, title, body, ...opts }) =>
    run(() => gh.createIssue(owner, repo, title, body, opts))
);

server.tool(
  "update_issue",
  "Update an existing issue (title, body, state, labels, assignees)",
  {
    owner: z.string(),
    repo: z.string(),
    issue_number: z.number(),
    title: z.string().optional(),
    body: z.string().optional(),
    state: z.enum(["open", "closed"]).optional(),
    labels: z.array(z.string()).optional(),
    assignees: z.array(z.string()).optional(),
  },
  async ({ owner, repo, issue_number, ...updates }) =>
    run(() => gh.updateIssue(owner, repo, issue_number, updates))
);

server.tool(
  "add_issue_comment",
  "Add a comment to an issue or pull request",
  {
    owner: z.string(),
    repo: z.string(),
    issue_number: z.number(),
    body: z.string(),
  },
  async ({ owner, repo, issue_number, body }) =>
    run(() => gh.addIssueComment(owner, repo, issue_number, body))
);

server.tool(
  "list_issue_comments",
  "List comments on an issue",
  {
    owner: z.string(),
    repo: z.string(),
    issue_number: z.number(),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async ({ owner, repo, issue_number, ...opts }) =>
    run(() => gh.listIssueComments(owner, repo, issue_number, opts))
);

server.tool(
  "add_labels",
  "Add labels to an issue or PR",
  {
    owner: z.string(),
    repo: z.string(),
    issue_number: z.number(),
    labels: z.array(z.string()),
  },
  async ({ owner, repo, issue_number, labels }) =>
    run(() => gh.addLabels(owner, repo, issue_number, labels))
);

server.tool(
  "remove_label",
  "Remove a label from an issue or PR",
  {
    owner: z.string(),
    repo: z.string(),
    issue_number: z.number(),
    name: z.string(),
  },
  async ({ owner, repo, issue_number, name }) =>
    run(() => gh.removeLabel(owner, repo, issue_number, name))
);

server.tool(
  "list_labels",
  "List all labels in a repository",
  { owner: z.string(), repo: z.string() },
  async ({ owner, repo }) => run(() => gh.listLabels(owner, repo))
);

server.tool(
  "create_label",
  "Create a new label in a repository",
  {
    owner: z.string(),
    repo: z.string(),
    name: z.string(),
    color: z.string().describe("Hex color without #, e.g. 'ff0000'"),
    description: z.string().optional(),
  },
  async ({ owner, repo, name, color, description }) =>
    run(() => gh.createLabel(owner, repo, name, color, description))
);

// ── Pull Request Tools ──────────────────────────────────────────────

server.tool(
  "list_pull_requests",
  "List pull requests in a repository",
  {
    owner: z.string(),
    repo: z.string(),
    state: z.enum(["open", "closed", "all"]).optional(),
    sort: z.enum(["created", "updated", "popularity", "long-running"]).optional(),
    direction: z.enum(["asc", "desc"]).optional(),
    head: z.string().optional().describe("Filter by head branch (user:branch)"),
    base: z.string().optional().describe("Filter by base branch"),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async ({ owner, repo, ...opts }) => run(() => gh.listPullRequests(owner, repo, opts))
);

server.tool(
  "get_pull_request",
  "Get a specific pull request by number",
  { owner: z.string(), repo: z.string(), pull_number: z.number() },
  async ({ owner, repo, pull_number }) => run(() => gh.getPullRequest(owner, repo, pull_number))
);

server.tool(
  "create_pull_request",
  "Create a new pull request",
  {
    owner: z.string(),
    repo: z.string(),
    title: z.string(),
    body: z.string().optional(),
    head: z.string().describe("Branch with changes"),
    base: z.string().describe("Branch to merge into"),
  },
  async ({ owner, repo, title, body, head, base }) =>
    run(() => gh.createPullRequest(owner, repo, title, body, head, base))
);

server.tool(
  "list_pull_request_files",
  "List files changed in a pull request",
  { owner: z.string(), repo: z.string(), pull_number: z.number() },
  async ({ owner, repo, pull_number }) =>
    run(() => gh.listPullRequestFiles(owner, repo, pull_number))
);

server.tool(
  "get_pull_request_diff",
  "Get the diff of a pull request",
  { owner: z.string(), repo: z.string(), pull_number: z.number() },
  async ({ owner, repo, pull_number }) =>
    run(() => gh.getPullRequestDiff(owner, repo, pull_number))
);

server.tool(
  "list_pull_request_reviews",
  "List submitted reviews on a pull request (each with state APPROVED/CHANGES_REQUESTED/COMMENTED, reviewer login, body, and commit SHA). Use to check whether the bot has already reviewed this PR, and to learn what prior reviewers flagged.",
  { owner: z.string(), repo: z.string(), pull_number: z.number() },
  async ({ owner, repo, pull_number }) =>
    run(() => gh.listPullRequestReviews(owner, repo, pull_number))
);

server.tool(
  "list_pull_request_review_comments",
  "List line-level review comments on a pull request (each with path, line, body, commit_id, reviewer login). Distinct from issue comments — these are anchored to specific diff lines. Use to avoid duplicating an in-line nit a prior reviewer already raised.",
  { owner: z.string(), repo: z.string(), pull_number: z.number() },
  async ({ owner, repo, pull_number }) =>
    run(() => gh.listPullRequestReviewComments(owner, repo, pull_number))
);

server.tool(
  "create_pull_request_review",
  "Create a review on a pull request",
  {
    owner: z.string(),
    repo: z.string(),
    pull_number: z.number(),
    body: z.string().describe("Review summary"),
    event: z.enum(["APPROVE", "REQUEST_CHANGES", "COMMENT"]),
    comments: z
      .array(
        z.object({
          path: z.string(),
          position: z.number().optional(),
          line: z.number().optional(),
          body: z.string(),
        })
      )
      .optional()
      .describe("Inline review comments"),
  },
  async ({ owner, repo, pull_number, body, event, comments }) =>
    run(() => gh.createPullRequestReview(owner, repo, pull_number, body, event, comments || []))
);

server.tool(
  "merge_pull_request",
  "Merge a pull request",
  {
    owner: z.string(),
    repo: z.string(),
    pull_number: z.number(),
    commit_title: z.string().optional(),
    commit_message: z.string().optional(),
    merge_method: z.enum(["merge", "squash", "rebase"]).optional(),
  },
  async ({ owner, repo, pull_number, ...opts }) =>
    run(() => gh.mergePullRequest(owner, repo, pull_number, opts))
);

// ── Commit Tools ────────────────────────────────────────────────────

server.tool(
  "list_commits",
  "List commits on a repository or branch",
  {
    owner: z.string(),
    repo: z.string(),
    sha: z.string().optional().describe("Branch name or commit SHA"),
    path: z.string().optional().describe("Only commits touching this path"),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async ({ owner, repo, ...opts }) => run(() => gh.listCommits(owner, repo, opts))
);

// ── Search Tools ────────────────────────────────────────────────────

server.tool(
  "search_repositories",
  "Search for GitHub repositories",
  {
    query: z.string(),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async ({ query, page, per_page }) => run(() => gh.searchRepositories(query, page, per_page))
);

server.tool(
  "search_issues",
  "Search issues and pull requests across repositories",
  {
    query: z.string().describe("GitHub search query (e.g. 'repo:owner/name is:open label:bug')"),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async ({ query, page, per_page }) => run(() => gh.searchIssues(query, page, per_page))
);

server.tool(
  "search_code",
  "Search code across repositories",
  {
    query: z.string().describe("GitHub code search query"),
    page: z.number().optional(),
    per_page: z.number().optional(),
  },
  async ({ query, page, per_page }) => run(() => gh.searchCode(query, page, per_page))
);

// ── Start ───────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);

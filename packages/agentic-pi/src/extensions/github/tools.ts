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
import {
  GitHubClient,
  isActionsDenied,
  isStaleDataError,
  type GitHubClientOptions,
  type SignedCommit,
} from "./client.js";
import { gitAuthEnv } from "./credentials.js";
import {
  DEFAULT_LOG_EXCERPT_BYTES,
  MAX_LOG_EXCERPT_BYTES,
  MIN_LOG_EXCERPT_BYTES,
  excerptJobLog,
} from "./log-excerpt.js";
import { currentBranch, diffWorktreeAgainst, hasLocalCommit } from "./worktree-diff.js";

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
 * The mutation is the only thing standing between us and an unsigned commit on
 * a `required_signatures` repo. If GitHub says it did not sign, or signed but
 * the signature doesn't verify, say so loudly — the commit is already on the
 * branch, so a silent `verified: false` would be discovered by a blocked PR
 * hours later. `null` means GitHub returned no signature yet, not a failure.
 */
function assertSigned(commit: SignedCommit): void {
  if (commit.signature && !commit.signature.wasSignedByGitHub) {
    throw new Error(
      `published ${commit.oid} but GitHub did not sign it (state=${commit.signature.state}). A repository requiring signed commits will block it. Do not retry — report this.`,
    );
  }
  if (commit.signature && !commit.signature.isValid) {
    throw new Error(
      `published ${commit.oid} but GitHub's signature on it is not valid (state=${commit.signature.state}). A repository requiring signed commits will block it. Do not retry — report this.`,
    );
  }
}

/** The first line of whatever a failed git child actually said, not the
 * generic "Command failed: git …" wrapper execFileSync throws — git's real
 * cause is on stderr. Safe to surface: `gitAuthEnv` injects the token as a
 * `GIT_CONFIG_VALUE_1` extraheader, never into a URL, so git's stderr cannot
 * carry it (credentials.ts). Falls back to the thrown message (e.g. a
 * detached-HEAD `Error` from `currentBranch`, which has no stderr). */
function firstLineOfFailure(err: unknown): string {
  const e = err as MaybeHttpError;
  const stderr = e.stderr ? e.stderr.toString().trim() : "";
  const text = stderr || e.message || String(err);
  return text.split("\n")[0]!;
}

/**
 * Local HEAD is now behind the branch we just wrote. `reset --mixed` moves the
 * branch ref and the index onto the published commit and leaves every file
 * untouched — sound precisely because the published tree IS the working tree.
 * Best effort: a failed sync does not un-publish anything, so it is reported,
 * never thrown.
 *
 * Only safe when the checked-out branch IS the one just published: `reset
 * --mixed` moves whatever branch HEAD currently points at, so publishing to a
 * different branch than the one checked out would silently repoint the
 * checkout's own branch onto someone else's commit (measured in review).
 */
async function syncLocalToPublished(
  cwd: string,
  target: string,
  oid: string,
  auth: GitHubAuth,
): Promise<string> {
  try {
    const current = currentBranch(cwd);
    if (current !== target) {
      return `skipped: published to ${target}, checked out on ${current}`;
    }
    const token = await auth.getToken();
    execFileSync("git", ["fetch", "origin", target], {
      cwd,
      stdio: "pipe",
      timeout: 120_000,
      env: { ...process.env, ...gitAuthEnv(token), GIT_TERMINAL_PROMPT: "0" },
    });
    execFileSync("git", ["reset", "--mixed", oid], { cwd, stdio: "pipe" });
    return "ok";
  } catch (err) {
    return `skipped: ${firstLineOfFailure(err)}`;
  }
}

/**
 * Resolve the remote tip to diff the working tree against, and make sure it is
 * in the local object store — all WITHOUT creating anything remote yet: the
 * branch's own tip if it exists, otherwise the base branch's tip
 * (`createCommitOnBranch` needs the branch to exist, but creating it here
 * would be a remote write that a later refusal could never undo). Returns
 * `from` — the base branch a missing `target` would be created from, or
 * `null` if `target` already exists — for the caller to act on only after
 * every refusal check has run.
 */
async function resolveDiffBase(
  gh: GitHubClient,
  auth: GitHubAuth,
  cwd: string,
  owner: string,
  repo: string,
  target: string,
  baseBranch: string | undefined,
): Promise<{ tip: string; from: string | null }> {
  const existingTip = await gh.getBranchTip(owner, repo, target);
  let from: string | null = null;
  let tip: string;
  if (existingTip !== null) {
    tip = existingTip;
  } else {
    from = baseBranch || (await gh.getRepository(owner, repo)).default_branch;
    const baseTip = await gh.getBranchTip(owner, repo, from);
    if (baseTip === null) {
      throw new Error(
        `base branch ${from} does not exist in ${owner}/${repo} either — cannot create ${target}`,
      );
    }
    tip = baseTip;
  }

  // The diff needs the remote tip in the local object store. A shallow clone
  // may not have it; fetching by sha is cheap and precise.
  if (!hasLocalCommit(cwd, tip)) {
    const token = await auth.getToken();
    try {
      execFileSync("git", ["fetch", "--depth=1", "origin", tip], {
        cwd,
        stdio: "pipe",
        timeout: 120_000,
        env: { ...process.env, ...gitAuthEnv(token), GIT_TERMINAL_PROMPT: "0" },
      });
    } catch {
      // fall through to the check below with a message naming the sha
    }
  }
  if (!hasLocalCommit(cwd, tip)) {
    throw new Error(
      `the remote tip of ${target} (${tip}) is not in this clone and could not be fetched — someone else has pushed. Re-run the phase against the current branch; do NOT git push.`,
    );
  }

  return { tip, from };
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
      "Get repository metadata: name, full_name, description, private/fork/archived, default_branch, language, topics, star + open-issue counts, html_url, pushed_at.",
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
      "github_publish",
      "Publish your work: commit the whole working tree and push it, in one step, as a SIGNED commit. Use this INSTEAD of `git add`/`git commit`/`git push` — a commit built by git in this sandbox is unsigned, and a repository that requires signed commits blocks it permanently. GitHub builds and signs the commit for you, attributed to the bot. Local commits you already made are folded in; the published commit is the working tree as it stands now. Fails rather than publishing if a change needs a file mode it cannot express (a new executable file, a symlink, a submodule pointer) — do not work around that with `git push`.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        message: Type.String({
          description:
            "Commit message. First line is the headline; everything after it is the body.",
        }),
        branch: Type.Optional(
          Type.String({ description: "Branch to publish to (default: the checked-out branch)" }),
        ),
        base_branch: Type.Optional(
          Type.String({
            description:
              "If the branch does not exist on GitHub yet, create it from this one (default: the repo's default branch)",
          }),
        ),
        path: Type.Optional(
          Type.String({
            description: "Path to the git working tree (default: the current directory)",
          }),
        ),
        exclude: Type.Optional(
          Type.Array(Type.String(), {
            description: 'Pathspecs to leave out of the commit, e.g. ".lastlight"',
          }),
        ),
        include: Type.Optional(
          Type.Array(Type.String(), {
            description:
              'Pathspecs to restrict the commit to, e.g. ".lastlight". When given, nothing outside them is published, additions and deletions alike. Omit to publish the whole working tree.',
          }),
        ),
      }),
      async ({ owner, repo, message, branch, base_branch, path: repoPath, exclude, include }) => {
        const cwd = repoPath || process.cwd();
        const target = branch || currentBranch(cwd);
        const { tip, from } = await resolveDiffBase(
          gh,
          auth,
          cwd,
          owner,
          repo,
          target,
          base_branch,
        );

        const changes = diffWorktreeAgainst(cwd, tip, {
          ...(exclude && { exclude }),
          ...(include && { include }),
        });
        if (changes.unsupported.length > 0) {
          const listed = changes.unsupported.map((u) => `${u.path}: ${u.reason}`).join("; ");
          throw new Error(
            `refusing to publish — ${changes.unsupported.length} change(s) need a file mode the signed-commit API cannot set: ${listed}. Nothing was published. Do NOT fall back to git push (it would produce an unsigned commit); flag this for a human.`,
          );
        }
        if (changes.additions.length === 0 && changes.deletions.length === 0) {
          return {
            published: false,
            // An empty `include` makes no path eligible, so the change set is
            // empty however much the tree differs. Callers are told to trust
            // this string, so it must not blame the tree for a caller error.
            reason:
              include?.length === 0
                ? "nothing to publish — `include` was an empty list, so no path was eligible. The working tree may well differ from the branch. Pass the pathspecs you meant to publish, or omit `include` to publish the whole tree."
                : "nothing to publish — the working tree matches the branch",
          };
        }

        // Every refusal above has already run — nothing past this point may
        // fail for a reason unrelated to GitHub itself, so it's safe to write.
        if (from !== null) {
          await gh.createBranch(owner, repo, target, from);
        }

        const [headline, ...rest] = message.split("\n");
        const body = rest.join("\n").trim();
        let commit: SignedCommit;
        try {
          commit = await gh.publishSignedCommit({
            owner,
            repo,
            branch: target,
            expectedHeadOid: tip,
            headline: (headline ?? "").trim() || message.trim(),
            ...(body ? { body } : {}),
            additions: changes.additions,
            deletions: changes.deletions,
          });
        } catch (err) {
          // A generic GraphQL error here reads to the agent as "the branch is
          // broken" — for STALE_DATA it is neither broken nor safe to retry
          // automatically here: the change set above was computed as worktree
          // vs. tip, so re-diffing against a tip that genuinely moved would
          // render another party's additions as deletions (see
          // docs/plans/signed-commit-publish/00-findings.md #4). Name the case
          // so the agent re-runs the whole tool call instead of looping on a
          // misdiagnosis.
          if (isStaleDataError(err)) {
            throw new Error(
              `publish rejected: the branch tip moved between reading it and writing (STALE_DATA). This can happen even with nothing else pushing, from lag between GitHub's REST read path and its GraphQL write path — it is not a sign the branch is broken. Re-run this tool call; do not retry in a loop and do not fall back to git push.`,
            );
          }
          throw err;
        }

        assertSigned(commit);
        const localSync = await syncLocalToPublished(cwd, target, commit.oid, auth);

        return {
          published: true,
          commit: commit.oid,
          url: commit.url,
          branch: target,
          verified: commit.signature
            ? commit.signature.wasSignedByGitHub && commit.signature.isValid
            : null,
          committer: commit.committer,
          added: changes.additions.filter((a) => a.status === "A").map((a) => a.path),
          modified: changes.additions.filter((a) => a.status === "M").map((a) => a.path),
          deleted: changes.deletions.map((d) => d.path),
          local_sync: localSync,
        };
      },
    ),

    tool(
      "github_list_branches",
      "List branches in a repository — each { name, sha, protected }. Paged: returns { items, page, per_page, has_more, next_page }.",
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
      "SEARCH a repository's issues when you do NOT already know the number. Returns { items, page, per_page, has_more, next_page }; each item is a summary (number, title, state, author, labels, assignees, comment count, timestamps, is_pull_request) — NOT the body. Call github_get_issue for one issue's body. If you were handed an issue_number, skip this.",
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
      "Get one issue by number: the list summary plus body (truncated past 4000 chars — pass full_body to lift that), closed_at and milestone.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        issue_number: Type.Number(),
        full_body: Type.Optional(
          Type.Boolean({
            description:
              "Return the complete body instead of the first 4000 chars. Only set this when the truncated head was not enough.",
          }),
        ),
      }),
      ({ owner, repo, issue_number, full_body }) =>
        gh.getIssue(owner, repo, issue_number, { fullBody: full_body }),
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
      "List comments on an issue or PR, oldest first. Returns { items, page, per_page, has_more, next_page } — 30 per page by default, each body truncated past 4000 chars. A long thread is PAGED, never silently cut: when has_more is true, re-call with the next_page value. Prefer paging over raising per_page.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        issue_number: Type.Number(),
        page: Type.Optional(Type.Number()),
        per_page: Type.Optional(Type.Number()),
        full_bodies: Type.Optional(
          Type.Boolean({
            description:
              "Return every comment body in full instead of truncating each at 4000 chars. Expensive on a long thread — prefer reading the truncated page first.",
          }),
        ),
      }),
      ({ owner, repo, issue_number, full_bodies, ...opts }) =>
        gh.listIssueComments(owner, repo, issue_number, { ...opts, fullBodies: full_bodies }),
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
      "List all labels in a repository — each { name, color, description }.",
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
      "SEARCH a repository's pull requests when you do NOT already know the number. Returns { items, page, per_page, has_more, next_page }; each item is a summary (number, title, state, draft, author, head, base, labels, timestamps) — NOT the body or the diff. If you were handed a specific pull_number, skip this and call github_get_pull_request directly; listing to 'confirm' a PR you already have is wasted context.",
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
      "Get one pull request by number: the list summary plus body (truncated past 4000 chars — pass full_body to lift that), mergeable/mergeable_state, merged, additions/deletions/changed_files/commits, and head/base SHAs. Use it for mergeability and metadata — for the changed files call github_list_pull_request_files, and for the diff github_get_pull_request_diff.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        pull_number: Type.Number(),
        full_body: Type.Optional(
          Type.Boolean({
            description:
              "Return the complete body instead of the first 4000 chars. Dependabot/Renovate changelogs run to tens of kB, so only set this when the truncated head was not enough — e.g. you need a breaking-changes section that fell past the cut.",
          }),
        ),
      }),
      ({ owner, repo, pull_number, full_body }) =>
        gh.getPullRequest(owner, repo, pull_number, { fullBody: full_body }),
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
      "List files changed in a pull request. Returns { items, page, per_page, has_more, next_page }; each item is { filename, status, additions, deletions, changes }. The per-file PATCH IS OMITTED by default — a lockfile patch alone runs to tens of thousands of lines. The file list plus line counts is usually the whole signal you need; when it isn't, prefer reading the one file you care about (github_get_file_contents) or the local checkout over pulling patches for everything.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        pull_number: Type.Number(),
        page: Type.Optional(Type.Number()),
        per_page: Type.Optional(Type.Number()),
        include_patch: Type.Optional(
          Type.Boolean({
            description:
              "Include each file's patch, capped at 2000 chars per file. Set this only after the file list alone proved insufficient, and narrow with per_page first.",
          }),
        ),
        full_patch: Type.Optional(
          Type.Boolean({
            description:
              "With include_patch, return each patch uncapped. Very expensive on a PR that touches a lockfile — avoid unless you have narrowed to a specific small file.",
          }),
        ),
      }),
      ({ owner, repo, pull_number, include_patch, full_patch, page, per_page }) =>
        gh.listPullRequestFiles(owner, repo, pull_number, {
          includePatch: include_patch,
          fullPatch: full_patch,
          page,
          perPage: per_page,
        }),
    ),

    tool(
      "github_get_pull_request_diff",
      "Get the diff of a pull request",
      Type.Object({ owner: Type.String(), repo: Type.String(), pull_number: Type.Number() }),
      ({ owner, repo, pull_number }) => gh.getPullRequestDiff(owner, repo, pull_number),
    ),

    tool(
      "github_list_pull_request_reviews",
      "List submitted reviews on a pull request — each { id, author, state (APPROVED/CHANGES_REQUESTED/COMMENTED), submitted_at, body }, body truncated past 4000 chars. Paged: returns { items, page, per_page, has_more, next_page }. Use to check whether the bot has already reviewed this PR.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        pull_number: Type.Number(),
        page: Type.Optional(Type.Number()),
        per_page: Type.Optional(Type.Number()),
        full_bodies: Type.Optional(
          Type.Boolean({ description: "Return every review body in full instead of truncating." }),
        ),
      }),
      ({ owner, repo, pull_number, full_bodies, page, per_page }) =>
        gh.listPullRequestReviews(owner, repo, pull_number, {
          fullBodies: full_bodies,
          page,
          perPage: per_page,
        }),
    ),

    tool(
      "github_list_pull_request_review_comments",
      "List line-level review comments on a pull request — each { id, author, path, line, created_at, body, in_reply_to_id }, body truncated past 4000 chars. Distinct from issue comments: these are anchored to specific diff lines. Paged: returns { items, page, per_page, has_more, next_page }.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        pull_number: Type.Number(),
        page: Type.Optional(Type.Number()),
        per_page: Type.Optional(Type.Number()),
        full_bodies: Type.Optional(
          Type.Boolean({ description: "Return every comment body in full instead of truncating." }),
        ),
      }),
      ({ owner, repo, pull_number, full_bodies, page, per_page }) =>
        gh.listPullRequestReviewComments(owner, repo, pull_number, {
          fullBodies: full_bodies,
          page,
          perPage: per_page,
        }),
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
      "List commits on a repository or branch — each { sha, message, author, date, html_url }, message truncated past 4000 chars. Paged: returns { items, page, per_page, has_more, next_page }.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        sha: Type.Optional(Type.String({ description: "Branch name or commit SHA" })),
        path: Type.Optional(Type.String({ description: "Only commits touching this path" })),
        page: Type.Optional(Type.Number()),
        per_page: Type.Optional(Type.Number()),
        full_messages: Type.Optional(
          Type.Boolean({
            description: "Return every commit message in full instead of truncating.",
          }),
        ),
      }),
      ({ owner, repo, full_messages, ...opts }) =>
        gh.listCommits(owner, repo, { ...opts, fullMessages: full_messages }),
    ),

    // ── Actions (CI) ──────────────────────────────────────────────────
    //
    // Read-only CI evidence. The harness pre-fetches a failure summary into the
    // prompt, but that snapshot is static: diagnosing a red PR often means
    // asking a question the harness didn't anticipate — "did this same job pass
    // on the previous commit?", "which step actually failed?", "what does the
    // log say 200 lines before the error?". These three answer those.
    //
    // All three need the App's `Actions: read` permission and return
    // `{ ok: false, reason }` rather than throwing when it is absent.

    tool(
      "github_list_workflow_runs",
      "List GitHub Actions workflow runs for a repository, newest first. Filter by branch, head_sha, status, or workflow_id (a workflow file name like 'ci.yml', or its numeric id) to find how the SAME workflow behaved on an earlier commit — the comparison that separates a flaky failure from a reproducible one. Returns a trimmed projection of each run, not the full API object. Requires the App's 'Actions: read' permission; returns { ok: false, reason } when it is missing — do not retry in that case.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        workflow_id: Type.Optional(
          Type.String({ description: "Workflow file name (e.g. 'ci.yml') or numeric id" }),
        ),
        branch: Type.Optional(Type.String()),
        head_sha: Type.Optional(Type.String()),
        event: Type.Optional(Type.String({ description: "e.g. 'push', 'pull_request'" })),
        status: Type.Optional(
          Type.String({ description: "e.g. 'completed', 'in_progress', 'failure', 'success'" }),
        ),
        page: Type.Optional(Type.Number()),
        per_page: Type.Optional(Type.Number()),
      }),
      ({ owner, repo, ...opts }) => gh.listWorkflowRuns(owner, repo, opts),
    ),

    tool(
      "github_list_workflow_run_jobs",
      "List the jobs of one GitHub Actions workflow run, each with its steps and per-step conclusions. Use it to locate the exact step that failed before spending a log fetch on the whole job. Requires the App's 'Actions: read' permission; returns { ok: false, reason } when it is missing — do not retry in that case.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        run_id: Type.Number({ description: "Workflow run id (from github_list_workflow_runs)" }),
        filter: Type.Optional(
          Type.Union([Type.Literal("latest"), Type.Literal("all")], {
            description: "'latest' (default) returns only the last attempt of each job",
          }),
        ),
        page: Type.Optional(Type.Number()),
        per_page: Type.Optional(Type.Number()),
      }),
      ({ owner, repo, run_id, ...opts }) => gh.listWorkflowRunJobs(owner, repo, run_id, opts),
    ),

    tool(
      "github_get_job_logs",
      "Fetch one GitHub Actions job's log, EXCERPTED — timestamps stripped, anchored on the error lines with surrounding context, and hard-capped in bytes with a truncation notice. Use it when the CI failure summary in your prompt is inconclusive. The full log can be megabytes, so this never returns all of it; narrow with github_list_workflow_run_jobs first. Requires the App's 'Actions: read' permission; returns { ok: false, reason } when it is missing — do not retry in that case.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        job_id: Type.Number({ description: "Job id (from github_list_workflow_run_jobs)" }),
        max_bytes: Type.Optional(
          Type.Number({
            description: `Byte cap on the returned excerpt (default ${DEFAULT_LOG_EXCERPT_BYTES}, clamped to ${MIN_LOG_EXCERPT_BYTES}–${MAX_LOG_EXCERPT_BYTES})`,
          }),
        ),
      }),
      async ({ owner, repo, job_id, max_bytes }) => {
        const log = await gh.getJobLogs(owner, repo, job_id);
        if (isActionsDenied(log)) return log;
        const excerpt = excerptJobLog(log, max_bytes ?? DEFAULT_LOG_EXCERPT_BYTES);
        return {
          job_id,
          truncated: excerpt.truncated,
          bytes: excerpt.bytes,
          original_bytes: excerpt.originalBytes,
          log: excerpt.text,
        };
      },
    ),

    // ── Search ────────────────────────────────────────────────────────

    tool(
      "github_search_repositories",
      "Search for GitHub repositories. Returns { total_count, incomplete_results, items, page, per_page, has_more, next_page }; each item is { full_name, description, language, stargazers_count, default_branch, html_url }.",
      Type.Object({
        query: Type.String(),
        page: Type.Optional(Type.Number()),
        per_page: Type.Optional(Type.Number()),
      }),
      ({ query, page, per_page }) => gh.searchRepositories(query, page, per_page),
    ),

    tool(
      "github_search_issues",
      "Search issues and pull requests across repositories. Returns { total_count, incomplete_results, items, page, per_page, has_more, next_page }; each item is a summary (number, title, state, repository, author, labels, timestamps, is_pull_request) — NOT the body. Fetch one with github_get_issue.",
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
      "Search code across repositories. Returns { total_count, incomplete_results, items, page, per_page, has_more, next_page }; each item is { path, repository, html_url } — the MATCHING LINES ARE NOT RETURNED, so read the file (github_get_file_contents) or the local checkout when you need context. Counting hits (e.g. import sites) needs only total_count.",
      Type.Object({
        query: Type.String({ description: "GitHub code search query" }),
        page: Type.Optional(Type.Number()),
        per_page: Type.Optional(Type.Number()),
      }),
      ({ query, page, per_page }) => gh.searchCode(query, page, per_page),
    ),
  ];
}

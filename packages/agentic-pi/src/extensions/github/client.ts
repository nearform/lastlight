/**
 * Thin wrapper around Octokit that refreshes the token automatically.
 *
 * Ported 1:1 from mcp-github-app/src/github.js with TypeScript types.
 * All method names, parameters, and behaviour match the original — the goal
 * is bit-compatible JSON responses so the dashboard shim keeps working.
 */

import { Octokit } from "@octokit/rest";
import type { GitHubAuth } from "./auth.js";

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

/** GitHub's default grey — used when a label to ensure has no color. */
const DEFAULT_LABEL_COLOR = "ededed";

interface MaybeHttpError extends Error {
  status?: number;
  response?: {
    status?: number;
    headers?: Record<string, string>;
    data?: { errors?: Array<{ code?: string }> };
  };
}

/**
 * GitHub's create-label API is not idempotent: creating an existing label
 * 422s with `{ resource: "Label", code: "already_exists" }`. Detecting this
 * lets callers treat it as a benign no-op instead of a scary error.
 */
function isLabelAlreadyExists(err: unknown): boolean {
  const e = err as MaybeHttpError;
  const status = e?.status ?? e?.response?.status;
  if (status !== 422) return false;
  return (e.response?.data?.errors ?? []).some((x) => x.code === "already_exists");
}

/** The sentinel `createLabel` returns when a label already existed. */
type LabelExisted = { ok: true; existed: true };

function isLabelExisted(r: unknown): r is LabelExisted {
  return typeof r === "object" && r !== null && (r as { existed?: unknown }).existed === true;
}

/**
 * LLMs that see optional fields in a tool's JSON Schema sometimes emit
 * zero / empty-string values for ones they didn't actually want to set.
 * Strip those before spreading into an Octokit call so the API only sees
 * fields the agent meant to pass.
 */
function omitFalsy<T extends Record<string, unknown>>(opts: T | undefined): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(opts ?? {})) {
    if (v === undefined || v === null || v === "" || v === 0) continue;
    if (Array.isArray(v) && v.length === 0) continue;
    (out as Record<string, unknown>)[k] = v;
  }
  return out;
}

export interface GitHubClientOptions {
  /**
   * Override the GitHub REST API base URL (Octokit's `baseUrl`). Defaults to
   * `https://api.github.com`. Test/eval escape hatch: point the built-in
   * GitHub tools at a fake GitHub server so a real workflow can run with its
   * `github_*` calls mocked. Production leaves this unset.
   */
  baseUrl?: string;
}

export class GitHubClient {
  private _octokit: Octokit | null = null;
  private _tokenUsed: string | null = null;
  private readonly baseUrl?: string;

  constructor(
    private readonly auth: GitHubAuth,
    opts: GitHubClientOptions = {},
  ) {
    this.baseUrl = opts.baseUrl;
  }

  async octokit(): Promise<Octokit> {
    const token = await this.auth.getToken();
    if (token !== this._tokenUsed) {
      this._octokit = new Octokit({
        auth: token,
        ...(this.baseUrl ? { baseUrl: this.baseUrl } : {}),
      });
      this._tokenUsed = token;
    }
    return this._octokit!;
  }

  private async withRetry<T>(fn: () => Promise<T>): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const e = err as MaybeHttpError;
        const status = e.status || e.response?.status;
        if (status && status >= 400 && status < 500 && !RETRYABLE_STATUSES.has(status)) {
          throw err;
        }
        if (attempt === MAX_RETRIES) break;
        let delayMs: number;
        if (status === 429) {
          const retryAfter = e.response?.headers?.["retry-after"];
          delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : BASE_DELAY_MS * 2 ** attempt;
        } else {
          delayMs = BASE_DELAY_MS * 2 ** attempt;
        }
        if (status === 401) {
          this._tokenUsed = null;
        }
        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastError;
  }

  // ── Repositories ──────────────────────────────────────────────────

  async getRepository(owner: string, repo: string) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.repos.get({ owner, repo });
      return data;
    });
  }

  async getFileContents(owner: string, repo: string, path: string, branch?: string) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const params: { owner: string; repo: string; path: string; ref?: string } = {
        owner,
        repo,
        path,
      };
      if (branch) params.ref = branch;
      const { data } = await ok.repos.getContent(params);
      if (
        typeof data === "object" &&
        data !== null &&
        "content" in data &&
        typeof data.content === "string"
      ) {
        (data as { decoded_content?: string }).decoded_content = Buffer.from(
          data.content,
          "base64",
        ).toString("utf8");
      }
      return data;
    });
  }

  async createOrUpdateFile(
    owner: string,
    repo: string,
    path: string,
    content: string,
    message: string,
    branch?: string,
    sha?: string,
  ) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const params: Parameters<typeof ok.repos.createOrUpdateFileContents>[0] = {
        owner,
        repo,
        path,
        message,
        content: Buffer.from(content).toString("base64"),
      };
      if (branch) params.branch = branch;
      if (sha) params.sha = sha;
      const { data } = await ok.repos.createOrUpdateFileContents(params);
      return data;
    });
  }

  async pushFiles(
    owner: string,
    repo: string,
    branch: string,
    files: Array<{ path: string; content: string }>,
    message: string,
  ) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      // getRef and createRef both return the `git-ref` schema; only ref.object.sha
      // is read below. Typed explicitly to satisfy noImplicitAnyLet.
      let ref: Awaited<ReturnType<typeof ok.git.getRef>>["data"];
      try {
        const { data } = await ok.git.getRef({ owner, repo, ref: `heads/${branch}` });
        ref = data;
      } catch {
        const { data: repoData } = await ok.repos.get({ owner, repo });
        const { data: defaultRef } = await ok.git.getRef({
          owner,
          repo,
          ref: `heads/${repoData.default_branch}`,
        });
        const { data: newRef } = await ok.git.createRef({
          owner,
          repo,
          ref: `refs/heads/${branch}`,
          sha: defaultRef.object.sha,
        });
        ref = newRef;
      }
      const blobs = await Promise.all(
        files.map(async (f) => {
          const { data } = await ok.git.createBlob({
            owner,
            repo,
            content: f.content,
            encoding: "utf-8",
          });
          return { path: f.path, sha: data.sha, mode: "100644" as const, type: "blob" as const };
        }),
      );
      const { data: tree } = await ok.git.createTree({
        owner,
        repo,
        base_tree: ref.object.sha,
        tree: blobs,
      });
      const { data: commit } = await ok.git.createCommit({
        owner,
        repo,
        message,
        tree: tree.sha,
        parents: [ref.object.sha],
      });
      const { data: updated } = await ok.git.updateRef({
        owner,
        repo,
        ref: `heads/${branch}`,
        sha: commit.sha,
      });
      return { commit: commit.sha, branch, ref: updated };
    });
  }

  async listBranches(owner: string, repo: string, page = 1, perPage = 30) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.repos.listBranches({ owner, repo, page, per_page: perPage });
      return data;
    });
  }

  async createBranch(owner: string, repo: string, branch: string, fromBranch: string) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data: ref } = await ok.git.getRef({ owner, repo, ref: `heads/${fromBranch}` });
      const { data } = await ok.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha: ref.object.sha,
      });
      return data;
    });
  }

  // ── Issues ────────────────────────────────────────────────────────

  async listIssues(owner: string, repo: string, opts: Record<string, unknown> = {}) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.listForRepo({
        owner,
        repo,
        state: "open",
        per_page: 30,
        ...omitFalsy(opts),
      } as Parameters<typeof ok.issues.listForRepo>[0]);
      return data;
    });
  }

  async getIssue(owner: string, repo: string, issue_number: number) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.get({ owner, repo, issue_number });
      return data;
    });
  }

  async createIssue(
    owner: string,
    repo: string,
    title: string,
    body: string | undefined,
    opts: Record<string, unknown> = {},
  ) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.create({
        owner,
        repo,
        title,
        body,
        ...omitFalsy(opts),
      } as Parameters<typeof ok.issues.create>[0]);
      return data;
    });
  }

  async updateIssue(
    owner: string,
    repo: string,
    issue_number: number,
    updates: Record<string, unknown>,
  ) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.update({
        owner,
        repo,
        issue_number,
        ...omitFalsy(updates),
      } as Parameters<typeof ok.issues.update>[0]);
      return data;
    });
  }

  async addIssueComment(owner: string, repo: string, issue_number: number, body: string) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.createComment({ owner, repo, issue_number, body });
      return data;
    });
  }

  async listIssueComments(
    owner: string,
    repo: string,
    issue_number: number,
    opts: Record<string, unknown> = {},
  ) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.listComments({
        owner,
        repo,
        issue_number,
        per_page: 30,
        ...omitFalsy(opts),
      } as Parameters<typeof ok.issues.listComments>[0]);
      return data;
    });
  }

  async addLabels(owner: string, repo: string, issue_number: number, labels: string[]) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.addLabels({ owner, repo, issue_number, labels });
      return data;
    });
  }

  async removeLabel(owner: string, repo: string, issue_number: number, name: string) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.removeLabel({ owner, repo, issue_number, name });
      return data;
    });
  }

  async listLabels(owner: string, repo: string) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.listLabelsForRepo({ owner, repo, per_page: 100 });
      return data;
    });
  }

  async createLabel(
    owner: string,
    repo: string,
    name: string,
    color: string,
    description?: string,
  ) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      try {
        const { data } = await ok.issues.createLabel({ owner, repo, name, color, description });
        return data;
      } catch (err) {
        // Idempotent by design: a 422 already_exists means the label is already
        // there, which is success for every caller. Swallow it rather than
        // surfacing a validation error (the create API is not idempotent).
        if (isLabelAlreadyExists(err)) return { ok: true, existed: true } satisfies LabelExisted;
        throw err;
      }
    });
  }

  /**
   * Check-first + bulk: list labels once, then create only the missing ones.
   * Folds the defensive "ensure the canonical triage labels exist" loop into a
   * single idempotent call so triage runs stop emitting a stream of 422s.
   */
  async ensureLabels(
    owner: string,
    repo: string,
    labels: Array<{ name: string; color?: string; description?: string }>,
  ): Promise<{ created: string[]; existed: string[] }> {
    const existing = await this.listLabels(owner, repo);
    // GitHub treats label names case-insensitively for uniqueness.
    const existingNames = new Set(existing.map((l) => l.name.toLowerCase()));
    const created: string[] = [];
    const existed: string[] = [];
    for (const label of labels) {
      if (existingNames.has(label.name.toLowerCase())) {
        existed.push(label.name);
        continue;
      }
      // createLabel is itself idempotent, so this also covers the race where a
      // label appears between our list and the create.
      const result = await this.createLabel(
        owner,
        repo,
        label.name,
        label.color ?? DEFAULT_LABEL_COLOR,
        label.description,
      );
      if (isLabelExisted(result)) existed.push(label.name);
      else created.push(label.name);
    }
    return { created, existed };
  }

  // ── Pull Requests ─────────────────────────────────────────────────

  async listPullRequests(owner: string, repo: string, opts: Record<string, unknown> = {}) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const cleaned: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(opts)) {
        if (v === "" || v === undefined || v === null) continue;
        cleaned[k] = v;
      }
      const { data } = await ok.pulls.list({
        owner,
        repo,
        state: "open",
        per_page: 30,
        ...cleaned,
      } as Parameters<typeof ok.pulls.list>[0]);
      return data;
    });
  }

  async getPullRequest(owner: string, repo: string, pull_number: number) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.pulls.get({ owner, repo, pull_number });
      return data;
    });
  }

  async createPullRequest(
    owner: string,
    repo: string,
    title: string,
    body: string | undefined,
    head: string,
    base: string,
  ) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.pulls.create({ owner, repo, title, body, head, base });
      return data;
    });
  }

  async listPullRequestFiles(owner: string, repo: string, pull_number: number) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.pulls.listFiles({ owner, repo, pull_number, per_page: 100 });
      return data;
    });
  }

  async listPullRequestReviews(owner: string, repo: string, pull_number: number) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.pulls.listReviews({ owner, repo, pull_number, per_page: 100 });
      return data;
    });
  }

  async listPullRequestReviewComments(owner: string, repo: string, pull_number: number) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.pulls.listReviewComments({
        owner,
        repo,
        pull_number,
        per_page: 100,
      });
      return data;
    });
  }

  async getPullRequestDiff(owner: string, repo: string, pull_number: number) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.pulls.get({
        owner,
        repo,
        pull_number,
        mediaType: { format: "diff" },
      });
      return data;
    });
  }

  async createPullRequestReview(
    owner: string,
    repo: string,
    pull_number: number,
    body: string,
    event: string,
    comments: Array<{ path: string; position?: number; line?: number; body: string }> = [],
  ) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const params: Parameters<typeof ok.pulls.createReview>[0] = {
        owner,
        repo,
        pull_number,
        body,
        event: event as "APPROVE" | "REQUEST_CHANGES" | "COMMENT",
      };
      if (comments.length) (params as { comments?: typeof comments }).comments = comments;
      const { data } = await ok.pulls.createReview(params);
      return data;
    });
  }

  async mergePullRequest(
    owner: string,
    repo: string,
    pull_number: number,
    opts: Record<string, unknown> = {},
  ) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.pulls.merge({
        owner,
        repo,
        pull_number,
        ...opts,
      } as Parameters<typeof ok.pulls.merge>[0]);
      return data;
    });
  }

  /**
   * Enable GitHub auto-merge on a PR: GitHub merges it automatically once the
   * required status checks pass. Unlike `mergePullRequest` (an immediate merge)
   * this never merges a still-red PR. Uses the GraphQL
   * `enablePullRequestAutoMerge` mutation — there is no REST equivalent — so it
   * first resolves the PR's node id via REST.
   *
   * Auto-merge is not always available (the repo must have "Allow auto-merge"
   * enabled and at least one required check). Rather than throw, we return
   * `{ ok: false, reason }` in that case so the agent can fall back to leaving
   * the PR for a human.
   */
  async enablePullRequestAutoMerge(
    owner: string,
    repo: string,
    pull_number: number,
    mergeMethod: "merge" | "squash" | "rebase" = "squash",
  ) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data: pr } = await ok.pulls.get({ owner, repo, pull_number });
      const method = mergeMethod.toUpperCase() as "MERGE" | "SQUASH" | "REBASE";
      try {
        const res = await ok.graphql<{
          enablePullRequestAutoMerge: {
            pullRequest: {
              number: number;
              autoMergeRequest: { enabledAt: string | null } | null;
            };
          };
        }>(
          // NB: `@octokit/graphql` reserves `method`/`url`/`query` etc. as
          // request-option names, so the GraphQL variable can't be `$method`.
          `mutation($id: ID!, $mergeMethod: PullRequestMergeMethod!) {
            enablePullRequestAutoMerge(input: { pullRequestId: $id, mergeMethod: $mergeMethod }) {
              pullRequest { number autoMergeRequest { enabledAt } }
            }
          }`,
          { id: pr.node_id, mergeMethod: method },
        );
        return {
          ok: true,
          pull_number,
          merge_method: mergeMethod,
          auto_merge: res.enablePullRequestAutoMerge.pullRequest.autoMergeRequest,
        };
      } catch (err) {
        // GraphQL errors (e.g. "Auto merge is not allowed for this repository")
        // arrive as a GraphqlResponseError carrying `.errors`. Surface the
        // reason as a non-throwing result instead of failing the whole run.
        const e = err as { message?: string; errors?: Array<{ message?: string }> };
        const reason =
          e.errors?.map((x) => x.message).filter(Boolean).join("; ") ||
          e.message ||
          "unknown error";
        return { ok: false, pull_number, reason };
      }
    });
  }

  // ── Commits ───────────────────────────────────────────────────────

  async listCommits(owner: string, repo: string, opts: Record<string, unknown> = {}) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.repos.listCommits({
        owner,
        repo,
        per_page: 30,
        ...opts,
      } as Parameters<typeof ok.repos.listCommits>[0]);
      return data;
    });
  }

  // ── Search ────────────────────────────────────────────────────────

  async searchRepositories(query: string, page = 1, perPage = 30) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.search.repos({ q: query, page, per_page: perPage });
      return data;
    });
  }

  async searchIssues(query: string, page = 1, perPage = 30) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.search.issuesAndPullRequests({ q: query, page, per_page: perPage });
      return data;
    });
  }

  async searchCode(query: string, page = 1, perPage = 30) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.search.code({ q: query, page, per_page: perPage });
      return data;
    });
  }
}

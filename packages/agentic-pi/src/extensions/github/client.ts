/**
 * Thin wrapper around Octokit that refreshes the token automatically.
 *
 * Ported 1:1 from mcp-github-app/src/github.js with TypeScript types.
 * All method names, parameters, and behaviour match the original — the goal
 * is bit-compatible JSON responses so the dashboard shim keeps working.
 */

import { Octokit } from "@octokit/rest";
import type { GitHubAuth } from "./auth.js";
import type { PublishAddition, PublishDeletion } from "./worktree-diff.js";
import {
  capText,
  page,
  searchPage,
  summarizeBranch,
  summarizeCodeHit,
  summarizeComment,
  summarizeCommit,
  summarizeFile,
  summarizeIssue,
  summarizeIssueHit,
  summarizeLabel,
  summarizePullRequest,
  summarizeRepoHit,
  summarizeRepository,
  summarizeReview,
  summarizeReviewComment,
} from "./projections.js";

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

/**
 * Reading Actions runs, jobs and logs needs the App's `Actions: read`
 * permission, which lastlight documents as optional-but-recommended — every
 * installation predating that doc lacks it, and GitHub answers 403.
 *
 * A throw would reach the agent as a generic transient-looking error that it is
 * likely to retry in a loop. A terminal, self-explaining result stops it dead
 * and tells it what evidence it does and doesn't have.
 */
const ACTIONS_FORBIDDEN =
  "not permitted — the App lacks Actions: read. GitHub Actions runs, jobs and logs are unreadable for this installation. Do not retry: no amount of retrying will grant the permission. Work from the CI evidence already in your prompt (check-run annotations) and say that the job logs were unavailable.";

/** The non-throwing shape every Actions read degrades to on 403. */
export type ActionsDenied = { ok: false; reason: string };

export function isActionsDenied(r: unknown): r is ActionsDenied {
  return typeof r === "object" && r !== null && (r as ActionsDenied).ok === false;
}

/**
 * The fields of a workflow run worth spending context on: what ran, on which
 * commit, and how it ended. `path` is the workflow file; `head_sha` +
 * `conclusion` are what turn "did this job pass on an earlier SHA?" — the
 * flaky-vs-reproducible question — into a single comparison.
 */
function workflowRunSummary(run: {
  id: number;
  name?: string | null;
  path?: string;
  head_branch?: string | null;
  head_sha: string;
  event: string;
  status?: string | null;
  conclusion: string | null;
  run_number: number;
  run_attempt?: number;
  created_at: string;
  html_url: string;
}) {
  return {
    id: run.id,
    name: run.name,
    path: run.path,
    head_branch: run.head_branch,
    head_sha: run.head_sha,
    event: run.event,
    status: run.status,
    conclusion: run.conclusion,
    run_number: run.run_number,
    run_attempt: run.run_attempt,
    created_at: run.created_at,
    html_url: run.html_url,
  };
}

/**
 * The commit `createCommitOnBranch` built for us. `signature` is what makes the
 * whole exercise worth doing — a locally-built commit object can never be
 * `verified` under the App's `[bot]` identity (issue #268).
 */
export interface SignedCommit {
  oid: string;
  url: string;
  committer: { name: string; email: string } | null;
  signature: { isValid: boolean; state: string; wasSignedByGitHub: boolean } | null;
}

const CREATE_COMMIT_ON_BRANCH = `
mutation ($input: CreateCommitOnBranchInput!) {
  createCommitOnBranch(input: $input) {
    commit {
      oid
      url
      committer { name email }
      signature { isValid state wasSignedByGitHub }
    }
  }
}`;

/**
 * `GraphqlResponseError` (thrown by `ok.graphql()`) carries a top-level
 * `errors` array and no `.status` — the opposite shape from every REST error
 * `withRetry`'s guard (`:204`) already knows how to read. Duck-typed rather
 * than imported: `@octokit/graphql`'s error class is only a transitive
 * dependency here, and importing it directly would be fragile.
 */
function isGraphqlError(err: unknown): boolean {
  return (
    typeof err === "object" && err !== null && Array.isArray((err as { errors?: unknown }).errors)
  );
}

/**
 * GitHub's REST read path can lag its GraphQL write path by a few seconds
 * (measured — docs/plans/signed-commit-publish/00-findings.md #4): a `getRef`
 * right after a successful mutation can return the pre-write tip. The next
 * publish then computes `expectedHeadOid` from that stale tip, and this
 * mutation's own concurrency check rejects it exactly as if another writer
 * had raced us — `STALE_DATA` is GitHub's classification for that rejection.
 * Callers use this to give a specific, re-run-friendly message instead of the
 * generic GraphQL error text, without guessing from the message wording.
 */
export function isStaleDataError(err: unknown): boolean {
  if (!isGraphqlError(err)) return false;
  return (err as { errors: Array<{ type?: string }> }).errors.some((e) => e.type === "STALE_DATA");
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
      return summarizeRepository(data);
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

  /**
   * The branch's current remote tip, or null if the branch does not exist.
   * A missing branch is an ordinary state on the first publish of a new
   * feature branch, so it is not an error.
   */
  async getBranchTip(owner: string, repo: string, branch: string): Promise<string | null> {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      try {
        const { data } = await ok.git.getRef({ owner, repo, ref: `heads/${branch}` });
        return data.object.sha;
      } catch (err) {
        if (((err as MaybeHttpError).status ?? (err as MaybeHttpError).response?.status) === 404) {
          return null;
        }
        throw err;
      }
    });
  }

  /**
   * Create a commit GitHub signs for us.
   *
   * The REST Git Data API does NOT sign what it creates — its `signature` field
   * is an input you supply, so `pushFiles()` above produces unsigned commits.
   * This GraphQL mutation is the only path that yields `verified: true` under a
   * GitHub App installation token, with no key held anywhere (issue #268).
   *
   * `expectedHeadOid` is non-null by schema: if the branch moved since we read
   * its tip, GitHub rejects the mutation rather than clobbering the other push.
   * That is the concurrency story — there is no retry to write.
   */
  async publishSignedCommit(opts: {
    owner: string;
    repo: string;
    branch: string;
    expectedHeadOid: string;
    headline: string;
    body?: string;
    additions: PublishAddition[];
    deletions: PublishDeletion[];
  }): Promise<SignedCommit> {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      try {
        const data = await ok.graphql<{ createCommitOnBranch: { commit: SignedCommit } }>(
          CREATE_COMMIT_ON_BRANCH,
          {
            input: {
              branch: {
                repositoryNameWithOwner: `${opts.owner}/${opts.repo}`,
                branchName: opts.branch,
              },
              message: opts.body
                ? { headline: opts.headline, body: opts.body }
                : { headline: opts.headline },
              expectedHeadOid: opts.expectedHeadOid,
              fileChanges: {
                additions: opts.additions.map((a) => ({ path: a.path, contents: a.contents })),
                deletions: opts.deletions,
              },
            },
          },
        );
        return data.createCommitOnBranch.commit;
      } catch (err) {
        // A GraphQL-level rejection (schema error, validation error, a stale
        // expectedHeadOid) can never succeed by resending the same mutation, and
        // GraphqlResponseError carries no `.status` for withRetry's guard (:204) to
        // read — without this it retries indistinguishably from a flaky transport
        // 5xx, burning the full backoff before still failing. Tag a synthetic 4xx so
        // that guard treats it as terminal. GitHub never sent this status; it exists
        // only to route into the existing non-retryable path.
        if (isGraphqlError(err)) {
          (err as MaybeHttpError).status = 422;
        }
        throw err;
      }
    });
  }

  async listBranches(owner: string, repo: string, pageNum = 1, perPage = 30) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.repos.listBranches({
        owner,
        repo,
        page: pageNum,
        per_page: perPage,
      });
      return page(data.map(summarizeBranch), pageNum, perPage);
    });
  }

  async createBranch(owner: string, repo: string, branch: string, fromBranch: string) {
    // `octokit()` stays inside the retried closure: withRetry drops the cached
    // token on a 401 so the next attempt re-mints it.
    const sha = await this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.git.getRef({ owner, repo, ref: `heads/${fromBranch}` });
      return data.object.sha;
    });
    return this.createBranchAt(owner, repo, branch, sha);
  }

  /**
   * Create a branch at an exact commit. `github_publish` needs this rather than
   * `createBranch` above: the commit its new branch starts from is the newest
   * one the sandbox checkout and the base branch share, which is not the base
   * branch's tip whenever that branch advanced mid-run.
   */
  async createBranchAt(owner: string, repo: string, branch: string, sha: string) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.git.createRef({
        owner,
        repo,
        ref: `refs/heads/${branch}`,
        sha,
      });
      return data;
    });
  }

  // ── Issues ────────────────────────────────────────────────────────

  async listIssues(owner: string, repo: string, opts: Record<string, unknown> = {}) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const cleaned = omitFalsy(opts);
      const perPage = Number(cleaned.per_page ?? 30);
      const pageNum = Number(cleaned.page ?? 1);
      const { data } = await ok.issues.listForRepo({
        owner,
        repo,
        state: "open",
        ...cleaned,
        per_page: perPage,
        page: pageNum,
      } as Parameters<typeof ok.issues.listForRepo>[0]);
      return page(data.map(summarizeIssue), pageNum, perPage);
    });
  }

  async getIssue(
    owner: string,
    repo: string,
    issue_number: number,
    opts: { fullBody?: boolean } = {},
  ) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.get({ owner, repo, issue_number });
      return {
        ...summarizeIssue(data),
        body: capText(data.body, { full: opts.fullBody, hatch: "full_body: true" }),
        closed_at: data.closed_at ?? null,
        milestone: data.milestone?.title ?? null,
      };
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
      const { fullBodies, ...rest } = opts as { fullBodies?: boolean } & Record<string, unknown>;
      const cleaned = omitFalsy(rest);
      const perPage = Number(cleaned.per_page ?? 30);
      const pageNum = Number(cleaned.page ?? 1);
      const { data } = await ok.issues.listComments({
        owner,
        repo,
        issue_number,
        ...cleaned,
        per_page: perPage,
        page: pageNum,
      } as Parameters<typeof ok.issues.listComments>[0]);
      return page(
        data.map((c) => summarizeComment(c, fullBodies)),
        pageNum,
        perPage,
      );
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
      return data.map(summarizeLabel);
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
      const perPage = Number(cleaned.per_page ?? 30);
      const pageNum = Number(cleaned.page ?? 1);
      const { data } = await ok.pulls.list({
        owner,
        repo,
        state: "open",
        ...cleaned,
        per_page: perPage,
        page: pageNum,
      } as Parameters<typeof ok.pulls.list>[0]);
      return page(data.map(summarizePullRequest), pageNum, perPage);
    });
  }

  async getPullRequest(
    owner: string,
    repo: string,
    pull_number: number,
    opts: { fullBody?: boolean } = {},
  ) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.pulls.get({ owner, repo, pull_number });
      return {
        ...summarizePullRequest(data),
        body: capText(data.body, { full: opts.fullBody, hatch: "full_body: true" }),
        mergeable: data.mergeable,
        mergeable_state: data.mergeable_state,
        merged: data.merged,
        maintainer_can_modify: data.maintainer_can_modify,
        additions: data.additions,
        deletions: data.deletions,
        changed_files: data.changed_files,
        commits: data.commits,
        head_sha: data.head?.sha,
        head_repo: data.head?.repo?.full_name ?? null,
        base_sha: data.base?.sha,
      };
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

  async listPullRequestFiles(
    owner: string,
    repo: string,
    pull_number: number,
    opts: { includePatch?: boolean; fullPatch?: boolean; page?: number; perPage?: number } = {},
  ) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const perPage = opts.perPage ?? 100;
      const pageNum = opts.page ?? 1;
      const { data } = await ok.pulls.listFiles({
        owner,
        repo,
        pull_number,
        per_page: perPage,
        page: pageNum,
      });
      return page(
        data.map((f) => summarizeFile(f, opts)),
        pageNum,
        perPage,
      );
    });
  }

  async listPullRequestReviews(
    owner: string,
    repo: string,
    pull_number: number,
    opts: { fullBodies?: boolean; page?: number; perPage?: number } = {},
  ) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const perPage = opts.perPage ?? 30;
      const pageNum = opts.page ?? 1;
      const { data } = await ok.pulls.listReviews({
        owner,
        repo,
        pull_number,
        per_page: perPage,
        page: pageNum,
      });
      return page(
        data.map((r) => summarizeReview(r, opts.fullBodies)),
        pageNum,
        perPage,
      );
    });
  }

  async listPullRequestReviewComments(
    owner: string,
    repo: string,
    pull_number: number,
    opts: { fullBodies?: boolean; page?: number; perPage?: number } = {},
  ) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const perPage = opts.perPage ?? 30;
      const pageNum = opts.page ?? 1;
      const { data } = await ok.pulls.listReviewComments({
        owner,
        repo,
        pull_number,
        per_page: perPage,
        page: pageNum,
      });
      return page(
        data.map((c) => summarizeReviewComment(c, opts.fullBodies)),
        pageNum,
        perPage,
      );
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
          e.errors
            ?.map((x) => x.message)
            .filter(Boolean)
            .join("; ") ||
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
      const { fullMessages, ...rest } = opts as { fullMessages?: boolean } & Record<
        string,
        unknown
      >;
      const perPage = Number(rest.per_page ?? 30);
      const pageNum = Number(rest.page ?? 1);
      const { data } = await ok.repos.listCommits({
        owner,
        repo,
        ...rest,
        per_page: perPage,
        page: pageNum,
      } as Parameters<typeof ok.repos.listCommits>[0]);
      return page(
        data.map((c) => summarizeCommit(c, fullMessages)),
        pageNum,
        perPage,
      );
    });
  }

  // ── Actions (CI) ──────────────────────────────────────────────────

  /**
   * Wrap an Actions read so a missing permission becomes a terminal RESULT
   * instead of a throw. See {@link ACTIONS_FORBIDDEN} for why that matters.
   */
  private async actionsRead<T>(fn: () => Promise<T>): Promise<T | ActionsDenied> {
    try {
      return await this.withRetry(fn);
    } catch (err) {
      const e = err as MaybeHttpError;
      if ((e?.status ?? e?.response?.status) === 403) {
        return { ok: false, reason: ACTIONS_FORBIDDEN };
      }
      throw err;
    }
  }

  /**
   * Workflow runs, newest first, optionally scoped to one workflow file.
   *
   * Projected down to {@link workflowRunSummary}'s fields: the raw API objects
   * are ~4 KB each, so an unprojected page of 20 would cost more context than
   * the log the agent is actually chasing.
   */
  async listWorkflowRuns(
    owner: string,
    repo: string,
    opts: { workflow_id?: string | number } & Record<string, unknown> = {},
  ) {
    return this.actionsRead(async () => {
      const ok = await this.octokit();
      const { workflow_id, ...filters } = opts;
      const params = { owner, repo, per_page: 20, ...omitFalsy(filters) };
      const { data } =
        workflow_id !== undefined && workflow_id !== ""
          ? await ok.actions.listWorkflowRuns({ ...params, workflow_id } as Parameters<
              typeof ok.actions.listWorkflowRuns
            >[0])
          : await ok.actions.listWorkflowRunsForRepo(
              params as Parameters<typeof ok.actions.listWorkflowRunsForRepo>[0],
            );
      return {
        total_count: data.total_count,
        workflow_runs: data.workflow_runs.map(workflowRunSummary),
      };
    });
  }

  /**
   * Jobs of one workflow run, each with its steps — how the agent locates the
   * exact step that failed before spending a log fetch on the job.
   */
  async listWorkflowRunJobs(
    owner: string,
    repo: string,
    run_id: number,
    opts: Record<string, unknown> = {},
  ) {
    return this.actionsRead(async () => {
      const ok = await this.octokit();
      const { data } = await ok.actions.listJobsForWorkflowRun({
        owner,
        repo,
        run_id,
        per_page: 50,
        ...omitFalsy(opts),
      } as Parameters<typeof ok.actions.listJobsForWorkflowRun>[0]);
      return {
        total_count: data.total_count,
        jobs: data.jobs.map((job) => ({
          id: job.id,
          run_id: job.run_id,
          name: job.name,
          status: job.status,
          conclusion: job.conclusion,
          started_at: job.started_at,
          completed_at: job.completed_at,
          html_url: job.html_url,
          steps: (job.steps ?? []).map((s) => ({
            number: s.number,
            name: s.name,
            status: s.status,
            conclusion: s.conclusion,
          })),
        })),
      };
    });
  }

  /**
   * Raw text of one job's log. Returned verbatim — capping is the tool's job,
   * so the client stays a thin, honest wrapper (and a non-tool caller can pick
   * its own budget).
   */
  async getJobLogs(owner: string, repo: string, job_id: number) {
    return this.actionsRead(async () => {
      const ok = await this.octokit();
      // Octokit follows the 302 to the log blob and hands back the body; it is
      // text/plain, so the generic `data` type is unhelpful here.
      const { data } = await ok.actions.downloadJobLogsForWorkflowRun({ owner, repo, job_id });
      return typeof data === "string" ? data : String(data);
    });
  }

  // ── Search ────────────────────────────────────────────────────────

  async searchRepositories(query: string, pageNum = 1, perPage = 30) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.search.repos({ q: query, page: pageNum, per_page: perPage });
      return searchPage(data, data.items.map(summarizeRepoHit), pageNum, perPage);
    });
  }

  async searchIssues(query: string, pageNum = 1, perPage = 30) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.search.issuesAndPullRequests({
        q: query,
        page: pageNum,
        per_page: perPage,
      });
      return searchPage(data, data.items.map(summarizeIssueHit), pageNum, perPage);
    });
  }

  async searchCode(query: string, pageNum = 1, perPage = 30) {
    return this.withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.search.code({ q: query, page: pageNum, per_page: perPage });
      return searchPage(data, data.items.map(summarizeCodeHit), pageNum, perPage);
    });
  }
}

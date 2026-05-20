// Thin wrapper around Octokit that refreshes the token automatically.

import { Octokit } from "@octokit/rest";

// Retry config
const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;
const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);

export class GitHubClient {
  constructor(auth) {
    this.auth = auth;
    this._octokit = null;
    this._tokenUsed = null;
  }

  async octokit() {
    const token = await this.auth.getToken();
    if (token !== this._tokenUsed) {
      this._octokit = new Octokit({ auth: token });
      this._tokenUsed = token;
    }
    return this._octokit;
  }

  /**
   * Retry wrapper with exponential backoff for transient failures.
   * Handles rate limits (429) by respecting Retry-After header.
   */
  async _withRetry(fn) {
    let lastError;
    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastError = err;
        const status = err.status || err.response?.status;

        // Don't retry client errors (except rate limit and timeout)
        if (status && status >= 400 && status < 500 && !RETRYABLE_STATUSES.has(status)) {
          throw err;
        }

        // Don't retry if we've exhausted attempts
        if (attempt === MAX_RETRIES) break;

        // Rate limit: respect Retry-After header
        let delayMs;
        if (status === 429) {
          const retryAfter = err.response?.headers?.["retry-after"];
          delayMs = retryAfter ? parseInt(retryAfter, 10) * 1000 : BASE_DELAY_MS * Math.pow(2, attempt);
        } else {
          delayMs = BASE_DELAY_MS * Math.pow(2, attempt);
        }

        // If token might be expired (401), force refresh before retry
        if (status === 401) {
          this._tokenUsed = null;
        }

        await new Promise((r) => setTimeout(r, delayMs));
      }
    }
    throw lastError;
  }

  // ── Repositories ──────────────────────────────────────────────────

  async getFileContents(owner, repo, path, branch) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const params = { owner, repo, path };
      if (branch) params.ref = branch;
      const { data } = await ok.repos.getContent(params);
      if (data.content) {
        data.decoded_content = Buffer.from(data.content, "base64").toString("utf8");
      }
      return data;
    });
  }

  async createOrUpdateFile(owner, repo, path, content, message, branch, sha) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const params = {
        owner, repo, path, message,
        content: Buffer.from(content).toString("base64"),
      };
      if (branch) params.branch = branch;
      if (sha) params.sha = sha;
      const { data } = await ok.repos.createOrUpdateFileContents(params);
      return data;
    });
  }

  async pushFiles(owner, repo, branch, files, message) {
    return this._withRetry(async () => {
      const ok = await this.octokit();

      // Get the ref
      let ref;
      try {
        const { data } = await ok.git.getRef({ owner, repo, ref: `heads/${branch}` });
        ref = data;
      } catch (e) {
        // Branch doesn't exist — create from default branch
        const { data: repoData } = await ok.repos.get({ owner, repo });
        const { data: defaultRef } = await ok.git.getRef({
          owner, repo, ref: `heads/${repoData.default_branch}`,
        });
        const { data: newRef } = await ok.git.createRef({
          owner, repo,
          ref: `refs/heads/${branch}`,
          sha: defaultRef.object.sha,
        });
        ref = newRef;
      }

      // Create blobs
      const blobs = await Promise.all(
        files.map(async (f) => {
          const { data } = await ok.git.createBlob({
            owner, repo, content: f.content, encoding: "utf-8",
          });
          return { path: f.path, sha: data.sha, mode: "100644", type: "blob" };
        })
      );

      // Create tree
      const { data: tree } = await ok.git.createTree({
        owner, repo, base_tree: ref.object.sha, tree: blobs,
      });

      // Create commit
      const { data: commit } = await ok.git.createCommit({
        owner, repo, message, tree: tree.sha, parents: [ref.object.sha],
      });

      // Update ref
      const { data: updated } = await ok.git.updateRef({
        owner, repo, ref: `heads/${branch}`, sha: commit.sha,
      });

      return { commit: commit.sha, branch, ref: updated };
    });
  }

  async searchRepositories(query, page = 1, perPage = 30) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.search.repos({ q: query, page, per_page: perPage });
      return data;
    });
  }

  async getRepository(owner, repo) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.repos.get({ owner, repo });
      return data;
    });
  }

  async listBranches(owner, repo, page = 1, perPage = 30) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.repos.listBranches({ owner, repo, page, per_page: perPage });
      return data;
    });
  }

  // ── Issues ────────────────────────────────────────────────────────

  async listIssues(owner, repo, opts = {}) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.listForRepo({
        owner, repo, state: "open", per_page: 30, ...opts,
      });
      return data;
    });
  }

  async getIssue(owner, repo, issue_number) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.get({ owner, repo, issue_number });
      return data;
    });
  }

  async createIssue(owner, repo, title, body, opts = {}) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.create({ owner, repo, title, body, ...opts });
      return data;
    });
  }

  async updateIssue(owner, repo, issue_number, updates) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.update({ owner, repo, issue_number, ...updates });
      return data;
    });
  }

  async addIssueComment(owner, repo, issue_number, body) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.createComment({ owner, repo, issue_number, body });
      return data;
    });
  }

  async listIssueComments(owner, repo, issue_number, opts = {}) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.listComments({
        owner, repo, issue_number, per_page: 30, ...opts,
      });
      return data;
    });
  }

  async addLabels(owner, repo, issue_number, labels) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.addLabels({ owner, repo, issue_number, labels });
      return data;
    });
  }

  async removeLabel(owner, repo, issue_number, name) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.removeLabel({ owner, repo, issue_number, name });
      return data;
    });
  }

  // ── Pull Requests ─────────────────────────────────────────────────

  async listPullRequests(owner, repo, opts = {}) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      // GitHub treats empty-string filters (`?head=`, `?base=`) as literal
      // matches and returns []. Strip empty optional filters so the agent
      // can't accidentally narrow to nothing by passing `head: ""`.
      const cleaned = {};
      for (const [k, v] of Object.entries(opts)) {
        if (v === "" || v === undefined || v === null) continue;
        cleaned[k] = v;
      }
      const { data } = await ok.pulls.list({
        owner, repo, state: "open", per_page: 30, ...cleaned,
      });
      return data;
    });
  }

  async getPullRequest(owner, repo, pull_number) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.pulls.get({ owner, repo, pull_number });
      return data;
    });
  }

  async createPullRequest(owner, repo, title, body, head, base) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.pulls.create({ owner, repo, title, body, head, base });
      return data;
    });
  }

  async listPullRequestFiles(owner, repo, pull_number) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.pulls.listFiles({ owner, repo, pull_number, per_page: 100 });
      return data;
    });
  }

  async listPullRequestReviews(owner, repo, pull_number) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.pulls.listReviews({ owner, repo, pull_number, per_page: 100 });
      return data;
    });
  }

  async listPullRequestReviewComments(owner, repo, pull_number) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.pulls.listReviewComments({ owner, repo, pull_number, per_page: 100 });
      return data;
    });
  }

  async createPullRequestReview(owner, repo, pull_number, body, event, comments = []) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const params = { owner, repo, pull_number, body, event };
      if (comments.length) params.comments = comments;
      const { data } = await ok.pulls.createReview(params);
      return data;
    });
  }

  async getPullRequestDiff(owner, repo, pull_number) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.pulls.get({
        owner, repo, pull_number,
        mediaType: { format: "diff" },
      });
      return data;
    });
  }

  async mergePullRequest(owner, repo, pull_number, opts = {}) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.pulls.merge({ owner, repo, pull_number, ...opts });
      return data;
    });
  }

  // ── Commits & Branches ────────────────────────────────────────────

  async listCommits(owner, repo, opts = {}) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.repos.listCommits({
        owner, repo, per_page: 30, ...opts,
      });
      return data;
    });
  }

  async createBranch(owner, repo, branch, fromBranch) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data: ref } = await ok.git.getRef({
        owner, repo, ref: `heads/${fromBranch}`,
      });
      const { data } = await ok.git.createRef({
        owner, repo,
        ref: `refs/heads/${branch}`,
        sha: ref.object.sha,
      });
      return data;
    });
  }

  // ── Search ────────────────────────────────────────────────────────

  async searchIssues(query, page = 1, perPage = 30) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.search.issuesAndPullRequests({
        q: query, page, per_page: perPage,
      });
      return data;
    });
  }

  async searchCode(query, page = 1, perPage = 30) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.search.code({ q: query, page, per_page: perPage });
      return data;
    });
  }

  // ── Labels ────────────────────────────────────────────────────────

  async listLabels(owner, repo) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.listLabelsForRepo({ owner, repo, per_page: 100 });
      return data;
    });
  }

  async createLabel(owner, repo, name, color, description) {
    return this._withRetry(async () => {
      const ok = await this.octokit();
      const { data } = await ok.issues.createLabel({ owner, repo, name, color, description });
      return data;
    });
  }
}

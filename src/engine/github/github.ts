import type { Octokit } from "octokit";
import {
  githubAppClient,
  githubTokenClient,
  type GitHubAppClientConfig,
} from "./github-app-client.js";
import type { InlineComment, ReviewEvent } from "./review-poster.js";

/** GitHub reaction emoji values accepted by the reactions API. */
export type ReactionContent =
  | "+1"
  | "-1"
  | "laugh"
  | "confused"
  | "heart"
  | "hooray"
  | "rocket"
  | "eyes";

/**
 * GitHub client for the harness — uses GitHub App auth.
 * Used by the orchestrator to post comments, not by agent sessions.
 */
export class GitHubClient {
  private octokit: Octokit;

  constructor(config: GitHubAppClientConfig) {
    this.octokit = githubAppClient(config);
  }

  /**
   * Build a client authed with a raw bearer token (a pre-minted installation
   * token) instead of App JWT auth. Used by the harness-side `post-review`
   * action: prod passes the run's scoped review-write token; evals pass the
   * mock's token + `baseUrl`. Avoids the App installation-token minting
   * round-trip (which hard-codes api.github.com and the evals mock doesn't
   * serve).
   */
  static withToken(token: string, baseUrl?: string): GitHubClient {
    const client = Object.create(GitHubClient.prototype) as GitHubClient;
    client.octokit = githubTokenClient(token, baseUrl);
    return client;
  }

  /**
   * Create a new comment on an issue/PR. Returns the new comment id so callers
   * that want to edit it later (the in-place status checklist — see
   * `src/notify/transports/github.ts`) can hold onto a handle. Callers that
   * just post a one-off comment can ignore the return.
   */
  async postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<number> {
    const { data } = await this.octokit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return data.id;
  }

  /**
   * List every repository the App installation can access, as `owner/repo`
   * full names. Used at boot to seed the managed-repo list from the App grant
   * (see src/managed-repos.ts). The installation id is bound by the App auth
   * strategy, so no argument is needed. Paginated — handles installs with
   * hundreds of repos.
   */
  async listInstallationRepos(): Promise<string[]> {
    const repos = await this.octokit.paginate(
      this.octokit.rest.apps.listReposAccessibleToInstallation,
      { per_page: 100 },
    );
    return repos.map((r) => r.full_name);
  }

  /**
   * Edit an existing issue/PR comment in place. Paired with `postComment` to
   * maintain a single status comment that updates as a workflow progresses,
   * rather than posting a new comment per phase. GitHub does NOT notify
   * watchers on edits, which is exactly why this keeps the thread quiet.
   */
  async updateComment(owner: string, repo: string, commentId: number, body: string): Promise<void> {
    await this.octokit.rest.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body,
    });
  }

  /**
   * Add an emoji reaction to a specific issue comment. Used as an immediate
   * (silent) acknowledgment that the agent has accepted a request, before
   * any actual work — and any chatty bot comments — start.
   *
   * Reaction `content` values: "+1" | "-1" | "laugh" | "confused" | "heart"
   * | "hooray" | "rocket" | "eyes".
   */
  async reactToComment(
    owner: string,
    repo: string,
    commentId: number,
    content: ReactionContent = "rocket",
  ): Promise<void> {
    await this.octokit.rest.reactions.createForIssueComment({
      owner,
      repo,
      comment_id: commentId,
      content,
    });
  }

  /**
   * Add an emoji reaction to an issue or PR itself (not a comment) — used to
   * ack events that aren't comments, e.g. a freshly opened issue/PR. PRs are
   * issues for the reactions API, so this works for both.
   */
  async reactToIssue(
    owner: string,
    repo: string,
    issueNumber: number,
    content: ReactionContent = "eyes",
  ): Promise<void> {
    await this.octokit.rest.reactions.createForIssue({
      owner,
      repo,
      issue_number: issueNumber,
      content,
    });
  }

  /**
   * Add an emoji reaction to a pull-request review comment (inline diff
   * comment). Distinct endpoint from issue comments — review comments live on
   * the pulls API.
   */
  async reactToReviewComment(
    owner: string,
    repo: string,
    commentId: number,
    content: ReactionContent = "eyes",
  ): Promise<void> {
    await this.octokit.rest.reactions.createForPullRequestReviewComment({
      owner,
      repo,
      comment_id: commentId,
      content,
    });
  }

  async getIssue(owner: string, repo: string, issueNumber: number) {
    const { data } = await this.octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });
    return data;
  }

  /**
   * Fetch the issue body. Used by the dispatch path so build/explore/pr-fix
   * workflows always see the real issue body, even when triggered from a
   * comment (where the EventEnvelope.body field is the comment, not the
   * issue body).
   */
  async getIssueBody(owner: string, repo: string, issueNumber: number): Promise<string> {
    const { data } = await this.octokit.rest.issues.get({
      owner,
      repo,
      issue_number: issueNumber,
    });
    return data.body || "";
  }

  /**
   * List all comments on an issue/PR, oldest first. Used by the dispatch path
   * to inject the full conversation thread into the architect's context — the
   * spec the bot writes during an `explore` run lives here, and the build
   * cycle needs to see it to implement the agreed design.
   */
  async listIssueComments(
    owner: string,
    repo: string,
    issueNumber: number,
  ): Promise<Array<{ user: string; body: string; createdAt: string }>> {
    const data = await this.octokit.paginate(
      this.octokit.rest.issues.listComments,
      { owner, repo, issue_number: issueNumber, per_page: 100 },
    );
    return data.map((c) => ({
      user: c.user?.login || "unknown",
      body: c.body || "",
      createdAt: c.created_at,
    }));
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number) {
    const { data } = await this.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });
    return data;
  }

  /**
   * The repo's default branch (e.g. `main`, `master`, `develop`). Used to
   * scope build runs to the real base branch instead of assuming `main` — a
   * `master`-default repo otherwise breaks every `git ... main..HEAD` the
   * reviewer runs. See the `baseBranch` plumbing in src/index.ts.
   */
  async getDefaultBranch(owner: string, repo: string): Promise<string> {
    const { data } = await this.octokit.rest.repos.get({ owner, repo });
    return data.default_branch;
  }

  /** Convenience: fetch only the PR's head commit SHA. Used by check-run code. */
  async getPullRequestHeadSha(owner: string, repo: string, pullNumber: number): Promise<string> {
    const { data } = await this.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
    });
    return data.head.sha;
  }

  /**
   * Create a Check Run on a PR's head commit. Returns the new check_run id so
   * the caller can later transition it from `in_progress` → `completed` with
   * a conclusion. Repos that enable "Require status checks to pass" with
   * `name` in their list will gate merges on the eventual conclusion.
   *
   * Requires the GitHub App to have `Checks: Read and write` permission.
   */
  async createCheckRun(
    owner: string,
    repo: string,
    headSha: string,
    name: string,
    options: { detailsUrl?: string; output?: { title: string; summary: string } } = {},
  ): Promise<number> {
    const { data } = await this.octokit.rest.checks.create({
      owner,
      repo,
      name,
      head_sha: headSha,
      status: "in_progress",
      started_at: new Date().toISOString(),
      ...(options.detailsUrl ? { details_url: options.detailsUrl } : {}),
      ...(options.output ? { output: options.output } : {}),
    });
    return data.id;
  }

  /**
   * Update an existing Check Run — typically to transition `in_progress` →
   * `completed` with a conclusion. Conclusion values that branch protection
   * treats as passing: `success`, `neutral`, `skipped`. Failing: `failure`,
   * `cancelled`, `timed_out`, `action_required`.
   */
  async updateCheckRun(
    owner: string,
    repo: string,
    checkRunId: number,
    update: {
      status?: "queued" | "in_progress" | "completed";
      conclusion?:
        | "success"
        | "failure"
        | "neutral"
        | "cancelled"
        | "timed_out"
        | "action_required"
        | "skipped";
      /** Sets the check's "Details" link (e.g. the dashboard run deep link). */
      detailsUrl?: string;
      output?: { title: string; summary: string };
    },
  ): Promise<void> {
    await this.octokit.rest.checks.update({
      owner,
      repo,
      check_run_id: checkRunId,
      ...(update.status ? { status: update.status } : {}),
      ...(update.conclusion ? { conclusion: update.conclusion } : {}),
      ...(update.status === "completed" ? { completed_at: new Date().toISOString() } : {}),
      ...(update.detailsUrl ? { details_url: update.detailsUrl } : {}),
      ...(update.output ? { output: update.output } : {}),
    });
  }

  /**
   * Find the bot's most recent review on this PR's current head commit. Used
   * after a pr-review workflow finishes to derive the check-run conclusion
   * from the review the agent actually posted (APPROVE / REQUEST_CHANGES /
   * COMMENT). Returns null when the bot hasn't reviewed this SHA yet.
   *
   * `botLogin` defaults to `last-light[bot]` so the lookup matches App-auth'd
   * reviews regardless of how the agent identified itself.
   */
  async getLatestBotReview(
    owner: string,
    repo: string,
    pullNumber: number,
    headSha: string,
    botLogin = "last-light[bot]",
  ): Promise<{ state: string; body: string | null; submittedAt: string | null } | null> {
    const reviews = await this.octokit.paginate(this.octokit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    // Reviews are returned oldest-first; iterate newest-first to pick the most
    // recent one tied to this SHA. `commit_id` on a review is the head sha at
    // the time the review was submitted, which is exactly the discriminator
    // we want — re-pushes invalidate stale reviews here naturally.
    for (let i = reviews.length - 1; i >= 0; i--) {
      const r = reviews[i]!;
      if (r.user?.login === botLogin && r.commit_id === headSha) {
        return { state: r.state, body: r.body ?? null, submittedAt: r.submitted_at ?? null };
      }
    }
    return null;
  }

  /**
   * Fetch a PR's unified diff (three-dot, base…head) as a string. Used by the
   * `post-review` action to anchor findings to changed lines — the harness runs
   * this in-process (not in the sandbox), so the diff comes from the API rather
   * than a local `git diff`, with no dependency on checkout/fetch state.
   */
  async getPullRequestDiff(owner: string, repo: string, pullNumber: number): Promise<string> {
    const res = await this.octokit.rest.pulls.get({
      owner,
      repo,
      pull_number: pullNumber,
      mediaType: { format: "diff" },
    });
    // With `format: diff` Octokit returns the raw diff as the response body,
    // typed as the JSON shape — cast through unknown.
    return res.data as unknown as string;
  }

  /**
   * Submit one formal PR review with an event (APPROVE / REQUEST_CHANGES /
   * COMMENT) plus optional line-anchored inline comments. `commitId` pins the
   * review to the reviewed head SHA. This is the single harness-side write for
   * PR reviews — the reviewer agent never submits; it writes findings and the
   * `post-review` action calls this. Throws on a non-2xx so the action can fail
   * the phase visibly (or retry body-only).
   */
  async createPullRequestReview(
    owner: string,
    repo: string,
    pullNumber: number,
    review: { body: string; event: ReviewEvent; comments?: InlineComment[]; commitId?: string },
  ): Promise<void> {
    await this.octokit.rest.pulls.createReview({
      owner,
      repo,
      pull_number: pullNumber,
      body: review.body,
      event: review.event,
      ...(review.comments && review.comments.length ? { comments: review.comments } : {}),
      ...(review.commitId ? { commit_id: review.commitId } : {}),
    });
  }

  /**
   * Get failed check runs for a PR's head SHA.
   * Fetches the actual job logs (not just annotations) to show real errors.
   */
  async getFailedChecks(owner: string, repo: string, ref: string): Promise<string> {
    try {
      const { data } = await this.octokit.rest.checks.listForRef({
        owner,
        repo,
        ref,
        filter: "latest",
      });

      const failed = data.check_runs.filter(
        (r) => r.conclusion === "failure" || r.conclusion === "timed_out"
      );

      if (failed.length === 0) return "No failed checks found.";

      const summaries = await Promise.all(failed.map(async (run) => {
        let logExcerpt = "";

        // Try to fetch the actual job log (contains the real errors)
        if (run.details_url) {
          try {
            // Extract the job ID from the check run — the run is linked to a workflow job
            const jobId = run.id;
            const { data: logData } = await this.octokit.rest.actions.downloadJobLogsForWorkflowRun({
              owner,
              repo,
              job_id: jobId,
            });
            // logData is a string with the full log
            const fullLog = typeof logData === "string" ? logData : String(logData);
            // Extract the last N lines which typically contain the error
            const lines = fullLog.split("\n");
            // Find error lines and surrounding context
            const errorLines: string[] = [];
            for (let i = 0; i < lines.length; i++) {
              const line = lines[i];
              if (line.match(/error|ERR!|FAIL|failed|Error:|npm ERR/i) && !line.match(/^$/)) {
                // Include some context before and after
                const start = Math.max(0, i - 2);
                const end = Math.min(lines.length, i + 5);
                for (let j = start; j < end; j++) {
                  if (!errorLines.includes(lines[j])) {
                    errorLines.push(lines[j]);
                  }
                }
              }
            }
            if (errorLines.length > 0) {
              logExcerpt = errorLines.slice(0, 50).join("\n");
            } else {
              // No error lines found — show the last 30 lines
              logExcerpt = lines.slice(-30).join("\n");
            }
          } catch {
            // Job logs may not be available — fall back to annotations
          }
        }

        // Fall back to annotations if no job logs
        if (!logExcerpt) {
          try {
            const { data: annotations } = await this.octokit.rest.checks.listAnnotations({
              owner,
              repo,
              check_run_id: run.id,
            });
            if (annotations.length > 0) {
              logExcerpt = annotations
                .filter((a) => a.annotation_level === "failure")
                .slice(0, 10)
                .map((a) => `${a.path}:${a.start_line} — ${a.message}`)
                .join("\n");
            }
          } catch { /* annotations may not be available */ }
        }

        return `### ${run.name}: ${run.conclusion}\n${logExcerpt || "No log details available."}`;
      }));

      return summaries.join("\n\n");
    } catch (err: any) {
      return `Could not fetch check runs: ${err.message}`;
    }
  }
}

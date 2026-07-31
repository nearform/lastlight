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
 * One file fetched out of a repo's `.lastlight/` subtree.
 *
 * `path` is relative to `.lastlight/` itself (`lastlight.yml`,
 * `workflows/prompts/plan.md`, …) so the result drops straight onto disk in the
 * same shape as a deployment overlay. `mode` is the raw git filemode from the
 * tree entry — kept verbatim so the consumer can reject symlinks (`120000`)
 * without a second round-trip.
 */
export interface RepoConfigFile {
  path: string;
  mode: string;
  size: number;
  content: Buffer;
}

/**
 * Result of {@link GitHubClient.fetchRepoConfigTree}. Three outcomes, none of
 * them exceptional:
 *  - `absent`       — the repo has no `.lastlight/` (the common case; cheap).
 *  - `not-modified` — the caller's `etag`/`treeSha` still matches, so nothing
 *                     was downloaded and the caller's cached copy stands.
 *  - `ok`           — the subtree, fully materialized.
 *
 * `defaultBranch` is always reported because it IS the trust boundary: the
 * subtree only ever comes from there.
 */
export type RepoConfigTreeResult =
  | { status: "absent"; defaultBranch: string }
  | { status: "not-modified"; defaultBranch: string; treeSha: string; etag?: string }
  | {
      status: "ok";
      defaultBranch: string;
      treeSha: string;
      etag?: string;
      files: RepoConfigFile[];
      /** GitHub truncated the subtree listing — treat the result as incomplete. */
      truncated: boolean;
    };

/** Options for {@link GitHubClient.fetchRepoConfigTree}. */
export interface RepoConfigTreeOptions {
  /** ETag of the root-tree read from the previous fetch — enables a 304. */
  etag?: string;
  /** `.lastlight/` tree SHA from the previous fetch — a content-exact conditional. */
  treeSha?: string;
  /** Hard cap on files materialized (default 200). Extra entries are skipped. */
  maxFiles?: number;
  /** Hard cap on total bytes downloaded (default 2 MiB). Oversized entries are skipped. */
  maxBytes?: number;
  /**
   * Blob filter applied BEFORE downloading, on the path relative to
   * `.lastlight/`. Matters because `.lastlight/` is shared real estate: in
   * `buildAssets.location: repo` mode the build workflow commits its handoff
   * docs to `.lastlight/<issueKey>/*.md` there too. Without a filter those docs
   * would eat the byte budget and crowd out the config layer.
   */
  includePath?: (path: string) => boolean;
}

const REPO_CONFIG_DIR = ".lastlight";
const REPO_CONFIG_DEFAULT_MAX_FILES = 200;
const REPO_CONFIG_DEFAULT_MAX_BYTES = 2 * 1024 * 1024;

/** octokit surfaces HTTP failures as errors carrying the numeric `status`. */
function httpStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

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
   * Delete an issue/PR comment the bot posted earlier. Used to retract a
   * *transient* status comment once it stops being true — currently the
   * concurrency-cap enqueue ack, which promises "it'll start automatically when
   * a slot frees" and is meaningless (issue #244) the moment the run is
   * admitted. Only ever call this on a comment id this harness created.
   */
  async deleteComment(owner: string, repo: string, commentId: number): Promise<void> {
    await this.octokit.rest.issues.deleteComment({
      owner,
      repo,
      comment_id: commentId,
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
   * List a repo's open pull requests as light records (number / title / draft /
   * author login / labels / head ref + sha). Deterministic discovery for the
   * dependency-merge and dependency-ci-fix crons: they filter these by author +
   * green/red status in code and fan out one bounded single-PR run per candidate
   * — no agent sweep, so a repo with many open bumps can't overflow a single
   * scan's context. `labels` drives the `requires-human` skip; `headRef` lets the
   * red sweep pre-clone the PR head for ci-fix; `headSha` pins the exact commit
   * the check-conclusion query reads. All fields ride the same paginated
   * `pulls.list` response — no extra API call.
   */
  async listOpenPullRequests(
    owner: string,
    repo: string,
  ): Promise<
    Array<{
      number: number;
      title: string;
      draft: boolean;
      authorLogin: string;
      labels: string[];
      headRef: string;
      headSha: string;
    }>
  > {
    const prs = await this.octokit.paginate(this.octokit.rest.pulls.list, {
      owner,
      repo,
      state: "open",
      per_page: 100,
    });
    return prs.map((p) => ({
      number: p.number,
      title: p.title ?? "",
      draft: !!p.draft,
      authorLogin: p.user?.login ?? "",
      labels: (p.labels ?? [])
        .map((l) => (typeof l === "string" ? l : l.name ?? ""))
        .filter(Boolean),
      headRef: p.head?.ref ?? "",
      headSha: p.head?.sha ?? "",
    }));
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

  /**
   * Fetch a repo's committed `.lastlight/` subtree — its per-repo configuration
   * layer (issue #180) — from the repo's **default branch**.
   *
   * SECURITY — the default branch is the entire trust model here. This subtree
   * can re-point models, disable workflows and add approval gates for every run
   * against the repo, so it must only ever be read from a ref that already
   * passed the repo's own review/branch-protection. It is resolved live from the
   * repo metadata on every call (never assumed to be `main`), and NEVER read
   * from a PR head or from the sandbox checkout — otherwise a pull request could
   * rewrite the configuration of the agent reviewing it.
   *
   * Cheap by design, because a cron fanning out over N repos calls this N times:
   *  - `options.etag` (the previous call's root-tree ETag) short-circuits an
   *    untouched repo at a conditional 304 — 2 requests, no downloads.
   *  - `options.treeSha` (the previous `.lastlight/` tree SHA) short-circuits a
   *    repo that has committed elsewhere since. A git tree SHA is the content
   *    hash of the whole subtree, so equality means byte-identical.
   *  - a repo with no `.lastlight/` returns `{ status: "absent" }` — the common
   *    case is a normal negative result, not an exception.
   * Only when both conditionals miss does it download blobs, bounded by
   * `maxFiles` / `maxBytes` so a hostile repo can't make the harness pull an
   * unbounded tree.
   *
   * Lives on the client (rather than raw octokit at the call site) because the
   * evals harness swaps this whole seam for fixtures.
   */
  async fetchRepoConfigTree(
    owner: string,
    repo: string,
    options: RepoConfigTreeOptions = {},
  ): Promise<RepoConfigTreeResult> {
    const maxFiles = options.maxFiles ?? REPO_CONFIG_DEFAULT_MAX_FILES;
    const maxBytes = options.maxBytes ?? REPO_CONFIG_DEFAULT_MAX_BYTES;

    // The trust ref. Resolved every time — a repo can rename its default branch,
    // and caching the name would silently keep reading a stale (possibly
    // unprotected) ref.
    const { data: repoData } = await this.octokit.rest.repos.get({ owner, repo });
    const defaultBranch = repoData.default_branch;

    // Conditional read of the branch's root tree. `If-None-Match` is only worth
    // sending when we also hold the previous tree SHA — a 304 tells us "nothing
    // changed", which we can only turn into a useful answer if we can name what
    // didn't change.
    const conditional = options.etag && options.treeSha;
    let rootTree;
    try {
      rootTree = await this.octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: defaultBranch,
        ...(conditional ? { headers: { "if-none-match": options.etag! } } : {}),
      });
    } catch (err: unknown) {
      const status = httpStatus(err);
      // octokit surfaces a conditional-request hit as a thrown HttpError with
      // status 304 (anything non-2xx throws) — that's the cheap path, not a
      // failure. `If-None-Match` is only ever sent alongside a stored tree SHA
      // (see `conditional` above), so there is always one to hand back.
      if (status === 304 && options.treeSha) {
        return { status: "not-modified", defaultBranch, treeSha: options.treeSha, etag: options.etag };
      }
      // 404 = no commits yet (a brand-new empty repo); 409 = "Git Repository is
      // empty". Neither is an error worth propagating — there is simply no
      // config to read.
      if (status === 404 || status === 409) return { status: "absent", defaultBranch };
      throw err;
    }
    const etag = typeof rootTree.headers?.etag === "string" ? rootTree.headers.etag : undefined;

    const dirEntry = rootTree.data.tree.find((e) => e.path === REPO_CONFIG_DIR && e.type === "tree");
    if (!dirEntry?.sha) return { status: "absent", defaultBranch };
    const treeSha = dirEntry.sha;
    // Content-exact conditional: same subtree SHA ⇒ same bytes, whatever else
    // the repo committed since.
    if (options.treeSha && options.treeSha === treeSha) {
      return { status: "not-modified", defaultBranch, treeSha, etag };
    }

    let subtree;
    try {
      subtree = await this.octokit.rest.git.getTree({
        owner,
        repo,
        tree_sha: treeSha,
        recursive: "1",
      });
    } catch (err: unknown) {
      if (httpStatus(err) === 404) return { status: "absent", defaultBranch };
      throw err;
    }

    const files: RepoConfigFile[] = [];
    let bytes = 0;
    let truncated = subtree.data.truncated === true;
    for (const entry of subtree.data.tree) {
      // `commit` entries are submodules (no blob to read); `tree` entries are
      // directories, implied by their children's paths.
      if (entry.type !== "blob" || !entry.path || !entry.sha) continue;
      if (options.includePath && !options.includePath(entry.path)) continue;
      const size = typeof entry.size === "number" ? entry.size : 0;
      if (files.length >= maxFiles || bytes + size > maxBytes) {
        // Stop materializing rather than throwing: the caller decides how to
        // report an over-cap repo, and a partial tree is still flagged.
        truncated = true;
        continue;
      }
      const { data: blob } = await this.octokit.rest.git.getBlob({ owner, repo, file_sha: entry.sha });
      const content = Buffer.from(blob.content ?? "", (blob.encoding as BufferEncoding) ?? "base64");
      // Re-check against the ACTUAL length. `entry.size` is absent on some tree
      // entries and defaults to 0 above, so the pre-check degrades to
      // `bytes + 0 > maxBytes` and would admit a blob of any size.
      // `sanitizeRepoFiles` applies the cap again downstream, but this one is
      // meant to hold on its own. `continue`, not `break`, for the same reason
      // as above: a later small file is still admissible.
      if (bytes + content.length > maxBytes) {
        truncated = true;
        continue;
      }
      bytes += content.length;
      // Record the true size, not the (possibly absent, possibly wrong) size
      // the tree reported — downstream cap checks key off this.
      files.push({ path: entry.path, mode: entry.mode ?? "100644", size: content.length, content });
    }

    return { status: "ok", defaultBranch, treeSha, etag, files, truncated };
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
   * Settle-aware check conclusion for a ref — the LIGHT counterpart to
   * {@link getFailedChecks} (no job-log download). The red-dependency-PR cron
   * uses it to decide whether to fire `dependabot-ci-fix` without pulling logs
   * for every candidate.
   *
   * It combines check_runs (GitHub Actions et al.) with the combined commit
   * status (classic contexts: CircleCI, external CI) so a repo whose CI reports
   * only via statuses — exactly the kind the live `check_suite` webhook never
   * sees — isn't invisible to the backstop.
   *
   *   "none"    — no check_runs AND no status contexts (nothing to judge).
   *   "pending" — a check_run is queued/in_progress, or the combined status is
   *               pending with ≥1 context. We do NOT fire ci-fix mid-flight.
   *   "failing" — the suite has SETTLED (nothing pending) AND a check_run
   *               concluded failure/timed_out OR the combined status is
   *               failure/error. The conclusion set matches getFailedChecks so
   *               discovery and the fix prompt agree on what "red" means.
   *   "passing" — there ARE checks/statuses and none are failing or pending.
   */
  async getChecksConclusion(
    owner: string,
    repo: string,
    ref: string,
  ): Promise<"passing" | "failing" | "pending" | "none"> {
    const [{ data: checks }, { data: status }] = await Promise.all([
      this.octokit.rest.checks.listForRef({ owner, repo, ref, filter: "latest" }),
      this.octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref }),
    ]);
    const runs = checks.check_runs;
    const statuses = status.statuses ?? [];

    if (runs.length === 0 && statuses.length === 0) return "none";

    const runPending = runs.some((r) => r.status === "queued" || r.status === "in_progress");
    const statusPending = statuses.length > 0 && status.state === "pending";
    if (runPending || statusPending) return "pending";

    const runFailing = runs.some(
      (r) => r.conclusion === "failure" || r.conclusion === "timed_out",
    );
    const statusFailing = status.state === "failure" || status.state === "error";
    if (runFailing || statusFailing) return "failing";

    return "passing";
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

        // Try to fetch the actual Actions job log using the job id from details_url.
        const jobId = actionsJobIdFromDetailsUrl(run.details_url);
        if (jobId !== null) {
          try {
            const { data: logData } = await this.octokit.rest.actions.downloadJobLogsForWorkflowRun({
              owner,
              repo,
              job_id: jobId,
            });
            const fullLog = typeof logData === "string" ? logData : String(logData);
            logExcerpt = extractErrorExcerpt(fullLog);
          } catch {
            // Job logs may not be available — fall back to annotations
          }
        }

        // Fall back to annotations if no job logs
        if (!logExcerpt) {
          logExcerpt = await fetchAnnotationExcerpt(this.octokit, owner, repo, run.id);
        }

        return `### ${run.name}: ${run.conclusion}\n${logExcerpt || "No log details available."}`;
      }));

      return summaries.join("\n\n");
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Could not fetch check runs: ${message}`;
    }
  }
}

// ---------------------------------------------------------------------------
// Module-private helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp prefix that Actions prepends to every log line. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/;

/** Lines that carry no actionable signal on their own. */
const NOISE_RE = /Process completed with exit code|##\[error\]Process completed|^##\[error\]$/i;

/**
 * Parse the Actions job id from a check-run's `details_url`.
 * Actions URLs look like: `.../actions/runs/<runId>/job/<jobId>`
 * Returns `null` for non-Actions checks or unparseable URLs.
 */
export function actionsJobIdFromDetailsUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const m = url.match(/\/job\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * Strip the leading timestamp from a raw Actions log line.
 */
function stripTimestamp(line: string): string {
  return line.replace(TIMESTAMP_RE, "");
}

/**
 * Given the full text of an Actions job log, return a compact excerpt
 * highlighting the real error lines with surrounding context.
 * Timestamps are stripped; pure noise lines are deprioritised.
 */
export function extractErrorExcerpt(fullLog: string): string {
  const rawLines = fullLog.split("\n");
  const lines = rawLines.map(stripTimestamp);

  // Collect indices of real (non-noise) error lines
  const realErrorIndices: number[] = [];
  const noiseOnlyIndices: number[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.match(/error|ERR!|FAIL|failed|Error:|npm ERR/i) || line.match(/^\s*$/)) continue;
    if (NOISE_RE.test(line)) {
      noiseOnlyIndices.push(i);
    } else {
      realErrorIndices.push(i);
    }
  }

  // Prefer real error lines; fall back to noise-only if that's all we have
  const anchorIndices = realErrorIndices.length > 0 ? realErrorIndices : noiseOnlyIndices;

  if (anchorIndices.length > 0) {
    return buildContextExcerpt(lines, anchorIndices);
  }

  // No error lines at all — return the last 30 lines as a tail
  return lines.slice(-30).join("\n");
}

/**
 * Build a de-duplicated context excerpt from the given anchor line indices.
 */
function buildContextExcerpt(lines: string[], anchorIndices: number[]): string {
  const included = new Set<number>();
  for (const i of anchorIndices) {
    const start = Math.max(0, i - 2);
    const end = Math.min(lines.length, i + 6);
    for (let j = start; j < end; j++) included.add(j);
  }
  const sorted = Array.from(included).sort((a, b) => a - b);
  return sorted.slice(0, 50).map((i) => lines[i]).join("\n");
}

/**
 * Fetch annotation lines for a check run, trying failure-level first then
 * warning-level so the block is never emptier than necessary.
 */
async function fetchAnnotationExcerpt(
  octokit: Octokit,
  owner: string,
  repo: string,
  checkRunId: number
): Promise<string> {
  try {
    const { data: annotations } = await octokit.rest.checks.listAnnotations({
      owner,
      repo,
      check_run_id: checkRunId,
    });
    if (annotations.length === 0) return "";

    const failures = annotations
      .filter((a) => a.annotation_level === "failure")
      .slice(0, 10)
      .map((a) => `${a.path}:${a.start_line} — ${a.message}`);

    if (failures.length > 0) return failures.join("\n");

    // Fall back to warning-level annotations
    return annotations
      .filter((a) => a.annotation_level === "warning")
      .slice(0, 10)
      .map((a) => `${a.path}:${a.start_line} — ${a.message}`)
      .join("\n");
  } catch {
    return "";
  }
}

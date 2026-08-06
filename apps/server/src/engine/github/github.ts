import type { Octokit } from "octokit";
import { githubAppClient, githubTokenClient } from "./github-app-client.js";
import { getInstallationDirectory } from "./installations.js";
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

/**
 * One failed check run, resolved as far as the App's permissions allow.
 *
 * The optional fields are exactly the ones that need `Actions: read`. They are
 * the difference between "CI is red" and "CI is red *here*, in *this* step of
 * *this* workflow file" — `workflowPath` is what lets a fix agent open the CI
 * definition in its checkout and compare CI's toolchain against the sandbox's.
 */
export interface CiJobFailure {
  /** Check-run name, e.g. `CI / build (22)`. */
  name: string;
  /** `failure` | `timed_out` — the conclusions {@link GitHubClient.getChecksConclusion} calls red. */
  conclusion: string;
  /** e.g. `.github/workflows/ci.yml`. Undefined for non-Actions checks or when Actions is unreadable. */
  workflowPath?: string;
  /** Name of the step that failed, from the job's `steps[]`. Same availability as `workflowPath`. */
  failingStep?: string;
  /** {@link extractErrorExcerpt} over the real job log, or the annotation fallback. */
  logExcerpt: string;
  /** The check run's `details_url` — where an agent can dig further via `github_get_job_logs`. */
  jobUrl?: string;
  /** True only when `logExcerpt` came from the REAL Actions job log. */
  logsAvailable: boolean;
  /**
   * WHY the real log is missing, when it is. Set only for an Actions job we
   * actually tried to read — see {@link CiLogUnavailableCause}.
   */
  logUnavailableCause?: CiLogUnavailableCause;
}

/**
 * Why an Actions job log could not be used as evidence.
 *
 * Every one of these used to collapse into a single `.catch(() => null)`, and
 * the banner then asserted the one cause we had never checked ("the App lacks
 * `Actions: read`"). Telling an operator to grant a permission they already
 * granted is a smaller version of exactly the damage issue #251's Finding 1 was
 * about: a degradation that reads as normal operation. So the cause is
 * CLASSIFIED at the point of failure and rendered verbatim.
 *
 *  - `forbidden`   — HTTP 403. The genuine missing-permission case, and the
 *                    only one where "grant Actions: read" is the fix. App-wide,
 *                    so one job saying it settles it for the whole report.
 *  - `expired`     — HTTP 410 Gone. Actions retains logs for a bounded window;
 *                    on an older PR this is the COMMON case, and there is
 *                    nothing to grant.
 *  - `unavailable` — anything else: 429/secondary rate limit, 5xx, the report
 *                    deadline firing, or a body we could not decode. Transient.
 *  - `empty`       — the download succeeded and carried nothing usable. Not a
 *                    fetch problem at all.
 */
export type CiLogUnavailableCause = "forbidden" | "expired" | "unavailable" | "empty";

/** Structured result of {@link GitHubClient.getCiFailureReport}. */
export interface CiFailureReport {
  jobs: CiJobFailure[];
  /** False when NO job could supply a real log — everything below is annotations. */
  logsAvailable: boolean;
  /**
   * The cause the banner speaks with when `logsAvailable` is false — the most
   * actionable one across the jobs (see {@link dominantLogUnavailableCause}).
   * Undefined when logs were available or when no Actions job was even tried.
   */
  logUnavailableCause?: CiLogUnavailableCause;
}

/** Options shared by the three settle-aware check queries. */
export interface ChecksQueryOptions {
  /**
   * Drop check runs produced by this GitHub App slug — in practice always our
   * own `botName`.
   *
   * **This is the self-gating deadlock fix** (07-review-triggers.md §7.2). The
   * aggregate is computed over *every* check run on the head SHA, ours
   * included, so a `last-light/review` check sitting `queued` (waiting for CI,
   * under `review.trigger: after-checks`) or `in_progress` (a review actually
   * running) makes the aggregate permanently `pending`. The settle event then
   * never fires, the review never runs, the check never concludes — and if the
   * repo made it a *required* check, the PR is unmergeable forever. The same
   * loop reaches `pr.checks_passed` on a Dependabot PR whose review check is
   * still open, so the rule is uniform: **exclude our own checks from every
   * TRIGGER-side settle computation**, and let GitHub's required-check gate do
   * the real merge gating.
   *
   * It is deliberately opt-in rather than always-on: a caller reporting check
   * state to a *human* (or to the merge prompt) should show what GitHub shows.
   */
  excludeApp?: string;
}

/** octokit surfaces HTTP failures as errors carrying the numeric `status`. */
function httpStatus(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status;
  return typeof status === "number" ? status : undefined;
}

/**
 * Apply {@link ChecksQueryOptions.excludeApp} to a check-run list.
 *
 * One helper rather than the same `filter` inline at each query, because
 * "which reads drop our own checks" is a correctness property (07 §7.2) that
 * should be greppable — `getCiFailureReport` was the one settle-path read that
 * silently didn't, and our own `CHANGES_REQUESTED` review check concludes
 * `failure` (../review-check.ts), so the fix agent was handed its own
 * reviewer's verdict as CI evidence to fix.
 *
 * Only check runs carry an `app`; commit statuses do not, and we never post
 * one, so there is nothing to exclude on that side.
 */
function excludingApp<T extends { app?: { slug?: string | null } | null }>(
  runs: T[],
  opts: ChecksQueryOptions,
): T[] {
  return opts.excludeApp ? runs.filter((r) => r.app?.slug !== opts.excludeApp) : runs;
}

/**
 * Raised when a harness-side call targets an account the GitHub App is not
 * installed on. Distinct from a 404 so callers can say the actionable thing
 * ("install the App on `<owner>`") rather than GitHub's opaque wording.
 */
export class NoInstallationError extends Error {
  constructor(readonly owner: string) {
    super(
      `The GitHub App is not installed on "${owner}". Install it on that ` +
        `account (or remove ${owner}/* from managedRepos).`,
    );
    this.name = "NoInstallationError";
  }
}

/** App creds a {@link GitHubClient} mints from — no installation id: see `kit()`. */
export interface GitHubClientAppConfig {
  appId: string;
  privateKeyPath: string;
  baseUrl?: string;
}

/**
 * GitHub client for the harness — uses GitHub App auth.
 * Used by the orchestrator to post comments, not by agent sessions.
 *
 * **Owner-aware.** A GitHub App installed on N accounts has N installation ids,
 * and an Octokit is bound to exactly one of them. Every method here already
 * takes `owner` first, so the client resolves (and memoizes) one Octokit *per
 * installation* through {@link InstallationDirectory} rather than binding a
 * single configured installation id at construction — which is what made every
 * harness-side call against a second org 404 (see `installations.ts`). Callers
 * are unaffected: signatures are unchanged.
 *
 * In token mode ({@link GitHubClient.withToken}) there is no installation to
 * resolve, so one static Octokit serves every owner.
 */
export class GitHubClient {
  private appConfig?: GitHubClientAppConfig;
  private staticOctokit?: Octokit;
  /** installation id → Octokit. Built lazily, reused for the process's life. */
  private byInstallation = new Map<string, Octokit>();

  constructor(config: GitHubClientAppConfig) {
    this.appConfig = config;
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
    client.byInstallation = new Map();
    client.staticOctokit = githubTokenClient(token, baseUrl);
    return client;
  }

  /**
   * The Octokit authorized for `owner`'s installation of the App.
   *
   * Throws {@link NoInstallationError} when the App isn't installed there —
   * a hard, legible failure, because every alternative (falling back to some
   * other installation's token) produces a 404 or, worse, acts on a
   * same-named repo in the wrong account.
   */
  private async kit(owner: string): Promise<Octokit> {
    if (this.staticOctokit) return this.staticOctokit;
    const installationId = await getInstallationDirectory()?.resolve(owner);
    if (!installationId) throw new NoInstallationError(owner);
    return this.octokitForInstallation(installationId);
  }

  /**
   * Drop the memoized Octokit for an installation — called when the App is
   * uninstalled from an account so a later re-install doesn't reuse a client
   * bound to a dead installation.
   */
  forgetInstallation(installationId: string): void {
    this.byInstallation.delete(installationId);
  }

  /**
   * Create a new comment on an issue/PR. Returns the new comment id so callers
   * that want to edit it later (the in-place status checklist — see
   * `src/notify/transports/github.ts`) can hold onto a handle. Callers that
   * just post a one-off comment can ignore the return.
   */
  async postComment(owner: string, repo: string, issueNumber: number, body: string): Promise<number> {
    const kit = await this.kit(owner);
    const { data } = await kit.rest.issues.createComment({
      owner,
      repo,
      issue_number: issueNumber,
      body,
    });
    return data.id;
  }

  /**
   * Add labels to an issue/PR, leaving existing labels alone.
   *
   * The only harness-side label WRITE. Every other label mutation in the system
   * happens INSIDE the sandbox, through agentic-pi's `github_*` tools driven
   * from a prompt — which is the right place for a label whose value is an
   * agent's judgement (`dependency-trivial`, the triage vocabulary). This one
   * is different in kind: the dispatch-time escalation
   * (`../pr-escalation.ts`) fires precisely when we have decided NOT to
   * provision a sandbox, so there is no agent to ask.
   *
   * GitHub's own endpoint creates a label that does not exist yet (with an
   * arbitrary colour), so there is no `ensureLabels` companion to write.
   * Idempotent by construction — re-adding a present label is a no-op — but
   * that is NOT what makes the escalation post one comment; see
   * `../pr-escalation.ts` for the record that does.
   */
  async addLabels(
    owner: string,
    repo: string,
    issueNumber: number,
    labels: string[],
  ): Promise<void> {
    const kit = await this.kit(owner);
    if (labels.length === 0) return;
    await kit.rest.issues.addLabels({
      owner,
      repo,
      issue_number: issueNumber,
      labels,
    });
  }

  /**
   * List every repository ONE installation can access, as `owner/repo` full
   * names. Paginated — handles installs with hundreds of repos.
   *
   * Takes the installation id explicitly (rather than relying on the auth
   * strategy's bound installation, as it used to) because the App may be
   * installed on several accounts and each grant is separate.
   */
  async listInstallationRepos(installationId: string): Promise<string[]> {
    const kit = this.staticOctokit ?? this.octokitForInstallation(installationId);
    const repos = await kit.paginate(kit.rest.apps.listReposAccessibleToInstallation, {
      per_page: 100,
    });
    return repos.map((r) => r.full_name);
  }

  /**
   * The App's full repo grant, one entry per installation. Used at boot to seed
   * the managed-repo list (see `src/managed-repos.ts`), which keys its sets by
   * installation id so an install/uninstall on one account can't disturb
   * another's. Best-effort per installation: one account failing (suspended,
   * rate-limited) still yields the others.
   */
  async listAllInstallationRepos(): Promise<
    Array<{ installationId: string; account: string; repos: string[]; error?: string }>
  > {
    const directory = getInstallationDirectory();
    if (!directory) return [];
    const installations = await directory.refresh();
    const out: Array<{ installationId: string; account: string; repos: string[]; error?: string }> = [];
    for (const installation of installations) {
      try {
        out.push({
          installationId: installation.id,
          account: installation.account,
          repos: await this.listInstallationRepos(installation.id),
        });
      } catch (err: unknown) {
        out.push({
          installationId: installation.id,
          account: installation.account,
          repos: [],
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
    return out;
  }

  /**
   * The teams in `org` that `login` belongs to (issue #169).
   *
   * GraphQL rather than REST, for one reason: `Organization.teams` takes a
   * `userLogins` filter, so GitHub does the membership intersection server-side
   * and we pay one request for a person in four teams. The REST shapes
   * available to an App — enumerate every team, then a membership probe per
   * team — cost O(teams in the org), which is hundreds of requests per login in
   * exactly the orgs this feature is for.
   *
   * Requires the App's org **Members: read** permission. A missing permission
   * surfaces as a thrown GraphQL error, which the caller turns into a fail-open
   * `error` status rather than an empty (and therefore filtering) answer.
   */
  async listUserTeams(
    org: string,
    login: string,
    opts: { maxPages?: number } = {},
  ): Promise<{ teams: Array<{ slug: string; name: string | null }>; requests: number }> {
    const kit = await this.kit(org);
    const maxPages = opts.maxPages ?? 5;
    const teams: Array<{ slug: string; name: string | null }> = [];
    let after: string | null = null;
    let requests = 0;
    for (let page = 0; page < maxPages; page++) {
      const res: {
        organization: {
          teams: {
            pageInfo: { hasNextPage: boolean; endCursor: string | null };
            nodes: Array<{ slug: string; name: string | null } | null> | null;
          };
        } | null;
      } = await kit.graphql(
        `query($org: String!, $login: String!, $after: String) {
           organization(login: $org) {
             teams(first: 100, userLogins: [$login], after: $after) {
               pageInfo { hasNextPage endCursor }
               nodes { slug name }
             }
           }
         }`,
        { org, login, after },
      );
      requests++;
      // Null for a USER account (there is no organization to have teams) — the
      // cheap way to skip a personal-account owner without a separate probe.
      const connection = res.organization?.teams;
      if (!connection) break;
      for (const node of connection.nodes ?? []) {
        if (node?.slug) teams.push({ slug: node.slug, name: node.name ?? null });
      }
      if (!connection.pageInfo.hasNextPage) break;
      after = connection.pageInfo.endCursor;
      if (!after) break;
    }
    return { teams, requests };
  }

  /**
   * The repositories a team can reach, as `owner/repo` full names.
   *
   * **Bounded by construction.** A team in a large org can be granted thousands
   * of repos, so this stops at `maxPages` and reports `truncated: true` rather
   * than paging until the rate limit runs out. `isDone` is the cheap early
   * exit the caller uses to stop the moment it has seen every repo it cares
   * about (the managed set), which is the common case.
   */
  async listTeamRepos(
    org: string,
    slug: string,
    opts: { maxPages?: number; isDone?: (repos: string[]) => boolean } = {},
  ): Promise<{ repos: string[]; truncated: boolean; requests: number }> {
    const kit = await this.kit(org);
    const maxPages = opts.maxPages ?? 20;
    const repos: string[] = [];
    let after: string | null = null;
    let requests = 0;
    for (let page = 0; page < maxPages; page++) {
      const res: {
        organization: {
          team: {
            repositories: {
              pageInfo: { hasNextPage: boolean; endCursor: string | null };
              nodes: Array<{ nameWithOwner: string } | null> | null;
            };
          } | null;
        } | null;
      } = await kit.graphql(
        `query($org: String!, $slug: String!, $after: String) {
           organization(login: $org) {
             team(slug: $slug) {
               repositories(first: 100, after: $after) {
                 pageInfo { hasNextPage endCursor }
                 nodes { nameWithOwner }
               }
             }
           }
         }`,
        { org, slug, after },
      );
      requests++;
      const connection = res.organization?.team?.repositories;
      if (!connection) break;
      for (const node of connection.nodes ?? []) {
        if (node?.nameWithOwner) repos.push(node.nameWithOwner);
      }
      if (opts.isDone?.(repos)) return { repos, truncated: false, requests };
      if (!connection.pageInfo.hasNextPage) return { repos, truncated: false, requests };
      after = connection.pageInfo.endCursor;
      if (!after) return { repos, truncated: false, requests };
    }
    // Fell out of the loop with more pages waiting — the grant is partial.
    return { repos, truncated: after !== null, requests };
  }

  /** Memoized App-authed Octokit for a known installation id. */
  private octokitForInstallation(installationId: string): Octokit {
    const config = this.appConfig;
    if (!config) throw new Error("GitHubClient has no auth configured");
    const cached = this.byInstallation.get(installationId);
    if (cached) return cached;
    const kit = githubAppClient({ ...config, installationId });
    this.byInstallation.set(installationId, kit);
    return kit;
  }

  /**
   * Edit an existing issue/PR comment in place. Paired with `postComment` to
   * maintain a single status comment that updates as a workflow progresses,
   * rather than posting a new comment per phase. GitHub does NOT notify
   * watchers on edits, which is exactly why this keeps the thread quiet.
   */
  async updateComment(owner: string, repo: string, commentId: number, body: string): Promise<void> {
    const kit = await this.kit(owner);
    await kit.rest.issues.updateComment({
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
    const kit = await this.kit(owner);
    await kit.rest.issues.deleteComment({
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
    const kit = await this.kit(owner);
    await kit.rest.reactions.createForIssueComment({
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
    const kit = await this.kit(owner);
    await kit.rest.reactions.createForIssue({
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
    const kit = await this.kit(owner);
    await kit.rest.reactions.createForPullRequestReviewComment({
      owner,
      repo,
      comment_id: commentId,
      content,
    });
  }

  async getIssue(owner: string, repo: string, issueNumber: number) {
    const kit = await this.kit(owner);
    const { data } = await kit.rest.issues.get({
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
    const kit = await this.kit(owner);
    const { data } = await kit.rest.issues.get({
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
    const kit = await this.kit(owner);
    const data = await kit.paginate(
      kit.rest.issues.listComments,
      { owner, repo, issue_number: issueNumber, per_page: 100 },
    );
    return data.map((c) => ({
      user: c.user?.login || "unknown",
      body: c.body || "",
      createdAt: c.created_at,
    }));
  }

  async getPullRequest(owner: string, repo: string, pullNumber: number) {
    const kit = await this.kit(owner);
    const { data } = await kit.rest.pulls.get({
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
    const kit = await this.kit(owner);
    const prs = await kit.paginate(kit.rest.pulls.list, {
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
    const kit = await this.kit(owner);
    const { data } = await kit.rest.repos.get({ owner, repo });
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
    const kit = await this.kit(owner);
    const maxFiles = options.maxFiles ?? REPO_CONFIG_DEFAULT_MAX_FILES;
    const maxBytes = options.maxBytes ?? REPO_CONFIG_DEFAULT_MAX_BYTES;

    // The trust ref. Resolved every time — a repo can rename its default branch,
    // and caching the name would silently keep reading a stale (possibly
    // unprotected) ref.
    const { data: repoData } = await kit.rest.repos.get({ owner, repo });
    const defaultBranch = repoData.default_branch;

    // Conditional read of the branch's root tree. `If-None-Match` is only worth
    // sending when we also hold the previous tree SHA — a 304 tells us "nothing
    // changed", which we can only turn into a useful answer if we can name what
    // didn't change.
    const conditional = options.etag && options.treeSha;
    let rootTree;
    try {
      rootTree = await kit.rest.git.getTree({
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
      subtree = await kit.rest.git.getTree({
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
      const { data: blob } = await kit.rest.git.getBlob({ owner, repo, file_sha: entry.sha });
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
    const kit = await this.kit(owner);
    const { data } = await kit.rest.pulls.get({
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
   *
   * `status` defaults to `in_progress` (the historical behaviour). The other
   * two exist for the review PLACEHOLDERS: `queued` says "waiting for CI"
   * under `review.trigger: after-checks`, and `completed` + `conclusion:
   * neutral` says "available on request" under `on-request` — see
   * `reviewCheckPlacement` in ../pr-decisions.ts.
   */
  async createCheckRun(
    owner: string,
    repo: string,
    headSha: string,
    name: string,
    options: {
      status?: "queued" | "in_progress" | "completed";
      conclusion?: "success" | "failure" | "neutral" | "cancelled" | "timed_out" | "action_required" | "skipped";
      detailsUrl?: string;
      output?: { title: string; summary: string };
    } = {},
  ): Promise<number> {
    const kit = await this.kit(owner);
    const status = options.status ?? "in_progress";
    const { data } = await kit.rest.checks.create({
      owner,
      repo,
      name,
      head_sha: headSha,
      status,
      // `queued` has not started, so it must not claim a start time.
      ...(status === "queued" ? {} : { started_at: new Date().toISOString() }),
      ...(status === "completed"
        ? { conclusion: options.conclusion ?? "neutral", completed_at: new Date().toISOString() }
        : {}),
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
    const kit = await this.kit(owner);
    await kit.rest.checks.update({
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
    return (await this.getBotReviewHistory(owner, repo, pullNumber, headSha, botLogin)).atHead;
  }

  /**
   * Both facts one pass over `pulls.listReviews` can answer about OUR reviews:
   * the one on the current head (`atHead`, what {@link getLatestBotReview}
   * returns) and the most recent one at ANY head (`latest`, with the SHA it was
   * submitted against).
   *
   * `latest` is what the generated-only re-review gate keys on (issue #271):
   * "what did we last actually SAY, and what has changed since?". It has to be
   * the POSTED review rather than the last SHA we ran a review at — a run whose
   * `post-review` skipped (a stale head, an agent `skip`) said nothing, so its
   * SHA must not become the baseline a later push is diffed against, or the
   * change it never reviewed would be suppressed forever.
   *
   * One paginated call serves both, so the extra fact is free.
   */
  async getBotReviewHistory(
    owner: string,
    repo: string,
    pullNumber: number,
    headSha: string,
    botLogin = "last-light[bot]",
  ): Promise<{
    atHead: { state: string; body: string | null; submittedAt: string | null } | null;
    latest: { state: string; sha: string; body: string | null; submittedAt: string | null } | null;
  }> {
    const kit = await this.kit(owner);
    const reviews = await kit.paginate(kit.rest.pulls.listReviews, {
      owner,
      repo,
      pull_number: pullNumber,
      per_page: 100,
    });
    // Reviews are returned oldest-first; iterate newest-first to pick the most
    // recent one tied to this SHA. `commit_id` on a review is the head sha at
    // the time the review was submitted, which is exactly the discriminator
    // we want — re-pushes invalidate stale reviews here naturally.
    let atHead: { state: string; body: string | null; submittedAt: string | null } | null = null;
    let latest: { state: string; sha: string; body: string | null; submittedAt: string | null } | null = null;
    for (let i = reviews.length - 1; i >= 0; i--) {
      const r = reviews[i]!;
      if (r.user?.login !== botLogin) continue;
      if (!latest && r.commit_id) {
        latest = {
          state: r.state,
          sha: r.commit_id,
          body: r.body ?? null,
          submittedAt: r.submitted_at ?? null,
        };
      }
      if (!atHead && r.commit_id === headSha) {
        atHead = { state: r.state, body: r.body ?? null, submittedAt: r.submitted_at ?? null };
      }
      if (atHead && latest) break;
    }
    return { atHead, latest };
  }

  /**
   * The file paths that differ between two commits on this repo, or `null` when
   * the answer cannot be trusted.
   *
   * `null` — not `[]` — for every degraded case, because the one caller (the
   * generated-only re-review gate, issue #271) asks "is EVERY changed path
   * derived?" and an empty list would answer that vacuously yes and suppress a
   * review. GitHub's compare endpoint caps `files` at 300 entries, so a
   * truncated response is degraded too; a 300-file push is materially different
   * by any reading anyway.
   */
  async getChangedPathsBetween(
    owner: string,
    repo: string,
    baseSha: string,
    headSha: string,
  ): Promise<string[] | null> {
    const kit = await this.kit(owner);
    const res = await kit.rest.repos.compareCommitsWithBasehead({
      owner,
      repo,
      basehead: `${baseSha}...${headSha}`,
    });
    const files = res.data.files;
    if (!files || files.length >= 300) return null;
    return files.map((f) => f.filename);
  }

  /**
   * Fetch a PR's unified diff (three-dot, base…head) as a string. Used by the
   * `post-review` action to anchor findings to changed lines — the harness runs
   * this in-process (not in the sandbox), so the diff comes from the API rather
   * than a local `git diff`, with no dependency on checkout/fetch state.
   */
  async getPullRequestDiff(owner: string, repo: string, pullNumber: number): Promise<string> {
    const kit = await this.kit(owner);
    const res = await kit.rest.pulls.get({
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
    const kit = await this.kit(owner);
    await kit.rest.pulls.createReview({
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
    opts: ChecksQueryOptions = {},
  ): Promise<"passing" | "failing" | "pending" | "none"> {
    return (await this.getChecksSummary(owner, repo, ref, opts)).state;
  }

  /**
   * {@link getChecksConclusion} plus the COUNT of checks behind the verdict, in
   * the same two API calls.
   *
   * `settledCount` exists because "passing" alone is not evidence of anything:
   * on a repo with no CI at all, `getChecksConclusion` returns `"none"` and a
   * repo with one trivial check returns `"passing"` — and the auto-merge
   * decision needs to tell "CI approved this" from "nothing looked at it"
   * (`dependencies.minSettledChecks`; see `mayMerge` in ../pr-decisions.ts and
   * 09-state-machine.md → D10). Deriving it in the client rather than at the
   * call site keeps it to ONE round trip: recomputing the count from a second
   * `listForRef` would double the cost of every PR-state resolution.
   *
   * A check run counts as settled when it has left queued/in_progress —
   * whatever it concluded. Status contexts are settled unless the combined
   * state is `pending`.
   */
  async getChecksSummary(
    owner: string,
    repo: string,
    ref: string,
    opts: ChecksQueryOptions = {},
  ): Promise<{
    state: "passing" | "failing" | "pending" | "none";
    settledCount: number;
    pendingCount: number;
  }> {
    const kit = await this.kit(owner);
    const [{ data: checks }, { data: status }] = await Promise.all([
      kit.rest.checks.listForRef({ owner, repo, ref, filter: "latest" }),
      kit.rest.repos.getCombinedStatusForRef({ owner, repo, ref }),
    ]);
    // Drop OUR OWN check runs when the caller is deciding whether to TRIGGER
    // work — see {@link ChecksQueryOptions.excludeApp}.
    const runs = excludingApp(checks.check_runs, opts);
    const statuses = status.statuses ?? [];

    const runPendingCount = runs.filter(
      (r) => r.status === "queued" || r.status === "in_progress",
    ).length;
    const statusPending = statuses.length > 0 && status.state === "pending";
    const pendingCount = runPendingCount + (statusPending ? statuses.length : 0);
    const settledCount = runs.length - runPendingCount + (statusPending ? 0 : statuses.length);

    if (runs.length === 0 && statuses.length === 0) {
      return { state: "none", settledCount: 0, pendingCount: 0 };
    }

    if (runPendingCount > 0 || statusPending) {
      return { state: "pending", settledCount, pendingCount };
    }

    const runFailing = runs.some(
      (r) => r.conclusion === "failure" || r.conclusion === "timed_out",
    );
    const statusFailing = status.state === "failure" || status.state === "error";
    if (runFailing || statusFailing) return { state: "failing", settledCount, pendingCount };

    return { state: "passing", settledCount, pendingCount };
  }

  /**
   * The git AUTHOR NAME on a commit — not a GitHub login.
   *
   * This is the discriminator the fix state machine uses to answer "did WE push
   * this head, or did the world move?" (09-state-machine.md → S1, the attempt
   * table). It has to be the git author name because that is what
   * `git-auth.ts` stamps on the agent's own commits (`user.name = botLogin`),
   * and it is the same field `check_suite.head_commit.author.name` carries on
   * the webhook path — so the webhook and the cron agree by construction.
   *
   * Returns `""` when GitHub reports no author name, so callers get a value
   * that simply never equals `botLogin` rather than a null to branch on.
   */
  async getCommitAuthorName(owner: string, repo: string, ref: string): Promise<string> {
    const kit = await this.kit(owner);
    const { data } = await kit.rest.repos.getCommit({ owner, repo, ref });
    return data.commit?.author?.name ?? "";
  }

  /**
   * Check state of a PR's BASE branch head — a branch name is a valid `ref` for
   * the checks API, so this is {@link getChecksConclusion} pointed at the base
   * tip.
   *
   * It has its own name because the *question* is different: "is the PR at
   * fault, or was `main` already red?". A red base makes retrying the PR
   * pointless, and call sites asking that shouldn't have to know it's the same
   * query as "is this PR red".
   */
  async getBaseChecksState(
    owner: string,
    repo: string,
    baseRef: string,
    opts: ChecksQueryOptions = {},
  ): Promise<"passing" | "failing" | "pending" | "none"> {
    return this.getChecksConclusion(owner, repo, baseRef, opts);
  }

  /**
   * Structured CI failure evidence for a ref — the HEAVY counterpart to
   * {@link getChecksConclusion}: one Actions job-log download per failed check
   * run, plus the job and workflow-run metadata that says *where* it failed.
   *
   * Every Actions read here needs the App's optional `Actions: read`
   * permission. None of them is required: each degrades independently to
   * `undefined` / the annotation fallback, and the per-job + report-level
   * `logsAvailable` flags are what let the renderer say so out loud instead of
   * passing annotations off as job logs (issue #251).
   *
   * Throws if the check-run listing itself fails — a report cannot represent
   * "I couldn't look". {@link getFailedChecks} catches that for prompt callers.
   *
   * **Bounded on purpose.** `resolvePrState` awaits this synchronously on the
   * dispatch path a webhook handler takes, BEFORE any disposition is taken — so
   * it is paid in full even on dispatches that go on to skip as
   * `already-reviewed` / `on-hold` / `run-in-flight`. `checks.listForRef`
   * returns up to 30 runs, and the first cut of this method downloaded every
   * failed one's FULL log concurrently, uncapped and with no deadline: thirty
   * multi-megabyte strings resident at once, on a host with a 2 GB agent cap and
   * no swap. Hence {@link CI_LOG_FETCH_CONCURRENCY},
   * {@link CI_REPORT_DEADLINE_MS} and the byte cap inside
   * {@link extractErrorExcerpt}.
   */
  async getCiFailureReport(
    owner: string,
    repo: string,
    ref: string,
    opts: ChecksQueryOptions = {},
  ): Promise<CiFailureReport> {
    const kit = await this.kit(owner);
    const { data } = await kit.rest.checks.listForRef({
      owner,
      repo,
      ref,
      filter: "latest",
    });

    const failed = excludingApp(data.check_runs, opts).filter(
      (r) => r.conclusion === "failure" || r.conclusion === "timed_out"
    );
    if (failed.length === 0) return { jobs: [], logsAvailable: false };

    // ONE deadline for the whole report rather than one per request: what the
    // dispatch path can afford is a total wall-clock budget, and per-request
    // timeouts multiply by the number of concurrency waves. An aborted read is
    // classified `unavailable` like any other fetch failure, so a slow GitHub
    // costs us evidence, never the dispatch.
    const signal = AbortSignal.timeout(CI_REPORT_DEADLINE_MS);
    const request = { signal };

    // A failing matrix shares one workflow run, so `path` is one lookup for all
    // of its shards, not one per shard. Memoized per report, not per client —
    // a workflow file can be edited between runs.
    const workflowPaths = new Map<number, Promise<string | undefined>>();
    const workflowPathFor = (runId: number): Promise<string | undefined> => {
      let pending = workflowPaths.get(runId);
      if (!pending) {
        pending = kit.rest.actions
          .getWorkflowRun({ owner, repo, run_id: runId, request })
          .then((res) => res.data.path as string | undefined)
          .catch(() => undefined);
        workflowPaths.set(runId, pending);
      }
      return pending;
    };

    const jobs = await mapWithConcurrency(
      failed,
      CI_LOG_FETCH_CONCURRENCY,
      async (run): Promise<CiJobFailure> => {
        const jobId = actionsJobIdFromDetailsUrl(run.details_url);
        const runId = actionsRunIdFromDetailsUrl(run.details_url);

        let logExcerpt = "";
        let logsAvailable = false;
        let cause: CiLogUnavailableCause | undefined;
        let failingStep: string | undefined;
        let workflowPath: string | undefined;

        if (jobId !== null) {
          // The three Actions reads are independent — a permission denial or an
          // expired log on one must not cost us the other two. Only the LOG
          // read's failure is classified: it is the one the banner speaks about.
          const [log, job, path] = await Promise.all([
            kit.rest.actions
              .downloadJobLogsForWorkflowRun({ owner, repo, job_id: jobId, request })
              .then((res) => ({ ok: true as const, data: res.data as unknown }))
              .catch((err: unknown) => ({ ok: false as const, cause: logFetchCause(err) })),
            kit.rest.actions
              .getJobForWorkflowRun({ owner, repo, job_id: jobId, request })
              .then((res) => res.data)
              .catch(() => null),
            runId !== null ? workflowPathFor(runId) : Promise.resolve(undefined),
          ]);

          if (!log.ok) {
            cause = log.cause;
          } else {
            const text = decodeJobLog(log.data);
            // A body in a shape we don't recognise is not evidence — and it is
            // specifically the shape that used to stringify to
            // "[object ArrayBuffer]" and pass for a real log. See decodeJobLog.
            if (text === null) cause = "unavailable";
            else {
              logExcerpt = extractErrorExcerpt(text);
              // An excerpt we can't show is not evidence either: treat a blank
              // one as "no logs" so it falls through to annotations AND says so,
              // rather than claiming real logs and rendering nothing.
              if (logExcerpt.trim().length === 0) {
                logExcerpt = "";
                cause = "empty";
              }
            }
          }
          logsAvailable = logExcerpt.length > 0;

          failingStep = job?.steps?.find(
            (s) => s.conclusion === "failure" || s.conclusion === "timed_out"
          )?.name;
          workflowPath = path;
        }

        if (!logExcerpt) {
          logExcerpt = await fetchAnnotationExcerpt(kit, owner, repo, run.id);
        }

        return {
          name: run.name,
          conclusion: run.conclusion as string,
          ...(workflowPath ? { workflowPath } : {}),
          ...(failingStep ? { failingStep } : {}),
          logExcerpt,
          ...(run.details_url ? { jobUrl: run.details_url } : {}),
          logsAvailable,
          ...(cause ? { logUnavailableCause: cause } : {}),
        };
      },
    );

    const logsAvailable = jobs.some((j) => j.logsAvailable);
    const cause = logsAvailable ? undefined : dominantLogUnavailableCause(jobs);
    return { jobs, logsAvailable, ...(cause ? { logUnavailableCause: cause } : {}) };
  }

  /**
   * Get failed check runs for a PR's head SHA as the markdown blob
   * `{{ciSection}}` has always carried — a thin renderer over
   * {@link getCiFailureReport}, kept so prompt-only callers are unchanged.
   */
  async getFailedChecks(
    owner: string,
    repo: string,
    ref: string,
    opts: ChecksQueryOptions = {},
  ): Promise<string> {
    try {
      return renderCiFailureReport(await this.getCiFailureReport(owner, repo, ref, opts));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      return `Could not fetch check runs: ${message}`;
    }
  }

  // ── Feedback signals (issue #255) ────────────────────────────────────────

  /**
   * Everything the bot posted on one issue/PR that a human can react to.
   *
   * Called ONCE per finished run, not per poll: this is discovery, and the
   * recurring cost lives in {@link fetchReactions} instead. `since` is the
   * run's own start, so a long-lived PR with fifty comments only yields the few
   * this run actually wrote.
   *
   * Note the two spellings of our own login this has to survive: REST answers
   * `last-light[bot]` here, while the GraphQL `author.login` for the same
   * account answers `last-light`. The caller compares with `isSelfReactor`,
   * which strips the suffix.
   */
  async listBotComments(
    owner: string,
    repo: string,
    issueNumber: number,
    opts: { botLogin: string; isPr?: boolean; since?: string },
  ): Promise<FeedbackCandidate[]> {
    const kit = await this.kit(owner);
    const matches = (login: string | undefined) =>
      !!login && login.toLowerCase().replace(/\[bot\]$/, "") ===
        opts.botLogin.toLowerCase().replace(/\[bot\]$/, "");

    const out: FeedbackCandidate[] = [];

    const issueComments = await kit.paginate(kit.rest.issues.listComments, {
      owner,
      repo,
      issue_number: issueNumber,
      per_page: 100,
      ...(opts.since ? { since: opts.since } : {}),
    });
    for (const c of issueComments) {
      if (!matches(c.user?.login)) continue;
      out.push({
        kind: "issue_comment",
        externalId: String(c.id),
        nodeId: c.node_id,
        createdAt: c.created_at,
      });
    }

    // Inline review findings — the highest-value signal there is, because a
    // reaction lands on ONE finding rather than on a whole review. (The review
    // BODY is not reactable: GitHub exposes no reactions endpoint for a
    // pull-request review, and its UI offers no picker.)
    if (opts.isPr) {
      const reviewComments = await kit.paginate(kit.rest.pulls.listReviewComments, {
        owner,
        repo,
        pull_number: issueNumber,
        per_page: 100,
        ...(opts.since ? { since: opts.since } : {}),
      });
      for (const c of reviewComments) {
        if (!matches(c.user?.login)) continue;
        out.push({
          kind: "review_comment",
          externalId: String(c.id),
          nodeId: c.node_id,
          createdAt: c.created_at,
        });
      }
    }

    return out;
  }

  /**
   * Reactions for up to 100 artefacts in ONE request (issue #255).
   *
   * The only GraphQL call in this client, and it earns its keep: measured
   * against the live API, 100 nodes with their reactors costs **one**
   * rate-limit point, where the REST equivalent is 100 requests. That single
   * fact is what makes polling GitHub for reactions affordable at all — a
   * fixed-size working set of anchors refreshes for single-digit points a tick.
   *
   * It also returns the REACTORS, not just counts, so there is no second
   * "who was that?" round-trip: identity is what lets us dedupe, attribute and
   * notice a retraction.
   *
   * Absent nodes come back as nulls (a deleted comment) and are simply skipped
   * — the anchor ages out on its own.
   */
  async fetchReactions(owner: string, nodeIds: string[]): Promise<Map<string, ReactionRead[]>> {
    const out = new Map<string, ReactionRead[]>();
    if (nodeIds.length === 0) return out;
    const kit = await this.kit(owner);

    const query = `
      query($ids: [ID!]!) {
        nodes(ids: $ids) {
          __typename
          ... on IssueComment { id reactionGroups { content reactors(first: 50) { nodes { __typename ... on User { login } ... on Bot { login } } } } }
          ... on PullRequestReviewComment { id reactionGroups { content reactors(first: 50) { nodes { __typename ... on User { login } ... on Bot { login } } } } }
          ... on Issue { id reactionGroups { content reactors(first: 50) { nodes { __typename ... on User { login } ... on Bot { login } } } } }
        }
      }`;

    for (let i = 0; i < nodeIds.length; i += REACTION_BATCH_SIZE) {
      const batch = nodeIds.slice(i, i + REACTION_BATCH_SIZE);
      const res = await kit.graphql<{ nodes: (GraphQlReactable | null)[] }>(query, { ids: batch });
      for (const node of res.nodes ?? []) {
        if (!node?.id) continue;
        const reactions: ReactionRead[] = [];
        for (const group of node.reactionGroups ?? []) {
          for (const reactor of group.reactors?.nodes ?? []) {
            if (reactor?.login) reactions.push({ content: group.content, reactor: reactor.login });
          }
        }
        out.set(node.id, reactions);
      }
    }
    return out;
  }
}

/** GitHub's own cap on `nodes(ids:)`, and the unit our poll budget is counted in. */
export const REACTION_BATCH_SIZE = 100;

/** A bot-authored artefact a human could react to. */
export interface FeedbackCandidate {
  kind: "issue_comment" | "review_comment" | "issue";
  /** REST id, as a string — a GitHub id read back as a float would lose precision. */
  externalId: string;
  /** GraphQL global id; the key {@link GitHubClient.fetchReactions} batches on. */
  nodeId: string;
  createdAt: string;
}

/** One reaction as GraphQL reports it: SCREAMING_CASE content + who left it. */
export interface ReactionRead {
  content: string;
  reactor: string;
}

interface GraphQlReactable {
  id?: string;
  reactionGroups?: Array<{
    content: string;
    reactors?: { nodes?: Array<{ login?: string } | null> };
  }>;
}

// ---------------------------------------------------------------------------
// Module-private helpers (exported for unit tests)
// ---------------------------------------------------------------------------

/** ISO-8601 timestamp prefix that Actions prepends to every log line. */
const TIMESTAMP_RE = /^\d{4}-\d{2}-\d{2}T[\d:.]+Z\s/;

/** Lines that carry no actionable signal on their own. */
const NOISE_RE = /Process completed with exit code|##\[error\]Process completed|^##\[error\]$/i;

/**
 * Hard BYTE cap on one job's excerpt.
 *
 * `buildContextExcerpt` bounds LINES (50), and the no-anchor path bounds them
 * at 30 — neither bounds bytes, and a minified bundle, a base64 blob or a
 * single-line JSON dump is ONE line of arbitrary length. Roughly 4k tokens:
 * enough for a stack trace plus its build context, small enough that several of
 * these don't crowd out the prompt.
 *
 * Same cap, for the same reason, as agentic-pi's `excerptJobLog`
 * (`packages/agentic-pi/src/extensions/github/log-excerpt.ts`, whose header
 * explains the strategy). Duplicated rather than imported: that module is not
 * on agentic-pi's public entry (`src/index.ts`) and widening a published
 * package's API to share one constant is the wrong trade. Keep the two in step.
 */
const MAX_CI_LOG_EXCERPT_BYTES = 16_000;

/**
 * Cap on how much of a raw log we even SCAN. Beyond this we keep the TAIL —
 * the failure that stopped the job is the last one, and a long log's early
 * errors are usually retried-and-recovered noise. Without it a 100 MB log costs
 * a 100 MB `split("\n")` plus a regex per line before the excerpt cap above
 * ever gets a chance to apply.
 */
const MAX_CI_LOG_SCAN_BYTES = 512 * 1024;

/**
 * How many failed checks we resolve at once. `checks.listForRef` defaults to 30
 * runs and each resolution holds a whole job log in memory, so unbounded
 * `Promise.all` means up to 30 concurrent multi-megabyte strings — see
 * {@link GitHubClient.getCiFailureReport} for why that lands on the dispatch
 * path whether or not the dispatch goes anywhere.
 */
const CI_LOG_FETCH_CONCURRENCY = 4;

/**
 * Total wall-clock budget for every Actions read in one report. A webhook
 * handler is waiting on this, and the report is best-effort evidence: losing it
 * to a deadline costs the fix agent context, while hanging on it costs the
 * dispatch.
 */
const CI_REPORT_DEADLINE_MS = 20_000;

/**
 * `Promise.all` with a ceiling on how many run at once. Results stay in input
 * order, so the report reads in check-run order however the waves interleaved.
 */
async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Decode an Actions job-log response body into text, or `null` when it isn't
 * one we recognise.
 *
 * Octokit only hands back a `string` when the response carried a `text/*`
 * content type or a utf-8 charset; **anything else lands as an `ArrayBuffer`**
 * (`@octokit/request`'s `getResponseData`). This endpoint 302s to blob storage
 * whose content type we do not control, so that branch is reachable — and the
 * `typeof data === "string" ? data : String(data)` this replaces would have
 * turned it into the literal `"[object ArrayBuffer]"`: non-empty, so
 * `logsAvailable` went TRUE, the annotation fallback was skipped and the
 * degradation banner suppressed. That is precisely the silent degradation this
 * phase exists to kill, so an unrecognised shape is reported, not stringified.
 */
function decodeJobLog(data: unknown): string | null {
  if (typeof data === "string") return data;
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  // Buffer / Uint8Array — a view over someone else's ArrayBuffer, so the
  // offset+length matter.
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  return null;
}

/** Classify a failed job-log download — see {@link CiLogUnavailableCause}. */
function logFetchCause(err: unknown): CiLogUnavailableCause {
  const status = httpStatus(err);
  if (status === 403) return "forbidden";
  if (status === 410) return "expired";
  // 429 / 5xx / an aborted request / a network error all land here: we could
  // not fetch, and we do not know more than that.
  return "unavailable";
}

/**
 * The cause the report-level banner speaks with, in decreasing order of "what
 * should the operator do about it".
 *
 * `forbidden` leads because a 403 is App-wide — one job reporting it settles
 * the question for every job — and it is the only cause with an action attached.
 * `empty` trails because it is not a fetch failure at all.
 */
function dominantLogUnavailableCause(jobs: CiJobFailure[]): CiLogUnavailableCause | undefined {
  const order: CiLogUnavailableCause[] = ["forbidden", "expired", "unavailable", "empty"];
  return order.find((c) => jobs.some((j) => j.logUnavailableCause === c));
}

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
 * Parse the Actions *run* id out of the same `details_url`. The run — not the
 * job — is what knows the workflow file's `path`, and the URL already carries
 * it, so resolving `workflowPath` costs no extra lookup to discover the id.
 * Returns `null` for non-Actions checks or unparseable URLs.
 */
export function actionsRunIdFromDetailsUrl(url: string | null | undefined): number | null {
  if (!url) return null;
  const m = url.match(/\/actions\/runs\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/**
 * The three-line banner that fires when the report degraded to annotations —
 * one per {@link CiLogUnavailableCause}.
 *
 * This is the actual fix for issue #251's "Finding 1". The missing permission
 * was never the real damage — the damage was that its absence looked exactly
 * like normal operation, so every install that followed our own setup docs has
 * been diagnosing CI failures from truncated annotations without anyone
 * noticing. Saying so in the prompt makes the degradation legible to both the
 * agent and whoever reads the transcript.
 *
 * Which is exactly why there are four of these and not one. A banner that
 * names the wrong cause reintroduces the same failure in miniature: an operator
 * told to grant a permission they already granted stops reading, and the run
 * that produced a 410 or a rate limit goes on looking normal. Only `forbidden`
 * may mention the permission, because only a 403 is evidence of it.
 */
const LOGS_UNAVAILABLE_NOTES: Record<CiLogUnavailableCause, string> = {
  forbidden: [
    "NOTE: GitHub Actions job logs are unavailable (the App lacks `Actions: read`).",
    "The excerpts below are check-run annotations only, which are usually truncated.",
    "Grant Actions: read for full CI output.",
  ].join("\n"),
  expired: [
    "NOTE: GitHub Actions job logs are unavailable — GitHub has expired them (410 Gone; Actions keeps logs for a limited retention window).",
    "The excerpts below are check-run annotations only, which are usually truncated.",
    "This is NOT a permission problem and nothing needs granting: only a fresh CI run can produce readable logs.",
  ].join("\n"),
  unavailable: [
    "NOTE: GitHub Actions job logs could not be fetched (the request failed or timed out — e.g. a rate limit or a GitHub 5xx).",
    "The excerpts below are check-run annotations only, which are usually truncated.",
    "This is NOT a permission problem and is usually transient: a later attempt may well get them.",
  ].join("\n"),
  empty: [
    "NOTE: GitHub Actions returned an EMPTY job log for every failed check.",
    "The excerpts below are check-run annotations only, which are usually truncated.",
    "This is NOT a permission problem — the job produced no output GitHub kept.",
  ].join("\n"),
};

/**
 * Render a {@link CiFailureReport} as the markdown `{{ciSection}}` carries.
 *
 * The "No failed checks found." sentinel is load-bearing: `dispatchWorkflow`
 * tests the rendered string for `"No failed checks"` to decide whether to
 * populate `ciSection` at all.
 */
export function renderCiFailureReport(report: CiFailureReport): string {
  if (report.jobs.length === 0) return "No failed checks found.";

  const sections = report.jobs.map((job) => {
    const locators = [
      job.workflowPath ? `workflow: ${job.workflowPath}` : null,
      job.failingStep ? `failing step: ${job.failingStep}` : null,
    ].filter(Boolean);
    return [
      `### ${job.name}: ${job.conclusion}`,
      locators.length ? `(${locators.join(" — ")})` : null,
      job.logExcerpt || "No log details available.",
    ]
      .filter(Boolean)
      .join("\n");
  });

  // Only blame the permission when there was an Actions job whose logs we could
  // have read. A CircleCI-only repo has no Actions logs to be missing, and
  // telling its operator to grant `Actions: read` would be a lie.
  const hadActionsJob = report.jobs.some((j) => actionsJobIdFromDetailsUrl(j.jobUrl) !== null);
  if (report.logsAvailable || !hadActionsJob) return sections.join("\n\n");

  // No recorded cause means nobody classified the failure, so the honest banner
  // is the one that claims least — never the permission one, which is a claim
  // about a status code we would not have seen.
  const note = LOGS_UNAVAILABLE_NOTES[report.logUnavailableCause ?? "unavailable"];
  return [note, ...sections].join("\n\n");
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
 *
 * Bounded in BYTES as well as lines ({@link MAX_CI_LOG_EXCERPT_BYTES}), because
 * the line bounds below are no bound at all on a log whose failure is one
 * 8 MB minified line — and this excerpt is held on `PrState.ciReport` and
 * rendered into a prompt. The cap is applied here rather than at the call site
 * so every caller is bounded by construction.
 */
export function extractErrorExcerpt(
  fullLog: string,
  maxBytes: number = MAX_CI_LOG_EXCERPT_BYTES,
): string {
  // Scan-window first: everything below is O(log size), and the byte cap can
  // only help once we have already paid for the split.
  const rawLines = tailBytes(fullLog, MAX_CI_LOG_SCAN_BYTES).split("\n");
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

  const excerpt =
    anchorIndices.length > 0
      ? buildContextExcerpt(lines, anchorIndices)
      : // No error lines at all — return the last 30 lines as a tail
        lines.slice(-30).join("\n");

  const capped = tailBytes(excerpt, maxBytes);
  if (capped === excerpt) return excerpt;
  // Say so in-band: a silently truncated excerpt reads like a complete one, and
  // the agent would reason about a stack trace it can't see the top of.
  const shown = Buffer.byteLength(capped, "utf8");
  const total = Buffer.byteLength(excerpt, "utf8");
  return `[truncated — showing the last ${shown} of ${total} bytes of this excerpt]\n${capped}`;
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
 * Keep the last `maxBytes` bytes, then drop the leading partial line. That
 * second step also repairs the mojibake a byte-exact cut through a multi-byte
 * character would otherwise leave at the front. Cutting from the END because
 * the failure that stopped a job is the last thing in it.
 *
 * Mirrors agentic-pi's `tailBytes` (see {@link MAX_CI_LOG_EXCERPT_BYTES}).
 */
function tailBytes(text: string, maxBytes: number): string {
  const buf = Buffer.from(text, "utf8");
  if (buf.byteLength <= maxBytes) return text;
  const tail = buf.subarray(buf.byteLength - maxBytes).toString("utf8");
  const nl = tail.indexOf("\n");
  if (nl === -1) return tail;
  const whole = tail.slice(nl + 1);
  // One enormous line followed by a newline leaves nothing after the cut. A
  // ragged first line beats reporting the log as empty, which is a different
  // (and wrong) claim about why there is no evidence.
  return whole.trim().length > 0 ? whole : tail;
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

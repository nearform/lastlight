/**
 * In-process fake GitHub REST API.
 *
 * agentic-pi's built-in `github_*` tools talk to GitHub via Octokit. With the
 * `githubApiBaseUrl` seam (added to agentic-pi), we point that Octokit at this
 * server instead of api.github.com — so a REAL workflow runs unchanged while
 * every GitHub call is served from seeded fixtures and RECORDED for behavioral
 * grading.
 *
 * Only the endpoints our workflows actually hit are implemented; anything else
 * returns 404 so gaps surface loudly rather than silently passing. The server
 * binds to 127.0.0.1 on an ephemeral port.
 *
 * ONE method is not a REST route: {@link FakeGitHub.fetchRepoConfigTree}. The
 * per-repo config layer (issue #180) is read by the HARNESS, not by an agent
 * tool, through `GitHubClient.fetchRepoConfigTree` — core's own seam for exactly
 * this ("lives on the client rather than raw octokit at the call site because
 * the evals harness swaps this whole seam for fixtures"). So the fake implements
 * that method rather than the two git-tree + blob endpoints underneath it, and
 * `FakeGitHub` is structurally a `GitHubClient` for the one call
 * `fetchRepoLayer` makes. See `src/repo-config.ts` for the injection.
 */

import { createHash } from "node:crypto";
import { createServer, type ServerResponse } from "node:http";
import { type AddressInfo } from "node:net";

import type { IssueSeed, PullSeed, PullFile } from "./schema.js";

export interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
}

/** A review the workflow submitted during the run, in the shape the pr-review
 * grader consumes (decoupled from the fake's internal storage). */
export interface SubmittedReview {
  body: string;
  event: "APPROVE" | "REQUEST_CHANGES" | "COMMENT" | "PENDING";
  comments: { path: string; line?: number; side?: "LEFT" | "RIGHT"; body: string }[];
}

/**
 * One blob of a fixture `.lastlight/` tree, as a case declares it.
 *
 * `path` is relative to `.lastlight/` — exactly what GitHub's tree API returns
 * for the subtree, and what `sanitizeRepoFiles` classifies. `mode` defaults to a
 * regular file; set it explicitly (`"120000"`) to seed the symlink a case wants
 * the sanitizer to reject.
 */
export interface RepoConfigSeedFile {
  path: string;
  mode?: string;
  content: string | Buffer;
}

/** A materialized blob, in the shape core's `RepoConfigFile` declares. */
export interface RepoConfigTreeFile {
  path: string;
  mode: string;
  size: number;
  content: Buffer;
}

/** Structural mirror of core's `RepoConfigTreeOptions`. */
export interface RepoConfigTreeQuery {
  etag?: string;
  treeSha?: string;
  maxFiles?: number;
  maxBytes?: number;
  includePath?: (path: string) => boolean;
}

/** Structural mirror of core's `RepoConfigTreeResult` — the three outcomes. */
export type RepoConfigTreeAnswer =
  | { status: "absent"; defaultBranch: string }
  | { status: "not-modified"; defaultBranch: string; treeSha: string; etag?: string }
  | {
      status: "ok";
      defaultBranch: string;
      treeSha: string;
      etag?: string;
      files: RepoConfigTreeFile[];
      truncated: boolean;
    };

interface Label {
  name: string;
  color: string;
  description?: string;
}
interface Comment {
  id: number;
  user: { login: string };
  body: string;
  created_at: string;
}
interface Issue {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  user: { login: string };
  labels: Label[];
  comments: Comment[];
  created_at: string;
  updated_at: string;
  html_url: string;
}
interface InlineComment {
  id: number;
  user: { login: string };
  path: string;
  line?: number;
  /** Diff side the line anchors to (RIGHT = head, LEFT = base) — part of
   * GitHub's real review-comment shape, so the workflow posts it and the grader
   * can see which version a finding is on. */
  side?: "LEFT" | "RIGHT";
  position?: number;
  body: string;
  created_at: string;
}
interface Review {
  id: number;
  user: { login: string };
  body: string;
  state: "APPROVED" | "CHANGES_REQUESTED" | "COMMENTED" | "PENDING";
  commit_id?: string;
  submitted_at: string;
  /** Inline comments submitted with this review (non-standard on the wire, but
   * handy for grading — the GET endpoint serves them under /pulls/:n/comments). */
  comments: InlineComment[];
}
interface PullRequest {
  number: number;
  title: string;
  body: string;
  head: { ref: string; sha: string };
  base: { ref: string; sha: string };
  state: string;
  merged: boolean;
  user: { login: string };
  html_url: string;
  reviews: Review[];
  reviewComments: InlineComment[];
  /** Reviews the workflow SUBMITTED during the run (for pr-review grading). */
  submitted: Review[];
  /** Set by `PUT /pulls/:n/merge` — the merge the run actually performed. */
  mergedBy?: { method: string };
  /** Set by the `enablePullRequestAutoMerge` GraphQL mutation. */
  autoMerge?: { method: string; enabledAt: string };
}

/** How the create-review `event` maps to a review `state`. */
function eventToState(event: string | undefined): Review["state"] {
  switch (event) {
    case "APPROVE":
      return "APPROVED";
    case "REQUEST_CHANGES":
      return "CHANGES_REQUESTED";
    case "COMMENT":
      return "COMMENTED";
    default:
      return "PENDING";
  }
}

/** One failing job as the Actions endpoints should report it. */
export interface ActionsJobSeed {
  name: string;
  conclusion?: string;
  /** Full log text served by `GET /actions/jobs/:id/logs`. */
  log: string;
  workflowPath?: string;
  failingStep?: string;
}

/** The Actions fixture: one workflow run over the head SHA, with its jobs. */
export interface ActionsSeed {
  headSha: string;
  headBranch?: string;
  workflowName?: string;
  jobs: ActionsJobSeed[];
}

export interface FakeGitHub {
  url: string;
  calls: RecordedCall[];
  close: () => Promise<void>;
  /** Current labels on an issue (post-run inspection for behavioral grading). */
  labelsOn: (issueNumber: number) => string[];
  /** Comment bodies posted to an issue. */
  commentsOn: (issueNumber: number) => string[];
  issueState: (issueNumber: number) => "open" | "closed" | undefined;
  pulls: () => PullRequest[];
  /** Reviews the workflow submitted on a PR (event + body + inline comments) —
   * the pr-review grade reads these. */
  submittedReviews: (prNumber: number) => SubmittedReview[];
  /** Register the changed-file set served at `GET /pulls/:n/files`. Called after
   * the workspace is seeded (the diff isn't known at construction time). */
  setPullFiles: (prNumber: number, files: PullFile[]) => void;
  /**
   * The `GitHubClient.fetchRepoConfigTree` seam — the repo's committed
   * `.lastlight/` subtree, always "from the default branch" (there is only one
   * ref here, which is exactly the production trust rule). Serves whatever
   * {@link FakeGitHubOptions.repoConfig} declared:
   *
   *  - no fixture           → `{ status: "absent" }` (the common case, and what
   *                           every pre-existing eval instance gets);
   *  - a matching `treeSha` → `{ status: "not-modified" }`, the conditional path
   *                           a warm cache takes;
   *  - otherwise            → `{ status: "ok" }` with the blobs, after applying
   *                           the caller's `includePath` / `maxFiles` /
   *                           `maxBytes` bounds exactly as the real client does.
   *
   * The signature matches the real method, so a `FakeGitHub` can be handed
   * straight to `fetchRepoLayer({ client })` (see `src/repo-config.ts`).
   */
  fetchRepoConfigTree: (
    owner: string,
    repo: string,
    options?: RepoConfigTreeQuery,
  ) => Promise<RepoConfigTreeAnswer>;
  /** How many times {@link FakeGitHub.fetchRepoConfigTree} was called — a
   * mechanism signal (>0 proves the harness actually consulted the seam). */
  repoConfigFetches: () => number;
  /** The merge a run performed on a PR, if it merged one outright. */
  mergeOf: (prNumber: number) => { method: string } | undefined;
  /** The auto-merge a run enabled on a PR, if it took the gated route. */
  autoMergeOf: (prNumber: number) => { method: string; enabledAt: string } | undefined;
}

export interface FakeGitHubOptions {
  owner: string;
  repo: string;
  defaultBranch?: string;
  issues?: IssueSeed[];
  /**
   * GitHub Actions fixtures for the CI-read tools (`github_list_workflow_runs`
   * / `github_list_workflow_run_jobs` / `github_get_job_logs`).
   *
   * The fix workflows hand the agent a CI summary in the prompt and then invite
   * it to dig further with those tools — so a fix case whose tools 404 measures
   * an agent working around the harness. Built from the SAME `pr_state.ci_jobs`
   * seed that produced the prompt's `{{ciSection}}` (see `run-instance.ts`), so
   * what the agent reads and what it was told cannot disagree.
   */
  actions?: ActionsSeed;
  /** PRs served by the fake (pr-review tier). Each also gets a shadow issue so
   * the issue-comment / labels endpoints work on the PR number. */
  pulls?: PullSeed[];
  /** Repo labels that already exist (createLabel on these returns 422). */
  existingLabels?: string[];
  /**
   * The repo's committed `.lastlight/` tree (issue #180). Absent or empty ⇒ the
   * repo has no per-repo config layer, which is what every other eval case
   * declares and what `fetchRepoConfigTree` reports as `absent`.
   */
  repoConfig?: RepoConfigSeedFile[];
}

const NOW = "2026-01-01T00:00:00Z";

export async function startFakeGitHub(opts: FakeGitHubOptions): Promise<FakeGitHub> {
  const owner = opts.owner;
  const repo = opts.repo;
  const defaultBranch = opts.defaultBranch ?? "main";
  const calls: RecordedCall[] = [];

  const labels = new Map<string, Label>();
  for (const name of opts.existingLabels ?? []) labels.set(name, { name, color: "ededed" });

  const issues = new Map<number, Issue>();
  let commentSeq = 1000;
  for (const seed of opts.issues ?? []) {
    issues.set(seed.number, {
      number: seed.number,
      title: seed.title,
      body: seed.body,
      state: seed.state ?? "open",
      user: { login: seed.user ?? "reporter" },
      labels: (seed.labels ?? []).map((n) => labels.get(n) ?? { name: n, color: "ededed" }),
      comments: (seed.comments ?? []).map((c) => ({
        id: commentSeq++,
        user: { login: c.user },
        body: c.body,
        created_at: NOW,
      })),
      created_at: NOW,
      updated_at: NOW,
      html_url: `https://github.com/${owner}/${repo}/issues/${seed.number}`,
    });
  }

  const pulls: PullRequest[] = [];
  let pullSeq = 1;
  let reviewSeq = 5000;

  // Changed files per PR, served at GET /pulls/:n/files. Populated after seeding
  // via setPullFiles (the diff isn't known when the fake is constructed).
  const pullFiles = new Map<number, PullFile[]>();

  // Seed PRs (pr-review tier). Each PR also gets a SHADOW issue so the
  // issue-comment + labels endpoints work on the PR number (GitHub models a PR
  // as an issue), matching what the pr-review skill calls.
  for (const seed of opts.pulls ?? []) {
    pullSeq = Math.max(pullSeq, seed.number + 1);
    pulls.push({
      number: seed.number,
      title: seed.title,
      body: seed.body,
      head: { ref: seed.head_ref, sha: seed.head_commit },
      base: { ref: seed.base_ref, sha: seed.base_commit },
      state: seed.state ?? "open",
      merged: false,
      user: { login: seed.user ?? "contributor" },
      html_url: `https://github.com/${owner}/${repo}/pull/${seed.number}`,
      reviews: (seed.reviews ?? []).map((r) => ({
        id: reviewSeq++,
        user: { login: r.user },
        body: r.body,
        state: r.state ?? "COMMENTED",
        submitted_at: NOW,
        comments: [],
      })),
      reviewComments: (seed.review_comments ?? []).map((c) => ({
        id: commentSeq++,
        user: { login: c.user },
        path: c.path,
        line: c.line,
        body: c.body,
        created_at: NOW,
      })),
      submitted: [],
    });
    // Shadow issue so /issues/:n[/comments|/labels] serve the PR number.
    if (!issues.has(seed.number)) {
      issues.set(seed.number, {
        number: seed.number,
        title: seed.title,
        body: seed.body,
        state: seed.state ?? "open",
        user: { login: seed.user ?? "contributor" },
        labels: [],
        comments: (seed.issue_comments ?? []).map((c) => ({
          id: commentSeq++,
          user: { login: c.user },
          body: c.body,
          created_at: NOW,
        })),
        created_at: NOW,
        updated_at: NOW,
        html_url: `https://github.com/${owner}/${repo}/pull/${seed.number}`,
      });
    }
  }

  // ── The repo-config layer seam (issue #180) ───────────────────────────────
  // Not a REST route (see the file header): the harness reads a repo's
  // `.lastlight/` through `GitHubClient.fetchRepoConfigTree`, so that method is
  // what the fake implements — the tree/blob endpoints underneath it are the
  // real client's business, not the contract `fetchRepoLayer` depends on.
  const repoConfigFiles: RepoConfigTreeFile[] = (opts.repoConfig ?? []).map((f) => {
    const content = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, "utf8");
    return { path: f.path, mode: f.mode ?? "100644", size: content.length, content };
  });
  // Content identity standing in for git's tree SHA. The only property
  // `fetchRepoLayer`'s conditional refetch relies on is "same bytes ⇒ same sha".
  const repoConfigTreeSha = repoConfigFiles.length
    ? createHash("sha1")
        .update(
          [...repoConfigFiles]
            .sort((a, b) => a.path.localeCompare(b.path))
            .map((f) => `${f.mode} ${f.path} ${f.content.toString("base64")}`)
            .join("\n"),
        )
        .digest("hex")
    : undefined;
  const repoConfigEtag = repoConfigTreeSha ? `W/"${repoConfigTreeSha}"` : undefined;
  let repoConfigFetches = 0;

  async function fetchRepoConfigTree(
    reqOwner: string,
    reqRepo: string,
    options: RepoConfigTreeQuery = {},
  ): Promise<RepoConfigTreeAnswer> {
    repoConfigFetches++;
    // Loud, like an unimplemented REST route: being asked for a repo this fake
    // was never seeded with is a wiring bug, not "no config". `fetchRepoLayer`
    // catches it, warns and runs on the operator config, so it can't fail a run.
    if (reqOwner !== owner || reqRepo !== repo) {
      throw new Error(`fake-github: no repo-config fixture for ${reqOwner}/${reqRepo} (seeded ${owner}/${repo})`);
    }
    if (!repoConfigTreeSha) return { status: "absent", defaultBranch };
    // Both conditionals the real client offers: the root-tree ETag (which octokit
    // surfaces as a 304) and the content-exact subtree SHA.
    if ((options.etag === repoConfigEtag && options.treeSha) || options.treeSha === repoConfigTreeSha) {
      return { status: "not-modified", defaultBranch, treeSha: repoConfigTreeSha, etag: repoConfigEtag };
    }
    // The same pre-download bounds the real client applies, in the same order:
    // the path filter first (so build-handoff docs sharing `.lastlight/` never
    // eat the budget), then the file/byte caps.
    const maxFiles = options.maxFiles ?? 200;
    const maxBytes = options.maxBytes ?? 2 * 1024 * 1024;
    const files: RepoConfigTreeFile[] = [];
    let bytes = 0;
    let truncated = false;
    for (const file of repoConfigFiles) {
      if (options.includePath && !options.includePath(file.path)) continue;
      if (files.length >= maxFiles || bytes + file.size > maxBytes) {
        truncated = true;
        continue;
      }
      bytes += file.size;
      files.push(file);
    }
    return { status: "ok", defaultBranch, treeSha: repoConfigTreeSha, etag: repoConfigEtag, files, truncated };
  }

  // ── Actions fixture ───────────────────────────────────────────────────
  // Ids are synthetic but stable within a run, which is all the tools need:
  // `github_list_workflow_runs` hands the agent a run id and it asks for that
  // run's jobs, then that job's logs.
  const ACTIONS_RUN_ID = 900001;
  const actionsJobs = (opts.actions?.jobs ?? []).map((j, i) => ({
    id: 800001 + i,
    name: j.name,
    conclusion: j.conclusion ?? "failure",
    log: j.log,
    workflowPath: j.workflowPath,
    failingStep: j.failingStep,
  }));

  function serializeRun() {
    const a = opts.actions!;
    return {
      id: ACTIONS_RUN_ID,
      name: a.workflowName ?? "CI",
      head_sha: a.headSha,
      head_branch: a.headBranch ?? defaultBranch,
      path: a.jobs[0]?.workflowPath ?? ".github/workflows/ci.yml",
      event: "pull_request",
      status: "completed",
      conclusion: "failure",
      created_at: NOW,
      updated_at: NOW,
      html_url: `https://github.com/${owner}/${repo}/actions/runs/${ACTIONS_RUN_ID}`,
    };
  }

  function serializeJob(j: (typeof actionsJobs)[number]) {
    return {
      id: j.id,
      run_id: ACTIONS_RUN_ID,
      name: j.name,
      status: "completed",
      conclusion: j.conclusion,
      started_at: NOW,
      completed_at: NOW,
      html_url: `https://github.com/${owner}/${repo}/actions/runs/${ACTIONS_RUN_ID}/job/${j.id}`,
      steps: j.failingStep
        ? [{ name: j.failingStep, status: "completed", conclusion: "failure", number: 1 }]
        : [],
    };
  }

  /**
   * The PR's patch, assembled from the per-file `patch` hunks already seeded
   * for `GET /pulls/:n/files`. One fixture, two representations — a case that
   * declares its changed files gets both the file list and the diff, and they
   * cannot disagree.
   */
  function diffOf(prNumber: number): string {
    const files = pullFiles.get(prNumber) ?? [];
    return files
      .map((f) => `diff --git a/${f.filename} b/${f.filename}\n${f.patch ?? ""}`)
      .join("\n");
  }

  const repoBase = `/repos/${owner}/${repo}`;

  const server = createServer((req, res) => {
    const method = req.method ?? "GET";
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const chunks: Buffer[] = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      let body: unknown;
      if (chunks.length) {
        try {
          body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
        } catch {
          body = undefined;
        }
      }
      // Record every mutating call (the behavioral-grade signal).
      if (method !== "GET") calls.push({ method, path, body });

      const json = (status: number, payload: unknown) => {
        const text = JSON.stringify(payload);
        res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
        res.end(text);
      };

      try {
        const accept = String(req.headers.accept ?? "");
        const handled = route(method, path, body, json, accept, res);
        if (!handled) json(404, { message: `fake-github: no route for ${method} ${path}` });
      } catch (err) {
        json(500, { message: `fake-github error: ${(err as Error).message}` });
      }
    });
  });

  function route(
    method: string,
    path: string,
    body: unknown,
    json: (status: number, payload: unknown) => void,
    /** Request `Accept` — the diff media type is how `pulls.get` asks for a patch. */
    accept: string,
    res: ServerResponse,
  ): boolean {
    // ── GraphQL: the auto-merge mutation ────────────────────────────────
    //
    // `github_enable_auto_merge` has NO REST equivalent — GitHub exposes
    // `enablePullRequestAutoMerge` only through GraphQL, so a REST-only fake
    // 404s the one call the merge workflow's preferred path depends on, and the
    // agent silently falls back to a direct merge. That would make every
    // dependency-merge case measure the fallback.
    if (method === "POST" && path === "/graphql") {
      const q = String((body as { query?: string } | undefined)?.query ?? "");
      const vars = ((body as { variables?: Record<string, unknown> } | undefined)?.variables ??
        {}) as { id?: string; mergeMethod?: string };
      if (q.includes("enablePullRequestAutoMerge")) {
        // The node id the client resolved via REST is `PR_<number>` here (see
        // `serializePull`), so the mutation can find the PR the same way.
        const num = Number(String(vars.id ?? "").replace(/^PR_/, ""));
        const pr = pulls.find((p) => p.number === num);
        if (!pr) {
          json(200, { data: null, errors: [{ message: `Could not resolve to a node: ${vars.id}` }] });
          return true;
        }
        const method_ = String(vars.mergeMethod ?? "SQUASH").toLowerCase();
        pr.autoMerge = { method: method_, enabledAt: NOW };
        json(200, {
          data: {
            enablePullRequestAutoMerge: {
              pullRequest: { number: pr.number, autoMergeRequest: { enabledAt: NOW } },
            },
          },
        });
        return true;
      }
      json(200, { data: null, errors: [{ message: `fake-github: unsupported GraphQL operation` }] });
      return true;
    }

    // ── Actions (CI reads) ──────────────────────────────────────────────
    //
    // Served from the `actions` fixture, which is built from the same seed as
    // the prompt's CI summary — so `github_get_job_logs` corroborates
    // `{{ciSection}}` instead of contradicting it. With NO fixture these stay
    // 404, which is the loud default the rest of this file keeps.
    if (opts.actions && method === "GET" && path.startsWith(`${repoBase}/actions/`)) {
      const rest = path.slice(`${repoBase}/actions/`.length);
      if (rest === "runs" || /^workflows\/[^/]+\/runs$/.test(rest)) {
        json(200, { total_count: 1, workflow_runs: [serializeRun()] });
        return true;
      }
      const jobsOf = /^runs\/(\d+)\/jobs$/.exec(rest);
      if (jobsOf) {
        json(200, { total_count: actionsJobs.length, jobs: actionsJobs.map(serializeJob) });
        return true;
      }
      const logsOf = /^jobs\/(\d+)\/logs$/.exec(rest);
      if (logsOf) {
        const job = actionsJobs.find((j) => j.id === Number(logsOf[1]));
        if (!job) return false;
        // Real GitHub 302s to a signed blob URL and octokit follows it; a direct
        // 200 with the text is the same thing to the caller.
        res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
        res.end(job.log);
        return true;
      }
      return false;
    }

    // GET /repos/:owner/:repo
    if (method === "GET" && path === repoBase) {
      json(200, {
        full_name: `${owner}/${repo}`,
        name: repo,
        owner: { login: owner },
        default_branch: defaultBranch,
      });
      return true;
    }

    // Issues collection
    if (path === `${repoBase}/issues`) {
      if (method === "GET") {
        json(200, [...issues.values()].map(serializeIssue));
        return true;
      }
    }

    // Repo labels
    if (path === `${repoBase}/labels`) {
      if (method === "GET") {
        json(200, [...labels.values()]);
        return true;
      }
      if (method === "POST") {
        const b = body as { name: string; color?: string; description?: string };
        if (labels.has(b.name)) {
          json(422, { message: "Validation Failed: label already exists" });
          return true;
        }
        const label = { name: b.name, color: b.color ?? "ededed", description: b.description };
        labels.set(b.name, label);
        json(201, label);
        return true;
      }
    }

    // Search (dedup checks) — return no matches.
    if (method === "GET" && (path === "/search/issues" || path === "/search/repositories" || path === "/search/code")) {
      json(200, { total_count: 0, incomplete_results: false, items: [] });
      return true;
    }

    // Per-issue routes: /repos/:owner/:repo/issues/:n[/comments|/labels[/:name]]
    const issueMatch = path.match(new RegExp(`^${escapeRe(repoBase)}/issues/(\\d+)(/comments|/labels(?:/(.+))?)?$`));
    if (issueMatch) {
      const num = Number(issueMatch[1]);
      const sub = issueMatch[2];
      const labelName = issueMatch[3] ? decodeURIComponent(issueMatch[3]) : undefined;
      const issue = issues.get(num);
      if (!issue) {
        json(404, { message: `issue ${num} not found` });
        return true;
      }

      // /issues/:n
      if (!sub) {
        if (method === "GET") {
          json(200, serializeIssue(issue));
          return true;
        }
        if (method === "PATCH") {
          const b = (body ?? {}) as Partial<{ state: "open" | "closed"; title: string; body: string }>;
          if (b.state) issue.state = b.state;
          if (typeof b.title === "string") issue.title = b.title;
          if (typeof b.body === "string") issue.body = b.body;
          issue.updated_at = NOW;
          json(200, serializeIssue(issue));
          return true;
        }
      }

      // /issues/:n/comments
      if (sub === "/comments") {
        if (method === "GET") {
          json(200, issue.comments);
          return true;
        }
        if (method === "POST") {
          const b = body as { body: string };
          const comment: Comment = { id: commentSeq++, user: { login: "last-light[bot]" }, body: b.body, created_at: NOW };
          issue.comments.push(comment);
          json(201, comment);
          return true;
        }
      }

      // /issues/:n/labels  and  /issues/:n/labels/:name
      if (sub && sub.startsWith("/labels")) {
        if (method === "POST") {
          const b = body as { labels?: string[] };
          for (const name of b.labels ?? []) {
            const label = labels.get(name) ?? { name, color: "ededed" };
            labels.set(name, label);
            if (!issue.labels.find((l) => l.name === name)) issue.labels.push(label);
          }
          json(200, issue.labels);
          return true;
        }
        if (method === "GET") {
          json(200, issue.labels);
          return true;
        }
        if (method === "DELETE" && labelName) {
          issue.labels = issue.labels.filter((l) => l.name !== labelName);
          json(200, issue.labels);
          return true;
        }
      }
    }

    // Pulls collection: /repos/:owner/:repo/pulls
    if (path === `${repoBase}/pulls`) {
      if (method === "GET") {
        json(200, pulls.map(serializePull));
        return true;
      }
      if (method === "POST") {
        const b = body as { title: string; body?: string; head: string; base: string };
        const num = pullSeq++;
        const pr: PullRequest = {
          number: num,
          title: b.title,
          body: b.body ?? "",
          head: { ref: stripOwnerPrefix(b.head, owner), sha: "0".repeat(40) },
          base: { ref: b.base, sha: "0".repeat(40) },
          state: "open",
          merged: false,
          user: { login: "last-light[bot]" },
          html_url: `https://github.com/${owner}/${repo}/pull/${num}`,
          reviews: [],
          reviewComments: [],
          submitted: [],
        };
        pulls.push(pr);
        json(201, serializePull(pr));
        return true;
      }
    }

    // Per-PR routes: /repos/:owner/:repo/pulls/:n[/reviews|/comments|/files|/merge]
    const pullMatch = path.match(new RegExp(`^${escapeRe(repoBase)}/pulls/(\\d+)(/reviews|/comments|/files|/merge)?$`));
    if (pullMatch) {
      const num = Number(pullMatch[1]);
      const sub = pullMatch[2];
      const pr = pulls.find((p) => p.number === num);
      if (!pr) {
        json(404, { message: `pull ${num} not found` });
        return true;
      }

      // /pulls/:n — JSON, or the raw patch when the caller asked for the diff
      // media type. `github_get_pull_request_diff` is `pulls.get` with
      // `mediaType: { format: "diff" }`, so serving JSON to it would hand the
      // agent an object where it expects a patch — the impact assessment then
      // reasons about the wrong artifact entirely.
      if (!sub && method === "GET") {
        if (/vnd\.github(\.[^+\s]*)?\.diff/.test(accept) || /vnd\.github\.v3\.diff/.test(accept)) {
          // `charset=utf-8` is load-bearing: octokit decodes a response body as
          // TEXT only for `application/json`, `text/*` or a `charset=utf-8`
          // content-type, and hands anything else back as an ArrayBuffer.
          res.writeHead(200, { "content-type": "application/vnd.github.v3.diff; charset=utf-8" });
          res.end(diffOf(pr.number));
          return true;
        }
        json(200, serializePull(pr));
        return true;
      }

      // /pulls/:n/merge — the direct merge (`github_merge_pull_request`).
      if (sub === "/merge" && method === "PUT") {
        const b = (body ?? {}) as { merge_method?: string };
        if (pr.merged) {
          json(405, { message: "Pull Request is not mergeable" });
          return true;
        }
        pr.merged = true;
        pr.state = "closed";
        pr.mergedBy = { method: b.merge_method ?? "merge" };
        json(200, { sha: pr.head.sha, merged: true, message: "Pull Request successfully merged" });
        return true;
      }

      // /pulls/:n/reviews — list existing, or SUBMIT one (create_pull_request_review).
      if (sub === "/reviews") {
        if (method === "GET") {
          json(200, pr.reviews.map(serializeReview));
          return true;
        }
        if (method === "POST") {
          const b = (body ?? {}) as {
            body?: string;
            event?: string;
            commit_id?: string;
            comments?: { path: string; line?: number; side?: "LEFT" | "RIGHT"; position?: number; body: string }[];
          };
          const review: Review = {
            id: reviewSeq++,
            user: { login: "last-light[bot]" },
            body: b.body ?? "",
            state: eventToState(b.event),
            commit_id: b.commit_id ?? pr.head.sha,
            submitted_at: NOW,
            comments: (b.comments ?? []).map((c) => ({
              id: commentSeq++,
              user: { login: "last-light[bot]" },
              path: c.path,
              line: c.line,
              side: c.side,
              position: c.position,
              body: c.body,
              created_at: NOW,
            })),
          };
          pr.reviews.push(review);
          pr.submitted.push(review);
          pr.reviewComments.push(...review.comments);
          json(200, serializeReview(review));
          return true;
        }
      }

      // /pulls/:n/comments — inline review comments.
      if (sub === "/comments" && method === "GET") {
        json(200, pr.reviewComments);
        return true;
      }

      // /pulls/:n/files — the PR's changed files (computed from the seeded
      // workspace's git diff; empty until setPullFiles is called). Pagination
      // query params are ignored — the full set is returned in one page.
      if (sub === "/files" && method === "GET") {
        json(200, pullFiles.get(num) ?? []);
        return true;
      }
    }

    return false;
  }

  function serializePull(pr: PullRequest) {
    return {
      number: pr.number,
      // The GraphQL node id `enablePullRequestAutoMerge` is given. The real one
      // is opaque; the client only ever round-trips it from here to the
      // mutation, so a derivable form keeps the fake stateless about it.
      node_id: `PR_${pr.number}`,
      title: pr.title,
      body: pr.body,
      state: pr.state,
      merged: pr.merged,
      auto_merge: pr.autoMerge ? { enabled_by: { login: "last-light[bot]" }, merge_method: pr.autoMerge.method } : null,
      head: pr.head,
      base: pr.base,
      user: pr.user,
      draft: false,
      html_url: pr.html_url,
    };
  }

  function serializeReview(r: Review) {
    return {
      id: r.id,
      user: r.user,
      body: r.body,
      state: r.state,
      commit_id: r.commit_id,
      submitted_at: r.submitted_at,
    };
  }

  function serializeIssue(issue: Issue) {
    return {
      number: issue.number,
      title: issue.title,
      body: issue.body,
      state: issue.state,
      user: issue.user,
      labels: issue.labels,
      comments: issue.comments.length,
      created_at: issue.created_at,
      updated_at: issue.updated_at,
      html_url: issue.html_url,
      pull_request: undefined,
    };
  }

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${port}`,
    calls,
    close: () => new Promise<void>((r) => server.close(() => r())),
    labelsOn: (n) => (issues.get(n)?.labels ?? []).map((l) => l.name),
    commentsOn: (n) => (issues.get(n)?.comments ?? []).map((c) => c.body),
    issueState: (n) => issues.get(n)?.state,
    pulls: () => pulls,
    submittedReviews: (n) =>
      (pulls.find((p) => p.number === n)?.submitted ?? []).map((r) => ({
        body: r.body,
        event: stateToEvent(r.state),
        comments: r.comments.map((c) => ({ path: c.path, line: c.line, side: c.side, body: c.body })),
      })),
    setPullFiles: (n, files) => pullFiles.set(n, files),
    fetchRepoConfigTree,
    repoConfigFetches: () => repoConfigFetches,
    mergeOf: (n) => pulls.find((p) => p.number === n)?.mergedBy,
    autoMergeOf: (n) => pulls.find((p) => p.number === n)?.autoMerge,
  };
}

/** Inverse of {@link eventToState} — the grader reports the review's event. */
function stateToEvent(state: Review["state"]): SubmittedReview["event"] {
  switch (state) {
    case "APPROVED":
      return "APPROVE";
    case "CHANGES_REQUESTED":
      return "REQUEST_CHANGES";
    case "COMMENTED":
      return "COMMENT";
    default:
      return "PENDING";
  }
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** GitHub PR `head` can be "owner:branch" for cross-repo; strip the owner. */
function stripOwnerPrefix(head: string, owner: string): string {
  return head.startsWith(`${owner}:`) ? head.slice(owner.length + 1) : head;
}

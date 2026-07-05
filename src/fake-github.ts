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
 */

import { createServer } from "node:http";
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
}

export interface FakeGitHubOptions {
  owner: string;
  repo: string;
  defaultBranch?: string;
  issues?: IssueSeed[];
  /** PRs served by the fake (pr-review tier). Each also gets a shadow issue so
   * the issue-comment / labels endpoints work on the PR number. */
  pulls?: PullSeed[];
  /** Repo labels that already exist (createLabel on these returns 422). */
  existingLabels?: string[];
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
        const handled = route(method, path, body, json);
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
  ): boolean {
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

    // Per-PR routes: /repos/:owner/:repo/pulls/:n[/reviews|/comments|/files]
    const pullMatch = path.match(new RegExp(`^${escapeRe(repoBase)}/pulls/(\\d+)(/reviews|/comments|/files)?$`));
    if (pullMatch) {
      const num = Number(pullMatch[1]);
      const sub = pullMatch[2];
      const pr = pulls.find((p) => p.number === num);
      if (!pr) {
        json(404, { message: `pull ${num} not found` });
        return true;
      }

      // /pulls/:n
      if (!sub && method === "GET") {
        json(200, serializePull(pr));
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
      title: pr.title,
      body: pr.body,
      state: pr.state,
      merged: pr.merged,
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

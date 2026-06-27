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

import type { IssueSeed } from "./schema.js";

export interface RecordedCall {
  method: string;
  path: string;
  body?: unknown;
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
interface PullRequest {
  number: number;
  title: string;
  body: string;
  head: { ref: string };
  base: { ref: string };
  state: string;
  html_url: string;
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
}

export interface FakeGitHubOptions {
  owner: string;
  repo: string;
  defaultBranch?: string;
  issues?: IssueSeed[];
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
        json(200, pulls);
        return true;
      }
      if (method === "POST") {
        const b = body as { title: string; body?: string; head: string; base: string };
        const pr: PullRequest = {
          number: pullSeq++,
          title: b.title,
          body: b.body ?? "",
          head: { ref: stripOwnerPrefix(b.head, owner) },
          base: { ref: b.base },
          state: "open",
          html_url: `https://github.com/${owner}/${repo}/pull/${pullSeq - 1}`,
        };
        pulls.push(pr);
        json(201, pr);
        return true;
      }
    }

    return false;
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
  };
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** GitHub PR `head` can be "owner:branch" for cross-repo; strip the owner. */
function stripOwnerPrefix(head: string, owner: string): string {
  return head.startsWith(`${owner}:`) ? head.slice(owner.length + 1) : head;
}

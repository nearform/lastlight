/**
 * Read-only GitHub tools registered with pi-ai for the in-process Slack
 * chat path. Severely scoped: the chat agent can look up issues / PRs /
 * comments / repo files / commits / search, and nothing else. There are
 * no write operations on this surface — issue creation, labels, branches,
 * commits, merges all live in the workflow path under sandbox isolation.
 *
 * Returned value is a `{ tools, execute }` pair. `tools` plugs into
 * pi-ai's `Context.tools`; `execute(toolCall)` is what the chat-runner
 * loop calls when the model emits a tool_call.
 */
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Octokit } from "octokit";
import { createAppAuth } from "@octokit/auth-app";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { Tool, ToolCall } from "@earendil-works/pi-ai";

export interface ChatGitHubAuth {
  appId: string;
  privateKeyPath: string;
  installationId: string;
}

export interface ChatGitHubToolset {
  tools: Tool[];
  execute(call: ToolCall): Promise<{ content: string; isError: boolean }>;
}

interface ToolEntry {
  name: string;
  description: string;
  parameters: TSchema;
  handler: (params: any) => Promise<unknown>;
}

function tool<P extends TSchema>(
  name: string,
  description: string,
  parameters: P,
  handler: (params: Static<P>) => Promise<unknown>,
): ToolEntry {
  return {
    name,
    description,
    parameters,
    handler: handler as (p: any) => Promise<unknown>,
  };
}

function makeOctokit(auth: ChatGitHubAuth): Octokit {
  const privateKey = readFileSync(resolve(auth.privateKeyPath), "utf-8");
  return new Octokit({
    authStrategy: createAppAuth,
    auth: {
      appId: auth.appId,
      privateKey,
      installationId: auth.installationId,
    },
  });
}

export function buildChatGitHubTools(auth: ChatGitHubAuth): ChatGitHubToolset {
  const octokit = makeOctokit(auth);

  const entries: ToolEntry[] = [
    tool(
      "github_get_repository",
      "Get a repository's metadata (default branch, description, topics).",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
      }),
      async ({ owner, repo }) => {
        const { data } = await octokit.rest.repos.get({ owner, repo });
        return {
          full_name: data.full_name,
          default_branch: data.default_branch,
          description: data.description,
          topics: data.topics ?? [],
          private: data.private,
          open_issues_count: data.open_issues_count,
        };
      },
    ),

    tool(
      "github_get_issue",
      "Get a single issue by number.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        issue_number: Type.Number(),
      }),
      async ({ owner, repo, issue_number }) => {
        const { data } = await octokit.rest.issues.get({ owner, repo, issue_number });
        return {
          number: data.number,
          title: data.title,
          state: data.state,
          body: data.body,
          labels: (data.labels || []).map((l: any) => (typeof l === "string" ? l : l.name)),
          html_url: data.html_url,
          author: data.user?.login,
          created_at: data.created_at,
          updated_at: data.updated_at,
        };
      },
    ),

    tool(
      "github_list_issue_comments",
      "List comments on an issue or PR.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        issue_number: Type.Number(),
        per_page: Type.Optional(Type.Number()),
      }),
      async ({ owner, repo, issue_number, per_page }) => {
        const { data } = await octokit.rest.issues.listComments({
          owner,
          repo,
          issue_number,
          per_page: per_page ?? 30,
        });
        return data.map((c) => ({
          id: c.id,
          author: c.user?.login,
          body: c.body,
          created_at: c.created_at,
        }));
      },
    ),

    tool(
      "github_list_issues",
      "List issues on a repository.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        state: Type.Optional(
          Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")]),
        ),
        labels: Type.Optional(Type.String({ description: "Comma-separated label names." })),
        per_page: Type.Optional(Type.Number()),
      }),
      async ({ owner, repo, state, labels, per_page }) => {
        const { data } = await octokit.rest.issues.listForRepo({
          owner,
          repo,
          state: state ?? "open",
          labels,
          per_page: per_page ?? 30,
        });
        return data
          .filter((i) => !i.pull_request)
          .map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            labels: (i.labels || []).map((l: any) => (typeof l === "string" ? l : l.name)),
            author: i.user?.login,
            updated_at: i.updated_at,
          }));
      },
    ),

    tool(
      "github_get_pull_request",
      "Get a single pull request by number.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        pull_number: Type.Number(),
      }),
      async ({ owner, repo, pull_number }) => {
        const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number });
        return {
          number: data.number,
          title: data.title,
          state: data.state,
          body: data.body,
          head: data.head.ref,
          base: data.base.ref,
          mergeable: data.mergeable,
          draft: data.draft,
          html_url: data.html_url,
          author: data.user?.login,
        };
      },
    ),

    tool(
      "github_get_pull_request_diff",
      "Get the unified diff of a pull request.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        pull_number: Type.Number(),
      }),
      async ({ owner, repo, pull_number }) => {
        const { data } = await octokit.rest.pulls.get({
          owner,
          repo,
          pull_number,
          mediaType: { format: "diff" },
        });
        return { diff: data as unknown as string };
      },
    ),

    tool(
      "github_list_pull_requests",
      "List pull requests on a repository.",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        state: Type.Optional(
          Type.Union([Type.Literal("open"), Type.Literal("closed"), Type.Literal("all")]),
        ),
        per_page: Type.Optional(Type.Number()),
      }),
      async ({ owner, repo, state, per_page }) => {
        const { data } = await octokit.rest.pulls.list({
          owner,
          repo,
          state: state ?? "open",
          per_page: per_page ?? 30,
        });
        return data.map((p) => ({
          number: p.number,
          title: p.title,
          state: p.state,
          draft: p.draft,
          head: p.head.ref,
          base: p.base.ref,
          author: p.user?.login,
          updated_at: p.updated_at,
        }));
      },
    ),

    tool(
      "github_get_file_contents",
      "Read a file from a repository at the given ref (default: default branch).",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        path: Type.String(),
        ref: Type.Optional(Type.String()),
      }),
      async ({ owner, repo, path, ref }) => {
        const { data } = await octokit.rest.repos.getContent({ owner, repo, path, ref });
        if (Array.isArray(data)) {
          return data.map((d) => ({ name: d.name, type: d.type, size: d.size, path: d.path }));
        }
        if ("content" in data && data.content) {
          const text = Buffer.from(data.content, "base64").toString("utf-8");
          return { path: data.path, size: data.size, encoding: "utf-8", content: text };
        }
        return data;
      },
    ),

    tool(
      "github_list_commits",
      "List commits on a repository (optionally limited to a branch or path).",
      Type.Object({
        owner: Type.String(),
        repo: Type.String(),
        sha: Type.Optional(Type.String({ description: "Branch / commit SHA to start from." })),
        path: Type.Optional(Type.String()),
        per_page: Type.Optional(Type.Number()),
      }),
      async ({ owner, repo, sha, path, per_page }) => {
        const { data } = await octokit.rest.repos.listCommits({
          owner,
          repo,
          sha,
          path,
          per_page: per_page ?? 20,
        });
        return data.map((c) => ({
          sha: c.sha,
          message: c.commit.message,
          author: c.commit.author?.name,
          date: c.commit.author?.date,
          html_url: c.html_url,
        }));
      },
    ),

    tool(
      "github_search_issues",
      "Search across issues and pull requests with GitHub's search syntax.",
      Type.Object({
        q: Type.String({ description: "Search query, e.g. 'repo:owner/name is:open label:bug'." }),
        per_page: Type.Optional(Type.Number()),
      }),
      async ({ q, per_page }) => {
        const { data } = await octokit.rest.search.issuesAndPullRequests({
          q,
          per_page: per_page ?? 20,
        });
        return {
          total_count: data.total_count,
          items: data.items.map((i) => ({
            number: i.number,
            title: i.title,
            state: i.state,
            html_url: i.html_url,
            repository_url: i.repository_url,
          })),
        };
      },
    ),

    tool(
      "github_search_code",
      "Search code using GitHub's code search.",
      Type.Object({
        q: Type.String({ description: "Code search query, e.g. 'memorystore in:file repo:owner/name'." }),
        per_page: Type.Optional(Type.Number()),
      }),
      async ({ q, per_page }) => {
        const { data } = await octokit.rest.search.code({ q, per_page: per_page ?? 20 });
        return {
          total_count: data.total_count,
          items: data.items.map((i) => ({
            path: i.path,
            repository: i.repository.full_name,
            html_url: i.html_url,
          })),
        };
      },
    ),
  ];

  const byName = new Map(entries.map((e) => [e.name, e]));

  const tools: Tool[] = entries.map((e) => ({
    name: e.name,
    description: e.description,
    parameters: e.parameters,
  }));

  return {
    tools,
    async execute(call) {
      const entry = byName.get(call.name);
      if (!entry) {
        return {
          content: JSON.stringify({ error: `unknown tool: ${call.name}` }),
          isError: true,
        };
      }
      try {
        const result = await entry.handler(call.arguments);
        return { content: JSON.stringify(result, null, 2), isError: false };
      } catch (err) {
        const e = err as { message?: string; status?: number };
        return {
          content: JSON.stringify({
            error: e.message ?? String(err),
            status: e.status,
          }),
          isError: true,
        };
      }
    },
  };
}

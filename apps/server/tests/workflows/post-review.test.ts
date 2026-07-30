import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { AddressInfo } from "node:net";

// phase-executor imports these at module load; stub them (runPostReview itself
// touches none of them).
vi.mock("#src/engine/agent-executor.js", () => ({
  executeAgent: vi.fn(),
  executeCommand: vi.fn(),
}));
vi.mock("#src/admin/docker.js", () => ({ listRunningContainers: vi.fn(async () => []) }));
vi.mock("#src/workflows/loader.js", () => ({
  loadPromptTemplate: vi.fn(() => ""),
  resolveSkillPaths: vi.fn(() => undefined),
}));

import { GitHubPostReviewHandler, type PostReviewRunScope } from "#src/workflows/handlers/post-review.js";
import type { PhaseReporter } from "lastlight-workflow-engine";
import type { TemplateContext } from "#src/workflows/templates.js";
import type { AgentWorkflowDefinition, PhaseDefinition } from "#src/workflows/schema.js";
import type { DagNode } from "#src/workflows/dag.js";

/**
 * Integration test for the first-class `post-review` action
 * (`PhaseExecutor.runPostReview`) — the regression for the "workflow ran but
 * posted nothing" bug. Mirrors the evals mock: a tiny HTTP server that records
 * every `POST /pulls/:n/reviews`, so we prove a review lands from findings that
 * carry NO pr_number/base_ref/head_sha (the harness supplies them).
 */

interface RecordedReview {
  owner: string;
  repo: string;
  pr: string;
  body: unknown;
}

// The GitHub-API fallback (#2) fetches these when there's no local checkout
// (k8s). PR_DIFF is a minimal unified diff where src/foo.ts gains a line at
// new-line 10 — parseDiff yields RIGHT:10, so a finding at that line anchors
// inline instead of being demoted to the body.
const HEAD_SHA = "abc1234def5678901234567890abcdef12345678";
const PR_DIFF = [
  "diff --git a/src/foo.ts b/src/foo.ts",
  "index 1111111..2222222 100644",
  "--- a/src/foo.ts",
  "+++ b/src/foo.ts",
  "@@ -7,3 +7,4 @@",
  " line7",
  " line8",
  " line9",
  "+line10-added",
  "",
].join("\n");

function startMock(): { server: Server; url: string; reviews: RecordedReview[] } {
  const reviews: RecordedReview[] = [];
  const server = createServer((req, res) => {
    const m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/([^/]+)\/reviews$/.exec(req.url || "");
    if (req.method === "POST" && m) {
      let raw = "";
      req.on("data", (c) => (raw += c));
      req.on("end", () => {
        reviews.push({ owner: m[1]!, repo: m[2]!, pr: m[3]!, body: raw ? JSON.parse(raw) : {} });
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ id: 1, state: "COMMENTED" }));
      });
      return;
    }
    // getLatestBotReview lists reviews — return empty so we never short-circuit.
    if (req.method === "GET" && m) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("[]");
      return;
    }
    // pulls.get — the GitHub-API fallback for head SHA (JSON) or the PR diff
    // (Accept: application/vnd.github.diff). Used when there's no local checkout.
    const pm = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/([^/]+)$/.exec(req.url || "");
    if (req.method === "GET" && pm) {
      if (String(req.headers.accept || "").includes("diff")) {
        // charset=utf-8 so Octokit parses the body as text (a string), matching
        // real GitHub — without it Octokit returns an ArrayBuffer.
        res.writeHead(200, { "content-type": "application/vnd.github.diff; charset=utf-8" });
        res.end(PR_DIFF);
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ number: Number(pm[3]), head: { sha: HEAD_SHA } }));
      return;
    }
    res.writeHead(404).end("{}");
  });
  return { server, url: "", reviews };
}

function makeReporter() {
  const failed: string[] = [];
  const doneSteps: { key: string; status: string }[] = [];
  const reporter: PhaseReporter = {
    onStart: vi.fn(async () => {}),
    onEnd: vi.fn(async () => {}),
    step: vi.fn(async (key, status) => { doneSteps.push({ key, status }); }),
    message: vi.fn(async () => {}),
    approvalNote: vi.fn(async () => {}),
    postNote: vi.fn(async () => {}),
    persistPhase: vi.fn(() => {}),
    failWorkflow: vi.fn((e?: string) => { failed.push(e ?? ""); }),
    footer: vi.fn(async () => {}),
    noteTerminal: vi.fn(async () => {}),
  };
  return { reporter, failed, doneSteps };
}

const DEFINITION = {
  name: "pr-review",
  kind: "review",
  phases: [{ name: "post-review", type: "post-review" }],
} as unknown as AgentWorkflowDefinition;

const PHASE = DEFINITION.phases[0] as PhaseDefinition;
const NODE: DagNode = { name: "post-review", status: "pending", depends_on: [] } as unknown as DagNode;

describe("post-review action (runPostReview)", () => {
  let server: Server;
  let baseUrl: string;
  let reviews: RecordedReview[];
  let stateDir: string;
  let savedToken: string | undefined;

  beforeEach(async () => {
    const mock = startMock();
    server = mock.server;
    reviews = mock.reviews;
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    stateDir = mkdtempSync(join(tmpdir(), "post-review-"));
    savedToken = process.env.GITHUB_TOKEN;
    process.env.GITHUB_TOKEN = "test-token";
  });

  afterEach(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    rmSync(stateDir, { recursive: true, force: true });
    if (savedToken === undefined) delete process.env.GITHUB_TOKEN;
    else process.env.GITHUB_TOKEN = savedToken;
  });

  function seedFindings(taskId: string, repo: string, doc: unknown | null): void {
    const dir = join(stateDir, "sandboxes", taskId, repo, ".lastlight", "pr-review");
    if (doc === null) return; // simulate a missing file
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "findings.json"), JSON.stringify(doc));
  }

  function makeExecutor(taskId: string, ctxOverrides: Partial<TemplateContext> = {}) {
    const ctx: TemplateContext = {
      owner: "acme",
      repo: "widget",
      issueNumber: 42, // = PR number for a PR event
      issueTitle: "",
      issueBody: "",
      issueLabels: [],
      commentBody: "",
      sender: "cli",
      branch: "b",
      taskId,
      issueDir: ".lastlight/issue-42",
      bootstrapLabel: "x",
      ...ctxOverrides,
    };
    const run: PostReviewRunScope = {
      ctx,
      config: { githubApiBaseUrl: baseUrl, sandboxDir: join(stateDir, "sandboxes"), stateDir } as unknown as PostReviewRunScope["config"],
      taskId,
    };
    const rep = makeReporter();
    const handler = new GitHubPostReviewHandler(run, rep.reporter);
    // Wrap so existing call sites keep using `executor.execute(NODE, {})` — the
    // handler's execute takes the phase, which is constant for this suite.
    return { executor: { execute: (node: DagNode, outputs: Record<string, unknown>) => handler.execute(PHASE, node, outputs) }, rep };
  }

  it("posts a review from content-only findings (no pr_number/base_ref/head_sha)", async () => {
    const taskId = "widget-42-pr-review";
    seedFindings(taskId, "widget", {
      summary: "Looks good.",
      event: "APPROVE",
      findings: [],
    });
    const { executor, rep } = makeExecutor(taskId);
    const outcome = await executor.execute(NODE, {});
    expect(outcome.status).toBe("succeeded");
    expect(rep.failed).toHaveLength(0);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.pr).toBe("42");
    const body = reviews[0]!.body as { event: string; body: string };
    expect(body.event).toBe("APPROVE");
    expect(body.body).toContain("Looks good.");
  });

  it("posts from prNumber alone when issueNumber is absent (real PR webhook ctx)", async () => {
    // A `pr.opened`/`synchronize`/`reopened` webhook routes with only prNumber
    // (router drops the issue mirror), so simple.ts builds a ctx with
    // issueNumber: 0 + prNumber set. Regression for a real PR review that
    // computed findings but failed post-review with "no PR number in run
    // context" because the ctx never carried the PR number.
    const taskId = "widget-42-pronly";
    seedFindings(taskId, "widget", { summary: "Looks good.", event: "APPROVE", findings: [] });
    const { executor, rep } = makeExecutor(taskId, { issueNumber: 0, prNumber: 42 });
    const outcome = await executor.execute(NODE, {});
    expect(outcome.status).toBe("succeeded");
    expect(rep.failed).toHaveLength(0);
    expect(reviews).toHaveLength(1);
    expect(reviews[0]!.pr).toBe("42");
  });

  it("anchors a finding inline via the GitHub API diff when there is no local checkout (k8s)", async () => {
    // On k8s the harness has no repo checkout — only the artifact store's
    // `.lastlight/`. The local `git diff` fails, so pre-#2 every finding was
    // demoted to the body. The fallback fetches the PR diff + head SHA from the
    // GitHub API, so an on-diff finding posts as an inline comment. seedFindings
    // writes findings.json but no `.git`, exactly reproducing the k8s state.
    const taskId = "widget-42-apidiff";
    seedFindings(taskId, "widget", {
      summary: "One issue.",
      event: "REQUEST_CHANGES",
      findings: [
        { path: "src/foo.ts", line: 10, side: "RIGHT", severity: "Important", title: "bug", body: "fix this" },
      ],
    });
    const { executor, rep } = makeExecutor(taskId);
    const outcome = await executor.execute(NODE, {});
    expect(outcome.status).toBe("succeeded");
    expect(rep.failed).toHaveLength(0);
    expect(reviews).toHaveLength(1);
    const body = reviews[0]!.body as {
      event: string;
      body: string;
      commit_id?: string;
      comments: { path: string; line: number }[];
    };
    // Anchored inline (not demoted into the body's "Additional findings"), and
    // the review carries the API-fetched head SHA that inline comments require.
    expect(body.comments).toHaveLength(1);
    expect(body.comments[0]!.path).toBe("src/foo.ts");
    expect(body.comments[0]!.line).toBe(10);
    expect(body.commit_id).toBe(HEAD_SHA);
    expect(body.body).not.toContain("Additional findings");
  });

  it("skips (no post) when the agent recorded skip:true", async () => {
    const taskId = "widget-42-skip";
    seedFindings(taskId, "widget", { skip: true, summary: "already reviewed" });
    const { executor, rep } = makeExecutor(taskId);
    const outcome = await executor.execute(NODE, {});
    expect(outcome.status).toBe("succeeded");
    expect(rep.failed).toHaveLength(0);
    expect(reviews).toHaveLength(0);
  });

  it("FAILS visibly when findings are missing after a review", async () => {
    const taskId = "widget-42-missing";
    seedFindings(taskId, "widget", null); // no file written
    const { executor, rep } = makeExecutor(taskId);
    const outcome = await executor.execute(NODE, {});
    expect(outcome.status).toBe("failed");
    expect(rep.failed.length).toBeGreaterThan(0);
    expect(reviews).toHaveLength(0);
  });
});

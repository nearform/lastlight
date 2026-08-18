import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
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
import { setRuntimeConfig, resetRuntimeConfigForTests } from "#src/config/config.js";
import { defaultReviewConfig, type ReviewConfig } from "lastlight-shared/config-types";

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

function startMock(): {
  server: Server;
  url: string;
  reviews: RecordedReview[];
  comparedBaseheads: string[];
  setCompareFiles: (files: string[]) => void;
  setPriorReviews: (reviews: unknown[]) => void;
} {
  const reviews: RecordedReview[] = [];
  const comparedBaseheads: string[] = [];
  let compareFiles: string[] = [];
  let priorReviews: unknown[] = [];
  const server = createServer((req, res) => {
    // `?per_page=100` rides along on the paginated GET, so the path must not be
    // `$`-anchored — it was, so every reviews read 404'd and the idempotency
    // check silently never fired.
    const m = /^\/repos\/([^/]+)\/([^/]+)\/pulls\/([^/]+)\/reviews(?:\?|$)/.exec(req.url || "");
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
    // getBotReviewHistory lists reviews — empty by default so we never
    // short-circuit; `setPriorReviews` seeds a history for the duplicate guard.
    if (req.method === "GET" && m) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(priorReviews));
      return;
    }
    // repos.compareCommitsWithBasehead — the staleness check's delta read
    // (issue #271). `compareFiles` is set per-test; unset means "no comparison
    // was expected here".
    const cm = /^\/repos\/([^/]+)\/([^/]+)\/compare\/(.+)$/.exec(req.url || "");
    if (req.method === "GET" && cm) {
      comparedBaseheads.push(decodeURIComponent(cm[3]!));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ files: compareFiles.map((filename) => ({ filename })) }));
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
  return {
    server,
    url: "",
    reviews,
    comparedBaseheads,
    setCompareFiles: (files: string[]) => {
      compareFiles = files;
    },
    setPriorReviews: (reviews: unknown[]) => {
      priorReviews = reviews;
    },
  };
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
    persistPhase: vi.fn(async () => {}),
    failWorkflow: vi.fn(async (e?: string) => { failed.push(e ?? ""); }),
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
  let comparedBaseheads: string[];
  let setCompareFiles: (files: string[]) => void;
  let setPriorReviews: (reviews: unknown[]) => void;
  let stateDir: string;
  let savedToken: string | undefined;

  beforeEach(async () => {
    const mock = startMock();
    server = mock.server;
    reviews = mock.reviews;
    comparedBaseheads = mock.comparedBaseheads;
    setCompareFiles = mock.setCompareFiles;
    setPriorReviews = mock.setPriorReviews;
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

  it("does NOT shell out to the local git diff when there is no checkout, even with a base ref (k8s)", async () => {
    // Robin's homelab hit this: a real PR carries `baseBranch` ("main"), so
    // pre-fix `gitCommentableDiff` ran against the harness path — which on k8s
    // holds only the harvested `.lastlight/`, never a `.git`. Every git call
    // failed with `fatal: not a git repository`, dumping the giant `git diff`
    // usage block + a FALSE "demoting all findings to the body" (the API
    // fallback then rescued the findings). The handler must detect the absent
    // checkout and skip straight to the API diff — no failing subprocess, no
    // misleading log. seedFindings writes findings.json but no `.git`, exactly
    // reproducing the k8s state; the base ref present is what triggers the bug.
    const gitDiffSpy = vi.spyOn(
      GitHubPostReviewHandler.prototype as unknown as { gitCommentableDiff: () => unknown },
      "gitCommentableDiff",
    );
    try {
      const taskId = "widget-42-nogit-baseref";
      seedFindings(taskId, "widget", {
        summary: "One issue.",
        event: "REQUEST_CHANGES",
        findings: [
          { path: "src/foo.ts", line: 10, side: "RIGHT", severity: "Important", title: "bug", body: "fix this" },
        ],
      });
      const { executor, rep } = makeExecutor(taskId, { baseBranch: "main" });
      const outcome = await executor.execute(NODE, {});
      expect(outcome.status).toBe("succeeded");
      expect(rep.failed).toHaveLength(0);
      // The crux: with no local `.git`, the local git diff must never run.
      expect(gitDiffSpy).not.toHaveBeenCalled();
      // …and the finding still anchors inline via the GitHub API diff.
      const body = reviews[0]!.body as { comments: { path: string; line: number }[] };
      expect(body.comments).toHaveLength(1);
      expect(body.comments[0]!.path).toBe("src/foo.ts");
      expect(body.comments[0]!.line).toBe(10);
    } finally {
      gitDiffSpy.mockRestore();
    }
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
  /**
   * The staleness guard (issue #271) — don't post a review of a tree that no
   * longer exists.
   *
   * Dropping a review is only acceptable when a replacement is guaranteed, so
   * all three conditions have to hold: the head really moved, the trigger is
   * automatic, and the delta is MATERIAL. That last one is
   * `resolveReviewTrigger`'s generated-only gate read backwards — a material
   * push is one that gate lets through, so a fresh review is certain; a
   * generated-only push is one it suppresses, and dropping this review would
   * leave the PR with none at all.
   */
  describe("staleness — the head moved while the agent was reviewing", () => {
    /**
     * A real git checkout at a SHA of its own, so the run's REVIEWED head
     * genuinely differs from the PR head the mock reports. Without one,
     * `gitHeadSha` returns undefined and the handler falls back to the API
     * head — which is by definition never stale.
     */
    function seedCheckout(taskId: string, repo: string): void {
      const dir = join(stateDir, "sandboxes", taskId, repo);
      mkdirSync(dir, { recursive: true });
      const git = (...args: string[]) =>
        execFileSync("git", ["-C", dir, ...args], { stdio: "ignore" });
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@example.com");
      git("config", "user.name", "t");
      writeFileSync(join(dir, "README.md"), "hi");
      git("add", "-A");
      git("commit", "-qm", "reviewed head");
    }

    function withReviewConfig(over: Partial<ReviewConfig> = {}) {
      setRuntimeConfig({
        review: { ...defaultReviewConfig(), ...over },
      } as unknown as Parameters<typeof setRuntimeConfig>[0]);
    }

    afterEach(() => resetRuntimeConfigForTests());

    it("skips the post when a MATERIAL change landed on the PR mid-run", async () => {
      withReviewConfig({ trigger: "after-checks" });
      setCompareFiles(["pnpm-lock.yaml", "src/auth.ts"]);
      const taskId = "widget-42-stale";
      seedCheckout(taskId, "widget");
      seedFindings(taskId, "widget", { summary: "ok", event: "APPROVE", findings: [] });

      const { executor, rep } = makeExecutor(taskId);
      const outcome = await executor.execute(NODE, {});

      expect(outcome.status).toBe("succeeded");
      expect(rep.failed).toHaveLength(0);
      expect(reviews).toHaveLength(0);
      expect(outcome.results[0]!.output).toMatch(/^stale:/);
      // Compared the head we REVIEWED against the head that is live now.
      expect(comparedBaseheads).toHaveLength(1);
      expect(comparedBaseheads[0]).toMatch(new RegExp(`\\.\\.\\.${HEAD_SHA}$`));
    });

    it("POSTS when only generated files landed — nothing else will review this PR", async () => {
      // The gate that would suppress the re-review is the same one that makes
      // this delta immaterial, so skipping here would lose the review entirely.
      withReviewConfig({ trigger: "after-checks" });
      setCompareFiles(["pnpm-lock.yaml"]);
      const taskId = "widget-42-stale-generated";
      seedCheckout(taskId, "widget");
      seedFindings(taskId, "widget", { summary: "ok", event: "APPROVE", findings: [] });

      const { executor } = makeExecutor(taskId);
      expect((await executor.execute(NODE, {})).status).toBe("succeeded");
      expect(reviews).toHaveLength(1);
    });

    it("POSTS under on-request — nothing re-dispatches, so the human who asked would get nothing", async () => {
      withReviewConfig({ trigger: "on-request" });
      setCompareFiles(["src/auth.ts"]);
      const taskId = "widget-42-stale-onrequest";
      seedCheckout(taskId, "widget");
      seedFindings(taskId, "widget", { summary: "ok", event: "APPROVE", findings: [] });

      const { executor } = makeExecutor(taskId);
      expect((await executor.execute(NODE, {})).status).toBe("succeeded");
      expect(reviews).toHaveLength(1);
      expect(comparedBaseheads).toHaveLength(0);
    });

    it("POSTS when the compare read fails — a degraded read never drops a review", async () => {
      withReviewConfig({ trigger: "eager" });
      setCompareFiles([]); // an empty file list proves nothing material changed
      const taskId = "widget-42-stale-degraded";
      seedCheckout(taskId, "widget");
      seedFindings(taskId, "widget", { summary: "ok", event: "APPROVE", findings: [] });

      const { executor } = makeExecutor(taskId);
      expect((await executor.execute(NODE, {})).status).toBe("succeeded");
      expect(reviews).toHaveLength(1);
    });
  });
  /**
   * The duplicate-review guard (issue #271).
   *
   * nearform/skillspro#1641: two APPROVEs six minutes and 400 identical bytes
   * apart. The trigger gate's generated-only skip cannot catch it — the two
   * reviewed SHAs differ by `package.json` and `jest.config.js` as well as the
   * lock file, so the delta is material by any file-level test. Only the review
   * TEXT identifies it, and that isn't knowable until the agent has written it.
   */
  describe("duplicate — word-for-word the review we already posted", () => {
    const SUMMARY = "Completes the ESLint 8 to 10 migration. No blocking issues.";
    const priorApprove = (sha: string, body: string) => [
      {
        id: 1,
        state: "APPROVED",
        commit_id: sha,
        body,
        submitted_at: "2026-08-05T20:14:46Z",
        user: { login: "last-light[bot]" },
      },
    ];

    it("skips the post when the body and verdict are byte-identical", async () => {
      setPriorReviews(priorApprove("5491287206e7b6d11ffd6b8ca08b9c1747f2aac2", SUMMARY));
      const taskId = "widget-42-dupe";
      seedFindings(taskId, "widget", { summary: SUMMARY, event: "APPROVE", findings: [] });

      const { executor, rep } = makeExecutor(taskId);
      const outcome = await executor.execute(NODE, {});

      expect(outcome.status).toBe("succeeded");
      expect(rep.failed).toHaveLength(0);
      expect(reviews).toHaveLength(0);
      expect(outcome.results[0]!.output).toMatch(/^duplicate: .* 5491287/);
    });

    it("posts when a single word changed — this is not a fuzzy match", async () => {
      setPriorReviews(priorApprove("0ldsha0", SUMMARY));
      const taskId = "widget-42-dupe-differs";
      seedFindings(taskId, "widget", {
        summary: SUMMARY + " Nice work.",
        event: "APPROVE",
        findings: [],
      });
      const { executor } = makeExecutor(taskId);
      expect((await executor.execute(NODE, {})).status).toBe("succeeded");
      expect(reviews).toHaveLength(1);
    });

    // The APPROVE restriction is the check run, not squeamishness: skipping the
    // post leaves `concludeReviewCheck` with no review at this head, which it
    // concludes `neutral`. For an APPROVE that changes nothing (both pass branch
    // protection); for a CHANGES_REQUESTED it would turn a `failure` check into
    // a passing one and open the merge gate the review deliberately closed.
    it("posts a repeated CHANGES_REQUESTED — suppressing it would clear the merge gate", async () => {
      setPriorReviews([
        {
          id: 1,
          state: "CHANGES_REQUESTED",
          commit_id: "0ldsha0",
          body: SUMMARY,
          submitted_at: "2026-08-05T20:14:46Z",
          user: { login: "last-light[bot]" },
        },
      ]);
      const taskId = "widget-42-dupe-changes";
      seedFindings(taskId, "widget", { summary: SUMMARY, event: "REQUEST_CHANGES", findings: [] });
      const { executor } = makeExecutor(taskId);
      expect((await executor.execute(NODE, {})).status).toBe("succeeded");
      expect(reviews).toHaveLength(1);
    });

    it("posts an identical summary that now carries findings", async () => {
      setPriorReviews(priorApprove("0ldsha0", SUMMARY));
      const taskId = "widget-42-dupe-findings";
      seedFindings(taskId, "widget", {
        summary: SUMMARY,
        event: "APPROVE",
        findings: [
          { path: "src/foo.ts", line: 10, side: "RIGHT", severity: "Important", title: "bug", body: "fix" },
        ],
      });
      const { executor } = makeExecutor(taskId, { baseBranch: "main" });
      expect((await executor.execute(NODE, {})).status).toBe("succeeded");
      expect(reviews).toHaveLength(1);
    });
  });
});

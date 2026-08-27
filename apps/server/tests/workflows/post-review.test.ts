import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
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

  /** Write one survey's `hypotheses/<family>.jsonl` beside findings.json. */
  function seedHypotheses(taskId: string, repo: string, family: string, rows: object[]): void {
    const dir = join(stateDir, "sandboxes", taskId, repo, ".lastlight", "pr-review", "hypotheses");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, `${family}.jsonl`), rows.map((r) => JSON.stringify(r)).join("\n"));
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
    // pre-fix `gitDiffFiles` ran against the harness path — which on k8s
    // holds only the harvested `.lastlight/`, never a `.git`. Every git call
    // failed with `fatal: not a git repository`, dumping the giant `git diff`
    // usage block + a FALSE "demoting all findings to the body" (the API
    // fallback then rescued the findings). The handler must detect the absent
    // checkout and skip straight to the API diff — no failing subprocess, no
    // misleading log. seedFindings writes findings.json but no `.git`, exactly
    // reproducing the k8s state; the base ref present is what triggers the bug.
    const gitDiffSpy = vi.spyOn(
      GitHubPostReviewHandler.prototype as unknown as { gitDiffFiles: () => unknown },
      "gitDiffFiles",
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

    /**
     * The split verdict's inertness, enforced HERE rather than promised in a
     * prompt (locked decision 8).
     *
     * `resolveEvent` honours a `verdict` whenever one is present, which is what
     * makes it unit-testable. The deployment-level guarantee is this handler's:
     * with `review.analysis.enabled: false`, a findings file that carries a
     * verdict — a forked prompt, an overlay ahead of its config, a model
     * improvising the field — cannot change the event this deployment would
     * have posted yesterday.
     */
    describe("split verdict — inert unless review.analysis is enabled", () => {
      const withAnalysis = (enabled: boolean) =>
        withReviewConfig({
          trigger: "on-request",
          analysis: { ...defaultReviewConfig().analysis, enabled },
        });

      it("ignores a verdict when the analysis pipeline is OFF", async () => {
        withAnalysis(false);
        const taskId = "widget-42-verdict-off";
        seedFindings(taskId, "widget", {
          summary: "ok",
          event: "APPROVE",
          verdict: { spec: "fail", standards: "pass" },
          findings: [],
        });

        const { executor } = makeExecutor(taskId);
        expect((await executor.execute(NODE, {})).status).toBe("succeeded");
        expect(reviews).toHaveLength(1);
        expect((reviews[0]!.body as { event: string }).event).toBe("APPROVE");
      });

      it("downgrades the APPROVE when the analysis pipeline is ON", async () => {
        withAnalysis(true);
        const taskId = "widget-42-verdict-on";
        seedFindings(taskId, "widget", {
          summary: "ok",
          event: "APPROVE",
          verdict: { spec: "fail", standards: "pass" },
          findings: [],
        });

        const { executor } = makeExecutor(taskId);
        const outcome = await executor.execute(NODE, {});
        expect(outcome.status).toBe("succeeded");
        expect(reviews).toHaveLength(1);
        expect((reviews[0]!.body as { event: string }).event).toBe("COMMENT");
        // …and says so in the ledger row, or "event=COMMENT" on a doc that says
        // APPROVE reads as a bug rather than as the axis floor doing its job.
        expect(outcome.results[0]!.output).toContain("downgraded from APPROVE");
      });
    });

    /**
     * WP6b's attention boundary, at the deployment level.
     *
     * The unit tests pin `tierFindings`; what this owns is the two things only
     * the handler can get wrong — that the boundary is built from config at all,
     * and that it is NOT built when the pipeline is off. The second is the one
     * that matters: a cap silently applied to a deployment that never opted in
     * would change what its reviewer posts, which is precisely what locked
     * decision 8 forbids.
     */
    describe("the attention boundary — opt-in, and audited when it applies", () => {
      // PR_DIFF makes exactly RIGHT:7..10 commentable, so the budget is
      // exercised with a cap of 2 rather than the shipped 8. The 20-findings /
      // 8-inline / 12-in-the-body shape AC1b names is unit-covered in
      // `attention-boundary.test.ts`; what only this layer can prove is that
      // the boundary is BUILT FROM CONFIG at all, and that it is not built when
      // the pipeline is off.
      const findings = () => [
        { path: "src/foo.ts", line: 7, severity: "Critical", title: "on-diff A", body: "b" },
        { path: "src/foo.ts", line: 8, severity: "Critical", title: "on-diff B", body: "b" },
        { path: "src/foo.ts", line: 9, severity: "Important", title: "on-diff C", body: "b" },
        { path: "src/foo.ts", line: 10, severity: "Minor", title: "on-diff D", body: "b" },
        { path: "src/other.ts", line: 99, severity: "Important", title: "off-diff E", body: "b" },
      ];

      const dispositionPath = (taskId: string) =>
        join(stateDir, "sandboxes", taskId, "widget", ".lastlight", "pr-review", "disposition.json");

      it("does NOT cap, and writes no disposition, when the pipeline is off", async () => {
        withReviewConfig({
          trigger: "on-request",
          analysis: { ...defaultReviewConfig().analysis, enabled: false, maxInlineComments: 2 },
        });
        const taskId = "widget-42-boundary-off";
        seedFindings(taskId, "widget", { summary: "ok", event: "COMMENT", findings: findings() });

        const { executor } = makeExecutor(taskId);
        expect((await executor.execute(NODE, {})).status).toBe("succeeded");
        const posted = reviews[0]!.body as { comments: unknown[] };
        // All four anchorable findings post inline: the cap is configured and
        // deliberately ignored, because the deployment did not opt in.
        expect(posted.comments).toHaveLength(4);
        expect(existsSync(dispositionPath(taskId))).toBe(false);
      });

      it("applies the boundary from the RUN CONTEXT when the runtime config is silent", async () => {
        // The eval harness threads the arm's `review:` policy through
        // `prContextPatch` and never populates the process-global runtime
        // config. Reading only the global one made this handler disagree with
        // the twelve gated phases upstream about whether the pipeline ran — so a
        // pipeline-ON eval posted every `internal`-tier finding, uncapped, and
        // reported the precision of a deployment that does not exist.
        withReviewConfig({
          trigger: "on-request",
          analysis: { ...defaultReviewConfig().analysis, enabled: false },
        });
        const taskId = "widget-42-boundary-ctx";
        seedFindings(taskId, "widget", {
          summary: "ok",
          event: "COMMENT",
          findings: [...findings(), { path: "src/foo.ts", line: 9, severity: "Minor", title: "recorded only", body: "b", tier: "internal" }],
        });

        const { executor } = makeExecutor(taskId, { analysisEnabled: "true" });
        expect((await executor.execute(NODE, {})).status).toBe("succeeded");
        const posted = reviews[0]!.body as { comments: unknown[]; body: string };
        // The `internal` finding is withheld even though the runtime config
        // says the pipeline is off — the run's own context says otherwise.
        expect(posted.body).not.toContain("recorded only");
        expect(existsSync(dispositionPath(taskId))).toBe(true);
      });

      it("takes the boundary VALUES from the run context — the wire an eval overlay rides", async () => {
        // Found by the reviewer on this pipeline's own PR: `attentionBoundary()`
        // read only `getRuntimeConfig()` for its four budget values, and the
        // eval harness never populates that — so an arm overlay pinning
        // `maxBodyComments: null` (the measurement funnel) silently ran the
        // shipped `0`, and three repeats each recorded 5–14 `body-budget`
        // demotions the overlay had asked not to happen. The values now ride
        // the same context wire `analysisEnabled` does; runtime config is the
        // fallback, not the authority.
        withReviewConfig({
          trigger: "on-request",
          analysis: { ...defaultReviewConfig().analysis, enabled: false },
        });
        const taskId = "widget-42-boundary-ctx-values";
        seedFindings(taskId, "widget", { summary: "ok", event: "COMMENT", findings: findings() });

        const { executor } = makeExecutor(taskId, {
          analysisEnabled: "true",
          maxInlineComments: "2",
          // The literal `specContext` writes for the documented "unlimited
          // body overflow" value — it must survive the string projection.
          maxBodyComments: "null",
          internalFloor: "0.15",
          boundaryThresholds: "{}",
        });
        expect((await executor.execute(NODE, {})).status).toBe("succeeded");
        const posted = reviews[0]!.body as { comments: { line: number }[]; body: string };

        // The ctx inline budget bound (2, not the packaged 10)…
        expect(posted.comments.map((c) => c.line)).toEqual([7, 8]);
        // …and the ctx `null` opened the funnel wider than the packaged
        // default (`maxBodyComments: 5`) would have.
        expect(posted.body).toContain("### Additional findings");
        for (const t of ["on-diff C", "on-diff D", "off-diff E"]) expect(posted.body, t).toContain(t);
      });

      it("stays inert when NEITHER authority says the pipeline is on", () => {
        // The guarantee that must survive the fallback: `specContext` returns
        // `{}` when analysis is off, so `analysisEnabled` is ABSENT — not
        // `false` — and no deployment that never opted in can be moved.
        expect("analysisEnabled" in ({} as Record<string, unknown>)).toBe(false);
      });

      it("caps inline, keeps the rest in the BODY, and records every disposition", async () => {
        withReviewConfig({
          trigger: "on-request",
          // `maxBodyComments: null` pins the LEGACY unlimited funnel, so this
          // test inspects the demotion routing alone and never the body cap.
          // The shipped default (`5`) is a real budget with its own test
          // below; pinning here keeps the two questions apart.
          analysis: { ...defaultReviewConfig().analysis, enabled: true, maxInlineComments: 2, maxBodyComments: null },
        });
        const taskId = "widget-42-boundary-on";
        seedFindings(taskId, "widget", { summary: "ok", event: "COMMENT", findings: findings() });

        const { executor } = makeExecutor(taskId);
        expect((await executor.execute(NODE, {})).status).toBe("succeeded");
        const posted = reviews[0]!.body as { comments: { line: number }[]; body: string };

        // Ranked by severity: the two Criticals take the budget.
        expect(posted.comments.map((c) => c.line)).toEqual([7, 8]);
        // AC1b: the other three are in the body, not nowhere.
        expect(posted.body).toContain("### Additional findings");
        for (const t of ["on-diff C", "on-diff D", "off-diff E"]) expect(posted.body, t).toContain(t);
        // …and the two causes are not pooled under one heading.
        expect(posted.body).toContain("Outside this PR's diff");
        expect(posted.body).toContain("Beyond this review's inline comment limit");

        // "What did we know and not say?" is answerable on disk.
        const record = JSON.parse(readFileSync(dispositionPath(taskId), "utf8")) as {
          findings: { tier: string; reason: string | null; finding: { title: string } }[];
        };
        expect(record.findings).toHaveLength(5);
        expect(record.findings.filter((r) => r.tier === "inline")).toHaveLength(2);
        expect(
          record.findings.filter((r) => r.tier === "body").map((r) => [r.finding.title, r.reason]),
        ).toEqual([
          ["off-diff E", "off-diff"],
          ["on-diff C", "overflow"],
          ["on-diff D", "overflow"],
        ]);
      });

      it("the shipped default (maxBodyComments: 5) bounds the body — the top five post, the excess is recorded `body-budget`", async () => {
        // Same shape as the test above, but WITHOUT pinning `maxBodyComments`:
        // the spread carries the shipped default of 5, which is a real budget
        // rather than a closed door — so this needs MORE than five body
        // candidates to bind at all. Six here: four off-diff plus the two the
        // inline budget of 2 pushed over. The five best rank through; the
        // sixth lands `internal` with the machine reason `body-budget`,
        // auditable on disk.
        withReviewConfig({
          trigger: "on-request",
          analysis: { ...defaultReviewConfig().analysis, enabled: true, maxInlineComments: 2 },
        });
        const taskId = "widget-42-body-budget";
        seedFindings(taskId, "widget", {
          summary: "ok",
          event: "COMMENT",
          findings: [
            // Anchorable (PR_DIFF makes exactly RIGHT:7..10 commentable).
            { path: "src/foo.ts", line: 7, severity: "Critical", title: "on-diff A", body: "b" },
            { path: "src/foo.ts", line: 8, severity: "Critical", title: "on-diff B", body: "b" },
            { path: "src/foo.ts", line: 9, severity: "Important", title: "on-diff C", body: "b" },
            // Ranked last of everything (Minor × 0.2, still above the 0.15
            // floor), so the one finding the cap cuts is unambiguous rather
            // than a tie broken by document order.
            { path: "src/foo.ts", line: 10, severity: "Minor", title: "on-diff D", body: "b", confidence: 0.2 },
            // Off-diff: body-bound whatever the inline budget is.
            { path: "src/other.ts", line: 99, severity: "Important", title: "off-diff E", body: "b" },
            { path: "src/other.ts", line: 100, severity: "Important", title: "off-diff F", body: "b" },
            { path: "src/other.ts", line: 101, severity: "Minor", title: "off-diff G", body: "b" },
            { path: "src/other.ts", line: 102, severity: "Minor", title: "off-diff H", body: "b" },
          ],
        });

        const { executor } = makeExecutor(taskId);
        expect((await executor.execute(NODE, {})).status).toBe("succeeded");
        const posted = reviews[0]!.body as { comments: { line: number }[]; body: string };

        // The inline budget is untouched by the body cap.
        expect(posted.comments.map((c) => c.line)).toEqual([7, 8]);
        // Five of the six body candidates are posted, ranked by severity ×
        // confidence — and the sixth is simply absent from the review.
        expect(posted.body).toContain("### Additional findings");
        for (const t of ["off-diff E", "off-diff F", "off-diff G", "off-diff H", "on-diff C"]) {
          expect(posted.body, t).toContain(t);
        }
        expect(posted.body).not.toContain("on-diff D");

        // Nothing is deleted — the withheld one is on disk with the reason.
        const record = JSON.parse(readFileSync(dispositionPath(taskId), "utf8")) as {
          findings: { tier: string; reason: string | null; finding: { title: string } }[];
        };
        expect(record.findings).toHaveLength(8);
        expect(record.findings.filter((r) => r.tier === "body")).toHaveLength(5);
        expect(
          record.findings.filter((r) => r.tier === "internal").map((r) => [r.finding.title, r.reason]),
        ).toEqual([["on-diff D", "body-budget"]]);
      });

      /**
       * The anti-finding rule, at the deployment level.
       *
       * `tierFindings` is unit-covered; what only this layer can prove is that
       * the clean-discharge set is READ OFF THE WORKSPACE at all — the sibling
       * `hypotheses/` directory beside the findings the handler already reads —
       * and that a run with no such directory is byte-identical to today.
       *
       * Measured on `prreview__skillspro-1587-r2`: half to two thirds of every
       * hypothesis three identical repeats generated was a clean QUOTE, and on
       * one of the three, 17 findings built entirely out of them were POSTED at
       * confidence ≥ 0.75 — above every bar the boundary has.
       */
      it("records, and does not post, a finding whose evidence is all clean discharges", async () => {
        withReviewConfig({
          trigger: "on-request",
          analysis: { ...defaultReviewConfig().analysis, enabled: true, maxInlineComments: 8 },
        });
        const taskId = "widget-42-clean-discharge";
        seedFindings(taskId, "widget", {
          summary: "ok",
          event: "COMMENT",
          findings: [
            {
              path: "src/foo.ts",
              line: 7,
              severity: "Important",
              title: "anti-finding",
              body: "Type contract: consolidateData correctly accepts the new shape",
              confidence: 0.95,
              hypotheses: ["contract-001"],
            },
            {
              path: "src/foo.ts",
              line: 8,
              severity: "Important",
              title: "real finding",
              body: "the token can be null here",
              confidence: 0.8,
              hypotheses: ["contract-002"],
            },
            // No provenance at all: it must keep the confidence path, whatever
            // the surveys said. Absence of provenance is not innocence.
            { path: "src/foo.ts", line: 9, severity: "Minor", title: "unprovenanced", body: "b" },
          ],
        });
        seedHypotheses(taskId, "widget", "contract", [
          { discharge: "QUOTE", failureScenario: null },
          { discharge: "QUOTE", failureScenario: "a null token reaches the header" },
        ]);

        const { executor } = makeExecutor(taskId);
        const outcome = await executor.execute(NODE, {});
        expect(outcome.status).toBe("succeeded");
        const posted = reviews[0]!.body as { comments: { body: string }[]; body: string };

        expect(posted.comments.map((c) => c.body.includes("real finding"))).toEqual([true, false]);
        expect(posted.body).not.toContain("consolidateData correctly accepts");
        // …and the count is in the ledger row, so the effect is measurable
        // rather than felt.
        expect(outcome.results[0]!.output).toContain("1 recorded-only");

        const record = JSON.parse(readFileSync(dispositionPath(taskId), "utf8")) as {
          findings: { tier: string; reason: string | null; finding: { title: string } }[];
        };
        expect(record.findings.filter((r) => r.tier === "internal").map((r) => [r.finding.title, r.reason])).toEqual([
          ["anti-finding", "clean-discharge"],
        ]);
        expect(record.findings.filter((r) => r.tier === "inline")).toHaveLength(2);
      });

      it("is unmoved by a hypotheses dir when the pipeline is off", async () => {
        // No boundary ⇒ the directory is never even read, so a deployment that
        // has not opted in cannot be changed by what a survey happened to write.
        withReviewConfig({
          trigger: "on-request",
          analysis: { ...defaultReviewConfig().analysis, enabled: false },
        });
        const taskId = "widget-42-clean-discharge-off";
        seedFindings(taskId, "widget", {
          summary: "ok",
          event: "COMMENT",
          findings: [
            { path: "src/foo.ts", line: 7, severity: "Important", title: "anti-finding", body: "b", hypotheses: ["contract-001"] },
          ],
        });
        seedHypotheses(taskId, "widget", "contract", [{ discharge: "QUOTE", failureScenario: null }]);

        const { executor } = makeExecutor(taskId);
        const outcome = await executor.execute(NODE, {});
        expect(outcome.status).toBe("succeeded");
        expect((reviews[0]!.body as { comments: unknown[] }).comments).toHaveLength(1);
        // The `recorded-only` clause belongs to the boundary; with none applied
        // the ledger line is exactly the one it has always been.
        expect(outcome.results[0]!.output).not.toContain("recorded-only");
        expect(existsSync(dispositionPath(taskId))).toBe(false);
      });
    });
  });
  /**
   * A review already standing on the head SHA — and the two situations that
   * fact describes (`resolveReviewPost`).
   *
   * cliftonc/drizzle-cube#937: an `@last-light review` on a head we had already
   * reviewed surveyed, adjudicated and reconciled for eight minutes, reported
   * `succeeded`, and posted nothing. The dispatch gate had decided the request
   * overrode dedup; this step then re-decided it the other way.
   *
   * Fixing that must not cost what the guard was written for. `post-review` is
   * a handler phase with no `executions` row, so `shouldRunPhase` never skips
   * it and every resume/retry re-executes it — the review it finds at the head
   * is then its OWN, and posting a second copy is the failure mode. The
   * discriminator is the dispatch snapshot, so both cases are exercised here
   * with the same `explicitRequest: true` context.
   */
  describe("a review already on the head SHA", () => {
    const AT_DISPATCH = "2026-08-05T20:14:46Z";
    const reviewAtHead = (body: string, submittedAt: string) => ({
      id: 7,
      state: "APPROVED",
      commit_id: HEAD_SHA,
      body,
      submitted_at: submittedAt,
      user: { login: "last-light[bot]" },
    });
    /** The snapshot the dispatch gate resolved, as `index.ts` persists it. */
    const snapshot = (botReviewAtHead: unknown) => ({ prState: { botReviewAtHead } });

    it("skips the post when nobody asked — the unchanged idempotency case", async () => {
      setPriorReviews([reviewAtHead("Reviewed already.", AT_DISPATCH)]);
      const taskId = "widget-42-athead-auto";
      seedFindings(taskId, "widget", { summary: "Looks good.", event: "APPROVE", findings: [] });
      const { executor, rep } = makeExecutor(taskId, {
        ...snapshot({ state: "APPROVED", submittedAt: AT_DISPATCH }),
      });

      const outcome = await executor.execute(NODE, {});

      expect(outcome.status).toBe("succeeded");
      expect(rep.failed).toHaveLength(0);
      expect(reviews).toHaveLength(0);
      expect(outcome.results[0]!.output).toMatch(/^already-reviewed:/);
    });

    it("POSTS over the prior review when a human asked for this run by name", async () => {
      setPriorReviews([reviewAtHead("Reviewed already.", AT_DISPATCH)]);
      const taskId = "widget-42-athead-asked";
      seedFindings(taskId, "widget", { summary: "Had another look.", event: "APPROVE", findings: [] });
      const { executor, rep } = makeExecutor(taskId, {
        explicitRequest: true,
        // The review at the head is the very one the gate decided to override.
        ...snapshot({ state: "APPROVED", submittedAt: AT_DISPATCH }),
      });

      const outcome = await executor.execute(NODE, {});

      expect(outcome.status).toBe("succeeded");
      expect(rep.failed).toHaveLength(0);
      expect(reviews).toHaveLength(1);
      expect((reviews[0]!.body as { body: string }).body).toContain("Had another look.");
    });

    it("does NOT double-post on a re-entry — the review at the head is this run's own", async () => {
      // Dispatched on a head with no review of ours; by the time post-review
      // re-executes (a resume, a Retry) there is one, so it is ours. The
      // explicit request must not override this: a second copy of the review
      // they are already reading answers nobody.
      setPriorReviews([reviewAtHead("Had another look.", "2026-08-05T20:41:02Z")]);
      const taskId = "widget-42-athead-reentry";
      seedFindings(taskId, "widget", { summary: "Had another look.", event: "APPROVE", findings: [] });
      const { executor, rep } = makeExecutor(taskId, {
        explicitRequest: true,
        ...snapshot(null),
      });

      const outcome = await executor.execute(NODE, {});

      expect(outcome.status).toBe("succeeded");
      expect(rep.failed).toHaveLength(0);
      expect(reviews).toHaveLength(0);
      expect(outcome.results[0]!.output).toMatch(/^already-posted:/);
    });

    it("does NOT double-post the re-review it already posted OVER a prior one", async () => {
      // The hard half of the re-entry case: an explicit re-review that posted
      // and then died leaves TWO of our reviews on the head. Only the timestamp
      // tells the one we were sent to override from the one we posted.
      setPriorReviews([
        reviewAtHead("Reviewed already.", AT_DISPATCH),
        reviewAtHead("Had another look.", "2026-08-05T20:41:02Z"),
      ]);
      const taskId = "widget-42-athead-reentry-twice";
      seedFindings(taskId, "widget", { summary: "Had another look.", event: "APPROVE", findings: [] });
      const { executor } = makeExecutor(taskId, {
        explicitRequest: true,
        ...snapshot({ state: "APPROVED", submittedAt: AT_DISPATCH }),
      });

      const outcome = await executor.execute(NODE, {});

      expect(outcome.status).toBe("succeeded");
      expect(reviews).toHaveLength(0);
      expect(outcome.results[0]!.output).toMatch(/^already-posted:/);
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

    // The same carve-out `resolveReviewPost` makes one guard above: the shape
    // this rule catches is an UNPROMPTED re-review of a push that changed
    // nothing readable. A maintainer who typed `@bot review` is asking for
    // precisely the review it would suppress, and suppressing it hands them
    // eight minutes of pipeline and silence.
    it("posts a word-for-word repeat when a human asked for this run by name", async () => {
      setPriorReviews(priorApprove("0ldsha0", SUMMARY));
      const taskId = "widget-42-dupe-asked";
      seedFindings(taskId, "widget", { summary: SUMMARY, event: "APPROVE", findings: [] });
      const { executor } = makeExecutor(taskId, { explicitRequest: true });
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

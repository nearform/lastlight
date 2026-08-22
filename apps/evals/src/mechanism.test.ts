/**
 * Deterministic, AI-free tests for the eval harness mechanism. These run in the
 * DEFAULT `npm test` suite (not the paid `*.eval.test.ts` suite) so the mock
 * plumbing is regression-guarded for free:
 *
 *   - the fake GitHub speaks enough REST for the real github_* tools;
 *   - agentic-pi's `githubApiBaseUrl` seam actually routes Octokit at it;
 *   - workspace seeding + execution grading flip red→green correctly.
 */

import { describe, it, expect, afterAll } from "vitest";
import { GitHubClient } from "agentic-pi/dist/extensions/github/client.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startFakeGitHub, closingIssueNumbers } from "./fake-github.js";
import {
  appliedRepoConfigKeys,
  loadRepoConfigFixture,
  resolveEvalRepoConfig,
  type RepoConfigClient,
} from "./repo-config.js";
import { seedWorkspace, seedWorkspaceFromGit, prFilesFromGit, injectRepoContext } from "./seed.js";
import { gitDiffAgainstBase } from "./run-instance.js";
import { execFileSync } from "node:child_process";
import { gradeExecution, gradeBehavioral, gradeTriage, gradeReview, gradeMarkers, fBeta } from "./grade.js";
import { prContextPatch } from "./pr-context.js";
import { defaultFixConfig, resolveReviewGitHubClient } from "lastlight-core/evals";
import { computeMartianRanking, type MartianSidecar } from "./report.js";
import type { InstanceResult } from "./schema.js";
import { loadMergedConfig, resolvePhaseModel } from "./config.js";
import { modelsArm, configArm, releaseOverlayGuard } from "./arm.js";
import { collectMetrics } from "./metrics.js";

const staticAuth = { getToken: async () => "fake-token", expiresAt: null, canRefresh: false };

/** The shipped `datasets/` root — resolved from this file, not the cwd. */
const DATASETS = join(fileURLToPath(new URL(".", import.meta.url)), "..", "datasets");

describe("fake GitHub + agentic-pi github tools (baseUrl seam)", () => {
  it("serves seeded issues and records mutations made through the real GitHubClient", async () => {
    const fake = await startFakeGitHub({
      owner: "acme",
      repo: "widget",
      issues: [{ number: 101, title: "Crash on empty config", body: "boom", labels: [] }],
    });
    try {
      // The REAL agentic-pi client, pointed at the fake via the released seam.
      const gh = new GitHubClient(staticAuth, { baseUrl: fake.url });

      const issue = (await gh.getIssue("acme", "widget", 101)) as { number: number; title: string };
      expect(issue.number).toBe(101);
      expect(issue.title).toBe("Crash on empty config");

      await gh.createLabel("acme", "widget", "bug", "d73a4a");
      await gh.addLabels("acme", "widget", 101, ["bug", "ready-for-agent"]);
      await gh.addIssueComment("acme", "widget", 101, "Triaged — needs a repro first.");

      expect(fake.labelsOn(101)).toEqual(expect.arrayContaining(["bug", "ready-for-agent"]));
      expect(fake.commentsOn(101).some((c) => /repro/i.test(c))).toBe(true);
      expect(fake.calls.some((c) => c.method === "POST" && c.path.endsWith("/labels"))).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("behavioral + triage grades read the recorded GitHub state", async () => {
    const fake = await startFakeGitHub({
      owner: "acme",
      repo: "widget",
      issues: [{ number: 7, title: "Q", body: "how?", labels: [] }],
    });
    try {
      const gh = new GitHubClient(staticAuth, { baseUrl: fake.url });
      await gh.addLabels("acme", "widget", 7, ["question"]);

      const beh = gradeBehavioral({ labels_added: ["question"], labels_absent: ["ready-for-agent"] }, fake, { issueNumber: 7, branch: "main" });
      expect(beh.ok).toBe(true);

      const tri = gradeTriage({ category: "question" }, fake, 7);
      expect(tri.ok).toBe(true);

      const miss = gradeTriage({ state: "ready-for-agent" }, fake, 7);
      expect(miss.ok).toBe(false);
    } finally {
      await fake.close();
    }
  });
});

describe("fake GitHub — PR + review endpoints (pr-review tier)", () => {
  const seedPr = () =>
    startFakeGitHub({
      owner: "acme",
      repo: "widget",
      pulls: [
        {
          number: 42,
          title: "Add pagination",
          body: "Adds cursor pagination",
          base_ref: "main",
          head_ref: "feature/paginate",
          base_commit: "a".repeat(40),
          head_commit: "b".repeat(40),
          user: "contributor",
          reviews: [{ user: "human", body: "LGTM once tests pass", state: "COMMENTED" }],
          review_comments: [{ user: "human", path: "src/page.ts", line: 10, body: "off-by-one?" }],
          issue_comments: [{ user: "human", body: "thanks for the PR" }],
        },
      ],
    });

  it("serves the seeded PR, its prior reviews/comments, and the shadow issue", async () => {
    const fake = await seedPr();
    try {
      const base = fake.url;
      const pr = await (await fetch(`${base}/repos/acme/widget/pulls/42`)).json();
      expect(pr.number).toBe(42);
      expect(pr.merged).toBe(false);
      expect(pr.head.sha).toBe("b".repeat(40));
      expect(pr.base.ref).toBe("main");

      const reviews = await (await fetch(`${base}/repos/acme/widget/pulls/42/reviews`)).json();
      expect(reviews).toHaveLength(1);
      expect(reviews[0].state).toBe("COMMENTED");

      const comments = await (await fetch(`${base}/repos/acme/widget/pulls/42/comments`)).json();
      expect(comments[0].path).toBe("src/page.ts");

      // Shadow issue → issue-comment endpoint works on the PR number.
      const issueComments = await (await fetch(`${base}/repos/acme/widget/issues/42/comments`)).json();
      expect(issueComments.some((c: { body: string }) => /thanks/i.test(c.body))).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("records a submitted review and exposes it for grading", async () => {
    const fake = await seedPr();
    try {
      const res = await fetch(`${fake.url}/repos/acme/widget/pulls/42/reviews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: "REQUEST_CHANGES",
          body: "Two blocking issues below.",
          comments: [{ path: "src/page.ts", line: 12, body: "negative slice crashes" }],
        }),
      });
      expect(res.status).toBe(200);

      const submitted = fake.submittedReviews(42);
      expect(submitted).toHaveLength(1);
      expect(submitted[0].event).toBe("REQUEST_CHANGES");
      expect(submitted[0].comments[0].path).toBe("src/page.ts");

      // The behavioral proxy sees it.
      const beh = gradeBehavioral(
        { review_submitted: { event: "REQUEST_CHANGES", body_matches: "blocking" } },
        fake,
        { issueNumber: 42, branch: "feature/paginate" },
      );
      expect(beh.ok).toBe(true);

      // Wrong expected event → miss.
      const miss = gradeBehavioral({ review_submitted: { event: "APPROVE" } }, fake, {
        issueNumber: 42,
        branch: "feature/paginate",
      });
      expect(miss.ok).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("records line-anchored inline comments (the contract pr-review's post-review phase depends on)", async () => {
    // pr-review's deterministic `post-review` phase POSTs a review whose
    // findings are inline comments with path + line + side. The mock must
    // preserve those anchors so the grader can fold them in and a human sees
    // them threaded on the diff. This locks that route.
    const fake = await seedPr();
    try {
      const res = await fetch(`${fake.url}/repos/acme/widget/pulls/42/reviews`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          event: "REQUEST_CHANGES",
          body: "Two findings, both on the diff.",
          commit_id: "b".repeat(40),
          comments: [
            { path: "src/page.ts", line: 12, side: "RIGHT", body: "negative slice crashes" },
            { path: "src/page.ts", line: 20, side: "RIGHT", body: "missing await" },
          ],
        }),
      });
      expect(res.status).toBe(200);

      const submitted = fake.submittedReviews(42);
      expect(submitted).toHaveLength(1);
      expect(submitted[0].comments).toHaveLength(2);
      // The full anchor round-trips — path + line + side (RIGHT = head), the
      // shape GitHub's real review-comment API carries.
      expect(submitted[0].comments[0]).toMatchObject({ path: "src/page.ts", line: 12, side: "RIGHT" });
      expect(submitted[0].comments[1]).toMatchObject({ path: "src/page.ts", line: 20, side: "RIGHT" });
    } finally {
      await fake.close();
    }
  });

  it("serves GET /pulls/:n/files — empty (not 404) until seeded, then the registered set", async () => {
    // A review agent may list the PR's files via the API instead of a local
    // `git diff`. The route must exist (empty array before seeding, never 404)
    // and return whatever setPullFiles registered post-seed.
    const fake = await seedPr();
    try {
      const before = await fetch(`${fake.url}/repos/acme/widget/pulls/42/files`);
      expect(before.status).toBe(200);
      expect(await before.json()).toEqual([]);

      fake.setPullFiles(42, [
        { sha: "0".repeat(40), filename: "src/page.ts", status: "modified", additions: 3, deletions: 1, changes: 4, patch: "@@ -1 +1,3 @@" },
      ]);
      const after = await fetch(`${fake.url}/repos/acme/widget/pulls/42/files?per_page=100`);
      expect(after.status).toBe(200);
      const files = await after.json();
      expect(files).toHaveLength(1);
      expect(files[0]).toMatchObject({ filename: "src/page.ts", status: "modified", additions: 3, changes: 4 });
      expect(files[0].patch).toContain("@@");

      // Unknown PR still 404s (the route only serves seeded PRs).
      expect((await fetch(`${fake.url}/repos/acme/widget/pulls/999/files`)).status).toBe(404);
    } finally {
      await fake.close();
    }
  });
});

describe("fake GitHub — the repo-config layer seam (issue #180)", () => {
  const seed = (repoConfig?: Parameters<typeof startFakeGitHub>[0]["repoConfig"]) =>
    startFakeGitHub({ owner: "acme", repo: "widget", defaultBranch: "trunk", repoConfig });

  it("reports `absent` for a repo with no .lastlight/ — the pre-#180 default", async () => {
    // Every eval case that predates this feature takes this path, so it has to
    // be a plain negative answer (never an error) AND report the trust ref.
    const fake = await seed();
    try {
      expect(await fake.fetchRepoConfigTree("acme", "widget")).toEqual({
        status: "absent",
        defaultBranch: "trunk",
      });
      expect(fake.repoConfigFetches()).toBe(1);
    } finally {
      await fake.close();
    }
  });

  it("serves a seeded tree as `ok`, honouring includePath and the file cap", async () => {
    const fake = await seed([
      { path: "lastlight.yml", content: "models: {}\n" },
      { path: "workflows/prompts/answer.md", content: "repo prompt" },
      // Shared real estate: build-handoff docs live under `.lastlight/` too, and
      // `fetchRepoLayer` filters them out BEFORE spending the byte budget.
      { path: "issue-42/architect-plan.md", content: "not part of the layer" },
    ]);
    try {
      const all = await fake.fetchRepoConfigTree("acme", "widget");
      expect(all.status).toBe("ok");
      if (all.status !== "ok") return;
      expect(all.defaultBranch).toBe("trunk");
      expect(all.treeSha).toMatch(/^[0-9a-f]{40}$/);
      expect(all.files.map((f) => f.path)).toEqual([
        "lastlight.yml",
        "workflows/prompts/answer.md",
        "issue-42/architect-plan.md",
      ]);
      expect(all.files[0].mode).toBe("100644");
      expect(all.files[1].content.toString("utf8")).toBe("repo prompt");
      expect(all.truncated).toBe(false);

      const filtered = await fake.fetchRepoConfigTree("acme", "widget", {
        includePath: (p) => p.startsWith("workflows/"),
      });
      expect(filtered.status === "ok" && filtered.files.map((f) => f.path)).toEqual([
        "workflows/prompts/answer.md",
      ]);

      const capped = await fake.fetchRepoConfigTree("acme", "widget", { maxFiles: 1 });
      expect(capped.status === "ok" && capped.files).toHaveLength(1);
      expect(capped.status === "ok" && capped.truncated).toBe(true);
    } finally {
      await fake.close();
    }
  });

  it("answers `not-modified` to a matching treeSha/etag (the warm-cache path)", async () => {
    const fake = await seed([{ path: "lastlight.yml", content: "models: {}\n" }]);
    try {
      const first = await fake.fetchRepoConfigTree("acme", "widget");
      if (first.status !== "ok") throw new Error("expected ok");
      // Content-exact conditional: same subtree sha ⇒ nothing downloaded.
      const again = await fake.fetchRepoConfigTree("acme", "widget", { treeSha: first.treeSha });
      expect(again).toEqual({ status: "not-modified", defaultBranch: "trunk", treeSha: first.treeSha, etag: first.etag });
      // Root-tree ETag conditional (what octokit surfaces as a 304).
      const byEtag = await fake.fetchRepoConfigTree("acme", "widget", { etag: first.etag, treeSha: first.treeSha });
      expect(byEtag.status).toBe("not-modified");
      // A stale sha still downloads.
      expect((await fake.fetchRepoConfigTree("acme", "widget", { treeSha: "stale" })).status).toBe("ok");
    } finally {
      await fake.close();
    }
  });

  it("is loud about a repo it was never seeded with (a wiring bug, not 'no config')", async () => {
    const fake = await seed([{ path: "lastlight.yml", content: "models: {}\n" }]);
    try {
      await expect(fake.fetchRepoConfigTree("other", "repo")).rejects.toThrow(/no repo-config fixture/);
    } finally {
      await fake.close();
    }
  });
});

describe("repo-config layer — fixture → core's real resolver (issue #180)", () => {
  const cacheRoots: string[] = [];
  const cacheRoot = () => {
    const dir = mkdtempSync(join(tmpdir(), "ll-eval-repocfg-"));
    cacheRoots.push(dir);
    return dir;
  };
  afterAll(() => {
    for (const dir of cacheRoots) rmSync(dir, { recursive: true, force: true });
  });

  const resolve = (fake: Awaited<ReturnType<typeof startFakeGitHub>>, repo: string, workflowName = "answer") =>
    resolveEvalRepoConfig({
      repo,
      workflowName,
      client: fake as unknown as RepoConfigClient,
      defaultModel: "anthropic/claude-haiku-4-5",
      cacheRoot: cacheRoot(),
    });

  it("reads a case's fixture from <datasetDir>/lastlight/<id>/, laid out as the repo commits it", () => {
    const files = loadRepoConfigFixture(join(DATASETS, "repo-config"), "repoconfig__prompt-override");
    expect(files?.map((f) => f.path)).toEqual([
      "agent-context/repo-notes.md",
      "lastlight.yml",
      "workflows/prompts/answer.md",
    ]);
    // No fixture directory ⇒ no declaration. This is how every other tier stays
    // on the operator config without knowing the feature exists.
    expect(loadRepoConfigFixture(join(DATASETS, "repo-config"), "repoconfig__no-layer")).toBeUndefined();
    expect(loadRepoConfigFixture(undefined, "anything")).toBeUndefined();
  });

  it("unpacks the shipped fixture, merges the in-bounds keys and drops the rest", async () => {
    // The real production chain: fetchRepoLayer → sanitizeRepoFiles → unpack →
    // resolveRepoConfig. We assert its OUTPUT, not a re-implementation of it.
    const files = loadRepoConfigFixture(join(DATASETS, "repo-config"), "repoconfig__prompt-override");
    const fake = await startFakeGitHub({ owner: "lastlight-evals", repo: "lantern", repoConfig: files });
    try {
      const { repoConfig, refusal } = await resolve(fake, "lastlight-evals/lantern");
      expect(refusal).toBeUndefined();
      expect(repoConfig).toBeDefined();
      // Always the default branch — the trust ref, never a PR head.
      expect(repoConfig!.defaultBranch).toBe("main");
      // The assets the repo contributed, unpacked under a real host path the
      // runner's per-run asset resolver layers on top of the built-ins.
      expect(repoConfig!.assets).toEqual(["agent-context/repo-notes.md", "workflows/prompts/answer.md"]);
      const prompt = join(repoConfig!.assetRoot!, "workflows", "prompts", "answer.md");
      expect(readFileSync(prompt, "utf8")).toContain("REPO PROMPT APPLIED");
      // In-bounds config merged, with `repo` provenance…
      expect(repoConfig!.disabled.crons).toEqual(["weekly-security-scan"]);
      expect(appliedRepoConfigKeys(repoConfig!)).toEqual(["disabled.crons"]);
      // …and the out-of-bounds key dropped with a warning, not an exception.
      expect(repoConfig!.warnings.map((w) => w.code)).toContain("key-not-allowed");
      // The arm's model survives a layer that doesn't set `models:` — otherwise
      // a repo layer would silently rewrite the comparison axis.
      expect(repoConfig!.models.default).toBe("anthropic/claude-haiku-4-5");
    } finally {
      await fake.close();
    }
  });

  it("degrades to the operator config for a repo with no layer, and when the seam throws", async () => {
    const plain = await startFakeGitHub({ owner: "lastlight-evals", repo: "plain" });
    try {
      // `absent` ⇒ no layer at all ⇒ `runWorkflow` is called exactly as it was
      // before the feature existed.
      expect(await resolve(plain, "lastlight-evals/plain")).toEqual({});
      // A client that FAILS, and one that doesn't implement the seam at all
      // (a third-party mock predating #180 — a synchronous TypeError, not a
      // rejection), must both degrade rather than take the run down.
      for (const broken of [{ fetchRepoConfigTree: () => Promise.reject(new Error("boom")) }, {}]) {
        const out = await resolveEvalRepoConfig({
          repo: "lastlight-evals/plain",
          workflowName: "answer",
          client: broken as unknown as RepoConfigClient,
          defaultModel: "anthropic/claude-haiku-4-5",
          cacheRoot: cacheRoot(),
        });
        expect(out.repoConfig).toBeUndefined();
        expect(out.refusal).toBeUndefined();
      }
    } finally {
      await plain.close();
    }
  });

  it("surfaces a repo's own disabled.workflows as a refusal, not a layer", async () => {
    const fake = await startFakeGitHub({
      owner: "acme",
      repo: "widget",
      repoConfig: [{ path: "lastlight.yml", content: "disabled:\n  workflows:\n    - answer\n" }],
    });
    try {
      const { repoConfig, refusal } = await resolve(fake, "acme/widget", "answer");
      expect(repoConfig).toBeUndefined();
      expect(refusal).toMatch(/disables the "answer" workflow/);
      // A workflow the repo did NOT opt out of still resolves normally.
      expect((await resolve(fake, "acme/widget", "pr-review")).refusal).toBeUndefined();
    } finally {
      await fake.close();
    }
  });
});

describe("prFilesFromGit — GitHub /pulls/:n/files payload from a real git diff", () => {
  it("reports added/modified files with counts and per-file patch hunks", () => {
    const dir = mkdtempSync(join(tmpdir(), "prfiles-"));
    try {
      const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, stdio: ["ignore", "pipe", "pipe"] }).toString().trim();
      git("init", "-q", "-b", "main");
      git("config", "user.email", "t@e.com");
      git("config", "user.name", "t");
      writeFileSync(join(dir, "keep.txt"), "one\ntwo\nthree\n");
      git("add", "-A");
      git("commit", "-qm", "base");
      const base = git("rev-parse", "HEAD");
      writeFileSync(join(dir, "keep.txt"), "one\nTWO\nthree\n"); // modify
      writeFileSync(join(dir, "added.txt"), "brand new\n"); // add
      git("add", "-A");
      git("commit", "-qm", "head");
      const head = git("rev-parse", "HEAD");

      const files = prFilesFromGit(dir, base, head).sort((a, b) => a.filename.localeCompare(b.filename));
      expect(files.map((f) => f.filename)).toEqual(["added.txt", "keep.txt"]);

      const added = files.find((f) => f.filename === "added.txt")!;
      expect(added.status).toBe("added");
      expect(added.additions).toBe(1);
      expect(added.patch).toContain("brand new");

      const modified = files.find((f) => f.filename === "keep.txt")!;
      expect(modified.status).toBe("modified");
      expect(modified.additions).toBe(1);
      expect(modified.deletions).toBe(1);
      expect(modified.changes).toBe(2);
      expect(modified.patch).toMatch(/@@.*@@/);
      expect(modified.patch).toContain("+TWO");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("injectRepoContext — synthetic repo-context lands in the file Pi loads", () => {
  // Pi's runtime auto-loads the FIRST of AGENTS.md > CLAUDE.md walking up from the
  // agent cwd (= the repo dir), so the injection MUST write to that winning file —
  // never a sibling the loader would ignore, and never one that shadows real content.
  const withGitDir = (fn: (dir: string) => void) => {
    const dir = mkdtempSync(join(tmpdir(), "inject-"));
    try {
      execFileSync("git", ["init", "-q"], { cwd: dir, stdio: "ignore" });
      fn(dir);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it("creates a fresh AGENTS.md and git-excludes it when neither file exists", () => {
    withGitDir((dir) => {
      const target = injectRepoContext(dir, "Review with an eye for concurrency.");
      expect(target).toBe("AGENTS.md");
      expect(readFileSync(join(dir, "AGENTS.md"), "utf8")).toContain("concurrency");
      // Created file is hidden from `git status` via .git/info/exclude.
      expect(readFileSync(join(dir, ".git", "info", "exclude"), "utf8")).toContain("/AGENTS.md");
    });
  });

  it("appends into an existing AGENTS.md, preserving the repo's real content", () => {
    withGitDir((dir) => {
      writeFileSync(join(dir, "AGENTS.md"), "# Real repo guidance\nRun `make test`.\n");
      const target = injectRepoContext(dir, "Also: prefer small PRs.");
      expect(target).toBe("AGENTS.md");
      const out = readFileSync(join(dir, "AGENTS.md"), "utf8");
      expect(out).toContain("Real repo guidance"); // preserved
      expect(out).toContain("prefer small PRs"); // injected
    });
  });

  it("appends into an existing CLAUDE.md rather than creating a shadowing AGENTS.md", () => {
    withGitDir((dir) => {
      writeFileSync(join(dir, "CLAUDE.md"), "# Real CLAUDE guidance\n");
      const target = injectRepoContext(dir, "Injected note.");
      // AGENTS.md would win the loader and hide the real CLAUDE.md — so we must NOT create it.
      expect(target).toBe("CLAUDE.md");
      expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
      const out = readFileSync(join(dir, "CLAUDE.md"), "utf8");
      expect(out).toContain("Real CLAUDE guidance");
      expect(out).toContain("Injected note");
    });
  });

  it("is a no-op on empty/whitespace text", () => {
    withGitDir((dir) => {
      expect(injectRepoContext(dir, "   \n  ")).toBeUndefined();
      expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    });
  });
});

describe("pr-review grade — F-beta math + judge-free paths", () => {
  it("defaults to F1 (equal weight — Martian's leaderboard metric)", () => {
    // F1 (β=1) is the harmonic mean — symmetric in precision and recall.
    expect(fBeta(1, 1)).toBeCloseTo(1, 6);
    expect(fBeta(1, 0.5)).toBeCloseTo(fBeta(0.5, 1), 6); // symmetric at β=1
    // Closed-form: P=0.8, R=0.4 → 2*0.32 / (0.8 + 0.4) = 0.64/1.2.
    expect(fBeta(0.8, 0.4)).toBeCloseTo(0.64 / 1.2, 6);
  });

  it("β<1 weights precision higher (β=0.5 → precision 2×)", () => {
    expect(fBeta(0, 0, 0.5)).toBe(0);
    // P=1,R=0.5 should beat P=0.5,R=1 (precision-weighted).
    expect(fBeta(1, 0.5, 0.5)).toBeGreaterThan(fBeta(0.5, 1, 0.5));
    // Closed-form check: P=0.8, R=0.4 → 1.25*0.32 / (0.25*0.8 + 0.4) = 0.4/0.6.
    expect(fBeta(0.8, 0.4, 0.5)).toBeCloseTo(0.4 / 0.6, 6);
  });

  it("gradeReview reports β on the grade (F1 by default, opts.beta overrides)", async () => {
    const g1 = await gradeReview({ gold: [], reviews: [] });
    expect(g1.beta).toBe(1);
    const g2 = await gradeReview({ gold: [], reviews: [], beta: 0.5 });
    expect(g2.beta).toBe(0.5);
  });

  it("an empty review scores 0 against a non-empty gold set (no judge call)", async () => {
    const g = await gradeReview({ gold: [{ severity: "high", description: "x" }], reviews: [] });
    expect(g.precision).toBe(0);
    expect(g.recall).toBe(0);
    expect(g.fbeta).toBe(0);
    expect(g.falseNegatives).toHaveLength(1);
    expect(g.error).toBeUndefined();
    // Carries a minimal trace so the 0 is inspectable (not a blank judge modal):
    // no findings, and the gold listed as unmatched.
    expect(g.trace).toBeDefined();
    expect(g.trace!.findings).toHaveLength(0);
    expect(g.trace!.gold).toHaveLength(1);
    expect(g.trace!.gold[0].matchedFinding).toBeNull();
  });

  it("an empty review on an empty gold set is perfect (no judge call)", async () => {
    const g = await gradeReview({ gold: [], reviews: [] });
    expect(g.precision).toBe(1);
    expect(g.recall).toBe(1);
    expect(g.fbeta).toBe(1);
    expect(g.trace).toBeDefined();
    expect(g.trace!.gold).toHaveLength(0);
  });

  it("a posted review with no provider key is ungraded (error), not a silent zero", async () => {
    const saved = {
      a: process.env.ANTHROPIC_API_KEY,
      o: process.env.OPENAI_API_KEY,
      r: process.env.OPENROUTER_API_KEY,
      j: process.env.EVAL_JUDGE_MODEL,
    };
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.OPENAI_API_KEY;
    delete process.env.OPENROUTER_API_KEY;
    delete process.env.EVAL_JUDGE_MODEL;
    try {
      const g = await gradeReview({
        gold: [{ severity: "high", description: "negative slice" }],
        reviews: [{ body: "Found a bug in slicing", event: "COMMENT", comments: [] }],
      });
      expect(g.error).toBeTruthy();
    } finally {
      if (saved.a !== undefined) process.env.ANTHROPIC_API_KEY = saved.a;
      if (saved.o !== undefined) process.env.OPENAI_API_KEY = saved.o;
      if (saved.r !== undefined) process.env.OPENROUTER_API_KEY = saved.r;
      if (saved.j !== undefined) process.env.EVAL_JUDGE_MODEL = saved.j;
    }
  });
});

describe("computeMartianRanking — subset-fair leaderboard placement", () => {
  // Two covered PRs; toolA has data on both, toolB only on PR1 (must be excluded
  // so every ranked row is scored on the identical PR set). Our model is slotted
  // in by micro-F1.
  const sidecar: MartianSidecar = {
    judgeModel: "anthropic/claude-opus-4-5-20251101",
    toolDisplayNames: { toolA: "Tool A", toolB: "Tool B" },
    instances: {
      pr1: { url: "u1", toolMetrics: { toolA: { tp: 2, fp: 0, fn: 1 }, toolB: { tp: 1, fp: 1, fn: 2 } } },
      pr2: { url: "u2", toolMetrics: { toolA: { tp: 1, fp: 1, fn: 1 } } },
    },
  };
  const review = (matched: number, posted: number, gold: number) =>
    ({ precision: 0, recall: 0, fbeta: 0, beta: 1, posted, gold, matched, falsePositives: [], falseNegatives: [] });
  const res = (id: string, r: ReturnType<typeof review>) =>
    ({ instance_id: id, model: "m", review: r } as unknown as InstanceResult);

  it("ranks only tools present on every covered PR, and slots our model by micro-F1", () => {
    const results = [
      res("pr1", review(1, 3, 2)), // tp1 fp2 fn1
      res("pr2", review(1, 2, 2)), // tp1 fp1 fn1  → micro tp2 fp3 fn2 → F1 ≈ 0.444
      res("other", review(9, 9, 9)), // not in the sidecar → ignored, doesn't inflate prCount
    ];
    const r = computeMartianRanking(results, sidecar)!;
    expect(r.prCount).toBe(2);
    expect(r.coveredInstances).toEqual(["pr1", "pr2"]);
    // toolB dropped (missing on pr2); only toolA is comparable on both PRs.
    expect(r.tools.map((t) => t.key)).toEqual(["toolA"]);
    expect(r.tools[0].f1).toBeCloseTo(2 / 3, 5); // tp3 fp1 fn2 → P.75 R.6 → F1 .667
    const us = r.models[0];
    expect(us.f1).toBeCloseTo(4 / 9, 5); // tp2 fp3 fn2 → P.4 R.5 → F1 .444
    expect(us.rank).toBe(2); // below toolA
    expect(us.of).toBe(2); // 1 comparable tool + us
  });

  it("returns undefined when nothing graded overlaps the sidecar", () => {
    expect(computeMartianRanking([res("nope", review(1, 1, 1))], sidecar)).toBeUndefined();
  });
});

describe("config run type — per-step model resolution (config.ts)", () => {
  it("deep-merges overlay config.yaml over core default.yaml (overlay wins per key)", () => {
    const root = mkdtempSync(join(tmpdir(), "ll-eval-cfg-"));
    try {
      // A stand-in core root: just the one file loadMergedConfig reads.
      mkdirSync(join(root, "config"), { recursive: true });
      writeFileSync(
        join(root, "config", "default.yaml"),
        "models:\n  default: anthropic/claude-sonnet-4-6\nvariants: {}\n",
      );
      // An overlay that retargets some phases + sets a variant.
      const overlay = join(root, "overlay");
      mkdirSync(overlay, { recursive: true });
      writeFileSync(
        join(overlay, "config.yaml"),
        "models:\n  default: openai/gpt-5.4-mini\n  architect: openai/gpt-5.5\nvariants:\n  guardrails: low\n",
      );

      const { models, variants } = loadMergedConfig(root, overlay);
      expect(models.default).toBe("openai/gpt-5.4-mini"); // overlay wins
      expect(models.architect).toBe("openai/gpt-5.5"); // overlay-only key kept
      expect(variants.guardrails).toBe("low");

      // No overlay ⇒ just the core defaults.
      const core = loadMergedConfig(root);
      expect(core.models.default).toBe("anthropic/claude-sonnet-4-6");
      expect(core.models.architect).toBeUndefined();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolvePhaseModel mirrors core precedence: {{models.X}} template → models[phase] → default", () => {
    const models = { default: "m-default", guardrails: "m-guard", explore: "m-explore" };
    // 1. A phase whose YAML names `{{models.guardrails}}` → that template wins.
    expect(resolvePhaseModel("{{models.guardrails}}", "guardrails", models)).toBe("m-guard");
    // 2. A template keyed differently from the phase name (explore.yaml's
    //    `read_context` phase uses `{{models.explore}}`) → the TEMPLATE key wins,
    //    NOT the phase-name lookup. This is the case the `ctx.models` wiring guards.
    expect(resolvePhaseModel("{{models.explore}}", "read_context", models)).toBe("m-explore");
    // 3. No template, phase name present in the map → that entry.
    expect(resolvePhaseModel(undefined, "guardrails", models)).toBe("m-guard");
    // 4. No template, unmapped phase → the default.
    expect(resolvePhaseModel(undefined, "executor", models)).toBe("m-default");
    // 5. Template referencing an unset key → falls through to phase/default.
    expect(resolvePhaseModel("{{models.missing}}", "executor", models)).toBe("m-default");
  });
});

describe("Arm seam — model-selection adapters (arm.ts)", () => {
  // A stand-in core root (just the one file loadMergedConfig reads) + an overlay
  // that retargets some phases — mirrors the config.ts test fixtures.
  function makeRoots(): { root: string; overlay: string } {
    const root = mkdtempSync(join(tmpdir(), "ll-eval-arm-"));
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(
      join(root, "config", "default.yaml"),
      "models:\n  default: anthropic/claude-sonnet-4-6\nvariants: {}\n",
    );
    const overlay = join(root, "overlay");
    mkdirSync(overlay, { recursive: true });
    writeFileSync(
      join(overlay, "config.yaml"),
      "models:\n  default: openai/gpt-5.4-mini\n  architect: openai/gpt-5.5\nvariants:\n  guardrails: low\n",
    );
    return { root, overlay };
  }

  describe("modelsArm — one model forced across every step", () => {
    it("prepare() returns just the forced id and leaves ctx untouched", () => {
      const arm = modelsArm("openai/gpt-5.5", "OPENAI_API_KEY");
      expect(arm.label).toBe("openai/gpt-5.5");
      expect(arm.family).toBe("OPENAI_API_KEY");
      const ctx: Record<string, unknown> = {};
      const prepared = arm.prepare(ctx);
      // No per-step maps → core falls every phase back to config.model = the id.
      expect(prepared).toEqual({ model: "openai/gpt-5.5" });
      expect(prepared.models).toBeUndefined();
      expect(prepared.variants).toBeUndefined();
      expect(ctx.models).toBeUndefined();
      expect(ctx.variants).toBeUndefined();
    });

    it("recordPhaseModel() always reports the forced id; describe() is undefined", () => {
      const arm = modelsArm("openai/gpt-5.5", "OPENAI_API_KEY");
      // Even a phase naming a different model template runs the one forced id.
      expect(arm.recordPhaseModel("{{models.architect}}", "architect")).toBe("openai/gpt-5.5");
      expect(arm.recordPhaseModel(undefined, "executor")).toBe("openai/gpt-5.5");
      expect(arm.describe()).toBeUndefined();
    });

    it("activate() is a no-op (no overlay to switch)", () => {
      expect(() => modelsArm("m", "f").activate()).not.toThrow();
    });

    // A forced model is not the whole arm: the overlay's `review:` policy is a
    // deployment fact `--model` says nothing about, and `review.analysis.enabled`
    // is what switches the review evidence pipeline on. A `models` run with an
    // overlay must carry it, or `--model X --overlay wp3` silently runs baseline.
    it("carries the overlay's review policy; no overlay ⇒ undefined", () => {
      const { root, overlay } = makeRoots();
      try {
        // The overlay `makeRoots` writes has no `review:` — absent, not empty.
        expect(modelsArm("m", "f", overlay).review).toBeUndefined();
        expect(modelsArm("m", "f").review).toBeUndefined();

        writeFileSync(
          join(overlay, "config.yaml"),
          "models:\n  default: openai/gpt-5.4-mini\nreview:\n  postsCheck: true\n  analysis:\n    enabled: true\n    surveyPasses: 6\n",
        );
        const arm = modelsArm("m", "f", overlay);
        expect(arm.review).toEqual({ postsCheck: true, analysis: { enabled: true, surveyPasses: 6 } });
        // Config arms read the same block from the same file.
        expect(configArm(root, overlay).review).toEqual(arm.review);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("configArm — a deployment's per-step config drives selection", () => {
    it("prepare() patches ctx.models/variants and returns the merged maps + default", () => {
      const { root, overlay } = makeRoots();
      try {
        const arm = configArm(root, overlay);
        expect(arm.label).toBe("overlay"); // basename(overlayDir)
        expect(arm.family).toBe("overlay"); // config arms are their own family
        const ctx: Record<string, unknown> = {};
        const prepared = arm.prepare(ctx);
        // The executor model is the merged default (the resolve fallback).
        expect(prepared.model).toBe("openai/gpt-5.4-mini");
        expect(prepared.models?.architect).toBe("openai/gpt-5.5");
        expect(prepared.variants?.guardrails).toBe("low");
        // Threaded onto ctx EXACTLY as prod, so `{{models.X}}` templates resolve.
        expect(ctx.models).toBe(prepared.models);
        expect(ctx.variants).toBe(prepared.variants);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("--model override replaces the merged default; no overlay ⇒ label 'config' + core defaults", () => {
      const { root, overlay } = makeRoots();
      try {
        const arm = configArm(root, overlay, "fireworks/some-model");
        expect(arm.prepare({}).model).toBe("fireworks/some-model");

        const core = configArm(root, undefined);
        expect(core.label).toBe("config");
        expect(core.prepare({}).model).toBe("anthropic/claude-sonnet-4-6");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });

    it("recordPhaseModel() mirrors core precedence (template → phase → default); describe() summarises", () => {
      const { root, overlay } = makeRoots();
      try {
        const arm = configArm(root, overlay);
        // A phase naming `{{models.architect}}` → the overlay's gpt-5.5.
        expect(arm.recordPhaseModel("{{models.architect}}", "architect")).toBe("openai/gpt-5.5");
        // An unmapped phase with no template → the merged default.
        expect(arm.recordPhaseModel(undefined, "executor")).toBe("openai/gpt-5.4-mini");
        const desc = arm.describe();
        expect(desc).toContain("default→openai/gpt-5.4-mini");
        expect(desc).toContain("architect→openai/gpt-5.5");
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("overlay guard — the process-global asset root (ADR 0001)", () => {
    it("throws when a second, different overlay activates while one is in use; release clears it", () => {
      const { root, overlay } = makeRoots();
      const overlayB = join(root, "overlay-b");
      mkdirSync(overlayB, { recursive: true });
      writeFileSync(join(overlayB, "config.yaml"), "models:\n  default: openai/gpt-5.5\n");
      releaseOverlayGuard(); // clean slate regardless of test order
      try {
        const a = configArm(root, overlay);
        const b = configArm(root, overlayB);
        a.activate(); // first overlay — fine
        // A different overlay while `a` is still in use is the parallel footgun.
        expect(() => b.activate()).toThrow(/process-global|serially|in use/i);
        // Re-activating the SAME overlay is idempotent, not a conflict.
        expect(() => a.activate()).not.toThrow();
        // A release lets the next arm take over the global.
        releaseOverlayGuard();
        expect(() => b.activate()).not.toThrow();
      } finally {
        releaseOverlayGuard();
        rmSync(root, { recursive: true, force: true });
      }
    });
  });
});

describe("workspace seed + execution grade (SWE-bench resolved)", () => {
  it("flips red→green when the bug is fixed, and detects PASS_TO_PASS regressions", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ll-eval-mech-"));
    try {
      const fixtureDir = join(stateDir, "fixture");
      mkdirSync(join(fixtureDir, "src"), { recursive: true });
      // Buggy: off-by-one (returns n + 2).
      writeFileSync(join(fixtureDir, "src", "counter.ts"), "export const next = (n: number): number => n + 2;\n");

      const seeded = seedWorkspace({ stateDir, taskId: "mech-task", fixtureDir });
      expect(seeded.baseCommit).toHaveLength(40);

      // Held-out test the agent never saw.
      const heldOutDir = join(stateDir, "held");
      mkdirSync(heldOutDir, { recursive: true });
      writeFileSync(
        join(heldOutDir, "counter.test.ts"),
        [
          'import { test } from "node:test";',
          'import assert from "node:assert/strict";',
          'import { next } from "./src/counter.ts";',
          'test("increments by one", () => { assert.equal(next(1), 2); });',
          'test("stays numeric", () => { assert.equal(typeof next(3), "number"); });',
        ].join("\n") + "\n",
      );

      // Before the fix → FAIL_TO_PASS test is red → not resolved.
      const before = gradeExecution({
        workDir: seeded.workDir,
        heldOutDir,
        failToPass: ["increments by one"],
        passToPass: ["stays numeric"],
      });
      expect(before.resolved).toBe(false);
      expect(before.failToPass.find((t) => t.id === "increments by one")?.pass).toBe(false);
      expect(before.passToPass.find((t) => t.id === "stays numeric")?.pass).toBe(true);

      // Apply the fix → both green → resolved.
      writeFileSync(join(seeded.workDir, "src", "counter.ts"), "export const next = (n: number): number => n + 1;\n");
      const after = gradeExecution({
        workDir: seeded.workDir,
        failToPass: ["increments by one"],
        passToPass: ["stays numeric"],
      });
      expect(after.resolved).toBe(true);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 60_000);

  it('PASS_TO_PASS ["*"] requires the whole suite to stay green, not just named tests', () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ll-eval-star-"));
    try {
      const fixtureDir = join(stateDir, "fixture");
      mkdirSync(join(fixtureDir, "src"), { recursive: true });
      writeFileSync(join(fixtureDir, "src", "counter.ts"), "export const next = (n: number): number => n + 1;\n");
      const seeded = seedWorkspace({ stateDir, taskId: "star-task", fixtureDir });

      const heldOutDir = join(stateDir, "held");
      mkdirSync(heldOutDir, { recursive: true });
      writeFileSync(
        join(heldOutDir, "counter.test.ts"),
        [
          'import { test } from "node:test";',
          'import assert from "node:assert/strict";',
          'import { next } from "./src/counter.ts";',
          'test("increments by one", () => { assert.equal(next(1), 2); });',
        ].join("\n") + "\n",
      );

      // Whole suite green → the wildcard regression guard resolves.
      const green = gradeExecution({
        workDir: seeded.workDir,
        heldOutDir,
        failToPass: ["increments by one"],
        passToPass: ["*"],
      });
      expect(green.resolved).toBe(true);
      expect(green.passToPass.find((t) => t.id === "* (all tests)")?.pass).toBe(true);

      // An unrelated test now fails: the named FAIL_TO_PASS is still green, but
      // ["*"] catches the regression → NOT resolved.
      writeFileSync(
        join(seeded.workDir, "unrelated.test.ts"),
        [
          'import { test } from "node:test";',
          'import assert from "node:assert/strict";',
          'test("unrelated invariant", () => { assert.equal(1, 2); });',
        ].join("\n") + "\n",
      );
      const regressed = gradeExecution({
        workDir: seeded.workDir,
        failToPass: ["increments by one"],
        passToPass: ["*"],
      });
      expect(regressed.failToPass.find((t) => t.id === "increments by one")?.pass).toBe(true);
      expect(regressed.passToPass.find((t) => t.id === "* (all tests)")?.pass).toBe(false);
      expect(regressed.resolved).toBe(false);
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("captures the agent's changes as a diff vs base — even after a commit (where `git diff HEAD` is empty)", () => {
    const stateDir = mkdtempSync(join(tmpdir(), "ll-eval-diff-"));
    const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
    try {
      const fixtureDir = join(stateDir, "fixture");
      mkdirSync(join(fixtureDir, "src"), { recursive: true });
      writeFileSync(join(fixtureDir, "src", "counter.ts"), "export const next = (n: number): number => n + 2;\n");
      const seeded = seedWorkspace({ stateDir, taskId: "diff-task", fixtureDir, branch: "lastlight/fix" });

      // Simulate the agent: edit a file, add a NEW file, then commit (as the real
      // code-fix workflow does) so the working tree == HEAD.
      writeFileSync(join(seeded.workDir, "src", "counter.ts"), "export const next = (n: number): number => n + 1;\n");
      writeFileSync(join(seeded.workDir, "NOTES.md"), "# fixed the off-by-one\n");
      g(seeded.workDir, "add", "-A");
      g(seeded.workDir, "-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", "fix");

      // `git diff HEAD` is now empty (the prior bug) — but the diff vs base is not.
      expect(g(seeded.workDir, "diff", "HEAD").trim()).toBe("");
      const patch = gitDiffAgainstBase(seeded.workDir, seeded.baseCommit);
      expect(patch).toBeTruthy();
      expect(patch).toContain("src/counter.ts"); // the modified file
      expect(patch).toContain("NOTES.md"); // the new file
      expect(patch).toContain("+export const next = (n: number): number => n + 1;");
    } finally {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }, 60_000);

  it("suite mode: grades on the test command's exit code when there are no TAP names", () => {
    const workDir = mkdtempSync(join(tmpdir(), "ll-eval-suite-"));
    try {
      const green = gradeExecution({ workDir, failToPass: [], passToPass: [], testCmd: ["node", "-e", "process.exit(0)"] });
      expect(green.resolved).toBe(true);
      const red = gradeExecution({ workDir, failToPass: [], passToPass: [], testCmd: ["node", "-e", "process.exit(1)"] });
      expect(red.resolved).toBe(false);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }, 30_000);
});

describe("git-source seeding (checkout a base commit, fully offline)", () => {
  it("checks out base_commit from a local mirror and sets up an offline push origin", () => {
    const root = mkdtempSync(join(tmpdir(), "ll-eval-gitsrc-"));
    const g = (cwd: string, ...a: string[]) => execFileSync("git", a, { cwd, stdio: ["ignore", "pipe", "pipe"] }).toString();
    try {
      // Build a source repo: base commit (val=base) then a later commit (val=head).
      const src = join(root, "src-repo");
      mkdirSync(src, { recursive: true });
      g(src, "init", "-q", "-b", "main");
      g(src, "config", "user.email", "t@t");
      g(src, "config", "user.name", "t");
      writeFileSync(join(src, "val.txt"), "base\n");
      g(src, "add", "-A");
      g(src, "commit", "-q", "-m", "base");
      const base = g(src, "rev-parse", "HEAD").trim();
      writeFileSync(join(src, "val.txt"), "head\n");
      g(src, "add", "-A");
      g(src, "commit", "-q", "-m", "head");

      // Pre-seed the cache mirror at the path ensureRepoCache expects, so no
      // network clone happens — the whole test is offline.
      const cache = join(root, "cache");
      mkdirSync(join(cache, "repos"), { recursive: true });
      g(join(cache, "repos"), "clone", "--bare", "--quiet", src, join(cache, "repos", "acme__widget.git"));

      const stateDir = join(root, "state");
      mkdirSync(stateDir, { recursive: true });
      process.env.LASTLIGHT_EVALS_CACHE = cache;
      const seeded = seedWorkspaceFromGit({
        stateDir,
        taskId: "gitsrc-task",
        repo: "acme/widget",
        baseCommit: base,
        branch: "lastlight/fix",
      });

      expect(seeded.baseCommit).toBe(base);
      expect(seeded.branch).toBe("lastlight/fix");
      // Working tree is the BASE state, not head.
      expect(readFileSync(join(seeded.workDir, "val.txt"), "utf8")).toBe("base\n");
      // The offline origin accepts a push (proves `git push` works with no network).
      writeFileSync(join(seeded.workDir, "fix.txt"), "fixed\n");
      g(seeded.workDir, "add", "-A");
      g(seeded.workDir, "-c", "user.email=e@e", "-c", "user.name=e", "commit", "-q", "-m", "fix");
      expect(() => g(seeded.workDir, "push", "-q", "origin", "HEAD:refs/heads/lastlight/fix")).not.toThrow();
    } finally {
      delete process.env.LASTLIGHT_EVALS_CACHE;
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});

describe("collectMetrics — subscription-model cost fallback", () => {
  function writeSession(dir: string, envelope: Record<string, unknown>): void {
    const proj = join(dir, "projects", "slug");
    mkdirSync(proj, { recursive: true });
    writeFileSync(join(proj, "s.jsonl"), JSON.stringify({ type: "result", ...envelope }) + "\n");
  }

  it("imputes cost from the fallback rate when the transcript reports $0", () => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-"));
    try {
      // A flat-rate plan (e.g. kimi-coding): tokens present, cost reported as 0.
      writeSession(dir, {
        total_input_tokens: 1_000_000,
        total_output_tokens: 1_000_000,
        total_cache_read_input_tokens: 1_000_000,
        total_cost_usd: 0,
      });
      const rate = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 };
      const m = collectMetrics(dir, rate);
      // 1M @ $3 + 1M @ $15 + 1M @ $0.3 (all per-million) = 18.30
      expect(m.costUsd).toBeCloseTo(18.3, 6);
      expect(m.inputTokens).toBe(1_000_000);
      expect(m.outputTokens).toBe(1_000_000);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("keeps a real reported cost and ignores the fallback rate", () => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-"));
    try {
      writeSession(dir, { total_input_tokens: 500, total_output_tokens: 500, total_cost_usd: 0.42 });
      const m = collectMetrics(dir, { input: 999, output: 999 });
      expect(m.costUsd).toBeCloseTo(0.42, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("leaves cost at $0 when no fallback rate is supplied", () => {
    const dir = mkdtempSync(join(tmpdir(), "metrics-"));
    try {
      writeSession(dir, { total_input_tokens: 500, total_output_tokens: 500, total_cost_usd: 0 });
      const m = collectMetrics(dir);
      expect(m.costUsd).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ── The PR state machine seam (issues #251, #252) ───────────────────────────

describe("PR context — core's own projection, not a copy", () => {
  const args = {
    repo: "acme/widget",
    prNumber: 412,
    title: "Bump tiny-case from 2.4.0 to 3.0.0",
    body: "Bumps tiny-case.",
    branch: "dependabot/npm_and_yarn/tiny-case-3",
  };

  it("projects the CI evidence the fix prompts render", async () => {
    const ctx = await prContextPatch({
      ...args,
      seed: {
        checks_state: "failing",
        base_checks_state: "passing",
        attempt: 2,
        ci_jobs: [
          { name: "CI / test", log_excerpt: "SyntaxError: no export named 'kebab'", failing_step: "npm test" },
        ],
      },
    });

    // `{{ciSection}}` is the block the whole diagnosis rests on; `{{#if ciSection}}`
    // is how the prompt gates it, so an empty string here means the agent is
    // asked to diagnose a failure it was told nothing about.
    expect(String(ctx.ciSection)).toContain("CI FAILURES");
    expect(String(ctx.ciSection)).toContain("kebab");
    expect(ctx.attempt).toBe(2);
    expect(ctx.maxAttempts).toBe(defaultFixConfig().maxAttempts);
    expect(ctx.checksState).toBe("failing");
    expect(ctx.baseChecksState).toBe("passing");
    expect(ctx.ciLogsAvailable).toBe(true);
    // Both harness-owned paths reach the prompt as variables, so a fork that
    // hardcoded the old ones is not silently in play.
    expect(String(ctx.verifyScript)).toContain(".git/");
    expect(String(ctx.notesFile)).toContain(".git/");
  });

  it("carries the flaky promotion the third attempt turns on", async () => {
    const ctx = await prContextPatch({
      ...args,
      seed: { attempt: 3, flaky_deferrals: 2, checks_state: "failing" },
    });
    // The signal that stops attempt 3 from re-reporting `flaky` and then
    // running the fix phase against a verdict that says "change nothing".
    expect(ctx.flakyPromoted).toBe(true);
    expect(ctx.flakyDeferrals).toBe(2);
    expect(ctx.maxFlakyDeferrals).toBe(defaultFixConfig().maxFlakyDeferrals);
  });

  it("projects the merge gate's verdict AND its reason, from one decision", async () => {
    const green = await prContextPatch({
      ...args,
      seed: { checks_state: "passing", settled_check_count: 3 },
    });
    expect(green.mayMerge).toBe(true);
    expect(typeof green.mayMergeReason).toBe("string");

    const pending = await prContextPatch({ ...args, seed: { checks_state: "pending" } });
    expect(pending.mayMerge).toBe(false);
    // The reason is produced BY the decision — the panel, the log line and the
    // prompt are three renderings of it, never three prose variants.
    expect(String(pending.mayMergeReason).length).toBeGreaterThan(0);
  });

  it("seeds the policy blocks a prompt renders, under the case's overrides", async () => {
    const ctx = await prContextPatch({ ...args, seed: { dependencies: { autoMergeMaxImpact: "low" } } });
    expect((ctx.dependencies as { autoMergeMaxImpact: string }).autoMergeMaxImpact).toBe("low");
    // Everything the case did NOT override is the shipped default, so a case
    // states only what it is actually testing.
    expect((ctx.fix as { maxAttempts: number }).maxAttempts).toBe(defaultFixConfig().maxAttempts);
  });

  it("a case with no seed still gets a coherent snapshot", async () => {
    const ctx = await prContextPatch(args);
    expect(ctx.attempt).toBe(1);
    expect(ctx.ciSection).toBe("");
    expect(ctx.prNumber).toBe(412);
  });

  // The review evidence pipeline's ONE switch. `analysisEnabled` is what every
  // WP3 phase in `pr-review.yaml` gates on (`skip_if: "analysisEnabled != true"`),
  // and it comes from the ARM's overlay `config.yaml`, never from gold — so this
  // pair of assertions IS the two-arm comparison in miniature.
  it("the arm's review policy switches the evidence pipeline on, and its absence leaves it off", async () => {
    // baseline/config.yaml: a `review:` block with no `analysis` — the pipeline
    // stays off, with no per-case special-casing.
    const off = await prContextPatch({ ...args, review: { postsCheck: true } });
    expect(off.analysisEnabled).toBeUndefined();
    expect(off.prBody).toBeUndefined();

    // wp3/config.yaml: the same block plus `analysis.enabled`.
    const on = await prContextPatch({
      ...args,
      review: { postsCheck: true, analysis: { enabled: true, maxObligations: 40, surveyPasses: 6 } },
    });
    expect(on.analysisEnabled).toBe("true");
    expect(on.prBody).toBe(args.body);

    // No arm policy at all is byte-identical to a policy that names no analysis.
    expect((await prContextPatch(args)).analysisEnabled).toBeUndefined();
  });

  // The `spec` family's SECOND END. It went inert twice: once when `pr-review`
  // was excluded from `prContextPatch` entirely, and again after that exclusion
  // was lifted — because production reads the changed-file list from
  // `listPullRequestFilePaths` in `resolveSpecContext`, which the eval never
  // calls. `buildSpecObligations` then correctly refuses to emit a one-ended
  // seed (IRIS: a half mechanism measured WORSE than no seed), so all six
  // obligations vanish and the branch spends a model call saying it cannot work.
  //
  // Both failures were silent in the sense that mattered: the run went green.
  const withAnalysis = { enabled: true, maxObligations: 40, surveyPasses: 6 };
  const specBody = "### What & why\n\nCloses #1586.\n\n### Acceptance criteria\n\n- [ ] Silent login must not show the Google popup on a returning session\n";

  it("harness-derived changed files give the spec axis its second end", async () => {
    const ctx = await prContextPatch({
      ...args,
      body: specBody,
      review: { analysis: withAnalysis },
      changedFiles: ["src/auth/redirect-sign-in.ts", "src/auth/session.ts"],
    });
    const block = ctx.specObligations as string | undefined;
    expect(block).toBeDefined();
    // The obligation names both ends: the criterion verbatim, and a changed file.
    expect(block).toContain("Silent login must not show the Google popup");
    expect(block).toContain("src/auth/redirect-sign-in.ts");
    expect(block).not.toContain("changed-file list could not be read");
  });

  it("without them the axis degrades LOUDLY rather than silently passing", async () => {
    const ctx = await prContextPatch({ ...args, body: specBody, review: { analysis: withAnalysis } });
    // Locked decision 6: "could not look" and "looked and it is fine" are
    // different facts, so the block still renders and says which.
    expect(ctx.specObligations).toContain("changed-file list could not be read");
    expect(ctx.specObligations).toContain("That is NOT a pass");
  });

  it("a case seeding [] means 'changes nothing', not 'could not read'", async () => {
    const ctx = await prContextPatch({
      ...args,
      body: specBody,
      review: { analysis: withAnalysis },
      seed: { changed_files: [] },
      changedFiles: ["src/auth/session.ts"],
    });
    // The seed wins over the harness-derived set, and its degraded message is
    // the other one — a `||` fallback here would silently swap the two.
    expect(ctx.specObligations).toContain("changes no files");
    expect(ctx.specObligations).not.toContain("src/auth/session.ts");
  });

  it("the arm wins over a case's own review seed — gold can never flip an arm", async () => {
    const ctx = await prContextPatch({
      ...args,
      seed: { review: { analysis: { enabled: true } as never } },
      review: { analysis: { enabled: false } },
    });
    expect(ctx.analysisEnabled).toBeUndefined();
  });

  // BOTH ends, from the path production uses. The two above cover the
  // harness-derived fallback; this one covers what actually ships: a real
  // `GitHubClient` pointed at the fake, with core's own `resolveSpecContext`
  // doing the GraphQL + REST reads. Each end went missing separately, so the
  // assertion is deliberately on the CONJUNCTION — a criterion traceable to the
  // linked ISSUE (not merely the PR body) and a changed file, in one block.
  it("routes both ends through core's resolver against the fake (the production path)", async () => {
    const fake = await startFakeGitHub({
      owner: "acme",
      repo: "widgets",
      issues: [
        {
          number: 1586,
          title: "Authentication standardisation: silent sign-in",
          // The criterion lives ONLY here, never in the PR body — so a run that
          // read the body alone cannot produce it, and this test would fail.
          body: "Acceptance criteria\n\n- [ ] Backend enforces the nearform.com domain server-side (non-nearform accounts get 403)\n",
        },
      ],
      pulls: [
        {
          number: 412,
          title: "feat: silent sign-in",
          body: "### What & why\n\nCloses #1586. Adds the silent transport.\n",
          base_ref: "main",
          head_ref: "feat/sso",
          base_commit: "a".repeat(40),
          head_commit: "b".repeat(40),
        },
      ],
    });
    try {
      fake.setPullFiles(412, [
        { filename: "src/auth/session.ts", status: "modified", additions: 12, deletions: 2, changes: 14, sha: "c".repeat(40) },
      ]);
      const ctx = await prContextPatch({
        repo: "acme/widgets",
        prNumber: 412,
        title: "feat: silent sign-in",
        body: "### What & why\n\nCloses #1586. Adds the silent transport.\n",
        branch: "feat/sso",
        review: { analysis: withAnalysis },
        github: resolveReviewGitHubClient({ githubApiBaseUrl: fake.url }),
      });
      const block = ctx.specObligations as string | undefined;
      expect(block).toBeDefined();
      expect(block).toContain("nearform.com domain server-side");
      expect(block).toContain("src/auth/session.ts");
      expect(block).not.toContain("changed-file list could not be read");
    } finally {
      await fake.close();
    }
  });

  // GitHub's own boundary: a closing keyword links, a bare reference does not.
  // Getting this wrong would seed the axis with criteria from an issue the PR
  // never promised to satisfy — a confident obligation about the wrong "what
  // was asked", which is worse than no obligation.
  it("resolves closing keywords only, not bare references", () => {
    expect(closingIssueNumbers("Closes #12")).toEqual([12]);
    expect(closingIssueNumbers("fixes #7 and resolved #8")).toEqual([7, 8]);
    expect(closingIssueNumbers("Closes https://github.com/o/r/issues/99")).toEqual([99]);
    expect(closingIssueNumbers("Closes #5. Also closes #5.")).toEqual([5]);
    expect(closingIssueNumbers("See #12, part of #13, related to #14")).toEqual([]);
    expect(closingIssueNumbers("no links here")).toEqual([]);
  });
});

// ── Marker grading (fix / dependency-merge) ─────────────────────────────────

describe("gradeMarkers", () => {
  const diagnose = (cls: string) =>
    `DIAGNOSIS_COMPLETE: pr=412 attempt=1 class=${cls} cause=renamed export ci_vs_local=none`;

  it("grades the diagnosis class off the real marker line", () => {
    const phases = [{ output: `Looked at the log.\n${diagnose("reproducible")}` }];
    expect(gradeMarkers({ diagnosis_class: "reproducible" }, phases).ok).toBe(true);
    expect(gradeMarkers({ diagnosis_class: "flaky" }, phases).ok).toBe(false);
  });

  it("does not accept a bare mention of the tag", () => {
    // The disagreement that let a silent no-op run pass as a diagnosis (#251):
    // the phase gate tested `output.includes(tag)` while the parser required
    // `<TAG>:`. Grading goes through CORE's parser, so the two agree here.
    const phases = [{ output: "I'll finish with DIAGNOSIS_COMPLETE once I understand this." }];
    const g = gradeMarkers({ diagnosis_class: "reproducible" }, phases);
    expect(g.ok).toBe(false);
    expect(g.checks[0].detail).toContain("no marker");
  });

  it("takes the LAST marker across phases — a loop's later iteration supersedes", () => {
    const phases = [
      { output: diagnose("flaky") },
      { output: diagnose("reproducible") },
    ];
    expect(gradeMarkers({ diagnosis_class: "reproducible" }, phases).ok).toBe(true);
  });

  it("accepts any of a set where two verdicts are both defensible", () => {
    const phases = [{ output: diagnose("env-mismatch") }];
    expect(
      gradeMarkers({ diagnosis_class_any_of: ["reproducible", "env-mismatch"] }, phases).ok,
    ).toBe(true);
    expect(gradeMarkers({ diagnosis_class_any_of: ["flaky"] }, phases).ok).toBe(false);
  });

  it("grades the fix outcome and its gate", () => {
    const phases = [{ output: "CI_FIX_COMPLETE: pr=412 attempt=1 outcome=pushed tried=rename gate=green" }];
    expect(gradeMarkers({ fix_outcome: "pushed", fix_gate: "green" }, phases).ok).toBe(true);
    expect(gradeMarkers({ fix_gate: "red" }, phases).ok).toBe(false);
  });

  it("grades the merge assessment's impact and action", () => {
    const phases = [
      { output: "ASSESSMENT_COMPLETE: pr=501 verdict=TRIVIAL impact=low action=automerge" },
    ];
    expect(gradeMarkers({ assessment_impact: "low", assessment_action: "automerge" }, phases).ok).toBe(true);
    expect(gradeMarkers({ assessment_impact: "high" }, phases).ok).toBe(false);
  });

  it("is a no-op for a case that declares no expectations", () => {
    expect(gradeMarkers(undefined, [{ output: "anything" }]).ok).toBe(true);
  });
});

// ── The merge + Actions endpoints the two new tiers need ────────────────────

describe("fake GitHub — merge, auto-merge, diff and Actions", () => {
  const pr = {
    number: 501,
    title: "Bump @types/node from 22 to 26",
    body: "bump",
    base_ref: "main",
    head_ref: "dependabot/types-node-26",
    base_commit: "0".repeat(40),
    head_commit: "0".repeat(40),
    user: "dependabot[bot]",
    files: [
      {
        sha: "0".repeat(40),
        filename: "package.json",
        status: "modified" as const,
        additions: 1,
        deletions: 1,
        changes: 2,
        patch: '@@ -12,7 +12,7 @@\n-    "@types/node": "^22.10.2",\n+    "@types/node": "^26.1.1",',
      },
    ],
  };

  it("enables auto-merge through the GraphQL mutation the real tool uses", async () => {
    // There is NO REST endpoint for this. A REST-only fake 404s the merge
    // workflow's preferred path and the agent silently falls back to a direct
    // merge — every case would then measure the fallback.
    const fake = await startFakeGitHub({ owner: "acme", repo: "app", pulls: [pr] });
    try {
      const gh = new GitHubClient(staticAuth, { baseUrl: fake.url });
      const res = (await gh.enablePullRequestAutoMerge("acme", "app", 501, "squash")) as {
        ok: boolean;
      };
      expect(res.ok).toBe(true);
      expect(fake.autoMergeOf(501)?.method).toBe("squash");
      // Auto-merge is NOT a merge: the PR is still open, waiting on its checks.
      expect(fake.mergeOf(501)).toBeUndefined();
    } finally {
      await fake.close();
    }
  });

  it("records a direct merge separately from auto-merge", async () => {
    const fake = await startFakeGitHub({ owner: "acme", repo: "app", pulls: [pr] });
    try {
      const gh = new GitHubClient(staticAuth, { baseUrl: fake.url });
      await gh.mergePullRequest("acme", "app", 501, { merge_method: "squash" });
      expect(fake.mergeOf(501)?.method).toBe("squash");
      expect(fake.autoMergeOf(501)).toBeUndefined();
      // …and the two are gradeable as the different decisions they are.
      expect(gradeBehavioral({ pr_merged: true, auto_merge_enabled: false }, fake, { issueNumber: 501, branch: "main" }).ok).toBe(true);
      expect(gradeBehavioral({ pr_merged: false }, fake, { issueNumber: 501, branch: "main" }).ok).toBe(false);
    } finally {
      await fake.close();
    }
  });

  it("serves the PR patch to the diff media type, not JSON", async () => {
    const fake = await startFakeGitHub({ owner: "acme", repo: "app", pulls: [pr] });
    try {
      fake.setPullFiles(501, pr.files);
      const gh = new GitHubClient(staticAuth, { baseUrl: fake.url });
      const diff = (await gh.getPullRequestDiff("acme", "app", 501)) as unknown as string;
      // A JSON body here would hand the impact assessment an object where it
      // expects a patch — it would then reason about the wrong artifact.
      expect(String(diff)).toContain("diff --git a/package.json");
      expect(String(diff)).toContain("@types/node");
    } finally {
      await fake.close();
    }
  });

  it("serves the CI reads from the same fixture the prompt was built from", async () => {
    const fake = await startFakeGitHub({
      owner: "acme",
      repo: "app",
      pulls: [pr],
      actions: {
        headSha: "f1a0b22",
        jobs: [{ name: "CI / test", log: "SyntaxError: no export named 'kebab'", failingStep: "npm test" }],
      },
    });
    try {
      const gh = new GitHubClient(staticAuth, { baseUrl: fake.url });
      const runs = (await gh.listWorkflowRuns("acme", "app", {})) as { workflow_runs: { id: number }[] };
      expect(runs.workflow_runs.length).toBe(1);
      const jobs = (await gh.listWorkflowRunJobs("acme", "app", runs.workflow_runs[0].id)) as {
        jobs: { id: number; name: string }[];
      };
      expect(jobs.jobs[0].name).toBe("CI / test");
      const logs = (await gh.getJobLogs("acme", "app", jobs.jobs[0].id)) as unknown as
        | string
        | { log?: string; content?: string };
      // An agent that digs into the logs must read the SAME failure the prompt
      // told it about — one seed, two surfaces.
      expect(JSON.stringify(logs)).toContain("kebab");
    } finally {
      await fake.close();
    }
  });

  it("keeps an un-fixtured Actions route a loud 404", async () => {
    // The rest of this file's contract: an unimplemented route 404s rather than
    // returning a plausible empty answer.
    const fake = await startFakeGitHub({ owner: "acme", repo: "app", pulls: [pr] });
    try {
      const res = await fetch(`${fake.url}/repos/acme/app/actions/runs`);
      expect(res.status).toBe(404);
    } finally {
      await fake.close();
    }
  });
});

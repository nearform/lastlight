/**
 * Deterministic, AI-free tests for the eval harness mechanism. These run in the
 * DEFAULT `npm test` suite (not the paid `*.eval.test.ts` suite) so the mock
 * plumbing is regression-guarded for free:
 *
 *   - the fake GitHub speaks enough REST for the real github_* tools;
 *   - agentic-pi's `githubApiBaseUrl` seam actually routes Octokit at it;
 *   - workspace seeding + execution grading flip red→green correctly.
 */

import { describe, it, expect } from "vitest";
import { GitHubClient } from "agentic-pi/dist/extensions/github/client.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startFakeGitHub } from "./fake-github.js";
import { seedWorkspace, seedWorkspaceFromGit, prFilesFromGit } from "./seed.js";
import { gitDiffAgainstBase } from "./run-instance.js";
import { execFileSync } from "node:child_process";
import { gradeExecution, gradeBehavioral, gradeTriage, gradeReview, fBeta } from "./grade.js";
import { computeMartianRanking, type MartianSidecar } from "./report.js";
import type { InstanceResult } from "./schema.js";
import { loadMergedConfig, resolvePhaseModel } from "./config.js";
import { modelsArm, configArm, releaseOverlayGuard } from "./arm.js";

const staticAuth = { getToken: async () => "fake-token", expiresAt: null };

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

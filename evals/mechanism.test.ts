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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { startFakeGitHub } from "./fake-github.js";
import { seedWorkspace } from "./seed.js";
import { gradeExecution, gradeBehavioral, gradeTriage } from "./grade.js";

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
});

/**
 * Run ONE eval instance against the REAL production workflow with GitHub mocked.
 *
 * Flow:
 *   1. Start the fake GitHub (seeded from the instance's issue fixtures).
 *   2. (code-fix) Deterministically seed the workspace: fixture repo @ base
 *      commit + a local bare `origin` so `git push` works offline.
 *   3. Load the REAL workflow YAML (build / issue-triage / …) via the loader.
 *   4. runWorkflow with `sandbox: "none"`, `githubApiBaseUrl → fake GitHub`,
 *      and an EMPTY approvalConfig so gates never pause. No real GitHub creds.
 *   5. Grade deterministically (execution + behavioral) and collect metrics.
 *
 * The only deviations from production are the ones we can't do unattended:
 * approvals are skipped and GitHub is mocked. Prompts, skills, phases, and the
 * agent loop are exactly what ships.
 */

import { mkdtempSync, mkdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { getWorkflow } from "../src/workflows/loader.js";
import { runWorkflow } from "../src/workflows/runner.js";
import type { ExecutorConfig } from "../src/engine/profiles.js";
import type { TemplateContext } from "../src/workflows/templates.js";

import type { SweBenchInstance, InstanceResult } from "./schema.js";
import { startFakeGitHub } from "./fake-github.js";
import { seedWorkspace } from "./seed.js";
import { collectMetrics, drainSessions } from "./metrics.js";
import { gradeBehavioral, gradeExecution, gradeTriage } from "./grade.js";

export interface RunInstanceOptions {
  model: string;
  /** Base dir for the run's sandbox/sessions (a fresh temp dir if omitted). */
  stateDir?: string;
  /** Dataset dir holding `repos/<id>` (fixture) + `tests/<id>` (held-out). */
  datasetDir?: string;
  /** Default workflow when the instance doesn't name one. */
  defaultWorkflow?: string;
  keepWorkspace?: boolean;
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name] = repo.split("/");
  return { owner: owner ?? "acme", name: name ?? "widget" };
}

export async function runInstance(inst: SweBenchInstance, opts: RunInstanceOptions): Promise<InstanceResult> {
  const start = Date.now();
  const { owner, name } = splitRepo(inst.repo);
  const workflowName = inst.workflow ?? opts.defaultWorkflow ?? "issue-triage";
  const isCodeFix = workflowName !== "issue-triage";

  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "ll-eval-"));
  const sessionsDir = join(stateDir, "agent-sessions");
  // The shim appends per-phase jsonl under <sessionsDir>/projects/<slug>/ and
  // does not create that parent recursively — pre-create it so token/cost
  // metrics are captured (collectMetrics reads those jsonl files).
  mkdirSync(join(sessionsDir, "projects"), { recursive: true });
  const taskId = `${name}-${inst.issue?.number ?? 0}-${workflowName}-${slug(inst.instance_id)}`;
  const issueNumber = inst.issue?.number ?? 1;
  const branch = isCodeFix ? `lastlight/${slug(inst.instance_id)}` : "main";

  // 1. Fake GitHub, seeded with the issue.
  const fake = await startFakeGitHub({
    owner,
    repo: name,
    issues: inst.issue ? [inst.issue] : [],
    existingLabels: inst.issue?.labels ?? [],
  });

  // Static-token mode: no App creds (so no real mint), a dummy token so the
  // GitHub extension loads, and point its Octokit at the fake.
  const savedEnv = snapshotEnv(["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_API_URL"]);
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_INSTALLATION_ID;
  process.env.GITHUB_TOKEN = "eval-fake-token";
  process.env.GH_TOKEN = "eval-fake-token";

  const result: InstanceResult = {
    instance_id: inst.instance_id,
    model: opts.model,
    workflowSucceeded: false,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: 0,
    phases: [],
  };

  try {
    // 2. Seed the workspace for code-fix (triage needs no repo).
    if (isCodeFix && opts.datasetDir) {
      const fixtureDir = join(opts.datasetDir, "repos", inst.instance_id);
      if (existsSync(fixtureDir)) {
        seedWorkspace({ stateDir, taskId, fixtureDir, branch });
      }
    }

    // 3. Real workflow definition + run context.
    const def = getWorkflow(workflowName);
    const ctx: TemplateContext = {
      owner,
      repo: name,
      issueNumber,
      issueTitle: inst.issue?.title ?? inst.instance_id,
      issueBody: inst.issue?.body ?? inst.problem_statement,
      issueLabels: inst.issue?.labels ?? [],
      commentBody: "",
      sender: "eval",
      branch,
      taskId,
      issueDir: `.lastlight/issue-${issueNumber}`,
      bootstrapLabel: "lastlight:bootstrap",
      // No prePopulateBranch → the runner never clones from GitHub; the agent
      // works in the dir we seeded above (or an empty dir for triage).
    };

    const config: ExecutorConfig = {
      sandbox: "none",
      stateDir,
      sessionsDir,
      model: opts.model,
      githubApiBaseUrl: fake.url,
      // Eval workflows shouldn't reach the network beyond the model + fake GH.
      webSearch: false,
    };

    // 4. Run. Empty approvalConfig → every approval gate is disabled.
    const wf = await runWorkflow(def, ctx, config, {}, undefined, undefined, {});

    result.workflowSucceeded = wf.success;
    result.phases = wf.phases.map((p) => ({ phase: p.phase, success: p.success }));

    // 5a. Behavioral grade (GitHub mutations).
    const behavioralExpect = gradeBehavioral(inst.expect_github, fake, { issueNumber, branch });
    const triage = gradeTriage(inst.triage_gold, fake, issueNumber);
    result.behavioral = {
      ok: behavioralExpect.ok && triage.ok,
      checks: [...behavioralExpect.checks, ...triage.checks],
    };

    // 5b. Execution grade (code-fix only).
    if (isCodeFix && (inst.FAIL_TO_PASS?.length || inst.test_patch)) {
      const workDir = join(stateDir, "sandboxes", taskId);
      const heldOutDir = opts.datasetDir ? join(opts.datasetDir, "tests", inst.instance_id) : undefined;
      const exec = gradeExecution({
        workDir,
        heldOutDir,
        testPatch: inst.test_patch,
        failToPass: inst.FAIL_TO_PASS ?? [],
        passToPass: inst.PASS_TO_PASS ?? [],
      });
      result.resolved = exec.resolved;
      result.failToPass = exec.failToPass;
      result.passToPass = exec.passToPass;
      result.model_patch = gitDiff(workDir);
    }

    // 5c. Metrics. Drain the fire-and-forget session flush first so the final
    // `result` envelope (cost/tokens) has landed before we read + clean up.
    await drainSessions(sessionsDir);
    const m = collectMetrics(sessionsDir);
    result.inputTokens = m.inputTokens;
    result.outputTokens = m.outputTokens;
    result.costUsd = m.costUsd;
    result.githubMutations = fake.calls.length;
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    result.durationMs = Date.now() - start;
    await fake.close();
    restoreEnv(savedEnv);
    if (!opts.keepWorkspace && !opts.stateDir) {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }

  return result;
}

function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40);
}

function snapshotEnv(keys: string[]): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {};
  for (const k of keys) snap[k] = process.env[k];
  return snap;
}
function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const [k, v] of Object.entries(snap)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

function gitDiff(workDir: string): string | undefined {
  try {
    return execFileSync("git", ["diff", "HEAD"], { cwd: workDir, stdio: ["ignore", "pipe", "ignore"] }).toString();
  } catch {
    return undefined;
  }
}

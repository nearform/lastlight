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

import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getWorkflow,
  runWorkflow,
  type ExecutorConfig,
  type TemplateContext,
  type RunnerCallbacks,
} from "lastlight/evals";

import type { SweBenchInstance, InstanceResult, PhaseSession } from "./schema.js";
import { resolvePhaseModel, type ModelConfig, type VariantConfig } from "./config.js";
import { startFakeGitHub } from "./fake-github.js";
import { seedWorkspace } from "./seed.js";
import { collectMetrics, drainSessions, readSessionLog, listSessionFiles, concatJsonl } from "./metrics.js";
import { gradeBehavioral, gradeExecution, gradeTriage } from "./grade.js";

export interface RunInstanceOptions {
  /**
   * The arm's axis LABEL recorded on the result (a model id in `models` runs,
   * the config/overlay name in `config` runs). In `models` runs it's also the
   * model forced across every step; in `config` runs the per-step models come
   * from {@link modelConfig} instead and `model` is just the label.
   */
  model: string;
  /**
   * `config` run type: the merged per-step model map (default.yaml + overlay
   * config.yaml). When set, this is threaded to core EXACTLY as production does
   * — onto `ctx.models` (so `{{models.X}}` phase templates resolve) AND as the
   * `runWorkflow` `models` arg (the resolver fallback) — so core picks the
   * model per phase. `ExecutorConfig.model` falls back to `modelConfig.default`.
   * Omit for `models` runs (one model forced across all steps).
   */
  modelConfig?: ModelConfig;
  /** `config` run type: the merged per-step reasoning-effort map, threaded
   * alongside {@link modelConfig} (prod parity). */
  variantConfig?: VariantConfig;
  /** Base dir for the run's sandbox/sessions (a fresh temp dir if omitted). */
  stateDir?: string;
  /** Dataset dir holding `repos/<id>` (fixture) + `tests/<id>` (held-out). */
  datasetDir?: string;
  /** Default workflow when the instance doesn't name one. */
  defaultWorkflow?: string;
  keepWorkspace?: boolean;
  /**
   * Absolute dir for THIS trial's archived session logs (e.g.
   * `<runDir>/sessions/<id>__<model>/trial-1`). When set, the consolidated
   * transcript is flushed here live as `full.jsonl` (so a running case can be
   * followed) and, at the end, split into one `NN-<phase>.jsonl` per workflow
   * phase. Omit to keep the prior throwaway behaviour.
   */
  sessionTrialDir?: string;
  /** {@link sessionTrialDir} as a path RELATIVE to the run dir (what the
   * dashboard resolves against the scorecard URL). */
  sessionTrialRel?: string;
  /** 1-based trial index recorded on the result's {@link TrialSession}. */
  trial?: number;
  /**
   * When `false`, this call does NOT touch `process.env` — the caller has
   * already installed the eval's static-token env around the whole batch (see
   * {@link applyEvalEnv}). Required for running instances concurrently in one
   * process: per-run env splicing would race, but a single stable baseline
   * (identical fake token for every run) is safe. Defaults to `true` so a
   * standalone `runInstance` still self-manages its env.
   */
  manageEnv?: boolean;
}

const EVAL_ENV_KEYS = ["GITHUB_APP_ID", "GITHUB_APP_INSTALLATION_ID", "GITHUB_TOKEN", "GH_TOKEN", "GITHUB_API_URL"];

/**
 * Install the eval's static-token GitHub env and return a restore fn:
 *   - unset the App creds so no real installation token is ever minted, and
 *   - set a dummy `GITHUB_TOKEN`/`GH_TOKEN` so the GitHub extension loads in
 *     static-token mode (its Octokit is pointed at the fake server via
 *     `githubApiBaseUrl`).
 * Every eval run wants the SAME values, so the parallel batch installs this
 * once up front (stable baseline) and each `runInstance` skips its own env work
 * via `manageEnv: false`.
 */
export function applyEvalEnv(): () => void {
  const saved = snapshotEnv(EVAL_ENV_KEYS);
  delete process.env.GITHUB_APP_ID;
  delete process.env.GITHUB_APP_INSTALLATION_ID;
  process.env.GITHUB_TOKEN = "eval-fake-token";
  process.env.GH_TOKEN = "eval-fake-token";
  return () => restoreEnv(saved);
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
  // GitHub extension loads, and point its Octokit at the fake. In a parallel
  // batch the caller installs this once (manageEnv: false) so concurrent runs
  // share one stable baseline instead of racing per-run env splices.
  const restoreEvalEnv = opts.manageEnv === false ? () => {} : applyEvalEnv();

  const result: InstanceResult = {
    instance_id: inst.instance_id,
    model: opts.model,
    workflowSucceeded: false,
    inputTokens: 0,
    cachedTokens: 0,
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

    // `config` run type: thread the merged per-step model/variant maps onto the
    // context EXACTLY as production (`simple.js`) does, so phase `model:
    // "{{models.X}}"` templates resolve against `ctx.models`. (TemplateContext
    // doesn't declare these — prod sets them as extra top-level keys too.)
    if (opts.modelConfig) {
      (ctx as Record<string, unknown>).models = opts.modelConfig;
      (ctx as Record<string, unknown>).variants = opts.variantConfig ?? {};
    }

    const config: ExecutorConfig = {
      sandbox: "none",
      stateDir,
      sessionsDir,
      // `config` mode lets core pick per phase; `config.model` is only the
      // fallback for phases that resolve to nothing, so use the config default
      // (NOT opts.model, which is the arm label in config mode). `models` mode
      // forces opts.model across every step.
      model: opts.modelConfig ? opts.modelConfig.default : opts.model,
      githubApiBaseUrl: fake.url,
      // Eval workflows shouldn't reach the network beyond the model + fake GH.
      webSearch: false,
    };

    // Phase windows: each phase writes its own session jsonl(s), but the public
    // runner doesn't expose the sessionId→phase map. Phases run sequentially, so
    // `onPhaseStart` timestamps let us bucket each session file into the last
    // phase started before it (see the split in 5d).
    const phaseStarts: { phase: string; start: number }[] = [];
    const callbacks: RunnerCallbacks = {
      onPhaseStart: async (phase) => {
        phaseStarts.push({ phase, start: Date.now() });
      },
    };

    const trialDir = opts.sessionTrialDir;
    const fullFile = trialDir ? join(trialDir, "full.jsonl") : undefined;
    // Flush the consolidated transcript atomically (so a polling dashboard never
    // reads a half-written file): on a timer while running (follow-along), and
    // once at the end. Best-effort — a flush failure must never affect the run.
    const flushFull = () => {
      if (!fullFile || !trialDir) return;
      try {
        const log = readSessionLog(sessionsDir);
        if (!log) return;
        mkdirSync(trialDir, { recursive: true });
        const tmp = `${fullFile}.tmp`;
        writeFileSync(tmp, log);
        renameSync(tmp, fullFile);
      } catch {
        /* best-effort */
      }
    };

    // 4. Run. Empty approvalConfig (7th arg) → every approval gate is disabled.
    // In `config` mode the merged maps go to args 6 (models) and 9 (variants),
    // matching prod's runWorkflow call; in `models` mode both stay undefined so
    // every phase falls back to config.model (one model everywhere).
    const flushTimer = fullFile ? setInterval(flushFull, 1000) : undefined;
    let wf;
    try {
      wf = await runWorkflow(
        def,
        ctx,
        config,
        callbacks,
        undefined,
        opts.modelConfig,
        {},
        undefined,
        opts.variantConfig,
      );
    } finally {
      if (flushTimer) clearInterval(flushTimer);
    }

    result.workflowSucceeded = wf.success;
    // Record the model each phase resolved to — the run's forced model in
    // `models` mode, or the per-step model the merged config assigned in
    // `config` mode (mirrors core's selection for display; see config.ts).
    const phaseModelTemplates = new Map(def.phases.map((p) => [p.name, p.model]));
    result.phases = wf.phases.map((p) => ({
      phase: p.phase,
      success: p.success,
      model: opts.modelConfig
        ? resolvePhaseModel(phaseModelTemplates.get(p.phase), p.phase, opts.modelConfig)
        : opts.model,
    }));

    // A workflow can end un-successful for two very different reasons:
    //   - a DELIBERATE gate decision (guardrails `on_output` BLOCKED — the agent
    //     judged the repo/issue unfit to build). Core marks that phase with the
    //     constant `error: "BLOCKED"`. That's a legitimate measured outcome, NOT
    //     a harness failure — record it as `blocked` so it doesn't count as an
    //     error or flip the exit code.
    //   - a real RUN failure (a phase erroring — provider auth/credit/rate,
    //     timeout, a crash). That IS an error; surface it so the scorecard counts
    //     it under errors instead of a bare behavioral✗.
    if (!wf.success) {
      const failed = wf.phases.find((p) => !p.success && p.error);
      if (failed?.error === "BLOCKED") {
        result.blocked = true;
      } else {
        result.error = failed?.error
          ? `${failed.phase}: ${failed.error}`.slice(0, 300)
          : "workflow failed";
      }
    }

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
    result.cachedTokens = m.cachedTokens;
    result.outputTokens = m.outputTokens;
    result.costUsd = m.costUsd;
    result.githubMutations = fake.calls.length;

    // 5d. Archive the session (the drain above ensured the last `result`
    // envelope landed): a final consolidated `full.jsonl` plus one
    // `NN-<phase>.jsonl` per workflow phase — bucketing each session file into
    // the phase whose start-time window it falls in. Done before the temp
    // workspace is deleted below. Best-effort: a failure leaves sessionTrial unset.
    if (trialDir) {
      try {
        flushFull();
        const rel = opts.sessionTrialRel ?? trialDir;
        const successByPhase = new Map(wf.phases.map((p) => [p.phase, p.success]));
        const starts = [...phaseStarts].sort((a, b) => a.start - b.start);
        const files = listSessionFiles(sessionsDir); // chronological
        const buckets = new Map<string, string[]>();
        const order: string[] = [];
        for (const sf of files) {
          // The last phase started at/before this session's first line (50ms slack).
          let phase = starts[0]?.phase ?? "session";
          for (const ev of starts) {
            if (ev.start <= sf.firstTs + 50) phase = ev.phase;
            else break;
          }
          if (!buckets.has(phase)) {
            buckets.set(phase, []);
            order.push(phase);
          }
          buckets.get(phase)!.push(sf.file);
        }
        const phases: PhaseSession[] = [];
        let idx = 0;
        for (const phase of order) {
          const content = concatJsonl(buckets.get(phase)!);
          if (!content) continue; // skip no-agent phases (e.g. phase_0)
          idx++;
          const fileName = `${String(idx).padStart(2, "0")}-${slug(phase)}.jsonl`;
          mkdirSync(trialDir, { recursive: true });
          writeFileSync(join(trialDir, fileName), content);
          phases.push({ phase, success: successByPhase.get(phase), log: `${rel}/${fileName}` });
        }
        result.sessionTrial = {
          trial: opts.trial ?? 1,
          full: fullFile ? `${rel}/full.jsonl` : undefined,
          phases,
        };
      } catch {
        /* leave sessionTrial unset */
      }
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    result.durationMs = Date.now() - start;
    await fake.close();
    restoreEvalEnv();
    if (!opts.keepWorkspace && !opts.stateDir) {
      rmSync(stateDir, { recursive: true, force: true });
    }
  }

  return result;
}

export function slug(s: string): string {
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

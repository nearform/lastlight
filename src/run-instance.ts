/**
 * Run ONE eval instance against the REAL production workflow with GitHub mocked.
 *
 * Flow:
 *   1. Start the fake GitHub (seeded from the instance's issue fixtures).
 *   2. (code-fix) Deterministically seed the workspace: fixture repo @ base
 *      commit + a local bare `origin` so `git push` works offline.
 *   3. Load the REAL workflow YAML (build / issue-triage / …) via the loader.
 *   4. runWorkflow with `sandbox` (default `"none"`; `"gondolin"` isolates the
 *      agent's tools in a QEMU micro-VM — see `opts.sandbox`), `githubApiBaseUrl
 *      → fake GitHub`, and an EMPTY approvalConfig so gates never pause. No real
 *      GitHub creds.
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
import type { Arm } from "./arm.js";
import { startFakeGitHub } from "./fake-github.js";
import { seedWorkspace, seedWorkspaceFromGit, seedWorkspacePrReview, isRealSha, type SeedResult } from "./seed.js";
import { collectMetrics, drainSessions, readSessionLog, listSessionFiles, concatJsonl } from "./metrics.js";
import { gradeBehavioral, gradeExecution, gradeTriage, gradeReview } from "./grade.js";

export interface RunInstanceOptions {
  /**
   * The comparison arm — the ONE thing that varies model selection across a
   * run. `arm.label` is recorded on the result; `arm.prepare(ctx)` supplies the
   * executor model + per-phase `models`/`variants` (forced model for `models`
   * arms, the merged per-step config for `config` arms); `arm.recordPhaseModel`
   * reports what each phase resolved to. The two run-type branches that used to
   * live here are now polymorphism behind this interface (see {@link Arm}).
   */
  arm: Arm;
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
  /** pr-review judge configuration. `beta` overrides `EVAL_F_BETA`/default; when
   * `withDiff` is set the PR diff is fed to the judge (higher fidelity for terse
   * comments, at the cost of Martian-offline parity). */
  judge?: { beta?: number; withDiff?: boolean };
  /**
   * Execution sandbox backend for the agent (defaults to `"none"`). `"gondolin"`
   * runs the agent's bash/file tools inside a QEMU micro-VM so it cannot read
   * host paths outside its workspace (the anti-spoil property) — crucially the
   * agent runtime and `github_*` tools stay in-process, so the fake GitHub
   * (`githubApiBaseUrl`) is still honoured. `"docker"`/`"smol"` run the whole
   * agent inside the container/VM and do NOT honour `githubApiBaseUrl`, so they
   * break the GitHub mock as wired today (a documented follow-up).
   */
  sandbox?: NonNullable<ExecutorConfig["sandbox"]>;
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
  // Three tier shapes: triage (no repo), pr-review (checkout PR head, review-only,
  // judge grade), and code-fix (everything else — seed a base checkout + execution
  // grade). Keeping these explicit avoids the old `!== "issue-triage"` binary
  // misclassifying pr-review as code-fix.
  const isPrReview = workflowName === "pr-review";
  const isCodeFix = !isPrReview && workflowName !== "issue-triage";

  const stateDir = opts.stateDir ?? mkdtempSync(join(tmpdir(), "ll-eval-"));
  const sessionsDir = join(stateDir, "agent-sessions");
  // The shim appends per-phase jsonl under <sessionsDir>/projects/<slug>/ and
  // does not create that parent recursively — pre-create it so token/cost
  // metrics are captured (collectMetrics reads those jsonl files).
  mkdirSync(join(sessionsDir, "projects"), { recursive: true });
  // The target number is the PR number for pr-review, else the issue number.
  const targetNumber = inst.pr?.number ?? inst.issue?.number ?? 1;
  const taskId = `${name}-${targetNumber}-${workflowName}-${slug(inst.instance_id)}`;
  const issueNumber = targetNumber;
  const branch = isCodeFix
    ? `lastlight/${slug(inst.instance_id)}`
    : isPrReview
      ? inst.pr?.head_ref ?? "main"
      : "main";

  // 1. Fake GitHub, seeded with the issue and/or PR.
  const fake = await startFakeGitHub({
    owner,
    repo: name,
    issues: inst.issue ? [inst.issue] : [],
    pulls: inst.pr ? [inst.pr] : [],
    existingLabels: inst.issue?.labels ?? [],
  });

  // Static-token mode: no App creds (so no real mint), a dummy token so the
  // GitHub extension loads, and point its Octokit at the fake. In a parallel
  // batch the caller installs this once (manageEnv: false) so concurrent runs
  // share one stable baseline instead of racing per-run env splices.
  const restoreEvalEnv = opts.manageEnv === false ? () => {} : applyEvalEnv();

  const result: InstanceResult = {
    instance_id: inst.instance_id,
    model: opts.arm.label,
    workflowSucceeded: false,
    inputTokens: 0,
    cachedTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    durationMs: 0,
    phases: [],
  };

  try {
    // 2. Seed the workspace for code-fix (triage needs no repo). A vendored
    //    fixture dir wins; otherwise a git-source case (real base SHA + real
    //    repo) is checked out from the repo-local cache. Either way the agent
    //    works in a pre-seeded dir with an offline origin — no GitHub clone.
    // Seed the repo into a `<workspace>/<repo>/` SUBDIRECTORY (production's nested
    // layout) and tell the executor to run the agent there (`config.repoSubdir`
    // below). That keeps the workflow scaffolding core stages at the workspace
    // root — AGENTS.md, .lastlight-skills/ — OUTSIDE the repo's git tree, so the
    // captured diff (5b') is the repo's change alone. We keep the SeedResult to
    // diff the agent's final tree against the seeded base (the agent commits +
    // pushes, so a `git diff HEAD` would be empty — we diff against the base).
    const repoSubdir = isCodeFix || isPrReview ? name : undefined;
    let seed: SeedResult | undefined;
    if (isCodeFix) {
      const fixtureDir = opts.datasetDir ? join(opts.datasetDir, "repos", inst.instance_id) : undefined;
      if (fixtureDir && existsSync(fixtureDir)) {
        seed = seedWorkspace({ stateDir, taskId, fixtureDir, branch, repoSubdir });
      } else if (isRealSha(inst.base_commit) && /^[^/]+\/[^/]+$/.test(inst.repo)) {
        seed = seedWorkspaceFromGit({ stateDir, taskId, repo: inst.repo, baseCommit: inst.base_commit, branch, repoSubdir });
      }
    } else if (isPrReview && inst.pr && /^[^/]+\/[^/]+$/.test(inst.repo)) {
      // Check out the PR HEAD into a `<repo>/` subdir (skills/pr-review's
      // pre-clone contract), with an offline origin carrying base + head.
      seed = seedWorkspacePrReview({
        stateDir,
        taskId,
        repo: inst.repo,
        pullNumber: inst.pr.number,
        baseRef: inst.pr.base_ref,
        headRef: inst.pr.head_ref,
        baseCommit: inst.pr.base_commit,
        headCommit: inst.pr.head_commit,
        repoSubdir,
      });
    }
    // The repo's working dir (the nested subdir when seeded) — where grading and
    // the diff run. Falls back to the workspace root if nothing was seeded.
    const repoDir = seed?.workDir ?? join(stateDir, "sandboxes", taskId);

    // 3. Real workflow definition + run context.
    const def = getWorkflow(workflowName);
    const ctx: TemplateContext = {
      owner,
      repo: name,
      issueNumber,
      issueTitle: (isPrReview ? inst.pr?.title : inst.issue?.title) ?? inst.instance_id,
      issueBody: (isPrReview ? inst.pr?.body : inst.issue?.body) ?? inst.problem_statement,
      issueLabels: inst.issue?.labels ?? [],
      commentBody: "",
      sender: "eval",
      branch,
      taskId,
      issueDir: `.lastlight/issue-${issueNumber}`,
      bootstrapLabel: "lastlight:bootstrap",
      // pr-review's Context block keys off `prNumber` — the skill goes straight
      // to github_get_pull_request when it's set (buildPhasePrompt dumps every
      // defined ctx field into the "Context:" block).
      ...(isPrReview && inst.pr ? { prNumber: inst.pr.number, prTitle: inst.pr.title } : {}),
      // No prePopulateBranch → the runner never clones from GitHub; the agent
      // works in the dir we seeded above (or an empty dir for triage).
    };

    // The arm supplies model selection in one shot: it patches `ctx.models`/
    // `ctx.variants` (config arms — EXACTLY as production's `simple.js`, so phase
    // `model: "{{models.X}}"` templates resolve) and returns the executor model
    // plus the `runWorkflow` `models`/`variants` args. `models` arms leave the
    // context untouched and return just their forced id.
    const prepared = opts.arm.prepare(ctx as Record<string, unknown>);

    const config: ExecutorConfig = {
      sandbox: opts.sandbox ?? "none",
      stateDir,
      sessionsDir,
      // Run the agent inside the pre-seeded `<workspace>/<repo>/` checkout (only
      // when we actually seeded one), matching production's nested layout. Core
      // nests `agentCwd` here without a clone; AGENTS.md/.lastlight-skills stay
      // at the workspace root, siblings outside the repo.
      repoSubdir: seed ? repoSubdir : undefined,
      // `config` arms let core pick per phase (this is only the fallback for
      // phases that resolve to nothing — the merged config's `default`); `models`
      // arms force their one id across every step.
      model: prepared.model,
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
    // The arm's prepared maps go to args 6 (models) and 9 (variants), matching
    // prod's runWorkflow call; `models` arms leave both undefined so every phase
    // falls back to config.model (one model everywhere).
    const flushTimer = fullFile ? setInterval(flushFull, 1000) : undefined;
    let wf;
    try {
      wf = await runWorkflow(
        def,
        ctx,
        config,
        callbacks,
        undefined,
        prepared.models,
        {},
        undefined,
        prepared.variants,
      );
    } finally {
      if (flushTimer) clearInterval(flushTimer);
    }

    result.workflowSucceeded = wf.success;
    // Record the model each phase resolved to — the arm forced id in `models`
    // mode, or the per-step model the merged config assigned in `config` mode
    // (mirrors core's selection for display; see config.ts).
    const phaseModelTemplates = new Map(def.phases.map((p) => [p.name, p.model]));
    result.phases = wf.phases.map((p) => ({
      phase: p.phase,
      success: p.success,
      model: opts.arm.recordPhaseModel(phaseModelTemplates.get(p.phase), p.phase),
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

    // 5b'. Capture the agent's changed files as a unified diff BEFORE grading
    // touches the tree (gradeExecution copies held-out tests in / `git apply`s
    // the test patch). Diff against the seeded base — the agent commits its work,
    // so a `git diff HEAD` would be empty. Always-on for code-fix (independent of
    // whether tests are configured), so the dashboard can browse what changed.
    if (isCodeFix && seed) {
      const patch = gitDiffAgainstBase(repoDir, seed.baseCommit);
      // Kept in-memory for the SWE-bench predictions.jsonl roll-up.
      result.model_patch = patch;
      // Also persist as a DISCRETE artifact beside the trial's logs
      // (execution.log, session jsonl) — same run-relative path scheme as
      // `executionLog`. It publishes with the rest of the run tree
      // (`build-site.ts` copies eval-results/ verbatim) and keeps the
      // live-polled scorecard.json lean (the heavy diff is stripped from it —
      // see writeScorecard). The dashboard fetches this file for the viewer.
      if (patch && trialDir) {
        try {
          mkdirSync(trialDir, { recursive: true });
          writeFileSync(join(trialDir, "changes.diff"), patch);
          result.modelPatchFile = `${opts.sessionTrialRel ?? trialDir}/changes.diff`;
        } catch {
          /* best-effort: a missing file just hides the dashboard "files" button */
        }
      }
    }

    // 5a. Behavioral grade (GitHub mutations).
    const behavioralExpect = gradeBehavioral(inst.expect_github, fake, { issueNumber, branch });
    const triage = gradeTriage(inst.triage_gold, fake, issueNumber);
    result.behavioral = {
      ok: behavioralExpect.ok && triage.ok,
      checks: [...behavioralExpect.checks, ...triage.checks],
    };

    // 5b-pr. PR-review grade (pr-review only): the submitted review scored
    // against the gold set by an LLM judge → precision / recall / F-beta. A judge
    // failure is surfaced as a harness error (the case is ungraded) rather than a
    // silent zero, so it doesn't masquerade as a real score.
    if (isPrReview && inst.review_gold) {
      const reviews = fake.submittedReviews(issueNumber);
      // Opt-in (`--judge-with-diff`): feed the PR diff to the judge so it can
      // resolve terse, location-anchored review comments. The diff is base..head,
      // already in the seeded workspace — no network.
      let diff: string | undefined;
      if (opts.judge?.withDiff && inst.pr && seed) {
        try {
          diff = execFileSync("git", ["diff", `${inst.pr.base_commit}..${inst.pr.head_commit}`], {
            cwd: repoDir,
            encoding: "utf8",
            maxBuffer: 64 * 1024 * 1024,
          });
        } catch {
          /* leave diff undefined — judge falls back to diff-blind */
        }
      }
      const rg = await gradeReview({ gold: inst.review_gold, reviews, beta: opts.judge?.beta, diff });
      result.review = {
        precision: rg.precision,
        recall: rg.recall,
        fbeta: rg.fbeta,
        beta: rg.beta,
        posted: rg.posted,
        gold: rg.gold,
        matched: rg.matched,
        falsePositives: rg.falsePositives,
        falseNegatives: rg.falseNegatives,
        trace: rg.trace,
      };
      if (rg.error) result.error = result.error ?? `review judge: ${rg.error}`;
    }

    // 5b. Execution grade (code-fix only). Two modes:
    //   - Default (suite): run the repo's own `test_cmd` on the agent's final
    //     tree, resolved iff it exits 0. Nothing held out, nothing applied.
    //   - Hold-out (`hold_out_tests`): SWE-bench style — apply the maintainer's
    //     `test_patch` the agent never saw and grade named FAIL_TO_PASS / PASS_TO_PASS.
    if (isCodeFix && (inst.test_cmd || inst.test_patch || inst.FAIL_TO_PASS?.length)) {
      const holdOut = !!inst.hold_out_tests;
      const heldOutDir = opts.datasetDir ? join(opts.datasetDir, "tests", inst.instance_id) : undefined;
      const exec = gradeExecution({
        workDir: repoDir,
        heldOutDir: holdOut ? heldOutDir : undefined,
        testPatch: holdOut ? inst.test_patch : undefined,
        failToPass: holdOut ? inst.FAIL_TO_PASS ?? [] : [],
        passToPass: holdOut ? inst.PASS_TO_PASS ?? [] : [],
        testCmd: inst.test_cmd,
        setupCmd: inst.setup_cmd,
      });
      result.resolved = exec.resolved;
      result.failToPass = exec.failToPass;
      result.passToPass = exec.passToPass;
      // (model_patch is captured in 5b' above, before grading mutates the tree.)
      // Persist the held-out test output (setup log + TAP) so the dashboard can
      // show WHY a case was (un)resolved, not just the verdict. Lives beside the
      // trial's session logs, referenced by the same run-relative path scheme.
      if (trialDir) {
        try {
          mkdirSync(trialDir, { recursive: true });
          writeFileSync(join(trialDir, "execution.log"), exec.raw ?? "");
          result.executionLog = `${opts.sessionTrialRel ?? trialDir}/execution.log`;
        } catch {
          /* best-effort: a missing log just hides the dashboard link */
        }
      }
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

/**
 * Unified diff of the agent's final tree vs the seeded `base` commit — capturing
 * committed, uncommitted AND new/deleted files. Run inside the repo subdir, so
 * workflow scaffolding (AGENTS.md, .lastlight-skills/) at the workspace root is
 * naturally out of scope, and `git add -A` honours the repo's ignores (incl. the
 * harness's `node_modules` exclude from {@link seedWorkspace}) — so the diff is
 * the repo's own change alone. Staged into a throwaway index (`GIT_INDEX_FILE`)
 * so the repo's real index is untouched and the later `gradeExecution`
 * `git apply` still works.
 */
export function gitDiffAgainstBase(workDir: string, base: string): string | undefined {
  const tmpIndex = join(workDir, ".git", `eval-index-${process.pid}`);
  const env = { ...process.env, GIT_INDEX_FILE: tmpIndex };
  try {
    execFileSync("git", ["read-tree", base], { cwd: workDir, env, stdio: "ignore" });
    execFileSync("git", ["add", "-A"], { cwd: workDir, env, stdio: "ignore" });
    const out = execFileSync("git", ["diff", "--cached", base], {
      cwd: workDir,
      env,
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    }).toString();
    return out || undefined;
  } catch {
    return undefined;
  } finally {
    rmSync(tmpIndex, { force: true });
  }
}

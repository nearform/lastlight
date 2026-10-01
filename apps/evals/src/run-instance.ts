/**
 * Run ONE eval instance against the REAL production workflow with GitHub mocked.
 *
 * Flow:
 *   1. Start the fake GitHub (seeded from the instance's issue fixtures).
 *   2. (code-fix) Deterministically seed the workspace: fixture repo @ base
 *      commit + a local bare `origin` so `git push` works offline.
 *   3. Load the REAL workflow YAML (build / issue-triage / …) via the loader,
 *      and resolve the target repo's committed `.lastlight/` config layer (if
 *      the case declares one) through core's own dispatch-time resolver.
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

import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  getWorkflow,
  resolveReviewGitHubClient,
  runWorkflow,
  type ExecutorConfig,
  type TemplateContext,
  type RunnerCallbacks,
} from "lastlight-core/evals";

import type { SweBenchInstance, InstanceResult, PhaseSession } from "./schema.js";
import type { Arm } from "./arm.js";
import { modelTemplateForRow } from "./phase-models.js";
import { startFakeGitHub } from "./fake-github.js";
import { appliedRepoConfigKeys, loadRepoConfigFixture, resolveEvalRepoConfig, type RepoConfigClient } from "./repo-config.js";
import { seedWorkspace, seedWorkspaceFromGit, seedWorkspacePrReview, prFilesFromGit, mergeBaseOf, isRealSha, injectRepoContext, checkoutRound, type SeedResult } from "./seed.js";
import {
  collectMetrics,
  collectMetricsFromFiles,
  bucketSessionsByPhase,
  drainSessions,
  readSessionLog,
  listSessionFiles,
  concatJsonl,
} from "./metrics.js";
import { modelCost } from "./env.js";
import { gradeBehavioral, gradeExecution, gradeTriage, gradeReview, gradeInternalRecall, gradeMarkers } from "./grade.js";
import { readPipelineStats, persistPipelineArtifacts, internalJudgeInputs, withInternalRecall } from "./review-pipeline-stats.js";
import { writeStoredRunContext } from "./phase-replay-context.js";
import { caseHeadSha, prContextPatch, type PrStateSeed, type ReviewOverride } from "./pr-context.js";
import { resolveFactsBin } from "./paths.js";
import type { RereviewRound } from "./schema.js";
import type { PriorReview } from "lastlight-code-facts";
import type { InMemoryStateStore } from "lastlight-workflow-engine/test-support";
import {
  coverageSummary,
  deltaCounts,
  dispositionCounts,
  goldMatchedOf,
  ledgerCounts,
  planRounds,
  rollupRereview,
  type DispositionRowLike,
} from "./rereview.js";
import {
  carryForward,
  createRoundStore,
  fileAt,
  judgeComments,
  outdatedResolver,
  readFreshJson,
  ROUND_ARTIFACTS,
  roundScratch,
  scratchCoverage,
  scratchLedger,
  snapshotMtimes,
  UnitsOracle,
  type RoundUnit,
} from "./rereview-node.js";

/**
 * How far the fake's clock moves between two review rounds of a chained case,
 * so round k+1's reviews and threads are strictly later than round k's — the
 * order `lastBotReview` and every "latest review" read depends on.
 */
const ROUND_GAP_MS = 60 * 60 * 1000;

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
  /** Dataset dir holding `repos/<id>` (fixture) + `tests/<id>` (held-out), and —
   * for pr-review context injection — `context/<id>/`. */
  datasetDir?: string;
  /** The active deployment overlay dir (`--overlay`), used to resolve a GENERIC
   * repo-context block from `<overlayDir>/repo-context/AGENTS.md|CLAUDE.md` that
   * is injected into EVERY pr-review checkout. Undefined ⇒ no generic block. */
  overlayDir?: string;
  /** Inject synthetic repo-context (`<overlay>/repo-context/` +
   * `<datasetDir>/context/<id>/`) into the pr-review checkout so the reviewing
   * agent reads it (see {@link injectRepoContext}). Defaults to `true`; set false
   * (`--no-inject-context`) for a clean control run in an A/B. */
  injectContext?: boolean;
  /** Default workflow when the instance doesn't name one. */
  defaultWorkflow?: string;
  /**
   * Keep the trial's workspace instead of deleting it, and record its path on
   * the result as {@link InstanceResult.workspaceDir}.
   *
   * The evidence pipeline's whole output is files under
   * `<stateDir>/sandboxes/<taskId>/.lastlight/pr-review/` — `facts.json`, the
   * rendered obligation blocks, `hypotheses/<family>.jsonl`, `probes/env.json`
   * and WP4's probe transcripts. The `finally` below removed all of it, so the
   * only way to read an artifact was to catch a live run mid-flight. Off by
   * default because a kept workspace is a full checkout (plus `node_modules`
   * once `prepare` runs), which across a 50-case batch is tens of gigabytes.
   */
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

const EVAL_ENV_KEYS = [
  "GITHUB_APP_ID",
  "GITHUB_APP_INSTALLATION_ID",
  "GITHUB_TOKEN",
  "GH_TOKEN",
  "GITHUB_API_URL",
  "LASTLIGHT_FACTS_BIN",
];

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
  // Thread the facts binary into the run env the workflow's bash phases read.
  // `resolveFactsBin` was provenance-only until 2026-08-25, when a shell without
  // `LASTLIGHT_FACTS_BIN` ran the whole pr-review ladder with the conservation
  // gate and the reconcile floor exiting 127 on every case — every adjudication
  // ran to max_iterations and the scorecard's only witness was `factsBin: null`.
  // Respect an operator's explicit value; only fill the gap.
  if (!process.env.LASTLIGHT_FACTS_BIN) {
    const facts = resolveFactsBin();
    if (facts) process.env.LASTLIGHT_FACTS_BIN = facts;
  }
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
  // `dependabot-pr-merge` decides a merge through the GitHub tools and never
  // touches a checkout — production gives it no pre-clone either. Seeding it a
  // workspace would be inventing a code path it does not have.
  const NO_WORKSPACE = new Set(["issue-triage", "dependabot-pr-merge"]);
  const isCodeFix = !isPrReview && !NO_WORKSPACE.has(workflowName);
  // A chained re-review case (issue #429) — `null` for every case that runs
  // once, which then takes exactly the path it always took. Validated before
  // anything starts: a malformed chain is a case error, not a silent one-round run.
  let rounds: ReturnType<typeof planRounds> = null;
  let roundsError: string | undefined;
  try {
    rounds = isPrReview ? planRounds(inst) : null;
  } catch (err) {
    roundsError = (err as Error).message;
  }

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

  // 1. Fake GitHub, seeded with the issue and/or PR — plus the repo's committed
  //    `.lastlight/` tree when the case ships one at
  //    `<datasetDir>/lastlight/<instance_id>/`. No fixture ⇒ the mock reports the
  //    repo as having no layer, which is every case that predates issue #180.
  const fake = await startFakeGitHub({
    owner,
    repo: name,
    // The PR's linked issues join the issue store so the `closingIssuesReferences`
    // GraphQL route can resolve the body's `Closes #N` against real content —
    // the first end of the `spec` axis. Content here, linkage in the fake.
    issues: [...(inst.issue ? [inst.issue] : []), ...(inst.pr?.linked_issues ?? [])],
    pulls: inst.pr ? [inst.pr] : [],
    // A chained case releases seeded discussion round by round (`from_round`).
    chained: !!rounds,
    // The CI-read tools (`github_list_workflow_runs` / `..._run_jobs` /
    // `github_get_job_logs`) served from the SAME seed that produces the
    // prompt's `{{ciSection}}`, so digging into the logs corroborates what the
    // agent was told rather than contradicting it. Absent seed ⇒ the routes stay
    // 404, which is this file's loud default.
    ...(inst.pr_state?.ci_jobs?.length
      ? {
          actions: {
            headSha: caseHeadSha(inst),
            headBranch: inst.pr_state.head_ref,
            jobs: inst.pr_state.ci_jobs.map((j) => ({
              name: j.name,
              conclusion: j.conclusion,
              log: j.log_excerpt,
              workflowPath: j.workflow_path,
              failingStep: j.failing_step,
            })),
          },
        }
      : {}),
    existingLabels: inst.issue?.labels ?? [],
    repoConfig: loadRepoConfigFixture(opts.datasetDir, inst.instance_id),
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
    if (roundsError) throw new Error(roundsError);
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
        // `repos-head/<id>/` — the PR's own commit, applied on the branch over
        // the base tree. Presence IS the declaration, like every other
        // per-instance dir here. Without it base and head are identical, and a
        // diagnosing agent that asks "is main broken too?" correctly answers
        // yes — turning every red-dependency case into `upstream-broken`.
        const headDir = opts.datasetDir
          ? join(opts.datasetDir, "repos-head", inst.instance_id)
          : undefined;
        seed = seedWorkspace({
          stateDir,
          taskId,
          fixtureDir,
          branch,
          repoSubdir,
          headDir,
          headMessage: inst.pr?.title,
        });
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
        ...(rounds ? { roundCommits: rounds.map((r) => r.head_commit) } : {}),
        repoSubdir,
      });
    }
    // The repo's working dir (the nested subdir when seeded) — where grading and
    // the diff run. Falls back to the workspace root if nothing was seeded.
    const repoDir = seed?.workDir ?? join(stateDir, "sandboxes", taskId);

    // Every round of a case runs the same workflow definition.
    const def = getWorkflow(workflowName);
    const trialDir = opts.sessionTrialDir;

    /**
     * One dispatch of the workflow: serve the head's changed files, inject the
     * repo context, build the context from the snapshot, resolve the repo layer
     * and run. A single-round case calls it once; a chained case
     * (`inst.rounds`) once per round head, in order (see below).
     */
    const executeRound = async (round: {
      /** The head this dispatch reviews. */
      head: string;
      /** The `pr_state` seed: the case's, with a chained round's carried fields over it. */
      seed: PrStateSeed | undefined;
      sessionsDir: string;
      store?: InMemoryStateStore;
      workflowId?: string;
    }) => {
      // Serve the PR's changed files at GET /pulls/:n/files (pr-review): computed
      // from base..head in the just-seeded workspace, so a review agent that lists
      // files via the API gets the real changed set instead of a 404.
      //
      // KEPT, not discarded: this same set is the SECOND END of every `spec`
      // obligation, and in production `resolveSpecContext` reads it from
      // `listPullRequestFilePaths` at the dispatch choke point. The eval never
      // calls that (it builds the snapshot itself), so without threading it into
      // `prContextPatch` below `changedFiles` stays `null`, `buildSpecObligations`
      // correctly refuses to emit a one-ended seed, and the whole spec family —
      // the one axis nothing else has tried — spends a model call reporting that
      // it cannot work. Deriving it here rather than seeding it per case keeps the
      // two ends from drifting apart and covers every case for free.
      let prFilePaths: string[] | undefined;
      if (isPrReview && inst.pr && seed) {
        // Against the merge base, as GitHub computes a PR's files: a chained
        // case's earlier heads forked from an older base than the case's (the
        // branch merged or rebased onto main since), and a two-dot diff from
        // the newer base would list main's later changes as the PR's.
        const files = prFilesFromGit(repoDir, mergeBaseOf(repoDir, inst.pr.base_commit, round.head), round.head);
        fake.setPullFiles(inst.pr.number, files);
        prFilePaths = files.map((f) => f.filename);
      } else if (inst.pr?.files?.length) {
        // A tier with no checkout (dependency-merge) states its diff in the case
        // instead. Same registration, so `GET /pulls/:n/files` and the patch
        // `github_get_pull_request_diff` returns come from one source.
        fake.setPullFiles(inst.pr.number, inst.pr.files);
        prFilePaths = inst.pr.files.map((f) => f.filename);
      }

      // 2b. Inject synthetic repo-context into the pr-review checkout so the
      //     reviewing agent reads it — a GENERIC block from the overlay (applies to
      //     every repo) + a PER-REPO block from the tier dataset. The Pi runtime
      //     auto-loads AGENTS.md/CLAUDE.md walking up from the agent cwd (= the repo
      //     dir), so this reaches the model with no prompt change. Faithful to what a
      //     maintainer could commit, so a kept improvement is a portable "add this to
      //     your repo" recommendation. Records provenance for inspectability.
      if (isPrReview && seed && (opts.injectContext ?? true)) {
        const sources = resolveInjectedContext({
          overlayDir: opts.overlayDir,
          datasetDir: opts.datasetDir,
          instanceId: inst.instance_id,
        });
        if (sources.length) {
          const combined = sources.map((s) => s.text.trim()).filter(Boolean).join("\n\n");
          if (injectRepoContext(seed.workDir, combined)) {
            result.injectedContext = sources.map((s) => ({
              source: s.source,
              path: s.path,
              bytes: Buffer.byteLength(s.text, "utf8"),
            }));
          }
        }
      }

      // 3. The run context (the workflow definition is resolved once, above).
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
        // defined ctx field into the "Context:" block). `baseBranch` is what the
        // deterministic `post-review` phase reads to compute the commentable diff
        // (`git diff origin/<baseBranch>...HEAD`) — WITHOUT it every finding is
        // demoted to the review body and the line-anchored inline-comment path
        // (the point of the tier) never fires. Prod sets it from the PR's base ref;
        // the eval must too, or it diverges from what ships.
        ...(isPrReview && inst.pr
          ? { prNumber: inst.pr.number, prTitle: inst.pr.title, baseBranch: inst.pr.base_ref }
          : {}),
        // No prePopulateBranch → the runner never clones from GitHub; the agent
        // works in the dir we seeded above (or an empty dir for triage).
      };

      // 3a. The PR state machine's projection (issues #251, #252).
      //
      // A PR-scoped workflow is dispatched in production, never called: the
      // dispatcher resolves one `PrState` snapshot and `renderContext` projects it
      // into the context. That projection IS what the fix and merge prompts reason
      // with — `{{ciSection}}`, `{{attempt}}`, `{{mayMerge}}`, `{{priorNotes}}`,
      // `{{verifyScript}}` — so running them off a hand-built context measures a
      // workflow production does not have. `./pr-context.ts` builds the snapshot a
      // case seeds and hands it to CORE's projection, unmodified.
      //
      // Gated on the workflow's own `pr_scoped: true` metadata rather than a name
      // list here — the same fact core derives `prScopedWorkflows()` from, so an
      // overlay's forked fix workflow is covered without a change to this file.
      //
      // `pr-review` USED TO BE excluded here, and the exclusion was about scores,
      // not about correctness: pr-review is judge-scored and its numbers are
      // compared across runs and against Martian's leaderboard, so enriching its
      // context would move every historical figure as a side effect of a change
      // that was not about them.
      //
      // The exclusion was LIFTED DELIBERATELY on 2026-08-22. It had made the
      // review evidence pipeline unmeasurable on the only tier its gates are read
      // on: with no `prContextPatch`, core's `renderContext` never runs, the
      // context never gets `analysisEnabled`, and every WP3 phase in
      // `pr-review.yaml` matches `skip_if: "analysisEnabled != true"` and skips.
      // WP0's `{{specObligations}}` was unmeasurable there for the same reason.
      // The choice was between a pipeline that cannot be measured and a baseline
      // that has to be re-run; the baseline is being re-run.
      //
      // THEREFORE: every pr-review number produced BEFORE 2026-08-22 was measured
      // on a different template context and must NOT be compared across that
      // boundary — not in `diff-runs.ts`, not against `2026-08-20_074355`, not
      // against the leaderboard entry that run backed. Re-baseline instead.
      const wantsPrContext = (def as { pr_scoped?: boolean }).pr_scoped === true || !!inst.pr_state;
      if (wantsPrContext) {
        Object.assign(
          ctx,
          await prContextPatch({
            repo: `${owner}/${name}`,
            prNumber: inst.pr?.number ?? issueNumber,
            title: inst.pr?.title ?? inst.issue?.title ?? inst.instance_id,
            body: inst.pr?.body ?? inst.issue?.body ?? inst.problem_statement,
            branch,
            seed: round.seed,
            baseRef: inst.pr?.base_ref,
            // The real head — the round's, or the PR's (`caseHeadSha`): never the
            // placeholder when the case names a real commit.
            ...(isRealSha(round.head) ? { headSha: round.head } : {}),
            // A chained case projects the snapshot itself too (`ctx.prState`), as
            // `dispatchWorkflow` does: post-review reads the ledger it was
            // dispatched with off it. Single-round cases keep the old context.
            snapshot: !!rounds,
            // A REAL `GitHubClient` pointed at the fake — the same construction
            // `post-review` already uses against the mock. Core's own
            // `resolveSpecContext` then reads BOTH ends of the spec axis through
            // it, so the eval exercises the production code path (GraphQL
            // `closingIssuesReferences` + `GET /pulls/:n/files`) rather than a
            // harness copy of it. `setPullFiles` above is what the second read
            // hits, so it must already have run — it has.
            github: resolveReviewGitHubClient({ githubApiBaseUrl: fake.url }),
            // Retained as the fallback for a tier with no live client: a case that
            // seeds `pr_state.changed_files` still wins — including seeding `[]`,
            // which asserts "this PR changes nothing" rather than "we could not
            // read it". Those must stay distinguishable (locked decision 6).
            changedFiles: prFilePaths,
            // The arm's own `review:` policy — the overlay's, never gold's. This
            // is the seam that turns the evidence pipeline on for the `wp3` arm
            // and leaves it off for `baseline`, with no per-case special-casing:
            // `baseline/config.yaml` simply declares no `analysis` block.
            review: opts.arm.review as ReviewOverride | undefined,
          }),
        );
      }

      // The arm supplies model selection in one shot: it patches `ctx.models`/
      // `ctx.variants` (config arms — EXACTLY as production's `simple.js`, so phase
      // `model: "{{models.X}}"` templates resolve) and returns the executor model
      // plus the `runWorkflow` `models`/`variants` args. `models` arms leave the
      // context untouched and return just their forced id.
      const prepared = opts.arm.prepare(ctx as Record<string, unknown>);

      // 3b. The target repo's `.lastlight/` config layer (issue #180), resolved
      //     through core's OWN dispatch-time resolver against the mock — fetch →
      //     sanitize → unpack → merge, unmodified. Undefined for a repo with no
      //     `.lastlight/`, in which case `runWorkflow` below is called exactly as
      //     it was before the feature existed. Never throws: the resolver's whole
      //     contract is "warn, drop the bad bits, run anyway".
      const repoRun = await resolveEvalRepoConfig({
        repo: `${owner}/${name}`,
        workflowName,
        client: fake as unknown as RepoConfigClient,
        models: prepared.models,
        variants: prepared.variants,
        defaultModel: prepared.model,
        cacheRoot: join(stateDir, "repo-config"),
      });
      if (repoRun.repoConfig) {
        result.repoLayer = {
          repo: repoRun.repoConfig.repo,
          defaultBranch: repoRun.repoConfig.defaultBranch,
          treeSha: repoRun.repoConfig.treeSha,
          assets: [...repoRun.repoConfig.assets],
          applied: appliedRepoConfigKeys(repoRun.repoConfig),
          warnings: repoRun.repoConfig.warnings.map((w) => `${w.code}: ${w.message}`),
        };
      }
      // The repo opting ITSELF out of this workflow in `.lastlight/lastlight.yml`.
      // Production abandons the dispatch here — no run, no agent call — so the
      // case is `blocked` (a deliberate measured outcome), not an error.
      if (repoRun.refusal) {
        result.blocked = true;
        result.repoLayer = { ...(result.repoLayer ?? { repo: `${owner}/${name}` }), refused: repoRun.refusal };
        result.behavioral = gradeBehavioral(inst.expect_github, fake, { issueNumber, branch });
        result.githubMutations = fake.calls.length;
        return { refused: true as const };
      }

      const config: ExecutorConfig = {
        sandbox: opts.sandbox ?? "none",
        stateDir,
        sessionsDir: round.sessionsDir,
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

      // Phase windows: `onPhaseStart`/`onPhaseEnd` bracket each phase, and the
      // pair is what makes a phase's duration MEASURED rather than inferred from
      // the next phase's start — which would silently bill the gap between phases
      // (workspace refresh, the `until_bash` container spin-up) to whichever phase
      // happened to precede it.
      //
      // `phaseStarts` additionally backs the FALLBACK attribution rule in
      // `bucketSessionsByPhase`. Sessions now carry their owning phase as a stamp,
      // so the windows are only consulted for jsonl archived before that stamp
      // existed; see that function for why a start-time lookup cannot attribute a
      // fan-out at all.
      const phaseStarts: { phase: string; start: number }[] = [];
      const phaseWindows = new Map<string, { start: number; end?: number }>();
      const callbacks: RunnerCallbacks = {
        onPhaseStart: async (phase) => {
          const now = Date.now();
          phaseStarts.push({ phase, start: now });
          // First start wins: a label the engine re-announces (a loop node whose
          // condition-met entry repeats it) must not restart its own clock.
          if (!phaseWindows.has(phase)) phaseWindows.set(phase, { start: now });
        },
        onPhaseEnd: async (phase) => {
          const w = phaseWindows.get(phase);
          if (w) w.end = Date.now();
        },
      };

      const fullFile = trialDir ? join(trialDir, "full.jsonl") : undefined;
      // Flush the consolidated transcript atomically (so a polling dashboard never
      // reads a half-written file): on a timer while running (follow-along), and
      // once at the end. Best-effort — a flush failure must never affect the run.
      const flushFull = () => {
        if (!fullFile || !trialDir) return;
        try {
          const log = readSessionLog(round.sessionsDir);
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
      // falls back to config.model (one model everywhere). The 10th arg is the
      // repo layer — `undefined` for a repo with no `.lastlight/`, which is the
      // pre-#180 call byte-for-byte. The 5th/8th (store, workflow id) are unset
      // for a single-round case — no db, so every gate is inert — and, for a
      // chained case, the in-memory run store post-review persists the review
      // ledger to (`rereview-node.ts`); `approvalConfig` stays empty either way.
      const flushTimer = fullFile ? setInterval(flushFull, 1000) : undefined;
      let wf;
      try {
        wf = await runWorkflow(
          def,
          ctx,
          config,
          callbacks,
          round.store as never,
          prepared.models,
          {},
          round.workflowId,
          prepared.variants,
          repoRun.repoConfig,
        );
      } finally {
        if (flushTimer) clearInterval(flushTimer);
      }
      return { wf, ctx, prepared, phaseStarts, phaseWindows, flushFull, fullFile };
    };

    // ── Chained re-review rounds (issue #429) ──────────────────────────────
    //
    // A case with `rounds` runs the real workflow once per earlier head, in
    // order, before the scored last round below — one fake GitHub (round k's
    // review and threads are what round k+1 reads), one per-PR workspace
    // (checked out to each head, its `.lastlight/pr-review/` carried as a
    // reused production workspace carries it), and one in-memory run store, so
    // post-review persists the review ledger to the round's run scratch and the
    // next round is dispatched with it through core's `deriveReviewLedger`.
    const store = rounds ? createRoundStore() : undefined;
    const roundRecords: RereviewRound[] = [];
    let roundSeed: PrStateSeed | undefined = inst.pr_state;
    let currentHead = rounds ? rounds[0]!.head_commit : caseHeadSha(inst);
    const prDir = join(repoDir, ".lastlight", "pr-review");
    const heads = rounds?.map((r) => r.head_commit) ?? [];
    const factsBin = rounds ? resolveFactsBin() : null;
    const oracle =
      rounds && factsBin && inst.pr
        ? new UnitsOracle({ repoDir, base: inst.pr.base_commit, factsBin, root: join(stateDir, "rereview-oracle") })
        : undefined;
    if (rounds && inst.pr && seed) {
      fake.setOutdatedResolver(outdatedResolver(repoDir, () => currentHead));
    }

    /**
     * What one finished round measured — everything but the grade and the
     * spend, which the caller adds (the last round's come from the case's own).
     */
    const measureRound = async (k: number, before: Map<string, number | null>, wfOk: { success: boolean; error?: string }) => {
      const head = heads[k]!;
      const reviews = fake.submittedReviews(inst.pr!.number);
      const inline = reviews.flatMap((r) => r.comments);
      const disposition = readFreshJson(prDir, "disposition.json", before) as { findings?: DispositionRowLike[] } | undefined;
      const scratch = store ? await roundScratch(store, roundWorkflowId(k)) : {};
      const record: RereviewRound = {
        round: k + 1,
        headSha: head,
        ...(rounds![k]!.label ? { label: rounds![k]!.label } : {}),
        workflowSucceeded: wfOk.success,
        ...(wfOk.error ? { error: wfOk.error } : {}),
        ...(reviews.length ? { event: reviews.at(-1)!.event } : {}),
        inlinePosted: inline.length,
        ...(disposition?.findings ? dispositionCounts(disposition.findings) : {}),
        costUsd: 0,
        inputTokens: 0,
        cachedTokens: 0,
        outputTokens: 0,
        durationMs: 0,
      };
      const coverage = coverageSummary(scratchCoverage(scratch) ?? readFreshJson(prDir, "review-coverage.json", before));
      if (coverage) record.coverage = coverage;
      const ledger = ledgerCounts(scratchLedger(scratch) as never);
      if (ledger) record.ledger = ledger;

      // Late discoveries: round ≥ 2 only. The round's OWN units and prior
      // review when its pipeline cut them (what its convergence gate saw);
      // otherwise the harness's oracle cut over the same two heads, so an arm
      // that runs no pipeline is measured on the same instrument.
      if (k >= 1) {
        const ownUnits = readFreshJson(prDir, "units.json", before) as { units?: RoundUnit[] } | undefined;
        const ownPrior = readFreshJson(prDir, "prior-review.json", before) as PriorReview | undefined;
        let units: RoundUnit[] | undefined;
        let prior: PriorReview | null | undefined;
        if (ownUnits?.units?.length && ownPrior) {
          units = ownUnits.units;
          prior = ownPrior;
          record.lateDiscoverySource = "units.json";
        } else if (oracle) {
          try {
            units = oracle.at(heads, k).units;
            prior = oracle.priorFor(heads, k);
            record.lateDiscoverySource = "oracle";
          } catch (err) {
            record.lateDiscoveryUnavailable = `oracle units cut failed: ${(err as Error).message.slice(0, 200)}`;
          }
        } else {
          record.lateDiscoveryUnavailable = "no units.json/prior-review.json this round and no lastlight-facts binary for the oracle";
        }
        if (units && prior !== undefined) {
          const verdicts = judgeComments({
            comments: inline.map((c) => ({ path: c.path, ...(c.line !== undefined ? { line: c.line } : {}), ...(c.start_line !== undefined ? { start_line: c.start_line } : {}) })),
            prior,
            units,
            fileText: (path) => fileAt(repoDir, head, path),
          });
          record.lateDiscovery = verdicts.filter((v) => v.verdict === "unchanged").length;
          record.lateDiscoveryOf = verdicts.filter((v) => v.verdict !== null).length;
          const delta = deltaCounts(units);
          if (delta) record.delta = delta;
          roundVerdicts.set(k, verdicts);
        }
      }
      return { record, reviews, scratch, disposition };
    };
    const roundWorkflowId = (k: number) => `${taskId}:round-${k + 1}`;
    const roundVerdicts = new Map<number, unknown[]>();

    /** A round's evidence, beside its artifacts: what it posted, its dispositions, the ledger it left, the late-discovery verdicts. */
    const archiveRound = (k: number, m: Awaited<ReturnType<typeof measureRound>>, extra: { sessionsDir?: string } = {}): string | undefined => {
      if (!trialDir) return undefined;
      const dir = join(trialDir, `round-${k + 1}`);
      try {
        mkdirSync(dir, { recursive: true });
        if (extra.sessionsDir) {
          const log = readSessionLog(extra.sessionsDir);
          if (log) writeFileSync(join(dir, "full.jsonl"), log);
          persistPipelineArtifacts(repoDir, dir);
        }
        writeFileSync(
          join(dir, "round.json"),
          `${JSON.stringify(
            {
              round: k + 1,
              head: heads[k],
              reviews: m.reviews,
              disposition: m.disposition ?? null,
              reviewLedger: scratchLedger(m.scratch) ?? null,
              reviewCoverage: scratchCoverage(m.scratch) ?? null,
              lateDiscovery: roundVerdicts.get(k) ?? null,
              dispatched: roundSeed ?? null,
            },
            null,
            2,
          )}\n`,
        );
        return `${opts.sessionTrialRel ?? trialDir}/round-${k + 1}`;
      } catch {
        return undefined;
      }
    };

    if (rounds && inst.pr && seed) {
      for (let k = 0; k < rounds.length - 1; k++) {
        const head = heads[k]!;
        if (k > 0) {
          checkoutRound(repoDir, seed.branch, head);
          fake.advanceClock(ROUND_GAP_MS);
        }
        currentHead = head;
        fake.setHead(inst.pr.number, head);
        fake.startRound(k + 1);
        const sessionsDirK = join(stateDir, `agent-sessions-round-${k + 1}`);
        mkdirSync(join(sessionsDirK, "projects"), { recursive: true });
        const before = snapshotMtimes(prDir, ROUND_ARTIFACTS);
        const startedAt = Date.now();
        const seedK: PrStateSeed = { ...(roundSeed ?? {}), head_sha: head };
        roundSeed = seedK;
        const ran = await executeRound({ head, seed: seedK, sessionsDir: sessionsDirK, store, workflowId: roundWorkflowId(k) });
        if ("refused" in ran) return result;
        await drainSessions(sessionsDirK);
        const failed = ran.wf.phases.find((p) => !p.success && p.error);
        const m = await measureRound(k, before, {
          success: ran.wf.success,
          ...(failed?.error ? { error: `${failed.phase}: ${failed.error}`.slice(0, 300) } : {}),
        });
        const cost = collectMetrics(sessionsDirK, modelCost(ran.prepared.model));
        Object.assign(m.record, {
          costUsd: cost.costUsd,
          inputTokens: cost.inputTokens,
          cachedTokens: cost.cachedTokens,
          outputTokens: cost.outputTokens,
          durationMs: Date.now() - startedAt,
        });
        // The round's own grade, for cumulative recall — the same judge and
        // gold as the scored round, over the review THIS round posted.
        if (inst.review_gold) {
          const rg = await gradeReview({ gold: inst.review_gold, reviews: m.reviews, beta: opts.judge?.beta, neutralGold: inst.review_gold_neutral });
          const matched = goldMatchedOf(rg.trace);
          if (!rg.error && matched) {
            m.record.goldMatched = matched;
            m.record.postedFindings = rg.posted;
          }
        }
        const rel = archiveRound(k, m, { sessionsDir: sessionsDirK });
        if (rel) m.record.artifactRel = rel;
        roundRecords.push(m.record);
        // Recorded as it goes, so a later round that throws still leaves the
        // rounds that ran on the result (re-rolled with the last round below).
        result.rereview = rollupRereview(roundRecords, inst.review_gold?.length);
        // What the next round is dispatched with.
        roundSeed = {
          ...(inst.pr_state ?? {}),
          ...carryForward({
            repoDir,
            baseCommit: inst.pr.base_commit,
            prevHead: head,
            nextHead: heads[k + 1]!,
            reviews: m.reviews,
            prev: seedK,
            scratch: m.scratch,
          }),
        };
      }
      // The scored round: the PR's own head.
      checkoutRound(repoDir, seed.branch, inst.pr.head_commit);
      fake.advanceClock(ROUND_GAP_MS);
      currentHead = inst.pr.head_commit;
      fake.setHead(inst.pr.number, inst.pr.head_commit);
      fake.startRound(rounds.length);
    }
    const finalBefore = rounds ? snapshotMtimes(prDir, ROUND_ARTIFACTS) : undefined;
    const finalStartedAt = Date.now();
    const ran = await executeRound({
      // Single-round: the PR's own head (its files are what GET /pulls/:n/files
      // always served), else the snapshot's head for a PR-less case.
      head: inst.pr?.head_commit ?? caseHeadSha(inst),
      seed: roundSeed,
      sessionsDir,
      ...(store ? { store, workflowId: roundWorkflowId(rounds!.length - 1) } : {}),
    });
    if ("refused" in ran) return result;
    const { wf, ctx, prepared, phaseStarts, phaseWindows, flushFull, fullFile } = ran;

    result.workflowSucceeded = wf.success;
    // Record the model each phase resolved to — the arm forced id in `models`
    // mode, or the per-step model the merged config assigned in `config` mode
    // (mirrors core's selection for display; see config.ts). `wf.phases` rows
    // carry ledger labels (`survey_branch_contract`), not YAML names, so the
    // template lookup goes through modelTemplateForRow (phase-models.ts), which
    // parses branch rows back to their declaration via core's PhaseRef.
    result.phases = wf.phases.map((p) => {
      const { template, fallbackPhase } = modelTemplateForRow(def.phases, p.phase, p.modelTemplate);
      return {
        phase: p.phase,
        success: p.success,
        model: opts.arm.recordPhaseModel(template, p.phase, fallbackPhase),
      };
    });

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

    // 5a'. Marker grade (fix / dependency-merge). The verdict a run signs off
    // with is the deliverable for those tiers, and it touches no GitHub state —
    // so without this a diagnosis that reached the wrong class scores green.
    const markers = gradeMarkers(inst.expect_markers, wf.phases);
    if (inst.expect_markers) result.markers = markers;

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
      // The evidence pipeline's own telemetry, read off the artifacts it wrote.
      // Deliberately read HERE and not from the `--keep-workspace` branch below:
      // making the mechanism metrics conditional on a debugging flag is how they
      // came to be absent from every arm ever measured. `undefined` for a
      // baseline arm, which runs no pipeline and writes no artifacts.
      const readout = readPipelineStats(repoDir);
      // …and copied somewhere that outlives the workspace, before anything can
      // fail below. `sessionTrialDir` is in the run dir; `stateDir` is in
      // `os.tmpdir()`, which the OS empties. See `persistPipelineArtifacts`.
      if (opts.sessionTrialDir) {
        try {
          if (persistPipelineArtifacts(repoDir, opts.sessionTrialDir) && opts.sessionTrialRel)
            result.pipelineArtifactRel = `${opts.sessionTrialRel}/pr-review`;
          // The prompt context a phase REPLAY needs and cannot rebuild from
          // the artifacts: what `select` was told about the PR's earlier
          // conversation and review ledger (`phase-replay-node.ts`'s
          // `readStoredRunContext`). Beside `pr-review/`, never inside it — a
          // replay copies that dir into the checkout the agent works in.
          writeStoredRunContext(opts.sessionTrialDir, ctx as Record<string, unknown>);
        } catch (err) {
          // Never fail a measured run over its own bookkeeping — but a warning
          // on a background process IS functionally silent, which is the bug
          // this function exists to fix wearing a different hat. So the failure
          // is RECORDED on the result: `pipelineArtifactRel` stays unset (there
          // is nothing to point at) and `pipelineArtifactError` says why, so
          // downstream analysis can tell "this run had no artifacts" from
          // "this run's artifacts could not be written".
          const reason = err instanceof Error ? err.message : String(err);
          result.pipelineArtifactError = reason;
          console.warn(`could not persist pipeline artifacts: ${reason}`);
        }
      }
      const rg = await gradeReview({
        gold: inst.review_gold,
        reviews,
        beta: opts.judge?.beta,
        neutralGold: inst.review_gold_neutral,
        diff,
      });
      // Internal recall — gold matched by everything the pipeline GENERATED,
      // including what the attention boundary held back. One extra judge call
      // (MATCH only; `findings.json` needs no extraction), and it is what makes
      // "never found it" separable from "found it and did not say it".
      const internal = readout
        ? await gradeInternalRecall({ gold: inst.review_gold, findings: internalJudgeInputs(readout.findings), diff })
        : undefined;
      result.review = {
        precision: rg.precision,
        recall: rg.recall,
        fbeta: rg.fbeta,
        beta: rg.beta,
        posted: rg.posted,
        gold: rg.gold,
        matched: rg.matched,
        ...(rg.matchedFindings !== undefined ? { matchedFindings: rg.matchedFindings } : {}),
        ...(rg.postedRaw !== undefined ? { postedRaw: rg.postedRaw } : {}),
        ...(rg.neutralized !== undefined ? { neutralized: rg.neutralized } : {}),
        falsePositives: rg.falsePositives,
        falseNegatives: rg.falseNegatives,
        trace: rg.trace,
        ...(readout ? { pipeline: withInternalRecall(readout, internal) } : {}),
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
    // Price with the executor model's declared fallback rate (models.json `cost`),
    // applied only to phases whose transcript reports $0 — e.g. flat-rate plans
    // like kimi-coding, which carry no pay-as-you-go price. `config` arms with a
    // mixed per-phase model set are priced by their default model (best-effort;
    // the fallback only ever fires for a zero-cost model in the price table).
    const m = collectMetrics(sessionsDir, modelCost(prepared.model));
    result.inputTokens = m.inputTokens;
    result.cachedTokens = m.cachedTokens;
    result.outputTokens = m.outputTokens;
    result.costUsd = m.costUsd;
    result.githubMutations = fake.calls.length;

    // Session files + their phase attribution, computed ONCE: 5c' prices each
    // bucket and 5d archives it. Two passes would be two chances to disagree
    // about which phase a session belonged to.
    const sessionFiles = listSessionFiles(sessionsDir); // chronological
    const split = bucketSessionsByPhase(sessionFiles, phaseStarts);

    // 5c'. Per-phase attribution — the instrument the speed work is graded on.
    // Without it a scorecard says a case took 30 minutes and nothing about
    // WHERE, so every latency claim had to be read by hand out of transcripts.
    // Duration comes from the measured phase window; cost/tokens from that
    // phase's own session jsonl, through the same roll-up the case level uses.
    for (const pm of result.phases ?? []) {
      const w = phaseWindows.get(pm.phase);
      // Absent window ⇒ the phase never started (skipped). Leave it undefined:
      // see PhaseMetric.durationMs — 0 would read as "instant", not "not run".
      if (w?.end !== undefined) pm.durationMs = w.end - w.start;
      const files = split.buckets.get(pm.phase);
      if (!files?.length) continue;
      const pmM = collectMetricsFromFiles(files, modelCost(prepared.model));
      pm.inputTokens = pmM.inputTokens;
      pm.cachedTokens = pmM.cachedTokens;
      pm.outputTokens = pmM.outputTokens;
      pm.costUsd = pmM.costUsd;
      if (pmM.agentMs > 0) pm.agentMs = pmM.agentMs;
    }

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
        const { order, buckets } = split;
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

    // 5e. The chained case's last round, measured like the others, and the
    // roll-up. Its grade, spend and artifacts are the case's own (above).
    if (rounds && finalBefore) {
      const k = rounds.length - 1;
      const m = await measureRound(k, finalBefore, { success: wf.success, ...(result.error ? { error: result.error } : {}) });
      Object.assign(m.record, {
        costUsd: result.costUsd,
        inputTokens: result.inputTokens,
        cachedTokens: result.cachedTokens,
        outputTokens: result.outputTokens,
        durationMs: Date.now() - finalStartedAt,
      });
      const matched = result.review && !result.error?.startsWith("review judge") ? goldMatchedOf(result.review.trace) : null;
      if (matched) {
        m.record.goldMatched = matched;
        m.record.postedFindings = result.review!.posted;
      }
      const rel = archiveRound(k, m);
      if (rel) m.record.artifactRel = rel;
      roundRecords.push(m.record);
      result.rereview = rollupRereview(roundRecords, inst.review_gold?.length);
    }
  } catch (err) {
    result.error = err instanceof Error ? err.message : String(err);
  } finally {
    result.durationMs = Date.now() - start;
    await fake.close();
    restoreEvalEnv();
    if (!opts.keepWorkspace && !opts.stateDir) {
      rmSync(stateDir, { recursive: true, force: true });
    } else if (opts.keepWorkspace) {
      // Recorded rather than merely printed: the path has to survive into
      // `scorecard.json` or a batch of 8 kept workspaces is 8 temp dirs with
      // machine-generated names and no mapping back to a case.
      result.workspaceDir = stateDir;
    }
  }

  return result;
}

export function slug(s: string): string {
  return s.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40);
}

/**
 * Resolve the synthetic repo-context blocks to inject for a pr-review case, in
 * generic-then-per-repo order:
 *   1. GENERIC — `<overlayDir>/repo-context/AGENTS.md|CLAUDE.md` (applies to every
 *      repo; the cross-cutting "add this everywhere" recommendation).
 *   2. PER-REPO — `<datasetDir>/context/<instance_id>/AGENTS.md|CLAUDE.md` (scoped
 *      to this repo; the "add this to YOUR repo" recommendation). `datasetDir` is
 *      the discovered tier root, so an overlay-hosted dataset's own `context/`
 *      wins by the same overlay-by-name rule as `instances.json`.
 * Within a dir, `AGENTS.md` wins over `CLAUDE.md`. Missing files are simply
 * skipped — injection is presence-based, zero-config.
 */
function resolveInjectedContext(opts: {
  overlayDir?: string;
  datasetDir?: string;
  instanceId: string;
}): { source: "overlay" | "instance"; path: string; text: string }[] {
  const pick = (dir: string): string | undefined => {
    for (const name of ["AGENTS.md", "CLAUDE.md"]) {
      const p = join(dir, name);
      if (existsSync(p)) return p;
    }
    return undefined;
  };
  const out: { source: "overlay" | "instance"; path: string; text: string }[] = [];
  const generic = opts.overlayDir ? pick(join(opts.overlayDir, "repo-context")) : undefined;
  if (generic) out.push({ source: "overlay", path: generic, text: readFileSync(generic, "utf8") });
  const perRepo = opts.datasetDir ? pick(join(opts.datasetDir, "context", opts.instanceId)) : undefined;
  if (perRepo) out.push({ source: "instance", path: perRepo, text: readFileSync(perRepo, "utf8") });
  return out;
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

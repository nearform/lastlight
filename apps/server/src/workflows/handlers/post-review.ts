import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { GitHubClient } from "../../engine/github/github.js";
import {
  buildReview,
  buildBodyOnlyReview,
  parseDiff,
  type ReviewFindingsDoc,
} from "../../engine/github/review-poster.js";
import { getRuntimeConfig } from "../../config/config.js";
import type { ExecutorConfig } from "lastlight-workflow-engine";
import type { TemplateContext } from "lastlight-workflow-engine";
import type { PhaseDefinition } from "lastlight-workflow-engine";
import type { DagNode } from "lastlight-workflow-engine";
import type {
  PhaseOutcome,
  PhaseReporter,
  PhaseResult,
  PhaseTypeHandler,
  WorkflowStateStore,
} from "lastlight-workflow-engine";

/** Run-scoped data the `post-review` handler needs. */
export interface PostReviewRunScope {
  ctx: TemplateContext;
  config: ExecutorConfig;
  /** Single workspace shared by every phase + loop iteration of the run. */
  taskId: string;
  store?: WorkflowStateStore;
  workflowId?: string;
}

/**
 * Build post-review's own GitHub client from STABLE config, never the live
 * `process.env`. A concurrent in-process (gondolin) run clears `GITHUB_APP_*`
 * in the shared `process.env` (agent-executor `applyEnv`, hard rule #8) for the
 * duration of its agent turn; reading the PEM path from `process.env` mid-clear
 * yields `""` → `resolve("")` = the cwd (a directory) → `readFileSync` EISDIR.
 * The pr-review cron surfaced this by fanning out concurrent runs, but it bites
 * any two overlapping in-process runs. `getRuntimeConfig()` is loaded once at
 * boot, so its `githubApp`/`githubToken` are immune to the race. Exported for
 * the concurrent-clear regression test.
 */
export function resolveReviewGitHubClient(runConfig: { githubApiBaseUrl?: string }): GitHubClient {
  const baseUrl = runConfig.githubApiBaseUrl;
  if (baseUrl) {
    // Eval / test path: the mock ignores auth; any bearer token works.
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || "eval-fake-token";
    return GitHubClient.withToken(token, baseUrl);
  }
  const cfg = getRuntimeConfig();
  if (cfg?.githubApp) return new GitHubClient(cfg.githubApp);
  if (cfg?.githubToken) return GitHubClient.withToken(cfg.githubToken);
  // Last resort — runtime config not loaded (shouldn't happen in a live harness).
  return new GitHubClient({
    appId: process.env.GITHUB_APP_ID || "",
    privateKeyPath: process.env.GITHUB_APP_PRIVATE_KEY_PATH || "",
    installationId: process.env.GITHUB_APP_INSTALLATION_ID || "",
  });
}

/**
 * The `type: post-review` phase — the one workflow body genuinely coupled to
 * GitHub, lifted out of the engine into an app-registered {@link PhaseTypeHandler}.
 *
 * First-class, in-process PR-review submission. The reviewer agent writes only
 * *content* to `.lastlight/pr-review/findings.json` (`{ skip?, summary, event,
 * findings[] }`); THIS handler supplies every fact the harness already knows —
 * the PR number (run context), the base ref, head SHA and diff (pre-cloned
 * checkout) — anchors each finding to a changed line, and posts one formal
 * review via `GitHubClient`.
 *
 * A genuine failure — missing findings after a real review, or a GitHub error
 * that survives the body-only retry — FAILS the phase visibly; only a
 * legitimate `skip` succeeds without posting. Idempotent on resume: it no-ops
 * when a bot review already exists on the current head SHA.
 */
export class GitHubPostReviewHandler implements PhaseTypeHandler {
  constructor(
    private readonly run: PostReviewRunScope,
    private readonly reporter: PhaseReporter,
  ) {}

  async execute(
    phase: PhaseDefinition,
    _node: DagNode,
    _outputs: Readonly<Record<string, unknown>>,
  ): Promise<PhaseOutcome> {
    const phaseName = phase.name;
    await this.reporter.onStart(phaseName);
    await this.reporter.step(phaseName, "running", phase.messages?.on_start);

    const succeed = async (summary: string): Promise<PhaseOutcome> => {
      const result: PhaseResult = { phase: phaseName, success: true, output: summary };
      this.reporter.persistPhase(phaseName, summary);
      await this.reporter.onEnd(phaseName, result);
      await this.reporter.step(phaseName, "done", phase.messages?.on_success);
      return { results: [result], status: "succeeded" };
    };
    const fail = async (error: string): Promise<PhaseOutcome> => {
      const result: PhaseResult = { phase: phaseName, success: false, output: "", error };
      await this.reporter.onEnd(phaseName, result);
      await this.reporter.step(phaseName, "failed", phase.messages?.on_failure);
      // Record a failed phase_history entry so the dashboard pipeline renders
      // this node red — the handler has no `executions` row (it runs in-process),
      // and `persistPhase` only writes success entries, so without this a failed
      // post-review would show as "pending" despite the run being marked failed.
      if (this.run.store && this.run.workflowId) {
        this.run.store.runs.appendPhase(this.run.workflowId, phaseName, {
          phase: phaseName,
          timestamp: new Date().toISOString(),
          success: false,
          summary: error,
        });
      }
      this.reporter.failWorkflow(error);
      console.error(`[post-review] ${error}`);
      return { results: [result], status: "failed" };
    };

    const ctx = this.run.ctx;
    const owner = String(ctx.owner);
    const repo = String(ctx.repo);
    const prNumber =
      (typeof ctx.prNumber === "number" ? ctx.prNumber : undefined) ??
      (typeof ctx.issueNumber === "number" && ctx.issueNumber > 0 ? ctx.issueNumber : undefined);
    if (!prNumber) return fail("post-review: no PR number in run context; cannot post review");

    // Read the agent's findings from the host checkout. The review phase writes
    // it at `.lastlight/pr-review/findings.json` relative to the repo cwd; the
    // workspace persists on the host between phases (see sandbox/index.ts).
    const hostRepoDir = this.resolveHostRepoDir(repo);
    const findingsPath = join(hostRepoDir, ".lastlight", "pr-review", "findings.json");
    let doc: ReviewFindingsDoc;
    try {
      doc = JSON.parse(readFileSync(findingsPath, "utf8")) as ReviewFindingsDoc;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A missing/unreadable file after a completed review means the review
      // phase didn't honour its contract — surface it, don't post silently.
      return fail(`post-review: could not read findings (${findingsPath}): ${msg}`);
    }

    if (doc.skip) {
      return succeed(`skipped: ${doc.summary || "agent skipped review"}`);
    }

    const github = this.buildReviewClient();

    // Head SHA + base ref come from the checkout / run context, never the agent.
    const baseRef = typeof ctx.baseBranch === "string" && ctx.baseBranch ? ctx.baseBranch : undefined;
    const headSha = this.gitHeadSha(hostRepoDir);

    // Idempotency: skip if a bot review already exists on this head SHA (guards
    // resume / re-entry from double-posting).
    if (headSha) {
      try {
        const existing = await github.getLatestBotReview(owner, repo, prNumber, headSha, getRuntimeConfig()?.botLogin);
        if (existing) return succeed(`already reviewed head ${headSha.slice(0, 7)} (${existing.state})`);
      } catch {
        /* best-effort — fall through and attempt the post */
      }
    }

    // Commentable line set from the local checkout diff. Failure → null → all
    // findings demoted to the body (the review still posts).
    const commentable = baseRef ? this.gitCommentableDiff(hostRepoDir, baseRef) : null;
    const review = buildReview(doc, commentable);

    try {
      await github.createPullRequestReview(owner, repo, prNumber, {
        body: review.body,
        event: review.event,
        comments: review.comments,
        commitId: headSha,
      });
      return succeed(
        `posted review: ${review.inlineCount} inline, ${review.demotedCount} in body, event=${review.event}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[post-review] inline review POST failed: ${msg}; retrying body-only`);
      // Off-diff anchors (e.g. a stale diff) 422 — retry with everything in the
      // body so the review still lands.
      const bodyOnly = buildBodyOnlyReview(doc);
      try {
        await github.createPullRequestReview(owner, repo, prNumber, {
          body: bodyOnly.body,
          event: bodyOnly.event,
          commitId: headSha,
        });
        return succeed(`posted review (body-only fallback): ${bodyOnly.demotedCount} findings, event=${bodyOnly.event}`);
      } catch (err2) {
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        return fail(`post-review: GitHub rejected the review (inline: ${msg}; body-only: ${msg2})`);
      }
    }
  }

  /** Host path of the run's repo checkout — mirrors sandbox/index.ts layout. */
  private resolveHostRepoDir(repo: string): string {
    const config = this.run.config;
    const sandboxBase = resolve(config.sandboxDir || join(config.stateDir || "data", "sandboxes"));
    const workDir = join(sandboxBase, this.run.taskId);
    // pr-review pre-clones into a `<repo>/` subdir (a sibling of the workspace
    // root's AGENTS.md / skill bundle). Fall back to the workspace root if the
    // repo subdir has no findings (defensive — should not happen for pr-review).
    const repoDir = join(workDir, repo);
    if (existsSync(join(repoDir, ".lastlight", "pr-review"))) return repoDir;
    if (existsSync(join(workDir, ".lastlight", "pr-review"))) return workDir;
    return repoDir;
  }

  /** Build the GitHub client for the post: token+baseUrl in evals, App auth in prod. */
  private buildReviewClient(): GitHubClient {
    return resolveReviewGitHubClient(this.run.config);
  }

  private gitHeadSha(repoDir: string): string | undefined {
    try {
      return execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
    } catch {
      return undefined;
    }
  }

  /** Compute the base…head diff locally and parse it into a commentable set. */
  private gitCommentableDiff(repoDir: string, baseRef: string): Map<string, Set<string>> | null {
    const git = (...args: string[]): string =>
      execFileSync("git", ["-C", repoDir, ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    const tryGit = (...args: string[]): void => {
      try {
        execFileSync("git", ["-C", repoDir, ...args], { stdio: "ignore" });
      } catch {
        /* offline / already complete / already present — best-effort */
      }
    };

    // The three-dot (merge-base…head) diff mirrors GitHub's own PR diff exactly,
    // so it's the ideal anchor set — but it needs the merge-base present locally,
    // which a shallow `--depth 1 --single-branch` pr-review clone doesn't have.
    const threeDot = () => parseDiff(git("diff", `origin/${baseRef}...HEAD`));
    // Two-dot compares the two end trees directly — no history walk — so it works
    // on ANY clone depth (down to depth 1). It's a *superset* of the three-dot
    // diff (it also shows changes the base picked up since the PR forked), which
    // is a safe over-approximation for anchoring: the agent's findings sit on the
    // PR's own changed lines (⊆ three-dot ⊆ two-dot), and any stray off-diff
    // anchor is caught by the body-only POST retry.
    const twoDot = () => parseDiff(git("diff", `origin/${baseRef}`, "HEAD"));

    // Materialize origin/<base> as a real remote-tracking ref (a single-branch
    // clone's refspec only covers the PR branch, so a bare `fetch origin <base>`
    // updates FETCH_HEAD but may not create origin/<base>).
    tryGit("fetch", "origin", `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`, "--depth", "50");
    try {
      return threeDot();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // A non-shallow failure (unknown base ref, corrupt repo) still gets the
      // depth-agnostic two-dot before we give up to the body.
      if (!/no merge base|shallow/i.test(msg)) {
        try {
          return twoDot();
        } catch {
          return this.diffFailed(msg);
        }
      }
      // The shallow boundary hid the merge-base. Deepen BOTH sides: the base
      // branch AND the depth-1 PR branch (HEAD). The earlier code only
      // unshallowed the base, leaving HEAD with no reachable ancestor, so the
      // three-dot retry still died with "no merge base" and demoted every
      // finding to the body (recurred on nearform/skillspro#1598, #1599).
      // `--unshallow` no-ops-then-throws on an already-complete repo, so both
      // are best-effort; we only pay the full fetch on this rare failure path.
      tryGit("fetch", "origin", "--unshallow"); // deepen the PR branch (the single-branch refspec)
      tryGit("fetch", "origin", `+refs/heads/${baseRef}:refs/remotes/origin/${baseRef}`, "--unshallow"); // deepen base
      try {
        return threeDot();
      } catch (err2) {
        // Genuinely unrelated histories, or a base we couldn't fully fetch (e.g.
        // egress-blocked): fall back to the two-dot superset — still anchors the
        // PR's own lines — before demoting everything to the body.
        const msg2 = err2 instanceof Error ? err2.message : String(err2);
        try {
          return twoDot();
        } catch {
          return this.diffFailed(msg2);
        }
      }
    }
  }

  private diffFailed(msg: string): null {
    console.warn(`[post-review] could not compute commentable diff (${msg}); demoting all findings to the body`);
    return null;
  }
}

/** Build the app-registered `post-review` phase-type handler for a run. */
export function makePostReviewHandler(run: PostReviewRunScope, reporter: PhaseReporter): PhaseTypeHandler {
  return new GitHubPostReviewHandler(run, reporter);
}

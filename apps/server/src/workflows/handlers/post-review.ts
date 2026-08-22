import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve, sep } from "node:path";
import { GitHubClient } from "../../engine/github/github.js";
import {
  anchorFindings,
  buildReview,
  buildBodyOnlyReview,
  commentableOf,
  parseDiffFiles,
  worstAxis,
  type AttentionBoundary,
  type DiffFile,
  type ReviewFindingsDoc,
  type TieredFindings,
} from "../../engine/github/review-poster.js";
import { getRuntimeConfig } from "../../config/config.js";
import { defaultReviewConfig } from "lastlight-shared/config-types";
import { hasMaterialChange } from "../../engine/pr-decisions.js";
import { logger } from "../../logging/logger.js";

const log = logger("post-review");
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
 * `process.env`. An in-process (gondolin) run used to clear `GITHUB_APP_*` in the
 * shared `process.env` for the duration of its agent turn; reading the PEM path
 * mid-clear yielded `""` → `resolve("")` = the cwd (a directory) →
 * `readFileSync` EISDIR. The pr-review cron surfaced it by fanning out
 * concurrent runs, but it bit any two overlapping in-process runs.
 *
 * That splice is gone — per-run GitHub credentials are threaded explicitly now
 * (issue #215, `githubAuthEnvFrom` + agentic-pi's `githubAuthEnv`) — so nothing
 * writes those keys at runtime any more. This stays config-first regardless:
 * `getRuntimeConfig()` is loaded once at boot, so it cannot be raced by anything
 * that mutates the process env in future. Exported for the concurrent-clear
 * regression test.
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
      await this.reporter.persistPhase(phaseName, summary);
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
        await this.run.store.runs.appendPhase(this.run.workflowId, phaseName, {
          phase: phaseName,
          timestamp: new Date().toISOString(),
          success: false,
          summary: error,
        });
      }
      await this.reporter.failWorkflow(error);
      log.error(error);
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

    // The split verdict (#271 fix 7) only exists when the evidence pipeline is
    // on. Dropping it here rather than trusting nothing to write it is what
    // makes locked decision 8 STRUCTURAL: with `review.analysis.enabled: false`
    // a findings file that carries a `verdict` — a forked prompt, an overlay
    // that got ahead of its config, a model improvising the field — cannot
    // change the event this deployment would have posted yesterday.
    //
    // Operator-layer config on purpose, matching `staleAgainstCurrentHead`
    // below: this runs in-process against a run whose repo-clamped block is not
    // threaded here, and `review.analysis` is operator-only anyway, so the two
    // cannot disagree.
    if (!this.analysisEnabled() && doc.verdict) {
      log.info("Ignoring a split verdict: review.analysis is disabled", {
        repo: `${owner}/${repo}`,
        prNumber,
      });
      doc = { ...doc, verdict: undefined };
    }

    if (doc.skip) {
      return succeed(`skipped: ${doc.summary || "agent skipped review"}`);
    }

    const github = this.buildReviewClient();

    // Head SHA + base ref come from the checkout / run context, never the agent.
    const baseRef = typeof ctx.baseBranch === "string" && ctx.baseBranch ? ctx.baseBranch : undefined;
    // `git rev-parse HEAD` doubles as the "is there a local checkout?" probe: it
    // returns a SHA on host-checkout backends (docker/none/gondolin) and
    // undefined on k8s, where the workspace lives in a sandbox PVC and only the
    // harvested `.lastlight/` reaches the harness.
    const localHeadSha = this.gitHeadSha(hostRepoDir);
    // No local checkout (k8s) — fetch the head SHA from the GitHub API so the
    // idempotency check below and inline comments (which require a commit id)
    // both work.
    let headSha = localHeadSha;
    if (!headSha) headSha = await github.getPullRequestHeadSha(owner, repo, prNumber).catch(() => undefined);

    // One pass over our review history answers both questions asked below: is
    // there already a review on THIS head (idempotency), and what did we last
    // actually say (the duplicate guard). Both used to be their own paginated
    // `listReviews`.
    let history: Awaited<ReturnType<GitHubClient["getBotReviewHistory"]>> = { atHead: null, latest: null };
    if (headSha) {
      // Best-effort: a failed read leaves both null, which posts.
      history = await github
        .getBotReviewHistory(owner, repo, prNumber, headSha, getRuntimeConfig()?.botLogin)
        .catch(() => ({ atHead: null, latest: null }));

      // Idempotency: skip if a bot review already exists on this head SHA
      // (guards resume / re-entry from double-posting).
      if (history.atHead) {
        return succeed(`already reviewed head ${headSha.slice(0, 7)} (${history.atHead.state})`);
      }

      const stale = await this.staleAgainstCurrentHead(github, owner, repo, prNumber, headSha);
      if (stale) return succeed(stale);
    }

    // Commentable line set from the local checkout diff. Failure → null → all
    // findings demoted to the body (the review still posts). Gated on a local
    // checkout actually existing: without that guard, k8s (no `.git` on the
    // harness) runs a guaranteed-to-fail `git diff` that dumps a usage block and
    // a FALSE "demoting all findings to the body" on every run — before the API
    // fallback silently rescues the findings.
    let files = localHeadSha && baseRef ? this.gitDiffFiles(hostRepoDir, baseRef) : null;
    // No local checkout (or no base ref) — fall back to GitHub's own PR diff
    // (the same merge-base diff) so findings still anchor inline on k8s instead
    // of demoting to the body.
    if (!files) files = await this.apiDiffFiles(github, owner, repo, prNumber);
    const commentable = files ? commentableOf(files) : null;

    // WP6a — derive each finding's anchor from its verbatim `existingCode`
    // before anything partitions on `line`. A finding whose analysis is right
    // and whose arithmetic is off by two is otherwise demoted to the body, which
    // is the full price of a wrong answer for a counting slip. Inert on a
    // findings.json whose entries carry no excerpt: `anchorFindings` returns
    // them untouched, so this cannot move a deployment that has not opted in.
    if (files) {
      const anchored = anchorFindings(
        Array.isArray(doc.findings) ? doc.findings : [],
        files,
        localHeadSha ? (p) => this.readHeadFile(hostRepoDir, p) : undefined,
      );
      if (anchored.stats.hunk || anchored.stats.file || anchored.stats.relocated) {
        log.info("Anchored findings from their code excerpts", {
          repo: `${owner}/${repo}`,
          prNumber,
          ...anchored.stats,
        });
      }
      doc = { ...doc, findings: anchored.findings };
    }

    // WP6b — the attention boundary, and it exists ONLY when the evidence
    // pipeline is on. `undefined` here is not a default, it is the whole
    // inertness guarantee: `buildReview` takes its pre-WP6b branch and a
    // deployment that never opted in gets no cap, no thresholds and no
    // `internal` tier, whatever a findings.json happens to carry.
    const boundary = this.attentionBoundary();
    const review = buildReview(doc, commentable, boundary);
    if (boundary && review.tiered) {
      this.recordDisposition(hostRepoDir, boundary, review.tiered);
    }

    const repeat = this.repeatOfLastReview(history.latest, review);
    if (repeat) {
      log.info("Skipping a duplicate review post", { repo: `${owner}/${repo}`, prNumber, summary: repeat });
      return succeed(repeat);
    }

    try {
      await github.createPullRequestReview(owner, repo, prNumber, {
        body: review.body,
        event: review.event,
        comments: review.comments,
        commitId: headSha,
      });
      // Name the downgrade in the ledger row when the split verdict caused one.
      // Without it "event=COMMENT" on a doc whose `event` says APPROVE reads as
      // a bug rather than as the axis floor doing its job.
      const downgraded =
        doc.event === "APPROVE" && review.event !== "APPROVE" && worstAxis(doc.verdict) === "fail"
          ? `, downgraded from APPROVE by verdict spec=${doc.verdict?.spec ?? "-"}/standards=${doc.verdict?.standards ?? "-"}`
          : "";
      return succeed(
        `posted review: ${review.inlineCount} inline, ${review.demotedCount} in body, event=${review.event}${downgraded}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("Inline review POST failed; retrying body-only", { err });
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

  /**
   * Would this review be a WORD-FOR-WORD repeat of the one we already posted
   * (issue #271)? Returns the summary line to succeed with, or `null` to post.
   *
   * nearform/skillspro#1641 is the case, and it is worth being exact about why
   * the trigger-gate half of #271 does not cover it. Two APPROVEs, six minutes
   * and 400 identical bytes apart, on two head SHAs whose two-dot delta is
   * `package-lock.json` **plus** `package.json` and `jest.config.js` — a force-
   * push amend, materially different by any file-level test, so
   * `resolveReviewTrigger`'s generated-only gate correctly lets it through. The
   * only thing that identifies it as a duplicate is the review text itself, and
   * that is not knowable until the agent has written it.
   *
   * So this saves the DUPLICATE COMMENT, not the money — the run has already
   * happened by the time we get here. It is deliberately the narrowest rule
   * that catches the observed shape:
   *
   * - the same `body`, byte for byte, as our last posted review;
   * - `APPROVE` with **no** inline comments on both sides.
   *
   * The APPROVE restriction is not squeamishness, it is the check run. Skipping
   * the post means `concludeReviewCheck` finds no review at this head and
   * concludes `neutral`. `neutral` and `success` both pass branch protection, so
   * suppressing a duplicate APPROVE changes nothing; suppressing a duplicate
   * CHANGES_REQUESTED would turn a `failure` check into a passing one and open
   * a merge gate the review deliberately closed.
   */
  private repeatOfLastReview(
    last: { state: string; sha: string; body: string | null } | null,
    review: { body: string; event: string; comments: unknown[] },
  ): string | null {
    if (review.event !== "APPROVE" || review.comments.length > 0) return null;
    if (!last || last.state !== "APPROVED" || last.body !== review.body) return null;
    return `duplicate: this APPROVE is word-for-word the one we posted on ${last.sha.slice(0, 7)}`;
  }

  /**
   * Has the PR moved on since the SHA this run actually reviewed (issue #271)?
   *
   * Returns the summary line to succeed with when the review should NOT be
   * posted, or `null` to post. Posting a review of a tree that no longer exists
   * spends the maintainer's attention on findings GitHub will immediately mark
   * outdated — nearform/skillspro#1587's churn is full of them.
   *
   * Three conditions, ALL required, because dropping a review is only
   * acceptable when a replacement is guaranteed:
   *
   * 1. **The head really moved.** Any read failure leaves it unknown and posts.
   * 2. **The trigger is automatic.** Under `on-request` nothing re-dispatches on
   *    its own, so the human who asked would simply never get an answer.
   * 3. **The delta is MATERIAL** — at least one changed path is not generated.
   *    That is exactly `resolveReviewTrigger`'s generated-only gate read the
   *    other way round: a material push is one that gate will let through, so a
   *    fresh review of the new head is guaranteed; a generated-only push is one
   *    it will suppress, and dropping this review would mean the PR gets none at
   *    all.
   *
   * Operator-layer `review` config on purpose: this runs in-process against a
   * run whose repo-clamped block isn't threaded here, and the clamp only ever
   * ADDS generated paths — so the operator list is the subset, which resolves
   * more deltas as "material" and therefore drops fewer reviews.
   */
  private async staleAgainstCurrentHead(
    github: GitHubClient,
    owner: string,
    repo: string,
    prNumber: number,
    reviewedSha: string,
  ): Promise<string | null> {
    const review = getRuntimeConfig()?.review;
    if (!review || review.trigger === "on-request") return null;

    const currentSha = await github.getPullRequestHeadSha(owner, repo, prNumber).catch(() => undefined);
    if (!currentSha || currentSha === reviewedSha) return null;

    const changed = await github
      .getChangedPathsBetween(owner, repo, reviewedSha, currentSha)
      .catch((err: unknown) => {
        log.warn("Could not compare the reviewed head with the current one; posting anyway", { err });
        return null;
      });
    // `null` (degraded/truncated) and `[]` both mean "no material change proven",
    // so both post — the same fail-open direction the trigger gate takes.
    if (!hasMaterialChange(changed, review.generatedPaths)) return null;

    const summary =
      `stale: reviewed ${reviewedSha.slice(0, 7)} but the head is now ${currentSha.slice(0, 7)}; ` +
      `a review of the new head will be dispatched instead`;
    log.info("Skipping a stale review post", { repo: `${owner}/${repo}`, prNumber, summary });
    return summary;
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

  /**
   * The attention budget, or `undefined` when the evidence pipeline is off.
   *
   * Operator-layer config, matching the `verdict` strip and
   * `staleAgainstCurrentHead` — `review.analysis` is operator-only anyway, so
   * the repo-clamped block cannot disagree with it.
   */
  private attentionBoundary(): AttentionBoundary | undefined {
    if (!this.analysisEnabled()) return undefined;
    const analysis = getRuntimeConfig()?.review?.analysis ?? defaultReviewConfig().analysis;
    return {
      maxInlineComments: analysis.maxInlineComments,
      thresholds: analysis.thresholds ?? {},
      internalFloor: analysis.internalFloor,
    };
  }

  /**
   * Is the review evidence pipeline on FOR THIS RUN?
   *
   * Two authorities, and the second one is why this is a method rather than a
   * `getRuntimeConfig()` read at each site. The process-global runtime config is
   * the production authority. But `analysisEnabled` on the run CONTEXT is what
   * every gated phase in `pr-review.yaml` actually keys off — `specContext`
   * projects it, and only when the run's own effective review config had
   * `analysis.enabled`. So the context is the run-scoped truth, and reading only
   * the global one makes this handler disagree with the twelve phases upstream
   * of it about whether the pipeline ran.
   *
   * **Measured 2026-08-22, and it silently cost a whole arm.** The eval harness
   * threads the arm's `review:` policy through `prContextPatch` and never
   * populates the runtime config, so a pipeline-ON eval run had all twelve
   * analysis phases fire and then hit a `post-review` that believed the pipeline
   * was off: the attention boundary was inert (every `internal`-tier finding
   * POSTED, no inline cap, no family thresholds) and the split verdict was
   * stripped. Twenty findings posted where the shipped configuration would have
   * posted eleven — a precision number describing a deployment that does not
   * exist.
   *
   * The inertness guarantee is unchanged: `specContext` returns `{}` when
   * analysis is off, so `analysisEnabled` is ABSENT — not `false` — on every
   * deployment that has not opted in, and neither authority can be satisfied.
   */
  private analysisEnabled(): boolean {
    if (getRuntimeConfig()?.review?.analysis?.enabled) return true;
    return this.run.ctx.analysisEnabled === "true";
  }

  /**
   * Write what happened to each finding — its tier, and why.
   *
   * [WP6](../../../../docs/plans/review-evidence-pipeline/06-adjudicate.md)'s
   * AC1b asks for this in a `review_findings` table, and that table is
   * [WP7](../../../../docs/plans/review-evidence-pipeline/07-review-memory.md)'s
   * — which depends on WP6, so it does not exist yet. **Decided deliberately
   * (2026-08-22): scope the record to the run's own workspace for now** rather
   * than pull a schema change forward for a consumer that has not been written,
   * on a table whose shape would be a guess.
   *
   * What it buys today is the thing that separates an attention boundary from
   * v2's suppressor: *"what did we know and not say?"* is answerable. Without a
   * record the `internal` tier is a dark drop, and a dark drop is the defect
   * this whole work package exists to avoid re-introducing.
   *
   * Best-effort — a failure here must never stop a review posting.
   */
  private recordDisposition(
    repoDir: string,
    boundary: AttentionBoundary,
    tiered: TieredFindings,
  ): void {
    try {
      const rows = [
        ...tiered.inline.map((f) => ({ tier: "inline" as const, reason: null, finding: f })),
        ...tiered.body.map((d) => ({ tier: "body" as const, reason: d.reason, finding: d.finding })),
        ...tiered.internal.map((f) => ({
          tier: "internal" as const,
          reason: "below the internal floor" as string,
          finding: f,
        })),
      ];
      writeFileSync(
        join(repoDir, ".lastlight", "pr-review", "disposition.json"),
        JSON.stringify({ generatedAt: new Date().toISOString(), boundary, findings: rows }, null, 2),
      );
    } catch (err) {
      log.warn("Could not record the finding disposition", { err });
    }
  }

  /**
   * Read a head-side file for the anchor cascade's step 2. Best-effort by
   * design: a miss just means the excerpt is not found there and the cascade
   * moves on to relocation.
   *
   * **The path comes from a model**, so it is confined to the checkout the same
   * way every other path in this handler is — `resolve` then a prefix check, not
   * a `..` denylist. Size-capped because the excerpt scan is O(file) and a
   * findings.json naming a vendored bundle should cost nothing.
   */
  private readHeadFile(repoDir: string, relPath: string): string | null {
    try {
      const root = resolve(repoDir);
      const full = resolve(root, relPath);
      if (full !== root && !full.startsWith(root + sep)) return null;
      const st = statSync(full);
      if (!st.isFile() || st.size > 2 * 1024 * 1024) return null;
      return readFileSync(full, "utf8");
    } catch {
      return null;
    }
  }

  /** Build the GitHub client for the post: token+baseUrl in evals, App auth in prod. */
  private buildReviewClient(): GitHubClient {
    return resolveReviewGitHubClient(this.run.config);
  }

  private gitHeadSha(repoDir: string): string | undefined {
    try {
      // Also the "is there a local checkout?" probe (undefined on k8s), so it
      // runs on every run — silence stderr ("fatal: not a git repository") that
      // execFileSync otherwise inherits to the console.
      return execFileSync("git", ["-C", repoDir, "rev-parse", "HEAD"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
    } catch {
      return undefined;
    }
  }

  /** Compute the base…head diff locally and parse it into per-file hunks. */
  private gitDiffFiles(repoDir: string, baseRef: string): DiffFile[] | null {
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
    const threeDot = () => parseDiffFiles(git("diff", `origin/${baseRef}...HEAD`));
    // Two-dot compares the two end trees directly — no history walk — so it works
    // on ANY clone depth (down to depth 1). It's a *superset* of the three-dot
    // diff (it also shows changes the base picked up since the PR forked), which
    // is a safe over-approximation for anchoring: the agent's findings sit on the
    // PR's own changed lines (⊆ three-dot ⊆ two-dot), and any stray off-diff
    // anchor is caught by the body-only POST retry.
    const twoDot = () => parseDiffFiles(git("diff", `origin/${baseRef}`, "HEAD"));

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
    log.warn("Could not compute commentable diff; demoting all findings to the body", { reason: msg });
    return null;
  }

  /** Fetch the PR's diff from the GitHub API and parse it into per-file hunks —
   *  the fallback when there's no local checkout (k8s). GitHub's PR diff is the
   *  same merge-base…head diff the local three-dot path targets, so the anchor
   *  set is identical. Best-effort: any failure returns null and every finding
   *  demotes to the body (the review still posts). */
  private async apiDiffFiles(
    github: GitHubClient,
    owner: string,
    repo: string,
    prNumber: number,
  ): Promise<DiffFile[] | null> {
    try {
      return parseDiffFiles(await github.getPullRequestDiff(owner, repo, prNumber));
    } catch (err) {
      return this.diffFailed(err instanceof Error ? err.message : String(err));
    }
  }
}

/** Build the app-registered `post-review` phase-type handler for a run. */
export function makePostReviewHandler(run: PostReviewRunScope, reporter: PhaseReporter): PhaseTypeHandler {
  return new GitHubPostReviewHandler(run, reporter);
}

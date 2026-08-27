import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, resolve, sep } from "node:path";
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
import { hasMaterialChange, resolveReviewPost, type HeadReview } from "../../engine/pr-decisions.js";
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
 * Is this hypothesis row a CLEAN DISCHARGE — the pass saying *"I looked, I
 * quote the line, and it is fine"*?
 *
 * Two conditions, and each one is defensive about a shape that was actually
 * measured on disk:
 *
 * 1. **`discharge` OR `status`, case-insensitively**, mirroring `codeOf` in
 *    `code-facts`' `discharge.ts` so the gate and the boundary can never
 *    disagree about whether a row was discharged. Rows are heterogeneous: some
 *    carry neither (the `spec` pass's invented `{verdict, rationale, path,
 *    line, obligation}` shape), and a dead family writes `{status:
 *    "notMeasured"}`. Neither is a QUOTE, so neither is clean.
 * 2. **`failureScenario` PRESENT and explicitly `null`**, not merely absent —
 *    and this is the load-bearing half. The rule being read is the row shape's
 *    own contract, *"on a clean QUOTE write `failureScenario: null`"*, so it is
 *    a SELF-REPORT: a row that never wrote the key made no report at all.
 *
 *    Measured, and it decides the `--contract minimal` question. Across the two
 *    preserved 2026-08-22 runs (the pre-`full` contract, which never asked for
 *    the field) **37 rows are `QUOTE` with no `failureScenario` key, and every
 *    single one is from `spec.jsonl`'s invented `{claim, status, path, line,
 *    evidence}` shape** — a shape with nowhere to record a scenario, so its
 *    silence carries no information. Under the `full` contract of 2026-08-23,
 *    71 of 78 clean rows write the key explicitly. Requiring it therefore costs
 *    **zero findings** on the full-contract runs (17 / 14 / 7 demoted either
 *    way) and makes the rule a **true no-op** on every minimal-contract run,
 *    where the loose reading would have silently demoted 28 findings on the
 *    strength of a field nobody asked for.
 */
function isCleanDischarge(row: unknown): boolean {
  if (!row || typeof row !== "object" || Array.isArray(row)) return false;
  const r = row as Record<string, unknown>;
  const raw = r.discharge ?? r.status;
  if (typeof raw !== "string" || raw.trim().toUpperCase() !== "QUOTE") return false;
  return "failureScenario" in r && r.failureScenario === null;
}

/**
 * Which hypothesis ids in `<dir>/hypotheses/*.jsonl` are clean discharges.
 *
 * **`undefined` means there is no `hypotheses/` directory at all** — the
 * shipped two-phase reviewer, and every arm that runs no evidence pipeline. The
 * caller passes it straight through, so no pipeline ⇒ byte-identical output.
 * (An empty set behaves identically by construction: `every` over a non-empty
 * id list against an empty set is false. The distinction is kept for the log.)
 *
 * Identity is assigned exactly as `code-facts`' `readHypothesisSet` assigns it,
 * because the ids in `findings[].hypotheses[]` came out of that reader's own
 * `--ledger`: canonical **`<family>-NNN`**, family from the FILENAME (the
 * survey branch owns its file, so the name is authoritative in a way a
 * self-reported field is not), ordinal from position in an append-only file.
 * A model-declared `id` is honoured as an **alias** only when exactly one row
 * claims it and it shadows no canonical id — an ambiguous alias resolves to
 * nothing, which leaves the finding on the confidence path rather than crediting
 * whichever file sorted first.
 *
 * Parsing is defensive throughout: a torn final line on a killed run is normal
 * and must not throw. Note that a line that parses to a non-object still
 * consumes its ordinal, because `readHypothesisSet` counts it — an ordinal that
 * drifted from the ledger's would mis-resolve every later citation in the file.
 */
export function readCleanDischarges(dir: string): ReadonlySet<string> | undefined {
  let files: string[];
  try {
    files = readdirSync(join(dir, "hypotheses"))
      .filter((f) => f.endsWith(".jsonl"))
      .sort();
  } catch {
    // No `hypotheses/` directory — the surveys never ran. Not an empty set:
    // "nobody looked" and "looked, found none clean" are different facts.
    return undefined;
  }

  const cleanCanonical = new Set<string>();
  const canonical = new Set<string>();
  /** A model-declared id → every canonical id claiming it. */
  const claims = new Map<string, string[]>();

  for (const file of files) {
    const family = basename(file, ".jsonl");
    let rows: unknown[];
    try {
      rows = readFileSync(join(dir, "hypotheses", file), "utf8")
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as unknown];
          } catch {
            return []; // a torn final line on a killed run is normal
          }
        });
    } catch {
      continue; // unreadable file — the other families still count
    }
    rows.forEach((row, index) => {
      const id = `${family}-${String(index + 1).padStart(3, "0")}`;
      canonical.add(id);
      if (isCleanDischarge(row)) cleanCanonical.add(id);
      const declared = (row as { id?: unknown } | null)?.id;
      if (typeof declared === "string" && declared.length > 0 && declared !== id) {
        claims.set(declared, [...(claims.get(declared) ?? []), id]);
      }
    });
  }

  const clean = new Set(cleanCanonical);
  for (const [declared, claimedBy] of claims) {
    // Canonical always wins, and an id two rows claim credits neither.
    if (canonical.has(declared) || claimedBy.length !== 1) continue;
    if (cleanCanonical.has(claimedBy[0]!)) clean.add(declared);
  }
  return clean;
}

/**
 * The review that stood on the head SHA when this run was DISPATCHED, off the
 * persisted `context.prState` — `resolveReviewPost`'s discriminator between a
 * prior review and this run's own.
 *
 * Read defensively rather than through the `PrState` type: the context is JSON
 * that outlives the build that wrote it, and a run dispatched before
 * `submittedAt` was recorded has the same shape minus that field. `null` — no
 * snapshot at all, which is every eval-harness run — degrades to "treat
 * anything at the head as ours", i.e. exactly the unconditional guard this
 * replaced.
 */
function dispatchReview(ctx: TemplateContext): HeadReview | null {
  const state = (ctx as Record<string, unknown>).prState;
  if (!state || typeof state !== "object") return null;
  const review = (state as Record<string, unknown>).botReviewAtHead;
  if (!review || typeof review !== "object") return null;
  const { state: reviewState, submittedAt } = review as Record<string, unknown>;
  if (typeof reviewState !== "string") return null;
  return { state: reviewState, submittedAt: typeof submittedAt === "string" ? submittedAt : null };
}

/**
 * Parse one context-projected boundary number back off its string form.
 * The projection is `specContext`'s (`pr-decisions.ts`); garbage degrades to
 * the caller's default — the direction `config.ts` coerces the same keys.
 */
function toBudget(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Like {@link toBudget} but fractional — `internalFloor` is a 0..1 bar. */
function toFloor(v: unknown, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/** The one JSON-valued context key; an unparseable value means "no bars". */
function parseThresholds(v: unknown): Record<string, number> {
  if (typeof v !== "string" || v === "") return {};
  try {
    const parsed: unknown = JSON.parse(v);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const out: Record<string, number> = {};
    for (const [k, val] of Object.entries(parsed)) {
      const n = Number(val);
      if (Number.isFinite(n)) out[k] = n;
    }
    return out;
  } catch {
    return {};
  }
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
 * legitimate `skip` succeeds without posting. Idempotent on resume: a review
 * this run already posted on the head SHA is never posted twice — see
 * {@link resolveReviewPost}, which is also what keeps that idempotency from
 * swallowing a maintainer's deliberate re-review of an unchanged head.
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

    // A human asked for THIS run by name — projected onto the run context at
    // the dispatch choke point (`src/index.ts`), so every route carries it
    // identically and a resume of this run still carries the request that
    // started it. Absent (an eval-harness run, a context written before the
    // field existed) reads as `false`, which is the pre-existing behaviour.
    const explicitRequest = ctx.explicitRequest === true;

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

      // "We already reviewed this head" — decided ONCE, by the same module the
      // dispatch gate asks. Two things are being told apart here and they used
      // to be one: a resume/re-entry finding the review this run itself posted
      // (never post again) versus a maintainer's deliberate `@bot review` on a
      // head we reviewed yesterday (post — that is the whole ask). The
      // discriminator is the dispatch snapshot, which is why `atDispatch` comes
      // off the persisted run context rather than a fresh read.
      const post = resolveReviewPost({
        atHead: history.atHead,
        atDispatch: dispatchReview(ctx),
        explicitRequest,
      });
      if (post.decision === "skip") {
        log.info("Not posting a review", {
          repo: `${owner}/${repo}`,
          prNumber,
          reason: post.reason,
          inputs: post.inputs,
        });
        return succeed(`${post.reason} — ${headSha.slice(0, 7)}`);
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
    // The anti-finding rule (below). Read ONLY when a boundary exists, so a
    // deployment that never opted in does not even stat the directory — the
    // same inertness discipline the boundary itself keeps.
    const clean = boundary
      ? readCleanDischarges(join(hostRepoDir, ".lastlight", "pr-review"))
      : undefined;
    const review = buildReview(doc, commentable, boundary, clean);
    if (boundary && review.tiered) {
      const antiFindings = review.tiered.internal.filter((r) => r.reason === "clean-discharge").length;
      if (clean?.size || antiFindings) {
        log.info("Withheld findings whose evidence is entirely clean discharges", {
          repo: `${owner}/${repo}`,
          prNumber,
          cleanHypotheses: clean?.size ?? 0,
          antiFindings,
        });
      }
      this.recordDisposition(hostRepoDir, boundary, review.tiered);
    }

    const repeat = this.repeatOfLastReview(history.latest, review, explicitRequest);
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
      // The `internal` count is reported even when it is zero, and only when a
      // boundary applied: "recorded, not posted" is a number nobody can read off
      // the review itself, and leaving it out of the one line the ledger keeps
      // is how a dark drop would look exactly like a quiet review.
      const withheld = review.tiered ? `, ${review.internalCount} recorded-only` : "";
      return succeed(
        `posted review: ${review.inlineCount} inline, ${review.demotedCount} in body${withheld}, event=${review.event}${downgraded}`,
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.warn("Inline review POST failed; retrying body-only", { err });
      // Off-diff anchors (e.g. a stale diff) 422 — retry with everything in the
      // body so the review still lands.
      // The tiering, when there was one: the retry must not republish what the
      // boundary recorded-and-withheld just because GitHub rejected an anchor.
      const bodyOnly = buildBodyOnlyReview(doc, review.tiered);
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
   *
   * Off for an EXPLICIT request, and that is not a courtesy — it is the same
   * rule `resolveReviewPost` applies one guard above. The shape this catches is
   * an unprompted re-review of a push that changed nothing a reviewer can read;
   * a maintainer who typed `@bot review` on an unchanged head is asking for
   * precisely the review this would suppress, and would get eight minutes of
   * pipeline and silence. Suppressing a duplicate APPROVE is safe (the check
   * concludes `neutral`, which passes) — but so is posting one, and only one of
   * the two answers the question.
   */
  private repeatOfLastReview(
    last: { state: string; sha: string; body: string | null } | null,
    review: { body: string; event: string; comments: unknown[] },
    explicitRequest: boolean,
  ): string | null {
    if (explicitRequest) return null;
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
    // The RUN CONTEXT is the first authority, for the same reason
    // `analysisEnabled()` reads it: the eval harness threads the arm's
    // `review:` policy through the context and never populates the
    // process-global runtime config, so a boundary read only off
    // `getRuntimeConfig()` silently applies the packaged defaults to every
    // eval arm — found on this pipeline's own PR after three repeats of an
    // arm that pinned `maxBodyComments: null` each recorded 5–14
    // `body-budget` demotions. `specContext` projects all four fields
    // together, so their presence is atomic; production projects them from
    // the same runtime config this fallback reads, so the two authorities
    // cannot disagree there.
    const ctx = this.run.ctx as Record<string, unknown>;
    if (typeof ctx.maxInlineComments === "string") {
      return {
        maxInlineComments: toBudget(ctx.maxInlineComments, defaultReviewConfig().analysis.maxInlineComments),
        thresholds: parseThresholds(ctx.boundaryThresholds),
        internalFloor: toFloor(ctx.internalFloor, defaultReviewConfig().analysis.internalFloor),
        // `"null"` is the literal the projection writes for the documented
        // "unlimited body overflow" value; anything else degrades to the
        // shipped default, the same direction `config.ts` coerces garbage —
        // and read from the same authority, so the two cannot drift apart when
        // the default moves.
        maxBodyComments:
          ctx.maxBodyComments === "null"
            ? null
            : toBudget(ctx.maxBodyComments, defaultReviewConfig().analysis.maxBodyComments ?? 0),
      };
    }
    const analysis = getRuntimeConfig()?.review?.analysis ?? defaultReviewConfig().analysis;
    return {
      maxInlineComments: analysis.maxInlineComments,
      thresholds: analysis.thresholds ?? {},
      internalFloor: analysis.internalFloor,
      // Nullable on purpose — `null` is the documented "unlimited body
      // overflow" value, so it must survive this projection rather than be
      // defaulted away. `??` here would erase the operator's explicit choice.
      maxBodyComments: analysis.maxBodyComments,
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
   * [WP6](../../../../../docs/plans/deterministic-pr-levers.md#adjudication-and-the-attention-boundary-wp6)'s
   * AC1b asks for this in a `review_findings` table, and that table is
   * [WP7](../../../../../docs/plans/deterministic-pr-levers.md#review-memory-wp7)'s
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
        // `reason` is the same machine token the body tier carries, not prose:
        // the sibling eval harness reads this file, and "below the internal
        // floor" as a sentence made the three causes of a withheld finding
        // indistinguishable to anything but a human.
        ...tiered.internal.map((r) => ({
          tier: "internal" as const,
          reason: r.reason as string,
          finding: r.finding,
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

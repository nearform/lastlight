/**
 * Deterministic discovery for the daily dependency crons.
 *
 * The old sweep dispatched ONE `dependabot-pr-merge` run per repo in `mode:
 * scan`, and that run's agent listed + assessed every open dependency PR in a
 * single session. On a busy repo that buries the model in giant lockfile
 * file-lists until its context overflows (or it returns an empty completion) —
 * the whole sweep dies having merged nothing. See the prompt's history.
 *
 * Instead we find the eligible dependency PRs HERE, in code (no LLM), and the
 * caller fans out one bounded single-PR run per PR — each run handles exactly
 * one PR, so overflow is structurally impossible and one bad PR can't sink the
 * others. This is the same division of labour as the real-time
 * `pr.checks_passed` / `pr.checks_failed` webhooks, just run as a backstop on a
 * schedule.
 *
 * Two sweeps share the candidate-listing core:
 *   - GREEN (`discoverGreenDependencyPrs`) → `dependabot-pr-merge`. "Green" is
 *     `mergeable_state === "clean"` — GitHub reports the PR mergeable with all
 *     checks passing, the exact signal the per-PR run itself re-checks before a
 *     direct merge, so discovery and assessment agree on what green means.
 *   - RED (`discoverRedDependencyPrs`) → `dependabot-ci-fix`. "Red" is any
 *     dependency PR that can't merge on its own and that ci-fix can push a fix
 *     for: a SETTLED failing check conclusion (see
 *     GitHubClient.getChecksConclusion — `mergeable_state` alone can't tell
 *     "failing" from "still running", and reports a red PR mergeable on repos
 *     with no *required* checks), OR a `mergeable_state` of `behind` (needs a
 *     base merge), `dirty` (merge conflict), or `blocked` (a required gate
 *     unmet). ci-fix brings the branch up to date and, once its push turns the
 *     checks green, the `pr.checks_passed` webhook hands off to the green sweep
 *     for the merge. A `blocked` PR ci-fix can't unblock (e.g. awaiting a
 *     required human review) is flagged `requires-human` so it stops recurring.
 *     `clean` is the green sweep's job; `unstable` is deliberately left for the
 *     real-time webhook or the next tick. `unknown` is a cold-cache placeholder,
 *     not a verdict — GitHub computes mergeability lazily, so a cold read returns
 *     `unknown` and kicks off the recompute; both sweeps re-poll it with a
 *     widening backoff (`resolveMergeableState`, issue #204) before giving up.
 *
 * **These are candidate finders, not policy** (09-state-machine.md → S1/S2).
 * They answer "does this PR look like it needs this workflow?" — a fact about
 * the pull request. Whether we may ACT on it (the `requires-human` escalation
 * guard, the attempt counter, the cost cap, the per-SHA dedup, the fork guard)
 * is decided once by `resolvePrState` + `resolveDispatchDisposition` at the
 * `dispatchWorkflow` choke point, which the webhook route crosses too. The
 * `requires-human` filter used to live here AND in the dispatcher, and the two
 * disagreed by construction: the label was a one-way door on the cron side
 * while the webhook cleared it on success. Now there is one answer.
 */

/**
 * Last Light dependency-PR lifecycle labels. THE single source of truth for
 * these strings. The discovery exclusion below imports `REQUIRES_HUMAN_LABEL`;
 * the dependabot PROMPTS hardcode the same strings (markdown can't import) —
 * `workflows/prompts/dependabot-pr-merge.md` and `dependabot-ci-fix.md`.
 * `tests/cron/label-vocab.test.ts` asserts those prompt files contain these
 * exact strings so the code and the prompts never drift.
 */
export const DEP_TRIVIAL_LABEL = "dependency-trivial";
export const DEP_FUNCTIONAL_LABEL = "dependency-functional";
export const REQUIRES_HUMAN_LABEL = "requires-human";

/**
 * MAJOR-bump impact tiers (issue #252, 05-impact.md §5.4). Additive: the two
 * labels above keep their meaning, because both are load-bearing for discovery
 * — `dependency-functional` + `requires-human` still means "high impact, a
 * human decides", so nothing about the escalated case changed.
 *
 * These say what the trivial/functional pair cannot: WHY a major was safe to
 * land, or why it was not. Exactly one is ever applied at a time; the merge
 * prompt clears the other two in the same idempotent pass.
 *
 * The hex colours are part of the contract — `github_ensure_labels` creates a
 * missing label with them, so a rename here without the same edit in
 * `workflows/prompts/dependabot-pr-merge.md` produces two label vocabularies on
 * the same repo. `tests/cron/label-vocab.test.ts` pins names and colours
 * against that prompt.
 */
/** Green, matching `dependency-trivial` — a major that reads as trivial. */
export const DEP_MAJOR_LOW_LABEL = "dependency-major-low";
export const DEP_MAJOR_LOW_COLOR = "0e8a16";
/** Amber, matching `dependency-functional` — landed, but worth a glance. */
export const DEP_MAJOR_MEDIUM_LABEL = "dependency-major-medium";
export const DEP_MAJOR_MEDIUM_COLOR = "fbca04";
/** Red, matching `requires-human` — never auto-merged. */
export const DEP_MAJOR_HIGH_LABEL = "dependency-major-high";
export const DEP_MAJOR_HIGH_COLOR = "b60205";

/** The subset of the harness GitHub client this module needs — keeps it fake-able. */
export interface PrDiscoveryClient {
  listOpenPullRequests(
    owner: string,
    repo: string,
  ): Promise<
    Array<{
      number: number;
      title: string;
      draft: boolean;
      authorLogin: string;
      labels: string[];
      headRef: string;
      headSha: string;
    }>
  >;
  getPullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<{ mergeable_state?: string }>;
  getChecksConclusion(
    owner: string,
    repo: string,
    ref: string,
    opts?: { excludeApp?: string },
  ): Promise<"passing" | "failing" | "pending" | "none">;
}

/** Why the red sweep summoned a PR — rendered into the ci-fix prompt as `{{reason}}`. */
export type RedReason = "checks-failing" | "behind" | "dirty" | "blocked";

/** A dependency PR, shaped to match the `pr.checks_passed`/`pr.checks_failed` webhook context. */
export interface DependencyPr {
  /** `owner/repo` full name — the shape `dispatchWorkflow` expects in `context.repo`. */
  repo: string;
  prNumber: number;
  title: string;
  /**
   * PR head ref — set ONLY by the red sweep so `dispatchWorkflow` pre-clones the
   * PR head for `dependabot-ci-fix`'s checkout (a PR_FIX_SHAPED_WORKFLOWS). The
   * green sweep leaves it undefined (the merge workflow has no checkout).
   */
  branch?: string;
  /**
   * Why the red sweep picked this PR (`checks-failing` | `behind` | `dirty` |
   * `blocked`) — set ONLY by the red sweep, threaded into the ci-fix prompt so
   * the agent knows whether it's fixing CI or just un-blocking a merge. The
   * green sweep leaves it undefined.
   */
  reason?: RedReason;
}

/** Bot logins that open dependency-update PRs. */
const DEPENDENCY_BOT_LOGINS = new Set(["dependabot[bot]", "renovate[bot]"]);

/** Titles a dependency bot uses, for the rare case its login is proxied/squashed. */
const DEPENDENCY_TITLE_RE =
  /^(bump |chore\(deps\b|build\(deps\b|deps(-dev)?:|update .*\brequirement\b)/i;

/**
 * Is this open PR a (non-draft) dependency-update PR? Author is the primary
 * signal; the title pattern is a fallback for proxied bot accounts.
 */
export function isDependencyPr(pr: {
  authorLogin: string;
  title: string;
  draft: boolean;
}): boolean {
  if (pr.draft) return false;
  if (DEPENDENCY_BOT_LOGINS.has(pr.authorLogin.toLowerCase())) return true;
  return DEPENDENCY_TITLE_RE.test(pr.title);
}

export interface DiscoverOptions {
  /** Cap the candidates assessed per repo so one pathological repo can't spin
   *  hundreds of runs. They'd queue via admission control anyway, but this
   *  bounds the row count; the next daily tick picks up any remainder. */
  maxPerRepo?: number;
  log?: (msg: string) => void;
  /**
   * Backoff (ms) between re-reads while `mergeable_state` is `unknown` — GitHub
   * computes mergeability lazily, so a cold read returns `unknown` AND triggers
   * the recompute; these delays give it time to settle (issue #204). One entry =
   * one extra read; the poll stops as soon as the state settles, so a normally
   * green PR waits just the first delay. Default `[2s, 4s, 10s]`; tests pass a
   * short/zero array (with `sleep`) to run the loop instantly.
   */
  mergeablePollDelaysMs?: number[];
  /** Injectable sleep for the re-poll backoff (default real `setTimeout`); tests
   *  pass a no-op so the poll loop runs without real delay. */
  sleep?: (ms: number) => Promise<void>;
  /**
   * `dependencies.requireSettledChecks` — when on, the GREEN sweep additionally
   * requires the head SHA's checks to be settled-`passing`, not just
   * `mergeable_state: "clean"`.
   *
   * `clean` alone is not proof: on a repo with **no required status checks** a
   * PR whose checks are FAILING still reports mergeable — the exact hazard the
   * merge prompt documents ("a direct merge would land a RED PR — this has
   * happened"), and the reason the cron's notion of green and the webhook's
   * settle logic must not be allowed to diverge. Costs one extra API call per
   * green candidate, which is why it is config-gated rather than unconditional.
   */
  requireSettledChecks?: boolean;
  /**
   * Our own App slug (`botName`), excluded from every check aggregate here.
   *
   * Both sweeps are TRIGGER-side settle computations, so the uniform rule of
   * 07 §7.2 applies: a `last-light/review` check that is queued or in progress
   * on the head SHA would otherwise report the suite `pending` and strand the
   * PR on both sweeps — the green one because `pending` is not `passing`, the
   * red one because it is not `failing` either.
   */
  botName?: string;
}

const DEFAULT_MAX_PER_REPO = 25;

/**
 * Widening backoff between `mergeable_state` re-reads (issue #204). Only the
 * reads taken while still `unknown` actually happen, so a PR that settles on the
 * first retry waits just 2s; a genuinely-uncomputable PR burns 2+4+10s across
 * three extra reads, then gives up and is left for the webhook / next tick.
 */
const MERGEABLE_POLL_DELAYS_MS = [2000, 4000, 10000];

const realSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/**
 * `mergeable_state` values that keep a PR from merging but that `dependabot-ci-fix`
 * can act on: `behind` (merge the base in), `dirty` (resolve the conflict, almost
 * always the lockfile), `blocked` (a required gate is unmet — ci-fix pushes any
 * fix it can, else flags `requires-human`). `clean` is the green sweep's; `unstable`
 * is caught via the checks conclusion; a cold `unknown` is re-polled
 * (`resolveMergeableState`) and only a still-`unknown` PR is left for a later tick.
 */
const MERGE_BLOCKED_STATES = new Set<RedReason>(["behind", "dirty", "blocked"]);

/** One repo's dependency-PR candidate, carried through the per-sweep filter. */
interface Candidate {
  owner: string;
  repo: string;
  full: string;
  number: number;
  title: string;
  headRef: string;
  headSha: string;
}

/**
 * List one repo's open dependency-PR candidates: is-dependency, non-draft,
 * oldest-first, capped at `maxPerRepo`. Per-repo listing failures are logged
 * and yield `[]`, never fatal, so one inaccessible repo doesn't sink the sweep.
 * Shared by both the green and red sweeps.
 *
 * No `requires-human` filter: that is a POLICY question, and it is now answered
 * once at dispatch off the snapshot's `escalatedBy` / `escalatedAtSha` — which
 * is what lets a maintainer's push re-arm a PR we escalated, instead of the
 * label being a permanent one-way door with no code path that removes it.
 */
async function listDependencyCandidates(
  full: string,
  gh: PrDiscoveryClient,
  maxPerRepo: number,
  log?: (msg: string) => void,
): Promise<Candidate[]> {
  const [owner, repo] = full.split("/");
  if (!owner || !repo) {
    log?.(`[dependabot-discovery] skipping malformed repo "${full}"`);
    return [];
  }

  let open: Awaited<ReturnType<PrDiscoveryClient["listOpenPullRequests"]>>;
  try {
    open = await gh.listOpenPullRequests(owner, repo);
  } catch (err) {
    log?.(`[dependabot-discovery] ${full}: listing PRs failed — ${String(err)}`);
    return [];
  }

  return open
    .filter(isDependencyPr)
    .sort((a, b) => a.number - b.number) // oldest first (the sweep's fairness order)
    .slice(0, maxPerRepo)
    .map((p) => ({
      owner,
      repo,
      full,
      number: p.number,
      title: p.title,
      headRef: p.headRef,
      headSha: p.headSha,
    }));
}

/**
 * Read a PR's `mergeable_state`, re-polling through a cold `unknown` (issue #204).
 *
 * GitHub computes mergeability lazily via a background test-merge: a cold `GET`
 * on a PR whose result hasn't (re)computed returns `mergeable_state: "unknown"`
 * AND kicks off the recompute; a follow-up read a beat later returns the settled
 * value. On a busy repo the base branch moves every few minutes and invalidates
 * every open PR's cached mergeability, so a single cold read almost always
 * catches `unknown` — leaving genuinely-`clean` PRs stranded tick after tick.
 * We re-read with a widening backoff (`MERGEABLE_POLL_DELAYS_MS`) until it
 * settles; a PR still `unknown` after the last delay is returned as-is and left
 * for the webhook / next tick, unchanged.
 *
 * SHARED by both sweeps deliberately: the green sweep enqueues on `clean`, the
 * red sweep routes `behind`/`dirty`/`blocked` — either signal reads `unknown`
 * cold, so the warm read belongs here, not just in the green sweep. Errors
 * propagate to the caller's per-candidate try/catch (which isolates + skips).
 */
async function resolveMergeableState(
  gh: PrDiscoveryClient,
  owner: string,
  repo: string,
  pullNumber: number,
  opts: DiscoverOptions,
): Promise<string | undefined> {
  const delays = opts.mergeablePollDelaysMs ?? MERGEABLE_POLL_DELAYS_MS;
  const sleep = opts.sleep ?? realSleep;
  let state = (await gh.getPullRequest(owner, repo, pullNumber)).mergeable_state;
  for (const delay of delays) {
    if (state !== "unknown") break; // settled — no point polling further
    await sleep(delay);
    state = (await gh.getPullRequest(owner, repo, pullNumber)).mergeable_state;
  }
  return state;
}

/**
 * Find every green (`mergeable_state: "clean"`) dependency PR across `repos`
 * (`owner/repo` full names), EXCLUDING any carrying the `requires-human` label.
 * A cold `unknown` read is re-polled (`resolveMergeableState`) before giving up,
 * so a genuinely-mergeable-but-uncomputed PR isn't stranded for want of a second
 * read (issue #204). Per-repo failures are logged and skipped, never fatal.
 */
export async function discoverGreenDependencyPrs(
  repos: string[],
  gh: PrDiscoveryClient,
  opts: DiscoverOptions = {},
): Promise<DependencyPr[]> {
  const maxPerRepo = opts.maxPerRepo ?? DEFAULT_MAX_PER_REPO;
  const out: DependencyPr[] = [];

  for (const full of repos) {
    for (const c of await listDependencyCandidates(full, gh, maxPerRepo, opts.log)) {
      let state: string | undefined;
      try {
        state = await resolveMergeableState(gh, c.owner, c.repo, c.number, opts);
      } catch (err) {
        opts.log?.(`[dependabot-discovery] ${c.full}#${c.number}: fetch failed — ${String(err)}`);
        continue;
      }
      // Only genuinely-green PRs. `unstable`/`blocked`/`behind`/`dirty` (and a PR
      // still `unknown` after the re-poll) are left for the real-time webhook or
      // the next tick once they go clean.
      if (state !== "clean") continue;

      // `clean` is GitHub's mergeability verdict, not a CI verdict — on a repo
      // with no *required* checks a red PR is still "clean". Ask the checks
      // directly so the cron's green means the same thing the webhook's does.
      if (opts.requireSettledChecks) {
        let conclusion: Awaited<ReturnType<PrDiscoveryClient["getChecksConclusion"]>>;
        try {
          conclusion = await gh.getChecksConclusion(c.owner, c.repo, c.headSha || c.headRef, {
          excludeApp: opts.botName,
        });
        } catch (err) {
          // Fail CLOSED here, uniquely: every other read in this module fails
          // open because a dropped candidate costs one tick, whereas a
          // wrongly-green candidate costs a merged red PR.
          opts.log?.(`[dependabot-discovery] ${c.full}#${c.number}: checks read failed — ${String(err)}`);
          continue;
        }
        if (conclusion !== "passing") {
          opts.log?.(
            `[dependabot-discovery] ${c.full}#${c.number}: mergeable_state=clean but checks are ${conclusion} — not green`,
          );
          continue;
        }
      }

      out.push({ repo: c.full, prNumber: c.number, title: c.title });
    }
  }

  return out;
}

/**
 * Find every RED dependency PR across `repos` (`owner/repo` full names) that
 * `dependabot-ci-fix` can act on, EXCLUDING any carrying the `requires-human`
 * label. A PR qualifies when its checks are settled-FAILING, OR its
 * `mergeable_state` is `behind` / `dirty` / `blocked` (a merge it can't make on
 * its own but ci-fix can push toward — see `MERGE_BLOCKED_STATES`). Failing CI
 * takes precedence in the reported `reason` (there's a concrete build to fix).
 * Contexts carry `branch` (the PR head ref) so `dependabot-ci-fix` pre-clones
 * the PR head, and `reason` so its prompt knows why it was summoned. Per-repo /
 * per-candidate failures are logged and skipped, never fatal.
 */
export async function discoverRedDependencyPrs(
  repos: string[],
  gh: PrDiscoveryClient,
  opts: DiscoverOptions = {},
): Promise<DependencyPr[]> {
  const maxPerRepo = opts.maxPerRepo ?? DEFAULT_MAX_PER_REPO;
  const out: DependencyPr[] = [];

  for (const full of repos) {
    for (const c of await listDependencyCandidates(full, gh, maxPerRepo, opts.log)) {
      let conclusion: Awaited<ReturnType<PrDiscoveryClient["getChecksConclusion"]>>;
      let mergeableState: string | undefined;
      try {
        // Query the exact commit we listed (headSha) so a mid-sweep push can't
        // make us read a newer commit's checks; fall back to the ref if absent.
        conclusion = await gh.getChecksConclusion(c.owner, c.repo, c.headSha || c.headRef, {
          excludeApp: opts.botName,
        });
        // A settled-failing build is reason enough (and makes the mergeable
        // signal moot), so skip the potentially-slow `unknown` re-poll for it;
        // otherwise warm the read so a cold `unknown` that's really behind/dirty/
        // blocked isn't stranded on the red side either (issue #204).
        mergeableState =
          conclusion === "failing"
            ? undefined
            : await resolveMergeableState(gh, c.owner, c.repo, c.number, opts);
      } catch (err) {
        opts.log?.(
          `[dependabot-discovery] ${c.full}#${c.number}: fetch failed — ${String(err)}`,
        );
        continue;
      }
      // Settled-failing CI (fix the build), OR a mergeable_state ci-fix can push
      // toward (behind/dirty/blocked). `passing`/`pending`/`none` checks with a
      // `clean`/`unstable` state (or one still `unknown` after the re-poll) are
      // left for the webhook or next tick.
      const blockedByMerge =
        mergeableState !== undefined && MERGE_BLOCKED_STATES.has(mergeableState as RedReason);
      if (conclusion === "failing" || blockedByMerge) {
        const reason: RedReason =
          conclusion === "failing" ? "checks-failing" : (mergeableState as RedReason);
        out.push({ repo: c.full, prNumber: c.number, title: c.title, branch: c.headRef, reason });
      }
    }
  }

  return out;
}

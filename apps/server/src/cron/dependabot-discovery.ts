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
 *     `clean` is the green sweep's job; `unstable`/`unknown` are deliberately
 *     left for the real-time webhook or the next tick.
 *
 * Both sweeps SKIP any PR carrying the `requires-human` label — the terminal
 * flag the dependabot prompts apply when Last Light can't proceed automatically
 * (a functional merge left for a human, or a CI fix it couldn't complete). That
 * stops the nightly crons re-attempting things we already know we can't land.
 * The webhooks are NOT label-gated, so a genuinely new bot push is still handled
 * live and the success path clears the label.
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
}

const DEFAULT_MAX_PER_REPO = 25;

/**
 * `mergeable_state` values that keep a PR from merging but that `dependabot-ci-fix`
 * can act on: `behind` (merge the base in), `dirty` (resolve the conflict, almost
 * always the lockfile), `blocked` (a required gate is unmet — ci-fix pushes any
 * fix it can, else flags `requires-human`). `clean` is the green sweep's; `unstable`
 * is caught via the checks conclusion; `unknown` is left for a later tick.
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
 * List + filter one repo's open dependency-PR candidates: is-dependency,
 * non-draft, NOT carrying the `requires-human` label, oldest-first, capped at
 * `maxPerRepo`. Per-repo listing failures are logged and yield `[]`, never
 * fatal, so one inaccessible repo doesn't sink the sweep. Shared by both the
 * green and red sweeps.
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
    // Don't re-attempt what we already flagged as needing a human.
    .filter((p) => !p.labels.includes(REQUIRES_HUMAN_LABEL))
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
 * Find every green (`mergeable_state: "clean"`) dependency PR across `repos`
 * (`owner/repo` full names), EXCLUDING any carrying the `requires-human` label.
 * Per-repo failures are logged and skipped, never fatal.
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
      let detail: { mergeable_state?: string };
      try {
        detail = await gh.getPullRequest(c.owner, c.repo, c.number);
      } catch (err) {
        opts.log?.(`[dependabot-discovery] ${c.full}#${c.number}: fetch failed — ${String(err)}`);
        continue;
      }
      // Only genuinely-green PRs. `unstable`/`blocked`/`behind`/`dirty`/`unknown`
      // are left for the real-time webhook or the next tick once they go clean.
      if (detail.mergeable_state === "clean") {
        out.push({ repo: c.full, prNumber: c.number, title: c.title });
      }
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
        conclusion = await gh.getChecksConclusion(c.owner, c.repo, c.headSha || c.headRef);
        mergeableState = (await gh.getPullRequest(c.owner, c.repo, c.number)).mergeable_state;
      } catch (err) {
        opts.log?.(
          `[dependabot-discovery] ${c.full}#${c.number}: fetch failed — ${String(err)}`,
        );
        continue;
      }
      // Settled-failing CI (fix the build), OR a mergeable_state ci-fix can push
      // toward (behind/dirty/blocked). `passing`/`pending`/`none` checks with a
      // `clean`/`unstable`/`unknown` state are left for the webhook or next tick.
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

/**
 * CANDIDATE FINDER for the pr-review cron (`check-prs-awaiting-review`).
 *
 * Finds the open PRs across `repos` that could plausibly want a review, in code
 * (no LLM). The caller fans out one bounded single-PR `pr-review` run per
 * result, with `prNumber` + head ref set (see `src/index.ts`) — the exact shape
 * the `pr.opened` webhook produces: a fresh per-repo scoped token, a pre-clone
 * of the PR head, and a real PR number for `post-review` to post to.
 *
 * **It holds no policy** (09-state-machine.md → S2). It used to filter drafts
 * and call `getLatestBotReview` per candidate, which made it a third
 * implementation of `review.trigger` alongside the webhook gate and the comment
 * path's silent bypass — in a plan whose whole thesis is "make the policy
 * configurable rather than hardcoded". The split is DISCOVERY vs POLICY, not
 * cron vs webhook: draft, already-reviewed-at-this-head, run-in-flight and the
 * trigger mode are all fields of the `PrState` snapshot that
 * `resolveReviewTrigger` decides over, once, at the dispatch choke point every
 * route crosses.
 *
 * The one filter that stays is not policy but arithmetic: GitHub 422s an
 * attempt to review your own pull request, so a bot-authored PR is not a
 * candidate in the first place.
 *
 * This replaces the old `mode: scan` run, whose single agent listed and reviewed
 * PRs itself inside the sandbox — which couldn't reliably auth (a static token
 * with no in-sandbox re-mint), couldn't pre-clone (no PR known up front), and
 * had no way to hand its chosen PR back to `post-review`, so it could never
 * actually post. The dependabot crons were migrated off `mode: scan` for the
 * same reasons (`src/cron/dependabot-discovery.ts`); this is that same move.
 */

import type { DependencyPr } from "./dependabot-discovery.js";

/** The subset of the harness GitHub client this needs — keeps it fake-able. */
export interface ReviewDiscoveryClient {
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
}

export interface ReviewDiscoverOptions {
  log?: (msg: string) => void;
  /**
   * Bot login incl. the `[bot]` suffix (e.g. `last-light[bot]`). The bot's own
   * PRs are not candidates — GitHub refuses a self-review outright. Defaults to
   * `last-light[bot]`; the caller passes the configured `botLogin` so a renamed
   * App slug matches.
   */
  botLogin?: string;
  /**
   * Cap the candidates offered per repo per tick, so one busy repo can't spin
   * hundreds of dispatches at once. Oldest-first, so the cap is stable across
   * ticks rather than starving the same tail every time.
   *
   * This used to cap runs DISPATCHED, walking every open PR and stopping after
   * N *unreviewed* ones. That distinction died with the per-candidate
   * `getLatestBotReview` call: the dispatch gate now answers "already reviewed
   * at this head" from the one `PrState` snapshot it resolves anyway, so a
   * candidate that turns out to be reviewed is a cheap gate skip, not a run.
   * Runs also queue against the global admission cap. Default 25.
   */
  maxPerRepo?: number;
}

const DEFAULT_BOT_LOGIN = "last-light[bot]";
const DEFAULT_MAX_PER_REPO = 25;

export async function discoverPrsAwaitingReview(
  repos: string[],
  gh: ReviewDiscoveryClient,
  opts: ReviewDiscoverOptions = {},
): Promise<DependencyPr[]> {
  const botLogin = opts.botLogin ?? DEFAULT_BOT_LOGIN;
  const maxPerRepo = opts.maxPerRepo ?? DEFAULT_MAX_PER_REPO;
  const out: DependencyPr[] = [];

  for (const full of repos) {
    const [owner, repo] = full.split("/");
    if (!owner || !repo) {
      opts.log?.(`[review-discovery] skipping malformed repo "${full}"`);
      continue;
    }

    let open: Awaited<ReturnType<ReviewDiscoveryClient["listOpenPullRequests"]>>;
    try {
      open = await gh.listOpenPullRequests(owner, repo);
    } catch (err) {
      // Per-repo failure is logged and skipped, never fatal, so one inaccessible
      // repo doesn't sink the sweep.
      opts.log?.(`[review-discovery] ${full}: listing PRs failed — ${String(err)}`);
      continue;
    }

    const candidates = open
      .filter((pr) => pr.authorLogin !== botLogin)
      .sort((a, b) => a.number - b.number) // oldest first — deterministic, fair
      .slice(0, maxPerRepo);

    for (const pr of candidates) {
      out.push({ repo: full, prNumber: pr.number, title: pr.title, branch: pr.headRef });
    }
  }

  return out;
}

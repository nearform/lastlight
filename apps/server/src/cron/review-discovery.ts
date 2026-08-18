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
   * Bot login incl. the `[bot]` suffix (e.g. `last-light[bot]`). Defaults to
   * `last-light[bot]`; the caller passes the configured `botLogin` so a renamed
   * App slug matches.
   *
   * Only load-bearing for a `BOT_LOGIN` overridden to something without the
   * `[bot]` suffix — {@link isBotAuthored} drops EVERY bot-authored PR, ours
   * included, matching the webhook route.
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

/**
 * Is this PR authored by a bot — ANY bot, not just us?
 *
 * The webhook route's predicate, verbatim (`connectors/github-webhook.ts` →
 * `isBotAuthoredPr`), because the two routes must answer this identically. They
 * did not: discovery compared against our own `botLogin` alone, so a PR opened
 * by a *different* App installed on the same repo was dropped by the webhook and
 * accepted by the sweep.
 *
 * That is not hypothetical. The `nearform` instance runs as
 * `nearform-lastlight[bot]` on repos that also carry PRs opened by
 * `last-light[bot]`; none of them matched, so all seven were re-dispatched every
 * 30 minutes. Each run reached the agent, which correctly refused to self-review
 * — at full sandbox cost, ~$1.30/hour indefinitely, because a refusal posts no
 * review and the per-head dedup keys on a POSTED one. The dedup hole is closed
 * separately (`resolveReviewTrigger`'s `already-assessed` branch); this closes
 * the reason those PRs were candidates at all.
 *
 * Widening past our own login is right on the merits too: the App cannot submit
 * a formal review of any bot's PR it authored, dependency PRs belong to the
 * dependabot crons rather than here, and a review nobody reads is spend without
 * a reader.
 *
 * `botLogin` is still checked explicitly — `BOT_LOGIN` may override it to a
 * string that does not carry the suffix.
 */
function isBotAuthored(authorLogin: string, botLogin: string): boolean {
  return authorLogin === botLogin || authorLogin.endsWith("[bot]");
}

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
      .filter((pr) => !isBotAuthored(pr.authorLogin, botLogin))
      .sort((a, b) => a.number - b.number) // oldest first — deterministic, fair
      .slice(0, maxPerRepo);

    for (const pr of candidates) {
      out.push({ repo: full, prNumber: pr.number, title: pr.title, branch: pr.headRef });
    }
  }

  return out;
}

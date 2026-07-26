/**
 * Deterministic discovery for the pr-review cron (`check-prs-awaiting-review`).
 *
 * Finds the open PRs that need a review — open, non-draft, NOT authored by the
 * bot, and WITHOUT a bot review at the PR's current head SHA — across `repos`,
 * in code (no LLM). The caller fans out one bounded single-PR `pr-review` run
 * per result, with `prNumber` + head ref set (see `src/index.ts`) — the exact
 * shape the `pr.opened` webhook produces: a fresh per-repo scoped token, a
 * pre-clone of the PR head, and a real PR number for `post-review` to post to.
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
  /** The bot's most recent review on this PR's CURRENT head SHA, or null when
   * the bot hasn't reviewed this SHA yet (re-pushes invalidate a stale review). */
  getLatestBotReview(
    owner: string,
    repo: string,
    pullNumber: number,
    headSha: string,
    botLogin?: string,
  ): Promise<{ state: string } | null>;
}

export interface ReviewDiscoverOptions {
  log?: (msg: string) => void;
  /**
   * Bot login incl. the `[bot]` suffix (e.g. `last-light[bot]`). The bot's own
   * PRs are skipped (never self-review), and its review at the current head SHA
   * marks a PR done. Defaults to `last-light[bot]`; the caller passes the
   * configured `botLogin` so a renamed App slug matches.
   */
  botLogin?: string;
  /**
   * Cap the number of runs DISPATCHED per repo per tick (not candidates
   * examined) so one busy repo can't spin hundreds of runs at once. The check
   * walks all open PRs and stops after this many *unreviewed* ones, so
   * already-reviewed PRs in the oldest positions never starve unreviewed PRs
   * behind them. Runs also queue against the global admission cap. Default 25.
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
      .filter((pr) => !pr.draft && pr.authorLogin !== botLogin)
      .sort((a, b) => a.number - b.number); // oldest first — deterministic, fair

    // Cap RUNS dispatched, not candidates examined: walk every open PR and stop
    // once we've queued `maxPerRepo` UNreviewed ones. Slicing before the review
    // check would starve unreviewed PRs behind a block of already-reviewed ones
    // (the steady state), deferring them indefinitely.
    let dispatched = 0;
    for (const pr of candidates) {
      if (dispatched >= maxPerRepo) break;
      let reviewed: boolean;
      try {
        reviewed = !!(await gh.getLatestBotReview(owner, repo, pr.number, pr.headSha, botLogin));
      } catch (err) {
        // Can't tell → skip this tick rather than risk a duplicate review. The
        // next tick retries, and `post-review` is itself idempotent on the head
        // SHA, so a missed check here can't cause a double-post downstream.
        opts.log?.(`[review-discovery] ${full}#${pr.number}: review lookup failed — ${String(err)}`);
        continue;
      }
      if (reviewed) continue; // already reviewed at the current head SHA
      out.push({ repo: full, prNumber: pr.number, title: pr.title, branch: pr.headRef });
      dispatched++;
    }
  }

  return out;
}

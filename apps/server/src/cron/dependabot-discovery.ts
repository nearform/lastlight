/**
 * Deterministic discovery for the daily dependency-merge cron.
 *
 * The old sweep dispatched ONE `dependabot-pr-merge` run per repo in `mode:
 * scan`, and that run's agent listed + assessed every open dependency PR in a
 * single session. On a busy repo that buries the model in giant lockfile
 * file-lists until its context overflows (or it returns an empty completion) —
 * the whole sweep dies having merged nothing. See the prompt's history.
 *
 * Instead we find the green dependency PRs HERE, in code (no LLM), and the
 * caller fans out one bounded single-PR run per PR — each assesses exactly one
 * PR, so overflow is structurally impossible and one bad PR can't sink the
 * others. This is the same division of labour as the real-time
 * `pr.checks_passed` webhook, just run as a backstop on a schedule.
 *
 * "Green" here is `mergeable_state === "clean"` — GitHub reports a PR mergeable
 * with all checks passing. It's the exact signal the per-PR run itself uses
 * before a direct merge, so discovery and assessment agree on what green means.
 */

/** The subset of the harness GitHub client this module needs — keeps it fake-able. */
export interface PrDiscoveryClient {
  listOpenPullRequests(
    owner: string,
    repo: string,
  ): Promise<Array<{ number: number; title: string; draft: boolean; authorLogin: string }>>;
  getPullRequest(
    owner: string,
    repo: string,
    pullNumber: number,
  ): Promise<{ mergeable_state?: string }>;
}

/** A green dependency PR, shaped to match the `pr.checks_passed` webhook context. */
export interface DependencyPr {
  /** `owner/repo` full name — the shape `dispatchWorkflow` expects in `context.repo`. */
  repo: string;
  prNumber: number;
  title: string;
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
 * Find every green (`mergeable_state: "clean"`) dependency PR across `repos`
 * (`owner/repo` full names). Per-repo failures are logged and skipped, never
 * fatal, so one inaccessible repo doesn't sink the sweep.
 */
export async function discoverGreenDependencyPrs(
  repos: string[],
  gh: PrDiscoveryClient,
  opts: DiscoverOptions = {},
): Promise<DependencyPr[]> {
  const maxPerRepo = opts.maxPerRepo ?? DEFAULT_MAX_PER_REPO;
  const out: DependencyPr[] = [];

  for (const full of repos) {
    const [owner, repo] = full.split("/");
    if (!owner || !repo) {
      opts.log?.(`[dependabot-discovery] skipping malformed repo "${full}"`);
      continue;
    }

    let open: Awaited<ReturnType<PrDiscoveryClient["listOpenPullRequests"]>>;
    try {
      open = await gh.listOpenPullRequests(owner, repo);
    } catch (err) {
      opts.log?.(`[dependabot-discovery] ${full}: listing PRs failed — ${String(err)}`);
      continue;
    }

    // Oldest first (the sweep's fairness order), bounded per repo.
    const candidates = open
      .filter(isDependencyPr)
      .sort((a, b) => a.number - b.number)
      .slice(0, maxPerRepo);

    for (const pr of candidates) {
      let detail: { mergeable_state?: string };
      try {
        detail = await gh.getPullRequest(owner, repo, pr.number);
      } catch (err) {
        opts.log?.(`[dependabot-discovery] ${full}#${pr.number}: fetch failed — ${String(err)}`);
        continue;
      }
      // Only genuinely-green PRs. `unstable`/`blocked`/`behind`/`dirty`/`unknown`
      // are left for the real-time webhook or the next tick once they go clean.
      if (detail.mergeable_state === "clean") {
        out.push({ repo: full, prNumber: pr.number, title: pr.title });
      }
    }
  }

  return out;
}

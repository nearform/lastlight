import { getManagedRepos } from "../../managed-repos.js";
import { getRuntimeConfig, type TeamVisibilityConfig } from "../../config/config.js";
import { logger } from "../../logging/logger.js";
import type { TeamStore, ResolvedTeam, VisibilitySyncStatus } from "../../state/team-store.js";
import type { GitHubClient } from "./github.js";

const log = logger("team-visibility");

/**
 * Why `repos` is what it is. Only `ok` yields a filter; every other value means
 * "show everything", and they are distinguished so the dashboard (and an
 * operator debugging a install) can tell "you're in no team" from "we couldn't
 * ask GitHub".
 */
export type VisibilityReason =
  | "ok"
  | "no-identity"
  | "disabled"
  | "unavailable"
  | "no-teams"
  | "too-many-teams"
  | "truncated"
  | "budget"
  | "error";

export interface VisibilityResult {
  /**
   * Managed repos to show — or `null`, the fail-open sentinel meaning "no
   * filter". Never an empty array: an empty result IS a fail-open case, because
   * an empty filter would blank the dashboard for somebody who can see plenty.
   */
  repos: string[] | null;
  /** Coarse "we have a resolved answer for this person" flag, for the UI hint. */
  synced: boolean;
  reason: VisibilityReason;
  /** Teams the answer was derived from (empty unless `ok`). */
  teams: Array<{ org: string; slug: string }>;
  /** When this login was last resolved, ISO — null if never. */
  syncedAt: string | null;
}

const FAIL_OPEN = (reason: VisibilityReason, syncedAt: string | null = null): VisibilityResult => ({
  repos: null,
  synced: false,
  reason,
  teams: [],
  syncedAt,
});

export const DEFAULT_TEAM_VISIBILITY: TeamVisibilityConfig = {
  enabled: false,
  ttlMinutes: 60,
  maxTeamsPerUser: 50,
  maxPagesPerTeam: 20,
  maxRequestsPerResolve: 60,
};

export interface TeamVisibilityDeps {
  store: TeamStore;
  /** Absent/null in chat-only mode and in tests that don't need GitHub. */
  github?: GitHubClient | null;
  /** Overridable for tests; defaults to the loaded runtime config. */
  config?: () => TeamVisibilityConfig;
  /** Overridable for tests; defaults to the effective managed-repo list. */
  managedRepos?: () => string[];
}

/**
 * Resolves "which managed repos should this person see in the dashboard?" —
 * the server half of issue #169.
 *
 * ## This answers a PREFERENCE, not an entitlement
 *
 * The repos returned here are the ones a person's teams own, **plus the ones
 * their own account owns** — which is still **not** the same as the repos they
 * can reach. Org owners and direct collaborators reach repos no team grants
 * them: a dry run against the live nearform install found one maintainer's
 * single team (`nearformers`) covering 4 of 8 managed repos, hiding
 * `nearform/lastlight` itself, on which they hold `admin` via org ownership.
 *
 * The ownership union closes the one gap that was pure artefact rather than
 * approximation: teams are an ORG concept, so a repo under somebody's personal
 * account could never be granted by a team, and a strictly team-derived answer
 * hid every one of them — on an instance managing mostly personal repos, that
 * was most of the dashboard. See {@link ownedManagedRepos}, and note the test
 * is `owner === login`, not "the owner is not an org".
 *
 * That is precisely why the dashboard filter this feeds is **opt-in and off by
 * default**. As a default it would hide people's own work; as a filter somebody
 * switched on for themselves it is the decluttering they asked for, reversible
 * in one click. The distinction to hold onto is between "what can you reach"
 * (permission) and "what do you work on" (involvement) — they coincide for a
 * regular org member and diverge completely for an owner, for whom no
 * access-derived rule could declutter anything at all.
 *
 * So: never present this as visibility or access, and never apply it to a user
 * who did not ask for it.
 *
 * ## Why this is lazy
 *
 * The obvious design is an org-wide sync: walk every managed repo, list the
 * teams with a grant, then pull each team's repos and members. In an org with
 * thousands of repos and hundreds of teams that is thousands of API requests
 * before it produces a single answer, and nearly all of it describes teams
 * nobody who uses the dashboard belongs to.
 *
 * So nothing is enumerated up front. When a person asks, we ask GitHub for
 * **their** teams (`Organization.teams(userLogins:)` — the filter is applied
 * server-side, so it is one request for somebody in four teams), then each of
 * those teams' repo grant, intersected with the managed set. A person in four
 * teams costs roughly six GraphQL requests, once per TTL. The org's size drops
 * out of the cost entirely.
 *
 * ## Why every failure shows MORE, never less
 *
 * This is UI declutter — the server keeps returning global data on every list
 * endpoint and hand-crafted API calls still see everything (see the issue's
 * non-goals). Nothing here is a security boundary. That is what licenses the
 * budgets: when a team is too big to enumerate, or a person is in too many
 * teams, or GitHub says no, we return the `null` sentinel and the dashboard
 * filters nothing. A *partial* list would be the genuinely harmful outcome —
 * it hides work somebody is responsible for, and looks exactly like the repo
 * having no activity.
 *
 * ## Staleness
 *
 * A cached answer is served immediately and refreshed in the background once it
 * is past `ttlMinutes`, so a dashboard request never waits on GitHub except on
 * the very first resolution. `team` / `membership` / `organization` webhooks
 * drop affected rows outright (see `connectors/github-webhook.ts`), which turns
 * the next request into that first-resolution path.
 */
export class TeamVisibilityResolver {
  private readonly store: TeamStore;
  private readonly github?: GitHubClient | null;
  private readonly readConfig: () => TeamVisibilityConfig;
  private readonly readManagedRepos: () => string[];
  /** login → in-flight resolution, so N dashboard polls cause ONE GitHub walk. */
  private inFlight = new Map<string, Promise<VisibilityResult>>();

  constructor(deps: TeamVisibilityDeps) {
    this.store = deps.store;
    this.github = deps.github;
    this.readConfig =
      deps.config ?? (() => getRuntimeConfig()?.teamVisibility ?? DEFAULT_TEAM_VISIBILITY);
    this.readManagedRepos = deps.managedRepos ?? getManagedRepos;
  }

  /**
   * The repos `login` should see. Never throws and never blocks on GitHub when a
   * cached answer exists — a stale one is returned as-is while a refresh runs
   * in the background.
   */
  async visibleRepos(login: string | undefined): Promise<VisibilityResult> {
    if (!login) return FAIL_OPEN("no-identity");
    const config = this.readConfig();
    if (!config.enabled) return FAIL_OPEN("disabled");
    if (!this.github) return FAIL_OPEN("unavailable");

    const sync = await this.store.getSync(login);
    if (sync) {
      const fresh = await this.store.isFresh(login, config.ttlMinutes * 60_000);
      if (!fresh) {
        // Stale-while-revalidate: hand back what we have, refresh behind the
        // request. Errors are swallowed — the cached answer already stands.
        void this.resolve(login, config).catch(() => undefined);
      }
      return this.fromCache(login, sync.status, sync.syncedAt);
    }
    return this.resolve(login, config);
  }

  /** Force a fresh resolution, ignoring the TTL (the admin re-sync route). */
  async resync(login: string): Promise<VisibilityResult> {
    const config = this.readConfig();
    if (!config.enabled) return FAIL_OPEN("disabled");
    if (!this.github) return FAIL_OPEN("unavailable");
    await this.store.invalidateLogin(login);
    return this.resolve(login, config);
  }

  /**
   * Managed repos owned by this login's OWN account.
   *
   * A personal account has no teams — teams are an org concept — so a repo
   * under your own login can never arrive via a team grant, and a purely
   * team-derived filter hid every one of them. That is backwards: team grants
   * are a proxy for involvement, and nobody is more involved in a repo than its
   * owner.
   *
   * **The test is `owner === login`, NOT "the owner is not an organization".**
   * The second reads as the same thing on a single-owner instance and is a
   * disclosure bug on any other: it would put every OTHER person's personal
   * repos into your filter. GitHub shares one namespace between users and orgs,
   * so an exact login match is unambiguous — and free, because the owner is
   * already in the managed string. No API call, nothing to cache.
   */
  private ownedManagedRepos(login: string, managed: Iterable<string>): string[] {
    const owned: string[] = [];
    for (const full of managed) {
      const slash = full.indexOf("/");
      if (slash > 0 && full.slice(0, slash) === login) owned.push(full);
    }
    return owned;
  }

  /** Project a stored status + the cached rows into a result. */
  private async fromCache(
    login: string,
    status: VisibilitySyncStatus,
    syncedAt: string | null,
  ): Promise<VisibilityResult> {
    // An INCOMPLETE team answer stays fail-open, and is deliberately NOT
    // rescued by the owned repos below. "Your own repos, plus an unknown
    // fraction of your teams'" is still a partial answer, and filtering to it
    // would hide precisely the org repos the truncated/errored half would have
    // contributed — the same reasoning that makes a partial org set fail the
    // whole pass. Only a COMPLETE team answer (`ok` or `empty`) is augmented.
    if (status !== "ok" && status !== "empty") {
      const reason: VisibilityReason =
        status === "truncated" ? "truncated" : status === "disabled" ? "disabled" : "error";
      return FAIL_OPEN(reason, syncedAt);
    }
    const cached = await this.store.reposForLogin(login);
    // A team that has since been marked truncated, or rows that vanished under
    // us, must not narrow the view.
    if (cached.truncated) return FAIL_OPEN("truncated", syncedAt);
    // Re-intersect with the LIVE managed list: a repo removed from the
    // installation since the resolution must not linger in somebody's filter.
    // The owned set is derived from that same live list rather than persisted,
    // so it has no cache of its own and cannot go stale against it — which is
    // also why `status: "empty"` (no teams at all) can still yield a filter.
    const managed = new Set(this.readManagedRepos());
    const repos = [
      ...new Set([
        ...cached.repos.filter((r) => managed.has(r)),
        ...this.ownedManagedRepos(login, managed),
      ]),
    ].sort();
    if (repos.length === 0) return { ...FAIL_OPEN("no-teams", syncedAt), synced: true };
    return { repos, synced: true, reason: "ok", teams: cached.teams, syncedAt };
  }

  /** One resolution pass, deduped per login. */
  private resolve(login: string, config: TeamVisibilityConfig): Promise<VisibilityResult> {
    const existing = this.inFlight.get(login);
    if (existing) return existing;
    const pending = this.resolveUncached(login, config)
      .catch((err: unknown) => {
        // resolveUncached is already total; this is the last-resort net so a
        // dashboard request can never 500 on a visibility lookup.
        log.warn("Team visibility resolution failed", { login, err });
        return FAIL_OPEN("error");
      })
      .finally(() => this.inFlight.delete(login));
    this.inFlight.set(login, pending);
    return pending;
  }

  private async resolveUncached(
    login: string,
    config: TeamVisibilityConfig,
  ): Promise<VisibilityResult> {
    const github = this.github;
    if (!github) return FAIL_OPEN("unavailable");

    const managed = this.readManagedRepos();
    // Nothing is managed yet (pre-boot-discovery, or a fresh install) — there
    // is nothing to filter and no point spending requests to learn that.
    if (managed.length === 0) return FAIL_OPEN("unavailable");

    const byOrg = new Map<string, Set<string>>();
    for (const full of managed) {
      const owner = full.split("/")[0];
      if (!owner) continue;
      const set = byOrg.get(owner) ?? new Set<string>();
      set.add(full);
      byOrg.set(owner, set);
    }

    let requests = 0;
    const budgetLeft = () => config.maxRequestsPerResolve - requests;
    const teams: ResolvedTeam[] = [];
    let truncated = false;
    let overBudget = false;
    let tooManyTeams = false;
    let failure: string | undefined;

    for (const [org, orgManaged] of byOrg) {
      if (budgetLeft() <= 0) {
        overBudget = true;
        break;
      }
      let orgTeams: Array<{ slug: string; name: string | null }>;
      try {
        const res = await github.listUserTeams(org, login, { maxPages: 5 });
        requests += res.requests;
        orgTeams = res.teams;
      } catch (err: unknown) {
        // The App not being installed on this owner, or a missing
        // `Members: read` grant. Either way we did not learn this org's answer,
        // so the whole pass fails open — see the status computation below.
        // (A personal-account owner is NOT here: `listUserTeams` reports it as
        // an empty team list, because "not an org" is an answer, not a fault.)
        failure = err instanceof Error ? err.message : String(err);
        log.warn("Could not list teams for user", { org, login, err });
        continue;
      }
      if (orgTeams.length > config.maxTeamsPerUser) {
        tooManyTeams = true;
        break;
      }
      for (const team of orgTeams) {
        if (budgetLeft() <= 0) {
          overBudget = true;
          break;
        }
        try {
          const pages = Math.max(1, Math.min(config.maxPagesPerTeam, budgetLeft()));
          const grant = await github.listTeamRepos(org, team.slug, {
            maxPages: pages,
            // Stop the moment this team's grant already covers every managed
            // repo in the org — the common case for an org-wide team, and it
            // turns a 2000-repo walk into one page.
            isDone: (seen) => countManaged(seen, orgManaged) === orgManaged.size,
          });
          requests += grant.requests;
          if (grant.truncated) truncated = true;
          teams.push({
            org,
            slug: team.slug,
            name: team.name,
            repos: grant.repos.filter((r) => orgManaged.has(r)),
            truncated: grant.truncated,
          });
        } catch (err: unknown) {
          failure = err instanceof Error ? err.message : String(err);
          log.warn("Could not list repos for team", { org, team: team.slug, err });
        }
      }
      if (overBudget || tooManyTeams) break;
    }

    // ANY failure fails the whole pass, even when other orgs answered cleanly.
    // A partial org set is a PARTIAL ANSWER: if `nearform` resolves and
    // `mirevue` errors, filtering to nearform's repos alone hides every mirevue
    // repo the person can see. Same reasoning as `truncated` — the only safe
    // incomplete answer is no answer.
    const status: VisibilitySyncStatus =
      tooManyTeams || overBudget || truncated
        ? "truncated"
        : failure
          ? "error"
          : teams.some((t) => t.repos.length > 0)
            ? "ok"
            : "empty";

    await this.store.recordResolution({
      login,
      // A truncated/errored pass persists nothing to join against — its rows
      // would be a partial answer, and the status already forces fail-open.
      teams: status === "ok" || status === "empty" ? teams : [],
      status,
      detail: tooManyTeams
        ? `login is in more than ${config.maxTeamsPerUser} teams`
        : overBudget
          ? `resolution exceeded ${config.maxRequestsPerResolve} requests`
          : truncated
            ? "a team's repo grant exceeded the page budget"
            : failure,
    });
    log.info("Resolved dashboard repo visibility", {
      login,
      status,
      requests,
      teams: teams.length,
      repos: teams.reduce((n, t) => n + t.repos.length, 0),
    });

    if (tooManyTeams) return FAIL_OPEN("too-many-teams");
    if (overBudget) return FAIL_OPEN("budget");
    if (truncated) return FAIL_OPEN("truncated");
    if (status === "error") return FAIL_OPEN("error");
    return this.fromCache(login, status, (await this.store.getSync(login))?.syncedAt ?? null);
  }
}

/** How many of `seen` are in the managed set — the early-exit predicate's input. */
function countManaged(seen: string[], managed: Set<string>): number {
  let n = 0;
  for (const repo of seen) if (managed.has(repo)) n++;
  return n;
}

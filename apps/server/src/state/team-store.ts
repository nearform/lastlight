import { and, asc, eq, max, sql } from "drizzle-orm";
import {
  nullsToUndefined,
  tablesOf,
  type OpSerializer,
  type StateClient,
  type StateTables,
} from "./client.js";

/**
 * Outcome of the last visibility resolution for one login.
 *
 * - `ok`        — the login belongs to at least one team with a managed-repo grant.
 * - `empty`     — resolved cleanly, but no team grants access to a managed repo.
 * - `truncated` — a team's grant was too large to enumerate inside the budget.
 * - `error`     — GitHub said no (permission, rate limit, network).
 * - `disabled`  — the feature is off, or there is no App client to ask.
 *
 * Only `ok` produces a filter. Every other status fails OPEN (see the module
 * header of `engine/github/team-visibility.ts`), but they are distinguished
 * because they are remembered for the TTL and shown on the admin surface.
 */
export type VisibilitySyncStatus = "ok" | "empty" | "truncated" | "error" | "disabled";

export interface VisibilitySync {
  login: string;
  syncedAt: string;
  status: VisibilitySyncStatus;
  detail?: string;
}

/** One team's resolved grant — already intersected with the managed-repo set. */
export interface ResolvedTeam {
  org: string;
  slug: string;
  name?: string | null;
  /** Managed repos the team can reach. May be a PREFIX when `truncated`. */
  repos: string[];
  /** True when enumeration stopped at the page budget, so `repos` is partial. */
  truncated: boolean;
}

/** What the cache can say about a login right now. */
export interface CachedVisibility {
  repos: string[];
  /** Any of the login's teams was truncated ⇒ the caller must fail open. */
  truncated: boolean;
  /** Teams the login is known to belong to, for the admin/debug surface. */
  teams: Array<{ org: string; slug: string }>;
}

/**
 * Owns the four `github_team*` / `github_visibility_sync` tables — the cache
 * behind per-repo dashboard visibility (issue #169).
 *
 * **This is a cache, not a mirror.** Rows exist only for teams a user who
 * actually logged in belongs to, written by the on-demand resolver. That is
 * deliberate: an org with thousands of repos and hundreds of teams would make a
 * full crawl cost thousands of API requests, and almost all of it would describe
 * teams nobody using the dashboard is in. The consequence every read path must
 * respect is that **absence means "unknown", never "no access"** — so a miss
 * fails open rather than hiding repos.
 *
 * Mirrors the other per-table stores ({@link ExecutionStore} /
 * {@link UserStore}): constructed from the single shared Drizzle client, every
 * multi-row write wrapped in one transaction. Those four transactions run
 * through the **connection-scoped** `serialize` mutex, the same instance
 * {@link WorkflowRunStore} uses — a store-scoped chain would leave a team
 * resolution free to overlap a run transaction on this one libsql client, which
 * is exactly the interleaving libsql handles badly.
 */
export class TeamStore {
  private serialize: OpSerializer;

  /**
   * Table objects for THIS client's dialect. Every method destructures what it
   * needs off this instead of importing from `schema/sqlite.js` — see
   * `client.ts` → {@link tablesOf} for why the cast alone cannot do it.
   */
  private readonly t: StateTables;

  constructor(
    private client: StateClient,
    deps: { serialize: OpSerializer },
  ) {
    this.serialize = deps.serialize;
    this.t = tablesOf(client);
  }

  /**
   * Replace everything known about ONE login in a single transaction: the teams
   * it belongs to, each of those teams' managed-repo grant, and the freshness
   * row. Atomic because a half-applied membership set would silently narrow
   * what somebody can see.
   *
   * Only touches membership rows for `login` — other logins' rows in the same
   * teams are left alone, since this pass learned nothing about them.
   */
  async recordResolution(input: {
    login: string;
    teams: ResolvedTeam[];
    status: VisibilitySyncStatus;
    detail?: string;
    at?: string;
  }): Promise<void> {
    const { githubTeamMembers, githubTeamRepos, githubTeams, githubVisibilitySync } = this.t;
    const now = input.at ?? new Date().toISOString();
    await this.serialize(() =>
      this.client.transaction(async (tx) => {
        await tx.delete(githubTeamMembers).where(eq(githubTeamMembers.login, input.login));
        for (const team of input.teams) {
          await tx
            .insert(githubTeams)
            .values({
              org: team.org,
              slug: team.slug,
              name: team.name ?? null,
              reposSyncedAt: now,
              truncated: team.truncated,
            })
            .onConflictDoUpdate({
              target: [githubTeams.org, githubTeams.slug],
              set: { name: team.name ?? null, reposSyncedAt: now, truncated: team.truncated },
            });
          await tx
            .delete(githubTeamRepos)
            .where(
              and(eq(githubTeamRepos.org, team.org), eq(githubTeamRepos.teamSlug, team.slug)),
            );
          // `repo` here is the QUALIFIED owner/repo full name — unlike every
          // other repo column in the schema — so it is stored exactly as the
          // resolver produced it, with no bare-repo normalization.
          for (const repo of team.repos) {
            await tx
              .insert(githubTeamRepos)
              .values({ org: team.org, teamSlug: team.slug, repo })
              .onConflictDoNothing();
          }
          await tx
            .insert(githubTeamMembers)
            .values({ org: team.org, teamSlug: team.slug, login: input.login })
            .onConflictDoNothing();
        }
        await tx
          .insert(githubVisibilitySync)
          .values({
            login: input.login,
            syncedAt: now,
            status: input.status,
            detail: input.detail ?? null,
          })
          .onConflictDoUpdate({
            target: githubVisibilitySync.login,
            set: { syncedAt: now, status: input.status, detail: input.detail ?? null },
          });
      }),
    );
  }

  /** The freshness/outcome row for a login, or null if never resolved. */
  async getSync(login: string): Promise<VisibilitySync | null> {
    const { githubVisibilitySync } = this.t;
    const [row] = await this.client
      .select()
      .from(githubVisibilitySync)
      .where(eq(githubVisibilitySync.login, login))
      .limit(1);
    if (!row) return null;
    const r = nullsToUndefined(row);
    return {
      ...r,
      status: r.status as VisibilitySyncStatus,
      // `nullsToUndefined` strips it at runtime; the cast keeps the declared
      // optional honest, since its signature can't narrow `string | null`.
      detail: r.detail ?? undefined,
    };
  }

  /**
   * Whether a login's cached answer is still inside `ttlMs`. A missing row is
   * never fresh; a `synced_at` we can't parse is treated as stale rather than
   * trusted forever.
   */
  async isFresh(login: string, ttlMs: number, now = Date.now()): Promise<boolean> {
    const sync = await this.getSync(login);
    if (!sync) return false;
    const at = Date.parse(sync.syncedAt);
    if (Number.isNaN(at)) return false;
    return now - at < ttlMs;
  }

  /**
   * Everything the cache knows about a login, joined membership → team_repos.
   * The caller intersects with the live managed-repo list; this returns what was
   * stored, which was already intersected at write time (a repo unmanaged since
   * then must not reappear just because a team still grants it).
   */
  async reposForLogin(login: string): Promise<CachedVisibility> {
    const { githubTeamMembers, githubTeamRepos, githubTeams } = this.t;
    const rows = await this.client
      .selectDistinct({ repo: githubTeamRepos.repo })
      .from(githubTeamMembers)
      .innerJoin(
        githubTeamRepos,
        and(
          eq(githubTeamRepos.org, githubTeamMembers.org),
          eq(githubTeamRepos.teamSlug, githubTeamMembers.teamSlug),
        ),
      )
      .where(eq(githubTeamMembers.login, login))
      .orderBy(asc(githubTeamRepos.repo));
    const teams = await this.client
      .select({
        org: githubTeamMembers.org,
        slug: githubTeamMembers.teamSlug,
        // The COALESCE is load-bearing, not defensive: `truncated` is NOT NULL,
        // so the only NULL here comes from the LEFT JOIN missing its team row —
        // a membership we learned about before (or without) the team itself.
        // Bound `false`, never a literal 0: Postgres rejects `boolean = integer`.
        truncated: sql`coalesce(${githubTeams.truncated}, ${false})`.mapWith(Boolean),
      })
      .from(githubTeamMembers)
      .leftJoin(
        githubTeams,
        and(
          eq(githubTeams.org, githubTeamMembers.org),
          eq(githubTeams.slug, githubTeamMembers.teamSlug),
        ),
      )
      .where(eq(githubTeamMembers.login, login))
      .orderBy(asc(githubTeamMembers.org), asc(githubTeamMembers.teamSlug));
    return {
      repos: rows.map((r) => r.repo),
      truncated: teams.some((t) => t.truncated === true),
      teams: teams.map((t) => ({ org: t.org, slug: t.slug })),
    };
  }

  /** Forget one login's answer — it will be re-resolved on the next request. */
  async invalidateLogin(login: string): Promise<void> {
    const { githubTeamMembers, githubVisibilitySync } = this.t;
    await this.serialize(() =>
      this.client.transaction(async (tx) => {
        await tx.delete(githubTeamMembers).where(eq(githubTeamMembers.login, login));
        await tx.delete(githubVisibilitySync).where(eq(githubVisibilitySync.login, login));
      }),
    );
  }

  /**
   * Forget one team — its grant AND every member's cached answer, because their
   * visible-repo set was derived from it. Called from the `team` webhook, where
   * the payload names the team but not who is affected.
   *
   * Returns the logins whose answers were dropped, so the caller can log the
   * blast radius of an org-side change.
   */
  async invalidateTeam(org: string, slug: string): Promise<string[]> {
    const { githubTeamMembers, githubTeamRepos, githubTeams, githubVisibilitySync } = this.t;
    // Deliberately OUTSIDE the transaction, as it always has been.
    const members = await this.client
      .select({ login: githubTeamMembers.login })
      .from(githubTeamMembers)
      .where(and(eq(githubTeamMembers.org, org), eq(githubTeamMembers.teamSlug, slug)));
    const logins = members.map((m) => m.login);
    await this.serialize(() =>
      this.client.transaction(async (tx) => {
        await tx
          .delete(githubTeamRepos)
          .where(and(eq(githubTeamRepos.org, org), eq(githubTeamRepos.teamSlug, slug)));
        await tx
          .delete(githubTeams)
          .where(and(eq(githubTeams.org, org), eq(githubTeams.slug, slug)));
        // Drop each affected member ENTIRELY, not just their row in this team.
        // Leaving their other memberships behind would keep a partial repo set in
        // the cache — and a partial set is the one answer this feature must never
        // produce. They re-resolve on their next request regardless, since their
        // freshness row goes with them, so this costs nothing extra.
        for (const login of logins) {
          await tx.delete(githubTeamMembers).where(eq(githubTeamMembers.login, login));
          await tx.delete(githubVisibilitySync).where(eq(githubVisibilitySync.login, login));
        }
      }),
    );
    return logins;
  }

  /** Drop the whole cache (admin re-sync, or an `organization` event we can't scope). */
  async invalidateAll(): Promise<void> {
    const { githubTeamMembers, githubTeamRepos, githubTeams, githubVisibilitySync } = this.t;
    await this.serialize(() =>
      this.client.transaction(async (tx) => {
        await tx.delete(githubTeamRepos);
        await tx.delete(githubTeamMembers);
        await tx.delete(githubTeams);
        await tx.delete(githubVisibilitySync);
      }),
    );
  }

  /** Most recent successful resolution across all logins — powers the coarse `synced` flag. */
  async lastSyncedAt(): Promise<string | null> {
    const { githubVisibilitySync } = this.t;
    const [row] = await this.client
      .select({ at: max(githubVisibilitySync.syncedAt) })
      .from(githubVisibilitySync);
    return row?.at ?? null;
  }
}

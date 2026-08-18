import type Database from "better-sqlite3";

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
 * {@link UserStore}): constructed from the single shared `Database`, every
 * multi-row write wrapped in one transaction.
 */
export class TeamStore {
  constructor(private db: Database.Database) {}

  /**
   * Replace everything known about ONE login in a single transaction: the teams
   * it belongs to, each of those teams' managed-repo grant, and the freshness
   * row. Atomic because a half-applied membership set would silently narrow
   * what somebody can see.
   *
   * Only touches membership rows for `login` — other logins' rows in the same
   * teams are left alone, since this pass learned nothing about them.
   */
  recordResolution(input: {
    login: string;
    teams: ResolvedTeam[];
    status: VisibilitySyncStatus;
    detail?: string;
    at?: string;
  }): void {
    const now = input.at ?? new Date().toISOString();
    const apply = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM github_team_members WHERE login = ?`).run(input.login);
      for (const team of input.teams) {
        this.db
          .prepare(
            `INSERT INTO github_teams (org, slug, name, repos_synced_at, truncated)
             VALUES (?, ?, ?, ?, ?)
             ON CONFLICT(org, slug) DO UPDATE SET
               name = excluded.name,
               repos_synced_at = excluded.repos_synced_at,
               truncated = excluded.truncated`,
          )
          .run(team.org, team.slug, team.name ?? null, now, team.truncated ? 1 : 0);
        this.db
          .prepare(`DELETE FROM github_team_repos WHERE org = ? AND team_slug = ?`)
          .run(team.org, team.slug);
        const insertRepo = this.db.prepare(
          `INSERT OR IGNORE INTO github_team_repos (org, team_slug, repo) VALUES (?, ?, ?)`,
        );
        for (const repo of team.repos) insertRepo.run(team.org, team.slug, repo);
        this.db
          .prepare(
            `INSERT OR IGNORE INTO github_team_members (org, team_slug, login) VALUES (?, ?, ?)`,
          )
          .run(team.org, team.slug, input.login);
      }
      this.db
        .prepare(
          `INSERT INTO github_visibility_sync (login, synced_at, status, detail)
           VALUES (?, ?, ?, ?)
           ON CONFLICT(login) DO UPDATE SET
             synced_at = excluded.synced_at,
             status = excluded.status,
             detail = excluded.detail`,
        )
        .run(input.login, now, input.status, input.detail ?? null);
    });
    apply();
  }

  /** The freshness/outcome row for a login, or null if never resolved. */
  getSync(login: string): VisibilitySync | null {
    const row = this.db
      .prepare(`SELECT login, synced_at, status, detail FROM github_visibility_sync WHERE login = ?`)
      .get(login) as Record<string, unknown> | undefined;
    if (!row) return null;
    return {
      login: row.login as string,
      syncedAt: row.synced_at as string,
      status: row.status as VisibilitySyncStatus,
      detail: (row.detail as string | null) ?? undefined,
    };
  }

  /**
   * Whether a login's cached answer is still inside `ttlMs`. A missing row is
   * never fresh; a `synced_at` we can't parse is treated as stale rather than
   * trusted forever.
   */
  isFresh(login: string, ttlMs: number, now = Date.now()): boolean {
    const sync = this.getSync(login);
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
  reposForLogin(login: string): CachedVisibility {
    const rows = this.db
      .prepare(
        `SELECT DISTINCT tr.repo AS repo
           FROM github_team_members m
           JOIN github_team_repos tr
             ON tr.org = m.org AND tr.team_slug = m.team_slug
          WHERE m.login = ?
          ORDER BY tr.repo`,
      )
      .all(login) as Array<{ repo: string }>;
    const teams = this.db
      .prepare(
        `SELECT m.org AS org, m.team_slug AS slug, COALESCE(t.truncated, 0) AS truncated
           FROM github_team_members m
           LEFT JOIN github_teams t ON t.org = m.org AND t.slug = m.team_slug
          WHERE m.login = ?
          ORDER BY m.org, m.team_slug`,
      )
      .all(login) as Array<{ org: string; slug: string; truncated: number }>;
    return {
      repos: rows.map((r) => r.repo),
      truncated: teams.some((t) => t.truncated === 1),
      teams: teams.map((t) => ({ org: t.org, slug: t.slug })),
    };
  }

  /** Forget one login's answer — it will be re-resolved on the next request. */
  invalidateLogin(login: string): void {
    const apply = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM github_team_members WHERE login = ?`).run(login);
      this.db.prepare(`DELETE FROM github_visibility_sync WHERE login = ?`).run(login);
    });
    apply();
  }

  /**
   * Forget one team — its grant AND every member's cached answer, because their
   * visible-repo set was derived from it. Called from the `team` webhook, where
   * the payload names the team but not who is affected.
   *
   * Returns the logins whose answers were dropped, so the caller can log the
   * blast radius of an org-side change.
   */
  invalidateTeam(org: string, slug: string): string[] {
    const members = this.db
      .prepare(`SELECT login FROM github_team_members WHERE org = ? AND team_slug = ?`)
      .all(org, slug) as Array<{ login: string }>;
    const logins = members.map((m) => m.login);
    const apply = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM github_team_repos WHERE org = ? AND team_slug = ?`).run(org, slug);
      this.db.prepare(`DELETE FROM github_teams WHERE org = ? AND slug = ?`).run(org, slug);
      // Drop each affected member ENTIRELY, not just their row in this team.
      // Leaving their other memberships behind would keep a partial repo set in
      // the cache — and a partial set is the one answer this feature must never
      // produce. They re-resolve on their next request regardless, since their
      // freshness row goes with them, so this costs nothing extra.
      const forgetMembership = this.db.prepare(`DELETE FROM github_team_members WHERE login = ?`);
      const forgetSync = this.db.prepare(`DELETE FROM github_visibility_sync WHERE login = ?`);
      for (const login of logins) {
        forgetMembership.run(login);
        forgetSync.run(login);
      }
    });
    apply();
    return logins;
  }

  /** Drop the whole cache (admin re-sync, or an `organization` event we can't scope). */
  invalidateAll(): void {
    const apply = this.db.transaction(() => {
      this.db.exec(`DELETE FROM github_team_repos`);
      this.db.exec(`DELETE FROM github_team_members`);
      this.db.exec(`DELETE FROM github_teams`);
      this.db.exec(`DELETE FROM github_visibility_sync`);
    });
    apply();
  }

  /** Most recent successful resolution across all logins — powers the coarse `synced` flag. */
  lastSyncedAt(): string | null {
    const row = this.db
      .prepare(`SELECT MAX(synced_at) AS at FROM github_visibility_sync`)
      .get() as { at: string | null } | undefined;
    return row?.at ?? null;
  }
}

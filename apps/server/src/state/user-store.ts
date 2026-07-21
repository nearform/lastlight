import type Database from "better-sqlite3";
import { randomUUID } from "crypto";

/**
 * Who acted on / triggered a workflow, coarsely. Persisted in the
 * `trigger_actor_type` column on both `executions` and `workflow_runs`
 * (issue #205) alongside the free-text `triggered_by` login/handle.
 */
export type TriggerActorType = "github" | "slack" | "cli" | "cron" | "admin" | "system";

/**
 * A first-class user identity (issue #205). Captures a GitHub identity
 * (stable numeric id + login + name + email + avatar) and a lazily-linked
 * Slack user id, so the dashboard can show a real person and a future sender
 * can email them. This is an ADDITIVE enrichment table — every actor column
 * elsewhere stays free-text `login`, and this row is resolved by LEFT-JOIN on
 * `login`. `email` is the future email hook; nothing sends yet.
 */
export interface User {
  id: string;
  /** Stable GitHub numeric id — the upsert key for GitHub logins. Null for Slack-only rows. */
  githubId?: number;
  /** GitHub login — the soft join key every actor column already stores. */
  login?: string;
  name?: string;
  /** Captured for future outbound email; nothing sends yet. Indexed, NOT unique. */
  email?: string;
  avatarUrl?: string;
  /** Slack `U…` id, linked lazily when a Slack user's email matches this row. */
  slackUserId?: string;
  isBlocked: boolean;
  /** True when `email` is a synthetic placeholder a future sender should skip. */
  emailIsPlaceholder: boolean;
  createdAt: string;
  updatedAt: string;
  lastLoginAt?: string;
}

/**
 * Owns every read/write against the `users` table. Mirrors the other per-table
 * stores ({@link ExecutionStore} / {@link ApprovalStore}): constructed from the
 * single shared `Database`, all reads flow through one `deserialize` helper.
 *
 * Upserts key on the stable ids (`github_id` for GitHub logins, `slack_user_id`
 * for Slack) — never on `email`, which is non-unique. The GitHub `login` stays
 * the soft join key used everywhere else in the schema.
 */
export class UserStore {
  constructor(private db: Database.Database) {}

  /**
   * Upsert a GitHub-authenticated user on their stable numeric id. On conflict,
   * refreshes the mutable identity fields (login/name/email/avatar) and bumps
   * `last_login_at` + `updated_at`. Called on every dashboard GitHub login so a
   * renamed login or new avatar is picked up. Returns the stored row.
   *
   * `email` is captured here as the future outbound-email hook (issue #205);
   * no sender exists yet.
   */
  getOrCreateUserByGithub(input: {
    githubId: number;
    login: string;
    name?: string | null;
    email?: string | null;
    avatarUrl?: string | null;
  }): User {
    const now = new Date().toISOString();
    const existing = this.findByGithubId(input.githubId);
    if (existing) {
      this.db
        .prepare(
          `UPDATE users
             SET login = ?, name = ?, email = ?, avatar_url = ?,
                 updated_at = ?, last_login_at = ?
           WHERE github_id = ?`,
        )
        .run(
          input.login,
          input.name ?? existing.name ?? null,
          input.email ?? existing.email ?? null,
          input.avatarUrl ?? existing.avatarUrl ?? null,
          now,
          now,
          input.githubId,
        );
      return this.findByGithubId(input.githubId)!;
    }
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO users
           (id, github_id, login, name, email, avatar_url, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        input.githubId,
        input.login,
        input.name ?? null,
        input.email ?? null,
        input.avatarUrl ?? null,
        now,
        now,
        now,
      );
    return this.getById(id)!;
  }

  /**
   * Upsert a Slack-authenticated user. Matches by email to an existing row
   * (typically a GitHub login who signed in with the same corporate address)
   * and links `slack_user_id` onto it; otherwise creates a Slack-only row
   * (no `login`, no `github_id`). Returns the stored row so the caller can
   * carry its `login` (if any) into the session token.
   */
  upsertSlackUser(input: {
    slackUserId: string;
    name?: string | null;
    email?: string | null;
  }): User {
    const now = new Date().toISOString();
    // Fast path: already linked.
    const linked = this.findBySlackUserId(input.slackUserId);
    if (linked) {
      this.db
        .prepare(
          `UPDATE users
             SET name = COALESCE(?, name), email = COALESCE(?, email),
                 updated_at = ?, last_login_at = ?
           WHERE slack_user_id = ?`,
        )
        .run(input.name ?? null, input.email ?? null, now, now, input.slackUserId);
      return this.findBySlackUserId(input.slackUserId)!;
    }
    // Match an existing (GitHub) row by email and link Slack onto it.
    const byEmail = input.email ? this.findByEmail(input.email) : null;
    if (byEmail) {
      this.linkSlackUser(byEmail.id, input.slackUserId);
      this.db
        .prepare(
          `UPDATE users SET name = COALESCE(name, ?), updated_at = ?, last_login_at = ? WHERE id = ?`,
        )
        .run(input.name ?? null, now, now, byEmail.id);
      return this.getById(byEmail.id)!;
    }
    // No match — create a Slack-only row.
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO users
           (id, slack_user_id, name, email, created_at, updated_at, last_login_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(id, input.slackUserId, input.name ?? null, input.email ?? null, now, now, now);
    return this.getById(id)!;
  }

  /** Link a Slack user id onto an existing row (e.g. a GitHub login matched by email). */
  linkSlackUser(userId: string, slackUserId: string): void {
    const now = new Date().toISOString();
    this.db
      .prepare(`UPDATE users SET slack_user_id = ?, updated_at = ? WHERE id = ?`)
      .run(slackUserId, now, userId);
  }

  getById(id: string): User | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE id = ?`).get(id) as
      | Record<string, unknown>
      | undefined;
    return row ? this.deserialize(row) : null;
  }

  findByGithubId(githubId: number): User | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE github_id = ?`).get(githubId) as
      | Record<string, unknown>
      | undefined;
    return row ? this.deserialize(row) : null;
  }

  /** Look up by the GitHub login — the soft join key used across the schema. */
  findByLogin(login: string): User | null {
    const row = this.db.prepare(`SELECT * FROM users WHERE login = ?`).get(login) as
      | Record<string, unknown>
      | undefined;
    return row ? this.deserialize(row) : null;
  }

  /**
   * First row matching `email`. `email` is non-unique (shared mailboxes), so
   * this returns the earliest-created match deterministically. Used to link a
   * Slack login to an existing GitHub identity by email.
   */
  findByEmail(email: string): User | null {
    const row = this.db
      .prepare(`SELECT * FROM users WHERE email = ? ORDER BY created_at ASC LIMIT 1`)
      .get(email) as Record<string, unknown> | undefined;
    return row ? this.deserialize(row) : null;
  }

  findBySlackUserId(slackUserId: string): User | null {
    const row = this.db
      .prepare(`SELECT * FROM users WHERE slack_user_id = ?`)
      .get(slackUserId) as Record<string, unknown> | undefined;
    return row ? this.deserialize(row) : null;
  }

  private deserialize(row: Record<string, unknown>): User {
    return {
      id: row.id as string,
      githubId: (row.github_id as number | null) ?? undefined,
      login: (row.login as string | null) ?? undefined,
      name: (row.name as string | null) ?? undefined,
      email: (row.email as string | null) ?? undefined,
      avatarUrl: (row.avatar_url as string | null) ?? undefined,
      slackUserId: (row.slack_user_id as string | null) ?? undefined,
      isBlocked: (row.is_blocked as number) === 1,
      emailIsPlaceholder: (row.email_is_placeholder as number) === 1,
      createdAt: row.created_at as string,
      updatedAt: row.updated_at as string,
      lastLoginAt: (row.last_login_at as string | null) ?? undefined,
    };
  }
}

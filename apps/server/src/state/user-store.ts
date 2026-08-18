import { randomUUID } from "crypto";
import { asc, eq, sql } from "drizzle-orm";
import { nullsToUndefined, tablesOf, type StateClient, type StateTables } from "./client.js";
import { isUniqueViolation } from "./dialect.js";

/**
 * Who acted on / triggered a workflow, coarsely. Persisted in the
 * `trigger_actor_type` column on both `executions` and `workflow_runs`
 * (issue #205) alongside the free-text `triggered_by` login/handle.
 */
export type TriggerActorType = "github" | "slack" | "cli" | "cron" | "admin" | "system";

/** The runtime membership set for {@link TriggerActorType} (guards untrusted input). */
export const TRIGGER_ACTOR_TYPES = ["github", "slack", "cli", "cron", "admin", "system"] as const;

/**
 * Narrow an arbitrary value to a {@link TriggerActorType}. The dispatch context
 * is a `Record<string, unknown>` that a cron definition or external API caller
 * can spread arbitrary keys into, so a bare `as` cast would persist an
 * unrecognised `trigger_actor_type`. Callers use this to fall through to their
 * derived default instead.
 */
export function isTriggerActorType(value: unknown): value is TriggerActorType {
  return typeof value === "string" && (TRIGGER_ACTOR_TYPES as readonly string[]).includes(value);
}

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

/** The row shape the builder returns for this table, before normalization. */
type UserRow = StateTables["users"]["$inferSelect"];

/**
 * Owns every read/write against the `users` table. Mirrors the other per-table
 * stores ({@link ExecutionStore} / {@link ApprovalStore}): constructed from the
 * single shared client, all reads flow through one `deserialize` helper.
 *
 * Upserts key on the stable ids (`github_id` for GitHub logins, `slack_user_id`
 * for Slack) — never on `email`, which is non-unique. The GitHub `login` stays
 * the soft join key used everywhere else in the schema.
 *
 * Pure single-table CRUD: it opens no transaction and takes no `dbc`, so every
 * method runs against the root client.
 */
export class UserStore {
  /**
   * Table objects for THIS client's dialect. Every method destructures what it
   * needs off this instead of importing from `schema/sqlite.js` — see
   * `client.ts` → {@link tablesOf} for why the cast alone cannot do it.
   */
  private readonly t: StateTables;

  constructor(private client: StateClient) {
    this.t = tablesOf(client);
  }

  /**
   * Upsert a GitHub-authenticated user on their stable numeric id. On conflict,
   * refreshes the mutable identity fields (login/name/email/avatar) and bumps
   * `last_login_at` + `updated_at`. Called on every dashboard GitHub login so a
   * renamed login or new avatar is picked up. Returns the stored row.
   *
   * `email` is captured here as the future outbound-email hook (issue #205);
   * no sender exists yet.
   *
   * Lookup-then-insert is no longer atomic-by-physics, so a losing racer's
   * insert trips the `github_id` UNIQUE: catch it, re-read, and hand back the
   * winner. Only a same-`github_id` winner counts — a violation on `login`
   * (some other identity already owns that handle) is a genuine conflict and
   * still throws, exactly as it did before.
   */
  async getOrCreateUserByGithub(input: {
    githubId: number;
    login: string;
    name?: string | null;
    email?: string | null;
    avatarUrl?: string | null;
  }): Promise<User> {
    const { users } = this.t;
    const now = new Date().toISOString();
    const existing = await this.findByGithubId(input.githubId);
    if (existing) {
      await this.client
        .update(users)
        .set({
          login: input.login,
          name: input.name ?? existing.name ?? null,
          email: input.email ?? existing.email ?? null,
          avatarUrl: input.avatarUrl ?? existing.avatarUrl ?? null,
          updatedAt: now,
          lastLoginAt: now,
        })
        .where(eq(users.githubId, input.githubId));
      return (await this.findByGithubId(input.githubId))!;
    }
    const id = randomUUID();
    try {
      // `is_blocked` / `email_is_placeholder` are deliberately absent — the DDL
      // defaults are their only writer.
      await this.client.insert(users).values({
        id,
        githubId: input.githubId,
        login: input.login,
        name: input.name ?? null,
        email: input.email ?? null,
        avatarUrl: input.avatarUrl ?? null,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const winner = await this.findByGithubId(input.githubId);
      if (winner) return winner;
      throw err;
    }
    return (await this.getById(id))!;
  }

  /**
   * Upsert a Slack-authenticated user. Matches by email to an existing row
   * (typically a GitHub login who signed in with the same corporate address)
   * and links `slack_user_id` onto it; otherwise creates a Slack-only row
   * (no `login`, no `github_id`). Returns the stored row so the caller can
   * carry its `login` (if any) into the session token.
   *
   * As in {@link getOrCreateUserByGithub}, the final insert is guarded: a
   * concurrent Slack login trips the `slack_user_id` UNIQUE and we return the
   * row that won instead.
   */
  async upsertSlackUser(input: {
    slackUserId: string;
    name?: string | null;
    email?: string | null;
  }): Promise<User> {
    const { users } = this.t;
    const now = new Date().toISOString();
    // Fast path: already linked. Incoming values win when present, which is
    // what the old `COALESCE(?, name)` spelled.
    const linked = await this.findBySlackUserId(input.slackUserId);
    if (linked) {
      await this.client
        .update(users)
        .set({
          name: input.name ?? linked.name ?? null,
          email: input.email ?? linked.email ?? null,
          updatedAt: now,
          lastLoginAt: now,
        })
        .where(eq(users.slackUserId, input.slackUserId));
      return (await this.findBySlackUserId(input.slackUserId))!;
    }
    // Match an existing (GitHub) row by email and link Slack onto it.
    const byEmail = input.email ? await this.findByEmail(input.email) : null;
    if (byEmail) {
      await this.linkSlackUser(byEmail.id, input.slackUserId);
      await this.client
        .update(users)
        .set({
          // NOTE the argument order: `COALESCE(name, ?)`, not `COALESCE(?, name)`.
          // Unlike the fast path above, here the EXISTING name wins and the Slack
          // display name only fills a hole — a GitHub identity must not be renamed
          // by whatever the person happens to call themselves in Slack. Kept as an
          // explicit `sql` expression because expressing it as a conditional
          // `set` key is exactly how the meaning gets inverted.
          name: sql`COALESCE(${users.name}, ${input.name ?? null})`,
          updatedAt: now,
          lastLoginAt: now,
        })
        .where(eq(users.id, byEmail.id));
      return (await this.getById(byEmail.id))!;
    }
    // No match — create a Slack-only row.
    const id = randomUUID();
    try {
      await this.client.insert(users).values({
        id,
        slackUserId: input.slackUserId,
        name: input.name ?? null,
        email: input.email ?? null,
        createdAt: now,
        updatedAt: now,
        lastLoginAt: now,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const winner = await this.findBySlackUserId(input.slackUserId);
      if (winner) return winner;
      throw err;
    }
    return (await this.getById(id))!;
  }

  /** Link a Slack user id onto an existing row (e.g. a GitHub login matched by email). */
  async linkSlackUser(userId: string, slackUserId: string): Promise<void> {
    const { users } = this.t;
    const now = new Date().toISOString();
    await this.client
      .update(users)
      .set({ slackUserId, updatedAt: now })
      .where(eq(users.id, userId));
  }

  async getById(id: string): Promise<User | null> {
    const { users } = this.t;
    const [row] = await this.client.select().from(users).where(eq(users.id, id)).limit(1);
    return row ? deserialize(row) : null;
  }

  async findByGithubId(githubId: number): Promise<User | null> {
    const { users } = this.t;
    const [row] = await this.client
      .select()
      .from(users)
      .where(eq(users.githubId, githubId))
      .limit(1);
    return row ? deserialize(row) : null;
  }

  /** Look up by the GitHub login — the soft join key used across the schema. */
  async findByLogin(login: string): Promise<User | null> {
    const { users } = this.t;
    const [row] = await this.client.select().from(users).where(eq(users.login, login)).limit(1);
    return row ? deserialize(row) : null;
  }

  /**
   * First row matching `email`. `email` is non-unique (shared mailboxes), so
   * this returns the earliest-created match deterministically. Used to link a
   * Slack login to an existing GitHub identity by email.
   */
  async findByEmail(email: string): Promise<User | null> {
    const { users } = this.t;
    const [row] = await this.client
      .select()
      .from(users)
      .where(eq(users.email, email))
      .orderBy(asc(users.createdAt))
      .limit(1);
    return row ? deserialize(row) : null;
  }

  async findBySlackUserId(slackUserId: string): Promise<User | null> {
    const { users } = this.t;
    const [row] = await this.client
      .select()
      .from(users)
      .where(eq(users.slackUserId, slackUserId))
      .limit(1);
    return row ? deserialize(row) : null;
  }
}

/**
 * Builder rows are already camelCase, and `is_blocked` / `email_is_placeholder`
 * are `{ mode: "boolean" }` columns, so they arrive as real booleans — there is
 * nothing left to convert. The remaining job is turning the nullable columns
 * into absent optionals.
 */
function deserialize(row: UserRow): User {
  const r = nullsToUndefined(row);
  return {
    id: r.id,
    githubId: r.githubId ?? undefined,
    login: r.login ?? undefined,
    name: r.name ?? undefined,
    email: r.email ?? undefined,
    avatarUrl: r.avatarUrl ?? undefined,
    slackUserId: r.slackUserId ?? undefined,
    isBlocked: r.isBlocked,
    emailIsPlaceholder: r.emailIsPlaceholder,
    createdAt: r.createdAt,
    updatedAt: r.updatedAt,
    lastLoginAt: r.lastLoginAt ?? undefined,
  };
}

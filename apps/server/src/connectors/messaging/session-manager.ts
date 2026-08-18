import { randomUUID } from "crypto";
import { and, desc, eq, gte, inArray, isNull, lt, sql } from "drizzle-orm";
import type { ConversationKey, ConversationSession, ConversationMessage } from "./types.js";
import type { Dialect, StateClient } from "../../state/client.js";
import { changes, isUniqueViolation } from "../../state/dialect.js";
import { messagingMessages, messagingSessions } from "../../state/schema/sqlite.js";
import { logger } from "../../logging/logger.js";

const log = logger("messaging");

/** Inactivity timeout before a session is considered stale (30 minutes) */
const SESSION_TIMEOUT_MS = 30 * 60 * 1000;

/** The row shape the builder returns for `messaging_sessions`. */
type SessionRow = typeof messagingSessions.$inferSelect;

/**
 * Session manager for messaging conversations, over the shared state client.
 * Shared across all messaging platform connectors.
 *
 * Owns no DDL: both tables, their indexes and the partial unique index
 * (`WHERE active = 1` — "one active session per key") are declared in
 * `state/schema/sqlite.ts` and created by the migrations.
 */
export class SessionManager {
  constructor(private client: StateClient, private dialect: Dialect = "sqlite") {}

  /** Look up an existing session by id (used to read its agent_session_id). */
  async getSession(id: string): Promise<ConversationSession | null> {
    const [row] = await this.client
      .select()
      .from(messagingSessions)
      .where(eq(messagingSessions.id, id))
      .limit(1);
    return row ? this.rowToSession(row) : null;
  }

  /** Get an existing active session or create a new one */
  async getOrCreateSession(key: ConversationKey): Promise<ConversationSession> {
    const now = new Date().toISOString();
    const cutoff = new Date(Date.now() - SESSION_TIMEOUT_MS).toISOString();

    // The identity predicate for a session. `thread_id IS ?` in the old SQL:
    // SQLite's `IS` matches NULL to NULL, `=` never does — so a threadless
    // (DM) session must be matched with IS NULL or every message silently
    // forks a fresh session instead of continuing the existing one. Computed
    // once and used by both the lookup and the deactivate below.
    const threadMatches =
      key.threadId == null
        ? isNull(messagingSessions.threadId)
        : eq(messagingSessions.threadId, key.threadId);

    const keyMatches = and(
      eq(messagingSessions.platform, key.platform),
      eq(messagingSessions.channelId, key.channelId),
      threadMatches,
      eq(messagingSessions.userId, key.userId),
    );

    // Look for an active, non-stale session
    const findActive = async (): Promise<ConversationSession | null> => {
      const [row] = await this.client
        .select()
        .from(messagingSessions)
        .where(
          and(
            keyMatches,
            eq(messagingSessions.active, true),
            gte(messagingSessions.lastActivityAt, cutoff),
          ),
        )
        .limit(1);
      return row ? this.rowToSession(row) : null;
    };

    const existing = await findActive();
    if (existing) return existing;

    // Deactivate any stale sessions for this key
    await this.client
      .update(messagingSessions)
      .set({ active: false })
      .where(and(keyMatches, eq(messagingSessions.active, true)));

    // Create new session.
    //
    // Lookup-then-insert used to be atomic by physics — the whole method ran
    // inside one synchronous driver call, so nothing could interleave. It no
    // longer is: two messages arriving together on the same key can both miss
    // the lookup and both try to insert. The partial unique index
    // (`WHERE active = 1`) is what makes the loser fail rather than fork a
    // second live session, so the loser re-reads and adopts the winner.
    const id = randomUUID();
    try {
      await this.client.insert(messagingSessions).values({
        id,
        platform: key.platform,
        channelId: key.channelId,
        threadId: key.threadId,
        userId: key.userId,
        createdAt: now,
        lastActivityAt: now,
      });
    } catch (err) {
      if (!isUniqueViolation(err)) throw err;
      const winner = await findActive();
      // No winner means the violation came from something other than the
      // concurrent-create race we can recover from — surface it.
      if (!winner) throw err;
      log.debug("Lost the race to create a messaging session; adopting the winner", {
        platform: key.platform,
        channelId: key.channelId,
        sessionId: winner.id,
      });
      return winner;
    }

    return {
      id,
      platform: key.platform,
      channelId: key.channelId,
      threadId: key.threadId,
      userId: key.userId,
      agentSessionId: null,
      createdAt: now,
      lastActivityAt: now,
      messageCount: 0,
      active: true,
    };
  }

  /**
   * Persist the Agent SDK session id captured from the first chat reply in
   * a thread. Subsequent replies in the same thread pass this id back to
   * the SDK as `resume`, so the whole Slack thread maps to one continuous
   * Agent SDK session jsonl instead of a fresh file per message.
   */
  async setAgentSessionId(id: string, agentSessionId: string | null): Promise<void> {
    await this.client
      .update(messagingSessions)
      .set({ agentSessionId })
      .where(eq(messagingSessions.id, id));
  }

  /** Update last activity timestamp and increment message count */
  async touchSession(id: string): Promise<void> {
    await this.client
      .update(messagingSessions)
      .set({
        lastActivityAt: new Date().toISOString(),
        messageCount: sql`${messagingSessions.messageCount} + 1`,
      })
      .where(eq(messagingSessions.id, id));
  }

  /** Deactivate a session (e.g., user sends /new or /reset) */
  async deactivateSession(id: string): Promise<void> {
    await this.client
      .update(messagingSessions)
      .set({ active: false })
      .where(eq(messagingSessions.id, id));
  }

  /** Store a message in the conversation history */
  async addMessage(
    sessionId: string,
    role: "user" | "assistant",
    content: string,
    platformMessageId?: string,
  ): Promise<void> {
    // `id` is AUTOINCREMENT — never supplied.
    await this.client.insert(messagingMessages).values({
      sessionId,
      role,
      content,
      timestamp: new Date().toISOString(),
      platformMessageId: platformMessageId || null,
    });
  }

  /**
   * Get conversation history for a session — the most recent N messages, in
   * chronological order.
   *
   * The `ORDER BY` is DESC precisely because the limit must bite at the OLD
   * end: an `ASC … LIMIT 50` keeps the FIRST fifty messages of the thread, so
   * a long-running thread rehydrates its opening and never sees what was just
   * said. Reversed back to ASC here so the caller still gets oldest-first.
   * `id` breaks ties — `timestamp` is a whole-millisecond ISO string and the
   * user + assistant rows of one turn are routinely written inside the same
   * millisecond.
   */
  async getHistory(sessionId: string, limit = 50): Promise<ConversationMessage[]> {
    const rows = await this.client
      .select()
      .from(messagingMessages)
      .where(eq(messagingMessages.sessionId, sessionId))
      .orderBy(desc(messagingMessages.timestamp), desc(messagingMessages.id))
      .limit(limit);

    return rows.reverse().map((r) => ({
      id: r.id,
      sessionId: r.sessionId,
      role: r.role as ConversationMessage["role"],
      content: r.content,
      timestamp: r.timestamp,
      platformMessageId: r.platformMessageId,
    }));
  }

  /**
   * The live session for a thread, whichever user opened it — the thread's
   * conversation as Slack itself scopes it.
   *
   * Sessions are keyed per (thread, user) so two people talking in one thread
   * keep separate agent contexts, but a message the HARNESS posts belongs to
   * the thread rather than to a user, and its writer (the workflow's
   * `postComment`) knows only the channel + thread. Most-recently-active wins.
   *
   * `includeStale` drops the inactivity cutoff, for the one caller that is
   * WRITING to the thread rather than deciding whether to answer in it: a
   * workflow can easily run longer than `SESSION_TIMEOUT_MS` between the
   * question and its answer, and dropping that answer because the clock lapsed
   * mid-run is the very gap the transcript exists to close. Recording revives
   * the session (every write touches it), so the user's next message continues
   * this conversation instead of starting a fresh one.
   */
  async findActiveThreadSession(
    platform: string,
    channelId: string,
    threadId: string,
    opts: { includeStale?: boolean } = {},
  ): Promise<ConversationSession | null> {
    const cutoff = opts.includeStale
      ? new Date(0).toISOString()
      : new Date(Date.now() - SESSION_TIMEOUT_MS).toISOString();
    const [row] = await this.client
      .select()
      .from(messagingSessions)
      .where(
        and(
          eq(messagingSessions.platform, platform),
          eq(messagingSessions.channelId, channelId),
          eq(messagingSessions.threadId, threadId),
          eq(messagingSessions.active, true),
          gte(messagingSessions.lastActivityAt, cutoff),
        ),
      )
      .orderBy(desc(messagingSessions.lastActivityAt))
      .limit(1);
    return row ? this.rowToSession(row) : null;
  }

  /** Check if the bot is already participating in a thread (any user, any active non-stale session) */
  async hasActiveThread(platform: string, channelId: string, threadId: string): Promise<boolean> {
    return !!(await this.findActiveThreadSession(platform, channelId, threadId));
  }

  /** Clean up old inactive sessions (call from cron) */
  async cleanupStaleSessions(maxAgeDays = 7): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeDays * 24 * 60 * 60 * 1000).toISOString();
    const staleSessions = and(
      eq(messagingSessions.active, false),
      lt(messagingSessions.lastActivityAt, cutoff),
    );

    // Delete messages for old sessions first
    await this.client.delete(messagingMessages).where(
      inArray(
        messagingMessages.sessionId,
        this.client.select({ id: messagingSessions.id }).from(messagingSessions).where(staleSessions),
      ),
    );

    const result = await this.client.delete(messagingSessions).where(staleSessions);

    return changes(result);
  }

  /**
   * Builder rows are already camelCase and `active` is already a boolean, so
   * this is down to the two DEFAULT-without-NOT-NULL columns: a NULL
   * `message_count` reads as 0 and a NULL `active` as inactive, exactly as the
   * old `row.message_count` / `!!row.active` did.
   */
  private rowToSession(row: SessionRow): ConversationSession {
    return {
      id: row.id,
      platform: row.platform,
      channelId: row.channelId,
      threadId: row.threadId,
      userId: row.userId,
      agentSessionId: row.agentSessionId,
      createdAt: row.createdAt,
      lastActivityAt: row.lastActivityAt,
      messageCount: row.messageCount ?? 0,
      active: !!row.active,
    };
  }
}

import { randomUUID } from "crypto";
import { and, asc, count, desc, eq, gte, inArray, isNotNull, isNull, lt, sql } from "drizzle-orm";
import type { FeedbackSentiment, FeedbackSource } from "../engine/feedback/reactions.js";
import type { StateClient } from "./client.js";
import { changes, dayBucket } from "./dialect.js";
import { feedbackAnchors, feedbackSignals } from "./schema/sqlite.js";

/**
 * The feedback ledger (issue #255) — 👍/👎 on the bot's own output, scored
 * against the workflow run that produced it.
 *
 * Two tables with one job each (schema + rationale in `schema/sqlite.ts`):
 *
 * - **anchors** are the reactable artefacts we posted, each carrying the run it
 *   came from. They are how a reaction — which names a *message* — finds a run.
 * - **signals** are the reactions themselves, one row per (anchor, reactor,
 *   emoji), with the run attribution denormalized on so no analytics query
 *   needs a join.
 *
 * Two invariants worth keeping in mind when extending this:
 *
 * 1. **Ingest is idempotent.** Slack delivers at-least-once and the GitHub
 *    poller re-reads the same reactions every tick, so `recordSignal` is an
 *    upsert on `(anchor, reactor, emoji)` and callers may replay freely.
 * 2. **A retraction is a fact, not a delete.** Removing a reaction stamps
 *    `removed_at`; the row stays. "Somebody thumbed this and then thought
 *    better of it" is itself signal, and every scoring query filters on
 *    `removed_at IS NULL` rather than relying on the row being gone.
 */

/** What kind of thing was reacted to. */
export type FeedbackAnchorKind =
  | "slack_message"
  | "issue_comment"
  | "review_comment"
  | "issue";

export interface FeedbackAnchor {
  id: string;
  source: FeedbackSource;
  kind: FeedbackAnchorKind;
  externalId: string;
  nodeId: string | null;
  channel: string | null;
  owner: string | null;
  repo: string | null;
  issueNumber: number | null;
  workflowRunId: string | null;
  workflowName: string | null;
  messagingSessionId: string | null;
  createdAt: string;
  lastPolledAt: string | null;
}

/** The fields a caller supplies to register an anchor. */
export type FeedbackAnchorInput = Omit<FeedbackAnchor, "id" | "createdAt" | "lastPolledAt"> &
  Partial<Pick<FeedbackAnchor, "createdAt">>;

export interface FeedbackSignal {
  id: string;
  anchorId: string;
  source: FeedbackSource;
  workflowRunId: string | null;
  workflowName: string | null;
  messagingSessionId: string | null;
  owner: string | null;
  repo: string | null;
  issueNumber: number | null;
  emoji: string;
  score: number;
  sentiment: FeedbackSentiment;
  reactor: string | null;
  reactedAt: string | null;
  observedAt: string;
  removedAt: string | null;
  exportedAt: string | null;
}

export interface RecordSignalInput {
  anchor: FeedbackAnchor;
  emoji: string;
  score: number;
  sentiment: FeedbackSentiment;
  reactor?: string;
  reactedAt?: string;
}

/** One workflow's standing, for the dashboard leaderboard. */
export interface FeedbackSummaryRow {
  workflowName: string | null;
  /** Every live signal, 👀 included. */
  total: number;
  positive: number;
  negative: number;
  /** Recorded-but-unscored (👀). Excluded from `averageScore`. */
  neutral: number;
  /** Mean over SCORED signals only — a neutral 👀 must not drag it toward 0. */
  averageScore: number;
}

export interface FeedbackDailyRow {
  date: string;
  total: number;
  positive: number;
  negative: number;
  averageScore: number;
}

export interface FeedbackListOptions {
  limit?: number;
  offset?: number;
  workflowName?: string;
  repo?: string;
  source?: FeedbackSource;
  sinceIso?: string;
  /** Include retracted rows (default false). */
  includeRemoved?: boolean;
}

/** The row shapes the builder returns for these tables, before normalization. */
type AnchorRow = typeof feedbackAnchors.$inferSelect;
type SignalRow = typeof feedbackSignals.$inferSelect;

/**
 * `score` is a real integer (−2..+2), NOT a boolean, so these three tallies are
 * arithmetic in both dialects and need no boolean port. `SUM` is a bigint in
 * Postgres, hence `mapWith(Number)`.
 */
const positiveCount = sql`SUM(CASE WHEN ${feedbackSignals.score} > 0 THEN 1 ELSE 0 END)`.mapWith(
  Number,
);
const negativeCount = sql`SUM(CASE WHEN ${feedbackSignals.score} < 0 THEN 1 ELSE 0 END)`.mapWith(
  Number,
);
const neutralCount = sql`SUM(CASE WHEN ${feedbackSignals.score} = 0 THEN 1 ELSE 0 END)`.mapWith(
  Number,
);
/** Mean over SCORED signals only — the `!= 0` arm is what excludes 👀. */
const scoredAverage =
  sql`COALESCE(AVG(CASE WHEN ${feedbackSignals.score} != 0 THEN ${feedbackSignals.score} END), 0)`.mapWith(
    Number,
  );

export class FeedbackStore {
  constructor(private client: StateClient) {}

  // ── Anchors ──────────────────────────────────────────────────────────────

  /**
   * Register (or re-register) a reactable artefact. Idempotent on
   * `(source, channel, external_id)`: re-posting the same Slack ts, or
   * re-discovering the same GitHub comment on a later tick, updates the
   * attribution in place rather than forking a second anchor — which would
   * split one comment's reactions across two rows.
   */
  async upsertAnchor(input: FeedbackAnchorInput): Promise<FeedbackAnchor> {
    const now = new Date().toISOString();
    const id = randomUUID();
    await this.client
      .insert(feedbackAnchors)
      .values({
        id,
        source: input.source,
        kind: input.kind,
        externalId: input.externalId,
        nodeId: input.nodeId ?? null,
        channel: channelKey(input.channel),
        owner: input.owner ?? null,
        repo: input.repo ?? null,
        issueNumber: input.issueNumber ?? null,
        workflowRunId: input.workflowRunId ?? null,
        workflowName: input.workflowName ?? null,
        messagingSessionId: input.messagingSessionId ?? null,
        createdAt: input.createdAt ?? now,
      })
      .onConflictDoUpdate({
        target: [feedbackAnchors.source, feedbackAnchors.channel, feedbackAnchors.externalId],
        // Every arm is COALESCE(excluded, existing): a later sighting may learn
        // an attribution the first one lacked, but must never blank one it did
        // not carry.
        set: {
          nodeId: sql`coalesce(excluded.node_id, ${feedbackAnchors.nodeId})`,
          workflowRunId: sql`coalesce(excluded.workflow_run_id, ${feedbackAnchors.workflowRunId})`,
          workflowName: sql`coalesce(excluded.workflow_name, ${feedbackAnchors.workflowName})`,
          messagingSessionId: sql`coalesce(excluded.messaging_session_id, ${feedbackAnchors.messagingSessionId})`,
          owner: sql`coalesce(excluded.owner, ${feedbackAnchors.owner})`,
          repo: sql`coalesce(excluded.repo, ${feedbackAnchors.repo})`,
          issueNumber: sql`coalesce(excluded.issue_number, ${feedbackAnchors.issueNumber})`,
        },
      });
    // Read back rather than trusting `id`: on the conflict branch the existing
    // row keeps its own id, and callers need the one the signals will point at.
    return (await this.findAnchor(input.source, input.channel ?? null, input.externalId))!;
  }

  /** The reverse lookup a reaction hits. */
  async findAnchor(
    source: FeedbackSource,
    channel: string | null,
    externalId: string,
  ): Promise<FeedbackAnchor | null> {
    const [row] = await this.client
      .select()
      .from(feedbackAnchors)
      .where(
        and(
          eq(feedbackAnchors.source, source),
          eq(feedbackAnchors.externalId, externalId),
          eq(feedbackAnchors.channel, channelKey(channel)),
        ),
      )
      .limit(1);
    return row ? this.deserializeAnchor(row) : null;
  }

  async getAnchor(id: string): Promise<FeedbackAnchor | null> {
    const [row] = await this.client
      .select()
      .from(feedbackAnchors)
      .where(eq(feedbackAnchors.id, id))
      .limit(1);
    return row ? this.deserializeAnchor(row) : null;
  }

  /**
   * The GitHub poller's rotation: anchors still inside the reaction window,
   * least-recently-polled first, capped. Bounding it here rather than in the
   * cron is what keeps the API spend a property of the data (a fixed-size
   * working set) instead of of the schedule.
   */
  async anchorsToPoll(opts: {
    windowDays: number;
    limit: number;
    now?: Date;
  }): Promise<FeedbackAnchor[]> {
    const now = opts.now ?? new Date();
    const cutoff = new Date(now.getTime() - opts.windowDays * 86_400_000).toISOString();
    const rows = await this.client
      .select()
      .from(feedbackAnchors)
      .where(
        and(
          eq(feedbackAnchors.source, "github"),
          isNotNull(feedbackAnchors.nodeId),
          gte(feedbackAnchors.createdAt, cutoff),
        ),
      )
      // A boolean used as a sort key: never-polled anchors first. Portable in
      // both dialects — false sorts before true, matching SQLite's 0 < 1 — and
      // spelled out rather than left to NULLS FIRST/LAST, which is not.
      .orderBy(sql`${feedbackAnchors.lastPolledAt} IS NOT NULL`, asc(feedbackAnchors.lastPolledAt))
      .limit(opts.limit);
    return rows.map((r) => this.deserializeAnchor(r));
  }

  async markPolled(anchorIds: string[], at = new Date().toISOString()): Promise<void> {
    if (anchorIds.length === 0) return;
    await this.client
      .update(feedbackAnchors)
      .set({ lastPolledAt: at })
      .where(inArray(feedbackAnchors.id, anchorIds));
  }

  /** Drop anchors past the retention horizon. Signals are kept — they are the data. */
  async pruneAnchors(retentionDays: number, now = new Date()): Promise<number> {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    const res = await this.client
      .delete(feedbackAnchors)
      .where(lt(feedbackAnchors.createdAt, cutoff));
    return changes(res);
  }

  // ── Signals ──────────────────────────────────────────────────────────────

  /**
   * Record one reaction. Returns the signal when it is NEW (or a revival of a
   * retracted one), and null when it was already known — so the caller can emit
   * telemetry exactly once without tracking state itself.
   */
  async recordSignal(input: RecordSignalInput): Promise<FeedbackSignal | null> {
    const { anchor } = input;
    const now = new Date().toISOString();
    const reactor = input.reactor ?? null;
    const [row] = await this.client
      .select()
      .from(feedbackSignals)
      .where(
        and(
          eq(feedbackSignals.anchorId, anchor.id),
          matchReactor(reactor),
          eq(feedbackSignals.emoji, input.emoji),
        ),
      )
      .limit(1);

    if (row) {
      const existing = deserializeSignal(row);
      // Already live — nothing happened.
      if (!existing.removedAt) return null;
      // Reacted, un-reacted, reacted again. Revive the row and let it export
      // again: the person changed their mind twice and both are real events.
      await this.client
        .update(feedbackSignals)
        .set({
          removedAt: null,
          observedAt: now,
          reactedAt: input.reactedAt ?? now,
          exportedAt: null,
        })
        .where(eq(feedbackSignals.id, existing.id));
      return { ...existing, removedAt: null, observedAt: now, exportedAt: null };
    }

    const signal: FeedbackSignal = {
      id: randomUUID(),
      anchorId: anchor.id,
      source: anchor.source,
      workflowRunId: anchor.workflowRunId,
      workflowName: anchor.workflowName,
      messagingSessionId: anchor.messagingSessionId,
      owner: anchor.owner,
      repo: anchor.repo,
      issueNumber: anchor.issueNumber,
      emoji: input.emoji,
      score: input.score,
      sentiment: input.sentiment,
      reactor,
      reactedAt: input.reactedAt ?? now,
      observedAt: now,
      removedAt: null,
      exportedAt: null,
    };
    await this.client.insert(feedbackSignals).values({
      id: signal.id,
      anchorId: signal.anchorId,
      source: signal.source,
      workflowRunId: signal.workflowRunId,
      workflowName: signal.workflowName,
      messagingSessionId: signal.messagingSessionId,
      owner: signal.owner,
      repo: signal.repo,
      issueNumber: signal.issueNumber,
      emoji: signal.emoji,
      score: signal.score,
      sentiment: signal.sentiment,
      reactor: signal.reactor,
      reactedAt: signal.reactedAt,
      observedAt: signal.observedAt,
    });
    return signal;
  }

  /** Retract one reaction. Returns true when a live row was actually retracted. */
  async removeSignal(
    anchorId: string,
    reactor: string | null,
    emoji: string,
    at?: string,
  ): Promise<boolean> {
    const res = await this.client
      .update(feedbackSignals)
      .set({ removedAt: at ?? new Date().toISOString() })
      .where(
        and(
          eq(feedbackSignals.anchorId, anchorId),
          matchReactor(reactor),
          eq(feedbackSignals.emoji, emoji),
          isNull(feedbackSignals.removedAt),
        ),
      );
    return changes(res) > 0;
  }

  /**
   * Retract every live signal on an anchor that is NOT in `keep`. The GitHub
   * poller's reconciliation step: a reaction that has disappeared between two
   * batches has no event to announce it, so absence from the fresh read is the
   * only evidence there is.
   */
  async reconcileAnchor(
    anchorId: string,
    keep: Array<{ reactor: string | null; emoji: string }>,
  ): Promise<number> {
    const live = await this.client
      .select({
        id: feedbackSignals.id,
        reactor: feedbackSignals.reactor,
        emoji: feedbackSignals.emoji,
      })
      .from(feedbackSignals)
      .where(and(eq(feedbackSignals.anchorId, anchorId), isNull(feedbackSignals.removedAt)));
    const keepKeys = new Set(keep.map((k) => `${k.reactor ?? ""} ${k.emoji}`));
    const stale = live.filter((s) => !keepKeys.has(`${s.reactor ?? ""} ${s.emoji}`));
    if (stale.length === 0) return 0;
    const now = new Date().toISOString();
    await this.client
      .update(feedbackSignals)
      .set({ removedAt: now })
      .where(
        inArray(
          feedbackSignals.id,
          stale.map((r) => r.id),
        ),
      );
    return stale.length;
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  async list(
    opts: FeedbackListOptions = {},
  ): Promise<{ signals: FeedbackSignal[]; total: number }> {
    const filters = [
      opts.includeRemoved ? undefined : isNull(feedbackSignals.removedAt),
      opts.workflowName ? eq(feedbackSignals.workflowName, opts.workflowName) : undefined,
      opts.repo ? eq(feedbackSignals.repo, opts.repo) : undefined,
      opts.source ? eq(feedbackSignals.source, opts.source) : undefined,
      opts.sinceIso ? gte(feedbackSignals.observedAt, opts.sinceIso) : undefined,
    ].filter((f) => f !== undefined);
    const where = filters.length ? and(...filters) : undefined;
    const [counted] = await this.client
      .select({ n: count() })
      .from(feedbackSignals)
      .where(where);
    const rows = await this.client
      .select()
      .from(feedbackSignals)
      .where(where)
      .orderBy(desc(feedbackSignals.observedAt))
      .limit(opts.limit ?? 50)
      .offset(opts.offset ?? 0);
    return { signals: rows.map(deserializeSignal), total: counted?.n ?? 0 };
  }

  /** Every live signal on one run — powers the run-detail badge. */
  async forRun(workflowRunId: string): Promise<FeedbackSignal[]> {
    const rows = await this.client
      .select()
      .from(feedbackSignals)
      .where(
        and(
          eq(feedbackSignals.workflowRunId, workflowRunId),
          isNull(feedbackSignals.removedAt),
        ),
      )
      .orderBy(asc(feedbackSignals.observedAt));
    return rows.map(deserializeSignal);
  }

  /**
   * Per-workflow standing over the last N days.
   *
   * `averageScore` deliberately averages only over SCORED signals (`score != 0`).
   * 👀 is in the vocabulary at 0 so we can see engagement, but letting it into
   * the mean would make a well-received workflow look mediocre purely because
   * people also glanced at it.
   */
  async summaryByWorkflow(days: number, now = new Date()): Promise<FeedbackSummaryRow[]> {
    const since = new Date(now.getTime() - days * 86_400_000).toISOString();
    const rows = await this.client
      .select({
        workflowName: feedbackSignals.workflowName,
        total: count(),
        positive: positiveCount,
        negative: negativeCount,
        neutral: neutralCount,
        averageScore: scoredAverage,
      })
      .from(feedbackSignals)
      .where(and(isNull(feedbackSignals.removedAt), gte(feedbackSignals.observedAt, since)))
      .groupBy(feedbackSignals.workflowName)
      .orderBy(desc(count()));
    return rows.map((r) => ({ ...r, averageScore: round2(r.averageScore) }));
  }

  /**
   * Daily score series, zero-filled across the whole window so a chart shows
   * gaps as gaps rather than closing over them. Same UTC key generation as
   * `ExecutionStore.dailyStats`.
   */
  async dailyScores(
    days: number,
    workflowName?: string,
    now = new Date(),
  ): Promise<FeedbackDailyRow[]> {
    const startUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)),
    );
    const dateKeys: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(startUtc);
      d.setUTCDate(startUtc.getUTCDate() + i);
      dateKeys.push(d.toISOString().slice(0, 10));
    }

    // `dayBucket` is the portable spelling of sqlite's `date(observed_at)`:
    // timestamps are ISO text in both dialects, so it yields the same
    // `YYYY-MM-DD` keys the JS side above generates.
    const bucket = dayBucket(feedbackSignals.observedAt);
    const rows = await this.client
      .select({
        date: dayBucket(feedbackSignals.observedAt).mapWith(String),
        total: count(),
        positive: positiveCount,
        negative: negativeCount,
        averageScore: scoredAverage,
      })
      .from(feedbackSignals)
      .where(
        and(
          isNull(feedbackSignals.removedAt),
          gte(bucket, dateKeys[0]),
          workflowName ? eq(feedbackSignals.workflowName, workflowName) : undefined,
        ),
      )
      .groupBy(dayBucket(feedbackSignals.observedAt));

    const byDate = new Map(rows.map((r) => [r.date, r]));
    return dateKeys.map((date) => {
      const row = byDate.get(date);
      return row
        ? { ...row, averageScore: round2(row.averageScore) }
        : { date, total: 0, positive: 0, negative: 0, averageScore: 0 };
    });
  }

  // ── OTel export watermark ────────────────────────────────────────────────

  /**
   * Signals not yet exported to OTel, oldest first.
   *
   * **Retracted signals are excluded.** A reaction added and then withdrawn
   * while telemetry was off has no `exported_at` and a `removed_at`; exporting
   * it on the backlog drain would put a +1 the person explicitly took back onto
   * the trace, with nothing to say it was withdrawn. The live path never has
   * this problem (a retraction can't reach `exportSignal`), so the gap was
   * only ever reachable through the backfill.
   */
  async pendingExport(limit = 200): Promise<FeedbackSignal[]> {
    const rows = await this.client
      .select()
      .from(feedbackSignals)
      .where(and(isNull(feedbackSignals.exportedAt), isNull(feedbackSignals.removedAt)))
      .orderBy(asc(feedbackSignals.observedAt))
      .limit(limit);
    return rows.map(deserializeSignal);
  }

  async markExported(ids: string[], at = new Date().toISOString()): Promise<void> {
    if (ids.length === 0) return;
    await this.client
      .update(feedbackSignals)
      .set({ exportedAt: at })
      .where(inArray(feedbackSignals.id, ids));
  }

  // ── Deserialization ──────────────────────────────────────────────────────

  private deserializeAnchor(row: AnchorRow): FeedbackAnchor {
    return {
      ...row,
      source: row.source as FeedbackSource,
      kind: row.kind as FeedbackAnchorKind,
      // Back across the sentinel boundary: '' is the stored form of "no
      // channel", but the type callers see is `string | null`.
      channel: row.channel || null,
    };
  }
}

/**
 * The null-safe half of the `(anchor, reactor, emoji)` idempotency predicate,
 * the old `reactor IS ?`.
 *
 * `reactor` is nullable and a plain `=` never matches NULL, so getting this
 * wrong does not throw — it silently FORKS a row per re-delivery instead of
 * matching the existing one, and double-reactions accumulate unnoticed.
 */
function matchReactor(reactor: string | null) {
  return reactor == null
    ? isNull(feedbackSignals.reactor)
    : eq(feedbackSignals.reactor, reactor);
}

/**
 * Builder rows are already camelCase and the nullable columns are declared
 * `| null` on {@link FeedbackSignal} (not optional), so this is down to
 * re-attaching the two string-union types the TEXT columns erase.
 */
function deserializeSignal(row: SignalRow): FeedbackSignal {
  return {
    ...row,
    source: row.source as FeedbackSource,
    sentiment: row.sentiment as FeedbackSentiment,
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * The stored form of `channel`: '' for a surface that has none (GitHub).
 *
 * SQLite treats NULLs as DISTINCT in a UNIQUE constraint, so a nullable channel
 * makes `UNIQUE(source, channel, external_id)` — and the `ON CONFLICT` that
 * targets it — silently inoperative for every GitHub anchor. Normalizing here
 * keeps that one constraint honest for both surfaces without a second upsert
 * path; {@link FeedbackStore.deserializeAnchor} maps it back to null so the
 * type callers see is still `string | null`.
 */
function channelKey(channel: string | null | undefined): string {
  return channel ?? "";
}

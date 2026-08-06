import type Database from "better-sqlite3";
import { randomUUID } from "crypto";
import type { FeedbackSentiment, FeedbackSource } from "../engine/feedback/reactions.js";

/**
 * The feedback ledger (issue #255) — 👍/👎 on the bot's own output, scored
 * against the workflow run that produced it.
 *
 * Two tables with one job each (schema + rationale in `migrate.ts`):
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

/** Columns shared by every signal read, aliased snake → camel. */
const SIGNAL_COLUMNS = `
  id, anchor_id AS anchorId, source, workflow_run_id AS workflowRunId,
  workflow_name AS workflowName, messaging_session_id AS messagingSessionId, owner, repo,
  issue_number AS issueNumber, emoji, score, sentiment, reactor,
  reacted_at AS reactedAt, observed_at AS observedAt, removed_at AS removedAt,
  exported_at AS exportedAt
`;

export class FeedbackStore {
  constructor(private db: Database.Database) {}

  // ── Anchors ────────────────────────────────────────────────────

  /**
   * Register (or re-register) a reactable artefact. Idempotent on
   * `(source, channel, external_id)`: re-posting the same Slack ts, or
   * re-discovering the same GitHub comment on a later tick, updates the
   * attribution in place rather than forking a second anchor — which would
   * split one comment's reactions across two rows.
   */
  upsertAnchor(input: FeedbackAnchorInput): FeedbackAnchor {
    const now = new Date().toISOString();
    const id = randomUUID();
    this.db
      .prepare(
        `INSERT INTO feedback_anchors
           (id, source, kind, external_id, node_id, channel, owner, repo, issue_number,
            workflow_run_id, workflow_name, messaging_session_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(source, channel, external_id) DO UPDATE SET
           node_id = COALESCE(excluded.node_id, feedback_anchors.node_id),
           workflow_run_id = COALESCE(excluded.workflow_run_id, feedback_anchors.workflow_run_id),
           workflow_name = COALESCE(excluded.workflow_name, feedback_anchors.workflow_name),
           messaging_session_id = COALESCE(excluded.messaging_session_id, feedback_anchors.messaging_session_id),
           owner = COALESCE(excluded.owner, feedback_anchors.owner),
           repo = COALESCE(excluded.repo, feedback_anchors.repo),
           issue_number = COALESCE(excluded.issue_number, feedback_anchors.issue_number)`,
      )
      .run(
        id,
        input.source,
        input.kind,
        input.externalId,
        input.nodeId ?? null,
        input.channel ?? null,
        input.owner ?? null,
        input.repo ?? null,
        input.issueNumber ?? null,
        input.workflowRunId ?? null,
        input.workflowName ?? null,
        input.messagingSessionId ?? null,
        input.createdAt ?? now,
      );
    // Read back rather than trusting `id`: on the conflict branch the existing
    // row keeps its own id, and callers need the one the signals will point at.
    return this.findAnchor(input.source, input.channel ?? null, input.externalId)!;
  }

  /** The reverse lookup a reaction hits. */
  findAnchor(
    source: FeedbackSource,
    channel: string | null,
    externalId: string,
  ): FeedbackAnchor | null {
    const row = this.db
      .prepare(
        `SELECT * FROM feedback_anchors
          WHERE source = ? AND external_id = ? AND channel IS ?`,
      )
      .get(source, externalId, channel) as Record<string, unknown> | undefined;
    return row ? this.deserializeAnchor(row) : null;
  }

  getAnchor(id: string): FeedbackAnchor | null {
    const row = this.db
      .prepare(`SELECT * FROM feedback_anchors WHERE id = ?`)
      .get(id) as Record<string, unknown> | undefined;
    return row ? this.deserializeAnchor(row) : null;
  }

  /**
   * The GitHub poller's rotation: anchors still inside the reaction window,
   * least-recently-polled first, capped. Bounding it here rather than in the
   * cron is what keeps the API spend a property of the data (a fixed-size
   * working set) instead of of the schedule.
   */
  anchorsToPoll(opts: { windowDays: number; limit: number; now?: Date }): FeedbackAnchor[] {
    const now = opts.now ?? new Date();
    const cutoff = new Date(now.getTime() - opts.windowDays * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT * FROM feedback_anchors
          WHERE source = 'github' AND node_id IS NOT NULL AND created_at >= ?
          ORDER BY last_polled_at IS NOT NULL, last_polled_at ASC
          LIMIT ?`,
      )
      .all(cutoff, opts.limit) as Record<string, unknown>[];
    return rows.map((r) => this.deserializeAnchor(r));
  }

  markPolled(anchorIds: string[], at = new Date().toISOString()): void {
    if (anchorIds.length === 0) return;
    const stmt = this.db.prepare(`UPDATE feedback_anchors SET last_polled_at = ? WHERE id = ?`);
    const tx = this.db.transaction((ids: string[]) => {
      for (const id of ids) stmt.run(at, id);
    });
    tx(anchorIds);
  }

  /** Drop anchors past the retention horizon. Signals are kept — they are the data. */
  pruneAnchors(retentionDays: number, now = new Date()): number {
    const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
    const res = this.db
      .prepare(`DELETE FROM feedback_anchors WHERE created_at < ?`)
      .run(cutoff);
    return res.changes;
  }

  // ── Signals ────────────────────────────────────────────────────

  /**
   * Record one reaction. Returns the signal when it is NEW (or a revival of a
   * retracted one), and null when it was already known — so the caller can emit
   * telemetry exactly once without tracking state itself.
   */
  recordSignal(input: RecordSignalInput): FeedbackSignal | null {
    const { anchor } = input;
    const now = new Date().toISOString();
    const existing = this.db
      .prepare(
        `SELECT ${SIGNAL_COLUMNS} FROM feedback_signals
          WHERE anchor_id = ? AND reactor IS ? AND emoji = ?`,
      )
      .get(anchor.id, input.reactor ?? null, input.emoji) as FeedbackSignal | undefined;

    if (existing) {
      // Already live — nothing happened.
      if (!existing.removedAt) return null;
      // Reacted, un-reacted, reacted again. Revive the row and let it export
      // again: the person changed their mind twice and both are real events.
      this.db
        .prepare(
          `UPDATE feedback_signals
              SET removed_at = NULL, observed_at = ?, reacted_at = ?, exported_at = NULL
            WHERE id = ?`,
        )
        .run(now, input.reactedAt ?? now, existing.id);
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
      reactor: input.reactor ?? null,
      reactedAt: input.reactedAt ?? now,
      observedAt: now,
      removedAt: null,
      exportedAt: null,
    };
    this.db
      .prepare(
        `INSERT INTO feedback_signals
           (id, anchor_id, source, workflow_run_id, workflow_name, messaging_session_id, owner, repo,
            issue_number, emoji, score, sentiment, reactor, reacted_at, observed_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        signal.id,
        signal.anchorId,
        signal.source,
        signal.workflowRunId,
        signal.workflowName,
        signal.messagingSessionId,
        signal.owner,
        signal.repo,
        signal.issueNumber,
        signal.emoji,
        signal.score,
        signal.sentiment,
        signal.reactor,
        signal.reactedAt,
        signal.observedAt,
      );
    return signal;
  }

  /** Retract one reaction. Returns true when a live row was actually retracted. */
  removeSignal(anchorId: string, reactor: string | null, emoji: string, at?: string): boolean {
    const res = this.db
      .prepare(
        `UPDATE feedback_signals SET removed_at = ?
          WHERE anchor_id = ? AND reactor IS ? AND emoji = ? AND removed_at IS NULL`,
      )
      .run(at ?? new Date().toISOString(), anchorId, reactor, emoji);
    return res.changes > 0;
  }

  /**
   * Retract every live signal on an anchor that is NOT in `keep`. The GitHub
   * poller's reconciliation step: a reaction that has disappeared between two
   * batches has no event to announce it, so absence from the fresh read is the
   * only evidence there is.
   */
  reconcileAnchor(anchorId: string, keep: Array<{ reactor: string | null; emoji: string }>): number {
    const live = this.db
      .prepare(
        `SELECT id, reactor, emoji FROM feedback_signals
          WHERE anchor_id = ? AND removed_at IS NULL`,
      )
      .all(anchorId) as Array<{ id: string; reactor: string | null; emoji: string }>;
    const keepKeys = new Set(keep.map((k) => `${k.reactor ?? ""} ${k.emoji}`));
    const stale = live.filter((s) => !keepKeys.has(`${s.reactor ?? ""} ${s.emoji}`));
    if (stale.length === 0) return 0;
    const now = new Date().toISOString();
    const stmt = this.db.prepare(`UPDATE feedback_signals SET removed_at = ? WHERE id = ?`);
    const tx = this.db.transaction((rows: typeof stale) => {
      for (const r of rows) stmt.run(now, r.id);
    });
    tx(stale);
    return stale.length;
  }

  // ── Reads ──────────────────────────────────────────────────────

  list(opts: FeedbackListOptions = {}): { signals: FeedbackSignal[]; total: number } {
    const where: string[] = [];
    const params: unknown[] = [];
    if (!opts.includeRemoved) where.push("removed_at IS NULL");
    if (opts.workflowName) {
      where.push("workflow_name = ?");
      params.push(opts.workflowName);
    }
    if (opts.repo) {
      where.push("repo = ?");
      params.push(opts.repo);
    }
    if (opts.source) {
      where.push("source = ?");
      params.push(opts.source);
    }
    if (opts.sinceIso) {
      where.push("observed_at >= ?");
      params.push(opts.sinceIso);
    }
    const clause = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const total = (
      this.db
        .prepare(`SELECT COUNT(*) AS n FROM feedback_signals ${clause}`)
        .get(...params) as { n: number }
    ).n;
    const signals = this.db
      .prepare(
        `SELECT ${SIGNAL_COLUMNS} FROM feedback_signals ${clause}
          ORDER BY observed_at DESC LIMIT ? OFFSET ?`,
      )
      .all(...params, opts.limit ?? 50, opts.offset ?? 0) as FeedbackSignal[];
    return { signals, total };
  }

  /** Every live signal on one run — powers the run-detail badge. */
  forRun(workflowRunId: string): FeedbackSignal[] {
    return this.db
      .prepare(
        `SELECT ${SIGNAL_COLUMNS} FROM feedback_signals
          WHERE workflow_run_id = ? AND removed_at IS NULL
          ORDER BY observed_at ASC`,
      )
      .all(workflowRunId) as FeedbackSignal[];
  }

  /**
   * Per-workflow standing over the last N days.
   *
   * `averageScore` deliberately averages only over SCORED signals (`score != 0`).
   * 👀 is in the vocabulary at 0 so we can see engagement, but letting it into
   * the mean would make a well-received workflow look mediocre purely because
   * people also glanced at it.
   */
  summaryByWorkflow(days: number, now = new Date()): FeedbackSummaryRow[] {
    const since = new Date(now.getTime() - days * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT
           workflow_name AS workflowName,
           COUNT(*) AS total,
           SUM(CASE WHEN score > 0 THEN 1 ELSE 0 END) AS positive,
           SUM(CASE WHEN score < 0 THEN 1 ELSE 0 END) AS negative,
           SUM(CASE WHEN score = 0 THEN 1 ELSE 0 END) AS neutral,
           COALESCE(AVG(CASE WHEN score != 0 THEN score END), 0) AS averageScore
         FROM feedback_signals
         WHERE removed_at IS NULL AND observed_at >= ?
         GROUP BY workflow_name
         ORDER BY total DESC`,
      )
      .all(since) as FeedbackSummaryRow[];
    return rows.map((r) => ({ ...r, averageScore: round2(r.averageScore) }));
  }

  /**
   * Daily score series, zero-filled across the whole window so a chart shows
   * gaps as gaps rather than closing over them. Same UTC key generation as
   * `ExecutionStore.dailyStats`.
   */
  dailyScores(days: number, workflowName?: string, now = new Date()): FeedbackDailyRow[] {
    const startUtc = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - (days - 1)),
    );
    const dateKeys: string[] = [];
    for (let i = 0; i < days; i++) {
      const d = new Date(startUtc);
      d.setUTCDate(startUtc.getUTCDate() + i);
      dateKeys.push(d.toISOString().slice(0, 10));
    }

    const params: unknown[] = [dateKeys[0]];
    let filter = "";
    if (workflowName) {
      filter = " AND workflow_name = ?";
      params.push(workflowName);
    }
    const rows = this.db
      .prepare(
        `SELECT
           date(observed_at) AS date,
           COUNT(*) AS total,
           SUM(CASE WHEN score > 0 THEN 1 ELSE 0 END) AS positive,
           SUM(CASE WHEN score < 0 THEN 1 ELSE 0 END) AS negative,
           COALESCE(AVG(CASE WHEN score != 0 THEN score END), 0) AS averageScore
         FROM feedback_signals
         WHERE removed_at IS NULL AND date(observed_at) >= ?${filter}
         GROUP BY date(observed_at)`,
      )
      .all(...params) as FeedbackDailyRow[];

    const byDate = new Map(rows.map((r) => [r.date, r]));
    return dateKeys.map(
      (date) => {
        const row = byDate.get(date);
        return row
          ? { ...row, averageScore: round2(row.averageScore) }
          : { date, total: 0, positive: 0, negative: 0, averageScore: 0 };
      },
    );
  }

  // ── OTel export watermark ──────────────────────────────────────

  /** Signals not yet exported to OTel, oldest first. */
  pendingExport(limit = 200): FeedbackSignal[] {
    return this.db
      .prepare(
        `SELECT ${SIGNAL_COLUMNS} FROM feedback_signals
          WHERE exported_at IS NULL ORDER BY observed_at ASC LIMIT ?`,
      )
      .all(limit) as FeedbackSignal[];
  }

  markExported(ids: string[], at = new Date().toISOString()): void {
    if (ids.length === 0) return;
    const stmt = this.db.prepare(`UPDATE feedback_signals SET exported_at = ? WHERE id = ?`);
    const tx = this.db.transaction((rows: string[]) => {
      for (const id of rows) stmt.run(at, id);
    });
    tx(ids);
  }

  // ── Deserialization ────────────────────────────────────────────

  private deserializeAnchor(row: Record<string, unknown>): FeedbackAnchor {
    return {
      id: row.id as string,
      source: row.source as FeedbackSource,
      kind: row.kind as FeedbackAnchorKind,
      externalId: row.external_id as string,
      nodeId: (row.node_id as string | null) ?? null,
      channel: (row.channel as string | null) ?? null,
      owner: (row.owner as string | null) ?? null,
      repo: (row.repo as string | null) ?? null,
      issueNumber: (row.issue_number as number | null) ?? null,
      workflowRunId: (row.workflow_run_id as string | null) ?? null,
      workflowName: (row.workflow_name as string | null) ?? null,
      messagingSessionId: (row.messaging_session_id as string | null) ?? null,
      createdAt: row.created_at as string,
      lastPolledAt: (row.last_polled_at as string | null) ?? null,
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

import { randomUUID } from "crypto";
import { and, asc, count, desc, eq, gte, type SQL } from "drizzle-orm";
import { nullsToUndefined, tablesOf, type StateClient, type StateTables } from "./client.js";
import type { TriggerActorType } from "./user-store.js";

/**
 * A lexicographically-sortable row id: a fixed-width millisecond stamp, a
 * per-process counter, then a uuid.
 *
 * `created_at` has millisecond resolution, so rows written in the same tick tie
 * — and this table's whole purpose is a chronological read. Under sqlite the
 * tiebreak would have been `rowid` (INSERTION ORDER), which PostgreSQL has no
 * equivalent of; a plain `randomUUID()` is a total order but an ARBITRARY one,
 * and arbitrary is not good enough for a PAGED read. A page boundary landing
 * inside a same-millisecond tie under one ordering and outside it under
 * another silently skips or repeats rows between page 1 and page 2.
 *
 * Same reasoning, and the same shape, as `cron-run-store.ts` — see its copy of
 * this comment for the failure it was written against.
 */
let idSeq = 0;
function creationOrderedId(): string {
  const stamp = Date.now().toString(16).padStart(12, "0");
  idSeq = (idSeq + 1) & 0xffffff;
  return `${stamp}-${idSeq.toString(16).padStart(6, "0")}-${randomUUID()}`;
}

/**
 * The verb vocabulary (issue #206). A closed union on purpose: these strings
 * become data, so a typo at a call site should be a compile error rather than a
 * row nobody can filter for. Adding a verb is a deliberate edit here.
 */
export const ACTIVITY_ACTIONS = [
  "login",
  "workflow.trigger",
  "workflow.retry",
  "workflow.cancel",
  "workflow.toggle",
  "approval.approve",
  "approval.reject",
  "cron.fire",
  "cron.trigger",
  "cron.toggle",
  "config.edit",
  "container.kill",
  "artifact.edit",
  "pr.retry",
] as const;

export type ActivityAction = (typeof ACTIVITY_ACTIONS)[number];

/** Did the action happen, get refused, or blow up. */
export const ACTIVITY_OUTCOMES = ["ok", "denied", "error"] as const;

export type ActivityOutcome = (typeof ACTIVITY_OUTCOMES)[number];

/**
 * A short, flat summary — the new value of a toggle, the schedule that was set.
 * Deliberately NOT a payload: no request bodies, no prompt text, no tokens.
 * See the PII non-goal in `docs/plans/activity-log/README.md`.
 */
export type ActivityDetail = Record<string, string | number | boolean>;

/**
 * One recorded action. `actorLogin` is absent when the session carries no
 * verified login — password logins and auth-disabled instances both produce
 * that, and a null actor is a truer statement than the literal `"admin"` the
 * `updated_by` columns fall back to.
 */
export interface ActivityRecord {
  id: string;
  createdAt: string;
  actorLogin?: string;
  actorType?: TriggerActorType;
  action: ActivityAction;
  /** `workflow_run` | `cron` | `workflow` | `repo` | `approval` | `pr` | `container`. */
  targetType?: string;
  /** The bare identifier — a run id, a cron name, `owner/repo`, `owner/repo#7`. */
  targetId?: string;
  outcome: ActivityOutcome;
  detail?: ActivityDetail;
}

/** What a writer supplies. `id` and `createdAt` are minted here, never passed in. */
export interface ActivityEntry {
  actorLogin?: string | null;
  actorType?: TriggerActorType | null;
  action: ActivityAction;
  targetType?: string | null;
  targetId?: string | null;
  /** Defaults to `ok` — the overwhelmingly common case. */
  outcome?: ActivityOutcome;
  detail?: ActivityDetail | null;
}

export interface ActivityListOptions {
  limit?: number;
  offset?: number;
  /** Exact `actor_login`. */
  actor?: string;
  /** Exact `action` verb. */
  action?: string;
  targetType?: string;
  targetId?: string;
  /** `created_at >= sinceIso`. */
  sinceIso?: string;
}

/** The row shape the builder returns for this table, before normalization. */
type ActivityRow = StateTables["activityLog"]["$inferSelect"];

/**
 * Owns the `activity_log` ledger — one row per user-initiated action, across
 * the dashboard, CLI, Slack, GitHub and cron (issue #206).
 *
 * COMPLEMENTS #205's per-run actor columns rather than replacing them:
 * `workflow_runs.triggered_by` stays the hot-path attribution a run's detail
 * view reads, and this is the cross-cutting stream that answers "what has this
 * person done?" without joining five ledgers.
 *
 * Append-only. There is no update and no delete, by design — an audit row that
 * can be rewritten is not evidence of anything.
 *
 * Pure single-table CRUD: it opens no transaction and takes no `dbc`, so every
 * method runs against the root client.
 */
export class ActivityStore {
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
   * Append one row.
   *
   * `createdAt` is stamped here rather than accepted, so no caller can supply a
   * clock and no two writers can disagree about what "now" was.
   *
   * This throws on a store failure like any other method — the best-effort
   * contract (#206: "a store failure never fails the underlying action") lives
   * one level up, in `recordActivity()`, so that a test CAN still assert this
   * rejects.
   */
  async record(entry: ActivityEntry): Promise<string> {
    const { activityLog } = this.t;
    const id = creationOrderedId();
    await this.client.insert(activityLog).values({
      id,
      createdAt: new Date().toISOString(),
      actorLogin: entry.actorLogin ?? null,
      actorType: entry.actorType ?? null,
      action: entry.action,
      targetType: entry.targetType ?? null,
      targetId: entry.targetId ?? null,
      outcome: entry.outcome ?? "ok",
      detail: entry.detail ?? null,
    });
    return id;
  }

  /**
   * A page of the feed, newest first, plus the post-filter total so the caller
   * knows how many remain.
   *
   * The `desc(id)` tiebreak is load-bearing, not decoration: without it a page
   * boundary falling inside a same-millisecond run of rows skips or repeats
   * them. See {@link creationOrderedId}.
   */
  async list(
    opts: ActivityListOptions = {},
  ): Promise<{ activity: ActivityRecord[]; total: number }> {
    const { activityLog } = this.t;
    const limit = opts.limit ?? 50;
    const offset = opts.offset ?? 0;

    const where: SQL[] = [];
    if (opts.actor) where.push(eq(activityLog.actorLogin, opts.actor));
    if (opts.action) where.push(eq(activityLog.action, opts.action as ActivityAction));
    if (opts.targetType) where.push(eq(activityLog.targetType, opts.targetType));
    if (opts.targetId) where.push(eq(activityLog.targetId, opts.targetId));
    if (opts.sinceIso) where.push(gte(activityLog.createdAt, opts.sinceIso));
    const whereClause = where.length > 0 ? and(...where) : undefined;

    const [counted] = await this.client
      .select({ c: count() })
      .from(activityLog)
      .where(whereClause);

    // Every column here is small by construction (`detail` is a flat summary,
    // not a payload), so unlike `WorkflowRunStore.list` this needs no explicit
    // projection to keep a page cheap.
    const page = await this.client
      .select()
      .from(activityLog)
      .where(whereClause)
      .orderBy(desc(activityLog.createdAt), desc(activityLog.id))
      .limit(limit)
      .offset(offset);

    return { activity: page.map(deserialize), total: counted?.c ?? 0 };
  }

  /**
   * The distinct verbs actually present, for the dashboard's filter dropdown.
   *
   * Read from the data rather than returned from {@link ACTIVITY_ACTIONS} so
   * the dropdown offers only filters that can match something — and so a row
   * written by an older deployment whose verb has since been retired still
   * shows up as filterable.
   */
  async actions(): Promise<string[]> {
    const { activityLog } = this.t;
    const rows = await this.client
      .selectDistinct({ action: activityLog.action })
      .from(activityLog)
      .orderBy(asc(activityLog.action));
    return rows.map((r) => r.action);
  }
}

function deserialize(row: ActivityRow): ActivityRecord {
  const r = nullsToUndefined(row);
  return {
    id: r.id,
    createdAt: r.createdAt,
    actorLogin: r.actorLogin,
    actorType: r.actorType,
    action: r.action,
    targetType: r.targetType,
    targetId: r.targetId,
    outcome: r.outcome,
    detail: r.detail,
  };
}

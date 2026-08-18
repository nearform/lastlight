import { and, asc, count, desc, eq, gte, inArray, isNotNull, ne, or, sql, type SQL } from "drizzle-orm";
import type { ApprovalStore } from "./approval-store.js";
import type { TriggerActorType } from "./user-store.js";
import {
  nullsToUndefined,
  tablesOf,
  type OpSerializer,
  type StateClient,
  type StateDbc,
  type StateTables,
} from "./client.js";
import { changes } from "./dialect.js";
import { normalizeRepoRef, qualifiedRepoSql } from "./repo-ref.js";
import { logger } from "../logging/logger.js";

const log = logger("runs");

/**
 * Sort key that floats in-flight runs above everything else, ahead of the
 * `started_at DESC` tiebreak.
 *
 * This is a PAGINATION correctness fix, not a cosmetic one. The dashboard's
 * Live filter asks for `queued|running|paused`, and a cron fan-out enqueues a
 * whole batch at once — 30-40 rows whose `started_at` is newer than any run
 * currently executing. Ordered by date alone they filled the entire first page,
 * so the running work sat on page 2; and because the list hides queued rows by
 * default, the user saw an EMPTY Live tab while agents were mid-run. Sorting
 * client-side cannot fix that: the rows it would reorder were never fetched.
 *
 * `running` leads `paused` because a paused run already has its own surface
 * (the approval banner), so the top of the list is the place to see what is
 * actually moving. Everything terminal shares the last bucket and stays purely
 * chronological among itself, which is what the day/week ranges want.
 */
const ACTIVE_FIRST = ({ workflowRuns }: StateTables) => sql`CASE ${workflowRuns.status}
             WHEN 'running' THEN 0
             WHEN 'paused'  THEN 1
             WHEN 'queued'  THEN 2
             ELSE 3
           END`;

export interface PhaseHistoryEntry {
  phase: string;
  timestamp: string;
  success: boolean;
  summary?: string;
}

export interface WorkflowRun {
  id: string;
  workflowName: string;
  triggerId: string;
  /** GitHub org/user that owns {@link repo}. Stored as its own column so the
   *  runs list (which omits `context`) can compose the qualified `owner/repo`. */
  owner?: string;
  /**
   * BARE repo name (no owner) — kept path-safe for taskIds / workspace dirs.
   *
   * Normalized on the way in AND on the way back out (`state/repo-ref.ts`), so
   * a consumer can hand `(run.owner, run.repo)` to Octokit unsplit. Reach for
   * `qualifyRepo` when you need the user-facing `owner/repo`.
   */
  repo?: string;
  issueNumber?: number;
  /**
   * Who originally triggered this run (issue #205) — a GitHub login, a Slack
   * display name, or `cli`/`cron`. The run's value is the ORIGINAL trigger;
   * retry/cancel/approve actors land on the `executions` ledger, never
   * overwriting this. Free-text, joined to `users` on `login` for enrichment.
   */
  triggeredBy?: string;
  /** Coarse actor category for {@link triggeredBy}. */
  triggerActorType?: TriggerActorType;
  currentPhase: string;
  phaseHistory: PhaseHistoryEntry[];
  status: "queued" | "running" | "paused" | "succeeded" | "failed" | "cancelled";
  context?: Record<string, unknown>;
  /**
   * Mutable phase-to-phase state, merged at the top level by
   * `mergeScratch`. Distinct from `context` (which is the immutable trigger
   * input) — used by features like the socratic explore loop to accumulate
   * Q&A across reply-gate pauses.
   */
  scratch?: Record<string, unknown>;
  /**
   * Number of times `resumeOrphanedWorkflows` has re-dispatched this run
   * after a harness restart. Bounded by a small limit so a run that
   * crashes the host (e.g. agent OOM) is marked failed instead of
   * retried forever.
   */
  restartCount?: number;
  startedAt: string;
  updatedAt: string;
  finishedAt?: string;
  /**
   * The OTel trace this run was exported under (issue #255). A feedback signal
   * can land days after the run's span closed, so remembering where the trace
   * was is the only way to hang the score on the trace it grades rather than a
   * disconnected one. Absent whenever telemetry was disabled during the run.
   */
  traceId?: string;
  /** The `lastlight.workflow.run` span id — the parent a feedback span attaches to. */
  spanId?: string;
  /**
   * Rolled-up totals across the run's executions (SUM of `cost_usd` and
   * input+output+cache-read tokens). Populated only by {@link WorkflowRunStore.list}
   * for the dashboard's runs view via a LEFT JOIN on `executions`; absent on
   * single-run reads (`getRun`, which selects the row without the join).
   */
  totalCostUsd?: number;
  totalTokens?: number;
}

/** A non-agent phase marker folded into an atomic lifecycle op. */
export interface PhaseMarker {
  phase: string;
  summary?: string;
}

/** The row shape the builder returns for this table, before normalization. */
type RunRow = StateTables["workflowRuns"]["$inferSelect"];

/**
 * What {@link WorkflowRunStore.deserialize} accepts.
 *
 * A full row, or `list()`'s deliberately narrower projection — which omits the
 * two multi-MB JSON blobs (and trace/span, which no list consumer reads) and
 * adds the two roll-ups from its `executions` join. Everything the narrow
 * projection drops is therefore optional here.
 */
type RunRowLike = Pick<
  RunRow,
  "id" | "workflowName" | "triggerId" | "currentPhase" | "phaseHistory" | "status" | "startedAt" | "updatedAt"
> &
  Partial<RunRow> & { totalCostUsd?: number; totalTokens?: number };

/**
 * Aggregate root for a workflow run's lifecycle. Owns the `workflow_runs`
 * table (including the `phase_history` JSON column) and the named, atomic
 * transitions a run moves through: create → pause-for-approval →
 * resume/finish, plus gate resolution and the socratic reply append.
 *
 * Carved out of the old `StateDb` god-class (issue #97). The deepening: every
 * multi-step mutation that previously lived as an un-guarded read-modify-write
 * chain in `index.ts` / `admin/routes.ts` / `phase-executor.ts` is now a
 * single named operation wrapped in ONE transaction — a throw partway through
 * rolls the whole thing back, so a run can never be left marked `running` with
 * its gate unresolved (the hazard the issue calls out).
 *
 * Constructed with an injected {@link ApprovalStore}: an approval has no life
 * independent of its run, so the cross-table ops call the approval store's
 * single-table writes from inside this store's transaction, passing the
 * transaction handle as their trailing `dbc` argument. Both stores MUST be
 * built from the same client — a transaction is per-connection.
 *
 * Every op that opens a transaction runs through the injected
 * {@link OpSerializer}, the ONE connection-scoped mutex shared with
 * `TeamStore`: overlapping libsql interactive transactions fail in ways
 * `busy_timeout` cannot help with (it is connection-scoped, and the client
 * swaps connections after each transaction).
 *
 * The long-running re-dispatch (`dispatchWorkflow`, which spawns a Docker
 * sandbox for minutes) is deliberately NOT part of any transaction here. The
 * atomic boundary is the DB mutations only; the caller dispatches after the
 * op returns.
 */
/**
 * Notified once a run reaches a TERMINAL status, whichever path took it there.
 *
 * There are two consumers: the `last-light/review` check run
 * (`src/engine/review-check.ts`) and the GitHub feedback-anchor discovery of
 * issue #255 — which is why observers are a LIST. They were a single slot
 * originally, and a second `setTerminalObserver` call would have silently
 * displaced the review check rather than failing loudly.
 *
 * 09-state-machine.md → S2 found that check
 * being completed inside a `.then()` chained onto an in-memory promise in
 * `dispatcher.ts` — so it stranded `in_progress` on every server restart
 * mid-review (i.e. **every deploy**), every queued-then-resumed run, every
 * `expireStaleRuns` cancellation and every crash. The fix is not routing but
 * DURABILITY: make the check a projection of persisted run state, resolved
 * wherever that state becomes terminal. Hanging the hook here rather than at
 * the eight `finishRun` call sites is what makes `simple.ts`, `resume.ts`,
 * `expireQueued` and the admin cancel all resolve it for free — and what stops
 * a ninth call site being added without one.
 *
 * Contract: **synchronous, never throws, never re-enters the store.** It is
 * called after the row is written (outside any transaction), and an
 * implementation that needs I/O fires it and returns. One observer throwing
 * does not stop the others.
 */
export type TerminalRunObserver = (
  run: WorkflowRun,
  status: "succeeded" | "failed" | "cancelled",
) => void;

/**
 * Match one `owner/repo` against a `workflow_runs` row, in SQL.
 *
 * Exists because callers filter by the qualified name while the table stores
 * the pair — `owner` + a BARE `repo` (see `state/repo-ref.ts`). That is the
 * rule, and `owner = ? AND repo = ?` is it. A bare filter value has no owner to
 * split off, so it matches `repo` alone.
 *
 * The trailing `OR repo = ?` is **legacy-row handling, not the rule** (issue
 * #279). Rows written before the backfill put the qualified string in `repo`
 * itself; the migration converges them and both write choke points keep new
 * ones honest, so this arm should match nothing on a migrated DB. It is kept
 * because a `SELECT` is not the place to discover that a backfill didn't run,
 * and because dropping a row from a filter is the failure mode that hides
 * things silently.
 */
function repoMatchClause({ workflowRuns }: StateTables, repo: string): SQL {
  const slash = repo.indexOf("/");
  if (slash > 0) {
    return or(
      and(
        eq(workflowRuns.owner, repo.slice(0, slash)),
        eq(workflowRuns.repo, repo.slice(slash + 1)),
      ),
      eq(workflowRuns.repo, repo),
    ) as SQL;
  }
  return eq(workflowRuns.repo, repo);
}

export class WorkflowRunStore {
  private approvals: ApprovalStore;
  private serialize: OpSerializer;
  private terminalObservers: TerminalRunObserver[] = [];

  /**
   * Table objects for THIS client's dialect. Every method destructures what it
   * needs off this instead of importing from `schema/sqlite.js` — see
   * `client.ts` → {@link tablesOf} for why the cast alone cannot do it.
   */
  private readonly t: StateTables;

  constructor(
    private client: StateClient,
    deps: { approvals: ApprovalStore; serialize: OpSerializer },
  ) {
    this.approvals = deps.approvals;
    this.serialize = deps.serialize;
    this.t = tablesOf(client);
  }

  /** Add a {@link TerminalRunObserver}. Wired at boot; order is registration order. */
  addTerminalObserver(fn: TerminalRunObserver): void {
    this.terminalObservers.push(fn);
  }

  /**
   * Fire the terminal observers for a row that has just been written. Swallows
   * everything, per observer: a terminal transition is already persisted by the
   * time we get here, no projection of it may undo that, and one projection
   * failing must not cost the others their notification.
   */
  private async notifyTerminal(
    id: string,
    status: "succeeded" | "failed" | "cancelled",
  ): Promise<void> {
    if (this.terminalObservers.length === 0) return;
    let run: WorkflowRun | null = null;
    try {
      run = await this.getRun(id);
    } catch (err: unknown) {
      log.warn("Could not read a terminal run for its observers", { runId: id, err });
      return;
    }
    if (!run) return;
    for (const observe of this.terminalObservers) {
      try {
        observe(run, status);
      } catch (err: unknown) {
        log.warn("Terminal observer failed", { runId: id, err });
      }
    }
  }

  /**
   * Read a run's `context` object for an app-side read-modify-write.
   *
   * The three context mutations in this store — the error annotation in
   * {@link expireQueued} and {@link flipFinished}, the error clear in
   * {@link restartRun} — used to be `json_patch` / `json_remove` SQL, which
   * Postgres has no equivalent for. `context` is a json-mode column, so the
   * builder hands the object over and takes one back and the merge is plain JS.
   * A missing row (or a NULL column) reads as `{}`, exactly what the
   * `COALESCE(context, '{}')` those statements opened with produced.
   */
  private async readContext(
    id: string,
    dbc: StateDbc = this.client,
  ): Promise<Record<string, unknown>> {
    const { workflowRuns } = this.t;
    const [row] = await dbc
      .select({ context: workflowRuns.context })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, id))
      .limit(1);
    return { ...(row?.context ?? {}) };
  }

  // ── Plain single-mutation operations ───────────────────────────

  /**
   * Create a new workflow run record.
   *
   * The (owner, BARE repo) invariant is enforced HERE rather than asked of
   * callers (issue #279) — a fixture, an eval harness or a future caller
   * passing `"owner/repo"` is split rather than stored as a third shape. See
   * `state/repo-ref.ts`.
   */
  async createRun(run: Omit<WorkflowRun, "phaseHistory" | "updatedAt">): Promise<void> {
    const { workflowRuns } = this.t;
    const now = new Date().toISOString();
    const ref = normalizeRepoRef(run.owner, run.repo);
    // `context` / `scratch` / `phase_history` are json-mode columns: hand them
    // the OBJECT. Pre-stringifying would double-encode, silently.
    await this.client.insert(workflowRuns).values({
      id: run.id,
      workflowName: run.workflowName,
      triggerId: run.triggerId,
      owner: ref.owner ?? null,
      repo: ref.repo ?? null,
      issueNumber: run.issueNumber ?? null,
      currentPhase: run.currentPhase,
      phaseHistory: [],
      status: run.status,
      context: run.context ?? null,
      scratch: run.scratch ?? null,
      startedAt: run.startedAt,
      updatedAt: now,
      triggeredBy: run.triggeredBy ?? null,
      triggerActorType: run.triggerActorType ?? null,
    });
  }

  /**
   * Top-level merge of `patch` into the workflow run's scratch state.
   * Loop iterations can append to `scratch.socratic.qa` without clobbering
   * other keys.
   *
   * Throws if `patch` is not JSON-serializable (e.g. it contains a BigInt) —
   * which is exactly how the atomic ops prove their rollback: Drizzle
   * serializes the json-mode column when it executes the UPDATE, so a poison
   * patch throws from the statement itself, before it has mutated anything.
   */
  async mergeScratch(
    id: string,
    patch: Record<string, unknown>,
    dbc: StateDbc = this.client,
  ): Promise<void> {
    const { workflowRuns } = this.t;
    const now = new Date().toISOString();
    const [row] = await dbc
      .select({ scratch: workflowRuns.scratch })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, id))
      .limit(1);
    if (!row) return;
    const merged = { ...(row.scratch ?? {}), ...patch };
    await dbc
      .update(workflowRuns)
      .set({ scratch: merged, updatedAt: now })
      .where(eq(workflowRuns.id, id));
  }

  /**
   * Remember which OTel trace this run is being exported under (issue #255).
   *
   * Deliberately NOT touching `updated_at`: this is bookkeeping about the run,
   * not activity on it, and the liveness checks that read `updated_at` would
   * otherwise see a heartbeat the run never produced.
   *
   * Write-once in practice (the run span opens exactly once), and harmless if
   * repeated — a resume re-opens a span under a new trace, and the newest trace
   * is the right one for a signal arriving now.
   */
  async setTraceContext(id: string, traceId: string, spanId: string): Promise<void> {
    const { workflowRuns } = this.t;
    await this.client
      .update(workflowRuns)
      .set({ traceId, spanId })
      .where(eq(workflowRuns.id, id));
  }

  /**
   * Update the current phase and append to phase history. This is the single
   * seam through which all phase-history writes flow (issue #97 defers the
   * full `phase_history`/`executions` reconciliation to a follow-up, but
   * routes every write through here so that future change touches one method
   * instead of ~10 call sites).
   */
  async appendPhase(
    id: string,
    phase: string,
    entry: PhaseHistoryEntry,
    dbc: StateDbc = this.client,
  ): Promise<void> {
    const { workflowRuns } = this.t;
    const now = new Date().toISOString();
    const [row] = await dbc
      .select({ phaseHistory: workflowRuns.phaseHistory })
      .from(workflowRuns)
      .where(eq(workflowRuns.id, id))
      .limit(1);
    if (!row) return;
    const history: PhaseHistoryEntry[] = [...row.phaseHistory, entry];
    await dbc
      .update(workflowRuns)
      .set({ currentPhase: phase, phaseHistory: history, updatedAt: now })
      .where(eq(workflowRuns.id, id));
  }

  /** Get a single workflow run by ID */
  async getRun(id: string, dbc: StateDbc = this.client): Promise<WorkflowRun | null> {
    const { workflowRuns } = this.t;
    const [row] = await dbc
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.id, id))
      .limit(1);
    return row ? this.deserialize(row) : null;
  }

  /** Find the most recent active (running, paused, or queued) workflow run for a trigger */
  async getByTrigger(triggerId: string): Promise<WorkflowRun | null> {
    const { workflowRuns } = this.t;
    const [row] = await this.client
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.triggerId, triggerId),
          inArray(workflowRuns.status, ["queued", "running", "paused"]),
        ),
      )
      .orderBy(desc(workflowRuns.startedAt))
      .limit(1);
    return row ? this.deserialize(row) : null;
  }

  /**
   * True if any run of `workflowName` exists for this trigger, in ANY status.
   * Unlike `getByTrigger` (active runs only), this also sees a build that has
   * already succeeded/failed/cancelled — the signal the router uses to gate
   * reporter-driven re-triage to the pre-build window.
   */
  async hasRunForTrigger(triggerId: string, workflowName: string): Promise<boolean> {
    const { workflowRuns } = this.t;
    const [row] = await this.client
      .select({ id: workflowRuns.id })
      .from(workflowRuns)
      .where(
        and(eq(workflowRuns.triggerId, triggerId), eq(workflowRuns.workflowName, workflowName)),
      )
      .limit(1);
    return !!row;
  }

  /**
   * The most recent SUCCEEDED run of `workflowName` for this trigger, or null.
   * Unlike `getByTrigger` (active rows only), this reads terminal history: the
   * dependency-workflow dedup guard reads the winner's stored `context.headSha`
   * to skip re-assessing a PR at a head SHA it already handled.
   */
  async latestSucceededForTrigger(
    workflowName: string,
    triggerId: string,
  ): Promise<WorkflowRun | null> {
    const { workflowRuns } = this.t;
    const [row] = await this.client
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.triggerId, triggerId),
          eq(workflowRuns.workflowName, workflowName),
          eq(workflowRuns.status, "succeeded"),
        ),
      )
      .orderBy(desc(workflowRuns.startedAt))
      .limit(1);
    return row ? this.deserialize(row) : null;
  }

  /**
   * The most recent run for this trigger belonging to ANY of `workflowNames`,
   * in ANY status.
   *
   * Two things distinguish it from {@link latestSucceededForTrigger}:
   *
   * 1. **It keys on a FAMILY, not one workflow.** "How many times have we tried
   *    to fix this PR, and what did we try" is a fact about the pull request;
   *    which of `pr-fix` / `dependabot-ci-fix` happened to run is an
   *    implementation detail of how the event arrived — and routing genuinely
   *    varies (an `@bot fix this` comment on a red Dependabot PR is an LLM
   *    decision that can land on either). Under (workflow, PR) keying that PR
   *    would get a second, empty attempt counter: attempt resets to 1,
   *    `{{priorAttempts}}` renders blank, and the budget silently doubles.
   *    See 09-state-machine.md → S1 ("Identity").
   * 2. **It does not filter on success.** A crashed run has to be VISIBLE, so
   *    the caller can decide it consumed no attempt. Filtering it out here
   *    would make a crash look like "no prior attempt" and re-arm the loop
   *    from zero.
   */
  async latestForTrigger(
    workflowNames: string[],
    triggerId: string,
  ): Promise<WorkflowRun | null> {
    const { workflowRuns } = this.t;
    if (workflowNames.length === 0) return null;
    const [row] = await this.client
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.triggerId, triggerId),
          inArray(workflowRuns.workflowName, workflowNames),
        ),
      )
      .orderBy(desc(workflowRuns.startedAt))
      .limit(1);
    return row ? this.deserialize(row) : null;
  }

  /**
   * The oldest still-live (queued / running / paused) run for this trigger
   * among `workflowNames` — the PR-scoped run lock (09-state-machine.md → S4).
   *
   * Oldest-first deliberately: the answer to "who holds the lock" must be the
   * incumbent, not whichever row sorted last.
   *
   * `paused` counts. A paused run still owns its sandbox workspace, and the fix
   * family now SHARES one workspace per PR — letting a second workflow in
   * would have two agents fetch/reset/push the same branch through the same
   * directory.
   */
  async activeForTrigger(
    workflowNames: string[],
    triggerId: string,
  ): Promise<WorkflowRun | null> {
    const { workflowRuns } = this.t;
    if (workflowNames.length === 0) return null;
    const [row] = await this.client
      .select()
      .from(workflowRuns)
      .where(
        and(
          eq(workflowRuns.triggerId, triggerId),
          inArray(workflowRuns.workflowName, workflowNames),
          inArray(workflowRuns.status, ["queued", "running", "paused"]),
        ),
      )
      .orderBy(asc(workflowRuns.startedAt))
      .limit(1);
    return row ? this.deserialize(row) : null;
  }

  /**
   * The most recent SUCCEEDED run of EACH of `workflowNames` for this trigger,
   * keyed by workflow name. Absent keys mean "never succeeded here".
   *
   * Feeds the "already assessed at this head SHA" dedup, which is per-workflow
   * on purpose even though the fix ATTEMPT counter is per-family: `pr-fix`
   * having succeeded at a SHA says nothing about whether `dependabot-pr-merge`
   * has assessed it. One small indexed lookup per name — the set is four.
   */
  async latestSucceededForTriggers(
    workflowNames: string[],
    triggerId: string,
  ): Promise<Record<string, WorkflowRun>> {
    const out: Record<string, WorkflowRun> = {};
    for (const name of workflowNames) {
      const run = await this.latestSucceededForTrigger(name, triggerId);
      if (run) out[name] = run;
    }
    return out;
  }

  /** List all active (queued, running, or paused) workflow runs */
  async listActive(): Promise<WorkflowRun[]> {
    const { workflowRuns } = this.t;
    const rows = await this.client
      .select()
      .from(workflowRuns)
      .where(inArray(workflowRuns.status, ["queued", "running", "paused"]))
      .orderBy(desc(workflowRuns.startedAt));
    return rows.map((r) => this.deserialize(r));
  }

  /** List recent workflow runs, ordered by start time descending */
  async listRecent(limit = 20): Promise<WorkflowRun[]> {
    const { workflowRuns } = this.t;
    const rows = await this.client
      .select()
      .from(workflowRuns)
      .orderBy(desc(workflowRuns.startedAt))
      .limit(limit);
    return rows.map((r) => this.deserialize(r));
  }

  /**
   * List workflow runs with pagination + filters. Returns the page slice
   * AND the post-filter total so the dashboard knows how many remain.
   *
   * - sinceIso filters `started_at >= sinceIso` (used for the header date range).
   * - workflowName filters by exact `workflow_name`.
   * - statuses filters to one of the workflow statuses (`running`, `paused`,
   *   `succeeded`, `failed`, `cancelled`). Used for the dashboard's "live"
   *   filter, which maps to ['running','paused'].
   */
  async list(
    opts: {
      limit?: number;
      offset?: number;
      sinceIso?: string;
      workflowName?: string;
      repo?: string;
      /**
       * Restrict to a SET of repos — the dashboard's per-repo visibility scope
       * (issue #169), where a user's GitHub teams resolve to several repos at
       * once. Plural sibling of `repo`, matched with the same both-shapes rule;
       * an empty array means "no rows", which the caller must avoid by not
       * passing it. Ignored when `repo` is also set (the single-repo Repos tab
       * is the narrower ask).
       */
      repos?: string[];
      statuses?: string[];
    } = {},
  ): Promise<{ runs: WorkflowRun[]; total: number }> {
    const { workflowRuns, executions } = this.t;
    const limit = opts.limit ?? 20;
    const offset = opts.offset ?? 0;

    const where: SQL[] = [];
    if (opts.sinceIso) where.push(gte(workflowRuns.startedAt, opts.sinceIso));
    if (opts.workflowName) where.push(eq(workflowRuns.workflowName, opts.workflowName));
    if (opts.repo) {
      where.push(repoMatchClause(this.t, opts.repo));
    } else if (opts.repos && opts.repos.length > 0) {
      // OR the per-repo clauses. Not an `IN (...)`, because the column doesn't
      // hold the value being matched — see `repoMatchClause`.
      where.push(or(...opts.repos.map((r) => repoMatchClause(this.t, r))) as SQL);
    }
    if (opts.statuses && opts.statuses.length > 0) {
      where.push(inArray(workflowRuns.status, opts.statuses));
    }
    const whereClause = where.length > 0 ? and(...where) : undefined;

    const [counted] = await this.client
      .select({ c: count() })
      .from(workflowRuns)
      .where(whereClause);
    const total = counted?.c ?? 0;

    // A per-run token/cost roll-up, LEFT JOINed (indexed by
    // `idx_executions_workflow_run`). `agg` only exposes `workflow_run_id` +
    // the two sums, so nothing here collides with `workflow_runs`.
    const agg = this.client
      .select({
        workflowRunId: executions.workflowRunId,
        totalCostUsd: sql<number>`SUM(COALESCE(${executions.costUsd}, 0))`.as("total_cost_usd"),
        totalTokens: sql<number>`SUM(COALESCE(${executions.inputTokens}, 0)
                      + COALESCE(${executions.outputTokens}, 0)
                      + COALESCE(${executions.cacheReadInputTokens}, 0))`.as("total_tokens"),
      })
      .from(executions)
      .where(isNotNull(executions.workflowRunId))
      .groupBy(executions.workflowRunId)
      .as("agg");

    // Explicit column list — the heavy JSON blobs (`context`, `scratch`)
    // can each be many MB on long-running build runs and
    // the dashboard list view doesn't read them. Returning them turned a
    // 20-row page into a 14MB payload. The single-row endpoint
    // (`getRun`) still selects the whole row so the detail panel keeps
    // it when the user picks one.
    const rows = await this.client
      .select({
        id: workflowRuns.id,
        workflowName: workflowRuns.workflowName,
        triggerId: workflowRuns.triggerId,
        owner: workflowRuns.owner,
        repo: workflowRuns.repo,
        issueNumber: workflowRuns.issueNumber,
        currentPhase: workflowRuns.currentPhase,
        phaseHistory: workflowRuns.phaseHistory,
        status: workflowRuns.status,
        restartCount: workflowRuns.restartCount,
        startedAt: workflowRuns.startedAt,
        updatedAt: workflowRuns.updatedAt,
        finishedAt: workflowRuns.finishedAt,
        triggeredBy: workflowRuns.triggeredBy,
        triggerActorType: workflowRuns.triggerActorType,
        totalCostUsd: sql<number>`COALESCE(${agg.totalCostUsd}, 0)`,
        totalTokens: sql<number>`COALESCE(${agg.totalTokens}, 0)`,
      })
      .from(workflowRuns)
      .leftJoin(agg, eq(agg.workflowRunId, workflowRuns.id))
      .where(whereClause)
      .orderBy(ACTIVE_FIRST(this.t), desc(workflowRuns.startedAt))
      .limit(limit)
      .offset(offset);

    return {
      runs: rows.map((r) => this.deserialize(r)),
      total,
    };
  }

  /**
   * Count workflow runs with status 'running'. Excludes 'queued' and 'paused'
   * since those are not holding a sandbox slot. Used by the concurrency cap
   * (issue #172) to decide whether to queue a fresh run.
   */
  async countRunning(): Promise<number> {
    const { workflowRuns } = this.t;
    const [row] = await this.client
      .select({ c: count() })
      .from(workflowRuns)
      .where(eq(workflowRuns.status, "running"));
    return row?.c ?? 0;
  }

  /**
   * List all queued runs ordered by started_at ascending (FIFO enqueue order).
   * Used by the admission controller to pick the next run to promote and to
   * perform TTL expiry.
   */
  async listQueued(): Promise<WorkflowRun[]> {
    const { workflowRuns } = this.t;
    const rows = await this.client
      .select()
      .from(workflowRuns)
      .where(eq(workflowRuns.status, "queued"))
      .orderBy(asc(workflowRuns.startedAt));
    return rows.map((r) => this.deserialize(r));
  }

  /**
   * CAS: transition a queued run to running. Returns the number of rows changed
   * (1 = winner, 0 = already admitted or run not found). The guard
   * `WHERE status = 'queued'` prevents double-admission when the event-driven
   * and periodic paths race.
   *
   * Does NOT touch started_at or restart_count — those stay at their enqueue
   * values so TTL sweep can detect staleness and dashboards show enqueue time.
   */
  async admitRun(id: string): Promise<number> {
    const { workflowRuns } = this.t;
    const now = new Date().toISOString();
    const result = await this.client
      .update(workflowRuns)
      .set({ status: "running", updatedAt: now })
      .where(and(eq(workflowRuns.id, id), eq(workflowRuns.status, "queued")));
    return changes(result);
  }

  /**
   * CAS: transition a queued run to cancelled, recording the reason in
   * context.error. Returns the number of rows changed (1 on success, 0 if the
   * run was no longer queued). Used by the TTL sweep in the admission
   * controller to drop stale queued runs.
   *
   * The context annotation is an app-side read-modify-write (see
   * {@link readContext}), but the write still carries the whole compare-and-set
   * in its own `WHERE`, so the rows-affected count keeps its exact meaning. The
   * read cannot go stale underneath it either: nothing else writes the context
   * of a run that is still `queued`, and a run that stopped being queued loses
   * the CAS.
   */
  async expireQueued(id: string, reason: string): Promise<number> {
    const { workflowRuns } = this.t;
    const now = new Date().toISOString();
    const context = { ...(await this.readContext(id)), error: reason };
    const changed = changes(
      await this.client
        .update(workflowRuns)
        .set({ status: "cancelled", finishedAt: now, updatedAt: now, context })
        .where(and(eq(workflowRuns.id, id), eq(workflowRuns.status, "queued"))),
    );
    // A queued run that expires never ran a phase, but it may already own a
    // `last-light/review` check — the whole point of hanging the projection off
    // the terminal transition is that this path resolves it for free.
    if (changed === 1) await this.notifyTerminal(id, "cancelled");
    return changed;
  }

  /** Distinct workflow_name values, sorted alphabetically. */
  async distinctNames(): Promise<string[]> {
    const { workflowRuns } = this.t;
    const rows = await this.client
      .selectDistinct({ workflowName: workflowRuns.workflowName })
      .from(workflowRuns)
      .orderBy(asc(workflowRuns.workflowName));
    return rows.map((r) => r.workflowName);
  }

  /**
   * Per-repo run activity — one row per distinct `owner/repo`, with the run
   * count and the most-recent `started_at`. Powers the dashboard's Repos tab,
   * which annotates the managed-repo list with recent activity and sorts by it.
   * Ordered newest-activity first.
   *
   * The `repo` key is the QUALIFIED `owner/repo` (owner-less rows fall back to
   * the bare name) so it aligns with `getManagedRepos()` and the artifact-store
   * slugs the `/repos` endpoint unions it against — without this a repo splits
   * into two rows (bare-with-runs vs qualified-managed-with-zero).
   *
   * That join is the one in `state/repo-ref.ts`, expressed in SQL so it groups
   * correctly: two rows for the same repo that disagree about shape collapse
   * into one bucket here rather than after the fact.
   */
  async distinctRepos(): Promise<{ repo: string; runCount: number; lastRunAt: string }[]> {
    const { workflowRuns } = this.t;
    const qualified = qualifiedRepoSql(workflowRuns.owner, workflowRuns.repo, "bare");
    const lastRunAt = sql<string>`MAX(${workflowRuns.startedAt})`;
    return this.client
      .select({ repo: sql<string>`${qualified}`, runCount: count(), lastRunAt })
      .from(workflowRuns)
      .where(and(isNotNull(workflowRuns.repo), ne(workflowRuns.repo, "")))
      .groupBy(qualified)
      .orderBy(desc(lastRunAt));
  }

  /**
   * What Last Light did for ONE repo since `sinceIso` — a count per
   * (workflow, status) pair. The bot half of the weekly digest.
   *
   * Grouped in SQL rather than fetched-and-counted because a busy repo's week
   * is hundreds of rows and the digest wants six numbers. Filtered on the
   * QUALIFIED repo for the same reason `distinctRepos` groups on it: rows
   * written before the owner/repo backfill carry `owner/repo` in the repo
   * column, and a bare-name filter silently misses every one of them.
   */
  async summarizeRepoActivity(
    owner: string,
    repo: string,
    sinceIso: string,
  ): Promise<{ workflowName: string; status: string; count: number }[]> {
    const { workflowRuns } = this.t;
    const qualified = qualifiedRepoSql(workflowRuns.owner, workflowRuns.repo, "bare");
    return this.client
      .select({
        workflowName: workflowRuns.workflowName,
        status: workflowRuns.status,
        count: count(),
      })
      .from(workflowRuns)
      .where(and(eq(qualified, `${owner}/${repo}`), gte(workflowRuns.startedAt, sinceIso)))
      .groupBy(workflowRuns.workflowName, workflowRuns.status);
  }

  /**
   * Mark a workflow run as finished. Plain status flip when called with
   * neither an `error` nor a `terminalMarker`; with either, the work spans two
   * statements — the phase-history append and/or the `context.error`
   * read-modify-write, plus the status flip — so it runs in ONE transaction
   * and the dashboard never sees the terminal phase without the finished
   * status, or vice versa.
   */
  async finishRun(
    id: string,
    status: "succeeded" | "failed" | "cancelled",
    opts: { error?: string; terminalMarker?: PhaseMarker } = {},
  ): Promise<void> {
    const apply = async (dbc: StateDbc): Promise<void> => {
      if (opts.terminalMarker) {
        await this.appendPhase(
          id,
          opts.terminalMarker.phase,
          {
            phase: opts.terminalMarker.phase,
            timestamp: new Date().toISOString(),
            success: true,
            summary: opts.terminalMarker.summary,
          },
          dbc,
        );
      }
      await this.flipFinished(id, status, opts.error, dbc);
    };
    if (opts.terminalMarker || opts.error !== undefined) {
      await this.serialize(() => this.client.transaction(async (tx) => apply(tx)));
    } else {
      await apply(this.client);
    }
    // AFTER the transaction commits — the observer reads the row back.
    await this.notifyTerminal(id, status);
  }

  private async flipFinished(
    id: string,
    status: "succeeded" | "failed" | "cancelled",
    error?: string,
    dbc: StateDbc = this.client,
  ): Promise<void> {
    const { workflowRuns } = this.t;
    const now = new Date().toISOString();
    const patch: Partial<StateTables["workflowRuns"]["$inferInsert"]> = {
      status,
      finishedAt: now,
      updatedAt: now,
    };
    // Only annotate the context when there is an error to record — the SQL this
    // replaces expressed that as `CASE WHEN ? IS NOT NULL`, leaving the column
    // untouched otherwise.
    if (error !== undefined) patch.context = { ...(await this.readContext(id, dbc)), error };
    await dbc.update(workflowRuns).set(patch).where(eq(workflowRuns.id, id));
  }

  /** Cancel a workflow run */
  async cancelRun(id: string): Promise<void> {
    const { workflowRuns } = this.t;
    const now = new Date().toISOString();
    await this.client
      .update(workflowRuns)
      .set({ status: "cancelled", updatedAt: now, finishedAt: now })
      .where(eq(workflowRuns.id, id));
    await this.notifyTerminal(id, "cancelled");
  }

  /** Pause a workflow run (waiting for approval) */
  async setPaused(id: string, dbc: StateDbc = this.client): Promise<void> {
    const { workflowRuns } = this.t;
    const now = new Date().toISOString();
    await dbc
      .update(workflowRuns)
      .set({ status: "paused", updatedAt: now })
      .where(eq(workflowRuns.id, id));
  }

  /** Resume a paused workflow run (set back to running) */
  async setRunning(id: string, dbc: StateDbc = this.client): Promise<void> {
    const { workflowRuns } = this.t;
    const now = new Date().toISOString();
    await dbc
      .update(workflowRuns)
      .set({ status: "running", updatedAt: now })
      .where(eq(workflowRuns.id, id));
  }

  /**
   * Restart a FAILED or CANCELLED run so it can be retried from where it
   * stopped. Unlike {@link setRunning} this also clears the terminal markers the
   * stop left behind — `finished_at` and the `context.error` string
   * (`flipFinished` / `expireQueued` wrote it) — so the row reads live again
   * rather than "failed at …" / "dropped from queue …". The taskId, branch,
   * scratch and phase_history are all preserved, so the ledger-driven
   * re-dispatch (`resumeSimpleRun`) resumes from the stopped phase with the same
   * context; a queue-dropped `cancelled` run ran no phases, so it starts clean.
   *
   * `cancelled` is retryable because it covers two recoverable cases — a run
   * TTL-dropped from the queue after a server death, and a manual dashboard
   * cancel — neither of which is a permanent verdict. Guarded by
   * `WHERE status IN ('failed','cancelled')` and returns the changed-row count
   * so the caller can make retry a compare-and-set: a second concurrent retry
   * click sees 0 rows changed and does NOT dispatch again.
   *
   * Clearing the error is an app-side read-modify-write now (see
   * {@link readContext}); the CAS still rides on this one UPDATE, and a run in a
   * terminal status has no other writer to race the read against.
   */
  async restartRun(id: string): Promise<number> {
    const { workflowRuns } = this.t;
    const now = new Date().toISOString();
    const context = await this.readContext(id);
    delete context.error;
    const result = await this.client
      .update(workflowRuns)
      .set({
        status: "running",
        finishedAt: null,
        updatedAt: now,
        restartCount: sql`COALESCE(${workflowRuns.restartCount}, 0) + 1`,
        context,
      })
      .where(
        and(eq(workflowRuns.id, id), inArray(workflowRuns.status, ["failed", "cancelled"])),
      );
    return changes(result);
  }

  /**
   * Refresh a QUEUED run's enqueue clock to now. Used by boot recovery: a run
   * that was `queued` when the harness died carries a stale `started_at`, so the
   * admission TTL sweep would immediately expire it to `cancelled` on the next
   * tick instead of admitting it. Re-stamping the clock gives it a fresh
   * `maxQueueWaitMs` window so the AdmissionController admits it normally as
   * slots free. CAS-guarded on `status = 'queued'`; returns rows changed.
   */
  async requeue(id: string): Promise<number> {
    const { workflowRuns } = this.t;
    const now = new Date().toISOString();
    const result = await this.client
      .update(workflowRuns)
      .set({ startedAt: now, updatedAt: now })
      .where(and(eq(workflowRuns.id, id), eq(workflowRuns.status, "queued")));
    return changes(result);
  }

  /**
   * Backpressure requeue: flip a RUNNING run back to `queued` and re-stamp its
   * enqueue clock. Used by the k8s backend when a pod-create is rejected by the
   * namespace `ResourceQuota` (spec/09-sandbox.md (Concurrency)) — the run isn't failed, it's waiting
   * for capacity, and the AdmissionController promotes it again as slots free.
   * Re-stamping `started_at` gives it a fresh `maxQueueWaitMs` window so the TTL
   * sweep doesn't instantly expire a run that had been running for a while.
   * CAS-guarded on `status = 'running'`; returns rows changed (0 = safe no-op,
   * e.g. the run already finished or was cancelled between phases).
   */
  async requeueRunning(id: string): Promise<number> {
    const { workflowRuns } = this.t;
    const now = new Date().toISOString();
    const result = await this.client
      .update(workflowRuns)
      .set({ status: "queued", startedAt: now, updatedAt: now })
      .where(and(eq(workflowRuns.id, id), eq(workflowRuns.status, "running")));
    return changes(result);
  }

  /**
   * Increment the restart counter and return the new value. Used by
   * `resumeOrphanedWorkflows` to enforce a retry budget so a run that
   * crashes the host (agent OOM, etc.) eventually self-terminates instead
   * of being re-dispatched on every boot.
   */
  async incrementRestartCount(id: string): Promise<number> {
    const { workflowRuns } = this.t;
    const now = new Date().toISOString();
    // RETURNING collapses the old update-then-select pair into one statement —
    // and one round trip — while keeping the read of the value this call wrote.
    const [row] = await this.client
      .update(workflowRuns)
      .set({
        restartCount: sql`COALESCE(${workflowRuns.restartCount}, 0) + 1`,
        updatedAt: now,
      })
      .where(eq(workflowRuns.id, id))
      .returning({ restartCount: workflowRuns.restartCount });
    return row?.restartCount ?? 0;
  }

  private deserialize(row: RunRowLike): WorkflowRun {
    // Builder rows are camelCase, the json-mode columns arrive as real objects
    // and arrays, and `nullsToUndefined` turns the nullable columns into the
    // absent optionals `WorkflowRun` declares.
    const r = nullsToUndefined(row);
    // The compatibility shim for the (owner, BARE repo) invariant (issue #279).
    // The backfill converges stored rows and `createRun` keeps new ones honest,
    // so this only ever fires for a row written by an older process before the
    // migration ran — but it fires at the ONE boundary every consumer crosses,
    // which is what lets `admission.ts` and `feedback-poll.ts` hand
    // `(run.owner, run.repo)` straight to Octokit with no split of their own.
    const ref = normalizeRepoRef(r.owner, r.repo);
    return {
      ...r,
      owner: ref.owner,
      repo: ref.repo,
      status: r.status as WorkflowRun["status"],
      triggerActorType: r.triggerActorType as TriggerActorType | undefined,
      restartCount: r.restartCount ?? 0,
      // `totalCostUsd` / `totalTokens` are present only on `list()` rows (the
      // executions JOIN) and absent everywhere else — the spread carries both.
    };
  }

  // ── Named atomic lifecycle operations ──────────────────────────
  //
  // Each wraps ONE transaction, taken through the connection-scoped
  // {@link OpSerializer} so two of them (or one of TeamStore's) cannot
  // interleave on the shared client. The long-running re-dispatch
  // (`dispatchWorkflow`) stays OUT of these — the caller dispatches after the
  // op returns.

  /**
   * Resolve a socratic reply gate and resume the run, atomically: the reply
   * gate flips `pending → approved` (recording the reply text), the caller's
   * scratch patch merges in, and the run goes back to `running` — all in one
   * transaction. A throw anywhere rolls the whole thing back, so the run can
   * never be left `running` with its gate unresolved or its reply lost (the
   * hazard issue #97 calls out).
   *
   * The reply-gate resolve is guarded by `kind = 'reply' AND status = 'pending'`
   * (see {@link ApprovalStore.resolveReplyGate}); if it changes zero rows —
   * because a racing reply already resolved the gate — this throws and the
   * transaction aborts, which is the double-reply concurrency guard.
   *
   * The caller (`index.ts`) computes the explore-domain `scratch.socratic.qa`
   * patch and passes it in; the generic store stays ignorant of that shape.
   */
  /**
   * Pause a run for an approval gate, atomically: create the pending approval,
   * optionally merge a scratch patch (loops persist their iteration state
   * here), append the `waiting_approval` phase marker, and flip the run to
   * `paused` — all in one transaction. Covers the standard post-phase gate,
   * the reviewer-loop gate, and the interactive generic-loop gate.
   *
   * The marker is appended BEFORE the approval insert so that an insert
   * failure provably rolls back the phase-history write (the injected
   * ApprovalStore participates in the same transaction); ordering is invisible
   * outside the transaction.
   */
  async pauseForApproval(
    runId: string,
    approval: Parameters<ApprovalStore["create"]>[0],
    marker: PhaseMarker,
    scratchPatch?: Record<string, unknown>,
  ): Promise<void> {
    await this.serialize(() =>
      this.client.transaction(async (tx) => {
        await this.appendPhase(
          runId,
          marker.phase,
          {
            phase: marker.phase,
            timestamp: new Date().toISOString(),
            success: true,
            summary: marker.summary,
          },
          tx,
        );
        if (scratchPatch) await this.mergeScratch(runId, scratchPatch, tx);
        await this.approvals.create(approval, tx);
        await this.setPaused(runId, tx);
      }),
    );
  }

  /**
   * Approve a gate and resume its run, atomically. Reads the approval to find
   * its run, records the `approved` response, and flips the run back to
   * `running` in one transaction; returns the run so the caller can dispatch.
   * Used by the GitHub/Slack path (`index.ts`), which validates the dispatch
   * target BEFORE calling this so the flip to `running` is always followed by a
   * dispatch. The dashboard path does NOT use this — it can't prove a dispatch
   * will follow before responding, so it records the approval and lets
   * `resumeWorkflow` flip the run only as part of an actual dispatch.
   */
  async resolveGateAndResume(
    approvalId: string,
    responder: string,
  ): Promise<WorkflowRun | null> {
    return this.serialize(() =>
      this.client.transaction(async (tx) => {
        const approval = await this.approvals.getById(approvalId, tx);
        if (!approval) throw new Error(`approval ${approvalId} not found`);
        const changed = await this.approvals.respond(approvalId, "approved", responder, undefined, tx);
        if (changed !== 1) {
          throw new Error(`approval ${approvalId} is not pending (already resolved?)`);
        }
        await this.setRunning(approval.workflowRunId, tx);
        return this.getRun(approval.workflowRunId, tx);
      }),
    );
  }

  /**
   * Reject a gate and fail its run, atomically: record the `rejected` response
   * (with reason) and flip the run to `failed` in one transaction. Returns the
   * run (or null if the approval's run was already gone).
   */
  async resolveGateAndFail(
    approvalId: string,
    responder: string,
    reason?: string,
  ): Promise<WorkflowRun | null> {
    return this.serialize(() =>
      this.client.transaction(async (tx) => {
        const approval = await this.approvals.getById(approvalId, tx);
        if (!approval) throw new Error(`approval ${approvalId} not found`);
        const changed = await this.approvals.respond(approvalId, "rejected", responder, reason, tx);
        if (changed !== 1) {
          throw new Error(`approval ${approvalId} is not pending (already resolved?)`);
        }
        await this.flipFinished(
          approval.workflowRunId,
          "failed",
          `Rejected: ${reason || "no reason given"}`,
          tx,
        );
        return this.getRun(approval.workflowRunId, tx);
      }),
    );
  }

  async resolveReplyGateAndResume(
    runId: string,
    approvalId: string,
    replyText: string,
    responder: string,
    scratchPatch: Record<string, unknown>,
  ): Promise<WorkflowRun | null> {
    return this.serialize(() =>
      this.client.transaction(async (tx) => {
        const changed = await this.approvals.resolveReplyGate(approvalId, replyText, responder, tx);
        if (changed !== 1) {
          throw new Error(`reply gate ${approvalId} is not pending (already resolved?)`);
        }
        await this.mergeScratch(runId, scratchPatch, tx);
        await this.setRunning(runId, tx);
        return this.getRun(runId, tx);
      }),
    );
  }
}

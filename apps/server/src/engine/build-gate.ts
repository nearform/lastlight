/**
 * The BUILD dispatch gate — the IMPURE half of `./build-decisions.ts`.
 *
 * `resolveBuildTrigger` is a pure function over one resolved input record. This
 * module is what stands between it and the world: it RESOLVES those inputs from
 * the config and the state DB, logs the verdict, and applies the one consequence
 * that belongs to the DECISION rather than to the route. Nothing here re-decides
 * anything — every branch of the policy lives in the pure function, and a second
 * copy of any of it here is the exact drift the pure/impure split exists to stop.
 *
 * It is the issue-side mirror of `applyPrDispatchGate` (`./dispatcher.ts`), and
 * the header there states the rule this one also follows: a consequence that
 * belongs to the decision is applied HERE, so no caller can forget it. On this
 * path that consequence is the stage-label advance, which is not decoration —
 * it is **guard 2** of the four-guard loop-safety argument
 * (`./build-decisions.ts`, `./stage-advance.ts`).
 *
 * **Why its own module rather than `dispatcher.ts`.** The PR gate lives there
 * because the dispatcher is where the webhook route decides for itself. Nothing
 * on the issue side needs that: the gate has exactly one caller today
 * (`dispatchWorkflow`) and the two Phase 4 surfaces — the backstop sweep and
 * `/api/run` — reach the same choke point. Keeping it out of a 1,000-line module
 * keeps the footprint of this feature small enough to read in one sitting.
 */

import { getAutonomyConfig, getHoldLabel, isAutonomousRepo } from "../config/config.js";
import type { AutonomyStageConfig } from "../config/config.js";
import { issueTriggerId, resolveBuildTrigger } from "./build-decisions.js";
import { advanceStage } from "./stage-advance.js";
import { recordActivity } from "../activity.js";
import { logger } from "../logging/logger.js";
import type { StateDb } from "../state/db.js";
import type { WorkflowRun } from "../state/workflow-run-store.js";
import type { Decision } from "./pr-decisions.js";
import type { BuildTriggerDecision } from "./build-decisions.js";
import type { GitHubClient } from "./github/github.js";

const log = logger("build-gate");

/** What {@link applyBuildDispatchGate} was asked to decide. */
export interface BuildGateArgs {
  /** `"owner/repo"`. */
  repo: string;
  issueNumber: number;
  /** The issue's CURRENT labels — what the hold check reads. */
  labels: readonly string[];
  /** The label whose application triggered this, when one did. */
  addedLabel?: string;
  /** Which surface this dispatch arrived on. */
  route: "labeled" | "sweep" | "api";
  /** Did OUR bot apply the label? Drives the already-built asymmetry. */
  senderIsBot: boolean;
  /** Stage name from `autonomy.stages`, e.g. "build". */
  stage: string;
}

export interface BuildGateDeps {
  db: StateDb;
  /** `null` in chat-only mode — there is then no label to advance. */
  github: GitHubClient | null;
}

export interface BuildGateResult {
  decision: "dispatch" | "skip";
  reason: string;
  /**
   * The stage's approval gates, for the caller to union onto the run's
   * effective approval map. Only ever present on a `dispatch`.
   */
  gates?: Record<string, boolean>;
}

export async function applyBuildDispatchGate(
  args: BuildGateArgs,
  deps: BuildGateDeps,
): Promise<BuildGateResult> {
  // ── 1. THE STAGE ─────────────────────────────────────────────────────────
  //
  // The stage is what names the workflow, the labels and the gates, so an
  // unknown one leaves the gate with nothing to enforce. Fail CLOSED: a stage
  // dispatch we cannot identify must not run un-gated, because everything below
  // — the idempotency key, the hold, the label advance — is keyed on names only
  // the stage carries. An operator who renamed a stage gets no build and one
  // warning, rather than an ungoverned one.
  const stage = getAutonomyConfig().stages[args.stage];
  if (!stage) {
    const reason = `unknown-stage: \`${args.stage}\` is not in \`autonomy.stages\`, so there is no workflow, no labels and no gates to run behind`;
    log.warn("Build gate refused an unknown stage", {
      repo: args.repo,
      issueNumber: args.issueNumber,
      stage: args.stage,
      reason,
    });
    return { decision: "skip", reason };
  }

  // ── 2. THE INPUTS ────────────────────────────────────────────────────────
  //
  // Resolved once, here, so the pure function reads a single consistent record
  // — the same rule `resolvePrState` follows for the PR side.
  const triggerId = issueTriggerId(args.repo, args.issueNumber);
  const budget = getAutonomyConfig().budget;
  const [owner, name] = args.repo.split("/");
  // Read → decide → reserve under ONE in-process lock. The fan-out gates every
  // discovered issue in parallel, and a run row is only written later, inside
  // the dispatch — so without the lock and the reservation every gate in a
  // tick reads the same count, and seven issues against a ceiling of one all
  // dispatched (nearform, 2026-09-16).
  const decision = await withGateLock(async () => {
    // Every day-scoped budget input is measured from the same instant, resolved
    // ONCE here. Two reads that each called "start of today" separately could
    // straddle midnight and answer about different days.
    const sinceIso = startOfUtcDayIso();
    const [alreadyBuilt, inFlight, activeRuns, buildsForRepoToday, dailyStats, repoSpend] = await Promise.all([
      // GUARD 3 — the real lock. A fact in our own database, in ANY status, that
      // no GitHub outage can move.
      deps.db.runs.hasRunForTrigger(triggerId, stage.workflow),
      // `activeForTrigger`, not `getByTrigger`: both mean "queued | running |
      // paused for this trigger", but `getByTrigger` answers for ANY workflow, so
      // a live issue-triage run on the same issue would read as a build in
      // flight. The constraint being protected is two agents in one build
      // workspace, which is scoped to the stage's own workflow — and it is what
      // the decision's `run-in-flight:` reason claims in prose.
      deps.db.runs.activeForTrigger([stage.workflow], triggerId),
      // The concurrency input. `listActive()` + a filter, NOT `countRunning()`:
      // that one counts every running workflow in the harness — a PR review, a
      // triage, a cron fan-out — so the autonomy pipeline's own ceiling would be
      // consumed by work it has nothing to do with, and a busy deployment would
      // refuse every autonomous build while running none.
      deps.db.runs.listActive(),
      // Guard 4's counter. Runs STARTED for this repo today, in any status.
      deps.db.runs.countRunsForRepoSince(stage.workflow, args.repo, sinceIso),
      // `dailyStats(1)` is the inclusive window [today, today] — one bucket, and
      // it is synthesised as a zero row when nothing has run, so the array is
      // never empty. Read defensively anyway: a spend input that read `undefined`
      // as "over budget" would refuse every build on a quiet morning.
      deps.db.executions.dailyStats(1),
      deps.db.executions.repoCostSince(owner ?? "", name ?? "", sinceIso),
    ]);

    // `queued` and `running` only. A `paused` run is waiting on a human at an
    // approval gate: it holds no agent and no sandbox slot, so counting it let a
    // handful of plans awaiting review stop the whole pipeline. (It still blocks
    // a rebuild of ITS issue — that is `inFlight` above, which keeps `paused`.)
    const liveRows = activeRuns.filter(
      (run) =>
        run.workflowName === stage.workflow &&
        isAutonomousRun(run) &&
        (run.status === "queued" || run.status === "running"),
    ).length;
    // Dispatches this gate approved whose run row does not exist yet — see
    // `pendingReservations`. Without them every gate in one sweep tick reads the
    // same pre-burst count.
    const pending = await pendingReservations(deps.db, stage.workflow, triggerId);
    const concurrentAutonomousBuilds = liveRows + pending.length;
    const spendTodayUsd = dailyStats[dailyStats.length - 1]?.costUsd ?? 0;

    const decision = resolveBuildTrigger({
      repo: args.repo,
      issueNumber: args.issueNumber,
      labels: args.labels,
      addedLabel: args.addedLabel,
      route: args.route,
      senderIsBot: args.senderIsBot,
      autonomyEnabled: isAutonomousRepo(args.repo),
      alreadyBuilt,
      runInFlight: !!inFlight,
      holdLabel: getHoldLabel(),
      concurrentAutonomousBuilds,
      // A reserved dispatch for this repo has not STARTED a run yet, but it will.
      buildsForRepoToday: buildsForRepoToday + pending.filter((r) => r.repo === args.repo).length,
      spendTodayUsd,
      repoSpendTodayUsd: repoSpend.costUsd,
    }, budget);
    if (decision.decision === "dispatch") reserve(deps.db, stage.workflow, triggerId, args.repo);
    return decision;
  });

  // ── 3. THE LOG ───────────────────────────────────────────────────────────
  //
  // One line per dispatch, in the same shape `applyPrDispatchGate` logs: the
  // decision AND the reason that produced it, because the reason is the single
  // source the comment and the admin panel also render.
  log.info("Build gate decision", {
    workflow: stage.workflow,
    repo: args.repo,
    issueNumber: args.issueNumber,
    decision: decision.decision,
    reason: decision.reason,
  });

  if (decision.decision === "skip") {
    await applySkipConsequence(args, stage, decision, deps);
    return { decision: "skip", reason: decision.reason };
  }

  // ── 4. GUARD 2 — advance the label BEFORE the run starts ─────────────────
  //
  // Load-bearing, and the ORDERING is the whole point. The Phase 4 backstop
  // sweep queries `label:<enter>`; while the entry label is still on the issue,
  // every sweep tick and every re-delivered webhook sees a pipeline entry it is
  // entitled to pick up. Moving the label off here — before the run exists —
  // makes a re-dispatch structurally impossible rather than merely caught.
  //
  // A FAILED advance must not block the dispatch. `advanceStage` never throws
  // for exactly this reason: the labels are the human-readable projection of
  // the fact, and guard 3 (`hasRunForTrigger`) is the fact. So the cost of a
  // failure here is visibility, not a double build — but it IS guard 2 silently
  // degrading, so it gets a warning rather than passing unremarked.
  const advance = await advanceStage(
    {
      owner: owner ?? "",
      repo: name ?? "",
      issueNumber: args.issueNumber,
      from: stage.enter,
      to: stage.running,
      // A run is STARTING, so neither terminal verdict holds any more. Nothing
      // else ever clears them: this advance removes `enter`, and the terminal
      // observer removes `running` — so without this an issue that failed and
      // was then re-run successfully keeps `agent-blocked` alongside its new
      // `ready-for-human`, and the board files it under the older verdict.
      // Best-effort by contract; a stale label is untidy, never unsafe.
      alsoRemove: [stage.on_success, stage.on_failure],
    },
    { github: deps.github },
  );
  if (!advance.advanced || !advance.removed) {
    log.warn("Stage label advance degraded — the sweep's re-pickup guard is weaker for this issue", {
      workflow: stage.workflow,
      repo: args.repo,
      issueNumber: args.issueNumber,
      from: stage.enter,
      to: stage.running,
      advanced: advance.advanced,
      removed: advance.removed,
      reason: advance.reason,
    });
  }

  // The stage's gates travel back to the caller rather than being applied here:
  // they belong to the RUN, which does not exist yet. The union happens where
  // the run's effective approval map is composed (`workflows/simple.ts`).
  return { decision: "dispatch", reason: decision.reason, gates: stage.gates };
}

/**
 * Dispatch reservations — the gate's own not-yet-visible dispatches.
 *
 * A `dispatch` verdict is only a promise: the run row that the concurrency and
 * day-quota counts read is written later, inside `runSimpleWorkflow`. Between
 * the two, a reservation stands in for it. One is dropped as soon as a run for
 * its trigger has started at or after it (from then on the row is the count),
 * or after {@link RESERVATION_TTL_MS} — a dispatch refused downstream or crashed
 * before creating its row must not hold a slot forever.
 *
 * Keyed by the `StateDb` so each store (and each test's fresh one) has its own.
 * In-process only: one harness owns the dispatch choke point, and a restart
 * starts with no promises outstanding.
 */
interface Reservation {
  workflow: string;
  triggerId: string;
  repo: string;
  at: number;
}

const RESERVATION_TTL_MS = 5 * 60_000;
const reservationsByDb = new WeakMap<StateDb, Map<string, Reservation>>();

function reservationsFor(db: StateDb): Map<string, Reservation> {
  let held = reservationsByDb.get(db);
  if (!held) {
    held = new Map();
    reservationsByDb.set(db, held);
  }
  return held;
}

function reserve(db: StateDb, workflow: string, triggerId: string, repo: string): void {
  reservationsFor(db).set(`${workflow}\u0000${triggerId}`, { workflow, triggerId, repo, at: Date.now() });
}

/**
 * The live reservations for `workflow`, pruning realised and expired ones.
 * `ownTriggerId` is excluded: the board gates an issue, then `dispatchWorkflow`
 * gates it again, and a dispatch must not be refused by its own reservation.
 */
async function pendingReservations(
  db: StateDb,
  workflow: string,
  ownTriggerId: string,
): Promise<Reservation[]> {
  const held = reservationsFor(db);
  const now = Date.now();
  const out: Reservation[] = [];
  for (const [key, r] of held) {
    if (r.workflow !== workflow) continue;
    if (now - r.at > RESERVATION_TTL_MS) {
      held.delete(key);
      continue;
    }
    const latest = await db.runs.latestForTrigger([workflow], r.triggerId);
    if (latest && Date.parse(latest.startedAt) >= r.at) {
      held.delete(key);
      continue;
    }
    if (r.triggerId !== ownTriggerId) out.push(r);
  }
  return out;
}

/** Serialises the gate's read → decide → reserve step within this process. */
let gateTail: Promise<unknown> = Promise.resolve();
function withGateLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = gateTail.then(fn, fn);
  gateTail = next.catch(() => undefined);
  return next;
}

/**
 * Midnight UTC today, as an ISO string — the boundary every day-scoped budget
 * is measured from.
 *
 * UTC rather than a deployment-local day because that is what the ledger
 * already buckets on (`dayBucket()` slices the first ten characters of the
 * stored ISO timestamp), so a local-midnight boundary here would disagree with
 * the numbers on the dashboard's own stats page. Every reason string that names
 * this ceiling says "midnight UTC" out loud for the same reason.
 */
function startOfUtcDayIso(now: Date = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  ).toISOString();
}

/**
 * Was this run dispatched by the autonomy pipeline?
 *
 * The flag is stamped on the run's `context` at dispatch. `context` is a JSON
 * column typed `Record<string, unknown>` — anything at all may be in it, and on
 * an old row nothing is — so this is a defensive read with an explicit `=== true`
 * rather than a truthiness test: the question is "did the pipeline stamp this",
 * and a run carrying the string `"false"` is not an answer of yes.
 */
function isAutonomousRun(run: WorkflowRun): boolean {
  const ctx = run.context;
  if (!ctx || typeof ctx !== "object") return false;
  return (ctx as Record<string, unknown>)._autonomous === true;
}

/**
 * The greppable case name out of a `"<case>: <explanation>"` reason.
 *
 * Reading the CASE off the reason is blessed by `build-decisions.ts`'s own
 * module header — the grammar exists precisely so the case stays greppable
 * without a parallel enum to keep in sync. Reading the PROSE would not be: the
 * one skip with a durable consequence keys on the typed `budgetExhausted`
 * field, never on this.
 */
function caseOf(reason: string): string {
  const colon = reason.indexOf(":");
  return colon > 0 ? reason.slice(0, colon) : reason;
}

/**
 * What a skip costs — recorded, never silent, but PROPORTIONATE.
 *
 * `pr-escalation.ts` states the doctrine this follows: a skip that is terminal
 * for the problem owes a human an explanation on the subject itself, and a skip
 * that is merely "come back later" owes them nothing but a log line. Applying
 * the loud treatment to a transient skip is not a harmless excess — a cron that
 * re-ticks every twenty minutes would comment every twenty minutes, which is
 * the #256 failure shape (a notice with no de-duplication) rebuilt on a new
 * subject.
 *
 * So, three tiers:
 *
 * | case                    | log  | activity row | comment |
 * |-------------------------|------|--------------|---------|
 * | `concurrency-exhausted` | info | no           | no      |
 * | `repo-quota-exhausted`  | warn | yes          | no      |
 * | `budget-exhausted`      | warn | yes          | once    |
 *
 * `concurrency-exhausted` clears itself in minutes and fires on every sweep
 * tick while it holds, so a row per tick would be noise in the one stream whose
 * value is that a human can read it. The day quota is worth a row — it is a
 * ceiling somebody configured and may want to raise — but not a comment: the
 * issue is still going to be built, just not today. Only the spend ceiling is
 * terminal for the day in a way the issue itself should carry.
 *
 * Every skip NOT in that table (`on-hold`, `not-autonomous`, `already-built`,
 * `run-in-flight`) is silent here by design, as it was in Phase 1.
 *
 * Never throws: `recordActivity` swallows its own failures, and the GitHub half
 * is best-effort. A refusal that failed to be recorded is still a refusal.
 */
async function applySkipConsequence(
  args: BuildGateArgs,
  stage: AutonomyStageConfig,
  decision: Decision<BuildTriggerDecision>,
  deps: BuildGateDeps,
): Promise<void> {
  const skipCase = caseOf(decision.reason);
  if (skipCase !== "repo-quota-exhausted" && skipCase !== "budget-exhausted") return;

  const triggerId = issueTriggerId(args.repo, args.issueNumber);

  // A ceiling somebody configured has been hit. `warn`, not `info`: this is the
  // level an operator filters for when asking "is the pipeline stuck, or just
  // quiet?", and both cases are answers to that question.
  log.warn("Build gate refused a dispatch on a budget ceiling", {
    workflow: stage.workflow,
    repo: args.repo,
    issueNumber: args.issueNumber,
    case: skipCase,
    reason: decision.reason,
  });

  await recordActivity(deps.db, {
    action: "autonomy.skip",
    // Nobody asked for this — the pipeline refused itself.
    actorType: "system",
    targetType: "issue",
    targetId: triggerId,
    // `denied`, not `ok`: the row records an action that did NOT happen, which
    // is the same reading `pr.retry` gives a gate-refused retry.
    outcome: "denied",
    detail: { case: skipCase, workflow: stage.workflow, reason: decision.reason },
  });

  // The typed field, not the case name, is what gates the comment — and it is
  // set on exactly one branch.
  const exhausted = decision.budgetExhausted;
  if (!exhausted) return;

  const github = deps.github;
  const [owner, name] = args.repo.split("/");
  if (!github || !owner || !name) return;

  // ── The de-duplication, keyed on a DURABLE FACT ──────────────────────────
  //
  // The label's absence is the key, exactly as `noticeForkPr` keys on its
  // persisted record rather than on scanning comments for its own prose. This
  // is the only thing standing between "one comment" and "one comment every
  // twenty minutes for the rest of the day": the budget does not clear until
  // midnight, so every sweep tick between now and then reaches this same
  // branch. A body-text marker would not do — it costs an API scan per tick and
  // breaks the moment the wording changes — and neither would a timestamp,
  // which we would have nowhere to put.
  //
  // `args.labels` is the issue's CURRENT label set, the same snapshot the hold
  // check read.
  if (args.labels.includes(stage.on_failure)) return;

  // Label FIRST, comment second — the crash-window argument `noticeForkPr`
  // makes about its record. Crash between the two and the issue carries the
  // blocked label with no explanation: wrong, but bounded and recoverable by a
  // human taking the label off. Crash the other way round and the issue carries
  // a comment with no label, so the dedup key was never written and every tick
  // until midnight comments again. Between one missing sentence and an
  // unbounded comment loop, the durable write goes first.
  //
  // Note this is `advanceStage` with a `to` and NO `from`: it ADDS the blocked
  // label and removes nothing. The entry label must stay exactly where it is —
  // the build has not run, so the issue has not left the queue, and the sweep
  // re-picking it tomorrow is the intended behaviour. Advancing to `running`
  // here would be the opposite of the truth.
  const advance = await advanceStage(
    { owner, repo: name, issueNumber: args.issueNumber, to: stage.on_failure },
    { github },
  );
  if (!advance.added) {
    // No durable key was written, so a comment now would repeat on the next
    // tick. Say nothing; the activity row above is still the record.
    log.warn("Could not label a budget-exhausted issue — saying nothing, since a comment with no label would repeat every tick", {
      repo: args.repo,
      issueNumber: args.issueNumber,
      label: stage.on_failure,
      reason: advance.reason,
    });
    return;
  }

  try {
    await github.postComment(
      owner,
      name,
      args.issueNumber,
      renderBudgetExhaustedComment({
        scope: exhausted.scope,
        limitUsd: exhausted.limitUsd,
        spentUsd: exhausted.spentUsd,
        repo: args.repo,
        blockedLabel: stage.on_failure,
      }),
    );
  } catch (err: unknown) {
    log.warn("Budget-exhausted comment failed", {
      repo: args.repo,
      issueNumber: args.issueNumber,
      err,
    });
  }
}

/**
 * The budget-exhausted comment. Pure, so its wording is table-testable — the
 * same split `renderEscalationComment` makes.
 *
 * Three things it has to say, and nothing else. **Which ceiling**, with the
 * configured number, because "I am out of budget" is unactionable and "I have
 * spent $10.40 of this repo's $10.00" tells somebody exactly what to change.
 * **When it resets**, because the default assumption is that a blocked bot
 * stays blocked. And **both exits**, because this comment is the only place
 * most people will ever learn there are any — the `pr-escalation.ts` rule that
 * every exit which works must be named, and every exit named must work.
 *
 * Short on purpose: it is an interruption on somebody's issue, not a report.
 */
export function renderBudgetExhaustedComment(args: {
  scope: "harness" | "repo";
  limitUsd: number;
  spentUsd: number;
  repo: string;
  blockedLabel: string;
}): string {
  const ceiling =
    args.scope === "harness"
      ? `my daily model budget across every repository ($${args.limitUsd.toFixed(2)})`
      : `the daily model budget for \`${args.repo}\` ($${args.limitUsd.toFixed(2)})`;
  return (
    `I'm not starting a build here: I've hit ${ceiling}, having spent ` +
    `$${args.spentUsd.toFixed(2)} so far today. It resets at midnight UTC.\n\n` +
    `Two ways on from here: remove the \`${args.blockedLabel}\` label to re-arm me — ` +
    `I'll pick this up again once the budget has reset — or ask whoever runs this ` +
    `deployment to raise the limit.`
  );
}

/**
 * Admission controller for the global concurrency cap (issue #172).
 *
 * When `runSimpleWorkflow` creates a run with `status: 'queued'` instead of
 * `status: 'running'` (because `countRunning() >= maxWorkflows`), this
 * controller is responsible for promoting queued runs to running as slots free.
 *
 * Two promotion paths:
 *  1. **Event-driven**: `admitNext()` is called in `dispatchWorkflow`'s
 *     `finally` block so a just-finished run immediately frees its slot.
 *  2. **Periodic sweep**: `setInterval(sweep, sweepIntervalMs)` (default 15 s)
 *     also performs TTL expiry of stale queued runs before admitting.
 *
 * Concurrency safety: `admitRun` is a CAS (`WHERE status = 'queued'`), so
 * only the first caller wins a given row — the event-driven and periodic
 * paths can race safely.
 *
 * Admission reuses `resumeSimpleRun` (from resume.ts): a queued run's stored
 * `context` is identical in shape to what resumeSimpleRun reconstructs from,
 * and the ledger's `shouldRunPhase` will run all phases (none have run yet).
 * This avoids duplicating dispatch plumbing and naturally bypasses the cap
 * (resumes enter `runWorkflow` directly, not the fresh-run gate).
 *
 * **The enqueue ack is transient (issue #244).** `simple.ts` posts "…is queued,
 * it'll start automatically when a slot frees" and stashes the comment handle in
 * `scratch.queuedAck.commentId`. Whichever way the run leaves the queue, this
 * controller resolves that comment rather than leaving a stale promise behind:
 * admitted → `retractQueuedAck` deletes it; TTL-expired → `postExpiryAck`
 * rewrites it in place to the drop notice.
 */

import type { StateDb } from "../state/db.js";
import type { WorkflowRun } from "../state/workflow-run-store.js";
import { resumeSimpleRun, type ResumeOptions } from "./resume.js";
import { logger } from "../logging/logger.js";

const log = logger("admission");

/**
 * Absurdly-high runaway-loop backstop for the k8s backend. NOT a tuned
 * concurrency limit — the namespace ResourceQuota is the real authority
 * (spec/09-sandbox.md (Concurrency)). Mirrors the workflow engine's 1000-agent cap: a fuse, not a knob.
 */
export const K8S_SANITY_FUSE = 1000;

export interface AdmissionDeps {
  db: StateDb;
  resumeOpts: ResumeOptions;
  maxWorkflows: number;
  maxQueueWaitMs: number;
  /** How often the background sweep runs. Defaults to 15 000 ms. */
  sweepIntervalMs?: number;
  /**
   * k8s backpressure mode (spec/09-sandbox.md (Concurrency)): gate on `K8S_SANITY_FUSE` instead of
   * `maxWorkflows`, and promote at most ONE queued run per `admitNext` (each
   * promote is a quota probe; the run re-queues if the ResourceQuota is full).
   */
  backpressureMode?: boolean;
}

export interface AdmissionController {
  /** Promote as many queued runs as free slots allow. */
  admitNext(): Promise<void>;
  /** TTL-expire stale queued runs, then call admitNext(). */
  sweep(): Promise<void>;
  /** Start the background sweeper interval. */
  start(): void;
  /** Stop the background sweeper interval. */
  stop(): void;
}

export function createAdmissionController(deps: AdmissionDeps): AdmissionController {
  const { db, resumeOpts, maxWorkflows, maxQueueWaitMs } = deps;
  const backpressureMode = deps.backpressureMode ?? false;
  const cap = backpressureMode ? K8S_SANITY_FUSE : maxWorkflows;
  const sweepIntervalMs = deps.sweepIntervalMs ?? 15_000;
  let timer: ReturnType<typeof setInterval> | undefined;

  async function admitNext(): Promise<void> {
    // Re-read the running count and queued list on each iteration so we don't
    // race against concurrent admits or ongoing resumes changing the count.
    for (;;) {
      if (db.runs.countRunning() >= cap) break;
      const queued = db.runs.listQueued();
      if (queued.length === 0) break;
      const next = queued[0];
      const changes = db.runs.admitRun(next.id);
      if (changes !== 1) {
        // CAS lost — another admitter won this row; re-check from scratch.
        continue;
      }
      // Won the CAS: reload the row (now `running`) and dispatch in the
      // background. Do NOT await — this is a long-running sandbox dispatch.
      const admitted = db.runs.getRun(next.id);
      if (admitted) {
        // The enqueue ack ("it'll start automatically when a slot frees") has
        // now been honoured, so retract it before the run posts anything of its
        // own (issue #244). Fire-and-forget: a failed retract is cosmetic.
        retractQueuedAck(admitted, resumeOpts).catch((err: unknown) => {
          log.warn("Failed to retract queued ack", { runId: admitted.id, err });
        });
        dispatchAdmitted(admitted, resumeOpts);
      }
      // Backpressure mode: promote ONE probe per invocation. In app-count mode,
      // keep filling up to `cap` (the old behavior).
      if (backpressureMode) break;
    }
  }

  async function sweep(): Promise<void> {
    await expireStaleRuns(db, maxQueueWaitMs, resumeOpts);
    await admitNext();
  }

  function start(): void {
    if (timer !== undefined) return;
    timer = setInterval(() => {
      sweep().catch((err: unknown) => {
        log.error("Sweep failed", { err });
      });
    }, sweepIntervalMs);
  }

  function stop(): void {
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  }

  return { admitNext, sweep, start, stop };
}

/** Fire-and-forget: resume a newly admitted run. */
function dispatchAdmitted(run: WorkflowRun, resumeOpts: ResumeOptions): void {
  resumeSimpleRun(run, resumeOpts).catch((err: unknown) => {
    log.error("resumeSimpleRun failed", { runId: run.id, err });
  });
}

/** Expire queued runs that have waited longer than maxQueueWaitMs. */
async function expireStaleRuns(
  db: StateDb,
  maxQueueWaitMs: number,
  resumeOpts: ResumeOptions,
): Promise<void> {
  const queued = db.runs.listQueued();
  const now = Date.now();
  for (const run of queued) {
    const enqueuedAt = Date.parse(run.startedAt);
    if (now - enqueuedAt > maxQueueWaitMs) {
      const reason = "dropped from queue after waiting too long";
      const changed = db.runs.expireQueued(run.id, reason);
      if (changed === 1) {
        postExpiryAck(run, reason, resumeOpts).catch((err: unknown) => {
          log.warn("Failed to post expiry ack", { runId: run.id, err });
        });
      }
    }
  }
}

/**
 * The GitHub comment handle `simple.ts` stashes when it posts the enqueue ack,
 * so a later transition can retract or rewrite that comment (issue #244).
 * Absent for Slack-originated runs and for any run whose ack failed to post.
 */
function queuedAckCommentId(run: WorkflowRun): number | undefined {
  const ack = (run.scratch?.queuedAck ?? {}) as { commentId?: unknown };
  return typeof ack.commentId === "number" ? ack.commentId : undefined;
}

/**
 * Best-effort: delete the enqueue ack once the run has actually been admitted.
 *
 * The ack exists only to say "hang tight, this will start" — once it has, the
 * comment is a stale promise, and on a workflow that legitimately no-ops (a
 * re-triage of an already-triaged issue) it would otherwise be the run's ONLY
 * visible trace, reading as "it queued and never came back" (issue #244).
 * Deleting rather than editing keeps the thread clean: whatever the run itself
 * posts becomes the real answer, and the run stays fully visible in the
 * dashboard + `lastlight workflow list` either way.
 *
 * Never throws — a failed retract is cosmetic, and the run is already running.
 */
async function retractQueuedAck(run: WorkflowRun, resumeOpts: ResumeOptions): Promise<void> {
  const commentId = queuedAckCommentId(run);
  if (commentId === undefined) return;
  const { github } = resumeOpts;
  if (!github || !run.owner || !run.repo) return;
  await github.deleteComment(run.owner, run.repo, commentId);
}

/**
 * Best-effort: tell the originating surface that a queued run was dropped.
 * Never throws — the row has already been transitioned, so a failed ack is a UI
 * gap, not a data hazard.
 *
 * **Slack** runs get a thread reply: a Slack run is a human explicitly asking
 * for work, so an "it didn't run" message is useful.
 *
 * **GitHub** runs get no NEW comment — these are mostly automated dependency-PR
 * / review webhooks, and a fresh "dropped from queue" comment on every TTL
 * expiry floods the PR with noise (the symptom that surfaced this). But when the
 * run posted an enqueue ack, that comment is now actively false, so it is
 * rewritten IN PLACE (issue #244). That adds nothing to the thread — the comment
 * is already there — and GitHub does not notify watchers on edits, so the
 * anti-noise property holds.
 */
async function postExpiryAck(
  run: WorkflowRun,
  reason: string,
  resumeOpts: ResumeOptions,
): Promise<void> {
  const msg = `Workflow \`${run.workflowName}\` was ${reason}.`;

  // Slack-originated run: use slackPoster (channel/thread stored in context).
  if (run.triggerId.startsWith("slack:")) {
    const stored = (run.context || {}) as Record<string, unknown>;
    const channelId = stored.channelId as string | undefined;
    const threadId = stored.threadId as string | undefined;
    if (resumeOpts.slackPoster && channelId && threadId) {
      await resumeOpts.slackPoster(channelId, threadId, msg);
    }
    return;
  }

  // GitHub-originated run: rewrite the stale ack if we left one, else stay quiet.
  const commentId = queuedAckCommentId(run);
  if (commentId === undefined) return;
  const { github } = resumeOpts;
  if (!github || !run.owner || !run.repo) return;
  await github.updateComment(run.owner, run.repo, commentId, msg);
}

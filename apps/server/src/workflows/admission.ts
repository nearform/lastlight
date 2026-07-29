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
 */

import type { StateDb } from "../state/db.js";
import type { WorkflowRun } from "../state/workflow-run-store.js";
import { resumeSimpleRun, type ResumeOptions } from "./resume.js";

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
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[admission] Sweep failed: ${msg}`);
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
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[admission] resumeSimpleRun failed for ${run.id}: ${msg}`);
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
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[admission] Failed to post expiry ack for ${run.id}: ${msg}`);
        });
      }
    }
  }
}

/**
 * Best-effort: notify the ORIGINATING SLACK THREAD that a queued run was
 * dropped. A Slack run is a human explicitly asking for work, so a "it didn't
 * run" reply is useful. Never throws — the row has already been transitioned, so
 * a failed ack is a UI gap, not a data hazard.
 *
 * GitHub-originated runs get NO comment: these are mostly automated
 * dependency-PR / review webhooks, and a "dropped from queue" comment on every
 * TTL-expired run floods the PR with noise (the symptom that surfaced this). The
 * drop is still visible in the dashboard + `lastlight workflow list` (status
 * `cancelled`, `context.error` = the reason), and such a run can now be retried.
 */
async function postExpiryAck(
  run: WorkflowRun,
  reason: string,
  resumeOpts: ResumeOptions,
): Promise<void> {
  // Slack-originated run: use slackPoster (channel/thread stored in context).
  if (run.triggerId.startsWith("slack:")) {
    const msg = `Workflow \`${run.workflowName}\` was ${reason}.`;
    const stored = (run.context || {}) as Record<string, unknown>;
    const channelId = stored.channelId as string | undefined;
    const threadId = stored.threadId as string | undefined;
    if (resumeOpts.slackPoster && channelId && threadId) {
      await resumeOpts.slackPoster(channelId, threadId, msg);
    }
  }
  // GitHub-originated runs: intentionally no PR comment (see doc above).
}

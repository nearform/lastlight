import { Cron } from "croner";
import { SpanStatusCode, trace } from "@opentelemetry/api";
import type { StateDb } from "../state/db.js";
import { logger } from "../logging/logger.js";

const log = logger("cron");
const tracer = () => trace.getTracer("lastlight");

export interface CronJob {
  name: string;
  schedule: string;
  /**
   * Name of an agent workflow (workflows/<name>.yaml) to invoke on each tick.
   * Absent for a `handler:` cron — see {@link CronJob.handler}.
   */
  workflow?: string;
  /**
   * A HOST-SIDE handler to run instead of dispatching a workflow (the cron
   * YAML's `handler:` key, resolved to a function by `jobs.ts`). Takes the same
   * tick context a workflow dispatch would have received, so per-repo
   * participation and the control keys reach it unchanged.
   */
  handler?: (context: Record<string, unknown>) => Promise<void>;
  context: Record<string, unknown>;
}

/**
 * Consecutive failed ticks before the scheduler shouts.
 *
 * A constant, not a per-job field: `CronJob.maxFailures` existed for a year,
 * was read once as `job.maxFailures || 3`, and was **never set by anything** —
 * not the cron YAML schema (it has no such key), not `getJobs`. So it always
 * resolved to 3 while reading like a knob an operator could turn.
 */
const MAX_CONSECUTIVE_FAILURES = 3;

/** A lightweight direct job — runs a function, not a workflow */
export interface DirectCronJob {
  name: string;
  schedule: string;
  handler: () => Promise<void>;
}

export type WorkflowRunner = (workflow: string, context: Record<string, unknown>) => Promise<void>;

/**
 * Cron scheduler with overlap protection and failure tracking.
 * Each job runs a workflow via the agent runner, tracked in SQLite.
 */
export class CronScheduler {
  private jobs: Map<string, Cron> = new Map();
  private running: Set<string> = new Set();
  private db: StateDb;
  private runner: WorkflowRunner;

  constructor(db: StateDb, runner: WorkflowRunner) {
    this.db = db;
    this.runner = runner;
  }

  register(job: CronJob): void {
    if (this.jobs.has(job.name)) {
      throw new Error(`Cron job "${job.name}" already registered`);
    }

    const cronJob = new Cron(job.schedule, async () => {
      // Overlap protection — skip if still running
      if (this.running.has(job.name)) {
        log.info("Skipping — still running from previous tick", { job: job.name });
        return;
      }

      this.running.add(job.name);
      log.info("Running", { job: job.name });

      try {
        if (job.handler) await job.handler(job.context);
        else await this.runner(job.workflow!, job.context);
      } catch (err: unknown) {
        log.error("Job failed", { job: job.name, err });

        // Consecutive failures, counted off the `executions` ledger. A workflow
        // cron's rows are written per phase under the WORKFLOW name; a handler
        // cron's are written per tick under the CRON name by `withLedger`
        // (`cron/handlers.ts`) — which exists so this branch applies to both.
        // It used to be gated on `job.workflow`, so a handler cron failing every
        // tick produced one log line and nothing else: no count, and an admin
        // dashboard reporting zero failures beside it.
        const ledgerKey = job.workflow ?? job.name;
        const failures = this.db.executions.consecutiveFailures(ledgerKey);
        if (failures >= MAX_CONSECUTIVE_FAILURES) {
          log.error("ALERT: job has failed consecutively", { job: job.name, failures });
          // TODO: send alert (Slack webhook, email, etc.)
        }
      } finally {
        this.running.delete(job.name);
      }
    });

    this.jobs.set(job.name, cronJob);
    log.info("Registered", { job: job.name, schedule: job.schedule });
  }

  /** Register a lightweight direct handler (no skill/sandbox overhead) */
  registerDirect(job: DirectCronJob): void {
    if (this.jobs.has(job.name)) {
      throw new Error(`Cron job "${job.name}" already registered`);
    }

    const cronJob = new Cron(job.schedule, async () => {
      // Logged, not a silent return: a direct job wedged in `running` would
      // otherwise be skipped on every subsequent tick forever with no signal,
      // where the same wedge in `register()` is visible within one interval.
      if (this.running.has(job.name)) {
        log.info("Skipping — still running from previous tick", { job: job.name });
        return;
      }

      this.running.add(job.name);
      // The scheduler's span covers the trigger, not the work: the tick, its
      // duration and its failure. The handler owns whatever it does inside.
      // Starting it active also means `logger`'s pino mixin stamps
      // trace_id/span_id on every line the handler emits, so its logs and its
      // trace correlate with no plumbing.
      await tracer().startActiveSpan(`cron.${job.name}`, async (span) => {
        log.info("Running", { job: job.name });
        try {
          await job.handler();
        } catch (err: unknown) {
          log.error("Job failed", { job: job.name, err });
          span.recordException(err instanceof Error ? err : new Error(String(err)));
          span.setStatus({ code: SpanStatusCode.ERROR });
        } finally {
          span.end();
          this.running.delete(job.name);
        }
      });
    });

    this.jobs.set(job.name, cronJob);
    log.info("Registered", { job: job.name, schedule: job.schedule });
  }

  /** Whether a cron with this name is currently registered. */
  has(name: string): boolean {
    return this.jobs.has(name);
  }

  /** Stop and remove a single cron. No-op if not registered. */
  unregister(name: string): void {
    const job = this.jobs.get(name);
    if (!job) return;
    job.stop();
    this.jobs.delete(name);
    log.info("Stopped", { job: name });
  }

  /** Replace an existing cron with a new schedule/context. Equivalent to unregister + register. */
  update(job: CronJob): void {
    this.unregister(job.name);
    this.register(job);
  }

  /** Snapshot of registered jobs with the croner-computed next-run timestamp. */
  list(): Array<{ name: string; schedule: string; nextRun: Date | null }> {
    return Array.from(this.jobs.entries()).map(([name, cronJob]) => ({
      name,
      schedule: cronJob.getPattern() ?? "",
      nextRun: cronJob.nextRun(),
    }));
  }

  /** Stop all cron jobs */
  stopAll(): void {
    for (const [name, job] of this.jobs) {
      job.stop();
      log.info("Stopped", { job: name });
    }
    this.jobs.clear();
  }
}

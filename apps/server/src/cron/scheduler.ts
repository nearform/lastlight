import { Cron } from "croner";
import type { StateDb } from "../state/db.js";
import { logger } from "../logging/logger.js";

const log = logger("cron");

export interface CronJob {
  name: string;
  schedule: string;
  /** Name of an agent workflow (workflows/<name>.yaml) to invoke on each tick */
  workflow: string;
  context: Record<string, unknown>;
  /** Maximum consecutive failures before alerting */
  maxFailures?: number;
}

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
        await this.runner(job.workflow, job.context);
      } catch (err: unknown) {
        log.error("Job failed", { job: job.name, err });

        // Check consecutive failures (tracked under the workflow name)
        const failures = this.db.executions.consecutiveFailures(job.workflow);
        const max = job.maxFailures || 3;
        if (failures >= max) {
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
      if (this.running.has(job.name)) {
        return;
      }

      this.running.add(job.name);
      try {
        await job.handler();
      } catch (err: unknown) {
        log.error("Job failed", { job: job.name, err });
      } finally {
        this.running.delete(job.name);
      }
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

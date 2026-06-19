import { Cron } from "croner";
import type { StateDb } from "../state/db.js";

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
        console.log(`[cron] Skipping ${job.name} — still running from previous tick`);
        return;
      }

      this.running.add(job.name);
      console.log(`[cron] Running: ${job.name}`);

      try {
        await this.runner(job.workflow, job.context);
      } catch (err: any) {
        console.error(`[cron] ${job.name} failed:`, err.message);

        // Check consecutive failures (tracked under the workflow name)
        const failures = this.db.executions.consecutiveFailures(job.workflow);
        const max = job.maxFailures || 3;
        if (failures >= max) {
          console.error(`[cron] ALERT: ${job.name} has failed ${failures} times consecutively`);
          // TODO: send alert (Slack webhook, email, etc.)
        }
      } finally {
        this.running.delete(job.name);
      }
    });

    this.jobs.set(job.name, cronJob);
    console.log(`[cron] Registered: ${job.name} (${job.schedule})`);
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
      } catch (err: any) {
        console.error(`[cron] ${job.name} failed:`, err.message);
      } finally {
        this.running.delete(job.name);
      }
    });

    this.jobs.set(job.name, cronJob);
    console.log(`[cron] Registered: ${job.name} (${job.schedule})`);
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
    console.log(`[cron] Stopped: ${name}`);
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
      console.log(`[cron] Stopped: ${name}`);
    }
    this.jobs.clear();
  }
}

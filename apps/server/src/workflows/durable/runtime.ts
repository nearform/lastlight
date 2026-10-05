/**
 * OpenWorkflow-backed durable runtime for code-defined workflows (spike — see
 * docs/plans/durable-workflows/).
 *
 * OpenWorkflow is embedded: a polling worker inside this process claims runs
 * from its own SQLite file (it uses `node:sqlite`, and its schema has a
 * `workflow_runs` table, so it cannot share the libsql state DB). Steps are
 * checkpointed; a parked or crashed run is re-invoked from the top and every
 * completed step replays from its persisted output.
 */

import { OpenWorkflow } from "openworkflow";
import { BackendSqlite } from "openworkflow/sqlite";
import {
  approvalSignal,
  createWorkflowContext,
  type ApprovalDecision,
  type DurableStep,
  type LastLightWorkflow,
  type WorkflowInput,
  type WorkflowOutcome,
  type WorkflowServices,
} from "lastlight-workflow-engine/durable";
import { logger } from "../../logging/logger.js";

const log = logger("durable-runtime");

type DurationString = Parameters<DurableStepApi["sleep"]>[1];
type DurableStepApi = Parameters<Parameters<OpenWorkflow["defineWorkflow"]>[1]>[0]["step"];
type Spec = ReturnType<OpenWorkflow["defineWorkflow"]>;
type RunRow = Awaited<ReturnType<BackendSqlite["getWorkflowRun"]>>;
type StepRow = Awaited<ReturnType<BackendSqlite["listStepAttempts"]>>["data"][number];

export interface DurableRunHandle {
  runId: string;
  result(timeoutMs?: number): Promise<WorkflowOutcome>;
}

export class DurableRuntime {
  private readonly backend: BackendSqlite;
  private readonly ow: OpenWorkflow;
  private readonly specs = new Map<string, Spec>();
  private worker?: ReturnType<OpenWorkflow["newWorker"]>;

  constructor(dbPath: string, private readonly services: WorkflowServices) {
    this.backend = BackendSqlite.connect(dbPath);
    this.ow = new OpenWorkflow({ backend: this.backend });
  }

  register(wf: LastLightWorkflow): void {
    const spec = this.ow.defineWorkflow({ name: wf.name, version: wf.version }, async ({ input, step, run }) => {
      const durable: DurableStep = {
        run: (name, fn) => step.run({ name }, fn as () => Promise<never>),
        waitForSignal: (name, signal, timeout) =>
          step.waitForSignal({ name, signal, timeout: timeout as DurationString | undefined }),
        sleep: (name, duration) => step.sleep(name, duration as DurationString),
      };
      const ctx = createWorkflowContext(durable, this.services, run.id, input as WorkflowInput);
      return (await wf.run(ctx)) as never;
    });
    this.specs.set(wf.name, spec);
  }

  async start(name: string, input: WorkflowInput, idempotencyKey?: string): Promise<DurableRunHandle> {
    const spec = this.specs.get(name);
    if (!spec) throw new Error(`durable workflow "${name}" is not registered`);
    const handle = await spec.run(input as never, idempotencyKey ? { idempotencyKey } : undefined);
    return {
      runId: handle.workflowRun.id,
      result: (timeoutMs) => handle.result(timeoutMs ? { timeoutMs } : undefined) as Promise<WorkflowOutcome>,
    };
  }

  /** Deliver a gate decision. Returns false when the run was not parked on that gate. */
  async resolveApproval(runId: string, gate: string, decision: ApprovalDecision): Promise<boolean> {
    const { workflowRunIds } = await this.ow.sendSignal({
      signal: approvalSignal(runId, gate),
      data: decision as never,
      idempotencyKey: `${runId}:${gate}`,
    });
    if (workflowRunIds.length === 0) log.warn("approval signal had no waiter", { runId, gate });
    return workflowRunIds.length > 0;
  }

  async getRun(runId: string): Promise<RunRow> {
    return this.backend.getWorkflowRun({ workflowRunId: runId });
  }

  /**
   * A run parked on a signal wait or sleep. OpenWorkflow reports such a run
   * as `running` (or `sleeping`) with no worker lease and a future
   * `availableAt`, not as a distinct status.
   */
  async isParked(runId: string): Promise<boolean> {
    const run = await this.getRun(runId);
    if (!run || !["running", "sleeping"].includes(run.status)) return false;
    return run.workerId === null && run.availableAt !== null && run.availableAt.getTime() > Date.now();
  }

  async listSteps(runId: string): Promise<StepRow[]> {
    return (await this.backend.listStepAttempts({ workflowRunId: runId, limit: 1000 })).data;
  }

  async cancel(runId: string): Promise<void> {
    await this.ow.cancelWorkflowRun(runId);
  }

  /** Start the background polling worker (server mode). */
  async startWorker(concurrency = 4): Promise<void> {
    this.worker = this.ow.newWorker({ concurrency });
    await this.worker.start();
  }

  /** Claim and run whatever is due, once (tests / evals drive this directly). */
  async tick(): Promise<number> {
    this.worker ??= this.ow.newWorker();
    return this.worker.tick();
  }

  async stop(): Promise<void> {
    await this.worker?.stop();
    await this.backend.stop();
  }
}

import { randomUUID } from "node:crypto";
import {
  PhaseRef,
  buildPhasePrompt,
  isSoftOutcome,
  phaseConfigFor,
  renderTemplate,
  resolveTemplatedNumber,
  runLedgeredPhase,
  validateShellCommand,
  OPENINFERENCE_CHAIN,
  OPENINFERENCE_SPAN_KIND,
} from "lastlight-workflow-engine";
import type {
  AssetLoader,
  DagNode,
  ExecutionResult,
  ExecutorConfig,
  FanoutBranch,
  GitSandboxAccess,
  LedgerDeps,
  PhaseDefinition,
  PhaseOutcome,
  PhaseReporter,
  PhaseResolver,
  PhaseResult,
  PhaseTypeHandler,
  TemplateContext,
  WorkflowStateStore,
} from "lastlight-workflow-engine";
import { withAgentSession } from "../../engine/agent-executor.js";
import type { SandboxSession } from "../../engine/executors/orchestrator.js";
import type { SandboxBackend } from "../../config/config.js";
import type { SandboxFactory } from "../../sandbox/sandbox.js";
import { safeSpanAttributes, withSpan } from "../../telemetry/index.js";
import { OI, SpanKind, splitProviderModel } from "../../telemetry/openinference.js";
import { logger } from "../../logging/logger.js";

const log = logger("fanout");

/**
 * How many agent sessions a backend may have in flight against ONE provisioned
 * workspace.
 *
 * This is the safety valve, and the asymmetry in it is the whole point.
 *
 *  - **`none`** runs agentic-pi in the harness process. `InProcessSandbox.runAgent`
 *    holds no per-call mutable state — every per-run value (`githubAuthEnv`,
 *    `authFile`, `sandboxEnv`, `cwd`, `allowedHttpHosts`) travels as an explicit
 *    argument, and issue #215 made that true *precisely because* concurrent
 *    in-process runs share `process.env`. So N concurrent turns are safe, and
 *    this is the backend the eval harness uses.
 *  - **`docker`** is N `docker exec`s into the one container the phase already
 *    provisioned.
 *  - **`gondolin`** boots a QEMU micro-VM per agent session, inside the harness
 *    process. That is WP5's D7 exactly, and the nearform host has no swap, a
 *    hard agent memory cap, and has wedged under memory pressure before.
 *  - **`smol` / `kubernetes`** are simply unverified for concurrent turns.
 *
 * The last three clamp to 1, which runs the branches sequentially — byte-identical
 * to the chained phases this replaced. That costs nothing today: the review
 * evidence pipeline cannot run in production at all until `lastlight-facts` is
 * in the sandbox image (WP2), and until then the only thing that fans out is the
 * eval harness on `none`.
 */
const BACKEND_MAX_CONCURRENT: Record<SandboxBackend, number> = {
  none: 6,
  docker: 6,
  gondolin: 1,
  smol: 1,
  kubernetes: 1,
};

/** Absent `on_branch_soft_failure` ⇒ no retry, and one soft branch never fails the phase. */
const DEFAULT_BRANCH_SOFT_POLICY = { retries: 0, then: "complete" as const };

/** Run-scoped data the `fanout` handler needs. */
export interface FanoutRunScope {
  workflowName: string;
  ctx: TemplateContext;
  config: ExecutorConfig;
  /** Single workspace shared by every phase + branch of the run. */
  taskId: string;
  triggerId: string;
  githubAccess: GitSandboxAccess;
  backend: SandboxBackend;
  assets: AssetLoader;
  resolver: PhaseResolver;
  store?: WorkflowStateStore;
  workflowId?: string;
  ledger: Omit<LedgerDeps, "store">;
  /**
   * The two quota hooks `runner.ts` wraps its `AgentPort` in. A fan-out branch
   * bypasses that port (it drives an already-provisioned sandbox directly), so
   * without these a k8s ResourceQuota rejection inside a branch would fail the
   * run red instead of requeueing it as backpressure.
   */
  observeResult: (r: ExecutionResult) => ExecutionResult;
  observeError: (err: unknown) => never;
  /** Test seam — substitute a FakeSandbox. Defaults to the real factory. */
  sandboxFactory?: SandboxFactory;
}

/** What one branch produced, in declaration order. */
interface BranchOutcome {
  branch: FanoutBranch;
  label: string;
  result: ExecutionResult;
  /** A dedup hit on resume — the work was already done, don't re-report it. */
  deduped: boolean;
}

/**
 * Bounded, order-preserving concurrent map. Results land at their input index
 * however the pool interleaves, so `branches[i]` always pairs with `out[i]` —
 * a fan-out that reported its families in completion order would make two runs
 * of the same case diff against each other for no reason.
 */
async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      out[i] = await fn(items[i], i);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return out;
}

/**
 * The `type: fanout` phase — N agent sessions run CONCURRENTLY inside ONE
 * provisioned workspace, as a single DAG node.
 *
 * **Why this exists rather than parallel phases.** Real DAG concurrency is
 * parked (`docs/plans/review-evidence-pipeline/05-parallel-phases.md`) behind
 * four hard blockers and seven design changes, and that document says why in one
 * sentence: *"Every hard blocker below — B1, D1, D2, D7 — exists because each
 * phase provisions its own sandbox against a shared workspace. A fan-out inside
 * one agent has none of them."* One node means one workspace (B1), one
 * `current_phase` (B4), one terminal transition (D5), one provisioning pass so
 * no `ensureBaseAvailable` git-lock contention (D1/D2), one artifact
 * stage/harvest (D3), and one `outputs` writer (D4). B2 — a sibling's success
 * overwriting a `paused` run and orphaning its approval row, the item that doc
 * calls the worst in the list — is refused at the schema instead: a fanout phase
 * may not declare an approval gate.
 *
 * **What it gives up, and buys back.** A DAG node per branch is genuinely lost:
 * six survey families are one node now, retried as one. What is NOT lost is the
 * per-branch `executions` row — each branch goes through the same
 * {@link runLedgeredPhase} every other phase does, keyed
 * `<phase>_branch_<name>`, so resume, dedup, cost attribution and the
 * dashboard's longest-prefix grouping all keep working. `05-parallel-phases.md`
 * listed exactly those as the price of an in-agent fan-out; the ledger key is
 * how it goes unpaid.
 */
export class FanoutHandler implements PhaseTypeHandler {
  constructor(
    private readonly run: FanoutRunScope,
    private readonly reporter: PhaseReporter,
  ) {}

  async execute(
    phase: PhaseDefinition,
    _node: DagNode,
    outputs: Readonly<Record<string, unknown>>,
  ): Promise<PhaseOutcome> {
    const phaseName = phase.name;
    const branches = phase.branches ?? [];
    await this.reporter.onStart(phaseName);
    await this.reporter.step(phaseName, "running", phase.messages?.on_start);

    const concurrency = this.resolveConcurrency(phase, branches.length);
    const policy = phase.on_branch_soft_failure ?? DEFAULT_BRANCH_SOFT_POLICY;

    let outcomes: BranchOutcome[];
    try {
      outcomes = await withAgentSession(
        this.phaseConfig(phase),
        {
          taskId: this.run.taskId,
          githubAccess: this.run.githubAccess,
          sandboxFactory: this.run.sandboxFactory,
        },
        async (session) => {
          const ran = await mapPool(branches, concurrency, (branch) =>
            this.runBranch(session, phase, branch, outputs, policy),
          );
          // Gates run AFTER the join, and SEQUENTIALLY. `InProcessSandbox.runCommand`
          // is a `spawnSync` — it blocks the event loop — so interleaving a gate
          // with the agent turns would serialise the whole fan-out on the very
          // backend (`none`) the fan-out exists to speed up.
          for (const outcome of ran) {
            if (outcome.deduped) continue;
            await this.runBranchGate(session, phase, outcome);
          }
          return ran;
        },
      );
    } catch (err: unknown) {
      // A provisioning failure, or a mint that could not happen. One error for
      // the whole fan-out, because there was one workspace to fail.
      this.run.observeError(err);
    }

    return this.report(phase, outcomes, policy);
  }

  // ── Branches ───────────────────────────────────────────────────────────────

  /**
   * Run one branch, with the one-shot soft retry `on_branch_soft_failure`
   * describes. A HARD failure (terminated / fatal / tool error / non-zero exit)
   * is never retried — that is `isSoftOutcome`'s split, shared with the reviewer
   * and generic loops so all three stay in lockstep.
   */
  private async runBranch(
    session: SandboxSession,
    phase: PhaseDefinition,
    branch: FanoutBranch,
    outputs: Readonly<Record<string, unknown>>,
    policy: { retries: number; then: "fail" | "complete" },
  ): Promise<BranchOutcome> {
    const label = PhaseRef.branch(phase.name, branch.name).format();

    // A branch opens and closes its OWN phase window, exactly as
    // `PhaseExecutor.runStandard` does for a phase. Both hooks are pass-throughs
    // to the caller's `onPhaseStart`/`onPhaseEnd` (`runner.ts`), no-ops when a
    // caller supplies none — so this is inert in production and is the only
    // signal an external consumer has that a branch ran at all. Without it the
    // evals harness measured the parent window, found no row to hang it on, and
    // silently dropped 61% of a case's cost on the floor.
    //
    // `finally`, because a window this side opened must not be left open by a
    // throw: the consumer's rule for an unclosed window is indistinguishable
    // from "never started".
    await this.reporter.onStart(label);
    let outcome: BranchOutcome | undefined;
    try {
      outcome = await this.runBranchAttempts(session, phase, branch, label, outputs, policy);
      return outcome;
    } finally {
      await this.reporter.onEnd(
        label,
        outcome
          ? {
              phase: label,
              success: outcome.result.success,
              output: outcome.result.output ?? "",
              error: outcome.result.success ? undefined : outcome.result.error,
            }
          : { phase: label, success: false, output: "", error: "fan-out branch threw" },
      );
    }
  }

  /** The attempt loop — one branch's agent turn plus its one-shot soft retry. */
  private async runBranchAttempts(
    session: SandboxSession,
    phase: PhaseDefinition,
    branch: FanoutBranch,
    label: string,
    outputs: Readonly<Record<string, unknown>>,
    policy: { retries: number; then: "fail" | "complete" },
  ): Promise<BranchOutcome> {
    const prompt = buildPhasePrompt(this.branchPhase(phase, branch, label), this.run.ctx, this.run.assets, {
      phaseOutputs: outputs,
    });

    let attempt = 0;
    for (;;) {
      const attemptLabel =
        attempt === 0 ? label : PhaseRef.branchRetry(phase.name, branch.name).format();
      const pr = await this.runBranchOnce(session, phase, branch, attemptLabel, prompt);

      if (pr.skipped) {
        // `running` (another instance owns this row) and `done` (resume) both
        // mean "not ours to do". A fan-out cannot abort the run the way a
        // standard phase does — its five siblings are mid-flight — so both are
        // reported as a non-failing no-op and the phase carries on.
        return {
          branch,
          label,
          deduped: true,
          result: { success: true, output: "", turns: 0, durationMs: 0 },
        };
      }

      const result = this.run.observeResult(pr.result);
      const soft = !result.success && isSoftOutcome(result);
      if (!soft || attempt >= policy.retries) return { branch, label, result, deduped: false };

      log.info("fan-out branch came back soft — retrying once", {
        phase: phase.name,
        branch: branch.name,
        stopReason: result.stopReason,
      });
      attempt += 1;
    }
  }

  /** One ledgered agent turn for a branch, under its own AGENT span. */
  private async runBranchOnce(
    session: SandboxSession,
    phase: PhaseDefinition,
    branch: FanoutBranch,
    label: string,
    prompt: string,
  ) {
    const { workflowName, taskId, triggerId, githubAccess, workflowId, backend } = this.run;
    const config = this.branchConfig(phase, branch, label);
    const model = config.model;

    const attrs = {
      "workflow.name": workflowName,
      "phase.name": label,
      "workflow.run_id": workflowId,
      "trigger.id": triggerId,
      "task.id": taskId,
      repo: githubAccess.owner ? `${githubAccess.owner}/${githubAccess.repo}` : githubAccess.repo,
      "sandbox.backend": backend,
      "fanout.parent": phase.name,
      "fanout.branch": branch.name,
      model,
      [OPENINFERENCE_SPAN_KIND]: OPENINFERENCE_CHAIN,
    };

    return runLedgeredPhase(
      attrs,
      {
        dedupKey: `${workflowName}:${label}`,
        phaseName: label,
        taskId,
        triggerId,
        repo: githubAccess.repo,
        owner: githubAccess.owner,
        workflowRunId: workflowId,
      },
      { ...this.run.ledger, store: this.run.store },
      (onSessionId) => {
        const { system, modelName } = splitProviderModel(model ?? "");
        const spanAttrs = safeSpanAttributes({
          "agent.runtime": "agentic-pi",
          "sandbox.backend": backend,
          "task.id": taskId,
          repo: githubAccess.repo,
          "github.profile": githubAccess.profile,
          model,
          variant: config.variant,
          "fanout.parent": phase.name,
          "fanout.branch": branch.name,
          "workflow.name": workflowName,
          "phase.name": label,
          [OI.SPAN_KIND]: SpanKind.AGENT,
          ...(modelName ? { [OI.LLM_MODEL_NAME]: modelName } : {}),
          ...(system ? { [OI.LLM_SYSTEM]: system } : {}),
        });
        // The AGENT span is opened per branch and nests under the phase span
        // `runLedgeredPhase` just opened. `withSpan` runs on the OTel
        // AsyncLocalStorage context manager and `AgentSpanTree` snapshots its
        // parent in the constructor, so concurrent branches do not mis-parent
        // each other's turn/tool spans.
        return withSpan("lastlight.agent.execute", spanAttrs, (span) =>
          session.runAgent(prompt, config, { onSessionId, span }),
        );
      },
    );
  }

  /**
   * A branch's `until_bash`, recorded as its own `<phase>_branch_<name>_check`
   * row.
   *
   * Observational, and that is not a weakening — it is what the six chained
   * survey phases already did. Each declared `generic_loop: { max_iterations: 1,
   * until_bash: … }`, and with one iteration the gate can never cause a re-run:
   * it runs once, records `condition_met` / `condition_not_met`, and the loop
   * ends either way. Reproducing that exactly is what makes this a speed change
   * rather than a behaviour change.
   *
   * Like the generic loop's check row it bypasses the dedup ledger: a condition
   * must be re-evaluated every time it is asked, and `success` records whether
   * the check RAN, not what it said.
   */
  private async runBranchGate(
    session: SandboxSession,
    phase: PhaseDefinition,
    outcome: BranchOutcome,
  ): Promise<void> {
    const command = outcome.branch.until_bash?.trim();
    if (!command) return;

    const { workflowName, triggerId, githubAccess, workflowId, store: db } = this.run;
    const label = PhaseRef.branchCheck(phase.name, outcome.branch.name).format();
    const startedAt = Date.now();
    const executionId = db ? randomUUID() : undefined;

    if (db && executionId) {
      try {
        await db.executions.recordStart({
          id: executionId,
          triggerType: "webhook",
          triggerId,
          skill: `${workflowName}:${label}`,
          owner: githubAccess.owner,
          repo: githubAccess.repo,
          startedAt: new Date(startedAt).toISOString(),
          workflowRunId: workflowId,
        });
      } catch (err) {
        log.warn("Failed to record fan-out branch check row", { label, err });
      }
    }

    let met = false;
    let error: string | undefined;
    try {
      validateShellCommand(command);
      const res = await session.runCommand(
        { kind: "bash", command },
        this.branchConfig(phase, outcome.branch, label),
        { timeoutSeconds: this.gateTimeoutSeconds(phase, outcome.branch), writeSession: false },
      );
      met = res.success;
    } catch (err) {
      error = err instanceof Error ? err.message : String(err);
    }

    if (!met) {
      log.info("fan-out branch gate did not close", {
        phase: phase.name,
        branch: outcome.branch.name,
        error,
      });
    }

    if (db && executionId) {
      try {
        await db.executions.recordFinish(executionId, {
          success: error === undefined,
          error,
          turns: 0,
          durationMs: Date.now() - startedAt,
          stopReason: error !== undefined ? "error_fatal" : met ? "condition_met" : "condition_not_met",
        });
      } catch (err) {
        log.warn("Failed to finish fan-out branch check row", { label, err });
      }
    }
  }

  // ── Reporting ──────────────────────────────────────────────────────────────

  /**
   * Fold the branches into one node outcome.
   *
   * `then: "complete"` (the default) is what makes a fan-out a fan-out: it
   * gathers independent evidence, so one branch coming back empty must not
   * discard the other five. The six survey phases already had this — a chained
   * phase with `on_soft_failure: { retries: 1, then: complete }` — and it was
   * worth having: without it a single degenerate turn hard-failed the run, which
   * records no `assessedHeadShaByWorkflow` and hands `cron-review.yaml` something
   * to re-dispatch every thirty minutes forever.
   *
   * A HARD branch failure still fails the phase. That is not the soft policy's
   * business, and a fan-out where every branch crashed is not a success.
   */
  private async report(
    phase: PhaseDefinition,
    outcomes: BranchOutcome[],
    policy: { retries: number; then: "fail" | "complete" },
  ): Promise<PhaseOutcome> {
    const results: PhaseResult[] = outcomes.map((o) => ({
      phase: o.label,
      success: o.result.success || (isSoftOutcome(o.result) && policy.then === "complete"),
      output: o.result.output ?? "",
      error: o.result.success ? undefined : o.result.error,
    }));

    const failed = results.filter((r) => !r.success);
    const succeeded = results.length - failed.length;
    const summary =
      `${succeeded}/${results.length} branches` +
      (failed.length ? ` (failed: ${failed.map((r) => r.phase).join(", ")})` : "");

    // Every branch's output is addressable downstream under its own label, and
    // the phase's own key carries the joined text so `{{phaseOutputs.<phase>}}`
    // and an `output_var` keep meaning something.
    const outputVars: Record<string, unknown> = {};
    for (const o of outcomes) outputVars[o.label] = o.result.output ?? "";
    const joined = outcomes.map((o) => o.result.output ?? "").join("\n\n");
    outputVars[phase.name] = joined;
    if (phase.output_var) outputVars[phase.output_var] = joined;

    if (failed.length === results.length && results.length > 0) {
      const error = `every fan-out branch failed: ${failed.map((r) => r.error ?? r.phase).join("; ")}`;
      await this.reporter.onEnd(phase.name, { phase: phase.name, success: false, output: "", error });
      await this.reporter.step(phase.name, "failed", phase.messages?.on_failure);
      return { results, status: "failed", outputVars };
    }

    await this.reporter.persistPhase(phase.name, summary);
    await this.reporter.onEnd(phase.name, { phase: phase.name, success: true, output: joined });
    await this.reporter.step(phase.name, "done", phase.messages?.on_success);
    return { results, status: "succeeded", outputVars };
  }

  // ── Resolution helpers ─────────────────────────────────────────────────────

  /**
   * `min(declared, backend ceiling)`, logged when the host has the last word so
   * an operator who set `max_concurrent: 6` and saw sequential timings can find
   * out why from the log rather than from this file.
   */
  private resolveConcurrency(phase: PhaseDefinition, branchCount: number): number {
    const declared = resolveTemplatedNumber(
      phase.max_concurrent,
      this.run.ctx,
      `${phase.name}.max_concurrent`,
      this.run.ledger.logger,
    );
    const wanted = Math.max(1, declared ?? branchCount);
    const ceiling = BACKEND_MAX_CONCURRENT[this.run.backend] ?? 1;
    const effective = Math.min(wanted, ceiling, Math.max(1, branchCount));
    if (effective < wanted) {
      log.info("clamping fan-out concurrency for this backend", {
        phase: phase.name,
        backend: this.run.backend,
        requested: wanted,
        effective,
        reason:
          this.run.backend === "gondolin"
            ? "gondolin boots a QEMU micro-VM per agent session in the harness process"
            : "concurrent agent turns are unverified on this backend",
      });
    }
    return effective;
  }

  /** The phase-level config — what opens the shared session. */
  private phaseConfig(phase: PhaseDefinition): ExecutorConfig {
    const { model, variant } = this.resolveModelVariant(phase.model, phase.variant, phase.name);
    const base = phaseConfigFor(this.run.config, phase, this.run.assets);
    return {
      ...base,
      ...(model ? { model } : {}),
      ...(variant ? { variant } : {}),
      telemetry: {
        workflowName: this.run.workflowName,
        phaseName: phase.name,
        triggerId: this.run.triggerId,
        workflowRunId: this.run.workflowId,
      },
    };
  }

  /**
   * The per-branch config. Two things vary and both matter:
   * `telemetry.phaseName` (which is `skillBundleKey`, so each branch stages into
   * its OWN `.lastlight-skills/<label>/` and concurrent branches cannot clobber
   * each other's catalogue) and `skillPaths` when the branch overrides skills.
   */
  private branchConfig(phase: PhaseDefinition, branch: FanoutBranch, label: string): ExecutorConfig {
    const { model, variant } = this.resolveModelVariant(
      branch.model ?? phase.model,
      branch.variant ?? phase.variant,
      label,
      phase.name,
    );
    const base = phaseConfigFor(this.run.config, this.branchPhase(phase, branch, label), this.run.assets);
    return {
      ...base,
      ...(model ? { model } : {}),
      ...(variant ? { variant } : {}),
      telemetry: {
        workflowName: this.run.workflowName,
        phaseName: label,
        triggerId: this.run.triggerId,
        workflowRunId: this.run.workflowId,
      },
    };
  }

  /**
   * The branch as a phase-shaped object, for the two engine helpers that take
   * one (`buildPhasePrompt`, `phaseConfigFor`).
   *
   * Built by hand rather than by spreading the branch over the phase: a spread
   * would carry `until_bash` and `branches` into something that looks like a
   * PhaseDefinition, and the prompt-cache ordering (§D4 — shared prefix first,
   * the family's obligations last) depends on this going through exactly the
   * same `buildPhasePrompt` path the six chained phases used.
   */
  private branchPhase(phase: PhaseDefinition, branch: FanoutBranch, label: string): PhaseDefinition {
    return {
      name: label,
      type: "agent",
      prompt: branch.prompt ?? phase.prompt,
      skill: branch.skills ? undefined : (branch.skill ?? (branch.skills ? undefined : phase.skill)),
      skills: branch.skills ?? (branch.skill ? undefined : phase.skills),
      unrestricted_egress: phase.unrestricted_egress,
      web_search: phase.web_search,
      sandbox_image: phase.sandbox_image,
    } as PhaseDefinition;
  }

  /** Mirrors `PhaseExecutor.resolveModelVariant` — YAML template first, then the resolver. */
  private resolveModelVariant(
    template: string | undefined,
    variantTemplate: string | undefined,
    taskName: string,
    fallbackTask?: string,
  ): { model?: string; variant?: string } {
    const render = (t: string | undefined): string | undefined =>
      t ? renderTemplate(t, this.run.ctx) : undefined;
    const model =
      render(template) || this.run.resolver.modelFor(taskName) ||
      (fallbackTask ? this.run.resolver.modelFor(fallbackTask) : undefined);
    const variant =
      render(variantTemplate) || this.run.resolver.variantFor(taskName) ||
      (fallbackTask ? this.run.resolver.variantFor(fallbackTask) : undefined);
    return { model, variant };
  }

  private gateTimeoutSeconds(phase: PhaseDefinition, branch: FanoutBranch): number {
    return (
      resolveTemplatedNumber(
        branch.timeout_seconds ?? phase.timeout_seconds,
        this.run.ctx,
        `${phase.name}.${branch.name}.timeout_seconds`,
        this.run.ledger.logger,
      ) ?? 30
    );
  }
}

/** Build the app-registered `fanout` phase-type handler for a run. */
export function makeFanoutHandler(run: FanoutRunScope, reporter: PhaseReporter): PhaseTypeHandler {
  return new FanoutHandler(run, reporter);
}

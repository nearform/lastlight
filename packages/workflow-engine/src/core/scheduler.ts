import type { AgentWorkflowDefinition } from "./schema.js";
import { phaseSkipIfExpressions } from "./schema.js";
import type { TemplateContext } from "./templates.js";
import { renderTemplate } from "./templates.js";
import { evalSkipIf } from "./loop-eval.js";
import { buildDag, getReadyNodes, getNodesToSkip, isComplete } from "./dag.js";
import { PhaseExecutor, type PhaseRunContext } from "./phase-executor.js";
import { OPENINFERENCE_CHAIN, OPENINFERENCE_SPAN_KIND } from "./types.js";
import type {
  EnginePorts,
  PhaseReporter,
  PhaseResolver,
  PhaseResult,
  WorkflowResult,
  WorkflowStateStore,
} from "../ports/ports.js";

/**
 * Host capabilities the scheduler consults for the `requires_sandbox` /
 * `sandbox_image: qa` gates. Injected (docker-free) so the engine core never
 * imports `../sandbox`.
 */
export interface HostCapabilities {
  qaImageAvailable: () => boolean;
  qaImageName: string;
}

/** The injected collaborators + seams a scheduled workflow run needs. */
export interface SchedulerDeps {
  reporter: PhaseReporter;
  resolver: PhaseResolver;
  ports: EnginePorts;
  store?: WorkflowStateStore;
  /**
   * Whether a rich progress surface (ProgressReporter) is active — gates the
   * terminal completion ping + the PR-link step, which only fire on surfaces
   * that opt in (Slack). Plain GitHub runs leave the edited checklist as-is.
   */
  reporterActive: boolean;
  capabilities: HostCapabilities;
}

/**
 * Run an agent workflow defined by a YAML definition — the engine's scheduler.
 *
 * Every workflow executes as a DAG: workflows that declare no `depends_on`
 * are run as a synthesized chain (each phase depends on the one before it),
 * reproducing the old linear semantics including the failure cascade. Ready
 * nodes are executed **one at a time in declaration order** (sequential).
 * Each node's body — context / standard agent / reviewer-loop / generic-loop,
 * plus approval and reply gates — lives in {@link PhaseExecutor}; the scheduler
 * here owns the DAG, the `phases[]`/`outputs{}` accumulation, and the in-memory
 * node status.
 *
 * The app-side composition root (`src/workflows/runner.ts`) builds `runScope`
 * (the {@link PhaseRunContext}) plus `deps` and delegates here; the frozen
 * 9-arg `runWorkflow(...)` signature is preserved there.
 */
export async function runWorkflowCore(
  runScope: PhaseRunContext,
  deps: SchedulerDeps,
  // Shared with the composition root's notify/render closures so a message
  // template referencing `{{phaseOutputs.*}}` sees the accumulating map (the
  // app builds those closures over this same reference). Defaults to a fresh
  // map when driven standalone.
  outputs: Record<string, unknown> = {},
): Promise<WorkflowResult> {
  const { definition, ctx, config, triggerId, githubAccess, workflowId } = runScope;
  const { reporter, resolver, ports, store: db, reporterActive, capabilities } = deps;

  // The run-level span — the CHAIN root the phase (CHAIN) and agent (AGENT) spans
  // nest under, so a Phoenix trace renders workflow → phase → agent → turn → tool.
  const runSpanAttrs = {
    "workflow.name": definition.name,
    "workflow.run_id": workflowId,
    "trigger.id": triggerId,
    repo: githubAccess.repo,
    "sandbox.backend": config.sandbox,
    [OPENINFERENCE_SPAN_KIND]: OPENINFERENCE_CHAIN,
  };
  return ports.observability.withSpan("lastlight.workflow.run", runSpanAttrs, async () => {

  const phases: PhaseResult[] = [];

  const notify = (text: string) => reporter.postNote(text);
  const reportStep = reporter.step.bind(reporter);

  const executor = new PhaseExecutor(runScope, reporter, resolver, ports);

  // ── Schedule ─────────────────────────────────────────────────────────────────

  const dag = buildDag(definition.phases, { chainIfNoDeps: true });

  // Phase lookup + the backend this run is actually executing on. Used by the
  // `requires_sandbox` gate below — config.sandbox is undefined when no backend
  // override is set, which resolves to gondolin (see agent-executor).
  const phaseByName = new Map(definition.phases.map((p) => [p.name, p]));
  const activeBackend = config.sandbox ?? "gondolin";

  while (!isComplete(dag)) {
    // Honour a cancel that landed during the previous phase's execution, and
    // re-read the run row's scratch while we are here.
    if (db && workflowId) {
      const latest = db.runs.getRun(workflowId);
      if (latest?.status === "cancelled") {
        console.log(`[runner] ${definition.name} cancelled — stopping`);
        return { success: false, phases };
      }
      // `runScope.scratch` is loaded ONCE, before the first phase. The HOST also
      // writes to the row mid-run through `mergeScratch` from its `onPhaseEnd`
      // hook — lastlight-core's fix-marker harvest does exactly that — and this
      // process cannot see those writes. So the `skip_if` gate below would
      // evaluate `scratch.*` against the pre-run snapshot on a fresh run and only
      // see the real value across a resume (where the row is re-read at startup):
      // a guard that silently does nothing on the path it was written for, which
      // is the failure shape `skip_if` exists to avoid.
      //
      // Mutated in place, never replaced: `ctx.scratch` aliases this object so
      // `{{scratch.*}}` templates and the loop nodes' own slots keep resolving.
      // The row is authoritative because every in-engine scratch write is paired
      // with a `mergeScratch` of the same value.
      if (latest?.scratch) Object.assign(runScope.scratch, latest.scratch);
    }

    // Skip nodes whose trigger rule fails (deps terminal, rule unsatisfied).
    // This is how a failure cascades to the end of a chain as skips. Skips are
    // recorded in the executions ledger — the single source of truth the
    // dashboard derives phase status from.
    const toSkip = getNodesToSkip(dag);
    for (const node of toSkip) {
      node.status = "skipped";
      phases.push({ phase: node.name, success: true, output: "Skipped (trigger rule not satisfied)" });
      db?.executions.recordSkippedPhase(
        `${definition.name}:${node.name}`,
        triggerId,
        workflowId,
        githubAccess.repo,
      );
      await reportStep(node.name, "skipped");
    }

    const ready = getReadyNodes(dag);

    // Capability / conditional gate: skip any ready node that shouldn't run.
    // Safe-by-default graceful degradation — a gated phase (e.g. the browser-QA
    // step that needs the docker image) silently no-ops instead of failing the
    // workflow. Three reasons trigger a skip:
    //   1. `requires_sandbox` names a backend other than the one running.
    //   2. `sandbox_image: qa` but the browser-QA image isn't built here (only
    //      checked on docker — on other backends the field is inert).
    //   3. `skip_if` matches the run's render context — the phase is not
    //      *unavailable*, it is *unnecessary* (the fix phase after a diagnosis
    //      that says there is nothing to fix here). Evaluated only once the
    //      node is ready, so an upstream phase's output is already in `outputs`.
    // Uses the same non-failing skip mechanics as the trigger-rule skip above,
    // plus the phase's `on_skipped_done` message so the user sees why. All
    // three keep the RUN `succeeded`: a correct "nothing to do" is not a
    // failure (see `skip_if` in core/schema.ts for why that matters).
    const gatedSkip: { node: (typeof ready)[number]; reason: string }[] = [];
    for (const node of ready) {
      const phaseDef = phaseByName.get(node.name);
      const req = phaseDef?.requires_sandbox;
      if (req !== undefined && req !== activeBackend) {
        gatedSkip.push({ node, reason: `requires ${req} sandbox; running ${activeBackend}` });
      } else if (
        phaseDef?.sandbox_image === "qa" &&
        activeBackend === "docker" &&
        !capabilities.qaImageAvailable()
      ) {
        gatedSkip.push({ node, reason: `requires the ${capabilities.qaImageName} image, not built on this host` });
      } else if (phaseDef) {
        const exprs = phaseSkipIfExpressions(phaseDef);
        const matched = exprs.length
          ? evalSkipIf(exprs, { ...ctx, phaseOutputs: outputs, scratch: runScope.scratch, output: "" })
          : undefined;
        if (matched) gatedSkip.push({ node, reason: `skip_if matched: ${matched}` });
      }
    }
    if (gatedSkip.length > 0) {
      for (const { node, reason } of gatedSkip) {
        node.status = "skipped";
        const phaseDef = phaseByName.get(node.name);
        phases.push({
          phase: node.name,
          success: true,
          output: `Skipped (${reason})`,
        });
        db?.executions.recordSkippedPhase(
          `${definition.name}:${node.name}`,
          triggerId,
          workflowId,
          githubAccess.repo,
        );
        await reportStep(node.name, "skipped", phaseDef?.messages?.on_skipped_done);
      }
      continue; // re-evaluate the DAG with these nodes now terminal
    }

    if (ready.length === 0) {
      if (toSkip.length === 0) break; // stuck (shouldn't happen in a valid DAG)
      continue; // only had skips — loop to process downstream
    }

    // Sequential: run the earliest-declared ready node, one at a time.
    // Resume is ledger-driven: a completed phase's `runPhase` call returns
    // skipped:done via `shouldRunPhase`, so re-running from the top is safe.
    const node = ready[0];
    node.status = "running";

    let outcome;
    try {
      outcome = await executor.execute(node, outputs);
    } catch (err) {
      // An agent call threw (OOM / unexpected / provisioning failure). Mark the
      // node failed so the failure cascades to downstream skips, mirroring a
      // normal failure.
      console.error(`[runner] Phase "${node.name}" threw unexpectedly:`, err);
      phases.push({ phase: node.name, success: false, error: String(err), output: "" });
      node.status = "failed";
      // Attribute the failure to THIS phase. `current_phase`/`phase_history`
      // otherwise only advance on success (persistPhase hardcodes success:true),
      // so a throw here would leave the run's PHASE pointing at the last phase
      // that *succeeded* — mis-reporting which phase actually failed. Mirrors
      // post-review's fail() handler.
      if (db && workflowId) {
        db.runs.appendPhase(workflowId, node.name, {
          phase: node.name,
          timestamp: new Date().toISOString(),
          success: false,
          summary: err instanceof Error ? err.message : String(err),
        });
      }
      continue;
    }
    for (const r of outcome.results) phases.push(r);
    if (outcome.outputVars) Object.assign(outputs, outcome.outputVars);

    if (outcome.aborted) {
      // Dedup running-skip — another instance owns this phase. Stop without
      // cascading skips; this isn't a phase failure.
      return { success: false, phases };
    }
    if (outcome.paused) {
      return { success: true, phases, paused: true };
    }
    node.status = outcome.status;
  }

  // ── Workflow wrap-up ──────────────────────────────────────────────────────
  //
  // If the definition declares an `on_success.set_phase` terminal marker on any
  // phase, record it so the DB row shows the workflow as fully complete. Also
  // opportunistically extract a PR number from the terminal phase's output.
  const anyFailed = phases.some((p) => !p.success);
  const success = !anyFailed;

  let prNumber: number | undefined;
  let prUrl: string | undefined;
  const terminalPhase = [...definition.phases].reverse().find((p) => p.on_success?.set_phase);
  if (terminalPhase) {
    const terminalResult = phases.find((p) => p.phase === terminalPhase.name);
    const prMatch = terminalResult?.output?.match(/#(\d+)/);
    if (prMatch) prNumber = parseInt(prMatch[1], 10);
    const urlMatch = terminalResult?.output?.match(/https?:\/\/[^\s)]+\/pull\/\d+/);
    if (urlMatch) prUrl = urlMatch[0];
  }

  if (success) {
    if (db && workflowId) {
      // Fold the `on_success.set_phase` terminal marker into the same
      // transaction as the status flip so the dashboard never sees one
      // without the other.
      const terminalMarker = terminalPhase?.on_success?.set_phase
        ? { phase: terminalPhase.on_success.set_phase, summary: prNumber ? `PR #${prNumber}` : undefined }
        : undefined;
      db.runs.finishRun(workflowId, "succeeded", terminalMarker ? { terminalMarker } : {});
    }
  } else {
    const firstFailure = phases.find((p) => !p.success);
    reporter.failWorkflow(firstFailure?.error || "workflow failed");
  }

  // Single final update: render the workflow's `final_message` against the
  // accumulated outputs and deliver it once — folded into the checklist comment
  // as its footer when the in-place reporter is active, else posted as one
  // standalone comment. Empty render ⇒ no-op (e.g. the synthesizing phase was
  // skipped). This is what lets verify/qa-test end with a single combined
  // verdict instead of a comment per phase.
  if (success && definition.final_message) {
    const finalRendered = renderTemplate(definition.final_message, {
      ...ctx,
      phaseOutputs: outputs,
    }).trim();
    if (finalRendered) {
      if (reporterActive) await reporter.footer(finalRendered);
      else await notify(finalRendered);
    }
  }

  if (reporterActive) {
    if (success && prNumber && terminalPhase) {
      const link = prUrl ? `[PR #${prNumber}](${prUrl})` : `PR #${prNumber}`;
      await reporter.step(terminalPhase.name, "done", link);
    }
    const prSuffix = prNumber ? ` — PR #${prNumber}` : "";
    await reporter.noteTerminal(
      success
        ? `✅ **${definition.name} complete**${prSuffix}.`
        : `❌ **${definition.name} failed** — see the checklist above for the failing step.`,
    );
  }

  return { success, phases, prNumber };

  });
}

export type { AgentWorkflowDefinition, TemplateContext };

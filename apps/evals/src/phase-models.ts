/**
 * Map a runner phase ROW back to the YAML `model:` template that governed it,
 * for scorecard RECORDING (`PhaseMetric.model`) in `config` runs.
 *
 * `wf.phases` rows carry LEDGER labels, not YAML phase names: a `type: fanout`
 * phase's branches come back as `<parent>_branch_<name>` (plus `_retry` /
 * `_check` — see `packages/workflow-engine/src/core/phase-ref.ts`, the single
 * authority for those labels). A naive `def.phases`-by-name lookup therefore
 * missed every branch row, and `recordPhaseModel(undefined, <label>)` fell all
 * the way through to `models.default` — the scorecard said surveys ran the
 * default model while the session envelopes proved otherwise (RESTART.md §2j).
 * Execution was always correct (`fanout.ts:776` resolves
 * `branch.model ?? phase.model`); only the recording lied.
 *
 * So the label is parsed back through core's own `PhaseRef.parse`, and a branch
 * row resolves its template exactly as core's executor does
 * (`apps/server/src/workflows/handlers/fanout.ts` `branchConfig`):
 * `branch.model ?? phase.model`, with the PARENT phase name as the resolver's
 * fallback task. Non-branch rows keep the old behaviour byte-for-byte
 * (a declared name maps to its own `model:`; a loop-derived `_fix_`/`_iter_`
 * label maps to no template, as before — those run `fix_model`/the loop's own
 * config, which this recorder has never modelled).
 */
import { PhaseRef } from "lastlight-workflow-engine";

/** The subset of a workflow phase declaration the recorder reads. Structural,
 * so `def.phases` (core's `PhaseDefinition[]`) assigns directly. */
export interface PhaseModelSource {
  name: string;
  model?: string;
  branches?: readonly { name: string; model?: string }[];
}

export interface PhaseRowModelRef {
  /** The `model:` template governing this row, or undefined if none applies. */
  template: string | undefined;
  /** For fan-out branch rows: the parent phase name — core's `fallbackTask`
   * (`fanout.ts resolveModelVariant(…, label, phase.name)`). */
  fallbackPhase: string | undefined;
}

/** Resolve the `model:` template (and fallback task) for one `wf.phases` row. */
export function modelTemplateForRow(phases: readonly PhaseModelSource[], label: string): PhaseRowModelRef {
  // A declared phase name wins outright — even one that happens to look like a
  // generated label — matching the old exact-name map.
  const declared = phases.find((p) => p.name === label);
  if (declared) return { template: declared.model, fallbackPhase: undefined };

  const ref = PhaseRef.parse(label);
  if (ref.kind === "branch" || ref.kind === "branchRetry" || ref.kind === "branchCheck") {
    const parent = phases.find((p) => p.name === ref.base);
    const branch = parent?.branches?.find((b) => b.name === ref.branch);
    // `branch.model ?? phase.model` — the branch may declare its own override
    // (none do today, but core honours it, so the recorder must too).
    return { template: branch?.model ?? parent?.model, fallbackPhase: ref.base };
  }

  // Loop-derived rows (`_fix_N` / `_recheck_N` / `_iter_N`…): no template, as
  // before — recordPhaseModel then resolves models[<label>] → models.default.
  return { template: undefined, fallbackPhase: undefined };
}

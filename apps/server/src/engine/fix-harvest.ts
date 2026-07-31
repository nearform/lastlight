/**
 * The marker harvest — the impure half of `./fix-markers.ts`.
 *
 * A fix run's only durable output, besides the commit it may or may not have
 * pushed, is the pair of marker lines the agent emits. Nothing else survives
 * the run boundary: `{{phaseOutputs}}` is empty across runs, and the shared
 * per-PR workspace is `reset --hard`-ed between them. So the harness reads the
 * markers out of each phase's output as it completes and persists them on the
 * run's `scratch`, where the NEXT dispatch's `applyDerivedState` reads them
 * back off `latestForTrigger` (04-retry.md §4.2, 09-state-machine.md §S1).
 *
 * ## Why `scratch` and not `context`
 *
 * `context.prState` is the resolved snapshot, and it is written at DISPATCH —
 * before any phase runs. The harvest is a post-hoc fact about the run that
 * dispatch produced, so it cannot go there without rewriting the record of
 * what the dispatch decision was actually taken on. `scratch` is the run's
 * mutable phase-to-phase channel and already rides back on the same
 * `latestForTrigger` row, so the transport costs no new column, no new query
 * and no second write path.
 *
 * ## Two traps this module exists to absorb
 *
 * - **`phase` is a LABEL, not a phase name.** A `generic_loop` iteration
 *   arrives as `fix_iter_1` / `fix_iter_2`, a soft retry as `fix_iter_1_retry`.
 *   Keying on `phase === "fix"` would silently harvest nothing the moment the
 *   gate loop lands. This module does not key on the phase at all — the marker
 *   lines are self-identifying, so every phase of a fix-shaped workflow is
 *   scanned and the LAST marker of each kind wins (which is also the right
 *   answer for a loop: iteration 2 supersedes iteration 1).
 * - **`mergeScratch` is a TOP-LEVEL shallow merge.** Writing
 *   `{ fixMarkers: { diagnosis } }` after a previous write of
 *   `{ fixMarkers: { fix } }` would drop the first. Every write here therefore
 *   re-reads the namespace and merges into it.
 */

import type { StateDb } from "../state/db.js";
import type { WorkflowRun } from "../state/workflow-run-store.js";
import { PR_FIX_SHAPED_WORKFLOWS } from "../workflows/target-policy.js";
import {
  parseAttemptMarkers,
  type AttemptMarkers,
  type DiagnosisMarker,
  type FixOutcomeMarker,
} from "./fix-markers.js";

/**
 * The `scratch` key the harvest owns.
 *
 * Deliberately NOT `fix`: a `generic_loop` declares its own `scratch_key` in
 * YAML, `fix` is the obvious name for the gate loop's slot, and both would be
 * merged into the same top-level object by `mergeScratch`.
 */
export const FIX_HARVEST_SCRATCH_KEY = "fixMarkers";

/** What one run's harvest records. */
export interface HarvestedFixMarkers extends AttemptMarkers {
  /**
   * Phase bases the harvest has run over, in order, de-duplicated.
   *
   * Its presence — not the presence of a marker — is what says "the harvest
   * ran on this run". A run row with NO `fixMarkers` key at all is either
   * older than this feature or died before its first phase ended, which
   * `didSpendAttempt` distinguishes.
   */
  phases: string[];
  /** ISO timestamp of the most recent harvest write. */
  at: string;
}

/**
 * Strip the engine's generated loop suffixes off a phase label.
 *
 * `fix_iter_2` → `fix`, `fix_iter_2_retry` → `fix`, `review_recheck_1` →
 * `review`. Used only for the recorded {@link HarvestedFixMarkers.phases}
 * breadcrumb — the harvest itself is label-agnostic on purpose.
 */
export function phaseBase(label: string): string {
  return label
    .replace(/_iter_\d+_retry$/, "")
    .replace(/_iter_\d+$/, "")
    .replace(/_fix_\d+$/, "")
    .replace(/_recheck_\d+$/, "");
}

/**
 * Read a run row's harvested markers, or null when the run has none.
 *
 * Tolerates every shape a `scratch` column can hold, including rows written
 * before this key existed — `null` means "nothing was harvested here", which
 * callers must be able to tell from "harvested, and there was no marker".
 */
export function readHarvestedMarkers(
  run: Pick<WorkflowRun, "scratch"> | null | undefined,
): HarvestedFixMarkers | null {
  const slot = run?.scratch?.[FIX_HARVEST_SCRATCH_KEY];
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) return null;
  const raw = slot as Record<string, unknown>;
  return {
    diagnosis: (raw.diagnosis as DiagnosisMarker | undefined) ?? null,
    fix: (raw.fix as FixOutcomeMarker | undefined) ?? null,
    phases: Array.isArray(raw.phases) ? raw.phases.filter((p) => typeof p === "string") : [],
    at: typeof raw.at === "string" ? raw.at : "",
  };
}

/**
 * Harvest whatever markers `output` carries onto the run's scratch.
 *
 * Wired into `RunnerCallbacks.onPhaseEnd` at all THREE of its call sites —
 * `index.ts` (fresh dispatch) plus both of `resume.ts`'s (GitHub and Slack
 * resume). Harvesting only in the first would silently lose every marker on a
 * run that paused for an approval gate or was resumed after a restart, which
 * is precisely the population whose attempt counter matters most.
 *
 * Never throws: a failed harvest must not fail the phase that produced the
 * output it was reading.
 */
export function harvestFixMarkers(
  db: StateDb,
  runId: string,
  workflowName: string,
  phase: string,
  output: string,
): void {
  // Only the fix family carries these markers, and only it reads them back.
  if (!PR_FIX_SHAPED_WORKFLOWS.has(workflowName)) return;
  try {
    const parsed = parseAttemptMarkers(output ?? "");
    const current = readHarvestedMarkers(db.runs.getRun(runId));
    const base = phaseBase(phase);
    const phases = current?.phases ?? [];

    const next: HarvestedFixMarkers = {
      // Last marker of each kind wins. A `generic_loop` iteration 2 supersedes
      // iteration 1; a phase that emitted nothing leaves the earlier value
      // standing rather than blanking it.
      diagnosis: parsed.diagnosis ?? current?.diagnosis ?? null,
      fix: parsed.fix ?? current?.fix ?? null,
      phases: phases.includes(base) ? phases : [...phases, base],
      at: new Date().toISOString(),
    };
    db.runs.mergeScratch(runId, { [FIX_HARVEST_SCRATCH_KEY]: next });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[fix-harvest] ${workflowName}/${phase} run ${runId}: ${msg}`);
  }
}

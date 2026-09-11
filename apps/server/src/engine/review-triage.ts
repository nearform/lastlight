/**
 * The review DEPTH marker — parsed, and harvested onto the run's scratch
 * (issue #378).
 *
 * `prompts/review-triage.md` asks the triage phase to end with exactly one
 * machine-readable line:
 *
 * ```
 * REVIEW_DEPTH: full | light
 * ```
 *
 * That one line is the whole tier mechanism. It is written to
 * `scratch.reviewTriage`, the scheduler re-reads the run row's scratch at the
 * top of every scheduling pass, and the seven evidence-pipeline phases carry
 * `skip_if: "scratch.reviewTriage.depth == 'light'"`. Scratch rather than
 * `{{phaseOutputs}}` because scratch is durable across a resume and phase
 * outputs are not — a run that pauses for an approval gate and is picked back
 * up would otherwise re-run the full pipeline it had just decided to skip.
 *
 * Modelled on the pure/impure split of `./fix-markers.ts` + `./fix-harvest.ts`,
 * and it inherits both traps that module's header documents:
 *
 * - **`phase` is a LABEL, not a phase name.** A loop iteration arrives as
 *   `triage_iter_1`, a soft retry as `triage_iter_1_retry`. Nothing here keys
 *   on the label — the marker line is self-identifying, so every phase of the
 *   run is scanned and the LAST marker wins, which is also the right answer for
 *   a loop.
 * - **`mergeScratch` is a TOP-LEVEL shallow merge.** The namespace is written
 *   whole, never patched leaf-by-leaf.
 *
 * ## Why `light` REPLACES the namespace
 *
 * `runner.ts` seeds `{ depth: "full", deep, baseline }` at run start, and
 * exactly one of `deep` / `baseline` / `light` must be true so exactly one arm
 * of `prompts/review.md` renders — the template engine has no `else` and no
 * nesting, so three mutually exclusive keys is how a three-way choice is
 * expressed. Writing `{ depth: "light", light: true }` over the seed clears the
 * other two by replacement.
 *
 * ## Failure direction
 *
 * Every one of them is "full review". A malformed marker, an unrecognised
 * value, a phase that emitted nothing, a harvest that threw — all leave the
 * dispatch-time seed standing.
 */

import type { StateDb } from "../state/db.js";
import { logger } from "../logging/logger.js";

const log = logger("review-triage");

/** The `scratch` key this module and `runner.ts`'s seed share. */
export const REVIEW_TRIAGE_SCRATCH_KEY = "reviewTriage";

/** How much review the rest of the run owes. */
export type ReviewDepth = "full" | "light";

/** The namespace as it sits on `workflow_runs.scratch`. */
export interface ReviewTriageScratch {
  /** What the seven analysis phases' `skip_if` compares against. */
  depth: ReviewDepth;
  /** Render the light single-pass arm of `prompts/review.md`. */
  light?: boolean;
  /** Render the abbreviated arm — the evidence pipeline ran ahead of us. */
  deep?: boolean;
  /** Render the original no-pipeline arm. */
  baseline?: boolean;
}

/**
 * The one marker line, or `null` when the output carries none.
 *
 * Never throws — this is agent output, which is to say untrusted text produced
 * under time pressure by a language model. Case-insensitive on the value and
 * tolerant of surrounding whitespace, because those are transcription slips
 * rather than decisions; an unrecognised value is `null`, never coerced, so
 * `REVIEW_DEPTH: lightweight` cannot become a `light` review.
 *
 * The LAST marker in the output wins. A model that reasons out loud may mention
 * the line before it emits it, and the prompt asks for it at the end.
 */
export function parseTriageMarker(output: string): ReviewDepth | null {
  if (typeof output !== "string" || !output) return null;
  let found: ReviewDepth | null = null;
  const re = /^[^\S\r\n]*REVIEW_DEPTH:[^\S\r\n]*([A-Za-z]+)/gm;
  for (const m of output.matchAll(re)) {
    const value = (m[1] ?? "").toLowerCase();
    if (value === "full" || value === "light") found = value;
  }
  return found;
}

/**
 * Read a run row's triage namespace, or `null` when it has none.
 *
 * `null` — "nothing seeded here" — is distinguishable from a seeded `full`, and
 * both mean the same thing to every consumer: run everything. Tolerates every
 * shape the scratch column can hold, including rows written before this key
 * existed.
 */
export function readReviewTriage(
  run: { scratch?: Record<string, unknown> | null } | null | undefined,
): ReviewTriageScratch | null {
  const slot = run?.scratch?.[REVIEW_TRIAGE_SCRATCH_KEY];
  if (!slot || typeof slot !== "object" || Array.isArray(slot)) return null;
  const raw = slot as Record<string, unknown>;
  return {
    depth: raw.depth === "light" ? "light" : "full",
    light: raw.light === true,
    deep: raw.deep === true,
    baseline: raw.baseline === true,
  };
}

/**
 * Harvest a `REVIEW_DEPTH` marker off one phase's output.
 *
 * Wired into `RunnerCallbacks.onPhaseEnd` at all THREE of its call sites,
 * beside `harvestFixMarkers` and for the same reason: a review that paused for
 * an approval gate or was resumed after a restart completes its triage phase on
 * a resume path, and harvesting only on the fresh dispatch would silently run
 * the full pipeline the triage had just decided against.
 *
 * Never throws: a failed harvest must not fail the phase that produced the
 * output it was reading.
 */
export async function harvestReviewTriage(
  db: StateDb,
  runId: string,
  phase: string,
  output: string,
): Promise<void> {
  try {
    const depth = parseTriageMarker(output ?? "");
    // `full` and "no marker" are the same instruction: leave the seed alone.
    // Only a downgrade is ever written, so a later phase's output cannot
    // silently re-arm the pipeline a triage already skipped.
    if (depth !== "light") return;
    const next: ReviewTriageScratch = { depth: "light", light: true };
    await db.runs.mergeScratch(runId, { [REVIEW_TRIAGE_SCRATCH_KEY]: next });
    log.info("Triage downgraded this review to a single pass", { runId, phase });
  } catch (err: unknown) {
    log.warn("Triage harvest failed", { runId, phase, err });
  }
}

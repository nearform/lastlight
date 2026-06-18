/**
 * The single authority for building and resolving the phase labels the runner
 * generates for loop iterations.
 *
 * A workflow phase named in the YAML (e.g. `reviewer`) keeps that bare name for
 * its initial run. When a reviewer loop fixes-and-rechecks, or a generic loop
 * iterates, the runner mints a derived label. `PhaseRef.format()` is the ONLY
 * place those derived strings are constructed, and `phaseIndexInDefinition`
 * resolves them back to the declared phase.
 *
 * Scheme (post-#93):
 *
 *   initial review            → reviewer
 *   cycle n fix               → reviewer_fix_n
 *   cycle n re-review         → reviewer_recheck_n
 *   generic-loop iteration n  → reviewer_iter_n
 *
 * `n` is the 1-based cycle; `fix_k` and `recheck_k` pair within a cycle. The
 * legacy bare-numeric re-review form (`reviewer_2`) is dropped entirely — it is
 * neither produced nor recognized.
 */

import type { AgentWorkflowDefinition } from "./schema.js";

export type PhaseKind = "phase" | "fix" | "recheck" | "iter";

export class PhaseRef {
  constructor(
    readonly base: string,
    readonly kind: PhaseKind = "phase",
    readonly index?: number,
  ) {}

  /** The declared phase, run as-is (no derived suffix). */
  static review(base: string): PhaseRef {
    return new PhaseRef(base, "phase");
  }

  /** The executor fix run for cycle `n`. */
  static fix(base: string, n: number): PhaseRef {
    return new PhaseRef(base, "fix", n);
  }

  /** The reviewer re-review run for cycle `n`. */
  static recheck(base: string, n: number): PhaseRef {
    return new PhaseRef(base, "recheck", n);
  }

  /** The generic-loop iteration `n`. */
  static iter(base: string, n: number): PhaseRef {
    return new PhaseRef(base, "iter", n);
  }

  format(): string {
    switch (this.kind) {
      case "phase":
        return this.base;
      case "fix":
        return `${this.base}_fix_${this.index}`;
      case "recheck":
        return `${this.base}_recheck_${this.index}`;
      case "iter":
        return `${this.base}_iter_${this.index}`;
    }
  }

  /**
   * Parse a label back into a PhaseRef. Recognizes only the generated
   * `_fix_N` / `_recheck_N` / `_iter_N` suffixes; anything else (including a
   * bare declared name or the dropped legacy `_N` form) parses as a plain
   * `phase` whose base is the whole string.
   */
  static parse(label: string): PhaseRef {
    let m = label.match(/^(.*)_fix_(\d+)$/);
    if (m) return new PhaseRef(m[1], "fix", Number(m[2]));
    m = label.match(/^(.*)_recheck_(\d+)$/);
    if (m) return new PhaseRef(m[1], "recheck", Number(m[2]));
    m = label.match(/^(.*)_iter_(\d+)$/);
    if (m) return new PhaseRef(m[1], "iter", Number(m[2]));
    return new PhaseRef(label, "phase");
  }
}

/**
 * Resolve a recorded phase name to its index in `definition.phases`.
 *
 * Definition-aware and **exact-match-first**: a phase literally named like a
 * generated label (e.g. a YAML phase actually called `reviewer_fix_1`) wins
 * over suffix-stripping. Only when no exact match exists do we strip a
 * generated suffix and resolve to the base phase.
 *
 * Returns -1 when the name doesn't match any phase — unknown/untracked labels
 * (`waiting_approval`, user `set_phase` values like `complete`) and the dropped
 * legacy `reviewer_2` form all land here.
 */
export function phaseIndexInDefinition(
  definition: AgentWorkflowDefinition,
  name: string,
): number {
  const exact = definition.phases.findIndex((p) => p.name === name);
  if (exact >= 0) return exact;

  const ref = PhaseRef.parse(name);
  if (ref.kind === "phase") return -1;
  return definition.phases.findIndex((p) => p.name === ref.base);
}

/**
 * Given the phase the runner last completed, return the name of the phase the
 * runner should run next. Returns `null` when there is no next phase (i.e. the
 * workflow is done).
 */
export function nextPhaseAfter(
  definition: AgentWorkflowDefinition,
  completedPhase: string,
): string | null {
  const idx = phaseIndexInDefinition(definition, completedPhase);
  if (idx < 0 || idx >= definition.phases.length - 1) return null;
  return definition.phases[idx + 1].name;
}

/**
 * The single authority for building and resolving the phase labels the runner
 * generates for loop iterations.
 *
 * A workflow phase named in the YAML (e.g. `reviewer`) keeps that bare name for
 * its initial run. When a reviewer loop fixes-and-rechecks, or a generic loop
 * iterates, the runner mints a derived label. `PhaseRef.format()` is the ONLY
 * place those derived strings are constructed, and `PhaseRef.parse()` resolves
 * them back to their base phase + kind.
 *
 * Scheme (post-#93):
 *
 *   initial review            → reviewer
 *   cycle n fix               → reviewer_fix_n
 *   cycle n re-review         → reviewer_recheck_n
 *   generic-loop iteration n  → reviewer_iter_n
 *   generic-loop retry of n   → reviewer_iter_n_retry
 *
 * `n` is the 1-based cycle; `fix_k` and `recheck_k` pair within a cycle. The
 * `_retry` suffix is the one-shot re-run of a generic-loop iteration whose first
 * attempt came back empty (a "soft" outcome); it gets its own ledger row so
 * resume/dedup doesn't skip it, and the dashboard's longest-prefix grouping
 * still nests it under the same parent. The legacy bare-numeric re-review form
 * (`reviewer_2`) is dropped entirely — it is neither produced nor recognized.
 */

export type PhaseKind = "phase" | "fix" | "recheck" | "iter" | "retry";

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

  /** The one-shot retry of generic-loop iteration `n` after a soft outcome. */
  static iterRetry(base: string, n: number): PhaseRef {
    return new PhaseRef(base, "retry", n);
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
      case "retry":
        return `${this.base}_iter_${this.index}_retry`;
    }
  }

  /**
   * Parse a label back into a PhaseRef. Recognizes only the generated
   * `_fix_N` / `_recheck_N` / `_iter_N` suffixes; anything else (including a
   * bare declared name or the dropped legacy `_N` form) parses as a plain
   * `phase` whose base is the whole string.
   */
  static parse(label: string): PhaseRef {
    let m = label.match(/^(.*)_iter_(\d+)_retry$/);
    if (m) return new PhaseRef(m[1], "retry", Number(m[2]));
    m = label.match(/^(.*)_fix_(\d+)$/);
    if (m) return new PhaseRef(m[1], "fix", Number(m[2]));
    m = label.match(/^(.*)_recheck_(\d+)$/);
    if (m) return new PhaseRef(m[1], "recheck", Number(m[2]));
    m = label.match(/^(.*)_iter_(\d+)$/);
    if (m) return new PhaseRef(m[1], "iter", Number(m[2]));
    return new PhaseRef(label, "phase");
  }
}

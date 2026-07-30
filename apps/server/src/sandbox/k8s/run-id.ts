import { RUN_ID_LABEL } from "./pod.js";
import { sanitizeLabelValue } from "./naming.js";

/**
 * A sandbox run's identity, sanitized once at construction. Stamped
 * identically onto the Pod (`pod.ts`) and the PVC (`pvc.ts`) via
 * {@link RunId.matchLabels}, and compared back against that same label by
 * the reclaim run-selector (`reclaim.ts`) — this type makes that "stamp
 * exactly what you select on" rule structural instead of prose-only (F7):
 * there is exactly one place a raw runId is turned into a label value
 * (`RunId.from`), so a stamp call and a select call built from the same raw
 * id can never drift apart.
 */
export class RunId {
  private constructor(readonly label: string) {}

  /** Sanitize `raw` via the existing `sanitizeLabelValue` (the RFC-1123
   *  label-VALUE rules) and wrap the result. Sanitizes once — every other
   *  use of the run id (stamping, selecting) reads `.label` off this
   *  instance instead of re-sanitizing. */
  static from(raw: string): RunId {
    return new RunId(sanitizeLabelValue(raw));
  }

  /** The single `RUN_ID_LABEL` key/value pair to spread into a manifest's
   *  `metadata.labels` (stamping) or compare a listed object's labels
   *  against (selecting) — same shape either way. */
  matchLabels(): Record<string, string> {
    return { [RUN_ID_LABEL]: this.label };
  }
}

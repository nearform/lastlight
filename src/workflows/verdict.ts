/**
 * The single parser for a reviewer phase's verdict.
 *
 * A reviewer agent is asked to end its output with a `VERDICT:` marker line —
 * either `VERDICT: APPROVED` or `VERDICT: REQUEST_CHANGES`. When that marker is
 * present we trust it. When it's absent we fall back to a fragile heuristic
 * (preserved here exactly as both runner sites had it): treat the output as
 * approved only when it does NOT mention `REQUEST_CHANGES` and DOES start with
 * `APPROVED`. `viaFallback` lets callers warn when the marker was missing.
 *
 * Hardening the fallback is deliberately out of scope — this parser is
 * behaviour-neutral on verdict semantics.
 */

export type ReviewerVerdict = "APPROVED" | "REQUEST_CHANGES";

export interface ParsedVerdict {
  verdict: ReviewerVerdict;
  viaFallback: boolean;
}

export function parseReviewerVerdict(output: string): ParsedVerdict {
  const marker = output.match(/^\s*VERDICT:\s*(APPROVED|REQUEST_CHANGES)\s*$/im);
  if (marker) {
    return {
      verdict: marker[1].toUpperCase() === "APPROVED" ? "APPROVED" : "REQUEST_CHANGES",
      viaFallback: false,
    };
  }

  const upper = output.toUpperCase();
  const hasRequestChanges = /\bREQUEST_CHANGES\b/.test(upper);
  const isApproved = !hasRequestChanges && /^APPROVED\b/.test(upper);
  return {
    verdict: isApproved ? "APPROVED" : "REQUEST_CHANGES",
    viaFallback: true,
  };
}

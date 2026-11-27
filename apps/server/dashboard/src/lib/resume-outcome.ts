/**
 * What an approve did to the paused run behind the gate.
 *
 * `POST /approvals/:id/respond` resolves the gate AND tries to resume the run,
 * and the two can diverge: the gate settles, but the run may already be gone.
 * The outcome rides back on the response as `resume`:
 * - `resumed` — the run is running again.
 * - `queued`  — admitted, but the concurrency cap is full; it resumes when a
 *   slot frees up. This is the expected capped state, not a problem.
 * - `inactive` — the run was cancelled or expired while paused, so NOTHING
 *   resumed and nothing ever will. This is the one an operator who just pressed
 *   Approve would otherwise never learn.
 *
 * Only `inactive` is worth a word: `resumed`/`queued` both end in the run
 * running, so to the operator they are plain success. Every approval surface
 * (board card, focused view, inline banner) routes through this one function so
 * the sentence — and the choice of when to say nothing — can't drift between
 * them.
 */
export type ResumeOutcome = "resumed" | "queued" | "inactive";

/**
 * The line to show the operator after an approve, or `null` when the resume
 * landed and there is nothing to add.
 */
export function resumeNotice(resume: ResumeOutcome | undefined): string | null {
  return resume === "inactive"
    ? "Approved, but the run was no longer active — nothing resumed."
    : null;
}

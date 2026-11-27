/**
 * What an approve did to the paused run behind the gate.
 *
 * `POST /approvals/:id/respond` resolves the gate AND tries to resume the run,
 * and the two can diverge: the gate settles, but the resume may not land. The
 * outcome rides back on the response as `resume`:
 * - `resumed` — the run is running again.
 * - `queued`  — admitted, but the concurrency cap is full; it resumes when a
 *   slot frees up. This is the expected capped state, not a problem.
 * - `inactive` — the run was cancelled or expired while paused, so NOTHING
 *   resumed and nothing ever will.
 * - `unavailable` — the GitHub App isn't configured, so the run can't resume
 *   yet; it stays paused and resumes once the App is set up.
 * - `error` — the resume attempt threw; the gate is still recorded as approved.
 *
 * `resumed`/`queued` both end in the run running, so to the operator they are
 * plain success and say nothing. The other three each failed to resume for a
 * DIFFERENT reason, and the message names which — telling an operator the run
 * was "no longer active" when the real cause is config or an error is exactly
 * the conflation this split fixes. Every approval surface (board card, focused
 * view, inline banner) routes through this one function so the wording — and
 * the choice of when to stay silent — can't drift between them.
 */
export type ResumeOutcome = "resumed" | "queued" | "inactive" | "unavailable" | "error";

/**
 * The line to show the operator after an approve, or `null` when the resume
 * landed (running or queued) and there is nothing to add.
 */
export function resumeNotice(resume: ResumeOutcome | undefined): string | null {
  switch (resume) {
    case "inactive":
      return "Approved, but the run was no longer active — nothing resumed.";
    case "unavailable":
      return "Approved, but the run can't resume — the GitHub App isn't configured. It stays paused.";
    case "error":
      return "Approved, but resuming the run failed — it stays recorded as approved; check the server logs.";
    default:
      return null;
  }
}

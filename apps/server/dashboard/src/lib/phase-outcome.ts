/**
 * A phase's OUTCOME SUMMARY — the one line it recorded about what it actually
 * did, as opposed to whether it went green.
 *
 * The summary is the optional `summary` field of a `phase_history` entry
 * (`workflow_runs.phase_history[]`), written through the engine's
 * `PhaseReporter.persistPhase(phase, summary)` seam. That makes it the ONE
 * generic vehicle across every phase type: handler phases (`post-review`,
 * `fanout`), context phases, dedup skips, loop iterations and the terminal /
 * approval markers all write it, and it is served whole on
 * `GET /admin/api/workflow-runs/:id`. Plain agent phases record none — that is
 * expected, not a gap, and callers must render nothing rather than an empty box.
 *
 * Why this exists at all: a phase that SUCCEEDED but did nothing was visually
 * identical to one that succeeded and did a lot. `post-review` alone returns
 * `skipped: …`, `already-reviewed: …` and `posted review: 4 inline, 1 in body,
 * event=COMMENT` — all three rendered as the same green tick with no text, so
 * the drizzle-cube#937 run looked completely healthy while posting nothing and
 * the only way to find out was the admin API.
 */

/**
 * Leading tokens a phase uses when its summary is reporting that it did NOT do
 * the work — deliberately a short closed vocabulary rather than a general
 * "sounds like a skip" heuristic, because a false positive here would label a
 * phase that really posted/pushed something as a no-op.
 *
 * The producers, so the list can be checked against them:
 * - `skipped:` — `post-review`'s agent-declined branch.
 * - `already…` — `resolveReviewPost`'s `already-posted:` / `already-reviewed:`,
 *   the dispatch gate's `already-assessed:`, and the engine's
 *   `Already completed (deduplicated)`.
 * - `duplicate:` — `post-review` withholding a word-for-word repeat APPROVE.
 * - `stale:` — `post-review` declining to post against a moved head.
 */
const NO_OP_SUMMARY_RE = /^(skipped|already[\w-]*|duplicate|stale)\b/i;

/**
 * The summary to display for a phase, or `undefined` when there is nothing to
 * say. Blank-but-present summaries normalize to `undefined` so no caller has to
 * decide whether `""` deserves a box.
 */
export function phaseSummary(entry: { summary?: string } | undefined): string | undefined {
  const text = entry?.summary?.trim();
  return text ? text : undefined;
}

/**
 * Does this summary say the phase declined to do its work? Display-only — it
 * tints and badges the summary and NEVER changes a phase's status, so a miss
 * costs a shade of grey rather than a wrong verdict. The full text is always
 * rendered beside it.
 */
export function isNoOpSummary(summary: string): boolean {
  return NO_OP_SUMMARY_RE.test(summary);
}

/**
 * Shorten a summary to fit a pipeline node (110px wide — one clipped line is
 * all that fits without bloating the graph). The untruncated text still reaches
 * the user through the node's `title` and, in full, the phase detail panel.
 */
export function truncateSummary(summary: string, max = 40): string {
  const oneLine = summary.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

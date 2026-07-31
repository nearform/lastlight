/**
 * Escalation — what a terminal skip DOES to the pull request.
 *
 * `resolveFixDisposition` decides; this applies. Three of its skips are
 * terminal for the current problem (see `EscalationCase`), and before this
 * module all three were silent: the dispatch returned `{ kind: "skipped" }`
 * with a reason in the server log and *nothing at all* on the PR. 04-retry.md
 * §4.3 calls that strictly worse than being visible — a maintainer looking at a
 * red dependency PR that the bot has quietly abandoned has no way to learn that
 * it was abandoned, let alone why.
 *
 * So an escalating skip does three things, in this order:
 *
 *   1. **records a run row**  (why it must, below)
 *   2. **applies `requires-human`**
 *   3. **posts ONE comment** naming the case, the attempt count and each
 *      attempt's `class=` / `cause=`.
 *
 * ## Why the row, and why FIRST
 *
 * This is the crux, and it is not an implementation detail — it is 09 → D1's
 * general rule: *no prior-run verdict may gate dispatch unless the skipping
 * path writes a run row.*
 *
 * `escalatedAtSha` is read by `applyDerivedState` off the PRIOR RUN'S persisted
 * `context.prState`, via `latestForTrigger`. A dispatch-time skip returns
 * `{ kind: "skipped" }` and writes no row. So an escalation that stayed a
 * row-less skip would never persist `escalatedAtSha`, and the next dispatch
 * would see `requires-human` present with `escalatedAtSha: null` — which
 * `applyDerivedState` classifies as `escalatedBy: "human"`, **a permanent hard
 * override**. The bot would mistake its own escalation for a maintainer's "stay
 * out" and latch the PR dead: exactly the one-way door 09 → S1 set out to
 * remove, reintroduced by the feature meant to remove it.
 *
 * That is also why the row is written BEFORE the label. Every ordering has a
 * crash window; this one chooses the harmless side of it. Row-then-crash leaves
 * an escalation record with no label — the guard reads `escalatedBy: null`, so
 * the next event simply escalates again and the label lands on the retry.
 * Label-then-crash would leave a label with no record, which is precisely the
 * "human applied it" misclassification above, and it is permanent.
 *
 * The row is recorded **`succeeded`**, not `failed`: 09 → S1 reserves `failed`
 * for MALFUNCTION, and correct-but-stopped outcomes record `succeeded`. The run
 * did its job — it correctly determined the PR cannot be fixed here. `failed`
 * would post `messages.on_failure` on the PR, offer a dashboard Retry that
 * cannot succeed, and pollute the cost/failure stats.
 *
 * ## Once, and only once
 *
 * Neither `postComment` nor `addLabels` de-duplicates, and no API scan is used
 * to ask "did we already comment". The once-only property comes from the
 * persisted record instead: the next dispatch at the same head reads
 * `escalatedAtSha` back, resolves `escalatedBy: "us"`, and takes the
 * `escalated:` skip — which carries no `EscalationCase`, so nothing is applied.
 * A maintainer's push makes it a fresh problem, the guard falls away, and the
 * PR is dispatchable again with no label to remove by hand.
 */

import { randomUUID } from "crypto";
import type { StateDb } from "../state/db.js";
import type { GitHubClient } from "./github/github.js";
import type { FixConfig } from "../config/config.js";
import type { Decision, EscalationCase, FixDisposition } from "./pr-decisions.js";
import { prTriggerId, type PrState } from "./pr-state.js";
import { REQUIRES_HUMAN_LABEL } from "../cron/dependabot-discovery.js";

/** Collaborators {@link escalatePr} needs. `github` is null in chat-only mode. */
export interface EscalationDeps {
  db: StateDb;
  github: GitHubClient | null;
}

/**
 * The phase name the escalation row terminates on. Not a real phase — no
 * executor ran — but `phase_history` is what the run detail panel renders, and
 * a run whose only entry says `escalated` reads correctly beside runs whose
 * entries say `diagnose` / `fix`.
 */
export const ESCALATION_PHASE = "escalated";

/** What {@link escalatePr} did, for the caller's log line and for tests. */
export interface EscalationOutcome {
  case: EscalationCase;
  runId: string;
  labelled: boolean;
  commented: boolean;
}

/**
 * Apply the escalation for a skip that carries one; do nothing otherwise.
 *
 * Called from BOTH dispatch gates — `dispatcher.ts` (webhook / comment routes)
 * and `dispatchWorkflow` (cron fan-out, `/api/run`). One helper rather than two
 * call-site implementations, because a skip that escalates on one route and
 * stays silent on the other is the exact divergence the PR state machine exists
 * to remove: the daily `fix-red-dependency-prs` sweep is the route that reaches
 * most exhausted PRs.
 *
 * Never throws. Every GitHub write is independently best-effort — a failure
 * degrades the escalation's VISIBILITY, never the dispatch outcome, and the
 * caller skips either way.
 */
export async function escalatePr(
  workflowName: string,
  state: PrState,
  decision: Decision<FixDisposition>,
  fix: FixConfig,
  deps: EscalationDeps,
): Promise<EscalationOutcome | null> {
  const kase = decision.escalation;
  if (!kase || decision.decision !== "skip") return null;

  const [owner, name] = state.repo.split("/");
  if (!owner || !name) return null;

  // No head SHA means the PR read failed. Recording `escalatedAtSha: ""` would
  // read back as falsy, which `applyDerivedState` resolves to
  // `escalatedBy: "human"` — the permanent override. Refuse rather than latch;
  // the next event re-resolves the snapshot and escalates properly.
  if (!state.headSha) {
    console.warn(
      `[escalate] ${state.repo}#${state.prNumber}: ${kase} but the head SHA is unknown — skipping silently`,
    );
    return null;
  }

  // No client, no label, no comment — so an escalation here would be invisible,
  // which is the whole thing this exists to prevent. Recording a row alone
  // would also accumulate one per cron tick, since with no label the guard
  // never binds.
  if (!deps.github) return null;

  const github = deps.github;

  // ── 1. The record. Written FIRST — see the module header. ────────────────
  //
  // A failure here ABORTS the escalation rather than falling through to the
  // label. Labelling without a record is the one combination that latches: the
  // next dispatch sees `requires-human` with no `escalatedAtSha` behind it and
  // reads our own label as a maintainer's permanent override.
  const runId = randomUUID();
  const recorded: PrState = {
    ...state,
    escalatedAtSha: state.headSha,
    escalatedBy: "us",
  };
  try {
    deps.db.runs.createRun({
      id: runId,
      workflowName,
      triggerId: prTriggerId(state.repo, state.prNumber),
      owner,
      repo: name,
      issueNumber: state.prNumber,
      currentPhase: ESCALATION_PHASE,
      status: "running",
      triggeredBy: "last-light",
      triggerActorType: "system",
      context: {
        // The snapshot the NEXT dispatch reads back — `escalatedAtSha` above is
        // the whole point of the row.
        prState: recorded,
        // …and the human-readable half of the same fact, for the detail panel.
        escalation: { case: kase, reason: decision.reason, at: new Date().toISOString() },
      },
      startedAt: new Date().toISOString(),
    });
    // `succeeded`, not `failed`: 09 → S1 reserves `failed` for malfunction.
    deps.db.runs.finishRun(runId, "succeeded", {
      terminalMarker: { phase: ESCALATION_PHASE, summary: decision.reason },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[escalate] ${state.repo}#${state.prNumber}: could not record the escalation (${msg}) — ` +
      `applying no label, since a label with no record reads as a human's permanent hold`,
    );
    return null;
  }

  // ── 2. The label. ────────────────────────────────────────────────────────
  let labelled = false;
  try {
    await github.addLabels(owner, name, state.prNumber, [REQUIRES_HUMAN_LABEL]);
    labelled = true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[escalate] ${state.repo}#${state.prNumber}: could not apply the label: ${msg}`);
  }

  // ── 3. The comment. Only behind a label that actually landed. ────────────
  //
  // Without the label the guard cannot bind, so the next event will escalate
  // again — and commenting now would mean commenting once per retry.
  let commented = false;
  if (labelled) {
    try {
      await github.postComment(
        owner,
        name,
        state.prNumber,
        renderEscalationComment(kase, decision.reason, recorded, fix),
      );
      commented = true;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`[escalate] ${state.repo}#${state.prNumber}: could not post the comment: ${msg}`);
    }
  }

  console.log(
    `[escalate] ${workflowName} ${state.repo}#${state.prNumber}: ${kase} at ` +
    `${state.headSha.slice(0, 7)} (run ${runId}, label=${labelled}, comment=${commented})`,
  );
  return { case: kase, runId, labelled, commented };
}

/** One-line human summary per case, for the comment's opening sentence. */
const CASE_HEADLINE: Record<EscalationCase, string> = {
  "attempts-exhausted": "I've used every attempt I'm allowed on this pull request",
  "budget-exhausted": "I've spent the cost budget allowed for this pull request",
  "not-retryable": "The last diagnosis says another attempt can't help",
};

/**
 * The escalation comment. Pure, so its wording is table-testable.
 *
 * 04-retry.md §4.3 fixes the contents: **which escalation case this is, the
 * attempt count, and each attempt's `class=` + `cause=`.** The last of those is
 * `state.priorAttempts` — already rendered, already bounded (`fix-markers.ts`),
 * already the exact text the next attempt's prompt would have replayed. Nothing
 * is re-derived here: the reason comes from the decision, so the log line, this
 * comment and the admin detail panel are three renderings of ONE source.
 *
 * The closing paragraph is the anti-latch property, stated to the person who
 * has to act on it: pushing is the exit, and removing the label by hand is not
 * required. Saying so is what stops `requires-human` reading as the one-way
 * door it used to be.
 */
export function renderEscalationComment(
  kase: EscalationCase,
  reason: string,
  state: PrState,
  fix: FixConfig,
): string {
  const lines: string[] = [];
  lines.push(`**${CASE_HEADLINE[kase]}**, so I've applied \`${REQUIRES_HUMAN_LABEL}\` and stopped.`);
  lines.push("");
  lines.push(`- **Why:** ${reason}`);
  lines.push(`- **Attempts:** ${Math.max(state.attempt - 1, 0)} of ${fix.maxAttempts} spent`);
  if (fix.maxCostUsd !== null) {
    lines.push(
      `- **Cost so far:** $${state.cumulativeCostUsd.toFixed(2)} of $${fix.maxCostUsd.toFixed(2)}`,
    );
  }
  lines.push(`- **Head:** \`${state.headSha.slice(0, 7)}\``);
  lines.push("");

  if (state.priorAttempts.length > 0) {
    lines.push("What each attempt found:");
    lines.push("");
    for (const line of state.priorAttempts) lines.push(`- \`${line}\``);
  } else {
    // A crash never spends an attempt and leaves no marker, so an escalation
    // with an empty journal is a real (if rare) state — say so rather than
    // rendering an empty bullet list.
    lines.push("I have no per-attempt notes for this PR — no run got as far as a diagnosis.");
  }
  lines.push("");
  lines.push(
    "**Push a commit to this branch and I'll pick it up again** — a new head from anyone but me " +
    "is a fresh problem, so the attempt counter resets and this label stops holding me off. " +
    "You don't need to remove it by hand. You can also ask me directly in a comment to override.",
  );
  return lines.join("\n");
}

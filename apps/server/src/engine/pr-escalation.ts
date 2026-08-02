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
 * row-less skip would never persist `escalatedAtSha`, the guard would never
 * bind, and every subsequent event on the same dead PR would escalate again —
 * re-applying the label and posting the comment once per event, which is the
 * one behaviour worse than the silent skip this module replaced.
 *
 * That is also why the row is written BEFORE the label. Every ordering has a
 * crash window; this one chooses the harmless side of it. Row-then-crash leaves
 * an escalation record with no label — the guard still binds off the record, so
 * the PR is quiet and the label lands on the next escalation.
 * Label-then-crash would leave a label with no record: a `requires-human` on the
 * PR that nothing in the code can see, so the next event escalates and comments
 * all over again.
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
 * `escalatedAtSha` back and takes the `escalated:` skip — which carries no
 * `EscalationCase`, so nothing is applied.
 * A maintainer's push makes it a fresh problem, the guard falls away, and the
 * PR is dispatchable again with no label to remove by hand.
 *
 * That property is therefore **entirely dependent on the `escalated:` guard
 * firing first**, and the guard is bypassable: an explicit `@bot` request skips
 * it by design, and a recorded retry consumes the record outright
 * (03-retry-intervention.md). Every bypass lands back here, so `escalatePr`
 * additionally refuses outright when it has already escalated at this exact
 * head. Re-recording would be harmless; re-commenting is #256.
 */

import { randomUUID } from "crypto";
import type { StateDb } from "../state/db.js";
import type { GitHubClient } from "./github/github.js";
import type { FixConfig } from "../config/config.js";
import type { Decision, EscalationCase, FixDisposition } from "./pr-decisions.js";
import {
  INTERVENTION_PHASE,
  interventionKey,
  prScopedWorkflows,
  prTriggerId,
  type PrIntervention,
  type PrState,
} from "./pr-state.js";
import { HOLD_LABEL, REQUIRES_HUMAN_LABEL } from "../cron/dependabot-discovery.js";

/**
 * The packaged bot handle. Only a FALLBACK: every real call site passes the
 * configured `@${getBotName()}` down, and this exists so a test (or a caller
 * with no boot config) still renders a comment that names a plausible handle
 * rather than `@undefined`.
 */
const DEFAULT_BOT_HANDLE = "last-light";

/** Collaborators {@link escalatePr} needs. `github` is null in chat-only mode. */
export interface EscalationDeps {
  db: StateDb;
  github: GitHubClient | null;
  /**
   * The HOLD label (`hold.label`) and `@<botName>`, for the escalation
   * comment's list of exits. Optional so every existing construction still
   * compiles; the packaged names are the fallback.
   */
  holdLabel?: string;
  botMention?: string;
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
  // read back as an escalation at a head that matches nothing, so the guard
  // would never bind and every later event would escalate — and comment —
  // again. Refuse rather than latch; the next event re-resolves the snapshot
  // and escalates properly.
  if (!state.headSha) {
    console.warn(
      `[escalate] ${state.repo}#${state.prNumber}: ${kase} but the head SHA is unknown — skipping silently`,
    );
    return null;
  }

  // The `escalated:` guard is what normally makes this once-only, but it can
  // be bypassed — by an explicit request, by a hand-removed label, or by a
  // retry — and every bypass lands here again. Re-recording is harmless;
  // re-commenting is #256.
  if (state.escalatedAtSha === state.headSha) return null;

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
  const recorded: PrState = { ...state, escalatedAtSha: state.headSha };
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
        renderEscalationComment(kase, decision.reason, recorded, fix, {
          // The two operator-configurable names the comment has to speak. Read
          // HERE rather than inside the pure renderer, so the wording stays
          // table-testable and a deployment that renamed either gets a comment
          // naming what it actually renamed them to.
          holdLabel: deps.holdLabel ?? HOLD_LABEL,
          botMention: deps.botMention ?? `@${DEFAULT_BOT_HANDLE}`,
        }),
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

/**
 * The phase name the fork-notice row terminates on. Same non-phase convention
 * as {@link ESCALATION_PHASE}, so the run detail panel reads correctly.
 */
export const FORK_NOTICE_PHASE = "fork-pr";

/** What {@link noticeForkPr} did, for the caller's log line and for tests. */
export interface ForkNoticeOutcome {
  runId: string;
  commented: boolean;
}

/**
 * Tell a fork PR's author, ONCE, why we cannot help — and record that we did.
 *
 * Their change is fine; its head branch simply lives on a repo we have no write
 * access to (and its head ref isn't on origin), so there is nothing for a fix
 * run to clone or push to.
 *
 * ## Once per PR, and why the row
 *
 * The old notice had no de-duplication at all and keyed on `state.isFork`
 * rather than on the `fork-pr` decision, so a fork PR earned this comment on
 * every skip of any kind, once per skip (#256). Both halves are fixed: the
 * caller keys on `Decision.forkPr`, and the once-only property comes from the
 * persisted record exactly as it does for {@link escalatePr} — the next
 * dispatch reads `forkNoticedAtSha` back off the prior run's `context.prState`
 * and does not call this again. No API scan, no comment-body marker.
 *
 * The row therefore has to be written BEFORE the comment, for the same reason
 * and with the same crash-window reasoning: row-then-crash leaves a record with
 * no comment, so the author is told on the next event; comment-then-crash would
 * repeat the comment forever, which is the failure being fixed.
 *
 * Unlike an escalation this records no label and is never invalidated by a
 * push. A fork stays a fork.
 *
 * Never throws. The comment is best-effort; the record is not optional.
 */
export async function noticeForkPr(
  workflowName: string,
  state: PrState,
  deps: EscalationDeps,
): Promise<ForkNoticeOutcome | null> {
  const [owner, name] = state.repo.split("/");
  if (!owner || !name || !deps.github) return null;
  // Already told them. The whole point.
  if (state.forkNoticedAtSha) return null;
  // No head SHA means the PR read failed — but the dispatch gate refuses a
  // degraded read before it ever reaches here, so this is belt: recording
  // `forkNoticedAtSha: ""` would read back as falsy and re-notice forever.
  if (!state.headSha) return null;

  const runId = randomUUID();
  const recorded: PrState = { ...state, forkNoticedAtSha: state.headSha };
  try {
    deps.db.runs.createRun({
      id: runId,
      workflowName,
      triggerId: prTriggerId(state.repo, state.prNumber),
      owner,
      repo: name,
      issueNumber: state.prNumber,
      currentPhase: FORK_NOTICE_PHASE,
      status: "running",
      triggeredBy: "last-light",
      triggerActorType: "system",
      context: { prState: recorded },
      startedAt: new Date().toISOString(),
    });
    deps.db.runs.finishRun(runId, "succeeded", {
      terminalMarker: { phase: FORK_NOTICE_PHASE, summary: "fork-pr: told the author once" },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[fork-notice] ${state.repo}#${state.prNumber}: could not record the notice (${msg}) — ` +
      `saying nothing, since a comment with no record would repeat on every event`,
    );
    return null;
  }

  let commented = false;
  try {
    await deps.github.postComment(owner, name, state.prNumber, renderForkNotice(state));
    commented = true;
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(`[fork-notice] ${state.repo}#${state.prNumber}: comment failed: ${msg}`);
  }

  console.log(
    `[fork-notice] ${workflowName} ${state.repo}#${state.prNumber}: ` +
    `at ${state.headSha.slice(0, 7)} (run ${runId}, comment=${commented})`,
  );
  return { runId, commented };
}

/** The fork-PR notice. Pure, so its wording is table-testable. */
export function renderForkNotice(state: PrState): string {
  const source = state.headRepoFullName
    ? `from \`${state.headRepoFullName}\``
    : "from a now-deleted fork";
  return (
    `I can't apply fixes to this PR — it comes ${source}, and I have no write access to the ` +
    `source branch (nor is its head ref on \`${state.repo}\`). Re-create the change on a ` +
    `branch in \`${state.repo}\` and I'll fix it there.`
  );
}

/** One-line human summary per case, for the comment's opening sentence. */
const CASE_HEADLINE: Record<EscalationCase, string> = {
  "attempts-exhausted": "I've used every attempt I'm allowed on this pull request",
  "budget-exhausted": "I've spent the cost budget allowed for this pull request",
  "not-retryable": "The last diagnosis says another attempt can't help",
};

/** The operator-configurable names {@link renderEscalationComment} has to speak. */
export interface EscalationCommentVocab {
  /** `hold.label` — the label a maintainer applies to keep us off entirely. */
  holdLabel: string;
  /** `@<botName>` — the handle the `retry` command is addressed to. */
  botMention: string;
}

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
 * ## The closing section is a contract
 *
 * It is the only place most people will ever learn how to un-stick the bot, so
 * **every exit it names has to work and every exit that works has to be named.**
 * It used to fail both halves. It promised *"you can also ask me directly in a
 * comment to override"*, which the code refused — an explicit request cleared
 * the escalation guard and then fell straight into the same budget gate, so the
 * only thing asking achieved was a duplicate copy of this comment — and it did
 * not mention the hold label at all, because it predated it.
 *
 * After 02-hold-label.md and 03-retry-intervention.md the true exits are four,
 * and the split below is the useful one: three of them mean *"go again"* and
 * re-arm both budgets identically (locked decision 7), and the fourth means the
 * opposite. Listing the hold beside them is deliberate — a maintainer reading
 * this is, roughly half the time, someone who wants the bot to stop rather than
 * to try harder, and until now there was nothing here telling them how.
 */
export function renderEscalationComment(
  kase: EscalationCase,
  reason: string,
  state: PrState,
  fix: FixConfig,
  vocab: EscalationCommentVocab,
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
    `**How to un-stick this.** Any one of these three re-arms the attempt counter and the cost ` +
    `budget for this pull request — they do exactly the same thing, so pick whichever is least ` +
    `effort:`,
  );
  lines.push("");
  lines.push(
    `- **Push a commit to this branch.** A new head from anyone but me is a fresh problem, so I ` +
    `pick it up on the next event. You don't need to remove \`${REQUIRES_HUMAN_LABEL}\` by hand.`,
  );
  lines.push(
    `- **Comment \`${vocab.botMention} retry\`.** Anything you add after it — ` +
    `\`${vocab.botMention} retry the arm64 runner was flaky\` — is recorded against the PR and ` +
    `handed to the next attempt.`,
  );
  lines.push(
    `- **Remove the \`${REQUIRES_HUMAN_LABEL}\` label.** I read that as "have another go" and ` +
    `start a fresh window at this same commit.`,
  );
  lines.push("");
  lines.push(
    `If you'd rather I stayed off this pull request entirely, apply \`${vocab.holdLabel}\` — ` +
    `nothing of mine runs on it until that label comes off.`,
  );
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// The retry record — the other half of the same mechanism
// ---------------------------------------------------------------------------

/**
 * The phase name a standalone intervention row terminates on. Same non-phase
 * convention as {@link ESCALATION_PHASE} and {@link FORK_NOTICE_PHASE} — with
 * one difference that moves where it is declared: `pr-state.ts` has to
 * RECOGNISE this row when it derives `assessedHeadShaByWorkflow`, so the
 * constant is defined there (this module already imports that one, and the
 * reverse edge would be a cycle) and re-exported here, which is where every
 * caller expects to find it.
 */
export { INTERVENTION_PHASE };

/** What {@link recordIntervention} did, for the caller's log line and for tests. */
export interface InterventionOutcome {
  runId: string;
  via: PrIntervention["via"];
  at: string;
}

/**
 * Persist a retry that produced **no run**, so it is not silently lost.
 *
 * ## Where the record normally lives — and why this is the exception
 *
 * A retry that is immediately followed by a dispatch needs no row of its own:
 * `dispatchWorkflow` persists the whole resolved snapshot on the run's
 * `context.prState`, so the dispatched run itself carries the intervention and
 * the next dispatch reads it back exactly as it reads `escalatedAtSha`. That is
 * the common path and it is free.
 *
 * The exception is a retry the gate then skips for an unrelated reason — most
 * usefully `upstream-broken`, where the base branch is red at the moment the
 * maintainer asks. A skip returns `{ kind: "skipped" }` and writes NO row (09 →
 * D1), so without this the ask evaporates: the base goes green an hour later,
 * the PR is picked up, and the budget is still exhausted, so it escalates again
 * and the maintainer's retry never happened.
 *
 * Same shape and same ordering as {@link escalatePr} — the record first, before
 * any GitHub write — even though the crash window here is gentler (worst case a
 * retry is lost and the maintainer asks again). Two mechanisms with the same
 * shape and different orderings is how the next reader gets it wrong. There is
 * no GitHub write at all today; the ordering is stated so that adding one later
 * cannot get it backwards.
 *
 * ## The seam the admin API and the CLI use
 *
 * `lastlight pr retry <owner/repo#N>` is a thin client over an admin endpoint,
 * and the endpoint is exactly this pair of calls:
 *
 * ```ts
 * const state = await resolvePrState(owner, repo, prNumber, {
 *   github, db, botLogin,
 *   intervention: { via: "api", by: session.login, note: reason },
 * });
 * const outcome = await recordIntervention(workflowName, state, { db, github });
 * ```
 *
 * `resolvePrState` stamps `at`/`atSha` and re-arms the snapshot; this persists
 * it. The route may then dispatch immediately (in which case this row is
 * redundant but harmless — the guard below makes the pair idempotent) or leave
 * the next cron tick to pick the PR up.
 *
 * Never throws.
 */
export async function recordIntervention(
  workflowName: string,
  state: PrState,
  deps: EscalationDeps,
): Promise<InterventionOutcome | null> {
  const intervention = state.intervention;
  if (!intervention) return null;

  const [owner, name] = state.repo.split("/");
  if (!owner || !name) return null;

  // Same refusal as `escalatePr`'s: the head SHA is the record's idempotency
  // key, and one keyed to `""` would match nothing and re-arm forever.
  if (!state.headSha) return null;

  // Already persisted. `resolvePrState` folds an intervention forward off the
  // prior row, so a redelivered webhook (or a route that both records and
  // dispatches) resolves the SAME record rather than a new one — and this is
  // what stops a second row being written for it.
  const triggerId = prTriggerId(state.repo, state.prNumber);
  const prior = deps.db.runs.latestForTrigger([...prScopedWorkflows()], triggerId);
  const seen = priorIntervention(prior?.context);
  if (seen && interventionKey(seen) === interventionKey(intervention)) return null;

  const runId = randomUUID();
  try {
    deps.db.runs.createRun({
      id: runId,
      workflowName,
      triggerId,
      owner,
      repo: name,
      issueNumber: state.prNumber,
      currentPhase: INTERVENTION_PHASE,
      status: "running",
      triggeredBy: intervention.by || "last-light",
      // `system` and not `github`/`cli`: the row is the harness recording a
      // fact, not a person's run. WHO asked is on the record itself, which is
      // the one place it is allowed to be read from — for display.
      triggerActorType: "system",
      context: { prState: state, intervention },
      startedAt: new Date().toISOString(),
    });
    deps.db.runs.finishRun(runId, "succeeded", {
      terminalMarker: {
        phase: INTERVENTION_PHASE,
        summary: `retry requested via ${intervention.via}${intervention.by ? ` by ${intervention.by}` : ""}`,
      },
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(
      `[retry] ${state.repo}#${state.prNumber}: could not record the retry (${msg}) — ` +
      `it will be lost, and the maintainer will have to ask again`,
    );
    return null;
  }

  console.log(
    `[retry] ${workflowName} ${state.repo}#${state.prNumber}: recorded a ${intervention.via} retry ` +
    `at ${state.headSha.slice(0, 7)} (run ${runId})`,
  );
  return { runId, via: intervention.via, at: intervention.at };
}

/** The intervention on a stored run context, if any. Tolerates old rows. */
function priorIntervention(context: unknown): PrIntervention | null {
  if (!context || typeof context !== "object") return null;
  const snap = (context as Record<string, unknown>).prState;
  if (!snap || typeof snap !== "object") return null;
  const rec = (snap as Record<string, unknown>).intervention;
  if (!rec || typeof rec !== "object") return null;
  const at = (rec as Record<string, unknown>).at;
  return typeof at === "string" && at ? (rec as unknown as PrIntervention) : null;
}

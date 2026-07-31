---
title: "Router"
order: 5
description: "How an EventEnvelope becomes a workflow dispatch. Deterministic matching for predictable events, a cheap LLM classifier for @-mention comments and chat messages, plus the reply-gate short-circuit for paused workflows."
---

## Purpose

The router is the only place in the system where the decision "what
should happen now?" is made for an incoming event. It is built to be
the smallest layer that does that job — most events route by a literal
type check, and only the genuinely ambiguous ones (comments mentioning
the bot, free-form chat messages) reach an LLM.

There is no LLM in any path that decides whether to act on `issue.opened`
or `pr.opened`. Those go to skills directly. The LLM enters only when a
human has typed natural language at the bot.

## Public contract

```ts
export async function routeEvent(
  envelope: EventEnvelope,
  deps: RouterDeps = {},
): Promise<RoutingResult>;

export type RoutingResult =
  | { action: "skill";  skill: string; context: Record<string, unknown> }
  | { action: "reply";  message: string }
  | { action: "ignore"; reason: string };
```

Three possible outcomes — dispatch a skill, send a direct reply (no
agent involved), or drop the event. The harness consumes the result in
`src/index.ts:560–1124` and routes to the matching handler.

`RouterDeps` carries the DB handle (for the reply-gate lookup), the
managed-repos set, optional model overrides for the classifier and
screener, and a `github` client used solely to enrich a dependency-PR
mention comment with its check state before classification (see the
comment table). The router is otherwise side-effect-free — this one
read-only fetch is gated to Dependabot / Renovate PR comments.

Defined in `src/engine/router.ts:8–40`.

## Deterministic routes

These run before any LLM call. For every envelope, the first matching
rule wins.

The `@last-light` handle shown throughout this table is the **default**. The
mention handle is derived from the configured bot slug (`botName`, default
`last-light`; set via overlay `config.yaml` or `GITHUB_APP_BOT_NAME`), so a
deployment with `botName: nearform-lastlight` triggers on `@nearform-lastlight`
instead. Only the configured handle matches — there is no legacy fallback (see
[Configuration](/spec/02-configuration)).

| Trigger | Result | Notes |
|---|---|---|
| `issue.opened` / `issue.reopened` | `skill: issue-triage` | `reopened=true` for the latter |
| `pr.opened` / `pr.synchronize` / `pr.reopened` | `skill: pr-review` | |
| `pr.checks_failed` | `dependabot-ci-fix` (dependency PR) / `pr-fix` (anything else) | A failing `check_suite`. Routed **deterministically** off `envelope.isDependencyPr` — the discriminator the connector already computed to decide whether to emit at all (see [Integrations](/spec/03-integrations)) — with no classifier call, exactly like the green path below. It used to go through the classifier, which could only ever land on `dependabot-ci-fix`: `fallbackWorkflowForIntent` resolves a workflow by its `classification.intent` and `pr-fix.yaml` has no `classification:` block, so `pr-fix` was structurally unselectable. That was harmless only while the connector's gate was dependency-only; now that a PR whose head **we** pushed also emits the event, a human's red PR would have run a dependency-bump prompt, the `dependency-*` label vocabulary and a `requires-human` preflight it was never designed for |
| `pr.checks_passed` | the workflow claiming the `dependabot-pr-merge` intent (else `ignore`) | A green `check_suite` on a dependency-update PR (the connector already pre-filtered to Dependabot / Renovate). Routed **deterministically** via `getWorkflowByIntent("dependabot-pr-merge")` — no classifier call, since the dependency-PR gate is the connector's job |
| `comment.created` with pending reply gate | `skill: explore-reply` | Reply-gate short-circuit — see below |
| `comment.created` on a pre-build issue, plain (no `@last-light`) | `skill: issue-triage` (`mode: retriage`) | Reporter-driven re-triage — see below |
| `comment.created` without `@last-light` | `ignore` | reason: "no bot mention" |
| `comment.created` from non-maintainer | `reply: "only maintainers can trigger builds"` | `authorAssociation` not in `MAINTAINER_ROLES` |
| `comment.created` matching `@last-light approve\|reject [reason]` | `skill: approval-response` | Regex parse, no classifier |
| `comment.created` matching `@last-light security-review` | `skill: security-review` | |
| `comment.created` matching `@last-light verify <claim>` | `skill: verify` | Text after the keyword becomes `commentBody`; works on issues + PRs |
| `comment.created` matching `@last-light qa-test <target>` | `skill: qa-test` | Text after the keyword becomes `commentBody`; works on issues + PRs |
| `comment.created` matching `@last-light demo <notes>` | `skill: demo` | Text after the keyword becomes `commentBody`; works on issues + PRs |
| `comment.created` on issue with `security-scan` label | `skill: security-feedback` | Overrides classifier — every comment on a scan summary issue is feedback |
| `@last-light`-mention on a Dependabot / Renovate PR | classifier → `dependabot-ci-fix` (red) / `dependabot-pr-merge` (green) | For a dependency-authored PR the router fetches the PR + `getChecksConclusion` and passes `prAuthor` + `checksState` to the classifier, so an ambiguous "@bot can you look at this?" routes like the webhooks would. Gated on the cheap author/title predicate (`isDependencyPr`) and best-effort — a fetch failure or an explicit "review this" falls back to normal classification. Needs `github` in `RouterDeps` |
| `message` with pending reply gate on this Slack thread | `skill: explore-reply` | Same short-circuit as GitHub |
| `pr_review.submitted` / `pr_review_comment.created` | `ignore` | "not yet handled" — placeholder |

The remaining comment types — maintainer @-mentions without a special
command, and free-form Slack messages — reach the classifier.

## Reply-gate short-circuit

Before any mention parsing, the router asks the DB:

```ts
deps.db.getPendingReplyGateByTrigger(triggerId)
```

`triggerId` is `"${repo}#${issueNumber}"` for GitHub events and
`"slack:${teamId}:${channelId}:${threadId}"` for Slack messages. If a
paused workflow is waiting on this conversation, the comment becomes the
next loop iteration's input — no `@last-light` mention required, no
maintainer check, no classifier call. This is the mechanism that lets
the explore workflow have a natural back-and-forth with a human.

(`router.ts:97–112` for GitHub, `272–288` for Slack.)

## Reporter-driven re-triage

Sitting just above the mention gate (so it can catch the plain replies the
mention gate would otherwise drop), this branch lets new information re-open
triage on an issue **before it has entered a build**. It fires only for a
GitHub `comment.created` that is on an **issue** (not a PR), carries **no
`@last-light` mention**, and whose issue has **no `build` run** in
`workflow_runs` (`deps.db.runs.hasRunForTrigger("${repo}#${n}", "build")` —
any status, so a started/failed/completed build closes the window). Within
that gate:

- **`needs-info` issue + original author *or* a maintainer replies** →
  re-triage. Answering a `needs-info` request always re-opens triage.
- **Any other state + the original author replies** → re-triage only if a cheap
  classifier (`classifyCommentAddsInfo`) judges the comment to add substantive
  information (new detail / repro / clarification / scope change) rather than
  social noise ("thanks"). Safe default on classifier error is *no* re-triage.

Re-triage reuses the `issue-triage` handler with `context.mode = "retriage"`;
the triage agent re-reads the whole thread regardless. Bot comments are filtered
at the connector, so this can't self-loop. Author identity comes from
`envelope.issueAuthor` vs `envelope.sender`. (`router.ts`, `comment.created`
branch.)

## Maintainer gate

```ts
// src/engine/router.ts:28
const MAINTAINER_ROLES = new Set(["OWNER", "MEMBER", "COLLABORATOR"]);
```

Only these `authorAssociation` values can trigger work via `@last-light`
on a GitHub comment. Anyone else gets `action: "reply"` with a polite
decline (`router.ts:123–130`) — *the router itself emits the reply*,
not a workflow.

This check fires only after the `@last-light` mention check, so a
non-maintainer chatting in an issue without summoning the bot just
gets the "no bot mention" ignore — no rejection noise.

Slack messages have no equivalent gate; the messaging connector's
`SLACK_ALLOWED_USERS` allowlist (enforced at the connector layer) is
the only access control on chat.

## Prompt-injection screening

For events that reach a classifier, the router runs a cheap LLM
screener *in parallel* with the classifier, not sequentially. Both
finish in roughly the same time so combined latency is `max(a, b)`,
not `a + b`.

```ts
// src/engine/screen/screen.ts:47
async function screenForInjection(text: string, model?: string): Promise<ScreenResult>;
// ScreenResult = { flagged: boolean; reason?: string }
```

Behaviour:

- Short input (< 60 chars) skips the screener and returns `flagged: false`.
- Failure (timeout, parse error) returns `flagged: false`. **The
  screener is fail-open.** A broken screener never blocks an event.
- When `flagged: true`, the router prepends `[lastlight-flag: <reason>]`
  to the comment body before passing it to the workflow context
  (`router.ts:180–182`). The flag is advisory — the agent still runs,
  but `agent-context/security.md` instructs it to treat flagged content
  with suspicion.

## Build-intent classifier

The classifier turns a free-form comment or message into one discrete intent.
By default there are fourteen:

```
BUILD | EXPLORE | QUESTION | TRIAGE | REVIEW | SECURITY |
VERIFY | QATEST | DEMO | APPROVE | REJECT | STATUS | RESET | CHAT
```

(`VERIFY` → the `verify` workflow, `QATEST` → `qa-test`, `DEMO` → `demo`. The
structured `@last-light verify` / `@last-light qa-test` / `@last-light demo`
keyword matches above short-circuit before the classifier; natural-language
requests like "does this actually fix the crash?" reach `verify` via this
classifier path, and "record a demo of this" reaches `demo`.)

**The prompt is composed, forkable, and workflow-driven (issue #164).** The
system prompt is assembled at runtime by `buildClassifierPrompt()`, not
hardcoded:

- A **forkable base template** — `workflows/prompts/classifier.md`, resolved
  through the same overlay machinery as any other prompt (overlay wins by name;
  `lastlight fork classifier` copies it into `instance/`). It holds the framing,
  the global disambiguation rules, the five harness-owned **control** categories
  (`APPROVE`/`REJECT`/`STATUS`/`RESET`/`CHAT`), and the `{{categories}}` /
  `{{examples}}` / `{{intentTokens}}` slots.
- **Per-workflow categories.** Each workflow YAML contributes its own category
  via a `classification:` block (`intent` + `description` + optional `examples`);
  `build.yaml` owns `BUILD`, `pr-review.yaml` owns `REVIEW`, and so on. The
  classifier enumerates `listAgentWorkflows()`, merges the blocks in canonical
  order, and derives the token→intent vocabulary (token =
  `intent.toUpperCase().replace(/-/g,"")`, so `qa-test` → `QATEST`) from the same
  blocks. The composition is memoised and rebuilt when the asset layers change.

So a deployment can **add a routable intent by adding a workflow** — an overlay
`incident.yaml` with `classification.intent: incident` teaches the classifier the
`INCIDENT` category, the parser the token, and the router the route (see
[data-driven routing](#data-driven-routing-for-new-intents)) with **no core
edit**. The loader validates at boot that every `classification.intent` is unique
and doesn't shadow a control intent.

The model must reply in exactly four lines:

```
INTENT: BUILD
REPO: owner/name
ISSUE: 42
REASON: NONE
```

Heuristics worth knowing:

- **BUILD requires an object.** Either an explicit repo (Slack) or an
  implicit one (the GitHub issue the comment lives on).
- **EXPLORE requires brainstorm/spec/design language.** "Let's think
  about" / "what would it look like if". Otherwise BUILD or CHAT.
- **APPROVE/REJECT only matter if a gate is pending** — they're emitted
  but the harness verifies the gate before acting.
- **Ambiguous → CHAT.** The default bias is conservative.

Failure modes:

- Timeout (30 s default) or parse error → `{ intent: "chat" }`.
  Conservative fallback — the user gets a chat reply instead of an
  accidental build.
- Regex fallback for repo extraction: if the LLM misses an obvious
  `github.com/owner/repo/issues/N` URL in the text, `classifier.ts`
  parses it directly (`182–189`).

Called only on (a) GitHub `comment.created` with maintainer @-mention,
and (b) Slack `message`. Never on deterministic events.

### Data-driven routing for new intents

The router keeps its bespoke, context-dependent branches for the well-known
intents (`build` → `pr-fix` on a PR vs `build` on an issue;
`explore` is a no-op on a PR; the `security-scan` diversion). For an intent
*outside* that well-known set — a new one an overlay workflow introduced — the
trailing generic default falls back to `getWorkflowByIntent(intent)` (the
workflow whose `classification.intent` matches), routing to it on both GitHub
comments and Slack. It routes to that single workflow uniformly across surfaces;
a deployment needing surface-specific routing for its new intent can still add
`routes.github` / `routes.slack` overrides. Well-known intents never hit the
fallback, so their established routing is untouched.

**New issues** (`issue.opened`) route through the same composed classifier:
`classifyIssueIntent()` runs the main classifier over the issue title + body and
sends a `QUESTION` intent to the `answer` workflow, everything else to triage
(the safe default). This replaced a separate hardcoded question-vs-work prompt —
`answer.yaml` now owns the `QUESTION` category, so the two share one vocabulary.

A second, smaller helper — `classifyCommentAddsInfo` — answers a single
yes/no question (does a reporter's plain comment add substantive information,
or is it social noise?) and gates the [reporter-driven re-triage](#reporter-driven-re-triage)
branch for non-`needs-info` issues. Its prompt is the forkable
`workflows/prompts/classify-adds-info.md`. Same cheap-helper path; fail-closed
(error → no re-triage).

## `llm.ts` — the cheap-helper path

Both screener and classifier dispatch through `src/engine/llm.ts`,
which does direct HTTP POSTs to provider APIs (Anthropic Messages,
OpenAI Chat Completions, OpenRouter passthrough). No agent SDK, no
tools, no streaming — single-turn calls only.

Fast-model resolution (`defaultFastModel(taskType)` in `llm.ts`), in order:

1. The config `models:` map for the task key (`models.classifier`,
   `models.screener`) — set it in `config.yaml` like any other per-task model.
   Env `OPENCODE_MODELS` / `LASTLIGHT_MODELS` is layered into this map at
   config-load, so it's covered here too (env wins over `config.yaml`).
2. The env `OPENCODE_MODELS` JSON read directly — a fallback for contexts where
   runtime config isn't loaded (some CLI / test paths).
3. First configured provider's fast model, in registry order:
   `ANTHROPIC_API_KEY` → `anthropic/claude-haiku-4-5-20251001`,
   else `OPENAI_API_KEY` → `openai/gpt-5.4-mini`,
   else `OPENROUTER_API_KEY` → `openrouter/google/gemini-2.5-flash`.

Only an **explicit** per-task entry counts — never `models.default` — so the
cheap helpers stay cheap unless a deployment deliberately pins them.

Single retry on 429 / 5xx with a 750 ms back-off; never retries on
other 4xx (those are real errors).

This path is intentionally separate from the agentic-pi / pi-ai runtimes
used by the sandbox and chat surfaces. Routing decisions should not pay
the cost of those richer code paths.

## Skill enumeration

The full set of `skill` strings `routeEvent()` can emit, and where each
is handled in the harness:

| Skill | Handler in `src/index.ts` |
|---|---|
| `chat` | `577–650` — in-process chat runner |
| `chat-reset` | `654–661` — deactivate session, ack |
| `status-report` | `664–675` — list running executions |
| `approval-response` | `839–893` — resume or fail paused run |
| `explore-reply` | `750–836` — feed comment into paused explore loop |
| `pr-fix`, `dependabot-ci-fix` | `handlePrFix` — lightweight diagnose-then-fix-and-push (both are `PR_FIX_SHAPED_WORKFLOWS`, and both run the same two phases — see [Phases & Prompts](/spec/07-phases-and-prompts)). It no longer reads the PR itself: the head branch, the fork verdict and the CI evidence all come off the snapshot resolved by the [dispatch gate](#the-pr-scoped-dispatch-gate) below, so it is left with one degenerate case (we could not read the PR at all, so there is no branch to fix) |
| `build` | `896–976` — full build cycle on an issue |
| `answer` | `982–1014` — generic `dispatchWorkflow()` for `answer.yaml`; answers a question issue directly (routed via `routes.github.issue_answer` / `routes.slack.answer`) |
| `pr-review`, `pr-comment`, `issue-triage`, `issue-comment`, `explore`, `security-review`, `security-feedback`, `verify`, `qa-test`, `demo` | `982–1014` — generic `dispatchWorkflow()` + ack |

The generic-dispatch lane runs the YAML workflow whose name matches
the skill string. Anything bespoke (e.g. `build` first
records an `execution` row and reacts 🚀 on the comment before
dispatching) gets its own branch.

## The PR-scoped dispatch gate

The router answers *what should happen*. A second question — *may it happen
to this pull request right now* — is answered once, immediately after, by
`src/engine/dispatcher.ts`. It is a separate layer because the router is
side-effect-free and stateless by contract, while this gate reads live
GitHub state and our own run history.

Everything it needs is one **resolved snapshot**, `PrState`
(`src/engine/pr-state.ts`), computed once per dispatch for any workflow in
`PR_SCOPED_WORKFLOWS` (`pr-fix`, `dependabot-ci-fix`, `dependabot-pr-merge`,
`pr-review`). It has two halves — live GitHub facts (head SHA and its git
author, head/base refs, draft, fork, labels, checks state + settled count,
base-branch checks, our own review at the head, the CI failure report) and
facts derived from our run history keyed on the PR (attempt number, flaky
deferrals, escalation SHA and who escalated, prior-attempt markers,
cumulative cost, the last assessed head SHA per workflow, and any
PR-scoped run currently in flight). Resolution never throws: every read is
independently best-effort and degrades to a value that *cannot* cause a
skip, with the failures listed on `readErrors`. It rides down to
`dispatchWorkflow` on the context, so nothing is fetched twice.

The derived half is a **fold over the PR's own run history**, read off
the most recent run of the fix family (`latestForTrigger`, keyed on the
family rather than on one workflow, because "how many times have we
tried to fix this PR" is a fact about the pull request and routing
between `pr-fix` and `dependabot-ci-fix` genuinely varies). Its source
is that run's harvested markers (`scratch.fixMarkers` — see
[Phases & Prompts](/spec/07-phases-and-prompts)):

- **`attempt`** advances only when the prior run produced a
  `DIAGNOSIS_COMPLETE` marker *and* its class costs an attempt. A
  crashed run — sandbox provisioning failure, quota rejection, model
  API error — must not consume budget; without that rule one bad hour
  silently escalates every open dependency PR in every managed repo to
  `requires-human` and a human un-sticks each one by hand. `flaky` and
  `upstream-broken` are correct stopping verdicts about something other
  than this PR's code, so they cost nothing either; `infra-dependent`
  does cost an attempt, and escalates immediately. Someone *else's*
  push resets the counter to 1 — the world moved, so it is a fresh
  problem.
- **`flakyDeferrals`** counts *consecutive* `flaky` diagnoses and
  resets on any other class. It exists precisely because `flaky` is
  free: `fix.maxFlakyDeferrals` is the bound instead, and a third
  consecutive `flaky` means the job is not flaky but intermittently
  really failing. At the bound the verdict is **promoted to
  `reproducible`** — the harness drops the `class=flaky` row from the
  `fix` phase's `skip_if` for that run, so it is attempted normally
  (see [Phases & Prompts](/spec/07-phases-and-prompts)).
- **`priorAttempts`** accumulates one rendered line per attempt, oldest
  first, and is replayed into every later prompt — so it is bounded on
  both axes (line length and line count) rather than growing with the
  PR's age.
- **`priorDiagnosisClass`** is the *immediately preceding* run's class,
  and the only prior-run verdict any dispatch decision reads (see the
  escalation section below for why that is allowed). Unlike
  `flakyDeferrals` it is **not** carried across a run that diagnosed
  nothing — including our own escalation row — which is what keeps the
  manual exit working: a maintainer who removes `requires-human` by hand
  gets a genuine retry rather than an instant re-escalation that puts the
  label straight back.

A fresh problem clears all four together: a prompt that says "attempt
1" while recounting three earlier attempts is incoherent.

Every policy question is then a **pure function over that snapshot**
(`src/engine/pr-decisions.ts`) returning `{ decision, reason, inputs }`
rather than a bare enum — `mayMerge`, `resolveFixDisposition`,
`resolveMergeDisposition`, `resolveReviewTrigger`,
`resolveDispatchDisposition`, and `renderContext` (the projection into the
template variables the prompts render). The reason is produced by the
decision and rendered in the log line, the escalation comment and the run
detail panel: one source, several renderings, instead of three prose
variants that drift. Purity is the point — the whole gate is table-testable
against literal fixtures with no GitHub mock and no sandbox.

`mayMerge` is the one that does **not** gate dispatch, deliberately. It gates the
*action* — may this PR be landed at all, by either mechanism — and that decision
belongs inside the `dependabot-pr-merge` run, where the bump's impact tier is
known. It still runs *here*: `renderContext` evaluates it once and projects the
`{decision, reason}` pair as `{{mayMerge}}` / `{{mayMergeReason}}`, and the merge
prompt **reads that verdict rather than restating the predicate**.

The distinction matters, and it was learned the expensive way. Carrying the
*facts* (`checksState`, `checksSettledPassing`, `settledCheckCount`) and letting
the prompt state the rule over them is one predicate with two readings, free to
disagree — and they did, in both directions. A prompt gated on
`checksSettledPassing` alone misses `settledCheckCount < minSettledChecks`, so
raising `minSettledChecks` reports an open gate over a shut one; and it ignores
the `requireSettledChecks: false` exemption, so a deployment that turned the gate
off is still told not to merge. Projecting the decision is what makes the log
line, the prompt and the admin panel three renderings of one source.

What the dispatch gate does instead is the cheap subset —
`resolveMergeDisposition` refuses only `pending`, since a still-running suite has
nothing to decide yet; using the full predicate there would additionally refuse
every CI-less repo, which is reserved for **major** bumps rather than the whole
route.

Two properties are load-bearing:

- **A PR-scoped run lock.** Only one of the four workflows may be in flight
  for a PR at a time (`runInFlight`, an oldest-first query over `queued` /
  `running` / `paused` rows). `db.executions.isRunning(handler, triggerId)`
  was supposed to be this guard and **never worked at all**: it is called
  with a bare workflow name and a bare issue number, while every phase
  ledger row is written with `skill = "<workflow>:<phase>"` and
  `trigger_id = "owner/repo#N"`, so no row could ever match both predicates
  and it always returned false. Nothing had ever stopped an `@bot fix this`
  routed to `pr-fix` running concurrently with a `fix-red-dependency-prs`
  dispatch of `dependabot-ci-fix` — two agents, two clones of the same
  branch, both pushing. It also closes the case where
  `dependabot-pr-merge` enables auto-merge on a PR whose fix run is still
  running. The loser of the lock is **dropped with a reason, not queued**,
  which is only sound because every dropped case has a cron re-pickup
  (`merge-green-dependency-prs`, `fix-red-dependency-prs`,
  `check-prs-awaiting-review`); converting drop-on-lock into queue-on-lock
  is a prerequisite for retiring any of them.
- **No prior run's verdict may gate dispatch — unless the skipping path
  writes a run row.** A skip returns `{ kind: "skipped" }` and writes *no*
  row, so a gate on "what did the last run conclude" reads the same stale
  row forever and the PR is dead with no label, no comment and nothing on
  the PR explaining why. Almost every gate here is therefore a **live
  precondition** (`baseChecksState === "failing"` is `upstream-broken`, not
  a remembered diagnosis) or a fact about the PR that a human action can
  change. The single exception is `priorDiagnosisClass`, and it is allowed
  exactly because its skip *escalates* — which records a row (below).
  `requires-human` follows the same rule: the *state* is "we escalated at
  head SHA X" (`escalatedAtSha` on the run context), so a maintainer's push
  re-arms the loop automatically, while the same label with no escalating
  run of ours behind it means a human applied it by hand and is honoured as
  a permanent override.

An explicit human request (`comment.created` / `pr_review_comment.created`
/ Slack `message`) overrides the escalation guard, the not-retryable
verdict and the per-SHA dedup — a maintainer asking directly is an
intentional override — but not the facts: a fork PR, a red base branch and
an exhausted budget do not care how nicely you ask. Fork PRs are the one
skip the author is owed an explanation for, so the gate posts a comment
saying we have no branch to push to.

### Escalation — the skips that are not silent

Three of `resolveFixDisposition`'s skips are **terminal for the current
problem**: the attempt budget is spent (`fix.maxAttempts`), the cost budget
is spent (`fix.maxCostUsd`), or the last diagnosis names a class outside
`fix.retryableClasses` (packaged: anything but `reproducible` /
`env-mismatch`, so in practice `infra-dependent`). No further event will
change the answer until a human or a new commit does something, so leaving
them silent is *worse* than `requires-human` — which is at least visible.

Each of those decisions carries a typed **escalation case** beside its
reason, produced by the branch that decided rather than reconstructed from
the prose, and `src/engine/pr-escalation.ts` applies it: it records a run
row, applies `requires-human`, and posts **one** comment naming the case,
the attempt count and each attempt's `class=` / `cause=` (the same rendered
`priorAttempts` lines the next prompt would have replayed). Every other
skip stays silent, and the difference is structural — `upstream-broken`
self-heals and is not this PR's fault, `fork-pr` gets its own explanation,
`human-hold` / `escalated` are already escalated, and `already-assessed` is
a duplicate delivery.

The **run row is the load-bearing part**, not bookkeeping.
`escalatedAtSha` is read back off the *prior run's* persisted
`context.prState`; a dispatch-time skip writes no row, so an escalation
that stayed row-less would never persist it — and the next dispatch,
seeing `requires-human` with no `escalatedAtSha` behind it, would classify
our own label as a human's **permanent** hold and latch the PR dead. That
is the one-way door the stateful guard exists to remove, reintroduced by
the feature meant to remove it. The row is recorded `succeeded` (`failed`
is reserved for malfunction) with the resolved snapshot on it, so the run
detail panel explains the stop.

Three consequences follow from that ordering:

- **The row is written before the label.** Row-then-crash leaves an
  escalation with no label, so the guard does not bind and the next event
  simply escalates again; label-then-crash would leave a label with no
  record, which is the permanent misclassification above.
- **The comment is posted only behind a label that landed**, so a failed
  label write retries cleanly instead of commenting once per attempt.
- **Once-only is a property of the record, not of an API scan.** Neither
  `postComment` nor `addLabels` de-duplicates; the next dispatch at the
  same head resolves `escalatedBy: "us"` and takes the `escalated:` skip,
  which carries no escalation case and therefore applies nothing.

`dispatchWorkflow` runs the same gate for the routes that never cross the
dispatcher — the cron fan-outs and `/api/run` — and persists the snapshot
on the run row (see [State](/spec/10-state)). That is what makes a nightly
`fix-red-dependency-prs` run and a live webhook carry byte-identical
context, and it is why the escalation above is one shared call rather than
two call-site implementations: a skip that labels the PR on the webhook
route and stays silent on the cron route would be the same divergence this
whole gate exists to remove — and the daily sweep is the route that reaches
most exhausted PRs.

## Introspection — the route playground

Because `routeEvent` performs no side effects, a synthetic event can be threaded
through the *real* classifier and router to preview its decision without ever
dispatching a workflow. Two admin endpoints expose this:

- `GET /admin/api/route-graph` — the static map the dashboard draws: inputs
  (GitHub + Slack), each connector's event types tagged `deterministic` vs
  `classifier`, the handler set (workflows + in-process handlers), and the
  deterministic + intent edges (derived from `getRoutes()` + `listAgentWorkflows()`).
- `POST /admin/api/route-test` — a **hermetic dry-run**. It builds an
  `EventEnvelope` from the request (with an inert `reply` no-op and empty `raw`),
  calls `routeEvent(envelope, {})` — **no `db`, no `github`, so zero external
  reads/writes** — and, for comment-text types, calls `classifyComment(…, {
  explain: true })` to surface the model's one-sentence reasoning. It returns the
  `Route`, the classification, and a composed explanation. It never touches
  `dispatch` / `dispatchWorkflow` (structurally absent from the admin surface),
  so the only external effect is the cheap classifier call. Powers the dashboard
  **Router Playground** page.

The `explain` option on `classifyComment` is test/introspection-only: the
`REASON:` line is already parsed for every intent, so it only nudges the model to
populate it — production never sets it, leaving classifier output and token cost
unchanged.

## Invariants

- **No LLM in deterministic routes.** The opening / synchronize / open
  events route by event type. The LLM never decides whether to triage
  an issue.
- **Both check-outcome routes are deterministic.** `pr.checks_passed` and
  `pr.checks_failed` are structured events the connector has already
  qualified; re-deriving "is this a dependency PR?" from a prose sentence
  with a classifier is strictly worse than carrying the boolean the
  connector computed. A classifier route also silently constrains the
  reachable handlers to workflows that declare a `classification:` block,
  which is not a property any structured route should depend on.
- **The router decides *what*; the dispatch gate decides *whether*.** No PR
  policy — attempt budgets, escalation, dedup, the run lock — belongs in
  `routeEvent`. Keeping it out is what lets the route playground run the
  real router with no DB and no GitHub client.
- **Reply gate beats mention parsing.** If the DB says a workflow is
  waiting on this thread, the comment goes there — regardless of
  whether it mentions the bot, contains a slash command, or anything
  else. The natural-language continuation is the point.
- **Maintainer gate is a *router* decision.** Workflows assume their
  caller has been authorized. A re-implementation that lets non-
  maintainer events reach workflows will leak.
- **Screener is fail-open, classifier is fail-CHAT.** The screener
  failing should never silence the bot; the classifier failing should
  never accidentally launch a build cycle. These defaults are not
  symmetric on purpose.
- **`ignore` is silent.** No reply, no log entry beyond the router's
  console line, no DB write. The contract with the user is "if the bot
  doesn't react, the bot didn't see it".
- **Bot self-loop guards live in connectors, not here.** The router
  does not re-check `senderIsBot`. Adding a duplicate check would mask
  bugs in the connector layer.

## Current implementation

| Piece | File |
|---|---|
| `routeEvent`, `RoutingResult`, `MAINTAINER_ROLES`, `BOT_MENTION` regex | `src/engine/router.ts` |
| Build-intent classifier (compose + parse) | `src/engine/screen/classifier.ts` |
| Composable base prompt + adds-info prompt | `workflows/prompts/classifier.md`, `workflows/prompts/classify-adds-info.md` |
| Per-workflow category source | `classification:` block in each `workflows/<name>.yaml` |
| Intent → workflow fallback | `getWorkflowByIntent()` in `src/workflows/loader.ts` |
| PR snapshot + `PR_SCOPED_WORKFLOWS` (the run lock's span) | `src/engine/pr-state.ts` |
| Pure decisions over the snapshot | `src/engine/pr-decisions.ts` |
| Escalation (label + one comment + the run row) | `src/engine/pr-escalation.ts` |
| Dispatch gate (router result → workflow) | `src/engine/dispatcher.ts` |
| Injection screener | `src/engine/screen/screen.ts` |
| Direct provider calls + model auto-detect | `src/engine/llm.ts` |
| Harness consumer (skill → handler) | `src/index.ts:560–1124` |
| URL extraction fallback | `extractGithubRefFromText()` in `classifier.ts` |
| Route playground endpoints (`/route-graph`, `/route-test`) | `src/admin/routes.ts` |

## Rebuild notes

- **Parallelise the two LLM calls.** Screener and classifier run in
  parallel for a reason — they're both single-shot and roughly the
  same size. Doing them sequentially would double user-visible latency
  on every chat turn.
- **Use a discriminated union for the result.** `RoutingResult` as
  `{ action } & ...` lets the harness's switch be exhaustive and
  type-safe. A re-implementation that returns "skill string or null" is
  losing information.
- **Keep the LLM behind a feature gate.** A re-implementation may need
  to operate in environments without any LLM provider key. The
  classifier should be replaceable with a "default to CHAT" stub so
  the rest of the system still works.
- **Don't centralise auth here.** The router checks `authorAssociation`
  for `@last-light` build commands because the check is intent-specific
  ("is this a maintainer asking for write actions?"). Generic
  authorization belongs in connectors. Move it out and the router gets
  cluttered.
- **Reply-gate lookup is a single indexed DB query.** It runs on every
  comment and every Slack message, so cost it. SQLite handles it
  trivially; a re-implementation on a remote DB should cache the active
  set of `triggerId`s in memory.
- **Resolve PR state once, then decide.** The version of this system that
  read the PR at each site that needed it had six such sites, each
  fetching an overlapping subset and each free to disagree; the bugs that
  produced were invisible until the state was written down as one type. A
  re-implementation should make the snapshot a value, make every policy
  question a pure function of it, and give itself exactly one place that
  talks to the forge.
- **Treat the classifier prompt as code.** A change to the base template's
  output format or fallback rules ripples through every chat surface; the intent
  set itself is now data (one `classification:` block per workflow). Version both
  like config; test with golden cases (`buildClassifierPrompt()` is pure and
  snapshot-friendly). Keep the base template and the per-workflow blocks in sync
  with the token→intent vocabulary they compose into.
